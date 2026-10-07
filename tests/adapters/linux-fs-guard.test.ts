/**
 * The Linux filesystem-mutation guard, exercised for real: every case runs the
 * built `build/Release/agent-relay-fs-guard` against a disposable directory and
 * checks the filesystem afterwards, not only the reported code. A Linux run
 * without the built helper fails here instead of skipping, so a green suite
 * cannot hide a missing guard.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecaFsGuard,
  fsGuardExecutableName,
  type FsFileIdentity,
  type FsRootIdentity
} from '../../src/main/adapters/process/fs-guard';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';

const runner = new ExecaProcessRunner();
const HELPER = resolve(import.meta.dirname, '..', '..', 'build', 'Release', 'agent-relay-fs-guard');
const TIMEOUT_MS = 10_000;
const never = new AbortController().signal;

let base: string;
let root: string;
let outside: string;

function sha(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function fileIdentity(path: string): FsFileIdentity {
  const stats = lstatSync(path, { bigint: true });
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

/** No staging or quarantine name is ever left behind, wherever the operation stopped. */
function expectNoStagingLeftovers(directory: string): void {
  const leftovers: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.ornith-tmp-')) leftovers.push(join(current, entry.name));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(join(current, entry.name));
    }
  };
  walk(directory);
  expect(leftovers).toEqual([]);
}

/** The helper invoked directly, for argv shapes and environments the typed adapter never produces. */
async function raw(
  args: readonly string[],
  input?: string,
  env?: Record<string, string>
): Promise<{ exitCode: number | null; line: string }> {
  const result = await runner.run(HELPER, args, { input, env, timeoutMs: TIMEOUT_MS, maxOutputBytes: 4096 });
  return { exitCode: result.exitCode, line: result.stdout.trim() };
}

async function identify(guard: ExecaFsGuard, path = root): Promise<FsRootIdentity> {
  const result = await guard.identifyRoot(path, never, TIMEOUT_MS);
  if (!result.ok) throw new Error(`identity failed: ${result.code}`);
  return result.identity;
}

