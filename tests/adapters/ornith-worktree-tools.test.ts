import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { OrnithWorktreeTools } from '../../src/main/services/ornith-worktree-tools';

const runner = new ExecaProcessRunner();
const locatedGit = locateExecutable('git');
if (!locatedGit) throw new Error('Git is required by the Ornith worktree-tool suite.');
const gitPath = locatedGit.path;
const roots: string[] = [];

let root: string;
let repository: string;
let worktreesRoot: string;
let worktree: string;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run(gitPath, args, {
    cwd,
    timeoutMs: 20_000,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true'
    }
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function tools(testHooks?: ConstructorParameters<typeof OrnithWorktreeTools>[0]['testHooks']): OrnithWorktreeTools {
  return new OrnithWorktreeTools({
    worktreePath: worktree,
    worktreesRoot,
    repositoryPath: repository,
    branchName: 'task',
    runner,
    gitExecutablePath: gitPath,
    testHooks
  });
}

/** Every read-only Git subcommand Ornith is ever allowed to invoke. */
const ALLOWED_GIT_SUBCOMMANDS = new Set(['rev-parse', 'ls-files', 'status', 'diff']);
const MUTATING_GIT_VERBS = [
  'commit', 'push', 'checkout', 'reset', 'merge', 'rebase', 'clean',
  'branch', 'remote', 'fetch', 'pull', 'stash', 'tag', 'worktree', 'add', 'restore'
];

function toolsRecordingGitArgv(recorded: string[][]): OrnithWorktreeTools {
  const recordingRunner = {
    run: (file: string, args: readonly string[], options?: Parameters<typeof runner.run>[2]) => {
      if (file === gitPath) recorded.push([...args]);
      return runner.run(file, args, options);
    }
  };
  return new OrnithWorktreeTools({
    worktreePath: worktree,
    worktreesRoot,
    repositoryPath: repository,
    branchName: 'task',
    runner: recordingRunner,
    gitExecutablePath: gitPath
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-ornith-tools-'));
  roots.push(root);
  repository = join(root, 'repository');
  worktreesRoot = join(root, 'worktrees');
  worktree = join(worktreesRoot, 'task');
  mkdirSync(repository, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Ornith Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'fixture.txt'), 'alpha π omega\n', 'utf8');
  await git(repository, ['add', '--', 'fixture.txt']);
  await git(repository, ['commit', '-m', 'fixture']);
  await git(repository, ['worktree', 'add', '-b', 'task', worktree, 'HEAD']);
});

afterEach(() => {
  for (const path of roots.splice(0)) {
    try {
      if (existsSync(worktree) && lstatSync(worktree).isSymbolicLink()) unlinkSync(worktree);
    } catch {
      // The enclosing temporary root cleanup below remains the fallback.
    }
    rmSync(path, { recursive: true, force: true });
  }
});

describe('OrnithWorktreeTools containment and budgets', () => {
  it('rejects a recorded worktree root replaced by a junction before any operation', () => {
    const moved = join(root, 'moved-task');
    renameSync(worktree, moved);
    symlinkSync(moved, worktree, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => tools()).toThrow(/real directory|reparse point/i);
    expect(readFileSync(join(moved, 'fixture.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('alpha π omega\n');
  });

  it('returns a stable whole-file SHA-256 and prevents over-budget reads and writes', async () => {
    const boundary = tools();
    const raw = readFileSync(join(worktree, 'fixture.txt'));
    const sha256 = createHash('sha256').update(raw).digest('hex');

    const deniedRead = await boundary.readFile(
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4 },
      undefined,
      { readBytes: raw.byteLength - 1, writeBytes: 0 }
    );
    expect(deniedRead).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });

    const read = await boundary.readFile(
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 1, limit: 8 },
      undefined,
      { readBytes: raw.byteLength, writeBytes: 0 }
    );
    expect(read).toMatchObject({ ok: true, readBytes: raw.byteLength });
    if (!read.ok) throw new Error('expected a successful read');
    expect(read.forModel).toMatchObject({ sha256 });

    const deniedCreate = await boundary.createFile(
      { version: 1, action: 'create_file', path: 'created.txt', content: 'four' },
      undefined,
      { readBytes: 0, writeBytes: 3 }
    );
    expect(deniedCreate).toMatchObject({ ok: false, code: 'limit_write_bytes_exceeded' });
    expect(existsSync(join(worktree, 'created.txt'))).toBe(false);

    const replaced = await boundary.replaceText(
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256,
        replacements: [{ oldText: 'omega', newText: 'delta' }]
      },
      undefined,
      { readBytes: raw.byteLength * 2, writeBytes: raw.byteLength }
    );
    expect(replaced).toMatchObject({ ok: true, readBytes: raw.byteLength * 2, writeBytes: raw.byteLength });
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('alpha π delta\n');
  });

  it('never returns credential-shaped content from git_diff', async () => {
    writeFileSync(join(worktree, 'secret.txt'), 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n', 'utf8');
    const result = await tools().gitDiff(
      { version: 1, action: 'git_diff', paths: ['secret.txt'] },
      undefined,
      { readBytes: 4096, writeBytes: 0 }
    );

    expect(result).toMatchObject({ ok: false, code: 'disallowed_action' });
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('preserves newer in-place content when replace or delete reaches its mutation boundary', async () => {
    const original = readFileSync(join(worktree, 'fixture.txt'));
    const sha256 = createHash('sha256').update(original).digest('hex');
    let operation: 'replace_text' | 'delete_file' = 'replace_text';
    const boundary = tools({
      beforeMutation: (kind) => {
        if (kind === operation) writeFileSync(join(worktree, 'fixture.txt'), 'newer concurrent content\n', 'utf8');
      }
    });

    const replaceResult = await boundary.replaceText(
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256,
        replacements: [{ oldText: 'omega', newText: 'delta' }]
      },
      undefined,
      { readBytes: 4096, writeBytes: 4096 }
    );
    expect(replaceResult).toMatchObject({ ok: false, code: 'stale_hash' });
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('newer concurrent content');

    writeFileSync(join(worktree, 'fixture.txt'), original);
    operation = 'delete_file';
    const deleteResult = await boundary.deleteFile(
      { version: 1, action: 'delete_file', path: 'fixture.txt', sha256 },
      undefined,
      { readBytes: 4096, writeBytes: 0 }
    );
    expect(deleteResult).toMatchObject({ ok: false, code: 'stale_hash' });
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('newer concurrent content');
  });

  it('denies a destination-parent junction swap before create, replacement, or deletion mutation', async () => {
    const directory = join(worktree, 'nested');
    const displaced = join(worktree, 'nested-original');
    const outside = join(root, 'outside');
    mkdirSync(directory);
    mkdirSync(outside);
    writeFileSync(join(directory, 'existing.txt'), 'inside\n', 'utf8');
    writeFileSync(join(outside, 'existing.txt'), 'outside\n', 'utf8');
    const sha256 = createHash('sha256').update('inside\n').digest('hex');
    let swapped = false;
    const boundary = tools({
      beforeMutation: () => {
        if (swapped) return;
        swapped = true;
        renameSync(directory, displaced);
        symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
      }
    });

    const createResult = await boundary.createFile(
      { version: 1, action: 'create_file', path: 'nested/new.txt', content: 'must stay inside\n' },
      undefined,
      { readBytes: 0, writeBytes: 4096 }
    );
    expect(createResult).toMatchObject({ ok: false, code: 'path_symlink' });
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);

    unlinkSync(directory);
    renameSync(displaced, directory);
    swapped = false;
    const replaceResult = await boundary.replaceText(
      {
        version: 1,
        action: 'replace_text',
        path: 'nested/existing.txt',
        sha256,
        replacements: [{ oldText: 'inside', newText: 'changed' }]
      },
      undefined,
      { readBytes: 4096, writeBytes: 4096 }
    );
    expect(replaceResult).toMatchObject({ ok: false, code: 'path_symlink' });
    expect(readFileSync(join(outside, 'existing.txt'), 'utf8')).toBe('outside\n');

    unlinkSync(directory);
    renameSync(displaced, directory);
    swapped = false;
    const deleteResult = await boundary.deleteFile(
      { version: 1, action: 'delete_file', path: 'nested/existing.txt', sha256 },
      undefined,
      { readBytes: 4096, writeBytes: 0 }
    );
    expect(deleteResult).toMatchObject({ ok: false, code: 'path_symlink' });
    expect(readFileSync(join(outside, 'existing.txt'), 'utf8')).toBe('outside\n');
  });

  /**
   * The native mutation guard is the only thing here that can prove safety at
   * the actual syscall boundary: every check above `beforeNativeMutation`
   * fires (`resolveSafe`, `readRegularFileSafely`, `assertCheckoutIdentity`)
   * is pathname-based and therefore already stale by the time the guard
   * process is spawned. These cases swap the destination ancestor to a real
   * Windows junction *after* every one of those JavaScript-level checks has
   * already passed cleanly, and prove the guard's own from-scratch,
   * handle-relative walk still refuses the mutation and nothing escapes the
   * worktree — independent of, and later than, anything JavaScript checked.
   */
  it.runIf(process.platform === 'win32')(
    'the native mutation guard independently refuses create, replace, delete and mkdirp when the ancestor is swapped after every JavaScript-level recheck',
    async () => {
      const directory = join(worktree, 'nested');
      const outside = join(root, 'outside');
      mkdirSync(directory);
      mkdirSync(outside);
      writeFileSync(join(directory, 'existing.txt'), 'inside\n', 'utf8');
      writeFileSync(join(outside, 'existing.txt'), 'outside\n', 'utf8');
      const sha256 = createHash('sha256').update('inside\n').digest('hex');

      const swapToJunctionOutside = (): void => {
        rmSync(directory, { recursive: true, force: true });
        symlinkSync(outside, directory, 'junction');
      };
      const restoreDirectory = (): void => {
        unlinkSync(directory);
        mkdirSync(directory);
        writeFileSync(join(directory, 'existing.txt'), 'inside\n', 'utf8');
      };

      // `nested` already exists for every case here except the dedicated
      // mkdirp one below, so `mkdirp`'s own no-op success must not be the
      // thing that swaps the ancestor — only the final create/replace/delete
      // call should ever see the swapped directory, proving the swap is
      // caught at the actual mutation boundary and not merely earlier.
      const boundary = tools({
        beforeNativeMutation: (kind) => {
          if (kind !== 'mkdirp') swapToJunctionOutside();
        }
      });

      const createResult = await boundary.createFile(
        { version: 1, action: 'create_file', path: 'nested/new.txt', content: 'must stay inside\n' },
        undefined,
        { readBytes: 0, writeBytes: 4096 }
      );
      expect(createResult).toMatchObject({ ok: false, code: 'path_symlink' });
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
      restoreDirectory();

      const replaceResult = await boundary.replaceText(
        {
          version: 1,
          action: 'replace_text',
          path: 'nested/existing.txt',
          sha256,
          replacements: [{ oldText: 'inside', newText: 'changed' }]
        },
        undefined,
        { readBytes: 4096, writeBytes: 4096 }
      );
      expect(replaceResult).toMatchObject({ ok: false, code: 'path_symlink' });
      expect(readFileSync(join(outside, 'existing.txt'), 'utf8')).toBe('outside\n');
      restoreDirectory();

      const deleteResult = await boundary.deleteFile(
        { version: 1, action: 'delete_file', path: 'nested/existing.txt', sha256 },
        undefined,
        { readBytes: 4096, writeBytes: 0 }
      );
      expect(deleteResult).toMatchObject({ ok: false, code: 'path_symlink' });
      expect(readFileSync(join(outside, 'existing.txt'), 'utf8')).toBe('outside\n');
      restoreDirectory();

      // mkdirp: a dedicated boundary swaps only on the mkdirp call itself, for
      // a brand-new nested path, proving directory creation is bound to the
      // same handle-relative guarantee as file mutation rather than the
      // pathname-based `mkdir(recursive)` this replaced. `nested` is already
      // a plain directory again after the delete case's `restoreDirectory()`.
      const mkdirpBoundary = tools({
        beforeNativeMutation: (kind) => {
          if (kind === 'mkdirp') swapToJunctionOutside();
        }
      });
      const mkdirpResult = await mkdirpBoundary.createFile(
        { version: 1, action: 'create_file', path: 'nested/deeper/new.txt', content: 'must stay inside\n' },
        undefined,
        { readBytes: 0, writeBytes: 4096 }
      );
      expect(mkdirpResult).toMatchObject({ ok: false, code: 'path_symlink' });
      expect(existsSync(join(outside, 'deeper'))).toBe(false);
    }
  );

  it.runIf(process.platform === 'win32')(
    'the native mutation guard refuses create, replace, delete and mkdirp when the entire worktree root is replaced by an ordinary directory after validation',
    async () => {
      const originalContent = readFileSync(join(worktree, 'fixture.txt'), 'utf8');
      const sha256 = createHash('sha256').update(originalContent).digest('hex');
      let caseNumber = 0;

      const boundaryWithWholeRootSwap = (): OrnithWorktreeTools => tools({
        beforeNativeMutation: () => {
          caseNumber += 1;
          const displaced = join(root, `bound-task-${caseNumber}`);
          renameSync(worktree, displaced);
          mkdirSync(worktree);
          writeFileSync(join(worktree, 'fixture.txt'), originalContent, 'utf8');
        }
      });
      const restoreBoundRoot = (): string => {
        const displaced = join(root, `bound-task-${caseNumber}`);
        const replacementFixture = readFileSync(join(worktree, 'fixture.txt'), 'utf8');
        rmSync(worktree, { recursive: true, force: true });
        renameSync(displaced, worktree);
        return replacementFixture;
      };

      const createResult = await boundaryWithWholeRootSwap().createFile(
        { version: 1, action: 'create_file', path: 'new.txt', content: 'must not reach replacement root\n' },
        undefined,
        { readBytes: 0, writeBytes: 4096 }
      );
      expect(createResult).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
      expect(existsSync(join(worktree, 'new.txt'))).toBe(false);
      expect(restoreBoundRoot()).toBe(originalContent);
      expect(existsSync(join(worktree, 'new.txt'))).toBe(false);

      const replaceResult = await boundaryWithWholeRootSwap().replaceText(
        {
          version: 1,
          action: 'replace_text',
          path: 'fixture.txt',
          sha256,
          replacements: [{ oldText: 'omega', newText: 'changed' }]
        },
        undefined,
        { readBytes: 4096, writeBytes: 4096 }
      );
      expect(replaceResult).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe(originalContent);
      expect(restoreBoundRoot()).toBe(originalContent);
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe(originalContent);

      const deleteResult = await boundaryWithWholeRootSwap().deleteFile(
        { version: 1, action: 'delete_file', path: 'fixture.txt', sha256 },
        undefined,
        { readBytes: 4096, writeBytes: 0 }
      );
      expect(deleteResult).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
      expect(existsSync(join(worktree, 'fixture.txt'))).toBe(true);
      expect(restoreBoundRoot()).toBe(originalContent);
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe(originalContent);

      const mkdirpResult = await boundaryWithWholeRootSwap().createFile(
        { version: 1, action: 'create_file', path: 'nested/deeper/new.txt', content: 'must not reach replacement root\n' },
        undefined,
        { readBytes: 0, writeBytes: 4096 }
      );
      expect(mkdirpResult).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
      expect(existsSync(join(worktree, 'nested'))).toBe(false);
      expect(restoreBoundRoot()).toBe(originalContent);
      expect(existsSync(join(worktree, 'nested'))).toBe(false);
    }
  );

  it.runIf(process.platform === 'win32')(
    'replace refuses a different same-name file introduced after the JavaScript hash check even when its content and hash are identical',
    async () => {
      const originalContent = readFileSync(join(worktree, 'fixture.txt'), 'utf8');
      const sha256 = createHash('sha256').update(originalContent).digest('hex');
      const preservedOriginal = join(worktree, 'fixture-original.txt');
      const boundary = tools({
        beforeNativeMutation: (kind) => {
          if (kind !== 'replace_text') return;
          renameSync(join(worktree, 'fixture.txt'), preservedOriginal);
          writeFileSync(join(worktree, 'fixture.txt'), originalContent, 'utf8');
        }
      });

      const result = await boundary.replaceText(
        {
          version: 1,
          action: 'replace_text',
          path: 'fixture.txt',
          sha256,
          replacements: [{ oldText: 'omega', newText: 'changed' }]
        },
        undefined,
        { readBytes: 4096, writeBytes: 4096 }
      );

      expect(result).toMatchObject({ ok: false, code: 'stale_hash' });
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe(originalContent);
      expect(readFileSync(preservedOriginal, 'utf8')).toBe(originalContent);
    }
  );

  it.runIf(process.platform === 'win32')(
    'normal create, replace, and delete still succeed byte-for-byte through the native mutation guard',
    async () => {
      const boundary = tools();
      const original = readFileSync(join(worktree, 'fixture.txt'));
      const sha256 = createHash('sha256').update(original).digest('hex');

      const created = await boundary.createFile(
        { version: 1, action: 'create_file', path: 'nested/deep/new.txt', content: 'created via the guard\n' },
        undefined,
        { readBytes: 0, writeBytes: 4096 }
      );
      expect(created).toMatchObject({ ok: true });
      expect(readFileSync(join(worktree, 'nested/deep/new.txt'), 'utf8')).toBe('created via the guard\n');

      const replaced = await boundary.replaceText(
        {
          version: 1,
          action: 'replace_text',
          path: 'fixture.txt',
          sha256,
          replacements: [{ oldText: 'omega', newText: 'guarded' }]
        },
        undefined,
        { readBytes: original.byteLength * 2, writeBytes: original.byteLength + 64 }
      );
      expect(replaced).toMatchObject({ ok: true });
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('alpha π guarded\n');

      const newSha256 = createHash('sha256')
        .update(readFileSync(join(worktree, 'fixture.txt')))
        .digest('hex');
      const deleted = await boundary.deleteFile(
        { version: 1, action: 'delete_file', path: 'fixture.txt', sha256: newSha256 },
        undefined,
        { readBytes: 4096, writeBytes: 0 }
      );
      expect(deleted).toMatchObject({ ok: true });
      expect(existsSync(join(worktree, 'fixture.txt'))).toBe(false);
    }
  );

  it('never invokes Git with a mutating subcommand across every read and write action', async () => {
    const recorded: string[][] = [];
    const boundary = toolsRecordingGitArgv(recorded);
    const original = readFileSync(join(worktree, 'fixture.txt'));
    const sha256 = createHash('sha256').update(original).digest('hex');

    await boundary.listFiles({ version: 1, action: 'list_files', prefix: '', limit: 20 });
    await boundary.readFile({ version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4096 });
    await boundary.searchText({ version: 1, action: 'search_text', query: 'alpha', caseSensitive: false, limit: 10 });
    await boundary.gitStatus();
    await boundary.gitDiff({ version: 1, action: 'git_diff' }, undefined, { readBytes: 1 << 20, writeBytes: 0 });
    await boundary.createFile(
      { version: 1, action: 'create_file', path: 'created.txt', content: 'x' },
      undefined,
      { readBytes: 0, writeBytes: 64 }
    );
    await boundary.replaceText(
      { version: 1, action: 'replace_text', path: 'fixture.txt', sha256, replacements: [{ oldText: 'alpha', newText: 'beta' }] },
      undefined,
      { readBytes: 4096, writeBytes: 4096 }
    );
    await boundary.deleteFile(
      { version: 1, action: 'delete_file', path: 'created.txt', sha256: createHash('sha256').update('x').digest('hex') },
      undefined,
      { readBytes: 64, writeBytes: 0 }
    );

    expect(recorded.length).toBeGreaterThan(0);
    for (const argv of recorded) {
      const subcommand = argv[0];
      expect(ALLOWED_GIT_SUBCOMMANDS.has(subcommand ?? '')).toBe(true);
      for (const verb of MUTATING_GIT_VERBS) {
        expect(argv).not.toContain(verb);
      }
    }
  });

  describe('listFiles byte-budget packing', () => {
    beforeEach(() => {
      // Untracked files in the worktree are part of the Ornith manifest too
      // (`ensureManifest` runs `git ls-files --others --exclude-standard`
      // against the worktree), so no commit is needed to exercise pagination.
      for (let index = 0; index < 40; index += 1) {
        writeFileSync(join(worktree, `roadmap-long-file-name-${String(index).padStart(3, '0')}.tsx`), 'export {};\n');
      }
    });

    it('packs fewer entries than requested when the byte budget is tight, and reports a correct nextCursor', async () => {
      const boundary = tools();
      const full = await boundary.listFiles({ version: 1, action: 'list_files', prefix: '', limit: 200 });
      expect(full).toMatchObject({ ok: true });
      if (!full.ok) throw new Error('unreachable');
      const fullForModel = full.forModel as { files: string[]; nextCursor: number | null; total: number };
      expect(fullForModel.total).toBe(41); // 40 fixtures + fixture.txt
      expect(fullForModel.files.length).toBe(41);
      expect(fullForModel.nextCursor).toBeNull();

      const tight = await boundary.listFiles(
        { version: 1, action: 'list_files', prefix: '', limit: 200 },
        undefined,
        300
      );
      expect(tight).toMatchObject({ ok: true });
      if (!tight.ok) throw new Error('unreachable');
      const serializedBytes = Buffer.byteLength(JSON.stringify(tight.forModel), 'utf8');
      expect(serializedBytes).toBeLessThanOrEqual(300);
      const tightForModel = tight.forModel as { files: string[]; nextCursor: number | null; total: number };
      expect(tightForModel.files.length).toBeGreaterThan(0);
      expect(tightForModel.files.length).toBeLessThan(fullForModel.files.length);
      expect(tightForModel.total).toBe(41);
      expect(tightForModel.nextCursor).toBe(tightForModel.files.length);

      // Resuming with the reported cursor must reach the end without gaps or repeats.
      const resumed = await boundary.listFiles(
        { version: 1, action: 'list_files', prefix: '', limit: 200, cursor: tightForModel.nextCursor! },
        undefined,
        300
      );
      expect(resumed).toMatchObject({ ok: true });
      if (!resumed.ok) throw new Error('unreachable');
      const resumedForModel = resumed.forModel as { files: string[] };
      const seen = new Set([...tightForModel.files, ...resumedForModel.files]);
      expect(seen.size).toBe(tightForModel.files.length + resumedForModel.files.length);
    });

    it('returns a small metadata-preserving stub, not the generic truncation stub, when even one entry does not fit', async () => {
      const boundary = tools();
      const result = await boundary.listFiles(
        { version: 1, action: 'list_files', prefix: '', limit: 200 },
        undefined,
        // Smaller than even the shortest single entry plus its JSON wrapper.
        16
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('unreachable');
      // Fixed-shape stub (two integers, a boolean, and a constant-length message) —
      // small by construction regardless of how tiny the requested budget was.
      expect(Buffer.byteLength(JSON.stringify(result.forModel), 'utf8')).toBeLessThanOrEqual(400);
      expect(result.forModel).toMatchObject({
        files: [],
        nextCursor: 0,
        total: 41,
        truncated: true
      });
      const forModel = result.forModel as { reason: string };
      expect(forModel.reason).toContain('byte budget');
    });
  });
});
