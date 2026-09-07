/**
 * Captures what a task branch currently contains, without changing any of it.
 *
 * ## Why an allowlist rather than a forbidden list
 *
 * {@link CliGitAdapter} guards a broad surface with a list of destructive
 * commands it refuses. This class needs the opposite discipline: it has a small
 * fixed set of things to run, all of them reads, and anything else would be a
 * bug. An allowlist states that directly, and it cannot be defeated by a
 * subcommand nobody thought to forbid.
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
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../../shared/domain/errors';
import type { CodeSnapshotChange } from '../../../shared/domain/code-review';
import { redactSecrets } from '../../../shared/util/redact';
import type {
  CodeSnapshotRequest,
  CodeSnapshotSource,
  RawCheckoutIdentity,
  RawCodeSnapshot,
  RawCodeSnapshotFile,
  RawCodeSnapshotFingerprint
} from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../process/process-runner';

/** Every Git invocation this class is permitted to make. */
const READ_ONLY: ReadonlyArray<readonly string[]> = [
  ['rev-parse'],
  ['merge-base'],
  ['diff', '--name-status'],
  ['diff', '--numstat'],
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
        remediation:
          'Install Git for Windows from https://git-scm.com/download/win and restart Agent Relay.'
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
      throw new AgentRelayError(
        'GIT_FAILED',
        `git ${args[0] ?? ''} failed while reading the task branch.`,
        { details: redactSecrets((result.stderr || result.stdout).slice(0, 2_000)) }
      );
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

  /**
   * The cheap description used to prove the worktree held still.
   *
   * Five reads, none of them touching file contents: where HEAD is, which
   * branch, what porcelain status says, which paths are in the change set, and
   * how many lines each of them changed. A commit, checkout, addition or
   * deletion moves the first four; the line counts are there because status
   * alone reports only THAT a file is modified, so a second edit to an
   * already-modified file would otherwise look like no movement at all.
   *
   * Known limit: an edit leaving the same added and removed line counts —
   * swapping two lines, say — moves none of these. Such a file is still covered
   * by the per-file identity and size check the handle-based reader makes
   * across its own read; what escapes both is a same-line-count edit to a file
   * that had already been digested. Recorded here rather than papered over:
   * closing it means re-digesting, which doubles the cost of every capture.
   */
  async fingerprint(request: CodeSnapshotRequest): Promise<RawCodeSnapshotFingerprint> {
    const [head, branch, status, changed, sizes] = await Promise.all([
      this.git(request.worktreePath, ['rev-parse', 'HEAD']),
      this.git(request.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.git(request.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.git(request.worktreePath, ['diff', '--name-status', '-z', request.baseBranch], {
        allowFailure: true
      }),
      // Line counts as well as names. Status alone reports only that a file is
      // modified, so a second edit to an already-modified file would leave it
      // unchanged; numstat moves whenever the number of changed lines does.
      this.git(request.worktreePath, ['diff', '--numstat', '-z', request.baseBranch], {
        allowFailure: true
      })
    ]);
    return {
      headCommit: head.stdout.trim(),
      branch: branch.stdout.trim(),
      status: status.stdout,
      changeSet: `${changed.stdout}\u0000--numstat--\u0000${sizes.stdout}`
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
      hasUncommittedState: status.stdout.trim().length > 0,
      // Taken from the same reads that produced the file list, so a caller can
      // compare it against a later one and learn whether anything moved while
      // the contents were being digested.
      // Built by the same method as `fingerprint()`, because the two are
      // compared: a capture-side shortcut here would make every check fail.
      fingerprint: await this.fingerprint(request)
    };
  }
}

/** Two fingerprints describe the same instant. */
export function sameFingerprint(
  a: RawCodeSnapshotFingerprint,
  b: RawCodeSnapshotFingerprint
): boolean {
  return (
    a.headCommit === b.headCommit &&
    a.branch === b.branch &&
    a.status === b.status &&
    a.changeSet === b.changeSet
  );
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
 * Is this resolved location inside the worktree?
 *
 * `relative` from the root to the target is the containment test: empty when
 * they are the same path, absolute when they share no root at all, and starting
 * with a `..` SEGMENT when the target is outside. Comparing segments rather
 * than a string prefix keeps a legitimate file called `..config` in.
 */
function isWithin(rootReal: string, targetReal: string): boolean {
  const root = resolve(rootReal);
  const target = resolve(targetReal);
  if (root === target) return true;
  const within = relative(root, target);
  if (within.length === 0 || isAbsolute(within)) return false;
  return within.split(sep)[0] !== '..';
}

export interface SnapshotFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

/**
 * The filesystem operations the safe reader needs, as a seam.
 *
 * Injectable so the replacement race below can be exercised deterministically.
 * Proving a check-then-open defect with a real symlink works on POSIX and needs
 * Developer Mode on Windows — and a security property tested only where the OS
 * happens to cooperate is untested exactly where it matters most.
 */
export interface SnapshotFileOps {
  realpath(target: string): string;
  lstat(target: string): SnapshotFileStat;
  open(target: string): number;
  fstat(fd: number): SnapshotFileStat;
  read(fd: number): NodeJS.ReadableStream;
  close(fd: number): void;
}

export const nodeSnapshotFileOps: SnapshotFileOps = {
  realpath: (target) => realpathSync(target),
  lstat: (target) => lstatSync(target),
  // Opened for reading only, once. Everything after this point works from the
  // descriptor, never from the name again.
  open: (target) => openSync(target, 'r'),
  fstat: (fd) => fstatSync(fd),
  read: (fd) => createReadStream('', { fd, autoClose: false, start: 0 }),
  close: (fd) => closeSync(fd)
};

export type SnapshotRead =
  | { readonly sha256: string; readonly bytes: number }
  | { readonly error: 'unreadable' | 'unsafe_path' };

/**
 * Digest a working-tree file from a single open handle.
 *
 * The shape this replaced was check-then-reopen: `lstat` and `realpath` the
 * NAME, decide it was safe, then hand the NAME to `createReadStream`. Between
 * those two steps a concurrent writer can swap the file for a link to a private
 * key, and the read follows it — every check having passed on a file that is no
 * longer the one being read.
 *
 * So the name is used exactly once, to open. Everything after that is the
 * descriptor: `fstat` proves what was actually opened is a regular file and the
 * same object `lstat` saw, and its device, inode and size are compared again
 * after the read, so a replacement or truncation during the read is detected
 * rather than silently digested. The parent directory is resolved separately,
 * because a symlinked directory component would otherwise carry the read
 * outside the worktree without the final component ever looking suspicious.
 */
export async function hashSnapshotFile(
  worktreePath: string,
  absolutePath: string,
  ops: SnapshotFileOps = nodeSnapshotFileOps
): Promise<SnapshotRead> {
  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = ops.realpath(worktreePath);
    // The PARENT is resolved, not the file: resolving the file would follow a
    // final-component symlink, which is the thing being refused.
    parentReal = ops.realpath(dirname(absolutePath));
  } catch {
    return { error: 'unsafe_path' };
  }
  if (!isWithin(rootReal, parentReal)) return { error: 'unsafe_path' };

  let before: SnapshotFileStat;
  try {
    before = ops.lstat(absolutePath);
  } catch {
    return { error: 'unreadable' };
  }
  // A symlink or reparse point is refused outright rather than followed and
  // then judged: nothing here needs to follow one.
  if (before.isSymbolicLink() || !before.isFile()) return { error: 'unsafe_path' };

  let fd: number;
  try {
    fd = ops.open(absolutePath);
  } catch {
    return { error: 'unreadable' };
  }

  try {
    const opened = ops.fstat(fd);
    if (!opened.isFile()) return { error: 'unsafe_path' };
    // What was opened must be what was checked. If the name was swapped between
    // the `lstat` and the `open`, these identities differ, and the read that
    // would have followed the swap never happens.
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      return { error: 'unsafe_path' };
    }

    const digest = createHash('sha256');
    let bytes = 0;
    const stream = ops.read(fd);
    await new Promise<void>((settle, fail) => {
      stream.on('data', (chunk: string | Buffer) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += buffer.byteLength;
        digest.update(buffer);
      });
      stream.on('error', fail);
      stream.on('end', settle);
    });

    // The same descriptor, after the read. If the file this handle refers to
    // was replaced or truncated underneath, its identity or length has moved
    // and the bytes just digested describe nothing that can be named.
    const after = ops.fstat(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      return { error: 'unsafe_path' };
    }
    if (bytes !== opened.size) return { error: 'unsafe_path' };

    return { sha256: digest.digest('hex'), bytes };
  } catch {
    return { error: 'unreadable' };
  } finally {
    try {
      ops.close(fd);
    } catch {
      // A close that fails cannot invalidate a digest already taken.
    }
  }
}
