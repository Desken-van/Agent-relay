/**
 * The code-review lifecycle: immutable subject, durable rounds, living findings.
 *
 * INT-D-A backend foundation. There is no renderer, no correction loop and no
 * live provider acceptance here — only the evidence layer those will stand on.
 *
 * ## The one idea everything else follows from
 *
 * A code review is a statement about a specific state of the code. If that
 * state can change without the statement changing with it, the review becomes a
 * claim about nothing in particular — and the longer it survives, the more
 * confidently it will be cited. So the subject is captured once, hashed, and
 * never edited; every round records the hash it was computed against; every
 * finding is scoped to that hash; and every decision names both the finding and
 * the snapshot it answered. Staleness is then not a flag anyone has to
 * remember to set. It is the observable difference between two hashes.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  canonicalCodeSnapshot,
  codeFindingFingerprintInput,
  codeReviewSnapshotSchema,
  codeReviewTriageFindingsSnapshot,
  CODE_REVIEW_UNRESOLVED_STATUSES,
  CODE_SNAPSHOT_VERSION,
  providerCodeFindingSchema,
  type CodeReviewDecisionAction,
  type CodeReviewActor,
  type CodeReviewFinding,
  type CodeReviewRound,
  type CodeReviewSnapshot,
  type CodeReviewSubject,
  type CodeReviewSubjectIdentity,
  type CodeReviewTriageResult,
  type CodeReviewVerdict,
  type CodeSnapshotEntry,
  type CodeSnapshotOmissionEntry,
  type ProviderCodeFinding
} from '../../shared/domain/code-review';
import type { Task } from '../../shared/domain/models';
import { TERMINAL_STATUSES } from '../../shared/domain/workflow';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import {
  unsafeProviderIdentity,
  unsafeProviderLocatorId,
  unsafeProviderProse,
  type UnsafeProviderTextReason
} from '../../shared/util/provider-text';
import { CodeReviewNotDispatchedError } from './code-review-provider';
import { specificationIdentity } from './specification-identity';
import {
  hashSnapshotFile,
  nodeSnapshotFileOps,
  sameFingerprint,
  type SnapshotFileOps
} from '../adapters/git/git-code-snapshot';
import type {
  AgentRunContext,
  Clock,
  CodeReviewRepository,
  CodeSnapshotLimits,
  CodeSnapshotSource,
  CodexAdapter,
  ExternalCodeReviewer,
  IdGenerator,
  ProjectRepository,
  CodeSnapshotManifest,
  CodeSnapshotManifestEntry,
  CompletedRoundResult,
  ExternalCodeReviewRound,
  ExternalCodeRoundIdentity,
  ExternalCodeRoundLocator,
  RawCodeSnapshot,
  RoundFindingRecord,
  SettingsRepository,
  TaskRepository,
  TriageableFinding
} from '../ports';
import type { FindingTriageRecommendation } from '../../shared/schemas/codex';

/**
 * Bounded by count, never by content.
 *
 * There is no byte ceiling: files are streamed, so size costs constant memory,
 * and a size-based skip once recorded only a path, a reason and a length —
 * giving two different files of equal length the same identity. What remains is
 * a file-count ceiling, and exceeding it does not silently drop anything: it
 * marks the snapshot incomplete, which blocks review outright.
 */
export const DEFAULT_CODE_SNAPSHOT_LIMITS: CodeSnapshotLimits = {
  maxFiles: 512
};

/**
 * How many times a capture may retry when the worktree moves underneath it.
 *
 * Bounded on purpose. A worktree somebody is actively editing will never hold
 * still, and retrying forever would hang the operation instead of telling them
 * the truth: that no exact statement of this code can be made right now.
 */
export const CAPTURE_ATTEMPTS = 3;

const REVIEW_IN_FLIGHT =
  'A code review round for this task has already been dispatched and its outcome is not known. Nothing here may start another: the reviewer call is not idempotent and may already have run.';

const SUBJECT_STALE =
  'The reviewed code changed while the round was running, so its result describes a state this task is no longer in. The round and its findings are kept as history and are not in force.';

const SUBJECT_INCOMPLETE =
  'The captured subject is not an exact statement of this code: at least one changed file could not be digested, or the change set was larger than the capture ceiling. Nothing may be reviewed or decided against a partial snapshot.';

const SUBJECT_UNVERIFIABLE_AFTER =
  'The reviewed code could not be read back after the round, so whether it still matches is unknown. The result is not in force.';

const SUBJECT_INCOMPLETE_AFTER =
  'The reviewed code could not be fully digested after the round, so this result cannot be confirmed against an exact subject. This is not evidence that the code changed.';

/**
 * What a failed reservation records, and the whole of what it records.
 *
 * The reviewer's own error is NOT quoted. `CoaiCodeReviewer.parse` deliberately
 * puts an MCP server's refusal sentence inside the error message, so the caller
 * that asked can be told what happened — and that sentence is foreign text,
 * which can carry an absolute path, an argv, a control character or a
 * credential. `lastError` is durable and operator-visible, so it gets this
 * instead. The original error is still THROWN, so the immediate caller keeps
 * its code and its classification; only the stored copy is fixed.
 */
const RESERVATION_FAILED =
  'The reviewer could not open a round for this subject, so nothing was dispatched and no review ran. The round is closed as failed. Why the reviewer refused is deliberately not recorded here, because a provider error is foreign text and this field is stored.';

/**
 * What a dispatch whose outcome never came back records.
 *
 * Distinct from {@link RESERVATION_FAILED} in the one way that matters: the
 * request left this process. Whether a reviewer ran is not knowable from here,
 * so the round stays unresolved rather than closed, and nothing in this message
 * may suggest that repeating it is free.
 */
const DISPATCH_UNCONFIRMED =
  'The review was dispatched and its outcome could not be confirmed. The round stays unresolved: the request left this process, so a reviewer may well have run, and no answer is not evidence that none did. What the reviewer said is deliberately not recorded here, because a provider error is foreign text and this field is stored.';

/**
 * What a round records when the reviewer went away before anything was sent.
 *
 * Distinct from {@link DISPATCH_UNCONFIRMED} because the fact is different, and
 * the difference decides what the operator may do next. This one is only ever
 * written on typed proof that no request left the process, so the round is
 * closed and a new one may be started once the integration is configured again.
 */
const DISPATCH_NOT_ATTEMPTED =
  'The round was reserved, but external code review stopped being configured before anything was sent, so no reviewer ran and nothing was dispatched. The round is closed as failed; start a new one once external code review is configured again.';

/**
 * What an answer this build cannot read records.
 *
 * Every check in `validateAnswer` throws an {@link AgentRelayError} whose
 * sentence this application authored — each names a field and a problem and
 * never a value — so those are both safe to store and worth storing. A schema
 * failure is not ours to quote, and gets this fixed sentence instead.
 */
const ANSWER_MALFORMED =
  'The reviewer answered with something this build could not read as a review, so nothing was applied. The parser detail is not recorded here.';

const ATTESTATION_MISMATCH =
  'The reviewer did not attest that it read the subject this round dispatched, so its answer was not accepted. Nothing was recorded as a confirmed result.';

const CONTRACT_DRIFTED =
  'The Coai server’s tool contract changed between reserving this round and reading its answer back, so the answer was not accepted. Start a new round once the server is confirmed stable.';

const RECONCILE_CONTRACT_DRIFTED =
  'The provider’s current tool contract differs from the one this round was reserved under, so its answer was not applied. The round stays unresolved.';

const DUPLICATE_CONFLICT =
  'The reviewer reported one finding twice with different round-specific details, so the answer contradicts itself and was not persisted.';

const SUBJECT_UNSTABLE =
  'The worktree changed while it was being read, so no exact statement of this code could be made. Nothing was reviewed against a snapshot that might describe bytes which never coexisted.';

const RECONCILE_RUNNING =
  'The provider reports that this round is still running. Nothing was repeated, and no new round may start until it ends.';

/**
 * What an unreadable round says, and it is the WHOLE of what it says.
 *
 * The reviewer's own `reason` used to be appended here, which put arbitrary
 * provider prose into a durable, operator-visible column. Redaction hides
 * credential shapes; it hides neither an absolute path nor a control character,
 * and `ExternalCodeReviewer` is an interface — so any implementation, not only
 * the audited Coai adapter, could fill this field with whatever it liked.
 *
 * The message is therefore fixed and owned by Agent Relay. What is lost is a
 * provider's description of its own failure, which was never trustworthy enough
 * to store; what is kept is the only part that governs behaviour, which is that
 * the round stays unresolved.
 */
