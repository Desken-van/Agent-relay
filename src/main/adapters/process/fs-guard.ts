/**
 * The TypeScript side of the TOCTOU-safe Ornith mutation boundary.
 *
 * A small native helper per platform performs the actual
 * create/replace/delete/mkdirp against handles (Windows) or file descriptors
 * (Linux) opened relative to the canonical worktree root, immune to a
 * pathname-based ancestor swap:
 *
 *  - Windows: `native/windows-fs-guard.cpp` → `agent-relay-fs-guard.exe`
 *  - Linux:   `native/linux-fs-guard.cpp`   → `agent-relay-fs-guard`
 *
 * Both are built by `scripts/build-native.mjs` (node-gyp) and speak the same
 * fixed argv protocol and closed-vocabulary stdout line, so this module only
 * locates the executable for the current platform, invokes it through the
 * existing `ProcessRunner` (the same seam used for `git`), and maps its
 * result back to a typed value.
 *
 * `create`/`replace`/`delete`/`mkdirp` are the only four operation names the
 * helper accepts; nothing here builds a shell command line or passes model or
 * user text as anything but one bounded, pre-validated argv entry.
 *
 * On any other platform, or when the executable was not built, every method
 * fails closed — `{ ok: false, code: 'unavailable' }` with a reason that says
 * which — rather than silently falling back to an unbound pathname mutation.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from './process-runner';

export type FsGuardErrorCode =
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

export type FsGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: FsGuardErrorCode; readonly reason: string };

/**
 * Immutable identity of the exact directory the helper accepted as the worktree root.
 *
 * Every field is produced by the native helper and only ever compared for equality.
 */
export interface FsRootIdentity {
  /**
   * 16 lowercase hexadecimal digits. Windows: FILE_ID_INFO.VolumeSerialNumber.
   * Linux: the device number, as `fs.Stats.dev` reports it.
   */
  readonly volumeId: string;
  /**
   * 32 lowercase hexadecimal digits. Windows: all 128 bits of FILE_ID_INFO.FileId.
   * Linux: the inode number followed by the inode birth time, so a directory
   * recreated at the same path with a reused inode number is still different.
   */
  readonly fileId: string;
  /** Decimal; correlates with the bigint `fs.Stats.dev` of the caller's own snapshot. */
  readonly statDev: string;
  /** Decimal; correlates with the bigint `fs.Stats.ino` of the caller's own snapshot. */
  readonly statIno: string;
}

/** A file's identity exactly as Node's bigint `fs.Stats` reports it (`dev`, `ino`), in decimal. */
export interface FsFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export type FsRootIdentityResult =
  | { readonly ok: true; readonly identity: FsRootIdentity }
  | { readonly ok: false; readonly code: FsGuardErrorCode; readonly reason: string };

