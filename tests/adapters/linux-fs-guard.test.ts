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

  describe('races and missing primitives injected at the commit (LD_PRELOAD shims, a separate attacking process)', () => {
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
      // Never acts itself: the helper confines itself, so an attack must come from ANOTHER process. This only
      // pauses the helper once, just before the system call named by PAUSE_ON (one byte out on fd 3, then waits
      // for one byte on fd 4), and simulates missing primitives: UNSUPPORTED_RENAME (no renameat2 flags),
      // NO_TMPFILE (no O_TMPFILE) and NO_LANDLOCK (a kernel without Landlock).
      writeFileSync(join(shims, 'pause.c'), [
        '#define _GNU_SOURCE',
        '#include <dlfcn.h>', '#include <errno.h>', '#include <fcntl.h>', '#include <stdarg.h>', '#include <stdlib.h>',
        '#include <string.h>', '#include <sys/syscall.h>', '#include <unistd.h>',
        'static void pauseBefore(const char* call) {',
        '  static int done; const char* on = getenv("PAUSE_ON");',
        '  if (done || !on || strcmp(on, call) != 0) return;',
        '  done = 1; char b = 1; if (write(3, &b, 1) != 1 || read(4, &b, 1) != 1) _exit(99);',
        '}',
        'int linkat(int od, const char* o, int nd, const char* n, int f) {',
        '  static int (*real)(int, const char*, int, const char*, int); if (!real) real = dlsym(RTLD_NEXT, "linkat");',
        '  pauseBefore("linkat"); return real(od, o, nd, n, f);',
        '}',
        'int renameat2(int od, const char* o, int nd, const char* n, unsigned flags) {',
        '  static int (*real)(int, const char*, int, const char*, unsigned); if (!real) real = dlsym(RTLD_NEXT, "renameat2");',
        '  pauseBefore("renameat2");',
        '  if (flags != 0 && getenv("UNSUPPORTED_RENAME")) { errno = EOPNOTSUPP; return -1; }',
        '  return real(od, o, nd, n, flags);',
        '}',
        'int mkdirat(int d, const char* n, mode_t m) {',
        '  static int (*real)(int, const char*, mode_t); if (!real) real = dlsym(RTLD_NEXT, "mkdirat");',
        '  pauseBefore("mkdirat"); return real(d, n, m);',
        '}',
        'int openat(int d, const char* n, int flags, ...) {',
        '  static int (*real)(int, const char*, int, ...); if (!real) real = dlsym(RTLD_NEXT, "openat");',
        '  va_list ap; va_start(ap, flags); mode_t m = va_arg(ap, mode_t); va_end(ap);',
        '  if ((flags & O_TMPFILE) == O_TMPFILE && getenv("NO_TMPFILE")) { errno = EOPNOTSUPP; return -1; }',
        '  return real(d, n, flags, m);',
        '}',
        'long syscall(long number, ...) {',
        '  static long (*real)(long, ...); if (!real) real = dlsym(RTLD_NEXT, "syscall");',
        '  va_list ap; va_start(ap, number); long a[6]; for (int i = 0; i < 6; ++i) a[i] = va_arg(ap, long); va_end(ap);',
        '  if (number == SYS_landlock_create_ruleset && getenv("NO_LANDLOCK")) { errno = ENOSYS; return -1; }',
        '  return real(number, a[0], a[1], a[2], a[3], a[4], a[5]);',
        '}'
      ].join('\n'));
      for (const name of ['slow', 'pause']) {
        execFileSync('cc', ['-shared', '-fPIC', '-O2', '-o', join(shims, `${name}.so`), join(shims, `${name}.c`), '-ldl']);
      }
    });

    afterAll(() => rmSync(shims, { recursive: true, force: true }));

    /**
     * Run the helper under the pause shim. When it pauses before `call`, `attack` runs in THIS process
     * (outside the helper's confinement), then the helper resumes. `paused` proves the race really happened.
     */
    async function raced(
      args: readonly string[],
      input: string | undefined,
      env: Record<string, string>,
      call: string | null,
      attack: () => void
    ): Promise<{ exitCode: number | null; line: string; paused: boolean }> {
      const child = spawn(HELPER, args, {
        stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, LD_PRELOAD: join(shims, 'pause.so'), ...(call === null ? {} : { PAUSE_ON: call }), ...env }
      });
      let stdout = '';
      let paused = false;
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      const signal = child.stdio[3] as NodeJS.ReadableStream;
      const resume = child.stdio[4] as NodeJS.WritableStream;
      signal.on('data', () => {
        paused = true;
        attack();
        resume.write('g');
      });
      const exited = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
      child.stdin!.end(input ?? '');
      const exitCode = await exited;
      return { exitCode, line: stdout.trim(), paused };
    }

    function stagingNames(directory: string): string[] {
      return readdirSync(directory).filter((name) => name.startsWith('.ornith-tmp-'));
    }

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

    it('replace refuses, and keeps the original in place, when another process renames its file over the staging name before the exchange', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      writeFileSync(join(base, 'intruder.txt'), 'INTRUDER\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      const result = await raced(
        ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('original\n')],
        'replacement\n', {}, 'renameat2',
        () => renameSync(join(base, 'intruder.txt'), join(root, stagingNames(root)[0]!))
      );
      expect(result).toEqual({ exitCode: 1, line: 'ERR:HASH_MISMATCH', paused: true });
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
      // The intruder's own file is neither lost nor deleted by the helper: it was never the helper's to remove.
      const leftover = stagingNames(root);
      expect(leftover).toHaveLength(1);
      expect(readFileSync(join(root, leftover[0]!), 'utf8')).toBe('INTRUDER\n');
    });

    it('without RENAME_EXCHANGE, replace refuses before changing anything, even when the staging name is swapped', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'original\n');
      writeFileSync(join(base, 'intruder.txt'), 'INTRUDER\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      const args = ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('original\n')];

      // Untouched by anyone else: refused, unchanged, nothing left behind.
      expect(await raced(args, 'replacement\n', { UNSUPPORTED_RENAME: '1' }, null, () => undefined))
        .toEqual({ exitCode: 1, line: 'ERR:UNSUPPORTED', paused: false });
      expect(readdirSync(root)).toEqual(['file.txt']);
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');

      // The audited case: another process renames its file over the staging name, and only then does the
      // exchange turn out to be unsupported. The original stays in place with its content; nothing is lost.
      const result = await raced(args, 'replacement\n', { UNSUPPORTED_RENAME: '1' }, 'renameat2',
        () => renameSync(join(base, 'intruder.txt'), join(root, stagingNames(root)[0]!)));
      expect(result).toEqual({ exitCode: 1, line: 'ERR:UNSUPPORTED', paused: true });
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
      expect(fileIdentity(join(root, 'file.txt'))).toEqual({ dev, ino });
      expect(stagingNames(root).map((name) => readFileSync(join(root, name), 'utf8'))).toEqual(['INTRUDER\n']);
    });

    it('without RENAME_NOREPLACE, delete refuses before changing anything', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'keep\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      expect(await raced(['delete', root, identity.volumeId, identity.fileId, dev, ino, 'file.txt', sha('keep\n')],
        undefined, { UNSUPPORTED_RENAME: '1' }, null, () => undefined))
        .toEqual({ exitCode: 1, line: 'ERR:UNSUPPORTED', paused: false });
      expect(readdirSync(root)).toEqual(['file.txt']);
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('keep\n');
    });

    it('without Landlock, no mutation runs at all', async () => {
      const identity = await identify(guard);
      writeFileSync(join(root, 'file.txt'), 'keep\n');
      const { dev, ino } = fileIdentity(join(root, 'file.txt'));
      const ids = [root, identity.volumeId, identity.fileId];
      for (const [args, input] of [
        [['create', ...ids, 'new.txt'], 'x'],
        [['mkdirp', ...ids, 'a/b'], undefined],
        [['replace', ...ids, dev, ino, 'file.txt', sha('keep\n')], 'changed'],
        [['delete', ...ids, dev, ino, 'file.txt', sha('keep\n')], undefined]
      ] as const) {
        expect(await raced(args, input, { NO_LANDLOCK: '1' }, null, () => undefined), args[0])
          .toEqual({ exitCode: 1, line: 'ERR:UNSUPPORTED', paused: false });
      }
      expect(readdirSync(root)).toEqual(['file.txt']);
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('keep\n');
    });

    it('without O_TMPFILE, a named staging file gives the same create, replace and delete, with no leftovers', async () => {
      const identity = await identify(guard);
      const ids = [root, identity.volumeId, identity.fileId];
      const noTmpfile = { NO_TMPFILE: '1' };
      expect(await raced(['create', ...ids, 'new.txt'], 'created\n', noTmpfile, null, () => undefined))
        .toEqual({ exitCode: 0, line: 'OK', paused: false });
      expect(await raced(['create', ...ids, 'new.txt'], 'again\n', noTmpfile, null, () => undefined))
        .toEqual({ exitCode: 1, line: 'ERR:ALREADY_EXISTS', paused: false });
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('created\n');
      chmodSync(join(root, 'new.txt'), 0o700);
      const { dev, ino } = fileIdentity(join(root, 'new.txt'));
      expect(await raced(['replace', ...ids, dev, ino, 'new.txt', sha('created\n')], 'replaced\n', noTmpfile, null, () => undefined))
        .toEqual({ exitCode: 0, line: 'OK', paused: false });
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('replaced\n');
      expect(statSync(join(root, 'new.txt')).mode & 0o777).toBe(0o700);
      const replaced = fileIdentity(join(root, 'new.txt'));
      expect(await raced(['delete', ...ids, replaced.dev, replaced.ino, 'new.txt', sha('replaced\n')], undefined, noTmpfile, null, () => undefined))
        .toEqual({ exitCode: 0, line: 'OK', paused: false });
      expect(readdirSync(root)).toEqual([]);
    });

    describe('the whole worktree root moved away from its registered path at the commit', () => {
      // Landlock binds the helper to the root directory object, which can itself be renamed away. These cases
      // pause the helper at its commit, move the bound root to outside/moved-root and leave the registered path
      // empty, pointing back at it through a symlink, or missing. Every mutation must refuse with ROOT_INVALID
      // and leave the moved root exactly as it was: no change may survive outside the registered path.
      const attacks = {
        'replaced by an empty directory': (moved: string) => { renameSync(root, moved); mkdirSync(root); },
        'replaced by a symlink to its new place': (moved: string) => { renameSync(root, moved); symlinkSync(moved, root, 'dir'); },
        'moved away with nothing left behind': (moved: string) => { renameSync(root, moved); }
      } as const;

      for (const [attackName, attack] of Object.entries(attacks)) {
        for (const [op, call] of [
          ['create', 'linkat'],
          ['mkdirp', 'mkdirat'],
          ['replace', 'renameat2'],
          ['delete', 'renameat2']
        ] as const) {
          it(`${op}: root ${attackName} just before ${call} — refused, rolled back, nothing changed anywhere`, async () => {
            mkdirSync(join(root, 'sub'));
            writeFileSync(join(root, 'sub', 'a.txt'), 'original\n');
            const identity = await identify(guard);
            const { dev, ino } = fileIdentity(join(root, 'sub', 'a.txt'));
            const moved = join(outside, 'moved-root');
            const ids = [root, identity.volumeId, identity.fileId];
            const args = {
              create: ['create', ...ids, 'sub/new.txt'],
              mkdirp: ['mkdirp', ...ids, 'sub/deeper/deepest'],
              replace: ['replace', ...ids, dev, ino, 'sub/a.txt', sha('original\n')],
              delete: ['delete', ...ids, dev, ino, 'sub/a.txt', sha('original\n')]
            }[op];

            const result = await raced(args, 'changed\n', {}, call, () => attack(moved));

            expect(result).toEqual({ exitCode: 1, line: 'ERR:ROOT_INVALID', paused: true });
            // The bound root, wherever it now is, holds exactly what it held before.
            expect(readdirSync(moved)).toEqual(['sub']);
            expect(readdirSync(join(moved, 'sub'))).toEqual(['a.txt']);
            expect(readFileSync(join(moved, 'sub', 'a.txt'), 'utf8')).toBe('original\n');
            expect(fileIdentity(join(moved, 'sub', 'a.txt'))).toEqual({ dev, ino });
            // Nothing appeared at the registered path either.
            if (attackName === 'replaced by an empty directory') expect(readdirSync(root)).toEqual([]);
            if (attackName === 'replaced by a symlink to its new place') expect(lstatSync(root).isSymbolicLink()).toBe(true);
            if (attackName === 'moved away with nothing left behind') expect(existsSync(root)).toBe(false);
            expect(readdirSync(outside).sort()).toEqual(['moved-root', 'secret.txt']);
          });
        }
      }

      it('a root that stays at its registered path is unaffected: all four mutations still succeed', async () => {
        mkdirSync(join(root, 'sub'));
        writeFileSync(join(root, 'sub', 'a.txt'), 'original\n');
        const identity = await identify(guard);
        expect(await guard.mkdirp(root, identity, 'sub/deeper', never, TIMEOUT_MS)).toEqual({ ok: true });
        expect(await guard.createFile(root, identity, 'sub/deeper/new.txt', 'new\n', never, TIMEOUT_MS)).toEqual({ ok: true });
        const target = fileIdentity(join(root, 'sub', 'a.txt'));
        expect(await guard.replaceFile(root, identity, target, 'sub/a.txt', 'changed\n', sha('original\n'), never, TIMEOUT_MS)).toEqual({ ok: true });
        const replaced = fileIdentity(join(root, 'sub', 'a.txt'));
        expect(await guard.deleteFile(root, identity, replaced, 'sub/a.txt', sha('changed\n'), never, TIMEOUT_MS)).toEqual({ ok: true });
        expect(readdirSync(join(root, 'sub'))).toEqual(['deeper']);
        expect(readFileSync(join(root, 'sub', 'deeper', 'new.txt'), 'utf8')).toBe('new\n');
        expectNoStagingLeftovers(root);
      });
    });

    describe('a parent directory moved out of the worktree after the helper opened it', () => {
      /** `root/sub/a.txt`; the attack moves `root/sub` to `outside/sub` while the helper is paused. */
      function prepare(): void {
        mkdirSync(join(root, 'sub'));
        writeFileSync(join(root, 'sub', 'a.txt'), 'original\n');
      }
      const moveOut = (): void => renameSync(join(root, 'sub'), join(outside, 'sub'));

      for (const [op, call] of [
        ['create', 'linkat'],
        ['mkdirp', 'mkdirat'],
        ['replace', 'linkat'],
        ['delete', 'renameat2']
      ] as const) {
        it(`${op} is refused by the kernel and changes nothing outside the worktree (moved before ${call})`, async () => {
          prepare();
          const identity = await identify(guard);
          const { dev, ino } = fileIdentity(join(root, 'sub', 'a.txt'));
          const ids = [root, identity.volumeId, identity.fileId];
          const args = {
            create: ['create', ...ids, 'sub/new.txt'],
            mkdirp: ['mkdirp', ...ids, 'sub/deeper'],
            replace: ['replace', ...ids, dev, ino, 'sub/a.txt', sha('original\n')],
            delete: ['delete', ...ids, dev, ino, 'sub/a.txt', sha('original\n')]
          }[op];
          const result = await raced(args, 'changed\n', {}, call, moveOut);
          expect(result).toEqual({ exitCode: 1, line: 'ERR:REPARSE_ANCESTOR', paused: true });
          // Outside the worktree there is exactly what the attacker moved there, byte for byte.
          expect(readdirSync(outside).sort()).toEqual(['secret.txt', 'sub']);
          expect(readdirSync(join(outside, 'sub'))).toEqual(['a.txt']);
          expect(readFileSync(join(outside, 'sub', 'a.txt'), 'utf8')).toBe('original\n');
          expect(fileIdentity(join(outside, 'sub', 'a.txt'))).toEqual({ dev, ino });
          expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
          expect(readdirSync(root)).toEqual([]);
        });
      }

      it('replace moved out between naming its staged copy and the exchange: refused, original untouched, only the staged copy remains', async () => {
        // The documented residual: the staging name was created while the directory was still inside, and
        // the confined helper can no longer remove it once the directory is outside. It holds only the new
        // content; the original keeps its inode, name and bytes.
        prepare();
        const identity = await identify(guard);
        const { dev, ino } = fileIdentity(join(root, 'sub', 'a.txt'));
        const result = await raced(
          ['replace', root, identity.volumeId, identity.fileId, dev, ino, 'sub/a.txt', sha('original\n')],
          'changed\n', {}, 'renameat2', moveOut
        );
        expect(result).toEqual({ exitCode: 1, line: 'ERR:REPARSE_ANCESTOR', paused: true });
        expect(readFileSync(join(outside, 'sub', 'a.txt'), 'utf8')).toBe('original\n');
        expect(fileIdentity(join(outside, 'sub', 'a.txt'))).toEqual({ dev, ino });
        const staged = stagingNames(join(outside, 'sub'));
        expect(staged).toHaveLength(1);
        expect(readFileSync(join(outside, 'sub', staged[0]!), 'utf8')).toBe('changed\n');
        expect(readdirSync(join(outside, 'sub')).sort()).toEqual([staged[0]!, 'a.txt'].sort());
      });
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

  it('reports a helper that lacks a required primitive as unavailable, with a reason', async () => {
    const recording = {
      run: async () => ({ command: 'x', exitCode: 1, stdout: 'ERR:UNSUPPORTED\n', stderr: '', timedOut: false, cancelled: false, durationMs: 1, failed: true })
    };
    const guard = new ExecaFsGuard(recording, { platform: 'linux', locate: () => '/fake/agent-relay-fs-guard' });
    const identity: FsRootIdentity = { volumeId: '0'.repeat(16), fileId: '0'.repeat(32), statDev: '0', statIno: '0' };
    const result = await guard.createFile('/tmp/x', identity, 'a.txt', 'x', never, TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(!result.ok && result.reason).toMatch(/lacks a primitive the mutation guard requires \(Landlock/);
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
