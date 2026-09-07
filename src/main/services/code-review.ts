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
  type CodeReviewVerdict,
  type CodeSnapshotEntry,
  type CodeSnapshotOmissionEntry,
  type ProviderCodeFinding
} from '../../shared/domain/code-review';
import type { Task } from '../../shared/domain/models';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import { hashSnapshotFile } from '../adapters/git/git-code-snapshot';
import type {
  Clock,
  CodeReviewRepository,
  CodeSnapshotLimits,
  CodeSnapshotSource,
  ExternalCodeReviewer,
  IdGenerator,
  ProjectRepository,
  RawCodeSnapshot,
  RoundFindingRecord,
  TaskRepository
} from '../ports';

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

const ATTESTATION_MISMATCH =
  'The reviewer did not attest that it read the subject this round dispatched, so its answer was not accepted. Nothing was recorded as a confirmed result.';

const DUPLICATE_CONFLICT =
  'The reviewer reported one finding twice with different round-specific details, so the answer contradicts itself and was not persisted.';

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
export class CodeReviewClaims {
  private readonly held = new Set<string>();

  acquire(taskId: string): () => void {
    if (this.held.has(taskId)) {
      throw new AgentRelayError('BUSY', 'A code review is already running for this task.', {
        remediation: 'Wait for the round in flight to finish, then read the review again.'
      });
    }
    this.held.add(taskId);
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
    try {
      const { worktreePath, baseBranch } = this.requireReviewableTask(taskId);
      const snapshot = await this.buildSnapshot(worktreePath, baseBranch);
      currentSha256 = sha256(canonicalCodeSnapshot(snapshot));
      currentComplete = snapshot.complete;
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
      return { identity: 'incomplete', stored, currentSha256, problem: null };
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

  private async buildSnapshot(
    worktreePath: string,
    baseBranch: string
  ): Promise<CodeReviewSnapshot> {
    const raw: RawCodeSnapshot = await this.deps.snapshots.capture({
      worktreePath,
      baseBranch,
      maxFiles: this.limits.maxFiles
    });

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
      const read = await hashSnapshotFile(worktreePath, file.absolutePath);
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

    return codeReviewSnapshotSchema.parse({
      version: CODE_SNAPSHOT_VERSION,
      baseCommit: raw.baseCommit,
      headCommit: raw.headCommit,
      branch: raw.branch,
      entries,
      omitted,
      totalBytes,
      truncated: raw.truncated,
      // Exact means exact: every changed file digested, and the whole change
      // set seen. Anything less is storable evidence but not a subject a review
      // may be run against.
      complete: omitted.length === 0 && !raw.truncated,
      hasUncommittedState: raw.hasUncommittedState
    });
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
    const release = this.deps.claims.acquire(taskId);
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
        `No code-review round can run. ${availability.reason ?? 'The reviewer is unavailable.'}`,
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
      sessionId: null,
      serverName: null,
      serverVersion: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      tokensIn: null,
      tokensOut: null,
      lastError: null,
      startedAt: this.deps.clock.nowIso(),
      completedAt: null
    });

    const dispatched = this.deps.reviews.updateRound(round.id, { status: 'reviewing' });

    let answer;
    try {
      answer = await this.deps.reviewer.reviewCode(
        {
          // The task worktree, because that is where the snapshot came from.
          // The project root is a different working tree sharing the same
          // repository, and reviewing it would answer about other code.
          worktreePath,
          branch: subject.branch,
          baseRef: subject.baseCommit,
          headCommit: subject.headCommit,
          subjectSha256: subject.subjectSha256
        },
        scopeText,
        signal
      );
    } catch (error) {
      // The phase stays at `reviewing`: the request left this process and only
      // its answer was lost. Writing `failed` here would assert the call had no
      // effect, which nothing on this side can know.
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }

    // Validated at this boundary as well as the adapter's: the port is an
    // interface, and reviewer prose is data that must never reach storage
    // unchecked. A malformed answer is not a completed review.
    let findings: ProviderCodeFinding[];
    let verdict: CodeReviewVerdict;
    try {
      const parsed = z.array(providerCodeFindingSchema).max(512).parse(answer.findings);
      verdict = z
        .enum(['proceed', 'revise', 'continue_anyway', 'good_enough', 'call_human', 'escalated'])
        .parse(answer.verdict);
      if (containsSecretShape(JSON.stringify(parsed))) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'The reviewer returned credential-shaped text; the round was not persisted as complete.'
        );
      }
      // An answer that lists one finding twice with different round-specific
      // details contradicts itself, and that is a property of the answer — so
      // it is judged here, with the other answer checks, and long before the
      // completion transaction it would otherwise blow up inside.
      findings = this.collapseDuplicates(parsed, subject);
    } catch (error) {
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }

    // Did the reviewer read what it was asked to read? A capability flag is a
    // promise about a reviewer's general behaviour; this is evidence about THIS
    // answer. Without it, a reviewer that looked at the right worktree at the
    // wrong moment — or an answer that arrived for another round — would be
    // filed as a confirmed result.
    if (answer.reviewedSubjectSha256 !== subject.subjectSha256) {
      this.deps.reviews.updateRound(dispatched.id, {
        lastError: redactAndTruncate(ATTESTATION_MISMATCH, 10_000)
      });
      throw new AgentRelayError('PARSE_FAILED', ATTESTATION_MISMATCH, {
        remediation: 'Reconcile the round, and use a reviewer that attests the subject it read.'
      });
    }

    // Re-verify the subject before the result is applied. Four outcomes, and
    // they are genuinely four: the code demonstrably moved, it demonstrably did
    // not, it could not be read at all, or it could not be read exactly.
    // Deriving staleness from a null or partial hash would file "nobody could
    // tell" as proof the code had changed — a claim made from an absence.
    const after = await this.subjectIdentity(taskId);
    const note =
      after.identity === 'stale'
        ? SUBJECT_STALE
        : after.identity === 'unknown'
          ? `${SUBJECT_UNVERIFIABLE_AFTER} ${after.problem ?? ''}`.trim()
          : after.identity === 'incomplete'
            ? SUBJECT_INCOMPLETE_AFTER
            : null;

    // Findings are recorded against the subject the round actually read, never
    // against whatever the working state has become. That is what keeps a
    // stale round's findings inert instead of quietly re-targeting them.
    const records: RoundFindingRecord[] = findings.map(
      (finding) => {
      const fingerprint = sha256(codeFindingFingerprintInput(subject.subjectSha256, finding));
      return {
        finding: {
          id: this.deps.ids.next(),
          taskId: task.id,
          subjectSha256: subject.subjectSha256,
          fingerprint,
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
          firstRoundId: dispatched.id,
          lastRoundId: dispatched.id
        },
        // What THIS round said, kept beside the stable identity. A later round
        // can re-raise the same defect at a different severity or gate it
        // differently, and the stable row must not silently rewrite history.
        occurrence: {
          id: this.deps.ids.next(),
          roundId: dispatched.id,
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
      };
      }
    );

    // One transaction for the completion and every finding. A `completed` round
    // carrying only the findings that happened to be written before something
    // threw would under-report a review that really finished, and nothing
    // downstream could tell.
    const applied = this.deps.reviews.completeRoundWithFindings(
      dispatched.id,
      {
        status: 'completed',
        verdict,
        sessionId: answer.sessionId,
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
   * Mark a round whose answer never arrived as interrupted.
   *
   * Explicit, operator-driven, and not a repeat: it changes what the row says
   * about a call that already went out. It does NOT re-open the task for a new
   * dispatch — `interrupted` is still an unresolved status, because a round
   * that started and vanished is not evidence that starting another repeats
   * nothing.
   */
  markInterrupted(taskId: string, roundId: string, note: string): CodeReviewRound {
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

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                   */
  /* ------------------------------------------------------------------------ */

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
