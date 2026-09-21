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
    // The file's hash was shown by the read above, so both internal validation re-reads are
    // charged to the separate edit-validation budget and none to discovery.
    expect(replaced).toMatchObject({
      ok: true,
      readBytes: 0,
      validationReadBytes: raw.byteLength * 2,
      writeBytes: raw.byteLength
    });
    expect(boundary.validationReadBytesUsed()).toBe(raw.byteLength * 2);
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

describe('OrnithWorktreeTools mutation validation budget', () => {
  const MIB = 1024 * 1024;
  /** Nothing left for the model to discover with; edits must not depend on it. */
  const NO_DISCOVERY = { readBytes: 0, writeBytes: MIB * 4 };

  const shaOf = (raw: string | Buffer): string => createHash('sha256').update(raw).digest('hex');

  /** Read `path` the way the model does, so its hash is one Relay has shown. Returns that hash. */
  async function showHash(boundary: OrnithWorktreeTools, path: string): Promise<string> {
    const read = await boundary.readFile({ version: 1, action: 'read_file', path, offset: 0, limit: 8 });
    if (!read.ok) throw new Error(`expected a successful read of ${path}: ${read.code}`);
    return (read.forModel as { sha256: string }).sha256;
  }

  function write(path: string, content: string): Buffer {
    writeFileSync(join(worktree, path), content, 'utf8');
    return readFileSync(join(worktree, path));
  }

  const replace = (path: string, sha256: string, oldText = 'omega', newText = 'delta') => ({
    version: 1 as const,
    action: 'replace_text' as const,
    path,
    sha256,
    replacements: [{ oldText, newText }]
  });

  it('charges the internal re-reads of a shown file to validation and none to discovery, at 0 discovery bytes', async () => {
    const boundary = tools();
    const sha256 = await showHash(boundary, 'fixture.txt');
    const size = readFileSync(join(worktree, 'fixture.txt')).byteLength;

    const result = await boundary.replaceText(replace('fixture.txt', sha256), undefined, NO_DISCOVERY);

    expect(result).toMatchObject({ ok: true, readBytes: 0, validationReadBytes: size * 2 });
    expect(boundary.validationReadBytesUsed()).toBe(size * 2);
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('delta');
  });

  it('still charges an edit of a file whose hash was never shown to the discovery budget, and refuses it when that is short', async () => {
    const boundary = tools();
    const raw = readFileSync(join(worktree, 'fixture.txt'));

    const result = await boundary.replaceText(
      replace('fixture.txt', shaOf(raw)),
      undefined,
      { readBytes: raw.byteLength - 1, writeBytes: MIB }
    );

    expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    expect(boundary.validationReadBytesUsed()).toBe(0);
    expect(readFileSync(join(worktree, 'fixture.txt'))).toEqual(raw);

    const withBudget = await boundary.replaceText(
      replace('fixture.txt', shaOf(raw)),
      undefined,
      { readBytes: raw.byteLength * 2, writeBytes: MIB }
    );
    expect(withBudget).toMatchObject({ ok: true, readBytes: raw.byteLength * 2 });
    expect(boundary.validationReadBytesUsed()).toBe(0);
  });

  it('does not let a hash shown for one file authorize an edit of another', async () => {
    write('other.txt', 'omega elsewhere\n');
    const boundary = tools();
    const otherSha = await showHash(boundary, 'other.txt');
    const target = readFileSync(join(worktree, 'fixture.txt'));

    // The target's own hash is right, but only `other.txt`'s hash was ever shown for `other.txt`.
    const result = await boundary.replaceText(replace('fixture.txt', shaOf(target)), undefined, NO_DISCOVERY);
    expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    // …and a hash shown for another path is not shown for this one.
    const wrongPath = await boundary.replaceText(replace('fixture.txt', otherSha), undefined, NO_DISCOVERY);
    expect(wrongPath).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    expect(boundary.validationReadBytesUsed()).toBe(0);
    expect(readFileSync(join(worktree, 'fixture.txt'))).toEqual(target);
  });

  it('fails closed on a target changed after its last read, charging Relay for the one read that found it', async () => {
    const boundary = tools();
    const sha256 = await showHash(boundary, 'fixture.txt');
    writeFileSync(join(worktree, 'fixture.txt'), 'alpha π OMEGA\n', 'utf8');
    const changed = readFileSync(join(worktree, 'fixture.txt'));

    const result = await boundary.replaceText(replace('fixture.txt', sha256), undefined, NO_DISCOVERY);

    expect(result).toMatchObject({ ok: false, code: 'stale_hash' });
    expect(boundary.validationReadBytesUsed()).toBe(changed.byteLength);
    expect(readFileSync(join(worktree, 'fixture.txt'))).toEqual(changed);
  });

  it('keeps the time-of-check/time-of-use guard on the validation budget: a swap at the mutation boundary is refused', async () => {
    const original = readFileSync(join(worktree, 'fixture.txt'));
    const boundary = tools({
      beforeMutation: () => writeFileSync(join(worktree, 'fixture.txt'), 'newer concurrent content\n', 'utf8')
    });
    const sha256 = await showHash(boundary, 'fixture.txt');

    const result = await boundary.replaceText(replace('fixture.txt', sha256), undefined, NO_DISCOVERY);

    expect(result).toMatchObject({ ok: false, code: 'stale_hash' });
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe('newer concurrent content\n');
    // Both internal reads were paid for: the first, and the final re-read that caught the swap.
    expect(boundary.validationReadBytesUsed()).toBe(original.byteLength * 2);
  });

  it('treats a target that grew at the mutation boundary as stale, never reading past the size it validated', async () => {
    const original = readFileSync(join(worktree, 'fixture.txt'));
    const boundary = tools({
      beforeMutation: () => writeFileSync(join(worktree, 'fixture.txt'), Buffer.concat([original, Buffer.alloc(64 * 1024, 0x61)]))
    });
    const sha256 = await showHash(boundary, 'fixture.txt');

    const result = await boundary.replaceText(replace('fixture.txt', sha256), undefined, NO_DISCOVERY);

    expect(result).toMatchObject({ ok: false, code: 'stale_hash' });
    expect(boundary.validationReadBytesUsed()).toBe(original.byteLength * 2);
    expect(readFileSync(join(worktree, 'fixture.txt')).byteLength).toBe(original.byteLength + 64 * 1024);
  });

  it('deletes a shown file at 0 discovery bytes on the validation budget, and prunes its authorization', async () => {
    const boundary = tools();
    const sha256 = await showHash(boundary, 'fixture.txt');
    const size = readFileSync(join(worktree, 'fixture.txt')).byteLength;

    const result = await boundary.deleteFile(
      { version: 1, action: 'delete_file', path: 'fixture.txt', sha256 },
      undefined,
      { readBytes: 0, writeBytes: 0 }
    );

    expect(result).toMatchObject({ ok: true, readBytes: 0, validationReadBytes: size * 2 });
    expect(existsSync(join(worktree, 'fixture.txt'))).toBe(false);
    expect(boundary.validationReadBytesUsed()).toBe(size * 2);
  });

  it('refuses to delete a file whose hash was never shown when discovery cannot cover it', async () => {
    const boundary = tools();
    const raw = readFileSync(join(worktree, 'fixture.txt'));

    const result = await boundary.deleteFile(
      { version: 1, action: 'delete_file', path: 'fixture.txt', sha256: shaOf(raw) },
      undefined,
      { readBytes: 0, writeBytes: 0 }
    );

    expect(result).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    expect(readFileSync(join(worktree, 'fixture.txt'))).toEqual(raw);
    expect(boundary.validationReadBytesUsed()).toBe(0);
  });

  it('authorizes a further edit with the hash an edit or a create returned', async () => {
    const boundary = tools();
    const first = await boundary.createFile(
      { version: 1, action: 'create_file', path: 'made.txt', content: 'omega one\n' },
      undefined,
      NO_DISCOVERY
    );
    if (!first.ok) throw new Error(first.reason);
    const second = await boundary.replaceText(
      replace('made.txt', (first.forModel as { sha256: string }).sha256, 'one', 'two'),
      undefined,
      NO_DISCOVERY
    );
    if (!second.ok) throw new Error(second.reason);
    const third = await boundary.replaceText(
      replace('made.txt', (second.forModel as { sha256: string }).sha256, 'two', 'three'),
      undefined,
      NO_DISCOVERY
    );

    expect(third).toMatchObject({ ok: true, readBytes: 0 });
    expect(readFileSync(join(worktree, 'made.txt'), 'utf8')).toBe('omega three\n');
    // Two 10-byte files' worth of double reads: 'omega one\n' then 'omega two\n'.
    expect(boundary.validationReadBytesUsed()).toBe(2 * 10 + 2 * 10);
  });

  it('bounds cumulative validation itself: retries that fail still spend it, and the bound is never exceeded', async () => {
    write('big.txt', `${'a'.repeat(MIB - 6)}omega\n`);
    const boundary = tools();
    const sha256 = await showHash(boundary, 'big.txt');
    const limit = ORNITH_LIMITS.maxCumulativeMutationValidationBytes;
    const attempt = () => boundary.replaceText(replace('big.txt', sha256, 'no such text', 'x'), undefined, NO_DISCOVERY);

    // A mismatch is found after the first read only, so each failed attempt costs 1 MiB of validation.
    // Two reads of a MiB must still fit before an attempt starts: seven attempts do, the eighth does not.
    for (let index = 1; index <= 7; index += 1) {
      expect(await attempt()).toMatchObject({ ok: false, code: 'replacement_mismatch' });
      expect(boundary.validationReadBytesUsed()).toBe(index * MIB);
    }
    const refused = await attempt();
    expect(refused).toMatchObject({ ok: false, code: 'limit_mutation_validation_bytes_exceeded' });
    expect(refused.ok ? '' : refused.reason).toContain(`of the ${limit}-byte mutation-validation budget remain`);
    // Refusing did not read anything, and a further retry is refused just the same.
    expect(boundary.validationReadBytesUsed()).toBe(7 * MIB);
    expect(await attempt()).toMatchObject({ ok: false, code: 'limit_mutation_validation_bytes_exceeded' });
    expect(boundary.validationReadBytesUsed()).toBeLessThanOrEqual(limit);
    expect(readFileSync(join(worktree, 'big.txt')).byteLength).toBe(MIB);
  });

  it('refuses a target above the per-change size bound before reading it, whether or not its hash was shown', async () => {
    const raw = write('huge.txt', `${'b'.repeat(ORNITH_LIMITS.maxFileBytes)}omega\n`);
    const boundary = tools();
    const shown = await showHash(boundary, 'huge.txt');

    for (const sha256 of [shown, shaOf('never shown')]) {
      const result = await boundary.replaceText(replace('huge.txt', sha256), undefined, NO_DISCOVERY);
      expect(result).toMatchObject({ ok: false, code: 'limit_mutation_target_bytes_exceeded' });
    }
    expect(boundary.validationReadBytesUsed()).toBe(0);
    expect(readFileSync(join(worktree, 'huge.txt'))).toEqual(raw);
  });

  it('refuses to delete a target above the per-change size bound before reading it, whatever budget is left', async () => {
    const raw = write('huge.txt', `${'b'.repeat(ORNITH_LIMITS.maxFileBytes)}omega\n`);
    const boundary = tools();
    const shown = await showHash(boundary, 'huge.txt');

    for (const sha256 of [shown, shaOf('never shown')]) {
      const result = await boundary.deleteFile(
        { version: 1, action: 'delete_file', path: 'huge.txt', sha256 },
        undefined,
        { readBytes: raw.byteLength * 4, writeBytes: 0 }
      );
      expect(result).toMatchObject({ ok: false, code: 'limit_mutation_target_bytes_exceeded' });
    }
    expect(existsSync(join(worktree, 'huge.txt'))).toBe(true);
    expect(boundary.validationReadBytesUsed()).toBe(0);
  });

  it('never returns file content, or anything but the fixed reason, for a refused validation', async () => {
    write('big.txt', `${'a'.repeat(MIB - 6)}omega\n`);
    const boundary = tools();
    const sha256 = await showHash(boundary, 'big.txt');
    for (let index = 0; index < 7; index += 1) {
      await boundary.replaceText(replace('big.txt', sha256, 'no such text', 'x'), undefined, NO_DISCOVERY);
    }

    const refused = await boundary.replaceText(replace('big.txt', sha256, 'no such text', 'x'), undefined, NO_DISCOVERY);

    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain('aaaa');
    expect(JSON.stringify(refused)).not.toContain('omega');
  });
});

