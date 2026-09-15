/**
 * The bounded repository tool boundary for an Ornith run.
 *
 * Every method here executes exactly one accepted {@link OrnithAction}
 * against ONE task worktree. Nothing here parses model text as a command —
 * `git` is invoked only with a small fixed set of read-only argv shapes, and
 * every filesystem write goes through Node's `fs/promises`, never a shell.
 *
 * This class knows nothing about the model, the prompt, the loop, or
 * verification. `src/main/services/ornith-implementation.ts` owns those; this
 * file owns only "is this path safe, and is this one repository operation
 * allowed to happen".
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  realpath
} from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  ORNITH_LIMITS,
  type OrnithAction,
  type OrnithDenialCode
} from '../../shared/domain/ornith';
import { containsSecretShape } from '../../shared/util/redact';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { ProcessRunner } from '../adapters/process/process-runner';
import {
  ExecaWindowsFsGuard,
  type WindowsFsFileIdentity,
  type WindowsFsGuard,
  type WindowsFsGuardErrorCode,
  type WindowsFsRootIdentity
} from '../adapters/process/windows-fs-guard';
import { assertSafeWorktreePath, isInsideDirectory, isSamePath } from './path-safety';

/**
 * Map the mutation guard's fixed, closed error vocabulary onto the existing
 * Ornith denial codes. The guard is the authoritative last check, so any of
 * these firing means either a genuine race/attack was caught (`reparse_ancestor`,
 * `hash_mismatch`, `hard_linked`) or the platform primitive is unavailable
 * (`unavailable`) — never a reason to retry with a weaker path.
 */
function mapGuardDenial(code: WindowsFsGuardErrorCode): OrnithDenialCode {
  switch (code) {
    case 'reparse_ancestor':
      return 'path_symlink';
    case 'not_directory':
    case 'not_a_file':
    case 'hard_linked':
      return 'path_not_regular_file';
    case 'not_found':
      return 'file_not_found';
    case 'already_exists':
      return 'file_exists';
    case 'hash_mismatch':
      return 'stale_hash';
    case 'root_invalid':
      return 'checkout_identity_changed';
    case 'invalid_arguments':
      return 'invalid_path';
    case 'timeout':
      return 'timeout';
    default:
      return 'internal_error';
  }
}

/** The directory part of a validated Ornith relative path, `''` for a root-level file. */
function parentRelativeDir(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments.slice(0, -1).join('/');
}

export type OrnithToolResult =
  | {
      readonly ok: true;
      /** Bounded, JSON-serializable. Sent back to the model as the tool result. */
      readonly forModel: unknown;
      /** Bytes of repository content this call actually read (0 for a write-only call). */
      readonly readBytes: number;
      /** Bytes of repository content this call actually wrote (0 for a read-only call). */
      readonly writeBytes: number;
      /** Normalized relative path this call changed, if any. */
      readonly changedPath?: string;
      /** Bounded, safe one-line summary for the audit run event. Never file content. */
      readonly auditSummary: string;
    }
  | {
      readonly ok: false;
      readonly code: OrnithDenialCode;
      readonly reason: string;
    };

export interface OrnithOperationBudget {
  readonly readBytes: number;
  readonly writeBytes: number;
}

const DEFAULT_OPERATION_BUDGET: OrnithOperationBudget = {
  readBytes: ORNITH_LIMITS.maxCumulativeReadBytes,
  writeBytes: ORNITH_LIMITS.maxCumulativeWriteBytes
};

export interface OrnithWorktreeToolsOptions {
  readonly worktreePath: string;
  readonly worktreesRoot: string;
  readonly repositoryPath: string;
  readonly branchName: string;
  readonly runner: ProcessRunner;
  readonly gitExecutablePath?: string | null;
  /** Deterministic race injection for security tests; never wired from IPC or model output. */
  readonly testHooks?: {
    readonly beforeMutation?: (
      kind: 'create_file' | 'replace_text' | 'delete_file',
      relativePath: string
    ) => void | Promise<void>;
    /**
     * Fires after every JavaScript-level validation/recheck has passed and
     * immediately before the native mutation guard is invoked — the exact
     * boundary a pathname-based recheck cannot prove safe. Used only to prove
     * the native guard itself, independently, catches an ancestor swapped at
     * that instant; never wired from IPC or model output.
     */
    readonly beforeNativeMutation?: (
      kind: 'create_file' | 'replace_text' | 'delete_file' | 'mkdirp',
      relativePath: string
    ) => void | Promise<void>;
  };
  /** Overridden only by tests that need to force the guard "unavailable" path. */
  readonly fsGuard?: WindowsFsGuard;
}

function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
  timer.unref?.();
  const onParentAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    }
  };
}

function denied(code: OrnithDenialCode, reason: string): OrnithToolResult {
  return { ok: false, code, reason };
}

/** True when any path segment resolves to `.git`, checked again here defensively. */
function touchesDotGit(relativePath: string): boolean {
  return relativePath.split('/').includes('.git');
}

export class OrnithWorktreeTools {
  private manifest: string[] | null = null;
  /** Manifest entries plus files created this run, minus files deleted this run. */
  private readonly knownFiles = new Set<string>();
  private readonly changedFiles = new Set<string>();
  private gitPath: string | null = null;
  private readonly canonicalRoot: string;
  private readonly rootDevice: bigint | number;
  private readonly rootInode: bigint | number;
  private readonly fsGuard: WindowsFsGuard;
  private nativeRootIdentity: WindowsFsRootIdentity | null = null;

