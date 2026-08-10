/**
 * Git adapter.
 *
 * Everything Agent Relay does to a repository goes through this class, and the
 * class refuses to run a destructive subcommand at all — see {@link FORBIDDEN}.
 * That is a belt-and-braces measure: no caller in the codebase asks for
 * `reset --hard`, but a future one shouldn't be able to either.
 *
 * The isolation model:
 *   * the user's checkout is only ever *read*;
 *   * all agent work happens in a dedicated `git worktree` on a dedicated
 *     branch, under a directory Agent Relay owns;
 *   * commits and pushes happen only behind an explicit approval.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  ChangedFile,
  GitChangeSet,
  RepositoryInfo,
  WorktreeInfo
} from '../../../shared/domain/git';
import type { ToolDiagnostic } from '../../../shared/domain/diagnostics';
import { redactSecrets } from '../../../shared/util/redact';
import type { CreateWorktreeRequest, GitAdapter } from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../process/process-runner';

/**
 * Argument patterns that are never allowed, regardless of caller.
 * Checked against the argv array, so there is no string to obfuscate through.
 */
const FORBIDDEN: ReadonlyArray<{ test: (args: readonly string[]) => boolean; why: string }> = [
  {
    test: (a) => a[0] === 'reset' && a.includes('--hard'),
    why: '`git reset --hard` discards work irreversibly.'
  },
  {
    test: (a) => a[0] === 'clean' && a.some((arg) => /^-[a-zA-Z]*f/.test(arg)),
    why: '`git clean -f` deletes untracked files irreversibly.'
  },
  {
    test: (a) => a[0] === 'push' && a.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease')),
    why: 'Force-pushing can destroy commits on a remote.'
  },
  {
    test: (a) => a[0] === 'branch' && a.some((arg) => arg === '-D' || arg === '--delete' || arg === '-d'),
    why: 'Agent Relay never deletes branches.'
  },
  {
    test: (a) => a[0] === 'checkout' && a.includes('--force'),
    why: '`git checkout --force` discards uncommitted work.'
  },
  {
    test: (a) => a[0] === 'worktree' && a[1] === 'remove' && a.includes('--force'),
    why: 'Removing a worktree by force can discard uncommitted work.'
  },
  {
    test: (a) => a[0] === 'rebase' || a[0] === 'filter-branch',
    why: 'History rewriting is out of scope for Agent Relay.'
  }
];

function assertAllowed(args: readonly string[]): void {
  for (const rule of FORBIDDEN) {
    if (rule.test(args)) {
      throw new AgentRelayError('GIT_FAILED', `Refusing to run a destructive Git command. ${rule.why}`, {
        details: `git ${args.join(' ')}`
      });
    }
  }
}

export interface GitAdapterOptions {
  readonly configuredPath?: string | null;
  readonly timeoutMs?: number;
}