describe('OrnithWorktreeTools git_diff against the remaining discovery budget', () => {
  const diff = { version: 1 as const, action: 'git_diff' as const, paths: ['fixture.txt'] };
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

  const editFixture = (text: string): void => writeFileSync(join(worktree, 'fixture.txt'), text, 'utf8');

  /** Tools whose `git diff` is answered by `answer`; every other Git call (identity, manifest) is real. */
  function toolsAnsweringDiff(answer: Partial<ProcessResult>): OrnithWorktreeTools {
    const wrapping = {
      run: (file: string, args: readonly string[], options?: Parameters<typeof runner.run>[2]): Promise<ProcessResult> =>
        file === gitPath && args[0] === 'diff'
          ? Promise.resolve({
              command: 'git diff',
              exitCode: 0,
              stdout: '',
              stderr: '',
              timedOut: false,
              cancelled: false,
              durationMs: 1,
              failed: false,
              ...answer
            })
          : runner.run(file, args, options)
    };
    return new OrnithWorktreeTools({
      worktreePath: worktree,
      worktreesRoot,
      repositoryPath: repository,
      branchName: 'task',
      runner: wrapping,
      gitExecutablePath: gitPath
    });
  }

  it('still returns a small diff that fits, charging its bytes to discovery', async () => {
    editFixture('alpha π delta\n');

    const result = await tools().gitDiff(diff);

    expect(result).toMatchObject({ ok: true, writeBytes: 0 });
    if (!result.ok) throw new Error(result.reason);
    expect((result.forModel as { diff: string }).diff).toContain('delta');
    expect(result.readBytes).toBeGreaterThan(0);
    expect(result.readBytes).toBe(Buffer.byteLength((result.forModel as { diff: string }).diff, 'utf8'));
  });

  it('returns a diff of exactly the remaining bytes, and refuses one byte more or nothing left', async () => {
    editFixture('alpha π delta\n');
    const full = await tools().gitDiff(diff);
    if (!full.ok) throw new Error(full.reason);
    const bytes = full.readBytes;

    const exact = await tools().gitDiff(diff, undefined, { readBytes: bytes, writeBytes: 0 });
    expect(exact).toMatchObject({ ok: true, readBytes: bytes });

    for (const remaining of [bytes - 1, 0]) {
      const refused = await tools().gitDiff(diff, undefined, { readBytes: remaining, writeBytes: 0 });
      expect(refused, `remaining ${remaining}`).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
      expect(refused.ok ? '' : refused.reason).toContain('discovery budget');
      // A refusal carries no part of the diff.
      expect(JSON.stringify(refused)).not.toContain('delta');
    }
  });

  it('refuses a diff far beyond what the process layer may buffer as a budget refusal, not an internal error', async () => {
    editFixture(`alpha π omega\n${'lorem ipsum dolor sit amet\n'.repeat(4_000)}`);

    for (const remaining of [100, 0]) {
      const refused = await tools().gitDiff(diff, undefined, { readBytes: remaining, writeBytes: 0 });
      expect(refused).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
      expect(JSON.stringify(refused)).not.toContain('lorem');
    }
    // …and with the budget there, the very same diff is returned (truncated for the model, never refused).
    const fits = await tools().gitDiff(diff);
    expect(fits).toMatchObject({ ok: true });
  });

  it('keeps a genuine Git failure distinct from a budget refusal', async () => {
    const limits = { readBytes: 100, writeBytes: 0 };

    // Git itself failed.
    const failed = await toolsAnsweringDiff({ exitCode: 128, failed: true, stderr: 'fatal: bad revision' }).gitDiff(diff, undefined, limits);
    expect(failed).toMatchObject({ ok: false, code: 'internal_error', reason: 'git diff could not be read.' });

    // Failed with no sign the output cap was involved, even though stdout happens to be large.
    const noFlag = await toolsAnsweringDiff({ failed: true, stdout: 'x'.repeat(5_000) }).gitDiff(diff, undefined, limits);
    expect(noFlag).toMatchObject({ ok: false, code: 'internal_error' });

    // The output cap was hit: the diff does not fit, whatever length of it the runner happened to keep
    // (it may have trimmed a newline, leaving exactly the remaining bytes) — and none of it is returned.
    for (const kept of [50, 99, 100, 5_000]) {
      const overflow = await toolsAnsweringDiff({ failed: true, outputLimitExceeded: true, stdout: 'x'.repeat(kept) }).gitDiff(diff, undefined, limits);
      expect(overflow, `kept ${kept}`).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
      expect(JSON.stringify(overflow)).not.toContain('xxxxx');
    }
  });

  it('decides the same way when Git prints a line-ending warning on stderr', async () => {
    // A Windows checkout prints an LF-to-CRLF notice on stderr, and the runner caps stderr at the same
    // size as stdout. The decision must still be the exact byte comparison on stdout, at the boundary.
    await git(repository, ['config', 'core.autocrlf', 'true']);
    editFixture('alpha π delta\n');
    const probe = await runner.run(gitPath, ['diff', 'HEAD', '--', 'fixture.txt'], { cwd: worktree, timeoutMs: 20_000 });
    expect(probe.stderr).toContain('will be replaced by');
    const full = await tools().gitDiff(diff);
    if (!full.ok) throw new Error(full.reason);

    const exact = await tools().gitDiff(diff, undefined, { readBytes: full.readBytes, writeBytes: 0 });
    expect(exact).toMatchObject({ ok: true, readBytes: full.readBytes });

    const refused = await tools().gitDiff(diff, undefined, { readBytes: full.readBytes - 1, writeBytes: 0 });
    expect(refused).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
  });

  /**
   * Tools whose `git diff` is a real process, through the real runner with the options the tool set, that
   * prints a short diff on stdout and `stderrBytes` of warnings on stderr.
   */
  function toolsWithNoisyDiff(stderrBytes: number): OrnithWorktreeTools {
    const script = `process.stdout.write(${JSON.stringify('+a line of diff\n'.repeat(3))}); process.stderr.write('w'.repeat(${stderrBytes}));`;
    const wrapping = {
      run: (file: string, args: readonly string[], options?: Parameters<typeof runner.run>[2]): Promise<ProcessResult> =>
        file === gitPath && args[0] === 'diff'
          ? runner.run(process.execPath, ['-e', script], options)
          : runner.run(file, args, options)
    };
    return new OrnithWorktreeTools({
      worktreePath: worktree,
      worktreesRoot,
      repositoryPath: repository,
      branchName: 'task',
      runner: wrapping,
      gitExecutablePath: gitPath
    });
  }

  it('is not thrown by any amount of stderr: only stdout is measured against the remaining budget', async () => {
    // 200 KB of warnings — far more than the stdout cap for these few bytes, and more than any fixed headroom.
    const noisy = toolsWithNoisyDiff(200_000);
    const full = await noisy.gitDiff(diff);
    if (!full.ok) throw new Error(full.reason);
    const bytes = full.readBytes;
    expect(bytes).toBeGreaterThan(0);

    expect(await noisy.gitDiff(diff, undefined, { readBytes: bytes, writeBytes: 0 })).toMatchObject({ ok: true, readBytes: bytes });
    for (const remaining of [bytes - 1, 0]) {
      expect(await noisy.gitDiff(diff, undefined, { readBytes: remaining, writeBytes: 0 }), `remaining ${remaining}`).toMatchObject({
        ok: false,
        code: 'limit_read_bytes_exceeded'
      });
    }
  });

  it('refuses an oversized diff as a budget even when the runner trims a newline at the cut', async () => {
    // The runner strips a final newline from what it kept, so when the cap lands right after a line break
    // the retained text is one shorter than the cap: exactly the remaining bytes, not more. It is the cap
    // being hit that proves the diff does not fit — never the length of what was kept.
    const script = `process.stdout.write(${JSON.stringify('x\n'.repeat(500))});`;
    const wrapping = {
      run: (file: string, args: readonly string[], options?: Parameters<typeof runner.run>[2]): Promise<ProcessResult> =>
        file === gitPath && args[0] === 'diff'
          ? runner.run(process.execPath, ['-e', script], options)
          : runner.run(file, args, options)
    };
    const boundary = new OrnithWorktreeTools({
      worktreePath: worktree,
      worktreesRoot,
      repositoryPath: repository,
      branchName: 'task',
      runner: wrapping,
      gitExecutablePath: gitPath
    });

    // An even remaining size puts the cap (remaining + 1) right after a "\n" in "x\nx\n…".
    for (const remaining of [99, 101, 199, 0, 1, 2]) {
      const result = await boundary.gitDiff(diff, undefined, { readBytes: remaining, writeBytes: 0 });
      expect(result, `remaining ${remaining}`).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    }
  });

  it('treats a stderr of any size as irrelevant: it is never captured, so it cannot fail a diff', async () => {
    // Far more than any output cap: still just a diff that fits.
    const result = await toolsWithNoisyDiff(9 * 1024 * 1024).gitDiff(diff);

    expect(result).toMatchObject({ ok: true });
  });

  it('never lets a clamped or negative remaining budget reach the runner as a non-positive cap', async () => {
    for (const remaining of [0, -5]) {
      const result = await toolsWithNoisyDiff(10).gitDiff(diff, undefined, { readBytes: remaining, writeBytes: 0 });
      expect(result, `remaining ${remaining}`).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    }
  });

  it('keeps credential detection fail-closed, and returns none of a credential-shaped diff over budget either', async () => {
    const secretDiff = `diff --git a/fixture.txt b/fixture.txt\n+token=${TOKEN}\n`;

    // Within budget: refused as credential-shaped, nothing returned.
    const within = await toolsAnsweringDiff({ stdout: secretDiff }).gitDiff(diff);
    expect(within).toMatchObject({ ok: false, code: 'disallowed_action' });
    expect(JSON.stringify(within)).not.toContain('ghp_');

    // Over budget: a budget refusal — and still none of it.
    const over = await toolsAnsweringDiff({ stdout: secretDiff }).gitDiff(diff, undefined, { readBytes: 10, writeBytes: 0 });
    expect(over).toMatchObject({ ok: false, code: 'limit_read_bytes_exceeded' });
    expect(JSON.stringify(over)).not.toContain('ghp_');

    // A real tracked edit that adds a token never puts it in a result.
    editFixture(`token=${TOKEN}\n`);
    const real = await tools().gitDiff(diff);
    expect(JSON.stringify(real)).not.toContain(TOKEN);
  });
});