const RECONCILE_UNKNOWN =
  'The provider could not say what became of this round. It stays unresolved: no answer is not evidence that no review ran, and starting another would risk a second non-idempotent call. What the provider said about it is deliberately not repeated here, because a provider message is foreign text that can carry a path, a command line or a credential, and this field is stored.';

const LOCATOR_INVALID =
  'The reviewer opened a round without a usable identity for it, so nothing was dispatched. A locator that is missing a part, or empty in one, names no round and could never be reconciled.';

const RECONCILE_OTHER_PROVIDER =
  'This round was dispatched to a different code reviewer than the one configured now, so its outcome cannot be read back here. It stays unresolved rather than being settled by a provider that never ran it.';

const NO_LOCATOR =
  'This round was dispatched without a recorded provider identity, so there is nothing to ask the provider about. It stays unresolved: naming the round by its subject would let another round\'s verdict land here, and no answer is not evidence that no review ran.';

const RECONCILE_WRONG_ROUND =
  'The provider answered for a different round than this one, so its result was not applied. The round stays unresolved.';

const RECONCILE_NOT_STARTED =
  'The provider proves this round never started, so nothing external was consumed and a new round may be dispatched.';

const RECONCILE_ATTESTATION =
  'The provider returned a result for a different subject than this round dispatched, so it was not applied. The round stays unresolved.';

const CHECKOUT_MISMATCH =
  'The task worktree does not match what this task records. Nothing was dispatched and nothing was written.';

const REVIEWER_CANNOT_SEE_SUBJECT =
  'This subject includes uncommitted or untracked work, and the configured reviewer reads only committed refs. It would review a different state of the code and return a verdict about it, so the round was refused rather than dispatched.';

const NO_CURRENT_SUBJECT =
  'This task has no captured code-review subject matching its current working state. Capture one before starting a round.';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Exclusive claims on the external code-review call of one task.
 *
 * Deliberately its own registry rather than the plan gate's. The two gates
 * spend different budgets against different questions, and a task legitimately
 * has a plan round and a code round at different moments in its life; making
 * them contend for one lock would create a refusal with no safety behind it.
 *
 * In-memory on purpose, for the same reason the plan gate's is: a claim means
 * "a call is in flight right now", which is only ever true of a live process.
 * What survives a restart is the round's durable status, and an unresolved
 * status already refuses a new dispatch.
 */
/** The operations that reach an external provider (Coai or Codex) and must not overlap. */
export type CodeReviewOperation = 'review' | 'reconcile' | 'triage';

export class CodeReviewClaims {
  private readonly held = new Map<string, CodeReviewOperation>();

  acquire(taskId: string, operation: CodeReviewOperation): () => void {
    const current = this.held.get(taskId);
    if (current !== undefined) {
      throw new AgentRelayError('BUSY', `A code review ${current} is already running for this task.`, {
        remediation: 'Wait for the operation in flight to finish, then read the review again.'
      });
    }
    this.held.set(taskId, operation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(taskId);
    };
  }

  isHeld(taskId: string): boolean {
    return this.held.has(taskId);
  }
}

export interface CodeReviewDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly reviews: CodeReviewRepository;
  readonly snapshots: CodeSnapshotSource;
  readonly reviewer: ExternalCodeReviewer;
  readonly claims: CodeReviewClaims;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits?: CodeSnapshotLimits;
  /**
   * The filesystem seam the digest reads through.
   *
   * Injectable for one reason: a test has to be able to change a file's bytes
   * at a chosen point DURING a capture, and no amount of real-clock racing does
   * that reliably. Production passes nothing and gets the real filesystem.
   */
  readonly fileOps?: SnapshotFileOps;
  /** For `triage()` only — a fresh, read-only, independent analysis call. Optional
   *  so existing tests that never exercise triage need not fake it. */
  readonly codex?: Pick<CodexAdapter, 'triageFindings'>;
  readonly settings?: SettingsRepository;
}

export interface CodeReviewTriageRequest {
  /** Exactly which findings to analyze. Omitted means every currently
   *  undecided, live finding for the current subject. */
  readonly findingIds?: readonly string[];
}

export interface DecideCodeFindingRequest {
  readonly findingId: string;
  readonly action: CodeReviewDecisionAction;
  readonly reason: string;
  /** The finding revision the caller was looking at. */
  readonly expectedRevision: number;
  readonly actor: CodeReviewActor;
  /** Where the decision entered the system, e.g. an IPC channel name. */
  readonly source: string;
}

export interface CodeReviewRoundOutcome {
  readonly round: CodeReviewRound;
  readonly findings: readonly CodeReviewFinding[];
  readonly newFindings: number;
  readonly repeatedFindings: number;
  /**
   * What the subject looked like when the round finished.
   *
   * One field carrying one of five named states, rather than a pair of booleans
   * between them. Two booleans can express four combinations, two of which are
   * meaningless, and every reader has to reconstruct the state machine from
   * them — which is how `incomplete` came to be reported as `stale` in the
   * first place. `current` is the only value under which the result is in
   * force; `stale`, `unknown` and `incomplete` each mean something different
   * about why it is not.
   */
  readonly subjectAfter: CodeReviewSubjectIdentity;
  /**
   * Why a reconciliation could not settle the round, when it could not.
   *
   * Absent for a settled round. Present, and naming the reason, when the
   * provider said the round was still running, could say nothing at all, or
   * answered for a different subject — three situations that all leave the
   * round unresolved and that an operator needs told apart.
   */
  readonly unsettledReason?: string;
}

/** One reading of the worktree, kept so a second can be compared with it. */
interface DigestPass {
  readonly raw: RawCodeSnapshot;
  readonly entries: CodeSnapshotEntry[];
  readonly omitted: CodeSnapshotOmissionEntry[];
  readonly totalBytes: number;
  readonly manifest: CodeSnapshotManifest;
  readonly fingerprint: RawCodeSnapshot['fingerprint'];
}

/**
 * A locator is only a locator if every part of it is there.
 *
 * Checked before the round is dispatched rather than when recovery needs it: a
 * half-formed identity written down at dispatch time produces a round that
 * looks answerable and names nothing, and by then the external call has already
 * been made.
 */
const externalRoundLocatorSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    roundId: z.string().min(1).max(128),
    // Computed by THIS client, never server-supplied — see
    // computeCoaiContractFingerprint in adapters/mcp/coai-profiles.ts —
    // but still shape-checked here like every other field this service
    // durably persists.
    contractFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

/**
 * Why this locator may not be written down, or `null` when it may.
 *
 * The service checks it as well as the Coai adapter, and not out of caution:
 * `ExternalCodeReviewer` is an INTERFACE. A second implementation reaches this
 * line without passing through the adapter's schema at all, and this is where a
 * locator becomes durable — it is stored on the round and shown wherever the
 * round's provider identity is.
 *
 * `providerId` is checked here for shape and, separately and immediately below,
 * for equality with the trusted local provider identity. The two answer
 * different questions: whether the string is storable, and whether the round is
 * ours.
 *
 * Names the FIELD and the violation, never the value.
 */
function unstorableLocator(locator: ExternalCodeRoundLocator): string | null {
  const checks: readonly (readonly [string, UnsafeProviderTextReason | null])[] = [
    ['The provider session id', unsafeProviderLocatorId(locator.sessionId)],
    ['The provider round id', unsafeProviderLocatorId(locator.roundId)],
    ['The provider id', unsafeProviderLocatorId(locator.providerId)]
  ];
  for (const [what, reason] of checks) {
    if (reason !== null) {
      return `${what} is ${reason}, so nothing was dispatched.`;
    }
  }

  return null;
}

function sameLocator(a: ExternalCodeRoundIdentity, b: ExternalCodeRoundIdentity): boolean {
  return (
    a.providerId === b.providerId && a.sessionId === b.sessionId && a.roundId === b.roundId
  );
}

/** Do two passes agree about every path AND everything the identity says of it? */
function sameManifest(a: CodeSnapshotManifest, b: CodeSnapshotManifest): boolean {
  if (
    a.headCommit !== b.headCommit ||
    a.baseCommit !== b.baseCommit ||
    a.branch !== b.branch ||
    a.checkout.commonDir !== b.checkout.commonDir ||
    a.checkout.branch !== b.checkout.branch ||
    a.checkout.detached !== b.checkout.detached ||
    a.entries.size !== b.entries.size
  ) {
    return false;
  }
  for (const [path, entry] of a.entries) {
    const other = b.entries.get(path);
    if (
      other === undefined ||
      other.change !== entry.change ||
      other.contentSha256 !== entry.contentSha256 ||
      other.bytes !== entry.bytes
    ) {
      return false;
    }
  }
  return true;
}

