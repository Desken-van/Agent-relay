#!/usr/bin/env node
/**
 * DIAGNOSTIC, not a guarantee test: reproduces the documented limit of the Linux
 * filesystem-mutation guard (see `native/linux-fs-guard.cpp` and docs/security.md).
 *
 * The guard checks that the registered worktree path still names the bound root
 * just before and just after each commit. A separate process that moves the root
 * OUT after the first check and BACK before the second is not detected:
 *
 *   1. the helper passes its pre-commit check;
 *   2. this script moves the root to outside/moved-root (helper paused before linkat);
 *   3. the helper creates the file — inside the moved root, outside the registered path;
 *   4. this script records that, then moves the root back (helper paused after linkat);
 *   5. the helper's post-commit check passes and it reports OK.
 *
 * Expected (documented, limited) outcome: OK, the file existed outside the registered
 * path during step 3-4, and afterwards it is inside the registered path and nothing
 * remains outside. Exit 0 when that is what happened; exit 1 when the behaviour differs
 * (for example because a stronger defence now refuses the race — then update the docs).
 *
 * Disposable directories only. Requires Linux, the built helper and a C compiler.
 *   node scripts/diagnostics/linux-fs-guard-root-race.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'linux') {
  console.error('This diagnostic exercises the Linux helper only.');
  process.exit(2);
}
const helper = resolve(import.meta.dirname, '..', '..', 'build', 'Release', 'agent-relay-fs-guard');
if (!existsSync(helper)) {
  console.error('build/Release/agent-relay-fs-guard is missing: run "npm run build:native".');
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'agent-relay-root-race-diagnostic-'));
try {
  // Pauses the helper before AND after linkat: one byte out on fd 3, then one byte in on fd 4.
  writeFileSync(join(base, 'pause-around-link.c'), [
    '#define _GNU_SOURCE',
    '#include <dlfcn.h>',
    '#include <unistd.h>',
    'static void pause_once(char tag) { char b = tag; if (write(3, &b, 1) != 1 || read(4, &b, 1) != 1) _exit(99); }',
    'int linkat(int od, const char* o, int nd, const char* n, int f) {',
    '  static int (*real)(int, const char*, int, const char*, int); static int done;',
    '  if (!real) real = dlsym(RTLD_NEXT, "linkat");',
    '  if (done) return real(od, o, nd, n, f);',
    '  done = 1; pause_once(\'b\'); int result = real(od, o, nd, n, f); pause_once(\'a\'); return result;',
    '}'
  ].join('\n'));
  execFileSync('cc', ['-shared', '-fPIC', '-O2', '-o', join(base, 'pause-around-link.so'), join(base, 'pause-around-link.c'), '-ldl']);

  const root = join(base, 'worktree');
  const outside = join(base, 'outside');
  const moved = join(outside, 'moved-root');
  mkdirSync(root);
  mkdirSync(outside);
  const [, volumeId, fileId] = execFileSync(helper, ['identity', root], { encoding: 'utf8' }).trim().split(':');

  const observed = { pausedBefore: false, pausedAfter: false, fileOutsideWhileMoved: false };
  const child = spawn(helper, ['create', root, volumeId, fileId, 'new.txt'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, LD_PRELOAD: join(base, 'pause-around-link.so') }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdio[3].on('data', (chunk) => {
    for (const tag of chunk.toString('latin1')) {
      if (tag === 'b') {
        observed.pausedBefore = true;
        renameSync(root, moved);
      } else if (tag === 'a') {
        observed.pausedAfter = true;
        observed.fileOutsideWhileMoved = existsSync(join(moved, 'new.txt'));
        renameSync(moved, root);
      }
      child.stdio[4].write('g');
    }
  });
  child.stdin.end('diagnostic content\n');
  const exitCode = await new Promise((done) => child.on('close', done));

  const result = {
    ...observed,
    exitCode,
    stdout: stdout.trim(),
    fileAtRegisteredPath: existsSync(join(root, 'new.txt')) ? readFileSync(join(root, 'new.txt'), 'utf8') : null,
    outsideAfterwards: readdirSync(outside)
  };
  const matchesDocumentedLimit =
    result.pausedBefore && result.pausedAfter && result.fileOutsideWhileMoved &&
    result.exitCode === 0 && result.stdout === 'OK' &&
    result.fileAtRegisteredPath === 'diagnostic content\n' && result.outsideAfterwards.length === 0;

  console.log(JSON.stringify({ ...result, stderr: stderr.trim(), matchesDocumentedLimit }, null, 2));
  console.log(matchesDocumentedLimit
    ? 'Documented limitation reproduced: the root was moved out and back between the guard\'s checks, the file was ' +
      'created outside the registered path for that interval, and the helper reported OK with the file back inside.'
    : 'Behaviour differs from the documented limitation; review native/linux-fs-guard.cpp and docs/security.md.');
  process.exitCode = matchesDocumentedLimit ? 0 : 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
