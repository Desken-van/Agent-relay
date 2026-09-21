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
  realpath,
  type FileHandle
} from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  ORNITH_LIMITS,
  classifyLineEnding,
  containsLiteralLineBreakEscape,
  type OrnithAction,
  type OrnithDenialCode
} from '../../shared/domain/ornith';
import { containsSecretShape } from '../../shared/util/redact';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../adapters/process/process-runner';
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
      /**
       * Bytes of repository content this call read on the model's behalf and that count
       * against the DISCOVERY budget (0 for a write-only call, and 0 for a mutation whose
       * internal validation was charged to `validationReadBytes` instead).
       */
      readonly readBytes: number;
      /**
       * Bytes Relay re-read only to validate a mutation of a file the model was already
       * shown, charged to the separate mutation-validation budget. Never shown to the
       * model. Absent means 0.
       */
      readonly validationReadBytes?: number;
      /** Bytes of repository content this call actually wrote (0 for a read-only call). */
      readonly writeBytes: number;
      /** Normalized relative path this call changed, if any. */
      readonly changedPath?: string;
      /**
       * For `search_text` only: how many matches it found. Present ONLY when every candidate file was
       * searched; absent when any was skipped (unreadable, binary, too large, over budget), because then
       * a count of zero would not mean "the named files do not contain this".
       */
      readonly matchCount?: number;
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
  /**
   * A specification's raw `scopedFilePaths` claim, already syntax-sanitized
   * by `sanitizeScopedFilePaths` (main/services/ornith-implementation.ts).
   * Intersected against the real manifest once, by `resolveAuthoritativeScope()`,
   * to become `authoritativeScope` — a candidate that does not exist in this
   * worktree is silently dropped, never treated as an error. Absent or fully
   * unmatched means "no trustworthy scope": every existing code path then
   * behaves exactly as it does without this option.
   */
  readonly scopedFilePathCandidates?: readonly string[];
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
    /**
     * Fires immediately before {@link identityRecheckCadence} performs an
     * actual checkout-identity re-check partway through a multi-candidate
     * scan (`searchText`, `gitDiff`'s untracked pass) — never on the calls in
     * between, which are free. Used only to prove that a worktree swapped out
     * from underneath a long-running scan is still caught within one
     * recheck interval, not merely at the next model turn; never wired from
     * IPC or model output.
     */
    readonly beforeIdentityRecheck?: () => void | Promise<void>;
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

const VALIDATION_READ_CHUNK_BYTES = 64 * 1024;

/** Ordinary ceiling for the output of one fixed read-only Git invocation, per stream. */
const GIT_DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** More untracked files than this and a worktree fingerprint is not taken (the caller treats the state as new). */
const FINGERPRINT_MAX_UNTRACKED_FILES = 200;
/** ...and likewise when their content adds up to more than this: the fingerprint is a cheap preflight, not a scan. */
const FINGERPRINT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** One reason for every diff that does not fit: it names the budget and promises nothing was returned. */
const GIT_DIFF_BUDGET_REASON =
  'The diff does not fit the remaining repository discovery budget. Nothing was returned and the worktree is unchanged by this request.';

/**
 * Read at most `limit + 1` bytes from an open handle. A result longer than `limit`
 * proves the file outgrew what the caller was authorised to read, without ever
 * buffering more than one byte past that bound — `handle.readFile` would buffer
 * whatever the file has become. The one extra byte is only a growth sentinel and is never
 * counted: `onRead` is told, chunk by chunk as each chunk arrives, how many of the bytes
 * just read count toward `limit`, so a read that is aborted or times out part-way has still
 * been charged for everything it read, and the total charged never exceeds `limit`.
 */
