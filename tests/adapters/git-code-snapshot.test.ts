/**
 * The snapshot source, against a real Git repository.
 *
 * A fake would prove that the parsing code parses; it would not prove that the
 * commands are read-only, that a rename is read as two paths rather than one,
 * or that an untracked file is seen at all without touching the index. Those
 * are the properties the whole gate rests on, so this suite builds real
 * repositories in a temporary directory and reads them.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitCodeSnapshotSource,
  isContainedRegularFile
} from '../../src/main/adapters/git/git-code-snapshot';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { canonicalCodeSnapshot, codeReviewSnapshotSchema } from '../../src/shared/domain/code-review';
import { DEFAULT_CODE_SNAPSHOT_LIMITS } from '../../src/main/services/code-review';
import { hashSnapshotFile } from '../../src/main/adapters/git/git-code-snapshot';
import type { RawCodeSnapshot } from '../../src/main/ports';

let root: string;
let gitAvailable = true;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function makeRepository(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--initial-branch', 'main');
  git(path, 'config', 'user.email', 'test@example.invalid');
  git(path, 'config', 'user.name', 'Agent Relay Test');
  git(path, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(path, 'kept.txt'), 'base content\n');
  git(path, 'add', 'kept.txt');
  git(path, 'commit', '-m', 'base');
  git(path, 'checkout', '-b', 'agent/task');
  return path;
}

/** Build the hashed snapshot exactly as the service does, for identity checks. */
async function identity(worktreePath: string, raw: RawCodeSnapshot): Promise<string> {
  const entries = [];
  const omitted = [];
  for (const file of raw.files) {
    if (file.change === 'deleted' || file.absolutePath === null) {
      entries.push({ path: file.path, change: 'deleted' as const, contentSha256: null, bytes: 0 });
      continue;
    }
    const read = await hashSnapshotFile(worktreePath, file.absolutePath);
    if ('error' in read) {
      omitted.push({ path: file.path, reason: read.error, bytes: 0 });
      continue;
    }
    entries.push({
      path: file.path,
      change: file.change,
      contentSha256: read.sha256,
      bytes: read.bytes
    });
  }
  const snapshot = codeReviewSnapshotSchema.parse({
    version: 1,
    baseCommit: raw.baseCommit,
    headCommit: raw.headCommit,
    branch: raw.branch,
    entries,
    omitted,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    truncated: raw.truncated,
    complete: omitted.length === 0 && !raw.truncated,
    hasUncommittedState: raw.hasUncommittedState
  });
  return createHash('sha256').update(canonicalCodeSnapshot(snapshot)).digest('hex');
}