export class CliGitAdapter implements GitAdapter {
  private resolvedPath: string | null = null;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: GitAdapterOptions = {}
  ) {}

  private gitPath(): string {
    if (this.resolvedPath) return this.resolvedPath;
    const located = locateExecutable('git', { configuredPath: this.options.configuredPath ?? null });
    if (!located) {
      throw new AgentRelayError('TOOL_MISSING', 'Git was not found on this machine.', {
        remediation: 'Install Git for Windows from https://git-scm.com/download/win and restart Agent Relay.'
      });
    }
    this.resolvedPath = located.path;
    return located.path;
  }

  private async git(
    cwd: string | undefined,
    args: readonly string[],
    options: { allowFailure?: boolean; timeoutMs?: number } = {}
  ): Promise<ProcessResult> {
    assertAllowed(args);

    const result = await this.runner.run(this.gitPath(), args, {
      cwd,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      // Never let Git open a credential prompt or an editor and hang the app.
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true'
      }
    });

    if (!options.allowFailure && result.exitCode !== 0) {
      throw new AgentRelayError('GIT_FAILED', `git ${args[0] ?? ''} failed.`, {
        details: redactSecrets((result.stderr || result.stdout).slice(0, 2000))
      });
    }

    return result;
  }

  async diagnose(): Promise<ToolDiagnostic> {
    const checkedAt = new Date().toISOString();
    const located = locateExecutable('git', { configuredPath: this.options.configuredPath ?? null });

    if (!located) {
      return {
        tool: 'git',
        status: 'missing',
        executablePath: null,
        version: null,
        detail: 'Git was not found on PATH or in the standard install locations.',
        remediation: 'Install Git for Windows from https://git-scm.com/download/win.',
        checkedAt
      };
    }

    const version = await this.runner.run(located.path, ['--version'], { timeoutMs: 15_000 });
    if (version.exitCode !== 0) {
      return {
        tool: 'git',
        status: 'error',
        executablePath: located.path,
        version: null,
        detail: redactSecrets(version.stderr || version.stdout).slice(0, 400),
        remediation: 'Run `git --version` in a terminal to see the underlying failure.',
        checkedAt
      };
    }

    const name = await this.runner.run(located.path, ['config', '--global', 'user.name'], {
      timeoutMs: 15_000
    });
    const email = await this.runner.run(located.path, ['config', '--global', 'user.email'], {
      timeoutMs: 15_000
    });
    const hasIdentity = name.stdout.trim().length > 0 && email.stdout.trim().length > 0;

    return {
      tool: 'git',
      status: hasIdentity ? 'ok' : 'error',
      executablePath: located.path,
      version: version.stdout.trim(),
      detail: hasIdentity
        ? `${version.stdout.trim()} — commit identity configured.`
        : `${version.stdout.trim()} — no global user.name/user.email configured.`,
      remediation: hasIdentity
        ? null
        : 'Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` before committing.',
      checkedAt
    };
  }

  async inspect(repositoryPath: string): Promise<RepositoryInfo> {
    const insideCheck = await this.git(repositoryPath, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true
    });

    if (insideCheck.exitCode !== 0 || insideCheck.stdout.trim() !== 'true') {
      return {
        isRepository: false,
        root: null,
        currentBranch: null,
        defaultBranchGuess: null,
        branches: [],
        hasRemoteOrigin: false,
        remoteUrl: null,
        isClean: false,
        dirtyFiles: [],
        userName: null,
        userEmail: null,
        headCommit: null
      };
    }

    const [root, branch, branches, remote, status, userName, userEmail, head] = await Promise.all([
      this.git(repositoryPath, ['rev-parse', '--show-toplevel']),
      this.git(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }),
      this.git(repositoryPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.git(repositoryPath, ['remote', 'get-url', 'origin'], { allowFailure: true }),
      this.git(repositoryPath, ['status', '--porcelain']),
      this.git(repositoryPath, ['config', 'user.name'], { allowFailure: true }),
      this.git(repositoryPath, ['config', 'user.email'], { allowFailure: true }),
      this.git(repositoryPath, ['rev-parse', 'HEAD'], { allowFailure: true })
    ]);

    const branchList = branches.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const dirtyFiles = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const currentBranch = branch.exitCode === 0 ? branch.stdout.trim() : null;

    return {
      isRepository: true,
      root: root.stdout.trim(),
      currentBranch: currentBranch === 'HEAD' ? null : currentBranch,
      defaultBranchGuess: guessDefaultBranch(branchList, currentBranch),
      branches: branchList,
      hasRemoteOrigin: remote.exitCode === 0 && remote.stdout.trim().length > 0,
      remoteUrl: remote.exitCode === 0 ? redactSecrets(remote.stdout.trim()) : null,
      isClean: dirtyFiles.length === 0,
      dirtyFiles,
      userName: userName.exitCode === 0 && userName.stdout.trim() ? userName.stdout.trim() : null,
      userEmail: userEmail.exitCode === 0 && userEmail.stdout.trim() ? userEmail.stdout.trim() : null,
      headCommit: head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null
    };
  }

  async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const result = await this.git(
      repositoryPath,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { allowFailure: true }
    );
    return result.exitCode === 0;
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeInfo> {
    const { repositoryPath, baseBranch, branchName, worktreePath } = request;

    if (await this.branchExists(repositoryPath, branchName)) {
      throw new AgentRelayError('WORKTREE_CONFLICT', `Branch "${branchName}" already exists.`, {
        remediation: 'Delete or rename the existing branch, or create a new task.'
      });
    }

    if (!(await this.branchExists(repositoryPath, baseBranch))) {
      throw new AgentRelayError('GIT_FAILED', `Base branch "${baseBranch}" does not exist locally.`, {
        remediation: `Run \`git branch\` in the project and pick a branch that exists, then update the project's default branch.`
      });
    }

    mkdirSync(dirname(worktreePath), { recursive: true });

    // `worktree add -b` creates the branch and the checkout in one atomic step.
    await this.git(repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath, baseBranch], {
      timeoutMs: 300_000
    });

    const worktrees = await this.listWorktrees(repositoryPath);
    const created = worktrees.find((wt) => samePath(wt.path, worktreePath));

    return (
      created ?? {
        path: worktreePath,
        branch: branchName,
        head: null,
        isLocked: false
      }
    );
  }

  async listWorktrees(repositoryPath: string): Promise<WorktreeInfo[]> {
    const result = await this.git(repositoryPath, ['worktree', 'list', '--porcelain'], {
      allowFailure: true
    });
    if (result.exitCode !== 0) return [];

    const entries: WorktreeInfo[] = [];
    let current: { path?: string; head?: string; branch?: string; locked?: boolean } = {};

    const flush = (): void => {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? null,
          head: current.head ?? null,
          isLocked: current.locked ?? false
        });
      }
      current = {};
    };

    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        flush();
        current.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (line.startsWith('locked')) {
        current.locked = true;
      }
    }
    flush();

    return entries;
  }

  async removeWorktree(repositoryPath: string, worktreePath: string): Promise<void> {
    // Note the absence of `--force`: if the worktree has uncommitted changes,
    // Git refuses and we surface that instead of destroying work.
    const result = await this.git(repositoryPath, ['worktree', 'remove', worktreePath], {
      allowFailure: true
    });

    if (result.exitCode !== 0) {
      throw new AgentRelayError(
        'GIT_FAILED',
        'Git refused to remove the worktree, most likely because it still contains uncommitted changes.',
        {
          details: redactSecrets(result.stderr || result.stdout).slice(0, 1000),
          remediation: 'Review the changes first. Agent Relay never force-removes a worktree.'
        }
      );
    }
  }

  async collectChanges(
    worktreePath: string,
    baseBranch: string,
    options: { maxDiffBytes: number }
  ): Promise<GitChangeSet> {
    // Compare against the point the task branched from, so the diff shows the
    // task's own work even if the base branch has moved on since.
    const mergeBase = await this.git(worktreePath, ['merge-base', baseBranch, 'HEAD'], {
      allowFailure: true
    });
    const base = mergeBase.exitCode === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;

    // Register untracked files with the index *by intent only* so they appear in
    // `git diff`. This writes no object and creates no commit; it is confined to
    // the task's own isolated worktree.
    await this.git(worktreePath, ['add', '--intent-to-add', '--all'], { allowFailure: true });

    const [status, stat, numstat, nameStatus, diff, commits] = await Promise.all([
      this.git(worktreePath, ['status', '--short']),
      this.git(worktreePath, ['diff', '--stat', base]),
      this.git(worktreePath, ['diff', '--numstat', base]),
      this.git(worktreePath, ['diff', '--name-status', base]),
      this.git(worktreePath, ['diff', base], { timeoutMs: 180_000 }),
      this.git(worktreePath, ['log', '--oneline', `${base}..HEAD`], { allowFailure: true })
    ]);

    const changedFiles = mergeFileInfo(nameStatus.stdout, numstat.stdout);
    const fullDiff = diff.stdout;
    const truncated = fullDiff.length > options.maxDiffBytes;

    return {
      statusShort: status.stdout,
      changedFiles,
      diffStat: stat.stdout,
      diff: truncated
        ? `${fullDiff.slice(0, options.maxDiffBytes)}\n…[diff truncated at ${options.maxDiffBytes} characters — ${fullDiff.length - options.maxDiffBytes} omitted]`
        : fullDiff,
      diffTruncated: truncated,
      diffBytes: fullDiff.length,
      recentCommits: commits.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      isEmpty: changedFiles.length === 0 && status.stdout.trim().length === 0,
      collectedAt: new Date().toISOString()
    };
  }

  async initRepository(path: string, defaultBranch: string): Promise<RepositoryInfo> {
    mkdirSync(path, { recursive: true });
    await this.git(path, ['init', '--initial-branch', defaultBranch]);
    return this.inspect(path);
  }

  async stageAll(worktreePath: string): Promise<void> {
    await this.git(worktreePath, ['add', '--all']);
  }

  async commit(worktreePath: string, message: string): Promise<{ commit: string }> {
    // `-m` takes the message as a single argv entry — no shell, no escaping.
    await this.git(worktreePath, ['commit', '-m', message]);
    const head = await this.git(worktreePath, ['rev-parse', 'HEAD']);
    return { commit: head.stdout.trim() };
  }

  async push(worktreePath: string, remote: string, branch: string): Promise<{ output: string }> {
    const result = await this.git(worktreePath, ['push', '--set-upstream', remote, branch], {
      timeoutMs: 300_000
    });
    return { output: redactSecrets(`${result.stdout}\n${result.stderr}`.trim()) };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function samePath(a: string, b: string): boolean {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}

function guessDefaultBranch(branches: readonly string[], currentBranch: string | null): string | null {
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    if (branches.includes(candidate)) return candidate;
  }
  if (currentBranch && currentBranch !== 'HEAD') return currentBranch;
  return branches[0] ?? null;
}