describe.runIf(process.platform === 'linux')('Linux native filesystem-mutation guard', () => {
  const guard = new ExecaFsGuard(runner);

  beforeAll(() => {
    expect(fsGuardExecutableName('linux')).toBe('agent-relay-fs-guard');
    expect(existsSync(HELPER), 'build/Release/agent-relay-fs-guard is missing: run "npm run build:native"').toBe(true);
  });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agent-relay-linux-fs-guard-'));
    root = join(base, 'worktree');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('root identity', () => {
    it('reports the device and inode Node itself sees, plus a 128-bit identity', async () => {
      const identity = await identify(guard);
      const stats = lstatSync(root, { bigint: true });
      expect(identity.statDev).toBe(stats.dev.toString());
      expect(identity.statIno).toBe(stats.ino.toString());
      expect(identity.volumeId).toBe(stats.dev.toString(16).padStart(16, '0'));
      expect(identity.fileId.slice(0, 16)).toBe(stats.ino.toString(16).padStart(16, '0'));
    });

    it('refuses a symlinked root, a file root and a relative root', async () => {
      const link = join(base, 'link');
      symlinkSync(root, link, 'dir');
      expect(await guard.identifyRoot(link, never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'root_invalid' });
      writeFileSync(join(base, 'file'), 'x');
      expect(await guard.identifyRoot(join(base, 'file'), never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'root_invalid' });
      expect(await guard.identifyRoot('worktree', never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'invalid_arguments' });
    });

    it('refuses every mutation once the root path names a different directory, even a recreated one', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      const target = fileIdentity(join(root, 'file.txt'));
      renameSync(root, join(base, 'displaced'));
      mkdirSync(root);
      writeFileSync(join(root, 'file.txt'), 'original\n');

      expect(await guard.mkdirp(root, identity, 'a/b', never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'root_invalid' });
      expect(await guard.createFile(root, identity, 'new.txt', 'x', never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'root_invalid' });
      expect(await guard.replaceFile(root, identity, target, 'file.txt', 'changed', sha('original\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'root_invalid' });
      expect(await guard.deleteFile(root, identity, target, 'file.txt', sha('original\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'root_invalid' });

      expect(readdirSync(root)).toEqual(['file.txt']);
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
      expect(readFileSync(join(base, 'displaced', 'file.txt'), 'utf8')).toBe('original\n');
    });

    it('refuses a root identity whose inode matches but whose birth time does not', async () => {
      const identity = await identify(guard);
      const forged = { ...identity, fileId: `${identity.fileId.slice(0, 16)}${'0'.repeat(16)}` };
      // Only meaningful where the filesystem records a birth time at all.
      if (identity.fileId.slice(16) === '0'.repeat(16)) return;
      expect(await guard.createFile(root, forged, 'new.txt', 'x', never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'root_invalid' });
      expect(existsSync(join(root, 'new.txt'))).toBe(false);
    });
  });

  describe('mkdirp', () => {
    it('creates every missing component, is idempotent, and honours the umask', async () => {
      const identity = await identify(guard);
      expect(await guard.mkdirp(root, identity, 'a/b/c', never, TIMEOUT_MS)).toEqual({ ok: true });
      expect(await guard.mkdirp(root, identity, 'a/b/c', never, TIMEOUT_MS)).toEqual({ ok: true });
      expect(statSync(join(root, 'a/b/c')).isDirectory()).toBe(true);
      const umask = process.umask();
      expect(statSync(join(root, 'a')).mode & 0o777).toBe(0o777 & ~umask);
    });

    it('refuses a symlinked ancestor without creating anything outside', async () => {
      const identity = await identify(guard);
      symlinkSync(outside, join(root, 'link'), 'dir');
      expect(await guard.mkdirp(root, identity, 'link/deeper', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(existsSync(join(outside, 'deeper'))).toBe(false);
    });

    it('refuses a file where a directory component should be', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file'), 'x');
      expect(await guard.mkdirp(root, identity, 'file/deeper', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'not_directory' });
    });
  });

  describe('create', () => {
    it('writes the exact bytes with the umask-filtered default mode', async () => {
      const identity = await identify(guard);
      const content = 'line one\r\nπ — two\n';
      mkdirSync(join(root, 'dir'));
      expect(await guard.createFile(root, identity, 'dir/new.txt', content, never, TIMEOUT_MS)).toEqual({ ok: true });
      expect(readFileSync(join(root, 'dir/new.txt'))).toEqual(Buffer.from(content, 'utf8'));
      expect(statSync(join(root, 'dir/new.txt')).mode & 0o777).toBe(0o666 & ~process.umask());
      expectNoStagingLeftovers(root);
    });

    it('never replaces an existing file or an existing symlink, and never writes through one', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'existing.txt'), 'keep\n');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      symlinkSync(join(outside, 'absent.txt'), join(root, 'dangling.txt'));

      for (const path of ['existing.txt', 'link.txt', 'dangling.txt']) {
        expect(await guard.createFile(root, identity, path, 'overwrite', never, TIMEOUT_MS))
          .toMatchObject({ ok: false, code: 'already_exists' });
      }
      expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('keep\n');
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
      expect(existsSync(join(outside, 'absent.txt'))).toBe(false);
      expectNoStagingLeftovers(root);
    });

    it('refuses a symlinked ancestor, a missing parent and a file parent', async () => {
      const identity = await identify(guard);
      symlinkSync(outside, join(root, 'link'), 'dir');
      mkdirSync(join(root, 'real'));
      symlinkSync(outside, join(root, 'real', 'nested-link'), 'dir');
      writeFileSync(join(root, 'file'), 'x');

      expect(await guard.createFile(root, identity, 'link/new.txt', 'x', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(await guard.createFile(root, identity, 'real/nested-link/new.txt', 'x', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(await guard.createFile(root, identity, 'missing/new.txt', 'x', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'not_found' });
      expect(await guard.createFile(root, identity, 'file/new.txt', 'x', never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'not_directory' });
      expect(readdirSync(outside)).toEqual(['secret.txt']);
      expect(existsSync(join(root, 'missing'))).toBe(false);
      expectNoStagingLeftovers(root);
    });

    it('refuses content above the 8 MiB ceiling without creating anything', async () => {
      const identity = await identify(guard);
      const result = await guard.createFile(root, identity, 'big.txt', 'x'.repeat(8 * 1024 * 1024 + 1), never, TIMEOUT_MS);
      expect(result).toMatchObject({ ok: false, code: 'invalid_arguments' });
      expect(readdirSync(root)).toEqual([]);
    });
  });

  describe('replace', () => {
    it('replaces the content atomically and keeps the permission bits', async () => {
      const identity = await identify(guard);
      const path = join(root, 'script.sh');
      writeFileSync(path, '#!/bin/sh\necho old\n');
      chmodSync(path, 0o750);
      const target = fileIdentity(path);

      const result = await guard.replaceFile(
        root, identity, target, 'script.sh', '#!/bin/sh\necho new\n', sha('#!/bin/sh\necho old\n'), never, TIMEOUT_MS
      );
      expect(result).toEqual({ ok: true });
      expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho new\n');
      expect(statSync(path).mode & 0o777).toBe(0o750);
      expect(lstatSync(path).nlink).toBe(1);
      expectNoStagingLeftovers(root);
    });

    it('refuses stale content, and a same-content file that is not the inode the caller hashed', async () => {
      const identity = await identify(guard);
      const path = join(root, 'file.txt');
      writeFileSync(path, 'original\n');
      const target = fileIdentity(path);

      expect(await guard.replaceFile(root, identity, target, 'file.txt', 'changed', sha('something else'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'hash_mismatch' });

      renameSync(path, join(root, 'preserved.txt'));
      writeFileSync(path, 'original\n');
      expect(await guard.replaceFile(root, identity, target, 'file.txt', 'changed', sha('original\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'hash_mismatch' });
      expect(readFileSync(path, 'utf8')).toBe('original\n');
      expect(readFileSync(join(root, 'preserved.txt'), 'utf8')).toBe('original\n');
      expectNoStagingLeftovers(root);
    });

    it('refuses a symlink, a hard-linked file, a directory, a FIFO and a missing file', async () => {
      const identity = await identify(guard);
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      writeFileSync(join(root, 'linked.txt'), 'shared\n');
      linkSync(join(root, 'linked.txt'), join(outside, 'second-name.txt'));
      mkdirSync(join(root, 'dir'));
      execFileSync('mkfifo', [join(root, 'fifo')]);
      const anyIdentity = fileIdentity(join(root, 'linked.txt'));

      const attempt = (path: string, hash: string): ReturnType<typeof guard.replaceFile> =>
        guard.replaceFile(root, identity, anyIdentity, path, 'changed', hash, never, TIMEOUT_MS);
      expect(await attempt('link.txt', sha('outside\n'))).toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(await attempt('linked.txt', sha('shared\n'))).toMatchObject({ ok: false, code: 'hard_linked' });
      expect(await attempt('dir', sha(''))).toMatchObject({ ok: false, code: 'not_a_file' });
      expect(await attempt('fifo', sha(''))).toMatchObject({ ok: false, code: 'not_a_file' });
      expect(await attempt('missing.txt', sha(''))).toMatchObject({ ok: false, code: 'not_found' });

      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
      expect(readFileSync(join(outside, 'second-name.txt'), 'utf8')).toBe('shared\n');
      expect(lstatSync(join(root, 'link.txt')).isSymbolicLink()).toBe(true);
      expectNoStagingLeftovers(root);
    });

    it('refuses a symlinked ancestor without touching the file it points at', async () => {
      const identity = await identify(guard);
      symlinkSync(outside, join(root, 'link'), 'dir');
      const target = fileIdentity(join(outside, 'secret.txt'));
      expect(await guard.replaceFile(root, identity, target, 'link/secret.txt', 'changed', sha('outside\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
    });
  });

  describe('delete', () => {
    it('deletes exactly the verified file', async () => {
      const identity = await identify(guard);
      mkdirSync(join(root, 'dir'));
      writeFileSync(join(root, 'dir/file.txt'), 'bye\n');
      const target = fileIdentity(join(root, 'dir/file.txt'));
      expect(await guard.deleteFile(root, identity, target, 'dir/file.txt', sha('bye\n'), never, TIMEOUT_MS)).toEqual({ ok: true });
      expect(readdirSync(join(root, 'dir'))).toEqual([]);
    });

    it('refuses stale content, a substituted inode, a symlink and a hard link, deleting nothing', async () => {
      const identity = await identify(guard);
      const path = join(root, 'file.txt');
      writeFileSync(path, 'keep\n');
      const target = fileIdentity(path);
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      writeFileSync(join(root, 'linked.txt'), 'shared\n');
      linkSync(join(root, 'linked.txt'), join(root, 'linked-too.txt'));

      expect(await guard.deleteFile(root, identity, target, 'file.txt', sha('other'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'hash_mismatch' });
      renameSync(path, join(root, 'preserved.txt'));
      writeFileSync(path, 'keep\n');
      expect(await guard.deleteFile(root, identity, target, 'file.txt', sha('keep\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'hash_mismatch' });
      expect(await guard.deleteFile(root, identity, target, 'link.txt', sha('outside\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'reparse_ancestor' });
      expect(await guard.deleteFile(root, identity, fileIdentity(join(root, 'linked.txt')), 'linked.txt', sha('shared\n'), never, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'hard_linked' });

      expect(readdirSync(root).sort()).toEqual(['file.txt', 'link.txt', 'linked-too.txt', 'linked.txt', 'preserved.txt']);
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
    });
  });

  describe('argument validation is the helper’s own, never the caller’s alone', () => {
    it('refuses traversal, absolute, empty-segment, .git, backslash and control-character paths', async () => {
      const identity = await identify(guard);
      for (const path of ['../escape.txt', 'a/../b.txt', '/etc/passwd', 'a//b.txt', './a.txt', '.git/config', 'sub/.git/x', 'a\\b.txt', 'bad\u0001.txt', '']) {
        expect(await guard.createFile(root, identity, path, 'x', never, TIMEOUT_MS), path)
          .toMatchObject({ ok: false, code: 'invalid_arguments' });
      }
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(base).sort()).toEqual(['outside', 'worktree']);
    });

    it('refuses malformed identities, hashes, argument counts and operations', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'x');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      const cases: string[][] = [
        ['create', root, 'nothex'.padEnd(16, 'z'), identity.fileId, 'a.txt'],
        ['create', root, identity.volumeId, identity.fileId.slice(1), 'a.txt'],
        ['replace', root, identity.volumeId, identity.fileId, '-1', ino, 'file.txt', sha('x')],
        ['replace', root, identity.volumeId, identity.fileId, dev, '99999999999999999999999', 'file.txt', sha('x')],
        ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', 'f'.repeat(63)],
        ['delete', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt'],
        ['identity', root, 'extra'],
        ['chmod', root, identity.volumeId, identity.fileId, 'file.txt'],
        ['create']
      ];
      for (const args of cases) {
        expect(await raw(args, ''), args.join(' ')).toEqual({ exitCode: 1, line: 'ERR:INVALID_ARGUMENTS' });
      }
      expect(readdirSync(root)).toEqual(['file.txt']);
    });
  });

  describe('the portable path (no O_TMPFILE, RENAME_EXCHANGE or RENAME_NOREPLACE)', () => {
    const portable = { AGENT_RELAY_FS_GUARD_PORTABLE_ONLY: '1' };

    it('creates, replaces and deletes with the same refusals and no leftovers', async () => {
      const identity = await identify(guard);
      const ids = [identity.volumeId, identity.fileId];

      expect(await raw(['create', root, ...ids, 'new.txt'], 'created\n', portable)).toEqual({ exitCode: 0, line: 'OK' });
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('created\n');
      expect(await raw(['create', root, ...ids, 'new.txt'], 'again\n', portable)).toEqual({ exitCode: 1, line: 'ERR:ALREADY_EXISTS' });
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('created\n');

      chmodSync(join(root, 'new.txt'), 0o700);
      const { dev, ino } = fileIdentity(join(root, 'new.txt'));
      expect(await raw(['replace', root, ...ids, dev, ino, 'new.txt', sha('stale')], 'x', portable))
        .toEqual({ exitCode: 1, line: 'ERR:HASH_MISMATCH' });
      expect(await raw(['replace', root, ...ids, dev, ino, 'new.txt', sha('created\n')], 'replaced\n', portable))
        .toEqual({ exitCode: 0, line: 'OK' });
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('replaced\n');
      expect(statSync(join(root, 'new.txt')).mode & 0o777).toBe(0o700);

      const replaced = fileIdentity(join(root, 'new.txt'));
      expect(await raw(['delete', root, ...ids, replaced.dev, replaced.ino, 'new.txt', sha('stale')], undefined, portable))
        .toEqual({ exitCode: 1, line: 'ERR:HASH_MISMATCH' });
      expect(existsSync(join(root, 'new.txt'))).toBe(true);
      expect(await raw(['delete', root, ...ids, replaced.dev, replaced.ino, 'new.txt', sha('replaced\n')], undefined, portable))
        .toEqual({ exitCode: 0, line: 'OK' });
      expect(readdirSync(root)).toEqual([]);

      symlinkSync(outside, join(root, 'link'), 'dir');
      expect(await raw(['create', root, ...ids, 'link/evil.txt'], 'x', portable)).toEqual({ exitCode: 1, line: 'ERR:REPARSE_ANCESTOR' });
      expect(readdirSync(outside)).toEqual(['secret.txt']);
      expectNoStagingLeftovers(root);
    });
  });

  describe('races injected at the commit itself (LD_PRELOAD shims)', () => {
    let shims: string;

    beforeAll(() => {
      shims = mkdtempSync(join(tmpdir(), 'agent-relay-fs-guard-shims-'));
      // Holds every fsync for SLOW_FSYNC_MS, so a signal reliably lands while content is being staged.
      writeFileSync(join(shims, 'slow.c'), [
        '#define _GNU_SOURCE',
        '#include <dlfcn.h>', '#include <stdlib.h>', '#include <time.h>',
        'int fsync(int fd) {',
        '  static int (*real)(int); if (!real) real = dlsym(RTLD_NEXT, "fsync");',
        '  const char* ms = getenv("SLOW_FSYNC_MS");',
        '  if (ms) { struct timespec t = { atoi(ms) / 1000, (atoi(ms) % 1000) * 1000000L }; while (nanosleep(&t, &t) != 0) {} }',
        '  return real(fd);',
        '}'
      ].join('\n'));
      // Another process renaming its own file over the staging name just before the exchange.
      writeFileSync(join(shims, 'swap.c'), [
        '#define _GNU_SOURCE',
        '#include <dlfcn.h>', '#include <fcntl.h>', '#include <stdio.h>', '#include <stdlib.h>',
        'int renameat2(int od, const char* o, int nd, const char* n, unsigned flags) {',
        '  static int (*real)(int, const char*, int, const char*, unsigned); static int done;',
        '  if (!real) real = dlsym(RTLD_NEXT, "renameat2");',
        '  if (!done && (flags & RENAME_EXCHANGE) && getenv("SWAP_IN")) { done = 1; renameat(AT_FDCWD, getenv("SWAP_IN"), od, o); }',
        '  return real(od, o, nd, n, flags);',
        '}'
      ].join('\n'));
      for (const name of ['slow', 'swap']) {
        execFileSync('cc', ['-shared', '-fPIC', '-O2', '-o', join(shims, `${name}.so`), join(shims, `${name}.c`), '-ldl']);
      }
    });

    afterAll(() => rmSync(shims, { recursive: true, force: true }));

    it('a termination that arrives while content is staged abandons the change before the commit', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      for (const args of [
        ['create', root, identity.volumeId, identity.fileId, 'new.txt'],
        ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('original\n')]
      ]) {
        const child = spawn(HELPER, args, {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, LD_PRELOAD: join(shims, 'slow.so'), SLOW_FSYNC_MS: '1500' }
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
        child.stdin.end('replacement content\n');
        await new Promise((done) => setTimeout(done, 500));
        child.kill('SIGTERM');
        expect(await exited).toBe(2);
        expect(stdout.trim()).toBe('ERR:INTERNAL');
        expect(existsSync(join(root, 'new.txt'))).toBe(false);
        expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
      }
      expectNoStagingLeftovers(root);
    });

    it('replace refuses, and restores the original, when a different file is renamed over the staging name before the exchange', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      writeFileSync(join(base, 'intruder.txt'), 'INTRUDER\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      const result = await raw(
        ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('original\n')],
        'replacement\n',
        { LD_PRELOAD: join(shims, 'swap.so'), SWAP_IN: join(base, 'intruder.txt') }
      );
      expect(result).toEqual({ exitCode: 1, line: 'ERR:HASH_MISMATCH' });
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
    });
  });

  describe('cancellation and timeouts never leave a partial file', () => {
    it('a helper killed while content is still arriving changes nothing', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));

      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        for (const args of [
          ['create', root, identity.volumeId, identity.fileId, 'new.txt'],
          ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('original\n')]
        ]) {
          const child = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'ignore'] });
          const exited = new Promise<NodeJS.Signals | null>((done) => child.on('exit', (_code, received) => done(received)));
          child.stdin.write('partial content that never finish');
          await new Promise((done) => setTimeout(done, 100));
          child.kill(signal);
          expect(await exited).toBe(signal);
          expect(existsSync(join(root, 'new.txt'))).toBe(false);
          expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
        }
      }
      expect(readdirSync(root)).toEqual(['file.txt']);
    });

    it('reports a cancelled operation as cancelled and performs nothing', async () => {
      const identity = await identify(guard);
      const controller = new AbortController();
      controller.abort();
      expect(await guard.createFile(root, identity, 'new.txt', 'x', controller.signal, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'cancelled' });
      expect(await guard.mkdirp(root, identity, 'a/b', controller.signal, TIMEOUT_MS))
        .toMatchObject({ ok: false, code: 'cancelled' });
      expect(readdirSync(root)).toEqual([]);
    });

    it('a timed-out replacement leaves either the whole old content or the whole new content', async () => {
      const identity = await identify(guard);
      const path = join(root, 'file.txt');
      const original = 'o'.repeat(256 * 1024);
      const next = 'n'.repeat(512 * 1024);
      writeFileSync(path, original);
      // From "killed before it started" to "finished in time", so the kill lands in every phase in between.
      for (const timeoutMs of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60, 100, 1_000]) {
        const current = readFileSync(path, 'utf8');
        const result = await guard.replaceFile(root, identity, fileIdentity(path), 'file.txt', next, sha(current), never, timeoutMs);
        const after = readFileSync(path, 'utf8');
        expect([original, next]).toContain(after);
        // Reported success exactly when the change landed: never a landed change reported as a timeout.
        expect(result.ok, `timeout ${timeoutMs} ms`).toBe(after === next);
        if (!result.ok) expect(result.code).toBe('timeout');
        if (after === next) writeFileSync(path, original);
      }
      expectNoStagingLeftovers(root);
    });
  });
});

describe('the guard on hosts without one', () => {
  it('fails closed with a reason naming the unsupported platform', async () => {
    const guard = new ExecaFsGuard(runner, { platform: 'darwin' });
    const result = await guard.identifyRoot('/tmp', never, TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(!result.ok && result.reason).toMatch(/no filesystem-mutation guard for this platform \(darwin\)/);
    expect(fsGuardExecutableName('darwin')).toBeNull();
  });

  it('never passes the portable-path test switch on to the helper', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const recording = {
      run: async (_file: string, _args: readonly string[], options?: { omitEnvNames?: readonly string[] }) => {
        seen.push(options?.omitEnvNames);
        return { command: 'x', exitCode: 0, stdout: 'OK\n', stderr: '', timedOut: false, cancelled: false, durationMs: 1, failed: false };
      }
    };
    const guard = new ExecaFsGuard(recording, { platform: 'linux', locate: () => '/fake/agent-relay-fs-guard' });
    const identity: FsRootIdentity = { volumeId: '0'.repeat(16), fileId: '0'.repeat(32), statDev: '0', statIno: '0' };
    expect(await guard.mkdirp('/tmp/x', identity, 'a', never, TIMEOUT_MS)).toEqual({ ok: true });
    expect(seen).toEqual([['AGENT_RELAY_FS_GUARD_PORTABLE_ONLY']]);
  });

  it('reports a helper that exited normally with OK as success even when the timeout fired during its commit', async () => {
    const recording = {
      run: async () => ({ command: 'x', exitCode: 0, stdout: 'OK\n', stderr: '', timedOut: true, cancelled: false, durationMs: 1, failed: true })
    };
    const guard = new ExecaFsGuard(recording, { platform: 'linux', locate: () => '/fake/agent-relay-fs-guard' });
    const identity: FsRootIdentity = { volumeId: '0'.repeat(16), fileId: '0'.repeat(32), statDev: '0', statIno: '0' };
    expect(await guard.createFile('/tmp/x', identity, 'a.txt', 'x', never, TIMEOUT_MS)).toEqual({ ok: true });
    const killed = { run: async () => ({ command: 'x', exitCode: null, stdout: '', stderr: '', timedOut: true, cancelled: false, durationMs: 1, failed: true }) };
    expect(await new ExecaFsGuard(killed, { platform: 'linux', locate: () => '/fake/agent-relay-fs-guard' })
      .createFile('/tmp/x', identity, 'a.txt', 'x', never, TIMEOUT_MS)).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('fails closed with an actionable reason when the helper was not built', async () => {
    const runs: string[] = [];
    const recording = { run: (file: string) => { runs.push(file); throw new Error('must not spawn'); } };
    const guard = new ExecaFsGuard(recording, { platform: 'linux', locate: () => null });
    const identity: FsRootIdentity = { volumeId: '0'.repeat(16), fileId: '0'.repeat(32), statDev: '0', statIno: '0' };
    const result = await guard.createFile('/tmp/x', identity, 'a.txt', 'x', never, TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(!result.ok && result.reason).toMatch(/agent-relay-fs-guard\) is not built; run "npm run build:native"/);
    expect(runs).toEqual([]);
  });
});
