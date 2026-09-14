/**
 * The TypeScript side of the TOCTOU-safe Ornith mutation boundary.
 *
 * `native/windows-fs-guard.cpp` (built by `scripts/build-native.mjs`, same
 * node-gyp/MSBuild pipeline as `agent-relay-windows-job.exe`) performs the
 * actual create/replace/delete/mkdirp against handles opened relative to the
 * canonical worktree root, immune to a pathname-based ancestor swap. This
 * module only locates that executable, invokes it through the existing
 * `ProcessRunner` (the same seam used for `git`), and maps its fixed,
 * closed-vocabulary stdout line back to a typed result.
 *
 * `create`/`replace`/`delete`/`mkdirp` are the only four operation names the
 * helper accepts; nothing here builds a shell command line or passes model or
 * user text as anything but one bounded, pre-validated argv entry.
 *
 * On any platform other than win32, or when the executable was not built,
 * every method fails closed — `{ ok: false, code: 'unavailable' }` — rather
 * than silently falling back to an unbound pathname mutation.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from './process-runner';

export type WindowsFsGuardErrorCode =
  | 'reparse_ancestor'
  | 'not_directory'
  | 'not_found'
  | 'already_exists'
  | 'hash_mismatch'
  | 'hard_linked'
  | 'not_a_file'
  | 'root_invalid'
  | 'invalid_arguments'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'internal';

export type WindowsFsGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WindowsFsGuardErrorCode; readonly reason: string };

/** Immutable identity of the exact directory handle accepted as the worktree root. */
export interface WindowsFsRootIdentity {
  /** FILE_ID_INFO.VolumeSerialNumber, fixed-width lowercase hexadecimal. */
  readonly volumeSerial: string;
  /** FILE_ID_INFO.FileId, all 128 bits in byte order, lowercase hexadecimal. */
  readonly fileId: string;
  /** BY_HANDLE_FILE_INFORMATION identity used to correlate Node's bigint stat snapshot. */
  readonly legacyVolumeSerial: string;
  readonly legacyFileIndex: string;
}

/** Legacy volume/file index exposed losslessly by Node's bigint fs.Stat. */
export interface WindowsFsFileIdentity {
  readonly volumeSerial: string;
  readonly fileIndex: string;
}

export type WindowsFsRootIdentityResult =
  | { readonly ok: true; readonly identity: WindowsFsRootIdentity }
  | { readonly ok: false; readonly code: WindowsFsGuardErrorCode; readonly reason: string };

