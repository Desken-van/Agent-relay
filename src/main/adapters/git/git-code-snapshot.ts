/**
 * Captures what a task branch currently contains, without changing any of it.
 *
 * ## Why an allowlist rather than a forbidden list
 *
 * {@link CliGitAdapter} guards a broad surface with a list of destructive
 * commands it refuses. This class needs the opposite discipline: it has exactly
 * four things to run, all of them reads, and anything else would be a bug. An
 * allowlist states that directly, and it cannot be defeated by a subcommand
 * nobody thought to forbid.
 *
 * ## Why not `git add --intent-to-add`
 *
 * The obvious way to make untracked files visible to `git diff` is to register
 * them in the index with `--intent-to-add`, which is what
 * {@link CliGitAdapter.collectChanges} does for the diff it shows an operator.
 * That writes index entries — it changes the repository state of a checkout the
 * user owns. A snapshot exists to say what the code WAS at a moment; producing
 * it by modifying the thing being measured is exactly the property it must not
 * have. `ls-files --others` answers the same question and writes nothing.
 */

import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../../shared/domain/errors';
import type { CodeSnapshotChange } from '../../../shared/domain/code-review';
import { redactSecrets } from '../../../shared/util/redact';
import type {
  CodeSnapshotRequest,
  CodeSnapshotSource,
  RawCheckoutIdentity,
  RawCodeSnapshot,
  RawCodeSnapshotFile
} from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../process/process-runner';

/** Every Git invocation this class is permitted to make. */
const READ_ONLY: ReadonlyArray<readonly string[]> = [
  ['rev-parse'],
  ['merge-base'],
  ['diff', '--name-status'],
  ['ls-files', '--others'],
  ['status', '--porcelain=v1']
];

function assertReadOnly(args: readonly string[]): void {
  const allowed = READ_ONLY.some((prefix) => prefix.every((part, index) => args[index] === part));
  if (!allowed) {
    throw new AgentRelayError(
      'GIT_FAILED',
      'The code snapshot may only run read-only Git commands.',
      { details: `git ${args.slice(0, 2).join(' ')}` }
    );
  }
}

/** Split a NUL-delimited Git record list, dropping the trailing empty field. */
function splitZ(value: string): string[] {
  return value.split('\0').filter((part) => part.length > 0);
}

/**
 * Map a `--name-status` code onto the change vocabulary.
 *
 * `T` (type change, e.g. file to symlink) is reported as a modification: the
 * path is still there and its content still differs, which is what a reviewer
 * needs to know.
 */
function toChange(code: string): CodeSnapshotChange {
  const letter = code[0] ?? '';
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  if (letter === 'R') return 'renamed';
  if (letter === 'C') return 'added';
  return 'modified';
}

export interface GitCodeSnapshotOptions {
  readonly configuredPath?: string | null;
  readonly timeoutMs?: number;
}