export interface FsGuard {
  /** Capture the native identity of the current root before any model-driven mutation. */
  identifyRoot(root: string, signal: AbortSignal, timeoutMs: number): Promise<FsRootIdentityResult>;
  /** Create every missing directory component of `relDir`, relative to `root`. A no-op if `relDir` is empty or already fully exists. */
  mkdirp(root: string, identity: FsRootIdentity, relDir: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult>;
  /** `relPath` must not already exist. Content is staged through the already identity-bound native root. */
  createFile(root: string, identity: FsRootIdentity, relPath: string, content: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult>;
  /** Re-verifies `targetIdentity` and `expectedSha256` and stages content through the same identity-bound native operation. */
  replaceFile(root: string, identity: FsRootIdentity, targetIdentity: FsFileIdentity, relPath: string, content: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult>;
  /** Re-verifies `targetIdentity` and `expectedSha256` through the same handle or descriptor it deletes with. */
  deleteFile(root: string, identity: FsRootIdentity, targetIdentity: FsFileIdentity, relPath: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult>;
}

/** The helper executable each supported platform builds; any platform absent here has none. */
const FS_GUARD_EXECUTABLES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'agent-relay-fs-guard.exe',
  linux: 'agent-relay-fs-guard'
};

/** The helper's file name on `platform`, or null when Agent Relay has no guard for it. */
export function fsGuardExecutableName(platform: NodeJS.Platform = process.platform): string | null {
  return FS_GUARD_EXECUTABLES[platform] ?? null;
}

/**
 * Beside this module (the built `out/main`, where electron-vite copies it), or
 * in the node-gyp output of a source checkout.
 */
function locateExecutable(name: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, name),
    resolve(here, '..', '..', '..', '..', 'build', 'Release', name)
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

function mapErrorCode(code: string): FsGuardErrorCode {
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

export interface ExecaFsGuardOptions {
  /** Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to the lookup beside this module and in `build/Release`. */
  readonly locate?: (executableName: string) => string | null;
}

export class ExecaFsGuard implements FsGuard {
  private resolvedPath: string | null | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly locate: (executableName: string) => string | null;

  constructor(private readonly runner: ProcessRunner, options: ExecaFsGuardOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.locate = options.locate ?? locateExecutable;
  }

  private resolvePath(): string | null {
    if (this.resolvedPath === undefined) {
      const name = fsGuardExecutableName(this.platform);
      this.resolvedPath = name === null ? null : this.locate(name);
    }
    return this.resolvedPath;
  }

  async identifyRoot(root: string, signal: AbortSignal, timeoutMs: number): Promise<FsRootIdentityResult> {
    const result = await this.invokeProcess(['identity', root], signal, timeoutMs);
    if (!result.ok) return result;
    const match = /^OK:([0-9a-f]{16}):([0-9a-f]{32}):([0-9]+):([0-9]+)$/.exec(result.line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
      return { ok: false, code: 'internal', reason: 'The mutation guard returned an invalid root identity.' };
    }
    return {
      ok: true,
      identity: {
        volumeId: match[1],
        fileId: match[2],
        statDev: match[3],
        statIno: match[4]
      }
    };
  }

  async mkdirp(root: string, identity: FsRootIdentity, relDir: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult> {
    return this.invoke(['mkdirp', root, identity.volumeId, identity.fileId, relDir], signal, timeoutMs);
  }

  async createFile(root: string, identity: FsRootIdentity, relPath: string, content: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult> {
    return this.invoke(['create', root, identity.volumeId, identity.fileId, relPath], signal, timeoutMs, content);
  }

  async replaceFile(root: string, identity: FsRootIdentity, targetIdentity: FsFileIdentity, relPath: string, content: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult> {
    return this.invoke([
      'replace', root, identity.volumeId, identity.fileId,
      targetIdentity.dev, targetIdentity.ino, relPath, expectedSha256
    ], signal, timeoutMs, content);
  }

  async deleteFile(root: string, identity: FsRootIdentity, targetIdentity: FsFileIdentity, relPath: string, expectedSha256: string, signal: AbortSignal, timeoutMs: number): Promise<FsGuardResult> {
    return this.invoke([
      'delete', root, identity.volumeId, identity.fileId,
      targetIdentity.dev, targetIdentity.ino, relPath, expectedSha256
    ], signal, timeoutMs);
  }

  private unavailableReason(): string {
    const name = fsGuardExecutableName(this.platform);
    if (name === null) {
      return `Agent Relay has no filesystem-mutation guard for this platform (${this.platform}); ` +
        'repository edits are refused because there is no unsafe fallback.';
    }
    return `The filesystem-mutation guard (${name}) is not built; run "npm run build:native" in the Agent Relay checkout ` +
      'and restart Agent Relay. Repository edits are refused until then.';
  }

  private async invokeProcess(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
    input?: string
  ): Promise<
    | { readonly ok: true; readonly line: string }
    | { readonly ok: false; readonly code: FsGuardErrorCode; readonly reason: string }
  > {
    const executable = this.resolvePath();
    if (executable === null) return unavailable(this.unavailableReason());

    const result = await this.runner.run(executable, args, {
      signal,
      timeoutMs,
      input,
      maxOutputBytes: 4096,
      // A test-only switch to the helper's portable path; never inherited by a real run.
      omitEnvNames: ['AGENT_RELAY_FS_GUARD_PORTABLE_ONLY']
    });

    const line = result.stdout.trim();
    // A helper that exited normally with OK did what it was asked, even when a timeout or a
    // cancellation reached it during its commit: the Linux helper defers those signals and
    // finishes, so reporting a failure here would hide a change that really landed.
    if (result.exitCode === 0 && /^OK(?::|$)/.test(line)) return { ok: true, line };

    if (result.cancelled) return { ok: false, code: 'cancelled', reason: 'The repository mutation was cancelled.' };
    if (result.timedOut) return { ok: false, code: 'timeout', reason: 'The repository mutation timed out.' };

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
  ): Promise<FsGuardResult> {
    const result = await this.invokeProcess(args, signal, timeoutMs, input);
    if (!result.ok) return result;
    return result.line === 'OK'
      ? { ok: true }
      : { ok: false, code: 'internal', reason: 'The mutation guard returned an unrecognised success result.' };
  }
}