  constructor(private readonly deps: OrnithWorktreeToolsOptions) {
    this.fsGuard = deps.fsGuard ?? new ExecaWindowsFsGuard(deps.runner);
    assertSafeWorktreePath({
      worktreePath: deps.worktreePath,
      worktreesRoot: deps.worktreesRoot,
      repositoryPath: deps.repositoryPath
    });
    const rootStats = lstatSync(deps.worktreePath, { bigint: true });
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new AgentRelayError('UNSAFE_PATH', 'The task worktree root must be a real directory, not a reparse point.');
    }
    this.canonicalRoot = realpathSync.native(deps.worktreePath);
    const canonicalWorktreesRoot = realpathSync.native(deps.worktreesRoot);
    if (!isInsideDirectory(canonicalWorktreesRoot, this.canonicalRoot)) {
      throw new AgentRelayError('UNSAFE_PATH', 'The canonical task worktree is outside the configured worktrees root.');
    }
    this.rootDevice = rootStats.dev;
    this.rootInode = rootStats.ino;
  }

  private async validateRootIdentity(): Promise<boolean> {
    try {
      const stats = await lstat(this.deps.worktreePath, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
      if (stats.dev !== this.rootDevice || stats.ino !== this.rootInode) return false;
      return isSamePath(await realpath(this.deps.worktreePath), this.canonicalRoot);
    } catch {
      return false;
    }
  }

  /**
   * Bind the native FILE_ID_INFO identity to the synchronous Node stat
   * snapshot captured by the constructor. A helper launched after a whole-root
   * pathname replacement therefore cannot silently bless the replacement as
   * the task worktree: its legacy volume/file index must first correlate with
   * the original Node snapshot, and every later mutation receives the full
   * 128-bit native identity.
   */
  private async bindNativeRootIdentity(
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly identity: WindowsFsRootIdentity }
    | { readonly ok: false; readonly code: OrnithDenialCode; readonly reason: string }
  > {
    if (this.nativeRootIdentity !== null) {
      return { ok: true, identity: this.nativeRootIdentity };
    }

    const result = await this.fsGuard.identifyRoot(
      this.canonicalRoot,
      signal,
      ORNITH_LIMITS.filesystemTimeoutMs
    );
    if (!result.ok) {
      return {
        ok: false,
        code: mapGuardDenial(result.code),
        reason: result.reason
      };
    }

    let sameLegacyIdentity = false;
    try {
      sameLegacyIdentity =
        BigInt(result.identity.legacyVolumeSerial) === BigInt(this.rootDevice) &&
        BigInt(result.identity.legacyFileIndex) === BigInt(this.rootInode);
    } catch {
      sameLegacyIdentity = false;
    }
    if (!sameLegacyIdentity) {
      return {
        ok: false,
        code: 'checkout_identity_changed',
        reason: 'The native worktree-root identity does not match the root captured for this run.'
      };
    }

    this.nativeRootIdentity = result.identity;
    return { ok: true, identity: result.identity };
  }

  /** Re-open the root natively and compare the exact identity already bound to this run. */
  private async validateNativeRootIdentity(signal: AbortSignal): Promise<boolean> {
    if (this.nativeRootIdentity === null) return true;
    const result = await this.fsGuard.identifyRoot(
      this.canonicalRoot,
      signal,
      ORNITH_LIMITS.filesystemTimeoutMs
    );
    if (!result.ok) return false;
    const actual = result.identity;
    const expected = this.nativeRootIdentity;
    return actual.volumeSerial === expected.volumeSerial &&
      actual.fileId === expected.fileId &&
      actual.legacyVolumeSerial === expected.legacyVolumeSerial &&
      actual.legacyFileIndex === expected.legacyFileIndex;
  }

  changedFileCount(): number {
    return this.changedFiles.size;
  }

  wouldExceedChangedFileLimit(path: string): boolean {
    return !this.changedFiles.has(path) && this.changedFiles.size >= ORNITH_LIMITS.maxChangedFiles;
  }

  /* ------------------------------------------------------------------ */
  /* Checkout identity                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Confirm the worktree still belongs to this task's branch, before any
   * mutation and before verification. A worktree re-pointed at another
   * checkout underneath a running loop must never be written to.
   */
  async assertCheckoutIdentity(signal?: AbortSignal): Promise<boolean> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      if (!(await this.validateRootIdentity())) return false;
      if (!(await this.validateNativeRootIdentity(bounded))) return false;
      const commonDir = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], bounded);
      const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], bounded);
      if (commonDir === null || branch === null) return false;
      if (branch.trim() === 'HEAD') return false; // detached
      if (branch.trim() !== this.deps.branchName) return false;
      const repoCommonDir = await this.git(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        bounded,
        this.deps.repositoryPath
      );
      if (repoCommonDir === null) return false;
      if (!isSamePath(commonDir.trim(), repoCommonDir.trim())) return false;
      return (await this.validateRootIdentity()) && (await this.validateNativeRootIdentity(bounded));
    } catch {
      if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
      if (bounded.aborted) throw new AgentRelayError('TIMEOUT', 'Checkout identity inspection timed out.');
      return false;
    } finally {
      dispose();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Manifest                                                            */
  /* ------------------------------------------------------------------ */

  private async ensureManifest(signal?: AbortSignal): Promise<string[]> {
    if (this.manifest !== null) return this.manifest;

    if (!(await this.assertCheckoutIdentity(signal))) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The checkout identity changed.');
    }

    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      const tracked = await this.git(['ls-files', '--cached', '-z'], bounded);
      const untracked = await this.git(
        ['ls-files', '--others', '--exclude-standard', '-z'],
        bounded
      );
      if (tracked === null || untracked === null) {
        throw new AgentRelayError('GIT_FAILED', 'Could not build the Ornith repository manifest.');
      }
      const names = new Set<string>();
      const NUL = String.fromCharCode(0);
      for (const raw of `${tracked}${NUL}${untracked}`.split(NUL)) {
        const name = raw.trim();
        if (name.length === 0) continue;
        if (touchesDotGit(name)) continue;
        names.add(name);
      }
      if (names.size > ORNITH_LIMITS.maxManifestFiles) {
        throw new AgentRelayError('VALIDATION_FAILED', 'The repository manifest exceeds the Ornith file limit.');
      }
      const sorted = [...names].sort();
      this.manifest = sorted;
      for (const name of sorted) this.knownFiles.add(name);
      return sorted;
    } finally {
      dispose();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Path resolution & safety                                            */
  /* ------------------------------------------------------------------ */

  private absolutePathFor(relativePath: string): string {
    return join(this.deps.worktreePath, ...relativePath.split('/'));
  }

  /**
   * Resolve `relativePath` against the real filesystem and prove it is safe:
   * every existing ancestor resolves without following a symlink/reparse
   * point outside the worktree, and the final component — if it exists — is
   * a regular file, not a symlink, not a directory, and not hard-linked.
   *
   * Returns the safe absolute path, or a denial. Never follows the final
   * component if it is a symlink; never trusts a name after it has been
   * checked once (the identity check re-happens against whatever `fs`
   * actually opens).
   */
  private async resolveSafe(
    relativePath: string,
    options: { mustExist: boolean; forWrite: boolean },
    signal?: AbortSignal
  ): Promise<{ ok: true; absolutePath: string } | { ok: false; code: OrnithDenialCode; reason: string }> {
    if (touchesDotGit(relativePath)) {
      return { ok: false, code: 'invalid_path', reason: 'The .git directory may not be accessed.' };
    }

    const absolutePath = this.absolutePathFor(relativePath);
    if (!(await this.assertCheckoutIdentity(signal))) {
      return { ok: false, code: 'checkout_identity_changed', reason: 'The checkout identity changed.' };
    }

    // lstat every existing logical ancestor. realpath(parent) alone is not
    // sufficient: a junction may resolve somewhere else still inside the
    // worktree, yet the contract forbids traversing any reparse point.
    const logicalRoot = resolve(this.deps.worktreePath);
    const pathSegments = relative(logicalRoot, absolutePath).split(sep).filter(Boolean);
    let logical = logicalRoot;
    for (const segment of pathSegments.slice(0, -1)) {
      logical = join(logical, segment);
      try {
        const ancestorStats = await lstat(logical);
        if (ancestorStats.isSymbolicLink()) {
          return { ok: false, code: 'path_symlink', reason: 'Symlink and reparse-point ancestors are not accessible.' };
        }
        if (!ancestorStats.isDirectory()) {
          return { ok: false, code: 'path_not_regular_file', reason: 'A path ancestor is not a directory.' };
        }
      } catch {
        if (options.mustExist || !options.forWrite) {
          return { ok: false, code: 'file_not_found', reason: 'A path ancestor does not exist.' };
        }
        break;
      }
    }
    const parent = dirname(absolutePath);

    let parentReal: string;
    try {
      parentReal = await realpath(parent);
    } catch {
      if (options.mustExist || !options.forWrite) {
        return { ok: false, code: 'path_not_regular_file', reason: 'The parent directory does not exist.' };
      }
      // create_file may need to create the parent directory. Validate the
      // deepest EXISTING ancestor stays inside the worktree instead.
      let ancestor = parent;
      for (;;) {
        try {
          parentReal = await realpath(ancestor);
          break;
        } catch {
          const next = dirname(ancestor);
          if (next === ancestor) {
            return { ok: false, code: 'invalid_path', reason: 'No existing ancestor directory was found.' };
          }
          ancestor = next;
        }
      }
    }

    let worktreeReal: string;
    try {
      worktreeReal = await realpath(this.deps.worktreePath);
    } catch {
      return { ok: false, code: 'path_outside_worktree', reason: 'The task worktree could not be resolved.' };
    }
    if (!isSamePath(worktreeReal, parentReal) && !isInsideDirectory(worktreeReal, parentReal)) {
      return { ok: false, code: 'path_outside_worktree', reason: 'The path resolves outside the task worktree.' };
    }

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      if (options.mustExist) {
        return { ok: false, code: 'file_not_found', reason: 'The file does not exist.' };
      }
      return { ok: true, absolutePath };
    }

    if (stats.isSymbolicLink()) {
      return { ok: false, code: 'path_symlink', reason: 'Symlinks and reparse points are not accessible.' };
    }
    if (!stats.isFile()) {
      return { ok: false, code: 'path_not_regular_file', reason: 'Only regular files are accessible.' };
    }
    if (options.forWrite && stats.nlink > 1) {
      return {
        ok: false,
        code: 'path_not_regular_file',
        reason: 'Hard-linked files may not be written to or deleted.'
      };
    }

    return { ok: true, absolutePath };
  }

  /**
   * Read one already-resolved name without following its final component, and
   * prove both the opened inode and the worktree root remained the identities
   * bound at construction. This closes the name-swap gap for search/diff,
   * which must not use a path-based `readFile` after validation.
   */
  private async readRegularFileSafely(
    absolutePath: string,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<{ ok: true; raw: Buffer } | { ok: false; code: OrnithDenialCode; reason: string }> {
    if (!(await this.validateRootIdentity())) {
      return { ok: false, code: 'checkout_identity_changed', reason: 'The task worktree root identity changed.' };
    }
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return { ok: false, code: 'path_not_regular_file', reason: 'Only regular non-link files are accessible.' };
    }
    if (before.size > maxBytes) {
      return { ok: false, code: 'limit_read_bytes_exceeded', reason: 'Reading the file would exceed the remaining repository byte budget.' };
    }
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return { ok: false, code: 'path_symlink', reason: 'The file identity changed before it was opened.' };
      }
      const raw = await handle.readFile({ signal });
      const after = await handle.stat();
      const named = await lstat(absolutePath);
      const namedReal = await realpath(absolutePath);
      if (
        opened.dev !== after.dev || opened.ino !== after.ino ||
        opened.dev !== named.dev || opened.ino !== named.ino || named.isSymbolicLink() ||
        (!isSamePath(this.canonicalRoot, namedReal) && !isInsideDirectory(this.canonicalRoot, namedReal)) ||
        !(await this.validateRootIdentity())
      ) {
        return { ok: false, code: 'path_symlink', reason: 'The file or worktree identity changed while it was being read.' };
      }
      return { ok: true, raw };
    } finally {
      await handle.close();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * `maxResultBytes` bounds the serialized `{files, nextCursor, total}` payload so it
   * always fits the caller's per-turn prompt budget, instead of building a full
   * `action.limit`-sized page and leaving truncation to a later, generic byte-budget
   * check that would otherwise discard `nextCursor`/`total` along with the files —
   * the defect that let a weak model repeat an identical `list_files` request with
   * no way to know pagination was even possible. Entries are packed in cursor order
   * against the EXACT serialized size (not an estimate), so the result is correct by
   * construction rather than approximated.
   */
  async listFiles(
    action: Extract<OrnithAction, { action: 'list_files' }>,
    signal?: AbortSignal,
    maxResultBytes = Number.POSITIVE_INFINITY
  ): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.filesystemTimeoutMs, signal);
    try {
      const manifest = await this.ensureManifest(bounded);
      const prefix = action.prefix;
      const matching = prefix.length === 0
        ? manifest
        : manifest.filter((name) => name === prefix || name.startsWith(`${prefix}/`));
      const cursor = action.cursor ?? 0;

      const page: string[] = [];
      let index = cursor;
      while (page.length < action.limit && index < matching.length) {
        const candidateNextCursor = index + 1 < matching.length ? index + 1 : null;
        const candidateBytes = Buffer.byteLength(
          JSON.stringify({ files: [...page, matching[index]], nextCursor: candidateNextCursor, total: matching.length }),
          'utf8'
        );
        if (candidateBytes > maxResultBytes) break;
        page.push(matching[index]!);
        index += 1;
      }

      if (page.length === 0 && index < matching.length) {
        // Not even the single next entry fits the remaining byte budget. Return a
        // fixed-shape, always-small stub that still carries `nextCursor` (left at
        // `cursor`, since nothing was skipped) and `total` rather than falling
        // through to the fully generic truncation stub that drops them.
        return {
          ok: true,
          forModel: {
            files: [],
            nextCursor: cursor,
            total: matching.length,
            truncated: true,
            reason: 'The next entry did not fit the remaining tool-result byte budget. Retry this same list_files request (same prefix and cursor) once more budget is available.'
          },
          readBytes: 0,
          writeBytes: 0,
          auditSummary: `list_files prefix="${prefix}" -> 0 of ${matching.length} (next entry exceeded byte budget)`
        };
      }

      const nextCursor = index < matching.length ? index : null;
      return {
        ok: true,
        forModel: { files: page, nextCursor, total: matching.length },
        readBytes: 0,
        writeBytes: 0,
        auditSummary: `list_files prefix="${prefix}" -> ${page.length} of ${matching.length}`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async readFile(action: Extract<OrnithAction, { action: 'read_file' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.filesystemTimeoutMs, signal);
    try {
      await this.ensureManifest(bounded);
      if (!this.knownFiles.has(action.path)) {
        return denied('file_not_found', 'The file is not part of the tracked/untracked task manifest.');
      }
      const resolved = await this.resolveSafe(action.path, { mustExist: true, forWrite: false }, bounded);
      if (!resolved.ok) return denied(resolved.code, resolved.reason);

      let handle;
      try {
        handle = await open(resolved.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return denied('file_not_found', 'The file could not be opened.');
      }
      try {
        const fileStats = await handle.stat();
        if (!fileStats.isFile()) {
          return denied('path_not_regular_file', 'Only regular files are accessible.');
        }
        if (fileStats.size > budget.readBytes) {
          return denied('limit_read_bytes_exceeded', 'Reading the file would exceed the remaining repository byte budget.');
        }
        const raw = await handle.readFile({ signal: bounded });
        const afterStats = await handle.stat();
        const namedStats = await lstat(resolved.absolutePath);
        const openedRealPath = await realpath(resolved.absolutePath);
        if (fileStats.dev !== afterStats.dev || fileStats.ino !== afterStats.ino ||
            fileStats.dev !== namedStats.dev || fileStats.ino !== namedStats.ino || namedStats.isSymbolicLink() ||
            (!isSamePath(this.canonicalRoot, openedRealPath) && !isInsideDirectory(this.canonicalRoot, openedRealPath)) ||
            !(await this.validateRootIdentity())) {
          return denied('path_symlink', 'The file identity changed while it was being read.');
        }
        let completeText: string;
        try {
          completeText = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
          return denied('path_not_regular_file', 'The file is not valid UTF-8 text.');
        }
        if (containsSecretShape(completeText)) {
          return denied('disallowed_action', 'The file content looks credential-shaped and was not returned.');
        }
        const sliced = safeUtf8Slice(raw, action.offset, action.limit);
        const sha256 = createHash('sha256').update(raw).digest('hex');

        return {
          ok: true,
          forModel: {
            path: action.path,
            offset: sliced.offset,
            bytesRead: sliced.bytesRead,
            eof: sliced.offset + sliced.bytesRead >= fileStats.size,
            content: sliced.text,
            sha256
          },
          readBytes: raw.byteLength,
          writeBytes: 0,
          auditSummary: `read_file path="${action.path}" offset=${sliced.offset} bytes=${sliced.bytesRead} sha256=${sha256}`
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async searchText(action: Extract<OrnithAction, { action: 'search_text' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.searchTimeoutMs, signal);
    try {
      const manifest = await this.ensureManifest(bounded);
      const candidates = action.files ?? manifest;
      for (const path of candidates) {
        if (!this.knownFiles.has(path)) {
          return denied('file_not_found', `"${path}" is not part of the task manifest.`);
        }
      }

      const needle = action.caseSensitive ? action.query : action.query.toLowerCase();
      const matches: { path: string; line: number }[] = [];
      let readBytesTotal = 0;

      for (const path of candidates) {
        if (matches.length >= action.limit) break;
        const resolved = await this.resolveSafe(path, { mustExist: true, forWrite: false }, bounded);
        if (!resolved.ok) continue;
        let content: string;
        try {
          const stats = await lstat(resolved.absolutePath);
          if (stats.size > ORNITH_LIMITS.maxReadBytes) continue;
          if (readBytesTotal + stats.size > budget.readBytes) {
            return denied('limit_read_bytes_exceeded', 'Search would exceed the remaining repository byte budget.');
          }
          const safeRead = await this.readRegularFileSafely(
            resolved.absolutePath,
            Math.min(ORNITH_LIMITS.maxReadBytes, budget.readBytes - readBytesTotal),
            bounded
          );
          if (!safeRead.ok) {
            if (safeRead.code === 'limit_read_bytes_exceeded' && stats.size > ORNITH_LIMITS.maxReadBytes) continue;
            return denied(safeRead.code, safeRead.reason);
          }
          const raw = safeRead.raw;
          readBytesTotal += raw.byteLength;
          content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
          continue; // binary or unreadable: silently skipped, matching a literal-text search's scope
        }
        const haystack = action.caseSensitive ? content : content.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && matches.length < action.limit; index += 1) {
          const line = action.caseSensitive ? lines[index] : lines[index]?.toLowerCase();
          if (line !== undefined && line.includes(needle)) {
            matches.push({ path, line: index + 1 });
          }
        }
      }

      return {
        ok: true,
        forModel: { matches, truncated: matches.length >= action.limit },
        readBytes: readBytesTotal,
        writeBytes: 0,
        auditSummary: `search_text -> ${matches.length} match(es) across ${candidates.length} file(s)`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async createFile(action: Extract<OrnithAction, { action: 'create_file' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.filesystemTimeoutMs, signal);
    try {
      const rootBinding = await this.bindNativeRootIdentity(bounded);
      if (!rootBinding.ok) return denied(rootBinding.code, rootBinding.reason);
      await this.ensureManifest(bounded);
      if (this.knownFiles.has(action.path)) {
        return denied('file_exists', 'A file already exists at that path.');
      }
      const resolved = await this.resolveSafe(action.path, { mustExist: false, forWrite: true }, bounded);
      if (!resolved.ok) return denied(resolved.code, resolved.reason);

      // Double-check nothing exists there right now (manifest can only know
      // about the repository state at construction time / after prior writes
      // this run, not about a file appearing out of band).
      try {
        await lstat(resolved.absolutePath);
        return denied('file_exists', 'A file already exists at that path.');
      } catch {
        // ENOENT is the success path.
      }

      const contentBytes = Buffer.byteLength(action.content, 'utf8');
      if (contentBytes > budget.writeBytes) {
        return denied('limit_write_bytes_exceeded', 'Creating the file would exceed the remaining repository write budget.');
      }
      const parentDir = parentRelativeDir(action.path);
      if (parentDir.length > 0) {
        await this.deps.testHooks?.beforeNativeMutation?.('mkdirp', action.path);
        const mkdirResult = await this.fsGuard.mkdirp(
          this.canonicalRoot,
          rootBinding.identity,
          parentDir,
          bounded,
          ORNITH_LIMITS.filesystemTimeoutMs
        );
        if (!mkdirResult.ok) {
          if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
          if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
          return denied(mapGuardDenial(mkdirResult.code), 'The mutation guard could not prepare the destination directory.');
        }
      }

      await this.deps.testHooks?.beforeMutation?.('create_file', action.path);
      const rechecked = await this.resolveSafe(action.path, { mustExist: false, forWrite: true }, bounded);
      if (!rechecked.ok) return denied(rechecked.code, rechecked.reason);
      try {
        await lstat(rechecked.absolutePath);
        return denied('file_exists', 'A file appeared at the requested path before creation.');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (!(await this.assertCheckoutIdentity(bounded))) {
        return denied('checkout_identity_changed', 'The checkout identity changed.');
      }
      assertMutationSignal(signal, bounded);
      await this.deps.testHooks?.beforeNativeMutation?.('create_file', action.path);
      const guardResult = await this.fsGuard.createFile(
        this.canonicalRoot,
        rootBinding.identity,
        action.path,
        action.content,
        bounded,
        ORNITH_LIMITS.filesystemTimeoutMs
      );
      if (!guardResult.ok) {
        if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
        if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
        return denied(mapGuardDenial(guardResult.code), guardResult.reason);
      }

      this.knownFiles.add(action.path);
      this.changedFiles.add(action.path);
      const sha256 = createHash('sha256').update(action.content, 'utf8').digest('hex');

      return {
        ok: true,
        forModel: { path: action.path, bytesWritten: contentBytes, sha256 },
        readBytes: 0,
        writeBytes: contentBytes,
        changedPath: action.path,
        auditSummary: `create_file path="${action.path}" bytes=${contentBytes}`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async replaceText(action: Extract<OrnithAction, { action: 'replace_text' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.filesystemTimeoutMs, signal);
    try {
      const rootBinding = await this.bindNativeRootIdentity(bounded);
      if (!rootBinding.ok) return denied(rootBinding.code, rootBinding.reason);
      await this.ensureManifest(bounded);
      if (!this.knownFiles.has(action.path)) {
        return denied('file_not_found', 'The file is not part of the tracked/untracked task manifest.');
      }
      const resolved = await this.resolveSafe(action.path, { mustExist: true, forWrite: true }, bounded);
      if (!resolved.ok) return denied(resolved.code, resolved.reason);

      const beforeStats = await lstat(resolved.absolutePath, { bigint: true });
      if (beforeStats.size > budget.readBytes) {
        return denied('limit_read_bytes_exceeded', 'Reading the file would exceed the remaining repository byte budget.');
      }
      const handle = await open(resolved.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: Buffer;
      let targetIdentity: WindowsFsFileIdentity;
      try {
        const openedStats = await handle.stat({ bigint: true });
        if (openedStats.dev !== beforeStats.dev || openedStats.ino !== beforeStats.ino || openedStats.nlink > 1) {
          return denied('path_not_regular_file', 'The file identity changed or is hard-linked.');
        }
        targetIdentity = {
          volumeSerial: openedStats.dev.toString(),
          fileIndex: openedStats.ino.toString()
        };
        raw = await handle.readFile({ signal: bounded });
      } finally {
        await handle.close();
      }
      if (raw.byteLength > ORNITH_LIMITS.maxFileBytes) {
        return denied('limit_read_bytes_exceeded', 'The file exceeds the size this tool may edit.');
      }
      const currentSha256 = createHash('sha256').update(raw).digest('hex');
      if (currentSha256 !== action.sha256) {
        return denied('stale_hash', 'The supplied hash does not match the file’s current content.');
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        return denied('path_not_regular_file', 'The file is not valid UTF-8 text.');
      }

      let next = text;
      for (const replacement of action.replacements) {
        const occurrences = countOccurrences(next, replacement.oldText);
        if (occurrences !== 1) {
          return denied(
            'replacement_mismatch',
            `A replacement's oldText occurs ${occurrences} time(s) at the moment it is applied; it must occur exactly once. No write was made.`
          );
        }
        next = next.replace(replacement.oldText, () => replacement.newText);
      }

      const nextBytes = Buffer.byteLength(next, 'utf8');
      if (nextBytes > ORNITH_LIMITS.maxFileBytes) {
        return denied('limit_write_bytes_exceeded', 'The resulting file would exceed the size limit.');
      }
      if (nextBytes > budget.writeBytes) {
        return denied('limit_write_bytes_exceeded', 'Replacing the file would exceed the remaining repository write budget.');
      }
      if (containsSecretShape(next)) {
        return denied('disallowed_action', 'The resulting file content looks credential-shaped.');
      }

      await this.deps.testHooks?.beforeMutation?.('replace_text', action.path);
      const rechecked = await this.resolveSafe(action.path, { mustExist: true, forWrite: true }, bounded);
      if (!rechecked.ok) return denied(rechecked.code, rechecked.reason);
      const finalRead = await this.readRegularFileSafely(
        rechecked.absolutePath,
        budget.readBytes - raw.byteLength,
        bounded
      );
      if (!finalRead.ok) return denied(finalRead.code, finalRead.reason);
      if (createHash('sha256').update(finalRead.raw).digest('hex') !== action.sha256) {
        return denied('stale_hash', 'The file content changed before replacement.');
      }
      if (!(await this.assertCheckoutIdentity(bounded))) {
        return denied('checkout_identity_changed', 'The checkout identity changed.');
      }
      assertMutationSignal(signal, bounded);
      // The native guard both stages the replacement through the bound root
      // handle and re-verifies the destination hash before the relative rename.
      await this.deps.testHooks?.beforeNativeMutation?.('replace_text', action.path);
      const guardResult = await this.fsGuard.replaceFile(
        this.canonicalRoot,
        rootBinding.identity,
        targetIdentity,
        action.path,
        next,
        action.sha256,
        bounded,
        ORNITH_LIMITS.filesystemTimeoutMs
      );
      if (!guardResult.ok) {
        if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
        if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
        return denied(mapGuardDenial(guardResult.code), guardResult.reason);
      }

      this.changedFiles.add(action.path);
      const newSha256 = createHash('sha256').update(next, 'utf8').digest('hex');

      return {
        ok: true,
        forModel: { path: action.path, sha256: newSha256, bytesWritten: nextBytes },
        readBytes: raw.byteLength * 2,
        writeBytes: nextBytes,
        changedPath: action.path,
        auditSummary: `replace_text path="${action.path}" replacements=${action.replacements.length}`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async deleteFile(action: Extract<OrnithAction, { action: 'delete_file' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.filesystemTimeoutMs, signal);
    try {
      const rootBinding = await this.bindNativeRootIdentity(bounded);
      if (!rootBinding.ok) return denied(rootBinding.code, rootBinding.reason);
      await this.ensureManifest(bounded);
      if (!this.knownFiles.has(action.path)) {
        return denied('file_not_found', 'The file is not part of the tracked/untracked task manifest.');
      }
      const resolved = await this.resolveSafe(action.path, { mustExist: true, forWrite: true }, bounded);
      if (!resolved.ok) return denied(resolved.code, resolved.reason);

      const beforeStats = await lstat(resolved.absolutePath, { bigint: true });
      if (beforeStats.size > budget.readBytes) {
        return denied('limit_read_bytes_exceeded', 'Hashing the file would exceed the remaining repository byte budget.');
      }
      const handle = await open(resolved.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: Buffer;
      let targetIdentity: WindowsFsFileIdentity;
      try {
        const openedStats = await handle.stat({ bigint: true });
        if (openedStats.dev !== beforeStats.dev || openedStats.ino !== beforeStats.ino || openedStats.nlink > 1) {
          return denied('path_not_regular_file', 'The file identity changed or is hard-linked.');
        }
        targetIdentity = {
          volumeSerial: openedStats.dev.toString(),
          fileIndex: openedStats.ino.toString()
        };
        raw = await handle.readFile({ signal: bounded });
      } finally {
        await handle.close();
      }
      const currentSha256 = createHash('sha256').update(raw).digest('hex');
      if (currentSha256 !== action.sha256) {
        return denied('stale_hash', 'The supplied hash does not match the file’s current content.');
      }

      try {
        await this.deps.testHooks?.beforeMutation?.('delete_file', action.path);
        const rechecked = await this.resolveSafe(action.path, { mustExist: true, forWrite: true }, bounded);
        if (!rechecked.ok) return denied(rechecked.code, rechecked.reason);
        const finalRead = await this.readRegularFileSafely(
          rechecked.absolutePath,
          budget.readBytes - raw.byteLength,
          bounded
        );
        if (!finalRead.ok) return denied(finalRead.code, finalRead.reason);
        if (createHash('sha256').update(finalRead.raw).digest('hex') !== action.sha256) {
          return denied('stale_hash', 'The file content changed before deletion.');
        }
        if (!(await this.assertCheckoutIdentity(bounded))) {
          return denied('checkout_identity_changed', 'The checkout identity changed.');
        }
        assertMutationSignal(signal, bounded);
        // The guard re-opens the file by handle, re-verifies this same
        // sha256 through that handle, and deletes it via the same handle —
        // no re-resolution by name between verification and deletion.
        await this.deps.testHooks?.beforeNativeMutation?.('delete_file', action.path);
        const guardResult = await this.fsGuard.deleteFile(
          this.canonicalRoot,
          rootBinding.identity,
          targetIdentity,
          action.path,
          action.sha256,
          bounded,
          ORNITH_LIMITS.filesystemTimeoutMs
        );
        if (!guardResult.ok) {
          if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
          if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
          return denied(mapGuardDenial(guardResult.code), guardResult.reason);
        }
      } catch (error) {
        return operationFailure(error, signal, bounded);
      }

      this.knownFiles.delete(action.path);
      this.changedFiles.add(action.path);

      return {
        ok: true,
        forModel: { path: action.path, deleted: true },
        readBytes: raw.byteLength * 2,
        writeBytes: 0,
        changedPath: action.path,
        auditSummary: `delete_file path="${action.path}"`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async gitStatus(signal?: AbortSignal): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      if (!(await this.assertCheckoutIdentity(bounded))) return denied('checkout_identity_changed', 'The checkout identity changed.');
      const output = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], bounded);
      if (output === null) return denied('internal_error', 'git status could not be read.');
      if (containsSecretShape(output)) return denied('disallowed_action', 'Git status contained credential-shaped data.');
      const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, ORNITH_LIMITS.maxManifestFiles);
      return {
        ok: true,
        forModel: { entries: lines },
        readBytes: 0,
        writeBytes: 0,
        auditSummary: `git_status -> ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  async gitDiff(action: Extract<OrnithAction, { action: 'git_diff' }>, signal?: AbortSignal, budget = DEFAULT_OPERATION_BUDGET): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      if (!(await this.assertCheckoutIdentity(bounded))) return denied('checkout_identity_changed', 'The checkout identity changed.');
      const args = ['diff', 'HEAD', '--'];
      if (action.paths && action.paths.length > 0) args.push(...action.paths);
      const trackedDiff = await this.git(args, bounded, undefined, Math.min(8 * 1024 * 1024, budget.readBytes + 1));
      if (trackedDiff === null) return denied('internal_error', 'git diff could not be read.');
      let bytesConsumed = Buffer.byteLength(trackedDiff, 'utf8');
      if (bytesConsumed > budget.readBytes) {
        return denied('limit_read_bytes_exceeded', 'Git diff would exceed the remaining repository byte budget.');
      }
      const manifest = await this.ensureManifest(bounded);
      const selected = action.paths ?? manifest;
      for (const path of selected) {
        if (!this.knownFiles.has(path)) return denied('file_not_found', 'A requested diff path is not in the task manifest.');
      }
      const untrackedArgs = ['ls-files', '--others', '--exclude-standard', '-z', '--'];
      if (action.paths && action.paths.length > 0) untrackedArgs.push(...action.paths);
      const untrackedRaw = await this.git(untrackedArgs, bounded);
      if (untrackedRaw === null) return denied('internal_error', 'Untracked files could not be inspected.');
      const additions: string[] = [];
      for (const path of untrackedRaw.split(String.fromCharCode(0)).filter(Boolean)) {
        const resolved = await this.resolveSafe(path, { mustExist: true, forWrite: false }, bounded);
        if (!resolved.ok) return denied(resolved.code, resolved.reason);
        const stats = await lstat(resolved.absolutePath);
        if (bytesConsumed + stats.size > budget.readBytes) {
          return denied('limit_read_bytes_exceeded', 'Untracked diff content would exceed the remaining repository byte budget.');
        }
        const safeRead = await this.readRegularFileSafely(
          resolved.absolutePath,
          budget.readBytes - bytesConsumed,
          bounded
        );
        if (!safeRead.ok) return denied(safeRead.code, safeRead.reason);
        const raw = safeRead.raw;
        bytesConsumed += raw.byteLength;
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
          return denied('path_not_regular_file', 'An untracked file is not valid UTF-8 text.');
        }
        const lines = content.split('\n');
        additions.push(
          `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`
        );
      }
      const output = [trackedDiff, ...additions].filter(Boolean).join('\n');
      if (containsSecretShape(output)) {
        return denied('disallowed_action', 'The diff contains credential-shaped content and was not returned.');
      }
      const outputBytes = Buffer.byteLength(output, 'utf8');
      const diffBudget = ORNITH_LIMITS.maxToolResultBytes - 256;
      const bounded_ = outputBytes > diffBudget
        ? `${truncateUtf8(output, diffBudget - 24)}\n…[diff truncated]`
        : output;
      return {
        ok: true,
        forModel: { diff: bounded_, truncated: outputBytes > diffBudget, originalBytes: outputBytes },
        readBytes: bytesConsumed,
        writeBytes: 0,
        auditSummary: `git_diff paths=${action.paths?.length ?? 0} -> ${output.length} chars`
      };
    } catch (error) {
      return operationFailure(error, signal, bounded);
    } finally {
      dispose();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Git plumbing                                                        */
  /* ------------------------------------------------------------------ */

  private resolveGit(): string {
    if (this.gitPath !== null) return this.gitPath;
    const located = locateExecutable('git', { configuredPath: this.deps.gitExecutablePath ?? null });
    if (!located) {
      throw new AgentRelayError('TOOL_MISSING', 'Git was not found for the Ornith worktree tools.');
    }
    this.gitPath = located.path;
    return located.path;
  }

  /** Fixed, read-only Git invocations only. Never stages, commits, or mutates the index. */
  private async git(args: readonly string[], signal: AbortSignal, cwd?: string, maxOutputBytes = 8 * 1024 * 1024): Promise<string | null> {
    const result = await this.deps.runner.run(this.resolveGit(), args, {
      cwd: cwd ?? this.deps.worktreePath,
      signal,
      timeoutMs: ORNITH_LIMITS.gitTimeoutMs,
      maxOutputBytes,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true'
      }
    });
    if (signal.aborted || result.cancelled) {
      throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
    }
    if (result.timedOut) {
      throw new AgentRelayError('TIMEOUT', 'The Git inspection timed out.');
    }
    if (result.exitCode !== 0 || result.failed) return null;
    return result.stdout;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Return a byte-bounded UTF-8 slice without cutting a multibyte code point. */
function safeUtf8Slice(raw: Buffer, requestedOffset: number, limit: number): {
  offset: number;
  bytesRead: number;
  text: string;
} {
  let start = Math.min(requestedOffset, raw.byteLength);
  while (start < raw.byteLength && (raw[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(raw.byteLength, start + limit);
  while (end > start && end < raw.byteLength && (raw[end]! & 0xc0) === 0x80) end -= 1;
  const bytes = raw.subarray(start, end);
  return {
    offset: start,
    bytesRead: bytes.byteLength,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const raw = Buffer.from(value, 'utf8');
  if (raw.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end));
}

/** Bounded, safe error text. Never the underlying exception's raw message or stack. */
function boundedErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.constructor.name : 'unknown error';
  return `An internal error occurred (${message}).`.slice(0, ORNITH_LIMITS.maxErrorChars);
}

function operationFailure(error: unknown, parent: AbortSignal | undefined, bounded: AbortSignal): OrnithToolResult {
  if (parent?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
  if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
  return denied('internal_error', boundedErrorReason(error));
}

/** Refuse to begin the irreversible pathname operation after either bound expires. */
function assertMutationSignal(parent: AbortSignal | undefined, bounded: AbortSignal): void {
  if (parent?.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
  if (bounded.aborted) throw new AgentRelayError('TIMEOUT', 'The repository operation timed out.');
}