export interface WindowsFsGuard {
  /** Capture the native identity of the current root before any model-driven mutation. */
  identifyRoot(root: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsRootIdentityResult>;
  /** Create every missing directory component of `relDir`, relative to `root`. A no-op if `relDir` is empty or already fully exists. */
  mkdirp(root: string, identity: WindowsFsRootIdentity, relDir: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult>;
  /** `relPath` must not already exist. Content is staged through the already identity-bound native root handle. */
  createFile(root: string, identity: WindowsFsRootIdentity, relPath: string, content: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult>;
  /** Re-verifies `expectedSha256` and stages content through the same identity-bound native operation. */
  replaceFile(root: string, identity: WindowsFsRootIdentity, targetIdentity: WindowsFsFileIdentity, relPath: string, content: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult>;
  /** Re-verifies `expectedSha256` through the same handle it deletes with. */
  deleteFile(root: string, identity: WindowsFsRootIdentity, targetIdentity: WindowsFsFileIdentity, relPath: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult>;
}

const WINDOWS_FS_GUARD_EXECUTABLE = 'agent-relay-fs-guard.exe';

function locateExecutable(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, WINDOWS_FS_GUARD_EXECUTABLE),
    resolve(here, '..', '..', '..', '..', 'build', 'Release', WINDOWS_FS_GUARD_EXECUTABLE)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const KNOWN_ERROR_CODES = new Set<string>([
  'REPARSE_ANCESTOR',
  'NOT_DIRECTORY',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'HASH_MISMATCH',
  'HARD_LINKED',
  'NOT_A_FILE',
  'ROOT_INVALID',
  'INVALID_ARGUMENTS',
  'INTERNAL'
]);

function mapErrorCode(code: string): WindowsFsGuardErrorCode {
  switch (code) {
    case 'REPARSE_ANCESTOR': return 'reparse_ancestor';
    case 'NOT_DIRECTORY': return 'not_directory';
    case 'NOT_FOUND': return 'not_found';
    case 'ALREADY_EXISTS': return 'already_exists';
    case 'HASH_MISMATCH': return 'hash_mismatch';
    case 'HARD_LINKED': return 'hard_linked';
    case 'NOT_A_FILE': return 'not_a_file';
    case 'ROOT_INVALID': return 'root_invalid';
    case 'INVALID_ARGUMENTS': return 'invalid_arguments';
    default: return 'internal';
  }
}

function unavailable(reason: string): {
  readonly ok: false;
  readonly code: 'unavailable';
  readonly reason: string;
} {
  return { ok: false, code: 'unavailable', reason };
}

export class ExecaWindowsFsGuard implements WindowsFsGuard {
  private resolvedPath: string | null | undefined;

  constructor(private readonly runner: ProcessRunner) {}

  private resolvePath(): string | null {
    if (this.resolvedPath === undefined) {
      this.resolvedPath = process.platform === 'win32' ? locateExecutable() : null;
    }
    return this.resolvedPath;
  }

  async identifyRoot(root: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsRootIdentityResult> {
    const result = await this.invokeProcess(['identity', root], signal, timeoutMs);
    if (!result.ok) return result;
    const match = /^OK:([0-9a-f]{16}):([0-9a-f]{32}):([0-9]+):([0-9]+)$/.exec(result.line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
      return { ok: false, code: 'internal', reason: 'The mutation guard returned an invalid root identity.' };
    }
    return {
      ok: true,
      identity: {
        volumeSerial: match[1],
        fileId: match[2],
        legacyVolumeSerial: match[3],
        legacyFileIndex: match[4]
      }
    };
  }

  async mkdirp(root: string, identity: WindowsFsRootIdentity, relDir: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult> {
    return this.invoke(['mkdirp', root, identity.volumeSerial, identity.fileId, relDir], signal, timeoutMs);
  }

  async createFile(root: string, identity: WindowsFsRootIdentity, relPath: string, content: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult> {
    return this.invoke(['create', root, identity.volumeSerial, identity.fileId, relPath], signal, timeoutMs, content);
  }

  async replaceFile(root: string, identity: WindowsFsRootIdentity, targetIdentity: WindowsFsFileIdentity, relPath: string, content: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult> {
    return this.invoke([
      'replace', root, identity.volumeSerial, identity.fileId,
      targetIdentity.volumeSerial, targetIdentity.fileIndex, relPath, expectedSha256
    ], signal, timeoutMs, content);
  }

  async deleteFile(root: string, identity: WindowsFsRootIdentity, targetIdentity: WindowsFsFileIdentity, relPath: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<WindowsFsGuardResult> {
    return this.invoke([
      'delete', root, identity.volumeSerial, identity.fileId,
      targetIdentity.volumeSerial, targetIdentity.fileIndex, relPath, expectedSha256
    ], signal, timeoutMs);
  }

  private async invokeProcess(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
    input?: string
  ): Promise<
    | { readonly ok: true; readonly line: string }
    | { readonly ok: false; readonly code: WindowsFsGuardErrorCode; readonly reason: string }
  > {
    const executable = this.resolvePath();
    if (executable === null) {
      return unavailable(
        process.platform === 'win32'
          ? 'The Windows filesystem-mutation guard is not built.'
          : 'The Windows filesystem-mutation guard is only available on Windows; there is no unsafe fallback.'
      );
    }

    const result = await this.runner.run(executable, args, {
      signal,
      timeoutMs,
      input,
      maxOutputBytes: 4096
    });

    if (result.cancelled) return { ok: false, code: 'cancelled', reason: 'The repository mutation was cancelled.' };
    if (result.timedOut) return { ok: false, code: 'timeout', reason: 'The repository mutation timed out.' };

    const line = result.stdout.trim();
    if (result.exitCode === 0) return { ok: true, line };

    const match = /^ERR:([A-Z_]+)$/.exec(line);
    if (match?.[1] !== undefined && KNOWN_ERROR_CODES.has(match[1])) {
      return { ok: false, code: mapErrorCode(match[1]), reason: `The mutation guard refused the operation (${match[1]}).` };
    }
    return { ok: false, code: 'internal', reason: 'The mutation guard returned an unrecognised result.' };
  }

  private async invoke(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
    input?: string
  ): Promise<WindowsFsGuardResult> {
    const result = await this.invokeProcess(args, signal, timeoutMs, input);
    if (!result.ok) return result;
    return result.line === 'OK'
      ? { ok: true }
      : { ok: false, code: 'internal', reason: 'The mutation guard returned an unrecognised success result.' };
  }
}
