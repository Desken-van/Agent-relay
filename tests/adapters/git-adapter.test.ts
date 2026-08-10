/**
 * Git integration tests against real temporary repositories.
 *
 * These use the actual `git` binary and the real adapter — the only thing that
 * is temporary is the repository. Nothing outside the per-test temp directory is
 * touched, and no remote is ever contacted.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGitAdapter, mergeFileInfo } from '../../src/main/adapters/git/git-adapter';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';

let root: string;
let repo: string;
let worktreesRoot: string;
let git: CliGitAdapter;

function run(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function commitFile(cwd: string, name: string, contents: string, message: string): void {
  writeFileSync(join(cwd, name), contents, 'utf8');
  run(['add', name], cwd);
  run(['commit', '-m', message], cwd);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-git-'));
  repo = join(root, 'repo');
  worktreesRoot = join(root, 'worktrees');
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  run(['init', '--initial-branch', 'main'], repo);
  // Local identity so the tests do not depend on the machine's global config.
  run(['config', 'user.name', 'Agent Relay Test'], repo);
  run(['config', 'user.email', 'test@agent-relay.local'], repo);
  run(['config', 'commit.gpgsign', 'false'], repo);

  commitFile(repo, 'README.md', '# demo\n', 'initial commit');

  git = new CliGitAdapter(new ExecaProcessRunner(), {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inspect', () => {
  it('reads a real repository', async () => {
    const info = await git.inspect(repo);

    expect(info.isRepository).toBe(true);
    expect(info.currentBranch).toBe('main');
    expect(info.branches).toContain('main');
    expect(info.defaultBranchGuess).toBe('main');
    expect(info.isClean).toBe(true);
    expect(info.hasRemoteOrigin).toBe(false);
    expect(info.userName).toBe('Agent Relay Test');
    expect(info.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a non-repository without throwing', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const info = await git.inspect(plain);

    expect(info.isRepository).toBe(false);
    expect(info.root).toBeNull();
    expect(info.branches).toEqual([]);
  });

  it('detects a dirty working tree', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted', 'utf8');
    const info = await git.inspect(repo);

    expect(info.isClean).toBe(false);
    expect(info.dirtyFiles.join('\n')).toContain('dirty.txt');
  });
});

describe('branches and worktrees', () => {
  it('reports branch existence accurately', async () => {
    expect(await git.branchExists(repo, 'main')).toBe(true);
    expect(await git.branchExists(repo, 'does-not-exist')).toBe(false);
  });

  it('creates an isolated worktree on a new branch', async () => {
    const worktreePath = join(worktreesRoot, 'task-1');

    const worktree = await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/task-1',
      worktreePath
    });

    expect(worktree.branch).toBe('agent-relay/task-1');
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);

    // The original checkout is untouched and still on main.
    const info = await git.inspect(repo);
    expect(info.currentBranch).toBe('main');
    expect(info.isClean).toBe(true);

    const worktrees = await git.listWorktrees(repo);
    expect(worktrees.some((entry) => entry.branch === 'agent-relay/task-1')).toBe(true);
  });

  it('refuses to reuse an existing branch name', async () => {
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/dup',
      worktreePath: join(worktreesRoot, 'dup-1')
    });

    await expect(
      git.createWorktree({
        repositoryPath: repo,
        baseBranch: 'main',
        branchName: 'agent-relay/dup',
        worktreePath: join(worktreesRoot, 'dup-2')
      })
    ).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  });

  it('refuses a base branch that does not exist', async () => {
    await expect(
      git.createWorktree({
        repositoryPath: repo,
        baseBranch: 'nope',
        branchName: 'agent-relay/x',
        worktreePath: join(worktreesRoot, 'x')
      })
    ).rejects.toThrow(/does not exist/i);
  });

  it('refuses to remove a worktree that has uncommitted work', async () => {
    const worktreePath = join(worktreesRoot, 'task-keep');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/keep',
      worktreePath
    });

    writeFileSync(join(worktreePath, 'work.txt'), 'important', 'utf8');

    await expect(git.removeWorktree(repo, worktreePath)).rejects.toThrow(/uncommitted/i);
    // The work is still there — nothing was force-removed.
    expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true);
  });

  it('removes a clean worktree', async () => {
    const worktreePath = join(worktreesRoot, 'task-clean');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/clean',
      worktreePath
    });

    await expect(git.removeWorktree(repo, worktreePath)).resolves.toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
  });
});

describe('collectChanges', () => {
  it('captures modified, added and untracked files without committing them', async () => {
    const worktreePath = join(worktreesRoot, 'task-changes');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/changes',
      worktreePath
    });

    writeFileSync(join(worktreePath, 'README.md'), '# demo\n\nmodified\n', 'utf8');
    writeFileSync(join(worktreePath, 'new-file.ts'), 'export const answer = 42;\n', 'utf8');

    const changes = await git.collectChanges(worktreePath, 'main', { maxDiffBytes: 100_000 });

    const paths = changes.changedFiles.map((file) => file.path).sort();
    expect(paths).toEqual(['README.md', 'new-file.ts']);
    expect(changes.diff).toContain('new-file.ts');
    expect(changes.diff).toContain('modified');
    expect(changes.diffStat.trim().length).toBeGreaterThan(0);
    expect(changes.isEmpty).toBe(false);
    expect(changes.diffTruncated).toBe(false);

    // Crucially: still uncommitted. Agent Relay never commits Claude's work.
    expect(changes.recentCommits).toHaveLength(0);
    const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8'
    });
    expect(log.trim()).toBe('');
  });

  it('reports an empty change set for an untouched worktree', async () => {
    const worktreePath = join(worktreesRoot, 'task-empty');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/empty',
      worktreePath
    });

    const changes = await git.collectChanges(worktreePath, 'main', { maxDiffBytes: 100_000 });

    expect(changes.changedFiles).toHaveLength(0);
    expect(changes.isEmpty).toBe(true);
    expect(changes.diff.trim()).toBe('');
  });

  it('truncates a diff that exceeds the configured budget', async () => {
    const worktreePath = join(worktreesRoot, 'task-big');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/big',
      worktreePath
    });

    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(join(worktreePath, 'big.txt'), big, 'utf8');

    const changes = await git.collectChanges(worktreePath, 'main', { maxDiffBytes: 500 });

    expect(changes.diffTruncated).toBe(true);
    expect(changes.diff).toContain('diff truncated');
    expect(changes.diffBytes).toBeGreaterThan(500);
  });

  it('includes commits made on the task branch as well as uncommitted work', async () => {
    const worktreePath = join(worktreesRoot, 'task-mixed');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/mixed',
      worktreePath
    });

    run(['config', 'user.name', 'Agent Relay Test'], worktreePath);
    run(['config', 'user.email', 'test@agent-relay.local'], worktreePath);
    commitFile(worktreePath, 'committed.txt', 'committed work\n', 'add committed work');
    writeFileSync(join(worktreePath, 'pending.txt'), 'pending work\n', 'utf8');

    const changes = await git.collectChanges(worktreePath, 'main', { maxDiffBytes: 100_000 });

    const paths = changes.changedFiles.map((file) => file.path).sort();
    expect(paths).toEqual(['committed.txt', 'pending.txt']);
    expect(changes.recentCommits).toHaveLength(1);
    expect(changes.recentCommits[0]).toContain('add committed work');
  });
});

describe('destructive command guard', () => {
  it('refuses reset --hard, clean -fd, force push and branch deletion', async () => {
    // Reach the private runner through the public surface the guard protects:
    // these are the exact argv shapes the guard rejects.
    const adapter = git as unknown as {
      git(cwd: string, args: string[], options?: unknown): Promise<unknown>;
    };

    await expect(adapter.git(repo, ['reset', '--hard', 'HEAD~1'])).rejects.toThrow(/destructive/i);
    await expect(adapter.git(repo, ['clean', '-fd'])).rejects.toThrow(/destructive/i);
    await expect(adapter.git(repo, ['push', '--force', 'origin', 'main'])).rejects.toThrow(
      /destructive/i
    );
    await expect(adapter.git(repo, ['push', '-f', 'origin', 'main'])).rejects.toThrow(/destructive/i);
    await expect(adapter.git(repo, ['branch', '-D', 'main'])).rejects.toThrow(/destructive/i);
    await expect(adapter.git(repo, ['checkout', '--force', 'main'])).rejects.toThrow(/destructive/i);
    await expect(adapter.git(repo, ['rebase', 'main'])).rejects.toThrow(/destructive/i);

    // The repository is untouched.
    const info = await git.inspect(repo);
    expect(info.isClean).toBe(true);
    expect(info.currentBranch).toBe('main');
  });
});

describe('commit', () => {
  it('stages and commits inside a worktree only when asked', async () => {
    const worktreePath = join(worktreesRoot, 'task-commit');
    await git.createWorktree({
      repositoryPath: repo,
      baseBranch: 'main',
      branchName: 'agent-relay/commit',
      worktreePath
    });
    run(['config', 'user.name', 'Agent Relay Test'], worktreePath);
    run(['config', 'user.email', 'test@agent-relay.local'], worktreePath);

    writeFileSync(join(worktreePath, 'feature.ts'), 'export const x = 1;\n', 'utf8');

    await git.stageAll(worktreePath);
    const { commit } = await git.commit(worktreePath, 'feat: add x\n\nmultiline body');

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8'
    });
    expect(log).toContain('feat: add x');

    // main is unaffected.
    const mainLog = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' });
    expect(mainLog).not.toContain('feat: add x');
  });
});

describe('diagnose', () => {
  it('finds the real git binary and reports a version', async () => {
    const diagnostic = await git.diagnose();
    expect(diagnostic.tool).toBe('git');
    expect(['ok', 'error']).toContain(diagnostic.status);
    expect(diagnostic.executablePath).toBeTruthy();
    expect(diagnostic.version).toContain('git version');
  });
});

describe('mergeFileInfo', () => {
  it('combines name-status and numstat output', () => {
    const files = mergeFileInfo(
      'M\tsrc/a.ts\nA\tsrc/b.ts\n',
      '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n'
    );

    expect(files).toEqual([
      { path: 'src/a.ts', status: 'M', insertions: 10, deletions: 2, binary: false },
      { path: 'src/b.ts', status: 'A', insertions: 5, deletions: 0, binary: false }
    ]);
  });

  it('marks binary files', () => {
    const files = mergeFileInfo('M\timage.png\n', '-\t-\timage.png\n');
    expect(files[0]).toMatchObject({ path: 'image.png', binary: true, insertions: null });
  });

  it('handles renames, which carry both paths', () => {
    const files = mergeFileInfo('R100\told.ts\tnew.ts\n', '0\t0\told.ts\tnew.ts\n');
    expect(files[0]?.path).toBe('new.ts');
    expect(files[0]?.status).toBe('R100');
  });
});