/**
 * Combine `--name-status` (what happened) with `--numstat` (how much) into one
 * list. `--numstat` reports `-` for binary files, which is how we detect them.
 */
export function mergeFileInfo(nameStatus: string, numstat: string): ChangedFile[] {
  const statuses = new Map<string, string>();
  for (const line of nameStatus.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0]?.trim();
    // Renames look like: R100<TAB>old/path<TAB>new/path
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (code && path) statuses.set(path.trim(), code);
  }

  const files: ChangedFile[] = [];
  for (const line of numstat.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const added = parts[0]?.trim() ?? '';
    const removed = parts[1]?.trim() ?? '';
    const rawPath = (parts.length >= 4 ? parts[3] : parts[2])?.trim() ?? '';
    if (rawPath.length === 0) continue;

    const binary = added === '-' || removed === '-';
    files.push({
      path: rawPath,
      status: statuses.get(rawPath) ?? 'M',
      insertions: binary ? null : Number.parseInt(added, 10) || 0,
      deletions: binary ? null : Number.parseInt(removed, 10) || 0,
      binary
    });
  }

  // Files that appear only in --name-status (e.g. pure renames with no content change).
  for (const [path, code] of statuses) {
    if (!files.some((f) => f.path === path)) {
      files.push({ path, status: code, insertions: 0, deletions: 0, binary: false });
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