export class GitCodeSnapshotSource implements CodeSnapshotSource {
  private resolvedPath: string | null = null;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: GitCodeSnapshotOptions = {}
  ) {}

  private gitPath(): string {
    if (this.resolvedPath) return this.resolvedPath;
    const located = locateExecutable('git', {
      configuredPath: this.options.configuredPath ?? null
    });
    if (!located) {
      throw new AgentRelayError('TOOL_MISSING', 'Git was not found on this machine.', {
        remediation: 'Install Git for Windows from https://git-scm.com/download/win and restart Agent Relay.'
      });
    }
    this.resolvedPath = located.path;
    return located.path;
  }

  private async git(
    cwd: string,
    args: readonly string[],
    options: { allowFailure?: boolean } = {}
  ): Promise<ProcessResult> {
    assertReadOnly(args);
    const result = await this.runner.run(this.gitPath(), args, {
      cwd,
      timeoutMs: this.options.timeoutMs ?? 120_000,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true'
      }
    });
    if (!options.allowFailure && result.exitCode !== 0) {
      throw new AgentRelayError('GIT_FAILED', `git ${args[0] ?? ''} failed while reading the task branch.`, {
        details: redactSecrets((result.stderr || result.stdout).slice(0, 2_000))
      });
    }
    return result;
  }

  /**
   * What checkout is this, and what is it on?
   *
   * Read before anything durable is written, because a worktree that belongs to
   * a different repository, or that is sitting on a different branch than the
   * task believes, is not the code the task means — and a review of it would be
   * a confident statement about the wrong thing.
   */
  async describeCheckout(worktreePath: string): Promise<RawCheckoutIdentity> {
    const commonDir = (
      await this.git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).stdout.trim();
    const branch = (
      await this.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).stdout.trim();
    return {
      // Resolved so that two spellings of one directory compare equal.
      commonDir: safeRealPath(commonDir) ?? commonDir,
      // Git prints the literal word for a detached HEAD; it is not a branch.
      branch: branch === 'HEAD' ? null : branch,
      detached: branch === 'HEAD'
    };
  }

  async capture(request: CodeSnapshotRequest): Promise<RawCodeSnapshot> {
    const head = (await this.git(request.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (
      await this.git(request.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).stdout.trim();

    // The point the task branched from, not wherever the base branch has since
    // moved to. A base that advanced underneath must not make the task's own
    // work look different than it is.
    const mergeBase = await this.git(
      request.worktreePath,
      ['merge-base', request.baseBranch, 'HEAD'],
      { allowFailure: true }
    );
    const base =
      mergeBase.exitCode === 0 && mergeBase.stdout.trim().length > 0
        ? mergeBase.stdout.trim()
        : (await this.git(request.worktreePath, ['rev-parse', request.baseBranch])).stdout.trim();

    // One diff against the WORKING TREE — no `--cached`, no second ref — so it
    // covers committed and uncommitted tracked changes together. Untracked
    // files are not in the index at all, so they need their own read.
    const [tracked, untracked, status] = await Promise.all([
      this.git(request.worktreePath, ['diff', '--name-status', '-z', base]),
      this.git(request.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
      // Whether anything is uncommitted at all. It decides whether a reviewer
      // that reads only committed refs could possibly be seeing this subject.
      this.git(request.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ]);

    const files: RawCodeSnapshotFile[] = [];
    const seen = new Set<string>();

    const add = (path: string, change: CodeSnapshotChange): void => {
      if (seen.has(path)) return;
      seen.add(path);
      files.push({
        path,
        change,
        absolutePath: change === 'deleted' ? null : join(request.worktreePath, path)
      });
    };

    const tokens = splitZ(tracked.stdout);
    for (let index = 0; index < tokens.length; ) {
      const code = tokens[index] ?? '';
      // A rename or copy record carries two paths; everything else carries one.
      // Getting this wrong would silently shift every later path by one field.
      if (code.startsWith('R') || code.startsWith('C')) {
        const from = tokens[index + 1];
        const to = tokens[index + 2];
        if (from !== undefined) add(from, 'deleted');
        if (to !== undefined) add(to, toChange(code));
        index += 3;
        continue;
      }
      const path = tokens[index + 1];
      if (path !== undefined) add(path, toChange(code));
      index += 2;
    }

    for (const path of splitZ(untracked.stdout)) add(path, 'untracked');

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = files.length > request.maxFiles;

    return {
      baseCommit: base,
      headCommit: head,
      branch,
      files: truncated ? files.slice(0, request.maxFiles) : files,
      truncated,
      hasUncommittedState: status.stdout.trim().length > 0
    };
  }
}

/** `realpathSync` that answers `null` instead of throwing on a missing path. */
function safeRealPath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Is this path a regular file that really lives inside the worktree?
 *
 * Containment is checked on the REAL path, after symlinks are resolved, and the
 * link itself is checked separately with `lstat`. Checking only the joined path
 * would be checking the string the caller built, not the file the OS would
 * open: a symlink inside the worktree pointing at `C:\Users\…\.ssh\id_rsa`
 * has a perfectly innocent-looking path and reads somebody's private key.
 */
export function isContainedRegularFile(worktreePath: string, absolutePath: string): boolean {
  const rootReal = safeRealPath(worktreePath);
  if (rootReal === null) return false;

  let link;
  try {
    link = lstatSync(absolutePath);
  } catch {
    return false;
  }
  // A symlink or a Windows reparse point is refused outright rather than
  // followed and then judged: the target can change between the check and the
  // read, and nothing here needs to follow one.
  if (link.isSymbolicLink()) return false;
  if (!link.isFile()) return false;

  const fileReal = safeRealPath(absolutePath);
  if (fileReal === null) return false;

  // `relative` from the root to the file is the containment test: it is empty
  // when they are the same path, absolute when they share no root at all, and
  // starts with a `..` SEGMENT when the file is outside. Comparing segments
  // rather than a string prefix keeps a legitimate file called `..config` in.
  const within = relative(resolve(rootReal), resolve(fileReal));
  if (within.length === 0 || isAbsolute(within)) return false;
  return within.split(sep)[0] !== '..';
}

export type SnapshotRead =
  | { readonly sha256: string; readonly bytes: number }
  | { readonly error: 'unreadable' | 'unsafe_path' };

/**
 * Digest a working-tree file by streaming it.
 *
 * Streaming rather than reading it whole, so that size never becomes a reason
 * to skip a file. The previous shape skipped anything over a ceiling and
 * recorded only its path, reason and length — which gave two different files of
 * identical size the same identity, and a subject hash that could not tell them
 * apart. Constant memory removes the reason for the ceiling to exist.
 */
export async function hashSnapshotFile(
  worktreePath: string,
  absolutePath: string
): Promise<SnapshotRead> {
  if (!isContainedRegularFile(worktreePath, absolutePath)) {
    return { error: 'unsafe_path' };
  }
  try {
    const digest = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(absolutePath);
    await new Promise<void>((settle, fail) => {
      stream.on('data', (chunk: string | Buffer) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += buffer.byteLength;
        digest.update(buffer);
      });
      stream.on('error', fail);
      stream.on('end', settle);
    });
    return { sha256: digest.digest('hex'), bytes };
  } catch {
    return { error: 'unreadable' };
  }
}