async function readAtMost(
  handle: FileHandle,
  limit: number,
  signal: AbortSignal,
  onRead?: (countedBytes: number) => void
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    signal.throwIfAborted();
    const chunk = Buffer.allocUnsafe(Math.min(VALIDATION_READ_CHUNK_BYTES, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    onRead?.(Math.max(0, Math.min(bytesRead, limit - total)));
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
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
  /**
   * The whole-file sha256 values this run has SHOWN the model, per path: one is issued
   * by every successful `read_file`, `create_file` and `replace_text`. A mutation that
   * supplies one of them is editing a file the model was already authorised to read —
   * and paid the discovery budget for — so Relay's own re-reads to validate that edit
   * are charged to {@link validationBytesRead}, not to discovery. A hash Relay never
   * issued (a guess, or one from another file) earns nothing: the edit keeps drawing on
   * the discovery budget exactly as before. Bounded by the action cap, and pruned on delete.
   */
  private readonly shownHashes = new Map<string, Set<string>>();
  /**
   * Bytes Relay itself re-read for mutation validation, cumulative for this run and
   * counted at the moment they are read — a denied or failed attempt still consumed
   * them, so retrying cannot buy more.
   */
  private validationBytesRead = 0;
  private gitPath: string | null = null;
  private readonly canonicalRoot: string;
  private readonly rootDevice: bigint | number;
  private readonly rootInode: bigint | number;
  private readonly fsGuard: WindowsFsGuard;
  private nativeRootIdentity: WindowsFsRootIdentity | null = null;
  /** Manifest-confirmed subset of `scopedFilePathCandidates`; computed only by `resolveAuthoritativeScope()`. */
  private authoritativeScope: readonly string[] | null = null;
  /**
   * Set once `resolveAuthoritativeScope()` has decided, success or failure, so
   * every later call returns the SAME answer that was already reported to the
   * model (e.g. a manifest build that failed transiently during the eager
   * pre-loop call is never quietly retried into a different scope). Nothing
   * else derives or touches `authoritativeScope`: it is not part of the
   * manifest's own lifecycle.
   */
  private authoritativeScopeDecided = false;

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

  /** Cumulative bytes Relay re-read for mutation validation this run (never model-visible). */
  validationReadBytesUsed(): number {
    return this.validationBytesRead;
  }

  /**
   * `null` when the mutation-validation budget can still cover BOTH internal reads of a
   * target this size (the first read and the final time-of-check/time-of-use re-read);
   * otherwise the denial. Reserving both up front makes the bound fail closed before any
   * byte is read, and the counter is then charged as the reads actually happen.
   */
  private validationReservationDenial(targetSize: number): OrnithToolResult | null {
    const needed = targetSize * 2;
    const remaining = ORNITH_LIMITS.maxCumulativeMutationValidationBytes - this.validationBytesRead;
    if (needed <= remaining) return null;
    return denied(
      'limit_mutation_validation_bytes_exceeded',
      `Validating this change needs ${needed} internal bytes but only ${Math.max(0, remaining)} of the ` +
        `${ORNITH_LIMITS.maxCumulativeMutationValidationBytes}-byte mutation-validation budget remain. ` +
        'Nothing was read for the model and nothing was written.'
    );
  }

  /**
   * The final re-read of a mutation target, immediately before the native mutation guard.
   * On the validation budget it is bounded by the size of the first read and charged
   * before it runs — a re-read that fails still read the file. A file that no longer fits
   * that size has changed since it was validated, which is a stale target, not a budget.
   */
  private async finalValidationRead(
    absolutePath: string,
    firstReadBytes: number,
    onValidationBudget: boolean,
    budget: OrnithOperationBudget,
    signal: AbortSignal
  ): Promise<{ ok: true; raw: Buffer } | { ok: false; code: OrnithDenialCode; reason: string }> {
    if (!onValidationBudget) {
      return this.readRegularFileSafely(absolutePath, budget.readBytes - firstReadBytes, signal);
    }
    this.validationBytesRead += firstReadBytes;
    const read = await this.readRegularFileSafely(absolutePath, firstReadBytes, signal);
    if (!read.ok && read.code === 'limit_read_bytes_exceeded') {
      return { ok: false, code: 'stale_hash', reason: 'The file changed size before the change was applied.' };
    }
    return read;
  }

  /** Charges each chunk of an internal validation read as it arrives; discovery-pool reads charge nothing here. */
  private validationCharge(onValidationBudget: boolean): ((countedBytes: number) => void) | undefined {
    if (!onValidationBudget) return undefined;
    return (countedBytes) => {
      this.validationBytesRead += countedBytes;
    };
  }

  private recordShownHash(relativePath: string, sha256: string): void {
    const known = this.shownHashes.get(relativePath);
    if (known === undefined) this.shownHashes.set(relativePath, new Set([sha256]));
    else known.add(sha256);
  }

  private wasShownHash(relativePath: string, sha256: string): boolean {
    return this.shownHashes.get(relativePath)?.has(sha256) ?? false;
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

  /**
   * How many files the worktree holds changed against HEAD right now, WHOEVER changed them — not only
   * this run's own edits, which is all {@link changedFileCount} knows. A later attempt that changes
   * nothing must not make earlier, preserved and still-unverified edits look like they are gone.
   *
   * Internal: one bounded, fixed, read-only Git call with stderr discarded. Never shown to the model
   * and not charged to either byte budget. `null` when it cannot be established (never a guess).
   */
  async workingTreeChangedFileCount(signal?: AbortSignal): Promise<number | null> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      const status = await this.gitCapture(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        bounded,
        undefined,
        GIT_DEFAULT_OUTPUT_BYTES,
        true
      );
      if (status.exitCode !== 0 || status.failed) return null;
      return status.stdout.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      return null;
    } finally {
      dispose();
    }
  }

  /**
   * A fingerprint of what the worktree holds relative to HEAD: the tracked diff plus the content of every
   * untracked file. Two calls return the same value exactly when the files are the same — so a verification
   * that already ran on this state is recognisable even if the model "changed" something and changed it
   * back (a bookkeeping counter of successful writes could not tell). `null` when it cannot be taken
   * (Git failed, an untracked file was unreadable or unsafe, or there are too many); the caller then
   * treats the state as new rather than refusing on a guess.
   *
   * Internal and bounded like {@link workingTreeChangedFileCount}. `--no-ext-diff --no-textconv` keep a
   * configured diff helper from running.
   */
  async worktreeFingerprint(signal?: AbortSignal): Promise<string | null> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.gitTimeoutMs, signal);
    try {
      const diff = await this.gitCapture(
        ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary', '--'],
        bounded,
        undefined,
        GIT_DEFAULT_OUTPUT_BYTES,
        true
      );
      if (diff.exitCode !== 0 || diff.failed) return null;
      const untracked = await this.gitCapture(
        ['ls-files', '--others', '--exclude-standard', '-z', '--'],
        bounded,
        undefined,
        GIT_DEFAULT_OUTPUT_BYTES,
        true
      );
      if (untracked.exitCode !== 0 || untracked.failed) return null;
      const names = untracked.stdout.split('\0').filter(Boolean).sort();
      if (names.length > FINGERPRINT_MAX_UNTRACKED_FILES) return null;
      const hash = createHash('sha256');
      hash.update(diff.stdout);
      hash.update('\0');
      let hashedBytes = 0;
      for (const name of names) {
        const resolved = await this.resolvePathOnly(name, { mustExist: true, forWrite: false });
        if (!resolved.ok) return null;
        const read = await this.readRegularFileSafely(resolved.absolutePath, ORNITH_LIMITS.maxFileBytes, bounded);
        if (!read.ok) return null;
        // The preflight cost is bounded by bytes as well as by count: past it the state is "unknown"
        // (verification proceeds) rather than the wait before the command spending the user's budget.
        hashedBytes += read.raw.byteLength;
        if (hashedBytes > FINGERPRINT_MAX_TOTAL_BYTES) return null;
        hash.update(name);
        hash.update('\0');
        hash.update(createHash('sha256').update(read.raw).digest('hex'));
        hash.update('\n');
      }
      return hash.digest('hex');
    } catch {
      return null;
    } finally {
      dispose();
    }
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

  /**
   * A stateful, per-call cadence for re-confirming checkout identity across a
   * multi-candidate scan (`searchText`, `gitDiff`'s untracked-file pass)
   * without paying `assertCheckoutIdentity`'s `git` subprocess cost on every
   * single candidate. The returned function resolves `true` immediately for
   * every call except every `ORNITH_LIMITS.searchIdentityRecheckFiles`th,
   * where it performs the real check; a caller must treat a `false` result
   * exactly like a failed `assertCheckoutIdentity` call (deny and stop
   * scanning at once — do not continue past it).
   */
  private identityRecheckCadence(signal: AbortSignal): () => Promise<boolean> {
    let sinceLastCheck = 0;
    return async (): Promise<boolean> => {
      if (sinceLastCheck < ORNITH_LIMITS.searchIdentityRecheckFiles) {
        sinceLastCheck += 1;
        return true;
      }
      sinceLastCheck = 0;
      await this.deps.testHooks?.beforeIdentityRecheck?.();
      return this.assertCheckoutIdentity(signal);
    };
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

  /**
   * Resolve and cache `authoritativeScope` against the real manifest, building
   * the manifest if needed. Read-only, never mutates. Intended to be called
   * once, eagerly, before the first prompt is built, so a scoped run's very
   * first turn can already name the confirmed file(s) instead of discovering
   * them lazily on first tool dispatch.
   *
   * Retries `ensureManifest()` up to twice before giving up: a review round
   * found that freezing the decision after a single failure could permanently
   * lose the scope hint for the rest of the run over a one-off transient
   * hiccup (e.g. a momentary git-spawn delay under load), reproducing the
   * unscoped-discovery cost this feature exists to avoid for the ENTIRE run
   * rather than just this one check. Two attempts bounds that cost: a
   * genuinely broken worktree fails both quickly and is then independently
   * re-detected by the loop's own per-iteration `assertCheckoutIdentity`
   * regardless, so nothing is masked either way — only a truly transient
   * failure benefits from the second try. Whatever the outcome, this remains
   * the one and only authoritative decision for this run instance: the scope
   * is computed here and nowhere else (it is not part of the manifest's own
   * lifecycle), and every later call returns the same answer that was
   * already reported to the model.
   */
  async resolveAuthoritativeScope(signal?: AbortSignal): Promise<readonly string[] | null> {
    if (this.authoritativeScopeDecided) return this.authoritativeScope;
    const maxAttempts = 2;
    let manifestBuilt = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // An aborted signal (task cancelled, or the caller's whole-loop deadline
      // reached) is not a transient failure: retrying it only spends more time.
      if (signal?.aborted) break;
      try {
        await this.ensureManifest(signal);
        manifestBuilt = true;
        break;
      } catch {
        // Fall through to the next attempt (if any).
      }
    }
    if (manifestBuilt) {
      const candidates = this.deps.scopedFilePathCandidates ?? [];
      const confirmed = [...new Set(candidates)].filter((path) => this.knownFiles.has(path));
      this.authoritativeScope = confirmed.length > 0 ? confirmed : null;
    }
    this.authoritativeScopeDecided = true;
    return this.authoritativeScope;
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
   *
   * Re-confirms checkout identity itself, so any single-file caller
   * (`readFile`, `createFile`, `replaceText`, `deleteFile`) gets it for
   * free. A caller that resolves many candidates in one action (`searchText`,
   * `gitDiff`'s untracked-file pass) should call {@link assertCheckoutIdentity}
   * on its own bounded cadence and use {@link resolvePathOnly} for the
   * per-candidate work instead — see the comment on `searchText` for why a
   * per-file call here does not scale.
   */
  private async resolveSafe(
    relativePath: string,
    options: { mustExist: boolean; forWrite: boolean },
    signal?: AbortSignal
  ): Promise<{ ok: true; absolutePath: string } | { ok: false; code: OrnithDenialCode; reason: string }> {
    if (touchesDotGit(relativePath)) {
      return { ok: false, code: 'invalid_path', reason: 'The .git directory may not be accessed.' };
    }
    if (!(await this.assertCheckoutIdentity(signal))) {
      return { ok: false, code: 'checkout_identity_changed', reason: 'The checkout identity changed.' };
    }
    return this.resolvePathOnly(relativePath, options);
  }

  /**
   * The path-safety half of {@link resolveSafe}, without the checkout-identity
   * re-check: every existing ancestor's symlink/reparse/containment check,
   * the final component's regular-file/symlink/hard-link check. Callers that
   * already confirmed checkout identity once for the whole action (on their
   * own bounded cadence — never skipped entirely) use this per candidate
   * instead of paying a fresh `assertCheckoutIdentity` (and its `git`
   * subprocess spawns) for every single file.
   */
  private async resolvePathOnly(
    relativePath: string,
    options: { mustExist: boolean; forWrite: boolean }
  ): Promise<{ ok: true; absolutePath: string } | { ok: false; code: OrnithDenialCode; reason: string }> {
    if (touchesDotGit(relativePath)) {
      return { ok: false, code: 'invalid_path', reason: 'The .git directory may not be accessed.' };
    }
    const absolutePath = this.absolutePathFor(relativePath);

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
      // Bounded by the same limit the size check above used: a file that grew after
      // that check is reported instead of being buffered whole.
      const raw = await readAtMost(handle, maxBytes, signal);
      if (raw.byteLength > maxBytes) {
        return { ok: false, code: 'limit_read_bytes_exceeded', reason: 'The file grew past the allowed read size while it was being read.' };
      }
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

      // Track the "files" array's own content size incrementally (each entry's quoted,
      // escaped JSON length plus its separating comma) instead of re-stringifying the
      // whole growing array on every candidate — the latter is O(n) work per iteration
      // (O(n^2) overall) for what is otherwise a single linear pass.
      const page: string[] = [];
      let filesArrayContentBytes = 0;
      let index = cursor;
      while (page.length < action.limit && index < matching.length) {
        const candidateNextCursor = index + 1 < matching.length ? index + 1 : null;
        const skeletonBytes = Buffer.byteLength(
          JSON.stringify({ files: [], nextCursor: candidateNextCursor, total: matching.length }),
          'utf8'
        );
        const entryBytes = Buffer.byteLength(JSON.stringify(matching[index]), 'utf8') + (page.length > 0 ? 1 : 0);
        const candidateBytes = skeletonBytes + filesArrayContentBytes + entryBytes;
        if (candidateBytes > maxResultBytes) break;
        page.push(matching[index]!);
        filesArrayContentBytes += entryBytes;
        index += 1;
      }

      if (page.length === 0 && index < matching.length) {
        // Not even the single next entry fits the remaining byte budget — an
        // unusually long path. Two designs were tried and rejected before this one:
        //
        // 1. Leave `nextCursor` at `cursor` and return ok:true — the model resubmits
        //    an identical request forever; the no-progress guard stops the run on an
        //    entry that was never actually unreachable, just unlistable by name.
        // 2. Skip past it (advance `nextCursor`, return ok:true with an empty page) —
        //    this DOES let enumeration keep moving, but has two independent problems.
        //    First, it silently omits one legal, existing path from the only tool that
        //    can name it: a model relying on list_files to discover what exists can
        //    finish "successfully" having never seen a file its task depended on —
        //    exactly the false-positive-completion risk `ok:true` is supposed to rule
        //    out. Second, even the SKIP NOTICE ITSELF is not exempt from this budget:
        //    a fixed, human-readable explanation of what happened does not fit inside
        //    the ~256-byte floor `preflightOrnithPrompt` can legitimately produce,
        //    so the message meant to explain the loss would itself get discarded by
        //    the caller's own generic byte-budget truncation — reintroducing the
        //    exact metadata-loss failure this whole fix exists to close, just for a
        //    rarer trigger.
        //
        // Fail closed instead: this one action is denied, ending the run honestly
        // (the caller's `!toolResult.ok` branch already treats every denial this way)
        // rather than letting it complete having silently skipped part of the
        // repository, or letting the explanation of that skip itself be silently lost.
        return denied(
          'limit_result_exceeded',
          `The file at manifest position ${index} of ${matching.length} under prefix "${prefix}" cannot be ` +
            'represented within the remaining tool-result byte budget for this run (its path is unusually long). ' +
            'Repository enumeration cannot honestly continue past this point at the current budget.'
        );
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

  /**
   * Charges the WHOLE file's size against the read budget even when `action`
   * only requests a small offset/limit slice, and even on a repeat read of a
   * path already read this run. This is intentional, not an oversight: the
   * whole file must be opened, read once, decoded, hashed (the returned
   * `sha256` is over the complete content) and scanned for credential-shaped
   * text before any slice of it can be safely returned, and the post-read
   * identity re-verification below only makes sense against that same
   * complete read. A per-run cache to avoid re-paying this on a later slice
   * of an unchanged file was considered and rejected: this run's cumulative
   * budget is meant to mean exactly "bytes actually read this run", and an
   * existing, deliberately-designed test exercises the cumulative cap via
   * repeated full-price reads of one large file at different offsets.
   *
   * `maxResultBytes` bounds the SERIALIZED result the same way `listFiles`'s and
   * `searchText`'s do: the slice is packed against the exact serialized size
   * (JSON escaping of quotes, backslashes and newlines can make a slice of
   * N raw bytes serialize to well over N), so the result — including
   * `totalBytes` and `nextOffset` — fits by construction instead of being
   * replaced afterward by the generic "exceeded this runtime context budget"
   * stub, which carries no content, no `sha256` and no way to continue. That
   * defect made a weak model that asked for a large chunk receive nothing and
   * fall back to paging through the file in tiny consecutive reads. Packing
   * changes only how much of the already fully-read, fully-hashed,
   * fully-scanned file is RETURNED; the byte charge above is unchanged.
   */
  async readFile(
    action: Extract<OrnithAction, { action: 'read_file' }>,
    signal?: AbortSignal,
    budget = DEFAULT_OPERATION_BUDGET,
    maxResultBytes = Number.POSITIVE_INFINITY
  ): Promise<OrnithToolResult> {
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
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const totalBytes = raw.byteLength;
        // Derived from the complete bytes already read and hashed above, never from
        // the returned slice: a window that happens to hold no line break must not
        // report "none" for a CRLF file.
        const lineEnding = classifyLineEnding(raw);
        const packed = packReadSlice(
          raw,
          action.offset,
          action.limit,
          (slice) => {
            const end = slice.offset + slice.bytesRead;
            return {
              path: action.path,
              offset: slice.offset,
              bytesRead: slice.bytesRead,
              totalBytes,
              lineEnding,
              // The offset a following chunk starts at; `null` once the end of
              // the file has been returned, so "is there more" never has to be
              // inferred from `eof` alone.
              nextOffset: end >= totalBytes ? null : end,
              eof: end >= totalBytes,
              content: slice.text,
              sha256
            };
          },
          maxResultBytes
        );
        if (packed === null) {
          return denied(
            'limit_result_exceeded',
            `Even an empty read_file result for this path needs more than the ${maxResultBytes} bytes that remain for ` +
              'this tool result. No part of the file can be reported within the current budget.'
          );
        }

        // The model now holds this hash; an edit that cites it is an authorised one.
        this.recordShownHash(action.path, sha256);
        return {
          ok: true,
          forModel: packed,
          readBytes: raw.byteLength,
          writeBytes: 0,
          auditSummary:
            `read_file path="${action.path}" offset=${packed.offset} bytes=${packed.bytesRead} ` +
            `of ${totalBytes} sha256=${sha256}`
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

  /**
   * `maxResultBytes` bounds the serialized `{matches, truncated}` payload the same way
   * `listFiles`'s does: matches are packed incrementally against the EXACT serialized
   * size, so the result fits by construction rather than being truncated away afterward
   * by the generic byte-budget check — the same defect class `listFiles` had. Unlike
   * `listFiles`, `search_text` has no cursor and was never a full-enumeration contract:
   * `truncated` already means "there may be more, narrow your query and retry", so
   * packing fewer matches than exist and marking `truncated: true` is honest within
   * that existing contract, not a new kind of data loss.
   *
   * A single candidate match that cannot fit is SKIPPED, not treated as a reason to
   * stop the whole search (review found that stopping at the first oversized candidate
   * made this a dead end: no cursor exists to skip past it, so a model retrying the
   * identical query got the identical empty result forever). Skipping one candidate
   * still leaves room for smaller ones later, so scanning continues. Two cases fail
   * closed with `limit_result_exceeded` instead of returning `ok:true`, because no
   * `ok:true` shape can honestly represent them: the empty-result skeleton itself not
   * fitting `maxResultBytes` at all, and every real match found being individually too
   * large to fit — the latter would otherwise be the exact dead end just described,
   * silently disguised as a normal "nothing matched" result.
   */
  async searchText(
    action: Extract<OrnithAction, { action: 'search_text' }>,
    signal?: AbortSignal,
    budget = DEFAULT_OPERATION_BUDGET,
    maxResultBytes = Number.POSITIVE_INFINITY
  ): Promise<OrnithToolResult> {
    const { signal: bounded, dispose } = timeoutSignal(ORNITH_LIMITS.searchTimeoutMs, signal);
    try {
      // Nothing left to spend: no non-empty candidate can fit, so this is the one
      // case that can be decided exactly - and therefore must fail BEFORE any
      // manifest, identity or per-file work, not after walking every candidate.
      // (With a small but non-zero remainder a later, smaller file may still fit,
      // which cannot be known without looking at sizes, so that case scans.)
      if (budget.readBytes <= 0) {
        return denied(
          'limit_read_bytes_exceeded',
          'No repository read budget remains for this run; search_text made no progress.'
        );
      }
      const manifest = await this.ensureManifest(bounded);
      // Deliberately NOT narrowed to `authoritativeScope`: a Coai review round
      // found that silently limiting an omitted search to the specification's
      // declared scope can permanently hide a real match in a file the scope
      // claim did not name, whenever the scope files themselves also contain
      // an incidental match for the query (so a "found something" result
      // looks complete when it is not) — a specification's scope is a
      // discovery hint, never a proof of completeness, and `search_text` has
      // no way to safely tell the difference between "nothing else matches"
      // and "the declared scope wasn't the whole story". Scoped discovery is
      // instead achieved at the prompt level (the SCOPE section in
      // `ornith-implementation.ts` tells the model it can `read_file` the
      // named path directly, without needing to search for it at all).
      const candidates = action.files ?? manifest;
      for (const path of candidates) {
        if (!this.knownFiles.has(path)) {
          return denied('file_not_found', `"${path}" is not part of the task manifest.`);
        }
      }

      // A broad search scans up to the whole manifest. `resolveSafe` re-confirms
      // checkout identity (several `git` subprocess spawns) on every call, which
      // is the right cost for a single-file action but is what actually exhausted
      // `searchTimeoutMs` here: one spawn-heavy check per candidate turned a
      // few-hundred-file repository into hundreds of `git` invocations inside one
      // timeout window. `ensureManifest` already checked identity once to build
      // the manifest (or used the cached one); this checks it once more up front
      // for a fresh call against a cached manifest, then only on a bounded
      // cadence thereafter (`identityRecheckCadence`) — enough to still catch a
      // worktree swapped out from underneath a long-running scan within one
      // interval's worth of files, without paying the per-file cost.
      if (!(await this.assertCheckoutIdentity(bounded))) {
        return denied('checkout_identity_changed', 'The checkout identity changed.');
      }
      const stillCurrent = this.identityRecheckCadence(bounded);

      // Hoisted once: invariant for the whole call, not per candidate line.
      const skeletonBytes = Buffer.byteLength(JSON.stringify({ matches: [], truncated: true }), 'utf8');
      if (skeletonBytes > maxResultBytes) {
        return denied(
          'limit_result_exceeded',
          `An empty search_text result ("matches":[]) needs ${skeletonBytes} bytes, but only ${maxResultBytes} ` +
            'bytes remain for this tool result. No search can be reported within the current budget.'
        );
      }

      const needle = action.caseSensitive ? action.query : action.query.toLowerCase();
      const matches: { path: string; line: number }[] = [];
      let matchesArrayContentBytes = 0;
      let anySkippedDueToBudget = false;
      let firstSkipped: { path: string; line: number; requiredBytes: number } | null = null;
      let readBytesTotal = 0;
      /** Set when at least one candidate's own size exceeded the remaining
       *  cumulative read budget and was skipped without being opened. Does
       *  NOT stop the scan — a later, smaller candidate may still fit — so
       *  this only affects `truncated` and the zero-progress check below. */
      let anySkippedDueToReadBudget = false;
      /** A candidate was NOT searched (unresolvable, too large, unreadable or binary, or over budget): the scan
       *  is incomplete, so "no matches" is not proof that the named files do not contain the text. */
      let anyCandidateNotSearched = false;

      for (const path of candidates) {
        if (matches.length >= action.limit) break;
        // The budget is spent exactly: no further non-empty candidate can fit, so
        // stop instead of probing every remaining file just to skip each one. A
        // candidate is still pending here, so the result is honestly truncated.
        if (readBytesTotal >= budget.readBytes) {
          anySkippedDueToReadBudget = true;
          break;
        }
        // Cheap, synchronous: several of this loop's own calls (`lstat`,
        // `resolvePathOnly`) take no signal, so without this the loop would
        // keep doing real filesystem work for the rest of a large candidate
        // list after the timeout already fired, only stopping once an
        // abort-aware read eventually throws.
        if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
        if (!(await stillCurrent())) {
          return denied('checkout_identity_changed', 'The checkout identity changed.');
        }
        const resolved = await this.resolvePathOnly(path, { mustExist: true, forWrite: false });
        if (!resolved.ok) {
          anyCandidateNotSearched = true;
          continue;
        }
        let content: string;
        try {
          const stats = await lstat(resolved.absolutePath);
          if (stats.size > ORNITH_LIMITS.maxReadBytes) {
            anyCandidateNotSearched = true;
            continue;
          }
          if (readBytesTotal + stats.size > budget.readBytes) {
            // This exact candidate is never opened or read — every byte
            // charged below still comes from a fully, successfully read
            // candidate. A later, SMALLER candidate may still fit the
            // remaining budget, so this skips just this one file rather than
            // stopping the whole scan (a large file early in manifest order
            // must not block smaller ones later in it).
            anySkippedDueToReadBudget = true;
            continue;
          }
          const safeRead = await this.readRegularFileSafely(
            resolved.absolutePath,
            Math.min(ORNITH_LIMITS.maxReadBytes, budget.readBytes - readBytesTotal),
            bounded
          );
          if (!safeRead.ok) {
            if (safeRead.code === 'limit_read_bytes_exceeded' && stats.size > ORNITH_LIMITS.maxReadBytes) {
              anyCandidateNotSearched = true;
              continue;
            }
            return denied(safeRead.code, safeRead.reason);
          }
          const raw = safeRead.raw;
          readBytesTotal += raw.byteLength;
          content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
          anyCandidateNotSearched = true;
          continue; // binary or unreadable: silently skipped, matching a literal-text search's scope
        }
        const haystack = action.caseSensitive ? content : content.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && matches.length < action.limit; index += 1) {
          // Named distinctly from `candidate.line` below (a line NUMBER, index+1):
          // this is the line's TEXT, used only for the needle check on this line and
          // never itself serialized — the two "line"s sharing a name previously read
          // as if a matched line's text became part of the returned entry, when it
          // never does.
          const lineText = action.caseSensitive ? lines[index] : lines[index]?.toLowerCase();
          if (lineText === undefined || !lineText.includes(needle)) continue;
          const candidate = { path, line: index + 1 };
          // Exact per-candidate size: path content varies, so unlike the skeleton this
          // cannot be hoisted, but it is computed only once per real candidate match,
          // not per budget check.
          const entryBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (matches.length > 0 ? 1 : 0);
          if (skeletonBytes + matchesArrayContentBytes + entryBytes > maxResultBytes) {
            anySkippedDueToBudget = true;
            firstSkipped ??= { path, line: index + 1, requiredBytes: skeletonBytes + entryBytes };
            // Not `continue`: `path` is fixed for the rest of this file and line
            // numbers only increase, so every later line's entry in THIS file is at
            // least as large as this one's — none of them could fit either. Move on
            // to the next candidate file instead of checking each remaining line.
            break;
          }
          matches.push(candidate);
          matchesArrayContentBytes += entryBytes;
        }
      }

      if (matches.length === 0 && anySkippedDueToBudget) {
        // firstSkipped.requiredBytes is skeletonBytes + this one entry, with no
        // earlier accepted matches folded in (matches.length === 0 here is exactly
        // why we reached this branch) — "alone" is accurate, not an approximation.
        //
        // Deliberately NOT suggesting "search fewer files": an entry's size is
        // determined by its own repository-relative path length (plus the fixed
        // skeleton and this file's line number), not by how many candidates were
        // examined — reducing the candidate COUNT without excluding the specific
        // long-path file would reproduce the identical failure.
        return denied(
          'limit_result_exceeded',
          `search_text found at least one match, but no single {path,line} entry it found fits within the ` +
            `${maxResultBytes}-byte tool-result budget — for example, ${JSON.stringify(firstSkipped!.path)} line ` +
            `${firstSkipped!.line} alone would need ${firstSkipped!.requiredBytes} bytes. This is not a matter of ` +
            'searching fewer files: reduce it by choosing a candidate with a shorter repository-relative path if ' +
            'one is known, or retry once more tool-result budget is available.'
        );
      }

      // Zero progress (nothing read, nothing found) despite at least one
      // candidate being skipped for exceeding the remaining read budget: an
      // honest, explicit denial — this is a real "this request cannot
      // proceed" fact, eligible for the caller's bounded one-shot read-budget
      // recovery. `readBytesTotal === 0` is sufficient to detect this: a
      // match can only be recorded after a successful read, which always
      // adds to `readBytesTotal` first — so if it is still 0, every examined
      // candidate was either skipped for budget or otherwise unreadable, and
      // nothing was genuinely searched.
      if (anySkippedDueToReadBudget && readBytesTotal === 0) {
        return denied(
          'limit_read_bytes_exceeded',
          `No candidate file could be read within the remaining repository read budget (${budget.readBytes} ` +
            'byte(s)); search_text made no progress.'
        );
      }

      return {
        ok: true,
        forModel: { matches, truncated: matches.length >= action.limit || anySkippedDueToBudget || anySkippedDueToReadBudget },
        readBytes: readBytesTotal,
        writeBytes: 0,
        // Only the number, so the loop can tell "the named files do not contain this" from "they do" —
        // and only when every candidate was actually searched: a scan cut short proves nothing.
        ...(anyCandidateNotSearched || anySkippedDueToReadBudget ? {} : { matchCount: matches.length }),
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
      this.recordShownHash(action.path, sha256);

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
      const targetSize = Number(beforeStats.size);
      // Per-target size bound on what Relay will read to validate one edit. Not a budget: it is
      // checked before anything is read, the same for every pool, so an edit never buffers a
      // larger file — and it has its own code, so a size refusal is never reported as a budget
      // that ran out.
      if (targetSize > ORNITH_LIMITS.maxFileBytes) {
        return denied(
          'limit_mutation_target_bytes_exceeded',
          `The file is larger than the ${ORNITH_LIMITS.maxFileBytes} bytes one change may validate. Nothing was read for the model and nothing was written.`
        );
      }
      const onValidationBudget = this.wasShownHash(action.path, action.sha256);
      if (onValidationBudget) {
        const denial = this.validationReservationDenial(targetSize);
        if (denial !== null) return denial;
      } else if (beforeStats.size > budget.readBytes) {
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
        // Bounded for every pool: never buffers more than one byte past the size that was
        // checked above. On the validation pool the bytes are charged as each chunk arrives.
        raw = await readAtMost(handle, targetSize, bounded, this.validationCharge(onValidationBudget));
        if (raw.byteLength > targetSize) {
          return denied('stale_hash', 'The file grew while the edit was being validated.');
        }
      } finally {
        await handle.close();
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
        if (occurrences === 0 && containsLiteralLineBreakEscape(replacement.oldText)) {
          // Diagnostic only: nothing is decoded, rewritten or applied. `raw` is the
          // hash-verified current content, so the style is the file's real one. The
          // reason names the style and the mistake, never file content or oldText.
          const lineEnding = classifyLineEnding(raw);
          if (lineEnding === 'lf' || lineEnding === 'crlf') {
            return denied(
              'replacement_escape_suspected',
              `oldText matched nothing and contains a backslash followed by "n" or "r", while this file uses ` +
                `${lineEnding.toUpperCase()} line endings. Probable JSON escaping mistake: a single-backslash JSON ` +
                'escape decodes to a real line break, but a doubled backslash decodes to a literal backslash plus a ' +
                'letter that cannot match a line break. Nothing was written or converted.'
            );
          }
        }
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
      const finalRead = await this.finalValidationRead(rechecked.absolutePath, raw.byteLength, onValidationBudget, budget, bounded);
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
      this.recordShownHash(action.path, newSha256);

      return {
        ok: true,
        forModel: { path: action.path, sha256: newSha256, bytesWritten: nextBytes },
        // Two internal reads of the target (first read, final re-read), on whichever pool paid for them.
        readBytes: onValidationBudget ? 0 : raw.byteLength * 2,
        validationReadBytes: onValidationBudget ? raw.byteLength * 2 : 0,
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
      const targetSize = Number(beforeStats.size);
      // The same per-target size bound as an edit, checked before anything is read: a delete is
      // a mutation too. (Under the old single budget only a ~1.3 MiB band above this bound was
      // even deletable — read plus two validation reads had to fit in 4 MiB.)
      if (targetSize > ORNITH_LIMITS.maxFileBytes) {
        return denied(
          'limit_mutation_target_bytes_exceeded',
          `The file is larger than the ${ORNITH_LIMITS.maxFileBytes} bytes one change may validate. Nothing was read for the model and nothing was deleted.`
        );
      }
      const onValidationBudget = this.wasShownHash(action.path, action.sha256);
      if (onValidationBudget) {
        const denial = this.validationReservationDenial(targetSize);
        if (denial !== null) return denial;
      } else if (beforeStats.size > budget.readBytes) {
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
        raw = await readAtMost(handle, targetSize, bounded, this.validationCharge(onValidationBudget));
        if (raw.byteLength > targetSize) {
          return denied('stale_hash', 'The file grew while the deletion was being validated.');
        }
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
        const finalRead = await this.finalValidationRead(rechecked.absolutePath, raw.byteLength, onValidationBudget, budget, bounded);
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
      this.shownHashes.delete(action.path);
      this.changedFiles.add(action.path);

      return {
        ok: true,
        forModel: { path: action.path, deleted: true },
        readBytes: onValidationBudget ? 0 : raw.byteLength * 2,
        validationReadBytes: onValidationBudget ? raw.byteLength * 2 : 0,
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
      // stdout is capped at `remaining + 1`, so a diff of exactly the remaining bytes still fits and
      // one byte more does not. Git's stderr is discarded: this tool never reads it, and it is the one
      // stream that could otherwise share the cap — so warnings (a Windows checkout prints one per
      // file whose line endings would change) cannot make a diff that fits look oversized, however
      // many there are, and a hit cap can only mean stdout.
      const remaining = Math.max(0, budget.readBytes);
      const stdoutCap = Math.min(GIT_DEFAULT_OUTPUT_BYTES, remaining + 1);
      const tracked = await this.gitCapture(args, bounded, undefined, stdoutCap, true);
      if (tracked.exitCode !== 0 || tracked.failed) {
        // Git was stopped because stdout reached the cap: at least `remaining + 1` characters, hence
        // at least that many bytes, so the diff does not fit the discovery budget. The cap being hit is
        // the evidence — never the length of what was kept, which the runner may have trimmed by a
        // newline. Nothing that was kept is returned. Anything else — a non-zero exit, a spawn
        // failure, a failure with no cap involved — is a genuine failure and stays one.
        if (tracked.outputLimitExceeded === true && stdoutCap === remaining + 1) {
          return denied('limit_read_bytes_exceeded', GIT_DIFF_BUDGET_REASON);
        }
        return denied('internal_error', 'git diff could not be read.');
      }
      const trackedDiff = tracked.stdout;
      let bytesConsumed = Buffer.byteLength(trackedDiff, 'utf8');
      if (bytesConsumed > budget.readBytes) {
        return denied('limit_read_bytes_exceeded', GIT_DIFF_BUDGET_REASON);
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
      const stillCurrent = this.identityRecheckCadence(bounded);
      for (const path of untrackedRaw.split(String.fromCharCode(0)).filter(Boolean)) {
        if (bounded.aborted) return denied('timeout', 'The repository operation timed out.');
        if (!(await stillCurrent())) {
          return denied('checkout_identity_changed', 'The checkout identity changed.');
        }
        const resolved = await this.resolvePathOnly(path, { mustExist: true, forWrite: false });
        if (!resolved.ok) return denied(resolved.code, resolved.reason);
        const stats = await lstat(resolved.absolutePath);
        if (bytesConsumed + stats.size > budget.readBytes) {
          return denied('limit_read_bytes_exceeded', GIT_DIFF_BUDGET_REASON);
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
  private async git(args: readonly string[], signal: AbortSignal, cwd?: string, maxOutputBytes = GIT_DEFAULT_OUTPUT_BYTES): Promise<string | null> {
    const result = await this.gitCapture(args, signal, cwd, maxOutputBytes);
    if (result.exitCode !== 0 || result.failed) return null;
    return result.stdout;
  }

  /**
   * Run one fixed read-only Git argv and return the WHOLE process result, so a caller that set
   * `maxOutputBytes` on purpose can tell an output overflow from a genuine failure. Cancellation
   * and timeout still throw exactly as {@link git} always has.
   */
  private async gitCapture(
    args: readonly string[],
    signal: AbortSignal,
    cwd?: string,
    maxOutputBytes = GIT_DEFAULT_OUTPUT_BYTES,
    discardStderr = false
  ): Promise<ProcessResult> {
    const result = await this.deps.runner.run(this.resolveGit(), args, {
      cwd: cwd ?? this.deps.worktreePath,
      signal,
      timeoutMs: ORNITH_LIMITS.gitTimeoutMs,
      maxOutputBytes,
      ...(discardStderr ? { discardStderr: true } : {}),
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
    return result;
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

/**
 * Return the largest UTF-8-safe slice of `raw` whose SERIALIZED result (as built
 * by `build`) is at most `maxResultBytes`, or `null` when not even an empty
 * slice fits. A binary search over the byte limit is enough: serialized size
 * grows with the limit apart from a few bytes of noise (`eof`'s `true` versus
 * `false`, `nextOffset`'s `null` versus a number), and the search only ever
 * returns a candidate it has actually measured as fitting, so the guarantee
 * is exact even where that noise makes the answer one or two bytes short of
 * the true maximum.
 */
function packReadSlice<T>(
  raw: Buffer,
  requestedOffset: number,
  requestedLimit: number,
  build: (slice: { offset: number; bytesRead: number; text: string }) => T,
  maxResultBytes: number
): T | null {
  const measure = (value: T): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const whole = build(safeUtf8Slice(raw, requestedOffset, requestedLimit));
  if (measure(whole) <= maxResultBytes) return whole;

  let best: T = build(safeUtf8Slice(raw, requestedOffset, 0));
  if (measure(best) > maxResultBytes) return null;
  let low = 1;
  // JSON escaping can only ever INFLATE a slice, so a slice of more than
  // `maxResultBytes` raw bytes can never serialize to within it: nothing above
  // that is worth measuring.
  let high = Math.min(requestedLimit - 1, maxResultBytes);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(safeUtf8Slice(raw, requestedOffset, mid));
    if (measure(candidate) <= maxResultBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
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