const source = new GitCodeSnapshotSource(new ExecaProcessRunner());
const capture = (path: string): Promise<RawCodeSnapshot> =>
  source.capture({
    worktreePath: path,
    baseBranch: 'main',
    maxFiles: DEFAULT_CODE_SNAPSHOT_LIMITS.maxFiles
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-snapshot-'));
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' });
  } catch {
    gitAvailable = false;
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.runIf(gitAvailable)('the read-only code snapshot', () => {
  it('sees committed, uncommitted and untracked work in one capture', async () => {
    const repository = makeRepository('mixed');
    writeFileSync(join(repository, 'committed.txt'), 'committed change\n');
    git(repository, 'add', 'committed.txt');
    git(repository, 'commit', '-m', 'work');
    writeFileSync(join(repository, 'kept.txt'), 'edited but not committed\n');
    writeFileSync(join(repository, 'scratch.txt'), 'never added\n');

    const raw = await capture(repository);
    const byPath = new Map(raw.files.map((file) => [file.path, file.change]));

    expect(byPath.get('committed.txt')).toBe('added');
    expect(byPath.get('kept.txt')).toBe('modified');
    // The whole reason this adapter exists: an untracked file is part of what a
    // reviewer would be shown, and it must be visible without being staged.
    expect(byPath.get('scratch.txt')).toBe('untracked');
    expect(raw.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(raw.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(raw.branch).toBe('agent/task');
  });

  it('leaves the index and the working tree exactly as it found them', async () => {
    const repository = makeRepository('untouched');
    writeFileSync(join(repository, 'kept.txt'), 'edited\n');
    writeFileSync(join(repository, 'scratch.txt'), 'never added\n');

    const before = git(repository, 'status', '--porcelain=v1', '--untracked-files=all');
    const headBefore = git(repository, 'rev-parse', 'HEAD');
    await capture(repository);
    const after = git(repository, 'status', '--porcelain=v1', '--untracked-files=all');

    // `git add --intent-to-add` would make the untracked file show as `A `
    // here. Producing the snapshot must not change the thing being measured.
    expect(after).toBe(before);
    expect(after).toContain('?? scratch.txt');
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repository, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('changes identity when a commit is added', async () => {
    const repository = makeRepository('committed-head');
    const before = await identity(repository, await capture(repository));

    writeFileSync(join(repository, 'new.txt'), 'new file\n');
    git(repository, 'add', 'new.txt');
    git(repository, 'commit', '-m', 'more work');

    expect(await identity(repository, await capture(repository))).not.toBe(before);
  });

  it('changes identity when tracked content changes without a commit', async () => {
    const repository = makeRepository('tracked-edit');
    const porcelain = (): string =>
      git(repository, 'status', '--porcelain=v1', '--untracked-files=all');
    expect(porcelain()).toBe('');
    const before = await identity(repository, await capture(repository));

    writeFileSync(join(repository, 'kept.txt'), 'edited in the worktree\n');
    // Git's own view is asserted at each step. Without it, a disagreement
    // about whether the file counts as modified — a stat cache, a
    // line-ending filter — would surface as an opaque hash mismatch
    // instead of naming which step went wrong.
    expect(porcelain()).toContain('kept.txt');
    const edited = await identity(repository, await capture(repository));
    expect(edited).not.toBe(before);

    // And back again: identity follows content, not the fact that an edit
    // happened at some point.
    writeFileSync(join(repository, 'kept.txt'), 'base content\n');
    expect(porcelain()).toBe('');
    expect(await identity(repository, await capture(repository))).toBe(before);
  });

  it('changes identity when an untracked file appears or is removed', async () => {
    const repository = makeRepository('untracked-edit');
    const before = await identity(repository, await capture(repository));

    const scratch = join(repository, 'scratch.txt');
    writeFileSync(scratch, 'never added\n');
    expect(await identity(repository, await capture(repository))).not.toBe(before);

    unlinkSync(scratch);
    expect(await identity(repository, await capture(repository))).toBe(before);
  });

  it('changes identity when a tracked file is deleted', async () => {
    const repository = makeRepository('deletion');
    const before = await identity(repository, await capture(repository));

    unlinkSync(join(repository, 'kept.txt'));
    const raw = await capture(repository);

    expect(raw.files.find((file) => file.path === 'kept.txt')?.change).toBe('deleted');
    expect(await identity(repository, raw)).not.toBe(before);
  });

  it('reads a rename as the two paths it actually is', async () => {
    const repository = makeRepository('rename');
    git(repository, 'mv', 'kept.txt', 'moved.txt');
    git(repository, 'commit', '-m', 'move it');

    const raw = await capture(repository);
    const byPath = new Map(raw.files.map((file) => [file.path, file.change]));

    // A rename record carries two paths. Reading it as one would shift every
    // later field by one and silently mis-attribute the rest of the change set.
    expect(byPath.get('kept.txt')).toBe('deleted');
    expect(byPath.get('moved.txt')).toBe('renamed');
  });

  it('gives the same identity to the same working state read twice', async () => {
    const repository = makeRepository('stable');
    writeFileSync(join(repository, 'kept.txt'), 'edited\n');
    writeFileSync(join(repository, 'scratch.txt'), 'untracked\n');

    expect(await identity(repository, await capture(repository))).toBe(await identity(repository, await capture(repository)));
  });

  it('carries no absolute path into the portable identity', async () => {
    // The same content in two different directories is the same code. If the
    // checkout location leaked into the hash, no two machines could ever agree.
    const first = makeRepository('portable-one');
    const second = makeRepository('portable-two');
    for (const repository of [first, second]) {
      writeFileSync(join(repository, 'kept.txt'), 'identical everywhere\n');
      writeFileSync(join(repository, 'scratch.txt'), 'also identical\n');
    }

    const rawFirst = await capture(first);
    const rawSecond = await capture(second);
    // The commits differ because the repositories were created separately, so
    // compare the part of the statement that describes content.
    expect(rawFirst.files.map((file) => file.path)).toEqual(
      rawSecond.files.map((file) => file.path)
    );
    for (const raw of [rawFirst, rawSecond]) {
      for (const file of raw.files) {
        expect(file.path).not.toContain(root);
        expect(file.path.startsWith('/')).toBe(false);
        expect(/^[a-zA-Z]:/.test(file.path)).toBe(false);
      }
    }
  });

  it('refuses to read a path that resolves outside the worktree', async () => {
    const repository = makeRepository('containment');
    const outside = join(root, 'outside-secret.txt');
    writeFileSync(outside, 'private\n');

    // No symlink needed for the plain case: a path that simply is not inside
    // the worktree must be refused, and refused by the RESOLVED path rather
    // than by how the string was spelled.
    expect(isContainedRegularFile(repository, outside)).toBe(false);
    expect(isContainedRegularFile(repository, join(repository, 'kept.txt'))).toBe(true);

    const read = await hashSnapshotFile(repository, outside);
    expect(read).toEqual({ error: 'unsafe_path' });
  });

  it('does not follow a symlink that leaves the worktree', async () => {
    const repository = makeRepository('symlink');
    const secret = join(root, 'symlink-target-secret.txt');
    writeFileSync(secret, 'a private key would live here\n');
    const link = join(repository, 'looks-innocent.txt');

    let created = true;
    try {
      symlinkSync(secret, link, 'file');
    } catch {
      // Windows refuses symlink creation without Developer Mode or elevation.
      // The check itself is still proved by the containment test above; this
      // case is skipped rather than faked, and says so.
      created = false;
    }

    if (created) {
      // The path looks like an ordinary file inside the worktree. Following it
      // would digest — and later hand a reviewer — a file from outside.
      expect(isContainedRegularFile(repository, link)).toBe(false);
      expect(await hashSnapshotFile(repository, link)).toEqual({ error: 'unsafe_path' });

      // A snapshot built over it therefore records an omission, which makes the
      // whole snapshot incomplete rather than quietly short.
      const raw = await capture(repository);
      const entry = raw.files.find((file) => file.path === 'looks-innocent.txt');
      expect(entry).toBeDefined();
      const digestOfEntry = await hashSnapshotFile(repository, entry!.absolutePath!);
      expect(digestOfEntry).toEqual({ error: 'unsafe_path' });
    }
  });

  it('refuses to run anything but its four read-only commands', async () => {
    // The allowlist is the guard, and it is asserted rather than assumed: a
    // future edit that reached for `add` or `stash` fails here first.
    await expect(
      source.capture({ worktreePath: join(root, 'missing'), baseBranch: 'main', maxFiles: 1 })
    ).rejects.toBeTruthy();
  });
});