describe('OrnithWorktreeTools facts for verification recovery', () => {
  const runGit = (args: readonly string[]): Promise<string> => git(worktree, args);

  describe('searchText matchCount', () => {
    it('is 0 for a search of the named file that found nothing, and the number of matches when it found some', async () => {
      const boundary = tools();
      const empty = await boundary.searchText({ version: 1, action: 'search_text', query: 'zz-no-such-text', caseSensitive: false, files: ['fixture.txt'], limit: 10 });
      const found = await boundary.searchText({ version: 1, action: 'search_text', query: 'alpha', caseSensitive: false, files: ['fixture.txt'], limit: 10 });

      expect(empty).toMatchObject({ ok: true, matchCount: 0 });
      expect(found).toMatchObject({ ok: true, matchCount: 1 });
    });

    it('is withheld — not reported as 0 — when a named file could not be searched, so an incomplete scan never reads as "empty"', async () => {
      // A binary file: it cannot be decoded as text, so it is skipped rather than searched.
      writeFileSync(join(worktree, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0xa0, 0xa1]));
      const boundary = tools();

      const withBinary = await boundary.searchText({ version: 1, action: 'search_text', query: 'zz-no-such-text', caseSensitive: false, files: ['fixture.txt', 'blob.bin'], limit: 10 });
      expect(withBinary).toMatchObject({ ok: true });
      expect(withBinary).not.toHaveProperty('matchCount');

      // A candidate too large for what is left of the read budget is skipped, not searched.
      writeFileSync(join(worktree, 'big.txt'), `${'filler line\n'.repeat(200)}`, 'utf8');
      const overBudget = await tools().searchText( // a fresh executor: its manifest is read once, so it must see big.txt
        { version: 1, action: 'search_text', query: 'zz-no-such-text', caseSensitive: false, files: ['fixture.txt', 'big.txt'], limit: 10 },
        undefined,
        { readBytes: 100, writeBytes: 0 }
      );
      expect(overBudget).toMatchObject({ ok: true, forModel: { truncated: true } });
      expect(overBudget).not.toHaveProperty('matchCount');
    });
  });

  describe('workingTreeChangedFileCount', () => {
    it('counts tracked edits and untracked files, and is 0 for a clean worktree', async () => {
      const boundary = tools();
      expect(await boundary.workingTreeChangedFileCount()).toBe(0);

      writeFileSync(join(worktree, 'fixture.txt'), 'changed\n', 'utf8');
      writeFileSync(join(worktree, 'new-file.txt'), 'new\n', 'utf8');
      expect(await boundary.workingTreeChangedFileCount()).toBe(2);
    });

    it('counts changes this tool executor did not make', async () => {
      const boundary = tools();
      writeFileSync(join(worktree, 'fixture.txt'), 'edited by an earlier attempt\n', 'utf8');

      expect(boundary.changedFileCount()).toBe(0); // its own edits
      expect(await boundary.workingTreeChangedFileCount()).toBe(1);
    });

    it('is unknown (null), not a guess, when Git cannot answer, and when the run was already aborted', async () => {
      const failing = new OrnithWorktreeTools({
        worktreePath: worktree,
        worktreesRoot,
        repositoryPath: repository,
        branchName: 'task',
        gitExecutablePath: gitPath,
        runner: {
          run: async (file, args, options) =>
            args[0] === 'status'
              ? { command: file, exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false, cancelled: false, durationMs: 1, failed: true }
              : runner.run(file, args, options)
        }
      });
      expect(await failing.workingTreeChangedFileCount()).toBeNull();

      const aborted = new AbortController();
      aborted.abort();
      expect(await tools().workingTreeChangedFileCount(aborted.signal)).toBeNull();
    });

    it('asks Git only a fixed, read-only question and shows nothing to the model', async () => {
      const recorded: string[][] = [];
      await toolsRecordingGitArgv(recorded).workingTreeChangedFileCount();

      const statusCalls = recorded.filter((argv) => argv.includes('status'));
      expect(statusCalls).toEqual([['status', '--porcelain=v1', '--untracked-files=all']]);
      for (const argv of recorded) {
        expect(ALLOWED_GIT_SUBCOMMANDS.has(argv[0]!)).toBe(true);
        for (const verb of MUTATING_GIT_VERBS) expect(argv).not.toContain(verb);
      }
    });
  });

  describe('worktreeFingerprint', () => {
    it('is stable for unchanged files and different for changed ones', async () => {
      const boundary = tools();
      const clean = await boundary.worktreeFingerprint();
      expect(clean).toMatch(/^[0-9a-f]{64}$/);
      expect(await boundary.worktreeFingerprint()).toBe(clean);

      writeFileSync(join(worktree, 'fixture.txt'), 'changed once\n', 'utf8');
      const changed = await boundary.worktreeFingerprint();
      expect(changed).not.toBe(clean);
      expect(await boundary.worktreeFingerprint()).toBe(changed);
    });

    it('returns to the same value when an edit is exactly reversed', async () => {
      const boundary = tools();
      writeFileSync(join(worktree, 'fixture.txt'), 'first edit\n', 'utf8');
      const first = await boundary.worktreeFingerprint();

      writeFileSync(join(worktree, 'fixture.txt'), 'second edit\n', 'utf8');
      expect(await boundary.worktreeFingerprint()).not.toBe(first);
      writeFileSync(join(worktree, 'fixture.txt'), 'first edit\n', 'utf8');
      expect(await boundary.worktreeFingerprint()).toBe(first);
    });

    it('sees an untracked file, and a change to its content', async () => {
      const boundary = tools();
      const clean = await boundary.worktreeFingerprint();

      writeFileSync(join(worktree, 'notes.md'), 'one\n', 'utf8');
      const withNew = await boundary.worktreeFingerprint();
      expect(withNew).not.toBe(clean);

      writeFileSync(join(worktree, 'notes.md'), 'two\n', 'utf8');
      expect(await boundary.worktreeFingerprint()).not.toBe(withNew);
    });

    it('is unknown (null) when Git fails, so a caller treats the state as new rather than refusing on a guess', async () => {
      const failing = new OrnithWorktreeTools({
        worktreePath: worktree,
        worktreesRoot,
        repositoryPath: repository,
        branchName: 'task',
        gitExecutablePath: gitPath,
        runner: {
          run: async (file, args, options) =>
            args[0] === 'diff'
              ? { command: file, exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false, cancelled: false, durationMs: 1, failed: true }
              : runner.run(file, args, options)
        }
      });
      expect(await failing.worktreeFingerprint()).toBeNull();
    });

    it('is unknown (null) rather than unbounded when there are too many untracked files to hash', async () => {
      for (let index = 0; index < 201; index += 1) {
        writeFileSync(join(worktree, `untracked-${String(index).padStart(3, '0')}.txt`), `${index}\n`, 'utf8');
      }
      expect(await tools().worktreeFingerprint()).toBeNull();
    });

    it('is unknown (null) once the untracked files add up to more than the hashing budget, so the preflight cost is bounded by bytes too', async () => {
      const chunk = 'x'.repeat(1_000_000); // under the per-file limit; 16 of these are just under 16 MiB
      for (let index = 0; index < 16; index += 1) writeFileSync(join(worktree, `blob-${String(index).padStart(2, '0')}.txt`), chunk, 'utf8');
      expect(await tools().worktreeFingerprint()).toMatch(/^[0-9a-f]{64}$/); // within budget: taken

      writeFileSync(join(worktree, 'blob-16.txt'), chunk, 'utf8');
      writeFileSync(join(worktree, 'blob-17.txt'), chunk, 'utf8');
      expect(await tools().worktreeFingerprint()).toBeNull(); // over budget: unknown, verification is simply allowed
    });

    it('runs no configured diff helper and only read-only Git subcommands', async () => {
      const recorded: string[][] = [];
      await toolsRecordingGitArgv(recorded).worktreeFingerprint();

      const diffCalls = recorded.filter((argv) => argv[0] === 'diff');
      expect(diffCalls).toHaveLength(1);
      expect(diffCalls[0]).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
      for (const argv of recorded) {
        expect(ALLOWED_GIT_SUBCOMMANDS.has(argv[0]!)).toBe(true);
        for (const verb of MUTATING_GIT_VERBS) expect(argv).not.toContain(verb);
      }
    });

    it('does not depend on the worktree path or contain anything but a digest', async () => {
      const value = await tools().worktreeFingerprint();
      expect(value).not.toBeNull();
      expect(containsAbsoluteMachinePath(value ?? '')).toBe(false);
      expect(await runGit(['status', '--porcelain=v1'])).toBe(''); // and it changed nothing
    });
  });
});