export class CodeReviewService {
  constructor(private readonly deps: CodeReviewDeps) {}

  private get limits(): CodeSnapshotLimits {
    return this.deps.limits ?? DEFAULT_CODE_SNAPSHOT_LIMITS;
  }

  /* ------------------------------------------------------------------------ */
  /* The immutable subject                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Capture the task's working state, or return the identical existing capture.
   *
   * Nothing is staged, committed or checked out to make this happen: the
   * snapshot source runs read-only Git commands and the contents are read
   * straight off disk. A review that mutated the code to describe it would be
   * describing something that no longer existed by the time it finished.
   */
  async captureSubject(taskId: string): Promise<CodeReviewSubject> {
    this.assertMutableTask(taskId);
    const { task, worktreePath, baseBranch } = this.requireReviewableTask(taskId);
    const snapshot = await this.buildSnapshot(worktreePath, baseBranch);
    const canonical = canonicalCodeSnapshot(snapshot);

    return this.deps.reviews.createSubject({
      id: this.deps.ids.next(),
      taskId: task.id,
      baseCommit: snapshot.baseCommit,
      headCommit: snapshot.headCommit,
      branch: snapshot.branch,
      snapshotJson: canonical,
      subjectSha256: sha256(canonical),
      fileCount: snapshot.entries.length,
      totalBytes: snapshot.totalBytes,
      truncated: snapshot.truncated,
      complete: snapshot.complete,
      hasUncommittedState: snapshot.hasUncommittedState,
      capturedAt: this.deps.clock.nowIso()
    });
  }

  /**
   * Does the stored subject still describe the task's working state?
   *
   * Five answers, and three of the distinctions are load-bearing.
   *
   * `stale` is a CLAIM: two hashes were both computed and they differ.
   * `unknown` is the ABSENCE of a claim: the working state could not be read,
   * so nothing was compared. They must never be collapsed, because the remedy
   * staleness suggests — capture again — is the one thing that cannot work when
   * capture is what failed.
   *
   * `incomplete` is neither: the capture succeeded and the code has not moved,
   * but something in it could not be digested, so the stored subject is not an
   * exact statement of the code and nothing may be reviewed or decided against
   * it. Its remedy is to fix what could not be read.
   */
  async subjectIdentity(taskId: string): Promise<{
    identity: CodeReviewSubjectIdentity;
    stored: CodeReviewSubject | null;
    currentSha256: string | null;
    /** Why the working state could not be read. Bounded and redacted. */
    problem: string | null;
  }> {
    const stored = this.deps.reviews.latestSubject(taskId);
    if (stored === null) {
      return { identity: 'no_subject', stored: null, currentSha256: null, problem: null };
    }

    let currentSha256: string;
    let currentComplete: boolean;
    let currentIncompleteReason: string | null = null;
    try {
      const { worktreePath, baseBranch } = this.requireReviewableTask(taskId);
      const snapshot = await this.buildSnapshot(worktreePath, baseBranch);
      currentSha256 = sha256(canonicalCodeSnapshot(snapshot));
      currentComplete = snapshot.complete;
      currentIncompleteReason = snapshot.complete
        ? null
        : snapshot.omitted.length > 0 || snapshot.truncated
          ? SUBJECT_INCOMPLETE
          : SUBJECT_UNSTABLE;
    } catch (error) {
      // The reason is kept, bounded and redacted, so an operator is told what
      // failed rather than being left with a bare "unknown".
      return {
        identity: 'unknown',
        stored,
        currentSha256: null,
        problem: redactAndTruncate(
          error instanceof Error ? error.message : String(error),
          2_000
        )
      };
    }

    // Completeness is checked BEFORE the hashes, and the order is the whole
    // point. An incomplete capture's hash is not an exact description of the
    // code, so its differing from the stored hash proves nothing about whether
    // the code changed — the two snapshots may cover different sets of files.
    // Reading that difference as `stale` would be a claim ("your code moved")
    // derived from evidence that cannot support it, and would send an operator
    // to re-capture when the actual problem is a file nobody can read.
    if (!currentComplete || !stored.complete) {
      // Derived from the snapshot rather than remembered on the service: an
      // incomplete capture that omitted nothing and was not truncated can only
      // have been one the worktree refused to hold still for.
      return {
        identity: 'incomplete',
        stored,
        currentSha256,
        problem: currentIncompleteReason
      };
    }
    // Both snapshots are exact, so now — and only now — a hash difference is
    // proof that the code itself changed.
    if (stored.subjectSha256 !== currentSha256) {
      return { identity: 'stale', stored, currentSha256, problem: null };
    }
    return { identity: 'current', stored, currentSha256, problem: null };
  }

  /**
   * Is this worktree the one the task means, on the branch the task recorded?
   *
   * Read before anything durable is written and before any external call. A
   * worktree that belongs to another repository, or that has been left detached
   * or moved onto a different branch, is not this task's code — and a review of
   * it would be a confident, well-evidenced statement about the wrong thing.
   */
  private async assertCheckoutIdentity(task: Task, worktreePath: string): Promise<void> {
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) {
      throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    }

    let checkout;
    let projectCheckout;
    try {
      [checkout, projectCheckout] = await Promise.all([
        this.deps.snapshots.describeCheckout(worktreePath),
        this.deps.snapshots.describeCheckout(project.localPath)
      ]);
    } catch (error) {
      throw new AgentRelayError('WORKTREE_INVALID', `${CHECKOUT_MISMATCH} The checkout could not be read.`, {
        details: redactAndTruncate(error instanceof Error ? error.message : String(error), 500)
      });
    }

