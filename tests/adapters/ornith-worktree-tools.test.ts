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
import { ExecaProcessRunner, type ProcessResult, type ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { OrnithWorktreeTools } from '../../src/main/services/ornith-worktree-tools';
import { ORNITH_LIMITS, containsAbsoluteMachinePath } from '../../src/shared/domain/ornith';

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

  describe('searchText checkout-identity recheck cadence', () => {
    // A broad search_text call used to re-run assertCheckoutIdentity — several
    // `git` subprocess spawns each — once per CANDIDATE FILE. On a repository
    // with a few hundred tracked files that alone exhausted searchTimeoutMs
    // before any actual grepping mattered. These tests prove the fix: the cost
    // is now bounded (not O(candidates)), and a worktree swapped out from
    // underneath a long scan is still caught within one recheck interval.
    it('scans 260 tracked files without an identity check per candidate file', async () => {
      for (let index = 0; index < 260; index += 1) {
        writeFileSync(join(worktree, `broad-${String(index).padStart(3, '0')}.txt`), 'needle appears once per file\n');
      }
      const recorded: string[][] = [];
      const boundary = toolsRecordingGitArgv(recorded);

      const started = Date.now();
      const result = await boundary.searchText({
        version: 1,
        action: 'search_text',
        query: 'needle',
        caseSensitive: false,
        // 261, not 260: hitting exactly `limit` is itself (pre-existingly, and
        // correctly) treated as possibly-truncated, since there might be more
        // beyond it — unrelated to what this test exercises.
        limit: 261
      });
      const elapsedMs = Date.now() - started;

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('unreachable');
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      expect(forModel.matches.length).toBe(260);
      expect(forModel.truncated).toBe(false);
      // Generous margin (real machines vary), but this is the assertion that
      // would have failed outright at 15s/20s before the fix: the old
      // per-candidate identity re-check made 260 files cost ~780 `git` spawns.
      expect(elapsedMs).toBeLessThan(10_000);

      // Manifest build (`ls-files --cached` + `ls-files --others`) is 2 calls;
      // the rest are `assertCheckoutIdentity` invocations (3 `rev-parse` calls
      // each). 260 candidates at a 25-file recheck interval is at most a
      // handful of rechecks — nowhere near 260 * 3 = 780.
      expect(recorded.length).toBeLessThan(40);
      for (const argv of recorded) {
        expect(ALLOWED_GIT_SUBCOMMANDS.has(argv[0] ?? '')).toBe(true);
      }
    });

    it('denies the whole call when the worktree root is replaced before it starts', async () => {
      const boundary = tools();
      // Build (and cache) the manifest against the real worktree first —
      // matching every real Ornith round, where the loop itself already
      // re-confirms checkout identity before dispatch and a search is never
      // the very first action against a brand-new tool instance.
      await boundary.listFiles({ version: 1, action: 'list_files', prefix: '', limit: 20 });
      const moved = join(root, 'moved-before-search');
      renameSync(worktree, moved);
      symlinkSync(moved, worktree, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const result = await boundary.searchText({ version: 1, action: 'search_text', query: 'alpha', caseSensitive: false, limit: 10 });
        expect(result).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
      } finally {
        unlinkSync(worktree);
        renameSync(moved, worktree);
      }
    });

    it('denies a scan and stops, rather than continuing, when the worktree root is replaced mid-scan', async () => {
      const originalInterval = ORNITH_LIMITS.searchIdentityRecheckFiles;
      // Shrink the recheck interval so a small, fast fixture still exercises a
      // real mid-scan recheck rather than needing hundreds of files.
      (ORNITH_LIMITS as { searchIdentityRecheckFiles: number }).searchIdentityRecheckFiles = 2;
      try {
        for (let index = 0; index < 8; index += 1) {
          writeFileSync(join(worktree, `mid-scan-${index}.txt`), 'needle\n');
        }
        let swapped = false;
        const boundary = new OrnithWorktreeTools({
          worktreePath: worktree,
          worktreesRoot,
          repositoryPath: repository,
          branchName: 'task',
          runner,
          gitExecutablePath: gitPath,
          testHooks: {
            beforeIdentityRecheck: () => {
              if (swapped) return;
              swapped = true;
              const moved = join(root, 'moved-mid-scan');
              renameSync(worktree, moved);
              symlinkSync(moved, worktree, process.platform === 'win32' ? 'junction' : 'dir');
            }
          }
        });

        try {
          const result = await boundary.searchText({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 20 });
          expect(swapped).toBe(true);
          expect(result).toMatchObject({ ok: false, code: 'checkout_identity_changed' });
        } finally {
          if (swapped) {
            const moved = join(root, 'moved-mid-scan');
            unlinkSync(worktree);
            renameSync(moved, worktree);
          }
        }
      } finally {
        (ORNITH_LIMITS as { searchIdentityRecheckFiles: number }).searchIdentityRecheckFiles = originalInterval;
      }
    });
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

    it('fails closed, rather than silently skipping, when a single entry cannot fit any budget', async () => {
      const boundary = tools();
      // 16 bytes cannot hold even the smallest possible {files:[],nextCursor,total}
      // skeleton, let alone one filename inside it.
      const result = await boundary.listFiles(
        { version: 1, action: 'list_files', prefix: '', limit: 200 },
        undefined,
        16
      );
      // Silently advancing past the entry (an earlier design) would let a run finish
      // having never enumerated a real, existing path — a false-positive-completion
      // risk. Silently returning it wrapped in a fixed explanatory stub is also wrong:
      // that stub is itself ~409 bytes and would not fit budgets between the 256-byte
      // internal floor and ~407 bytes either, reproducing the exact metadata-loss bug
      // this fix exists to close, just for a rarer trigger. Denying the action ends the
      // run honestly instead, through the same path every other Ornith denial already
      // uses.
      expect(result).toMatchObject({ ok: false, code: 'limit_result_exceeded' });
    });

    it('paginates a larger listing across many pages with no gaps, no duplicates, and preserved order', async () => {
      for (let index = 40; index < 120; index += 1) {
        writeFileSync(join(worktree, `roadmap-long-file-name-${String(index).padStart(3, '0')}.tsx`), 'export {};\n');
      }
      const boundary = tools();
      const full = await boundary.listFiles({ version: 1, action: 'list_files', prefix: '', limit: 200 });
      expect(full).toMatchObject({ ok: true });
      if (!full.ok) throw new Error('unreachable');
      const fullForModel = full.forModel as { files: string[]; total: number };
      expect(fullForModel.total).toBe(121); // 120 fixtures + fixture.txt

      const seen: string[] = [];
      let cursor: number | undefined;
      let pages = 0;
      for (;;) {
        const page = await boundary.listFiles(
          { version: 1, action: 'list_files', prefix: '', limit: 200, cursor },
          undefined,
          220 // tight enough to force several pages across 121 entries
        );
        expect(page).toMatchObject({ ok: true });
        if (!page.ok) throw new Error('unreachable');
        const pageForModel = page.forModel as { files: string[]; nextCursor: number | null; total: number };
        expect(Buffer.byteLength(JSON.stringify(page.forModel), 'utf8')).toBeLessThanOrEqual(220);
        expect(pageForModel.files.length).toBeGreaterThan(0);
        seen.push(...pageForModel.files);
        pages += 1;
        if (pageForModel.nextCursor === null) break;
        cursor = pageForModel.nextCursor;
        expect(pages).toBeLessThan(50); // guard against an infinite loop if cursor ever stalls
      }

      expect(pages).toBeGreaterThan(1); // must have actually needed multiple pages
      expect(seen).toEqual(fullForModel.files); // exact order preserved, no gaps
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
    });
  });

  describe('searchText byte-budget packing', () => {
    beforeEach(() => {
      for (let index = 0; index < 30; index += 1) {
        writeFileSync(
          join(worktree, `search-fixture-${String(index).padStart(3, '0')}.txt`),
          'needle appears once per file\n'
        );
      }
    });

    it('packs fewer matches than the requested limit under a tight byte budget, and marks the result truncated', async () => {
      const boundary = tools();
      // limit=35 against 30 real matches so a complete result is unambiguous: hitting
      // exactly `limit` is itself treated as possibly-truncated (there might be more
      // beyond it), a pre-existing, unrelated behavior this test does not exercise.
      const full = await boundary.searchText({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 35 });
      expect(full).toMatchObject({ ok: true });
      if (!full.ok) throw new Error('unreachable');
      const fullForModel = full.forModel as { matches: unknown[]; truncated: boolean };
      expect(fullForModel.matches.length).toBe(30);
      expect(fullForModel.truncated).toBe(false);

      const tight = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 35 },
        undefined,
        undefined,
        400
      );
      expect(tight).toMatchObject({ ok: true });
      if (!tight.ok) throw new Error('unreachable');
      const serializedBytes = Buffer.byteLength(JSON.stringify(tight.forModel), 'utf8');
      expect(serializedBytes).toBeLessThanOrEqual(400);
      const tightForModel = tight.forModel as { matches: unknown[]; truncated: boolean };
      expect(tightForModel.matches.length).toBeGreaterThan(0);
      expect(tightForModel.matches.length).toBeLessThan(30);
      // The budget cut it short before the declared limit was reached — this must be
      // visible as `truncated: true`, not silently presented as a complete result.
      expect(tightForModel.truncated).toBe(true);
    });

    it('fails closed rather than returning the dead-end {matches:[],truncated:true} when every real match is individually oversized', async () => {
      const boundary = tools();
      // Each of the 30 fixture files has one match, and each {path,line} entry for
      // them is 42 bytes — a 40-byte budget cannot fit even one. Silently returning
      // ok:true with an empty array here would be a dead end (no cursor to skip past
      // whichever match blocked it), so this must fail the action closed instead.
      const result = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 30 },
        undefined,
        undefined,
        40
      );
      expect(result).toMatchObject({ ok: false, code: 'limit_result_exceeded' });
      if (result.ok) throw new Error('unreachable');
      // Path is wrapped in JSON.stringify (quotes appear around it in the reason),
      // not raw-interpolated — the escaping-relevant property portably testable
      // without an OS-forbidden character in the filename itself (Windows already
      // disallows every character JSON.stringify would need to escape).
      expect(result.reason).toContain('"search-fixture-');
      expect(result.reason).not.toMatch(/[A-Za-z]:[\\/]|\\\\/); // no absolute machine path
      // This call passed no explicit `files`; the message must still be correct and
      // must not suggest that reducing the candidate COUNT would help, since the
      // failure is about one entry's own byte size, not how many files were searched.
      expect(result.reason).not.toMatch(/restrict\s+"files"/i);
      expect(result.reason).toContain('not a matter of searching fewer files');
      expect(result.reason).toContain('shorter repository-relative path');
    });

    it('escapes the offending path in the diagnostic via JSON.stringify, not raw interpolation', async () => {
      // Windows forbids every character JSON would need to escape (", \, control
      // characters) directly in a filename, so the escaping behavior is verified
      // structurally instead: the manifest is sorted, so "search-fixture-000.txt"
      // (the lexicographically first of the 30 fixtures) is always the entry
      // examined first here. Asserting the reason contains exactly
      // JSON.stringify('search-fixture-000.txt') proves that call is what produced
      // the text, not a raw `"${path}"` template that happens to look similar for
      // an already-safe name.
      const boundary = tools();
      const result = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 30 },
        undefined,
        undefined,
        40
      );
      expect(result).toMatchObject({ ok: false, code: 'limit_result_exceeded' });
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain(JSON.stringify('search-fixture-000.txt'));
    });

    it('break moves to the next candidate file and does not depend on the matched line\'s text length', async () => {
      const longPathName = `${'p'.repeat(150)}.txt`;
      writeFileSync(join(worktree, longPathName), 'needle\n', 'utf8');
      const hugeTextName = 'short.txt';
      // The matched line's actual text is enormous; {path,line} never includes it,
      // so this must still be treated as a small, easily-fitting entry.
      writeFileSync(join(worktree, hugeTextName), `needle ${'z'.repeat(5_000)}\n`, 'utf8');
      const boundary = tools();

      const result = await boundary.searchText(
        {
          version: 1,
          action: 'search_text',
          query: 'needle',
          caseSensitive: false,
          limit: 30,
          // Explicit order: the long-path (oversized) file is scanned strictly
          // before the short-path (huge-text) one.
          files: [longPathName, hugeTextName]
        },
        undefined,
        undefined,
        150 // fits the skeleton and short.txt's tiny entry; not longPathName's
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('unreachable');
      expect(Buffer.byteLength(JSON.stringify(result.forModel), 'utf8')).toBeLessThanOrEqual(150);
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      // Only the short-path match survived: proof the oversized file's match was
      // skipped (break moved on) AND that short.txt's huge line text did not, on its
      // own, cause its tiny {path,line} entry to be treated as oversized.
      expect(forModel.matches).toEqual([{ path: hugeTextName, line: 1 }]);
      expect(forModel.truncated).toBe(true);
    });

    it('always returns a result that fits maxResultBytes, or fails closed, across a sweep of budgets', async () => {
      const shortNames = Array.from({ length: 10 }, (_, i) => `sweep-${i}.txt`);
      const longNames = Array.from({ length: 3 }, (_, i) => `${'q'.repeat(150)}-${i}.txt`);
      for (const name of [...shortNames, ...longNames]) {
        writeFileSync(join(worktree, name), 'needle is present\n', 'utf8');
      }
      const boundary = tools();
      const files = [...longNames, ...shortNames]; // oversized entries scanned first

      for (const maxResultBytes of [10, 20, 31, 40, 60, 100, 150, 250, 500, 2_000, Number.POSITIVE_INFINITY]) {
        const result = await boundary.searchText(
          { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 20, files },
          undefined,
          undefined,
          maxResultBytes
        );
        if (result.ok) {
          const bytes = Buffer.byteLength(JSON.stringify(result.forModel), 'utf8');
          expect(bytes, `at maxResultBytes=${maxResultBytes}`).toBeLessThanOrEqual(maxResultBytes);
        } else {
          expect(result.code, `at maxResultBytes=${maxResultBytes}`).toBe('limit_result_exceeded');
        }
      }
    });

    it('fails closed before scanning when maxResultBytes cannot even hold the empty-result skeleton', async () => {
      const boundary = tools();
      // {"matches":[],"truncated":true} alone is 31 bytes; nothing this call could
      // ever return would fit a 20-byte budget, matched or not. This must be an
      // upfront, unconditional refusal rather than letting resultTextFor's own
      // fit-by-construction invariant check fail later with an internal error.
      const result = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 30 },
        undefined,
        undefined,
        20
      );
      expect(result).toMatchObject({ ok: false, code: 'limit_result_exceeded' });
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain('31');
      expect(result.reason).toContain('20');
    });

    it('skips an oversized first match and keeps scanning to find a later, smaller one that fits', async () => {
      const longName = `${'x'.repeat(150)}.txt`;
      writeFileSync(join(worktree, longName), 'needle appears here too\n', 'utf8');
      const shortName = 'z-short.txt';
      writeFileSync(join(worktree, shortName), 'needle appears here as well\n', 'utf8');
      const boundary = tools();

      const result = await boundary.searchText(
        {
          version: 1,
          action: 'search_text',
          query: 'needle',
          caseSensitive: false,
          limit: 30,
          // Explicit order: the oversized entry is scanned strictly before the small
          // one, proving the small one is still reached rather than the search
          // stopping at the first oversized candidate.
          files: [longName, shortName]
        },
        undefined,
        undefined,
        150 // fits the skeleton and the short entry, not the long one
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('unreachable');
      expect(Buffer.byteLength(JSON.stringify(result.forModel), 'utf8')).toBeLessThanOrEqual(150);
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      expect(forModel.matches).toEqual([{ path: shortName, line: 1 }]);
      expect(forModel.truncated).toBe(true); // the long match was real and was omitted
    });

    it('packs a mix of fitting and budget-skipped matches, preserving exact byte-bound compliance', async () => {
      const longNames = Array.from({ length: 3 }, (_, i) => `${'y'.repeat(150)}-${i}.txt`);
      const shortNames = Array.from({ length: 5 }, (_, i) => `short-${i}.txt`);
      for (const name of [...longNames, ...shortNames]) {
        writeFileSync(join(worktree, name), 'needle is here\n', 'utf8');
      }
      const boundary = tools();
      // Interleaved order: long, short, long, short, ... — proves skipping a long
      // entry does not stop the scan from reaching short entries on either side of it.
      const interleaved: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        if (longNames[i]) interleaved.push(longNames[i]!);
        interleaved.push(shortNames[i]!);
      }

      const result = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 30, files: interleaved },
        undefined,
        undefined,
        150 // fits some (not all) short entries and the skeleton, never a long one
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('unreachable');
      expect(Buffer.byteLength(JSON.stringify(result.forModel), 'utf8')).toBeLessThanOrEqual(250);
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      expect(forModel.matches.length).toBeGreaterThan(0);
      expect(forModel.matches.length).toBeLessThan(shortNames.length);
      for (const match of forModel.matches) {
        expect(shortNames).toContain(match.path); // never a long (skipped) entry
      }
      expect(forModel.truncated).toBe(true);
    });
  });

  describe('read_file accounting and identity-reuse policy', () => {
    it('charges the full file size for a small offset/limit slice, because identity/security verification requires the whole file', async () => {
      const content = 'y'.repeat(50_000);
      writeFileSync(join(worktree, 'large.txt'), content, 'utf8');
      const boundary = tools();

      const result = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'large.txt', offset: 10, limit: 5 },
        undefined,
        { readBytes: 50_000, writeBytes: 0 }
      );

      expect(result).toMatchObject({ ok: true, readBytes: 50_000 });
      if (!result.ok) throw new Error('expected a successful read');
      expect((result.forModel as { bytesRead: number }).bytesRead).toBe(5);
    });

    it('independently re-verifies a second read of the same path at a different offset, never reusing stale content', async () => {
      writeFileSync(join(worktree, 'mutable.txt'), 'AAAAAAAAAA', 'utf8');
      const boundary = tools();

      const first = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'mutable.txt', offset: 0, limit: 5 },
        undefined,
        { readBytes: 1000, writeBytes: 0 }
      );
      expect(first).toMatchObject({ ok: true, readBytes: 10 });

      // Replaced out from under the tool between two calls of the SAME run: a
      // cache keyed only on path (no design this repository adopted) would
      // still serve the stale content here; this tool has none, so the
      // second call must independently re-verify and see the new bytes.
      writeFileSync(join(worktree, 'mutable.txt'), 'BBBBBBBBBB', 'utf8');
      const second = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'mutable.txt', offset: 5, limit: 5 },
        undefined,
        { readBytes: 1000, writeBytes: 0 }
      );

      expect(second).toMatchObject({ ok: true, readBytes: 10 });
      if (!second.ok) throw new Error('expected a successful read');
      expect((second.forModel as { content: string }).content).toBe('BBBBB');
    });
  });

  describe('read_file totalBytes / nextOffset and result packing', () => {
    /** JSON-escape-heavy text: quotes, backticks, backslashes and newlines all inflate when serialized. */
    const escapeHeavyLine = '1. Open the "Settings" page, choose `Local inference`\\and press "Start"; expect "Healthy".\n';
    const escapeHeavy = escapeHeavyLine.repeat(420); // ~41 KB, like docs/manual-test.md in the real run

    function serializedBytes(value: unknown): number {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }

    type ReadResult = {
      path: string; offset: number; bytesRead: number; totalBytes: number;
      nextOffset: number | null; eof: boolean; content: string; sha256: string;
    };

    it('reports the file size and the offset a following chunk starts at, and null at the end of the file', async () => {
      writeFileSync(join(worktree, 'paged.txt'), 'y'.repeat(50_000), 'utf8');
      const boundary = tools();

      const first = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'paged.txt', offset: 10, limit: 5 },
        undefined,
        { readBytes: 50_000, writeBytes: 0 }
      );
      expect(first).toMatchObject({ ok: true, readBytes: 50_000 }); // accounting unchanged: the whole file
      if (!first.ok) throw new Error('expected a successful read');
      expect(first.forModel).toMatchObject({ offset: 10, bytesRead: 5, totalBytes: 50_000, nextOffset: 15, eof: false });

      const last = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'paged.txt', offset: 49_995, limit: 100 },
        undefined,
        { readBytes: 50_000, writeBytes: 0 }
      );
      if (!last.ok) throw new Error('expected a successful read');
      expect(last.forModel).toMatchObject({ bytesRead: 5, totalBytes: 50_000, nextOffset: null, eof: true });
    });

    it('follows nextOffset across multi-byte characters with no gaps and no duplicated bytes', async () => {
      const original = 'é€😀 mixed width text\n'.repeat(400);
      writeFileSync(join(worktree, 'wide.txt'), original, 'utf8');
      const boundary = tools();

      let offset = 0;
      let rebuilt = '';
      let pages = 0;
      for (;;) {
        const page = await boundary.readFile(
          { version: 1, action: 'read_file', path: 'wide.txt', offset, limit: 1001 }, // deliberately mid-character
          undefined,
          { readBytes: 1_000_000, writeBytes: 0 }
        );
        if (!page.ok) throw new Error('expected a successful read');
        const forModel = page.forModel as ReadResult;
        expect(forModel.bytesRead).toBeLessThanOrEqual(1001);
        rebuilt += forModel.content;
        pages += 1;
        if (forModel.nextOffset === null) break;
        expect(forModel.nextOffset).toBe(forModel.offset + forModel.bytesRead);
        offset = forModel.nextOffset;
        expect(pages).toBeLessThan(200);
      }
      expect(rebuilt).toBe(original);
    });

    it('packs the returned slice to the exact serialized result budget while still charging the whole file', async () => {
      writeFileSync(join(worktree, 'escape.md'), escapeHeavy, 'utf8');
      const raw = readFileSync(join(worktree, 'escape.md'));
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const boundary = tools();

      const result = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'escape.md', offset: 0, limit: 65_536 },
        undefined,
        { readBytes: 1_000_000, writeBytes: 0 },
        2_000
      );

      expect(result).toMatchObject({ ok: true, readBytes: raw.byteLength }); // honest: the full file was read
      if (!result.ok) throw new Error('expected a successful, packed read');
      expect(serializedBytes(result.forModel)).toBeLessThanOrEqual(2_000);
      const forModel = result.forModel as ReadResult;
      expect(forModel.bytesRead).toBeGreaterThan(0);
      expect(forModel.bytesRead).toBeLessThan(raw.byteLength);
      expect(forModel.totalBytes).toBe(raw.byteLength);
      expect(forModel.nextOffset).toBe(forModel.bytesRead);
      expect(forModel.eof).toBe(false);
      expect(forModel.sha256).toBe(sha256); // still over the COMPLETE file, not the slice
      expect(escapeHeavy.startsWith(forModel.content)).toBe(true);
    });

    it('pages a large escape-heavy file to completion under a tight budget: every page fits, none is a stub, none overlaps', async () => {
      writeFileSync(join(worktree, 'escape.md'), escapeHeavy, 'utf8');
      const boundary = tools();

      let offset = 0;
      let rebuilt = '';
      let pages = 0;
      for (;;) {
        const page = await boundary.readFile(
          { version: 1, action: 'read_file', path: 'escape.md', offset, limit: 65_536 },
          undefined,
          { readBytes: 1_000_000, writeBytes: 0 },
          1_500
        );
        if (!page.ok) throw new Error('expected a successful, packed read');
        expect(serializedBytes(page.forModel)).toBeLessThanOrEqual(1_500);
        const forModel = page.forModel as ReadResult;
        expect(forModel.bytesRead).toBeGreaterThan(0);
        expect(forModel.offset).toBe(offset);
        rebuilt += forModel.content;
        pages += 1;
        if (forModel.nextOffset === null) break;
        offset = forModel.nextOffset;
        expect(pages).toBeLessThan(200);
      }
      expect(rebuilt).toBe(escapeHeavy);
      expect(pages).toBeGreaterThan(1);
    });

    it('never splits a UTF-8 code point when packing: multi-byte text under a tight budget pages to exactly the original, every page valid', async () => {
      // 2-, 3- and 4-byte code points mixed with characters that JSON-escape, so the
      // packing binary search lands on many different byte limits, including
      // ones that fall inside a code point.
      const original = 'é€😀 "q" \\ end\n'.repeat(700);
      writeFileSync(join(worktree, 'wide-escape.md'), original, 'utf8');
      const boundary = tools();

      let offset = 0;
      let rebuilt = '';
      let pages = 0;
      for (;;) {
        const page = await boundary.readFile(
          { version: 1, action: 'read_file', path: 'wide-escape.md', offset, limit: 65_536 },
          undefined,
          { readBytes: 10_000_000, writeBytes: 0 },
          700
        );
        if (!page.ok) throw new Error('expected a successful, packed read');
        expect(serializedBytes(page.forModel)).toBeLessThanOrEqual(700);
        const forModel = page.forModel as ReadResult;
        expect(forModel.content).not.toContain('�'); // no replacement character: no split code point
        expect(Buffer.byteLength(forModel.content, 'utf8')).toBe(forModel.bytesRead); // the text IS the bytes
        expect(forModel.offset).toBe(offset);
        expect(forModel.bytesRead).toBeGreaterThan(0);
        rebuilt += forModel.content;
        pages += 1;
        if (forModel.nextOffset === null) break;
        expect(forModel.nextOffset).toBe(forModel.offset + forModel.bytesRead);
        offset = forModel.nextOffset;
        expect(pages).toBeLessThan(2_000);
      }
      expect(rebuilt).toBe(original);
      expect(pages).toBeGreaterThan(20);
    });

    it('reproduces the real defect: a chunk that fit the raw-byte clamp but not the serialized budget now returns content instead of a stub', async () => {
      writeFileSync(join(worktree, 'escape.md'), escapeHeavy, 'utf8');
      const raw = readFileSync(join(worktree, 'escape.md'));
      const budget = 10_890; // the real run's maxToolResultBytes
      const rawClamp = budget - 512; // what the dispatcher used to pass as the byte limit
      const naive = {
        path: 'escape.md', offset: 0, bytesRead: rawClamp, eof: false,
        content: raw.subarray(0, rawClamp).toString('utf8'), sha256: 'a'.repeat(64)
      };
      // Guard: this fixture really is one the old clamp got wrong (otherwise the test proves nothing).
      expect(serializedBytes(naive)).toBeGreaterThan(budget);

      const result = await tools().readFile(
        { version: 1, action: 'read_file', path: 'escape.md', offset: 0, limit: rawClamp },
        undefined,
        { readBytes: 1_000_000, writeBytes: 0 },
        budget
      );

      if (!result.ok) throw new Error('expected content, not a denial');
      expect(serializedBytes(result.forModel)).toBeLessThanOrEqual(budget);
      const forModel = result.forModel as ReadResult;
      expect(forModel.content.length).toBeGreaterThan(0);
      expect(forModel.sha256).toHaveLength(64);
      expect(forModel.nextOffset).not.toBeNull();
    });

    it('fails closed rather than returning a result over budget when not even an empty result fits', async () => {
      writeFileSync(join(worktree, 'tiny.txt'), 'hello\n', 'utf8');

      const result = await tools().readFile(
        { version: 1, action: 'read_file', path: 'tiny.txt', offset: 0, limit: 100 },
        undefined,
        { readBytes: 1_000, writeBytes: 0 },
        40
      );

      expect(result).toMatchObject({ ok: false, code: 'limit_result_exceeded' });
    });

    it('still refuses a credential-shaped file when the secret lies beyond the slice being returned', async () => {
      writeFileSync(
        join(worktree, 'later-secret.txt'),
        `safe start\n${'x'.repeat(200)}\ntoken=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n`,
        'utf8'
      );

      const result = await tools().readFile(
        { version: 1, action: 'read_file', path: 'later-secret.txt', offset: 0, limit: 5 },
        undefined,
        { readBytes: 10_000, writeBytes: 0 },
        1_000
      );

      expect(result).toMatchObject({ ok: false, code: 'disallowed_action' });
      expect(JSON.stringify(result)).not.toContain('ghp_');
    });

    it('still denies a read that would exceed the remaining read budget, independent of the result budget', async () => {
      writeFileSync(join(worktree, 'big.txt'), 'z'.repeat(5_000), 'utf8');

      const result = await tools().readFile(
        { version: 1, action: 'read_file', path: 'big.txt', offset: 0, limit: 10 },
        undefined,
        { readBytes: 4_999, writeBytes: 0 },
        10_000
      );

      expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    });
  });

  describe('resolveAuthoritativeScope', () => {
    // `search_text` deliberately does NOT consume this (a Coai review round found
    // that narrowing an omitted search to a declared scope could permanently hide
    // a real match in a file the scope claim omitted, whenever the scope file
    // itself also happened to contain an incidental match). It exists solely so
    // `OrnithImplementationService` can confirm a specification's declared scope
    // against the real manifest before rendering it in the prompt as a hint.
    function toolsWithScope(scopedFilePathCandidates: readonly string[]): OrnithWorktreeTools {
      return new OrnithWorktreeTools({
        worktreePath: worktree,
        worktreesRoot,
        repositoryPath: repository,
        branchName: 'task',
        runner,
        gitExecutablePath: gitPath,
        scopedFilePathCandidates
      });
    }

    it('resolves to the manifest-confirmed subset of declared candidates', async () => {
      writeFileSync(join(worktree, 'scoped.txt'), 'content\n', 'utf8');
      const boundary = toolsWithScope(['scoped.txt']);

      expect(await boundary.resolveAuthoritativeScope()).toEqual(['scoped.txt']);
    });

    it('drops a nonexistent declared candidate, resolving to null when nothing survives', async () => {
      const boundary = toolsWithScope(['docs/does-not-exist.md']);

      expect(await boundary.resolveAuthoritativeScope()).toBeNull();
    });

    it('resolves to null when no scope was declared at all', async () => {
      expect(await tools().resolveAuthoritativeScope()).toBeNull();
    });

    it('recovers from one transient manifest-build failure via its own bounded retry', async () => {
      writeFileSync(join(worktree, 'scoped.txt'), 'content\n', 'utf8');
      let calls = 0;
      const flakyRunner: ProcessRunner = {
        run: (file, args, options) => {
          calls += 1;
          if (calls === 1) {
            const failure: ProcessResult = {
              command: file, exitCode: 1, stdout: '', stderr: 'transient failure',
              timedOut: false, cancelled: false, durationMs: 1, failed: true
            };
            return Promise.resolve(failure);
          }
          return runner.run(file, args, options);
        }
      };
      const boundary = new OrnithWorktreeTools({
        worktreePath: worktree,
        worktreesRoot,
        repositoryPath: repository,
        branchName: 'task',
        runner: flakyRunner,
        gitExecutablePath: gitPath,
        scopedFilePathCandidates: ['scoped.txt']
      });

      // The first git call (inside the first ensureManifest attempt) fails;
      // the retry's calls all go through to the real runner and succeed.
      expect(await boundary.resolveAuthoritativeScope()).toEqual(['scoped.txt']);
      expect(calls).toBeGreaterThan(1);
    });

    it('does not depend on call order: the answer is the same when another tool built the manifest first', async () => {
      writeFileSync(join(worktree, 'scoped.txt'), 'content\n', 'utf8');
      const boundary = toolsWithScope(['scoped.txt']);

      // A tool dispatch builds the manifest before scope is ever resolved.
      const read = await boundary.readFile(
        { version: 1, action: 'read_file', path: 'scoped.txt', offset: 0, limit: 10 },
        undefined,
        { readBytes: 1_000, writeBytes: 0 }
      );
      expect(read).toMatchObject({ ok: true });

      expect(await boundary.resolveAuthoritativeScope()).toEqual(['scoped.txt']);
      expect(await boundary.resolveAuthoritativeScope()).toEqual(['scoped.txt']); // frozen, idempotent
    });

    it('freezes the decision permanently once resolved, even after a failed first attempt followed by a successful retry', async () => {
      writeFileSync(join(worktree, 'scoped.txt'), 'content\n', 'utf8');
      const boundary = toolsWithScope(['scoped.txt']);
      const aborted = new AbortController();
      aborted.abort();

      const first = await boundary.resolveAuthoritativeScope(aborted.signal);
      expect(first).toBeNull();

      // A later, real (non-aborted) call must not silently reach a different
      // answer than the one already decided and reported to the model.
      const second = await boundary.resolveAuthoritativeScope();
      expect(second).toBeNull();
    });
  });

  describe('searchText mid-scan cumulative read-budget handling', () => {
    it('returns honest partial matches and the true bytes read when the cumulative budget runs out mid-scan, never discarding progress', async () => {
      const matchBytes = Buffer.byteLength('needle\n', 'utf8');
      writeFileSync(join(worktree, 'a-match.txt'), 'needle\n', 'utf8');
      writeFileSync(join(worktree, 'b-toobig.txt'), 'z'.repeat(1000), 'utf8');
      const boundary = tools();

      const result = await boundary.searchText(
        {
          version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10,
          files: ['a-match.txt', 'b-toobig.txt']
        },
        undefined,
        { readBytes: matchBytes, writeBytes: 0 } // fits exactly the first candidate, never the second
      );

      expect(result).toMatchObject({ ok: true, readBytes: matchBytes });
      if (!result.ok) throw new Error('expected a partial success, not a denial');
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      expect(forModel.matches).toEqual([{ path: 'a-match.txt', line: 1 }]);
      expect(forModel.truncated).toBe(true);
    });

    it('denies with limit_read_bytes_exceeded and zero progress when even the first candidate cannot fit the remaining budget', async () => {
      writeFileSync(join(worktree, 'toobig.txt'), 'needle '.repeat(200), 'utf8');
      const boundary = tools();

      const result = await boundary.searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10, files: ['toobig.txt'] },
        undefined,
        { readBytes: 5, writeBytes: 0 }
      );

      expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    });

    function countingTools(counter: { gitCalls: number }): OrnithWorktreeTools {
      const countingRunner: ProcessRunner = {
        run: (file, args, options) => {
          if (file === gitPath) counter.gitCalls += 1;
          return runner.run(file, args, options);
        }
      };
      return new OrnithWorktreeTools({
        worktreePath: worktree,
        worktreesRoot,
        repositoryPath: repository,
        branchName: 'task',
        runner: countingRunner,
        gitExecutablePath: gitPath
      });
    }

    it('fails before any manifest, identity or per-file work when the read budget is already zero', async () => {
      writeFileSync(join(worktree, 'a.txt'), 'needle\n', 'utf8');
      const counter = { gitCalls: 0 };

      const result = await countingTools(counter).searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 },
        undefined,
        { readBytes: 0, writeBytes: 0 }
      );

      expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
      expect(counter.gitCalls).toBe(0); // decided by arithmetic alone: nothing was touched
    });

    it('stops scanning the moment the budget is spent exactly, instead of probing every remaining candidate', async () => {
      const matchBytes = Buffer.byteLength('needle\n', 'utf8');
      writeFileSync(join(worktree, 'f000.txt'), 'needle\n', 'utf8');
      for (let index = 1; index < 300; index += 1) {
        writeFileSync(join(worktree, `f${String(index).padStart(3, '0')}.txt`), 'x\n', 'utf8');
      }
      const action = { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 } as const;

      const exhausted = { gitCalls: 0 };
      const stopped = await countingTools(exhausted).searchText(action, undefined, { readBytes: matchBytes, writeBytes: 0 });
      expect(stopped).toMatchObject({ ok: true, readBytes: matchBytes });
      if (!stopped.ok) throw new Error('expected a partial success');
      expect((stopped.forModel as { matches: unknown[] }).matches).toEqual([{ path: 'f000.txt', line: 1 }]);
      expect((stopped.forModel as { truncated: boolean }).truncated).toBe(true);

      // Baseline: the identical search over ONE candidate. Its git cost is the fixed
      // cost of a search (manifest + identity checks). Probing the other 299
      // candidates would add a checkout-identity re-check (several git spawns)
      // every 25 of them, so an exact match proves none of them were probed.
      const single = { gitCalls: 0 };
      await countingTools(single).searchText(
        { ...action, files: ['f000.txt'] },
        undefined,
        { readBytes: matchBytes, writeBytes: 0 }
      );
      expect(exhausted.gitCalls).toBe(single.gitCalls);
    });

    it('does not search files over the per-file read cap or binary files, exactly as the protocol tells the model', async () => {
      writeFileSync(join(worktree, 'a-big.txt'), `needle\n${'z'.repeat(ORNITH_LIMITS.maxReadBytes)}`, 'utf8'); // one byte over the cap
      writeFileSync(join(worktree, 'b-binary.dat'), Buffer.concat([Buffer.from('needle '), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28])]));
      writeFileSync(join(worktree, 'c-ok.txt'), 'needle\n', 'utf8');

      const result = await tools().searchText(
        { version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 },
        undefined,
        { readBytes: 10_000_000, writeBytes: 0 }
      );

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('expected a successful search');
      const forModel = result.forModel as { matches: { path: string; line: number }[] };
      // Only the small text file is searched; a match in the two skipped files is invisible to search_text.
      expect(forModel.matches).toEqual([{ path: 'c-ok.txt', line: 1 }]);
    });

    it('skips an oversized candidate but keeps scanning smaller ones later in the list that still fit', async () => {
      const matchBytes = Buffer.byteLength('needle\n', 'utf8');
      writeFileSync(join(worktree, 'a-toobig.txt'), 'z'.repeat(1000), 'utf8');
      writeFileSync(join(worktree, 'b-fits.txt'), 'needle\n', 'utf8');
      const boundary = tools();

      const result = await boundary.searchText(
        {
          version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10,
          files: ['a-toobig.txt', 'b-fits.txt']
        },
        undefined,
        { readBytes: matchBytes, writeBytes: 0 } // fits only the second, smaller candidate
      );

      // Without skip-and-continue, the oversized first candidate would have
      // stopped the scan before ever reaching the second, smaller one that fits.
      expect(result).toMatchObject({ ok: true, readBytes: matchBytes });
      if (!result.ok) throw new Error('expected a successful, partial search');
      const forModel = result.forModel as { matches: { path: string; line: number }[]; truncated: boolean };
      expect(forModel.matches).toEqual([{ path: 'b-fits.txt', line: 1 }]);
      expect(forModel.truncated).toBe(true);
    });
  });

  describe('line endings and the replace_text JSON-escape diagnosis', () => {
    const budget = { readBytes: 1_000_000, writeBytes: 1_000_000 };
    const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
    /** What a doubled-backslash JSON escape of CRLF decodes to: four literal characters. */
    const literalCrlf = '\\r\\n';

    type ReadForModel = { lineEnding: string; content: string; bytesRead: number; totalBytes: number };

    async function readBack(name: string, content: string, limit = 65_536, maxResultBytes?: number): Promise<ReadForModel> {
      writeFileSync(join(worktree, name), content);
      const result = await tools().readFile(
        { version: 1, action: 'read_file', path: name, offset: 0, limit },
        undefined,
        budget,
        maxResultBytes
      );
      if (!result.ok) throw new Error(`expected a successful read, got ${result.code}`);
      return result.forModel as ReadForModel;
    }

    async function replaceIn(name: string, content: string, oldText: string, newText: string, hash = sha(content)) {
      writeFileSync(join(worktree, name), content);
      const boundary = tools();
      const result = await boundary.replaceText(
        { version: 1, action: 'replace_text', path: name, sha256: hash, replacements: [{ oldText, newText }] },
        undefined,
        budget
      );
      return { result, boundary, bytes: readFileSync(join(worktree, name)) };
    }

    it.each([
      ['lf', 'one\ntwo\nthree\n'],
      ['crlf', 'one\r\ntwo\r\nthree\r\n'],
      ['mixed', 'one\r\ntwo\nthree\r\n'],
      ['mixed', 'one\rtwo'],
      ['none', 'a single line with no break at all']
    ])('read_file classifies the whole file as %s (%j)', async (expected, content) => {
      const forModel = await readBack('endings.txt', content);
      expect(forModel.lineEnding).toBe(expected);
      expect(forModel.content).toBe(content); // classification never changes what is returned
    });

    it('classifies from the complete file, not from the returned slice', async () => {
      const content = `${'x'.repeat(300)}\r\nsecond line\r\n`;
      const forModel = await readBack('window.txt', content, 50);

      expect(forModel.content).toBe('x'.repeat(50)); // this window holds no line break at all
      expect(forModel.lineEnding).toBe('crlf');
    });

    it('still packs a line-ending-bearing, escape-heavy result inside the serialized budget', async () => {
      const line = '1. Open the "Settings" page, choose `Local inference`\\and press "Start"; expect "Healthy".\r\n';
      const forModel = await readBack('heavy.txt', line.repeat(420), 65_536, 1_500);

      expect(forModel.lineEnding).toBe('crlf');
      expect(forModel.bytesRead).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(forModel), 'utf8')).toBeLessThanOrEqual(1_500);
    });

    it('replaces text in a CRLF file when oldText carries real CR and LF characters (what a single-backslash JSON escape decodes to)', async () => {
      const original = 'title\r\nkeep this line\r\ntail\r\n';
      const decoded = (JSON.parse('{"oldText":"keep this line\\r\\ntail"}') as { oldText: string }).oldText;
      expect(decoded).toBe('keep this line\r\ntail');

      const { result, bytes } = await replaceIn('crlf.txt', original, decoded, 'kept\r\ntail');

      expect(result).toMatchObject({ ok: true });
      expect(bytes.toString('utf8')).toBe('title\r\nkept\r\ntail\r\n');
    });

    it.each([
      ['crlf', 'CRLF', 'first line\r\nsecond line\r\n', `first line${literalCrlf}second line`],
      ['lf', 'LF', 'first line\nsecond line\n', 'first line\\nsecond line']
    ])('refuses a literal backslash escape in oldText on a %s file with a precise diagnosis and writes nothing', async (_style, label, content, oldText) => {
      const { result, boundary, bytes } = await replaceIn('escaped.txt', content, oldText, 'replacement');

      expect(result).toMatchObject({ ok: false, code: 'replacement_escape_suspected' });
      if (result.ok) throw new Error('expected a refusal');
      expect(result.reason).toContain(`${label} line endings`);
      expect(result.reason).toContain('JSON escaping');
      expect(result.reason.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxErrorChars);
      // Neither oldText nor any file content is echoed, and the text cannot be mistaken for a UNC path.
      expect(result.reason).not.toContain('first line');
      expect(result.reason).not.toContain('second line');
      expect(containsAbsoluteMachinePath(result.reason)).toBe(false);
      expect(bytes.toString('utf8')).toBe(content);
      expect(boundary.changedFileCount()).toBe(0);
    });

    it.each([
      ['mixed', 'first line\r\nsecond line\nthird'],
      ['none', 'first line second line']
    ])('keeps the plain replacement_mismatch for a %s file (no known LF/CRLF style to diagnose)', async (_style, content) => {
      const { result, bytes } = await replaceIn('unknown-style.txt', content, `first line${literalCrlf}second line`, 'x');

      expect(result).toMatchObject({ ok: false, code: 'replacement_mismatch' });
      expect(bytes.toString('utf8')).toBe(content);
    });

    it('keeps the plain replacement_mismatch when oldText has no literal backslash escape', async () => {
      const { result } = await replaceIn('plain.txt', 'a\r\nb\r\n', 'not present', 'x');

      expect(result).toMatchObject({ ok: false, code: 'replacement_mismatch' });
    });

    it('does not diagnose text that really occurs in the file more than once: that is an ambiguous match, not an escaping mistake', async () => {
      const content = `a${literalCrlf}b\r\nc${literalCrlf}d\r\n`;
      const { result } = await replaceIn('twice.txt', content, literalCrlf, 'x');

      expect(result).toMatchObject({ ok: false, code: 'replacement_mismatch' });
    });

    it('checks the file hash first: a stale sha256 is still stale_hash, never the escape diagnosis', async () => {
      const { result, bytes } = await replaceIn(
        'stale.txt', 'first line\r\nsecond line\r\n', `first line${literalCrlf}second line`, 'x', sha('some other content')
      );

      expect(result).toMatchObject({ ok: false, code: 'stale_hash' });
      expect(bytes.toString('utf8')).toBe('first line\r\nsecond line\r\n');
    });

    it('never classifies or diagnoses input that is not valid UTF-8, even when it holds CR/LF bytes: both tools refuse it as non-text first', async () => {
      // CR LF, then bytes that are not UTF-8, then the four literal characters an escaped CRLF decodes to.
      const raw = Buffer.concat([Buffer.from('line\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from(literalCrlf), Buffer.from('\r\n')]);
      writeFileSync(join(worktree, 'binary.dat'), raw);

      const read = await tools().readFile(
        { version: 1, action: 'read_file', path: 'binary.dat', offset: 0, limit: 100 }, undefined, budget
      );
      expect(read).toMatchObject({ ok: false, code: 'path_not_regular_file' });
      expect(JSON.stringify(read)).not.toContain('lineEnding');

      const boundary = tools();
      const replaced = await boundary.replaceText(
        {
          version: 1, action: 'replace_text', path: 'binary.dat', sha256: sha(raw),
          replacements: [{ oldText: literalCrlf, newText: 'x' }]
        },
        undefined,
        budget
      );
      expect(replaced).toMatchObject({ ok: false, code: 'path_not_regular_file' });
      expect(readFileSync(join(worktree, 'binary.dat')).equals(raw)).toBe(true);
      expect(boundary.changedFileCount()).toBe(0);
    });

    it('is all-or-nothing across several replacements: a valid first one followed by an escape-suspected second one writes nothing', async () => {
      const content = 'alpha\r\nbeta line\r\ngamma\r\n';
      writeFileSync(join(worktree, 'multi.txt'), content);
      const boundary = tools();

      const result = await boundary.replaceText(
        {
          version: 1, action: 'replace_text', path: 'multi.txt', sha256: sha(content),
          replacements: [
            { oldText: 'alpha', newText: 'ALPHA' }, // valid, would apply in memory first
            { oldText: `beta line${literalCrlf}gamma`, newText: 'x' } // escape-suspected
          ]
        },
        undefined,
        budget
      );

      expect(result).toMatchObject({ ok: false, code: 'replacement_escape_suspected' });
      expect(readFileSync(join(worktree, 'multi.txt'), 'utf8')).toBe(content); // not even the first replacement landed
      expect(boundary.changedFileCount()).toBe(0);
    });

    it('replaces a block that spans a CRLF and a bare LF in a mixed file byte-exactly, converting nothing', async () => {
      const content = 'one\r\ntwo\nthree\r\nfour\n';
      const spanning = 'two\nthree\r\nfour'; // what single-backslash JSON escapes for LF and CRLF decode to

      const { result, bytes } = await replaceIn('mixed.txt', content, spanning, 'TWO\nTHREE\r\nFOUR');

      expect(result).toMatchObject({ ok: true });
      expect(bytes.toString('utf8')).toBe('one\r\nTWO\nTHREE\r\nFOUR\n');
    });

    it('never decodes or normalizes literal backslash sequences that really are the file text', async () => {
      // A CRLF documentation file whose text legitimately contains the four-character sequence.
      const original =
        `Escapes\r\nUse ${literalCrlf} in a JSON string.\r\nAlso keep ${literalCrlf} and \\n here.\r\nend\r\n`;
      const { result, bytes } = await replaceIn(
        'doc.md', original, `Use ${literalCrlf} in a JSON string.`, `Use ${literalCrlf} or \\r in a JSON string.`
      );

      expect(result).toMatchObject({ ok: true });
      // Only the addressed literal text changed; every other literal sequence and every real CRLF is byte-identical.
      expect(bytes.toString('utf8')).toBe(
        `Escapes\r\nUse ${literalCrlf} or \\r in a JSON string.\r\nAlso keep ${literalCrlf} and \\n here.\r\nend\r\n`
      );
      const forModel = await readBack('doc-after.txt', bytes.toString('utf8'));
      expect(forModel.content).toBe(bytes.toString('utf8'));
      expect(forModel.lineEnding).toBe('crlf');
    });
  });
});