    // A worktree shares its common Git directory with the repository it belongs
    // to. Comparing that rather than the path catches a worktree that was moved
    // or that points somewhere else entirely.
    if (checkout.commonDir !== projectCheckout.commonDir) {
      throw new AgentRelayError(
        'WORKTREE_INVALID',
        `${CHECKOUT_MISMATCH} It belongs to a different repository.`
      );
    }
    if (checkout.detached) {
      throw new AgentRelayError(
        'WORKTREE_INVALID',
        `${CHECKOUT_MISMATCH} Its HEAD is detached, so it is not on the task's branch.`
      );
    }
    if (checkout.branch !== task.branchName) {
      throw new AgentRelayError(
        'WORKTREE_INVALID',
        `${CHECKOUT_MISMATCH} It is on another branch than this task records.`
      );
    }
  }

  /**
   * Capture, and prove the worktree held still while it happened.
   *
   * Hashing a change set takes time, and nothing stops the tree changing during
   * it. Without a stability check the result is not merely out of date — it can
   * describe a state that never existed: edit A, edit B, restore A, and every
   * individual read is honest while their combination is fiction. So a cheap
   * fingerprint is taken with the file list and read again afterwards, and a
   * capture that saw movement is retried a bounded number of times before being
   * declared unstable rather than exact.
   */
  private async buildSnapshot(
    worktreePath: string,
    baseBranch: string
  ): Promise<CodeReviewSnapshot> {
    let last: CodeReviewSnapshot | null = null;
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      const candidate = await this.captureOnce(worktreePath, baseBranch);
      if (candidate.stable) return candidate.snapshot;
      last = candidate.snapshot;
    }
    // Every attempt saw movement. The snapshot is returned as evidence of what
    // was seen, marked incomplete, so nothing downstream can treat it as exact.
    return { ...(last as CodeReviewSnapshot), complete: false };
  }

  /**
   * One attempt: digest everything, then digest it again and compare.
   *
   * The second pass is the proof, and it is not cheap — it doubles the reading.
   * The cheap Git fingerprint is kept ahead of it as an early exit, but it
   * cannot be the proof: an edit that leaves the same added and removed line
   * counts moves none of its fields, so a file already digested could be
   * rewritten and the capture would still call itself exact. Nothing short of
   * comparing content digests can rule that out, and a snapshot that claims to
   * be an exact statement of the code has to have ruled it out.
   */
  private async captureOnce(
    worktreePath: string,
    baseBranch: string
  ): Promise<{ snapshot: CodeReviewSnapshot; stable: boolean }> {
    const first = await this.digestOnce(worktreePath, baseBranch);

    // Early exit: if the cheap description already moved, there is no point
    // paying for a second full pass to learn the same thing.
    const fingerprintAfter = await this.deps.snapshots.fingerprint({
      worktreePath,
      baseBranch,
      maxFiles: this.limits.maxFiles
    });
    if (!sameFingerprint(first.fingerprint, fingerprintAfter)) {
      return { snapshot: this.toSnapshot(first, false), stable: false };
    }

    const second = await this.digestOnce(worktreePath, baseBranch);
    const stable = sameManifest(first.manifest, second.manifest);
    return { snapshot: this.toSnapshot(first, stable), stable };
  }

  private toSnapshot(
    pass: DigestPass,
    stable: boolean
  ): CodeReviewSnapshot {
    return codeReviewSnapshotSchema.parse({
      version: CODE_SNAPSHOT_VERSION,
      baseCommit: pass.raw.baseCommit,
      headCommit: pass.raw.headCommit,
      branch: pass.raw.branch,
      entries: pass.entries,
      omitted: pass.omitted,
      totalBytes: pass.totalBytes,
      truncated: pass.raw.truncated,
      // Exact means exact: every changed file digested, the whole change set
      // seen, and every digest reproduced by a second reading. Anything less is
      // storable evidence but not a subject a review may be run against.
      complete: pass.omitted.length === 0 && !pass.raw.truncated && stable,
      hasUncommittedState: pass.raw.hasUncommittedState
    });
  }

  private async digestOnce(worktreePath: string, baseBranch: string): Promise<DigestPass> {
    const request = { worktreePath, baseBranch, maxFiles: this.limits.maxFiles };
    const checkout = await this.deps.snapshots.describeCheckout(worktreePath);
    const raw: RawCodeSnapshot = await this.deps.snapshots.capture(request);

    const entries: CodeSnapshotEntry[] = [];
    const omitted: CodeSnapshotOmissionEntry[] = [];
    let totalBytes = 0;

    for (const file of raw.files) {
      if (file.change === 'deleted' || file.absolutePath === null) {
        // A deletion has no content, and saying so is part of the statement:
        // removing a file must change the identity just as editing one does.
        entries.push({ path: file.path, change: 'deleted', contentSha256: null, bytes: 0 });
        continue;
      }

      // Streamed, and containment-checked first. Every regular file inside the
      // worktree is digested whatever its size; what cannot be digested is
      // recorded by name and reason, and makes the whole snapshot incomplete.
      const read = await hashSnapshotFile(
        worktreePath,
        file.absolutePath,
        this.deps.fileOps ?? nodeSnapshotFileOps
      );
      if ('error' in read) {
        omitted.push({ path: file.path, reason: read.error, bytes: 0 });
        continue;
      }

      totalBytes += read.bytes;
      entries.push({
        path: file.path,
        change: file.change,
        contentSha256: read.sha256,
        bytes: read.bytes
      });
    }

    // The manifest is what a second pass is compared against, and it carries
    // exactly what the subject hash carries: path, change, digest and size.
    // Anything less would let a file whose bytes never moved change what it IS
    // between the passes — an untracked file becoming an added one is the
    // everyday case — and that alone is a different subject.
    const manifest: CodeSnapshotManifest = {
      entries: new Map<string, CodeSnapshotManifestEntry>(
        [...entries]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((entry) => [
            entry.path,
            { change: entry.change, contentSha256: entry.contentSha256, bytes: entry.bytes }
          ])
      ),
      headCommit: raw.headCommit,
      baseCommit: raw.baseCommit,
      branch: raw.branch,
      checkout
    };

    return { raw, entries, omitted, totalBytes, manifest, fingerprint: raw.fingerprint };
  }

  /* ------------------------------------------------------------------------ */
  /* Rounds                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Run one code-review round against the task's current subject.
   *
   * The ordering is the contract. Everything that can refuse without an
   * external effect refuses first and writes nothing; the durable intent is
   * written before the reviewer is called, never after; and a lost answer
   * leaves that intent in place rather than being tidied away into a state that
   * implies the call never happened.
   */
  async review(taskId: string, signal?: AbortSignal): Promise<CodeReviewRoundOutcome> {
    this.assertMutableTask(taskId);
    const release = this.deps.claims.acquire(taskId, 'review');
    try {
      return await this.runReview(taskId, signal);
    } finally {
      release();
    }
  }

  private async runReview(
    taskId: string,
    signal?: AbortSignal
  ): Promise<CodeReviewRoundOutcome> {
    const { task, worktreePath } = this.requireReviewableTask(taskId);

    // Is this even the right checkout? Read before any durable write and before
    // any external call, so a moved, detached or re-pointed worktree costs
    // nothing but a refusal.
    await this.assertCheckoutIdentity(task, worktreePath);

    // An earlier round whose outcome is unknown blocks a new one. `requested`
    // and `reviewing` mean a call may be in flight or may already have run;
    // `interrupted` means one demonstrably did. None of them is evidence that
    // dispatching again would repeat nothing, and a non-idempotent call needs
    // exactly that evidence.
    const previous = this.deps.reviews.latestRound(taskId);
    if (
      previous !== null &&
      CODE_REVIEW_UNRESOLVED_STATUSES.includes(
        previous.status as (typeof CODE_REVIEW_UNRESOLVED_STATUSES)[number]
      )
    ) {
      throw new AgentRelayError('VALIDATION_FAILED', REVIEW_IN_FLIGHT, {
        remediation: 'Reconcile or close the previous round before starting another.'
      });
    }

    // Re-checked here, immediately before dispatch, rather than trusted from
    // whenever the subject happened to be captured.
    const before = await this.subjectIdentity(taskId);
    if (before.identity === 'incomplete') {
      // Its own refusal, with its own remedy: capturing again would produce the
      // same partial snapshot, because nothing about the code has moved.
      throw new AgentRelayError('VALIDATION_FAILED', SUBJECT_INCOMPLETE, {
        remediation:
          'Make every changed file readable — or reduce the change set below the capture ceiling — and capture the subject again.'
      });
    }
    if (before.stored === null || before.identity !== 'current') {
      throw new AgentRelayError('VALIDATION_FAILED', NO_CURRENT_SUBJECT, {
        remediation: 'Capture the code-review subject again, then start the round.'
      });
    }
    const subject = before.stored;

    // A reviewer that reads only committed refs cannot see a subject that
    // includes uncommitted or untracked work. Dispatching anyway would not
    // produce a worse review — it would produce a confident verdict about
    // different code, which is the failure that is hardest to detect later.
    if (subject.hasUncommittedState && !this.deps.reviewer.readsUncommittedWorktreeState) {
      throw new AgentRelayError('VALIDATION_FAILED', REVIEWER_CANNOT_SEE_SUBJECT, {
        remediation:
          'Commit the task branch before reviewing it, or configure a reviewer that reads the worktree.'
      });
    }

    // The last question that can be answered without an external effect, and
    // therefore the last one whose refusal may leave nothing behind. Asked
    // through a typed contract rather than inferred from whatever `reviewCode`
    // throws: "no provider is configured" and "the call went out and its answer
    // was lost" want opposite handling, and telling them apart by exception
    // type is how a provably local refusal ends up looking like a dispatch.
    const availability = await this.deps.reviewer.availability(signal);
    if (!availability.available) {
      throw new AgentRelayError(
        'TOOL_MISSING',
        // The reason comes from outside this application and travels to a
        // caller: it is redacted and bounded like any other foreign text, so a
        // provider cannot leak a path, an argv or a token through its refusal.
        `No code-review round can run. ${
          availability.reason === null
            ? 'The reviewer is unavailable.'
            : redactAndTruncate(availability.reason, 2_000)
        }`,
        {
          remediation:
            'Configure an external code reviewer. Capturing subjects and reading recorded findings work without one.'
        }
      );
    }

    const scopeText = this.scopeText(task, subject);

    // ---- Everything above this line is provably free of external effect. ----
    //
    // Durable intent, written BEFORE anything leaves the process. If the
    // machine dies on the next line, the row already says a round was about to
    // go out, and nothing will silently start a second one.
    const round = this.deps.reviews.createRound({
      id: this.deps.ids.next(),
      taskId: task.id,
      subjectId: subject.id,
      subjectSha256: subject.subjectSha256,
      status: 'requested',
      verdict: null,
      providerId: null,
      sessionId: null,
      providerRoundId: null,
      serverName: null,
      serverVersion: null,
      contractFingerprint: null,
      contractMismatchAt: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      tokensIn: null,
      tokensOut: null,
      lastError: null,
      startedAt: this.deps.clock.nowIso(),
      completedAt: null
    });

    // The task worktree, because that is where the snapshot came from. The
    // project root is a different working tree sharing the same repository, and
    // reviewing it would answer about other code.
    const externalSubject = {
      worktreePath,
      branch: subject.branch,
      baseRef: subject.baseCommit,
      headCommit: subject.headCommit,
      subjectSha256: subject.subjectSha256
    };

    // Name the round at the provider, and write that name down, BEFORE the
    // non-idempotent call. This is what makes recovery possible at all: a
    // locator recorded here can be asked about later, whereas a round described
    // only by its subject cannot be told apart from every other round of the
    // same code.
    //
    // `beginRound` must not itself consume a review round — a crash between it
    // and the write below would otherwise spend one that nothing can find.
    let locator: ExternalCodeRoundLocator;
    try {
      // Validated here, above the boundary, because an unusable locator must
      // stop the dispatch rather than be discovered by the recovery that needed
      // it. `providerId` is required to match the reviewer that produced it: a
      // round filed under somebody else's namespace could never be read back.
      locator = externalRoundLocatorSchema.parse(
        // The token is the durable round row's own id: it exists before this
        // call, survives a restart, and is different for every local round —
        // including two rounds over one subject, which a subject hash could not
        // tell apart.
        await this.deps.reviewer.beginRound(externalSubject, round.id, signal)
      );
      // Shape first: an unstorable component must stop the dispatch here, above
      // the non-idempotent call, rather than be discovered by whatever later
      // reads the row it would have been written into.
      const unstorable = unstorableLocator(locator);
      if (unstorable !== null) {
        throw new AgentRelayError('PARSE_FAILED', unstorable);
      }
      if (locator.providerId !== this.deps.reviewer.providerId) {
        throw new AgentRelayError('PARSE_FAILED', LOCATOR_INVALID);
      }
    } catch (error) {
      // Still above the non-idempotent call, so the round is closed as a
      // refusal that provably reviewed nothing.
      //
      // KNOWN AND BOUNDED: if `reserve_round` succeeded at the provider and only
      // its ANSWER was lost, that reservation is now stranded — this row is
      // closed, the next review builds a new row with a new token, and nothing
      // addresses the old one again. The cost stops at the provider's own
      // bookkeeping: a reservation dispatches no reviewer and spends no round
      // quota, so a stranded one reviews nothing and costs nothing. Resuming it
      // would need a durable reservation phase of its own, which is deliberately
      // not designed here.
      this.deps.reviews.updateRound(round.id, {
        status: 'failed',
        lastError: redactAndTruncate(RESERVATION_FAILED, 10_000)
      });
      // Rethrown untouched: the caller that asked for this review is entitled
      // to the code and the sentence. Only the DURABLE copy is Agent Relay's.
      throw error;
    }

    const dispatched = this.deps.reviews.updateRound(round.id, {
      status: 'reviewing',
      providerId: locator.providerId,
      sessionId: locator.sessionId,
      providerRoundId: locator.roundId,
      // Bound here, at reservation — the earliest point this durable round
      // exists — and never overwritten by a later call's own reading; see
      // `assertContractStable` below, called before any answer is applied.
      contractFingerprint: locator.contractFingerprint
    });

    let answer;
    try {
      answer = await this.deps.reviewer.reviewCode(locator, externalSubject, scopeText, signal);
    } catch (error) {
      // Two failures that look identical from here, and only one of them may
      // close the round.
      //
      // The typed error is positive proof that nothing was sent: it comes from
      // the configuration seam, which is resolved BEFORE any MCP call, so a
      // throw from there means the request never left. Recognised by TYPE and
      // never by its code — a real adapter can raise `TOOL_MISSING` from inside
      // an external call, once the request has already gone out, and treating
      // that as proof would close a round that may well have run.
      if (error instanceof CodeReviewNotDispatchedError) {
        this.deps.reviews.updateRound(dispatched.id, {
          status: 'failed',
          lastError: redactAndTruncate(DISPATCH_NOT_ATTEMPTED, 10_000)
        });
        throw error;
      }

      // Everything else: the phase stays at `reviewing`, because the request
      // left this process and only its answer was lost. Writing `failed` here
      // would assert the call had no effect, which nothing on this side knows.
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(DISPATCH_UNCONFIRMED, 10_000)
      });
      // Rethrown untouched, for the same reason as the reservation above.
      throw error;
    }

    // Validated at this boundary as well as the adapter's: the port is an
    // interface, and reviewer prose is data that must never reach storage
    // unchecked. A malformed answer is not a completed review.
    const validated = this.validateAnswer(answer, subject, dispatched.id);

    // Did the reviewer read what it was asked to read? A capability flag is a
    // promise about a reviewer's general behaviour; this is evidence about THIS
    // answer. Without it, a reviewer that looked at the right worktree at the
    // wrong moment — or an answer that arrived for another round — would be
    // filed as a confirmed result.
    if (!sameLocator(answer.locator, locator)) {
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(RECONCILE_WRONG_ROUND, 10_000)
      });
      throw new AgentRelayError('PARSE_FAILED', RECONCILE_WRONG_ROUND);
    }

    if (answer.reviewedSubjectSha256 !== subject.subjectSha256) {
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(ATTESTATION_MISMATCH, 10_000)
      });
      throw new AgentRelayError('PARSE_FAILED', ATTESTATION_MISMATCH, {
        remediation: 'Reconcile the round, and use a reviewer that attests the subject it read.'
      });
    }

    // Did the SERVER'S CONTRACT change between reserving this round and
    // running it? An answer produced under a schema this build never agreed
    // to for THIS round is not trustworthy evidence, whatever it says — see
    // `assertContractStable`.
    this.assertContractStable(dispatched.contractFingerprint, answer.contractFingerprint, dispatched.id);

    // Re-verify the subject before the result is applied. Four outcomes, and
    // they are genuinely four: the code demonstrably moved, it demonstrably did
    // not, it could not be read at all, or it could not be read exactly.
    // Deriving staleness from a null or partial hash would file "nobody could
    // tell" as proof the code had changed — a claim made from an absence.
    const after = await this.subjectIdentity(taskId);

    const applied = this.persistCompletion(dispatched.id, subject, answer, validated, after);

    return {
      round: applied.round,
      findings: applied.findings,
      // Counted over distinct findings, not over however many array entries the
      // provider sent: two identical entries are one finding reported once.
      newFindings: applied.created,
      repeatedFindings: applied.findings.length - applied.created,
      subjectAfter: after.identity
    };
  }

  /**
   * Refuse an answer produced under a contract different from the one this
   * round was RESERVED under.
   *
   * `reserved` is bound once, at `beginRound`, before the non-idempotent
   * `run_round` call — see the reservation-success write above. `fresh` is
   * what THIS read (a live `reviewCode`, or reconciliation's `roundStatus`)
   * just proved. They can legitimately differ from an ordinary schema change
   * at the server between the two calls, and an answer produced under a
   * schema this build never agreed to for THIS round is not safe to trust,
   * whatever it says — the same property `stdio-mcp-client.ts`'s per-call
   * schema validation already has for the SINGLE call about to be made; this
   * is the SESSION-level counterpart, covering the reserve→run/status gap a
   * per-call check cannot see.
   *
   * `reserved === null` (a round dispatched before this build recorded
   * fingerprints) is not a mismatch — there is nothing to compare against, so
   * nothing is refused on this account alone.
   */
  private assertContractStable(reserved: string | null, fresh: string, roundId: string): void {
    if (reserved === null || reserved === fresh) return;
    this.deps.reviews.updateRound(roundId, {
      contractMismatchAt: this.deps.clock.nowIso(),
      lastError: redactAndTruncate(CONTRACT_DRIFTED, 10_000)
    });
    throw new AgentRelayError('VALIDATION_FAILED', CONTRACT_DRIFTED, {
      remediation: 'Confirm the Coai server is stable, then start a new round.'
    });
  }

  /**
   * The non-throwing counterpart to {@link assertContractStable}, for
   * reconciliation's `running`/`not_started` reads: the round is not being
   * settled either way, so there is nothing to refuse — only a drift to
   * record durably, exactly as `completed`'s own reconciliation branch
   * already does further down. `reserved === null` (a round dispatched
   * before this build recorded fingerprints) is not a mismatch, matching
   * `assertContractStable`'s own leniency.
   */
  private contractDriftAt(reserved: string | null, fresh: string): string | null {
    return reserved !== null && reserved !== fresh ? this.deps.clock.nowIso() : null;
  }

  /**
   * Check an answer the way storage requires, and record why if it fails.
   *
   * Shared by a live dispatch and by reconciliation, because the two must apply
   * exactly the same standard: a result read back later is not more trustworthy
   * for having survived a crash, and a second implementation would drift.
   */
  private validateAnswer(
    answer: ExternalCodeReviewRound,
    subject: CodeReviewSubject,
    roundId: string
  ): { findings: ProviderCodeFinding[]; verdict: CodeReviewVerdict } {
    try {
      const parsed = z.array(providerCodeFindingSchema).max(512).parse(answer.findings);
      const verdict = z
        .enum(['proceed', 'revise', 'continue_anyway', 'good_enough', 'call_human', 'escalated'])
        .parse(answer.verdict);
      if (containsSecretShape(JSON.stringify(parsed))) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'The reviewer returned credential-shaped text; the round was not persisted as complete.'
        );
      }

      // The same standard for every OTHER provider-controlled string this
      // answer would put into storage. `findings` above is one of them; these
      // are the rest, and they used to be trusted here because the Coai adapter
      // had already checked them — which is a promise about ONE implementation
      // of an interface, not about the interface. This is the boundary where an
      // answer becomes durable, so this is where the check has to hold for
      // anything that reaches it.
      //
      // Identity and prose are judged differently on purpose: a server name or
      // version has no business carrying any control character, while a
      // reviewer's instruction may legitimately wrap.
      const foreign: readonly (readonly [string, UnsafeProviderTextReason | null])[] = [
        ['The reviewer summary', unsafeProviderProse(answer.reviewers, 2_000)],
        ['The reviewer instruction', unsafeProviderProse(answer.instruction, 20_000)],
        ['The MCP server name', unsafeProviderIdentity(answer.serverName)],
        ['The MCP server version', unsafeProviderIdentity(answer.serverVersion)]
      ];
      for (const [what, reason] of foreign) {
        if (reason !== null) {
          // Names the field and the problem, never the value: this message is
          // stored on the round, and repeating the value would defeat the check.
          throw new AgentRelayError(
            'PARSE_FAILED',
            `${what} is ${reason}; the round was not persisted as complete.`
          );
        }
      }
      // An answer that lists one finding twice with different round-specific
      // details contradicts itself, and that is a property of the answer — so
      // it is judged here, with the other answer checks, and long before the
      // completion transaction it would otherwise blow up inside.
      return { findings: this.collapseDuplicates(parsed, subject), verdict };
    } catch (error) {
      // Ours is storable, a parser's is not. Everything thrown inside this try
      // that is an `AgentRelayError` was constructed here from a constant or a
      // field name, so it quotes no provider value; a schema failure comes from
      // outside that guarantee and is replaced rather than repeated.
      this.deps.reviews.updateRound(roundId, {
        lastError: redactAndTruncate(
          error instanceof AgentRelayError ? error.message : ANSWER_MALFORMED,
          10_000
        )
      });
      throw error;
    }
  }

  /**
   * Write the completion, its findings and their occurrences as one act.
   *
   * Findings are recorded against the subject the round actually read, never
   * against whatever the working state has become — that is what keeps a stale
   * round's findings inert instead of quietly re-targeting them at code they
   * were never about.
   */
  private persistCompletion(
    roundId: string,
    subject: CodeReviewSubject,
    answer: ExternalCodeReviewRound,
    validated: { findings: ProviderCodeFinding[]; verdict: CodeReviewVerdict },
    after: { identity: CodeReviewSubjectIdentity; problem: string | null }
  ): CompletedRoundResult {
    const note =
      after.identity === 'stale'
        ? SUBJECT_STALE
        : after.identity === 'unknown'
          ? `${SUBJECT_UNVERIFIABLE_AFTER} ${after.problem ?? ''}`.trim()
          : after.identity === 'incomplete'
            ? SUBJECT_INCOMPLETE_AFTER
            : null;

    const records: RoundFindingRecord[] = validated.findings.map((finding) => ({
      finding: {
        id: this.deps.ids.next(),
        taskId: subject.taskId,
        subjectSha256: subject.subjectSha256,
        fingerprint: sha256(codeFindingFingerprintInput(subject.subjectSha256, finding)),
        severity: finding.severity,
        category: finding.category,
        gating: finding.gating,
        title: finding.title,
        body: finding.body,
        fix: finding.fix,
        file: finding.file,
        line: finding.line,
        provider: finding.provider,
        role: finding.role,
        firstRoundId: roundId,
        lastRoundId: roundId
      },
      // What THIS round said, kept beside the stable identity. A later round
      // can re-raise the same defect at a different severity or gate it
      // differently, and the stable row must not silently rewrite history.
      occurrence: {
        id: this.deps.ids.next(),
        roundId,
        subjectSha256: subject.subjectSha256,
        severity: finding.severity,
        category: finding.category,
        gating: finding.gating,
        title: finding.title,
        body: finding.body,
        fix: finding.fix,
        file: finding.file,
        line: finding.line,
        provider: finding.provider,
        role: finding.role
      }
    }));

    // One transaction for the completion and every finding. A `completed` round
    // carrying only the findings that happened to be written before something
    // threw would under-report a review that really finished, and nothing
    // downstream could tell.
    return this.deps.reviews.completeRoundWithFindings(
      roundId,
      {
        status: 'completed',
        verdict: validated.verdict,
        // The locator columns are deliberately absent from this patch. They were
        // written before the dispatch and are what proved this answer belongs
        // here; letting the answer restate them would let the evidence rewrite
        // the thing it was checked against, and a provider that simply omitted
        // one would blank half a locator on an otherwise good round.
        serverName: answer.serverName,
        serverVersion: answer.serverVersion,
        reviewers: answer.reviewers,
        gatingCount: answer.gatingCount,
        threshold: answer.threshold,
        tokensIn: answer.tokensIn,
        tokensOut: answer.tokensOut,
        completedAt: this.deps.clock.nowIso(),
        lastError: note === null ? null : redactAndTruncate(note, 10_000)
      },
      records
    );
  }

  /**
   * Fold an answer's exact repeats into one, and refuse a self-contradiction.
   *
   * A provider that lists the same finding twice is not describing two defects.
   * Left alone, the two rows collide on `UNIQUE (finding_id, round_id)` inside
   * the completion transaction and roll the whole answer back — a real review
   * discarded because of a provider's formatting.
   *
   * But "the same finding" is decided by the fingerprint, which deliberately
   * excludes `gating` and `fix`. So two entries can share an identity while
   * disagreeing about whether the defect gates the round. There is no honest
   * way to pick one, and picking silently would record a gating decision the
   * reviewer did not make — so the answer is refused, before anything is
   * written, as the contradiction it is.
   */
  private collapseDuplicates(
    findings: readonly ProviderCodeFinding[],
    subject: CodeReviewSubject
  ): ProviderCodeFinding[] {
    const byFingerprint = new Map<string, ProviderCodeFinding>();
    for (const finding of findings) {
      const fingerprint = sha256(codeFindingFingerprintInput(subject.subjectSha256, finding));
      const seen = byFingerprint.get(fingerprint);
      if (seen === undefined) {
        byFingerprint.set(fingerprint, finding);
        continue;
      }
      if (seen.gating !== finding.gating || seen.fix !== finding.fix) {
        throw new AgentRelayError('PARSE_FAILED', DUPLICATE_CONFLICT, {
          remediation: 'Ask the reviewer for one statement per finding.'
        });
      }
      // Identical in every respect. One defect, reported once.
    }
    return [...byFingerprint.values()];
  }

  /**
   * Read a dispatched round back, and settle it if the provider proves it done.
   *
   * The counterpart to "a lost answer is never retried automatically". Without
   * this, a round whose answer vanished stays unresolved forever and every
   * later review for that task is refused — the safe behaviour taken to the
   * point of uselessness. So there is exactly one read-only way out, and it
   * never starts a review: `roundStatus` is idempotent by contract, and the
   * three answers it can give license three different things.
   */
  async reconcile(taskId: string, signal?: AbortSignal): Promise<CodeReviewRoundOutcome> {
    this.assertMutableTask(taskId);
    const release = this.deps.claims.acquire(taskId, 'reconcile');
    try {
      return await this.runReconcile(taskId, signal);
    } finally {
      release();
    }
  }

  private async runReconcile(
    taskId: string,
    signal?: AbortSignal
  ): Promise<CodeReviewRoundOutcome> {
    const { worktreePath } = this.requireReviewableTask(taskId);

    const round = this.deps.reviews.latestRound(taskId);
    if (
      round === null ||
      !CODE_REVIEW_UNRESOLVED_STATUSES.includes(
        round.status as (typeof CODE_REVIEW_UNRESOLVED_STATUSES)[number]
      )
    ) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'There is no dispatched code-review round with an unknown outcome to reconcile.'
      );
    }

    const subject = this.deps.reviews.findSubjectById(round.subjectId);
    if (subject === null) {
      throw new AgentRelayError('NOT_FOUND', 'The subject this round was dispatched for is gone.');
    }

    // Without a recorded locator there is nothing to ask about. Describing the
    // round by its subject instead would invite the provider to answer about
    // some other round of the same code, and that answer would be written here.
    if (round.providerId === null || round.sessionId === null || round.providerRoundId === null) {
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(NO_LOCATOR, 10_000)
      });
      return this.unsettled(held, 'no-locator');
    }
    const locator: ExternalCodeRoundIdentity = {
      providerId: round.providerId,
      sessionId: round.sessionId,
      roundId: round.providerRoundId
    };

    // The configured reviewer can be a different one than the round went to —
    // that is what a restart with changed configuration looks like, and it is
    // precisely when an unresolved round is waiting. Session and round ids are
    // unique only inside one provider's namespace, so asking the wrong provider
    // is not merely useless: it can be answered.
    if (locator.providerId !== this.deps.reviewer.providerId) {
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(RECONCILE_OTHER_PROVIDER, 10_000)
      });
      return this.unsettled(held, 'other-provider');
    }

    const status = await this.deps.reviewer.roundStatus(
      locator,
      {
        worktreePath,
        branch: subject.branch,
        baseRef: subject.baseCommit,
        headCommit: subject.headCommit,
        subjectSha256: subject.subjectSha256
      },
      signal
    );

    if (status.kind === 'running') {
      // Still executing. The round keeps its phase, and nothing may start
      // another: this is the one state where a second dispatch is certain to
      // double a call that has not finished. `status.contractFingerprint` is
      // the CURRENT contract this read just proved (see its doc comment on
      // ExternalCodeRoundStatus) — compared here against the one reserved at
      // beginRound so a drift is recorded even while the round is still in
      // flight, not only once it completes.
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(RECONCILE_RUNNING, 10_000),
        contractMismatchAt: this.contractDriftAt(round.contractFingerprint, status.contractFingerprint)
      });
      return this.unsettled(held, 'running');
    }

    if (status.kind === 'not_started') {
      // The one answer that can safely release the round: the provider is
      // certain nothing ran under this locator, so nothing external was
      // consumed and a fresh dispatch repeats nothing. It is still not an
      // automatic repeat — the operator starts the next round by hand.
      const closed = this.deps.reviews.updateRound(round.id, {
        status: 'failed',
        lastError: redactAndTruncate(RECONCILE_NOT_STARTED, 10_000),
        contractMismatchAt: this.contractDriftAt(round.contractFingerprint, status.contractFingerprint)
      });
      return this.unsettled(closed, 'not-started');
    }

    if (status.kind === 'unknown') {
      // `status.reason` is deliberately NOT read. It is the one field on this
      // port that carries a reviewer's own words, and this write is durable.
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(RECONCILE_UNKNOWN, 10_000)
      });
      return this.unsettled(held, 'unknown');
    }

    // Completed — but only for THIS round, and only for this subject. The two
    // checks answer different questions: which round the answer belongs to, and
    // what that round read. A result failing either is somebody else's, and
    // applying it here would attach findings to code they were never about.
    if (!sameLocator(status.round.locator, locator)) {
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(RECONCILE_WRONG_ROUND, 10_000)
      });
      return this.unsettled(held, 'wrong-round');
    }

    if (status.round.reviewedSubjectSha256 !== subject.subjectSha256) {
      const held = this.deps.reviews.updateRound(round.id, {
        lastError: redactAndTruncate(RECONCILE_ATTESTATION, 10_000)
      });
      return this.unsettled(held, 'attestation-mismatch');
    }

    // Same standard `assertContractStable` applies to a live dispatch, in
    // reconciliation's own idiom: the round stays unresolved (never a thrown
    // exception, never `failed`) rather than applying an answer this build
    // never agreed the server's schema for. The historical `contractFingerprint`
    // recorded at reservation is left exactly as it was — only the explicit
    // mismatch marker is written.
    if (round.contractFingerprint !== null && round.contractFingerprint !== status.round.contractFingerprint) {
      const held = this.deps.reviews.updateRound(round.id, {
        contractMismatchAt: this.deps.clock.nowIso(),
        lastError: redactAndTruncate(RECONCILE_CONTRACT_DRIFTED, 10_000)
      });
      return this.unsettled(held, 'contract-drifted');
    }

    const validated = this.validateAnswer(status.round, subject, round.id);
    const after = await this.subjectIdentity(taskId);
    const applied = this.persistCompletion(round.id, subject, status.round, validated, after);
    return {
      round: applied.round,
      findings: applied.findings,
      newFindings: applied.created,
      repeatedFindings: applied.findings.length - applied.created,
      subjectAfter: after.identity
    };
  }

  /** A round that reconciliation could not settle, reported honestly. */
  private unsettled(round: CodeReviewRound, reason: string): CodeReviewRoundOutcome {
    return {
      round,
      findings: [],
      newFindings: 0,
      repeatedFindings: 0,
      subjectAfter: 'unknown',
      unsettledReason: reason
    };
  }

  /**
   * Mark a round whose answer never arrived as interrupted.
   *
   * Explicit, operator-driven, and not a repeat: it changes what the row says
   * about a call that already went out. It does NOT re-open the task for a new
   * dispatch — `interrupted` is still an unresolved status, because a round
   * that started and vanished is not evidence that starting another repeats
   * nothing.
   */
  markInterrupted(taskId: string, roundId: string, note: string): CodeReviewRound {
    this.assertMutableTask(taskId);
    const round = this.deps.reviews.findRoundById(roundId);
    if (round === null || round.taskId !== taskId) {
      throw new AgentRelayError('NOT_FOUND', 'No such code review round for this task.');
    }
    if (round.status !== 'requested' && round.status !== 'reviewing') {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `A round whose status is "${round.status}" has no dispatch left in flight.`
      );
    }
    return this.deps.reviews.updateRound(round.id, {
      status: 'interrupted',
      lastError: redactAndTruncate(note, 10_000)
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Decisions                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Record an operator's answer to one finding.
   *
   * Two guards, and they answer different questions. The subject check asks
   * "is this finding still about the code we have?" — an answer written against
   * an older snapshot is not carried forward onto a newer one, because the
   * defect it described may not exist any more and the operator was not shown
   * the code that does. The revision check asks "has anyone answered this since
   * the caller looked?" — a screen that has gone stale must not overwrite a
   * newer answer with an older one.
   */
  async decide(
    taskId: string,
    request: DecideCodeFindingRequest
  ): Promise<{ finding: CodeReviewFinding; action: CodeReviewDecisionAction }> {
    this.assertMutableTask(taskId);
    const reason = request.reason.trim();
    if (reason.length === 0) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'Every code-review decision requires a reason, including an acceptance.'
      );
    }
    if (containsSecretShape(reason)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A decision reason contains credential-shaped text and was not stored.'
      );
    }

    const finding = this.deps.reviews.findFindingById(request.findingId);
    if (finding === null || finding.taskId !== taskId) {
      throw new AgentRelayError('NOT_FOUND', 'No such code review finding for this task.');
    }

    const identity = await this.subjectIdentity(taskId);
    if (identity.identity === 'incomplete') {
      throw new AgentRelayError('VALIDATION_FAILED', SUBJECT_INCOMPLETE, {
        remediation: 'Capture an exact subject before deciding its findings.'
      });
    }
    if (identity.identity !== 'current' || identity.stored === null) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The reviewed code no longer matches the captured subject, so its findings cannot be decided.',
        { remediation: 'Capture the subject again and run a fresh round before deciding.' }
      );
    }
    if (finding.subjectSha256 !== identity.stored.subjectSha256) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'This finding belongs to an earlier snapshot of the code and cannot be decided against the current one.',
        { remediation: 'Decide the findings of the current round.' }
      );
    }

    const applied = this.deps.reviews.appendDecisionIfUnchanged(
      {
        id: this.deps.ids.next(),
        findingId: finding.id,
        subjectSha256: finding.subjectSha256,
        action: request.action,
        reason,
        actor: request.actor,
        source: request.source,
        findingRevision: request.expectedRevision,
        decidedAt: this.deps.clock.nowIso()
      },
      request.expectedRevision
    );
    if (applied === null) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'This finding was decided by someone else while you were looking at it, so nothing was written.',
        { remediation: 'Reload the finding and decide it again.' }
      );
    }

    return { finding: applied.finding, action: request.action };
  }

  /**
   * Codex-assisted, independent recommendations for a bounded set of
   * undecided, live findings — never a decision, never a resolve. A fresh,
   * read-only Codex call every time: no implementation session or tool
   * access is reused or granted. The result is persisted (one durable row
   * per task, wholesale-replaced — see `CodeReviewRepository.upsertTriage`)
   * bound to the exact subject and the exact finding identities/revisions it
   * was computed against, so it survives a restart and a later read can tell
   * whether it still applies via `codeReviewTriageIsCurrent`.
   */
  async triage(
    taskId: string,
    request: CodeReviewTriageRequest = {},
    signal?: AbortSignal
  ): Promise<readonly FindingTriageRecommendation[]> {
    const release = this.deps.claims.acquire(taskId, 'triage');
    try {
      return await this.runTriage(taskId, request, signal);
    } finally {
      release();
    }
  }

  private async runTriage(
    taskId: string,
    request: CodeReviewTriageRequest,
    signal?: AbortSignal
  ): Promise<readonly FindingTriageRecommendation[]> {
    if (!this.deps.codex || !this.deps.settings) {
      throw new AgentRelayError('TOOL_MISSING', 'Automatic finding triage is not configured in this build.');
    }
    const task = this.assertMutableTask(taskId);
    if (task.worktreePath === null) {
      throw new AgentRelayError('WORKTREE_INVALID', 'This task has no worktree yet.');
    }

    const identity = await this.subjectIdentity(taskId);
    if (identity.identity === 'incomplete') {
      throw new AgentRelayError('VALIDATION_FAILED', SUBJECT_INCOMPLETE, {
        remediation: 'Capture an exact subject before analyzing its findings.'
      });
    }
    if (identity.identity !== 'current' || identity.stored === null) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The reviewed code no longer matches the captured subject, so its findings cannot be analyzed.',
        { remediation: 'Capture the subject again and run a fresh round before analyzing.' }
      );
    }
    const subjectSha256 = identity.stored.subjectSha256;

    const all = this.deps.reviews.listFindings(taskId).filter((f) => f.subjectSha256 === subjectSha256);
    const decisionByFinding = new Map(all.map((f) => [f.id, this.deps.reviews.latestDecision(f.id)] as const));
    const undecided = all.filter((f) => decisionByFinding.get(f.id) === null);

    let targets: readonly CodeReviewFinding[];
    if (request.findingIds) {
      const byId = new Map(all.map((f) => [f.id, f]));
      // Deduped: a caller sending the same id twice must not double the
      // findings sent to Codex, nor make `validateTriageCoverage` demand two
      // recommendations for one ref (its own duplicate-ref check would then
      // fail a perfectly well-formed response).
      const uniqueIds = [...new Set(request.findingIds)];
      targets = uniqueIds.map((id) => {
        const found = byId.get(id);
        if (!found) {
          throw new AgentRelayError('VALIDATION_FAILED', `Finding ${id} is not a live finding for the current subject.`);
        }
        if (decisionByFinding.get(id) !== null) {
          throw new AgentRelayError('VALIDATION_FAILED', `Finding ${id} already has a decision recorded and cannot be analyzed.`);
        }
        return found;
      });
    } else {
      targets = undecided;
    }
    if (targets.length === 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There are no undecided findings to analyze.');
    }

    // Snapshotted before dispatch, so a decision recorded on any of these
    // findings WHILE Codex is thinking is detected below rather than silently
    // applied to evidence that has since moved.
    const revisionBefore = new Map(targets.map((f) => [f.id, f.revision]));
    const requestedIds = new Set(targets.map((f) => f.id));

    const specification = specificationIdentity(task.specificationJson).specification;
    const triageableFindings: TriageableFinding[] = targets.map((f) => ({
      ref: f.id,
      severity: f.severity,
      category: f.category,
      file: f.file.length > 0 ? f.file : null,
      line: f.line,
      title: f.title,
      body: f.body,
      fix: f.fix.length > 0 ? f.fix : null
    }));
    const priorDecisions = all
      .filter((f) => !requestedIds.has(f.id))
      .map((f) => decisionByFinding.get(f.id))
      .filter((d): d is NonNullable<typeof d> => d !== null && d !== undefined)
      .map((d) => ({ findingRef: d.findingId, action: d.action, reason: d.reason }));

    const settings = this.deps.settings.get();
    const context: AgentRunContext = {
      signal: signal ?? new AbortController().signal,
      timeoutMs: settings.processTimeoutMs,
      onProgress: () => undefined
    };

    const outcome = await this.deps.codex.triageFindings(
      {
        worktreePath: task.worktreePath,
        specification,
        findings: triageableFindings,
        priorDecisions,
        model: settings.codexModel
      },
      context
    );

    const validated = this.validateTriageCoverage(outcome.recommendations, requestedIds);

    // Refused if the subject or any targeted finding moved while the
    // (potentially long-running) Codex call was in flight — the read-only
    // analogue of `resolve`'s conditional write.
    const after = await this.subjectIdentity(taskId);
    if (after.identity !== 'current' || after.stored === null || after.stored.subjectSha256 !== subjectSha256) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The reviewed code changed while the analysis was running; the result was discarded.',
        { remediation: 'Try the analysis again against the current subject.' }
      );
    }
    for (const target of targets) {
      const current = this.deps.reviews.findFindingById(target.id);
      if (current === null || current.revision !== revisionBefore.get(target.id)) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'A finding was decided while the analysis was running; the result was discarded.',
          { remediation: 'Reload and try the analysis again.' }
        );
      }
    }

    const triageResult: CodeReviewTriageResult = {
      recommendations: validated.map((r) => ({
        // Guaranteed a string by `validateTriageCoverage` above (only a
        // string ref can be in `requestedIds`, which holds only finding ids).
        findingId: String(r.findingRef),
        recommendation: r.recommendation,
        reason: r.reason,
        evidenceRef: r.evidenceRef,
        confidence: r.confidence
      }))
    };
    this.deps.reviews.upsertTriage({
      id: this.deps.ids.next(),
      taskId,
      subjectId: after.stored.id,
      subjectSha256,
      findingsSnapshotJson: codeReviewTriageFindingsSnapshot(
        targets.map((f) => ({ id: f.id, revision: f.revision }))
      ),
      triageJson: JSON.stringify(triageResult)
    });

    return validated;
  }

  /**
   * Fails closed on anything short of exactly one well-formed recommendation
   * per requested finding: a partial response, an unrequested ref, or a
   * duplicate all discard the WHOLE result. A partial automatic triage
   * silently presented as complete is worse than none.
   */
  private validateTriageCoverage(
    recommendations: readonly FindingTriageRecommendation[],
    requestedIds: ReadonlySet<string>
  ): readonly FindingTriageRecommendation[] {
    const seen = new Set<string>();
    for (const recommendation of recommendations) {
      const ref = recommendation.findingRef;
      if (typeof ref !== 'string' || !requestedIds.has(ref)) {
        throw new AgentRelayError('PARSE_FAILED', 'Codex returned a recommendation for a finding that was not requested.');
      }
      if (seen.has(ref)) {
        throw new AgentRelayError('PARSE_FAILED', 'Codex returned more than one recommendation for the same finding.');
      }
      seen.add(ref);
    }
    if (seen.size !== requestedIds.size) {
      throw new AgentRelayError('PARSE_FAILED', 'Codex did not return a recommendation for every requested finding.');
    }
    return recommendations;
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                   */
  /* ------------------------------------------------------------------------ */

  private assertMutableTask(taskId: string): Task {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    if (TERMINAL_STATUSES.includes(task.status)) {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'This task is closed. Code-review history remains readable, but it cannot be changed.'
      );
    }
    return task;
  }

  /**
   * The scope a reviewer is given.
   *
   * Deliberately built here from durable state, never accepted from a caller.
   * A prompt supplied over IPC would let a renderer decide what the external
   * reviewer was asked, which is a different question from the one this gate
   * exists to answer.
   */
  private scopeText(task: Task, subject: CodeReviewSubject): string {
    return [
      '## Task under review',
      task.title,
      '',
      '## Original request',
      task.originalRequest,
      '',
      '## Reviewed code identity',
      `base ${subject.baseCommit}`,
      `head ${subject.headCommit}`,
      `snapshot ${subject.subjectSha256}`,
      `files ${subject.fileCount}${subject.truncated ? ' (change set truncated)' : ''}`
    ].join('\n');
  }

  private requireReviewableTask(taskId: string): {
    task: Task;
    project: { localPath: string };
    worktreePath: string;
    baseBranch: string;
  } {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);

    const project = this.deps.projects.findById(task.projectId);
    if (project === null) {
      throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    }
    if (task.worktreePath === null || task.branchName === null) {
      throw new AgentRelayError(
        'WORKTREE_INVALID',
        'This task has no isolated worktree, so there is no code to review.'
      );
    }
    if (task.baseBranch === null) {
      throw new AgentRelayError(
        'WORKTREE_INVALID',
        'This task has no recorded base branch, so a review has nothing to compare against.'
      );
    }
    return {
      task,
      project,
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch
    };
  }
}
