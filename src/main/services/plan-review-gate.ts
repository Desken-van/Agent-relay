/** Optional, durable external plan-review gate. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentRelayError, PlanReviewNotDispatchedError } from '../../shared/domain/errors';
import type { Task } from '../../shared/domain/models';
import { gateHasAcceptedDecisions, type PlanAutoDecideOutcome } from '../../shared/domain/plan-correction';
import {
  parsePlanReviewAutoDecisions,
  parsePlanReviewFindings,
  parsePlanReviewTriage,
  planReviewDecisionSchema,
  planReviewRecovery,
  planReviewSessionOwner,
  planReviewTriageResultSchema,
  taskRuleEvidenceBindingSchema,
  type PlanReviewAutoDecision,
  type PlanReviewDecision,
  type PlanReviewGate,
  type PlanReviewGateIdentity,
  type PlanReviewTriageRecommendation,
  type PlanReviewTriageResult
} from '../../shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../shared/domain/rule-evidence';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import type { FindingTriageRecommendation, TaskSpecification } from '../../shared/schemas/codex';
import { specificationIdentity } from './specification-identity';
import type {
  AgentRunContext,
  Clock,
  CodexAdapter,
  ExternalPlanReviewer,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject,
  IdGenerator,
  PlanReviewGatePatch,
  PlanReviewGateRepository,
  PlanReviewSubjectFactory,
  ProjectRepository,
  SettingsRepository,
  TaskRepository,
  TaskRuleEvidenceRepository,
  TriageableFinding
} from '../ports';
import type { PlanReviewClaims } from './plan-review-claims';
import { asStopped, runAsOperation, type TaskOperationKind, type TaskOperationRegistry } from './task-operations';
import { renderRuleEvidence, validateRuleEvidenceSnapshot } from './rule-evidence';

const MAX_PLAN_BYTES = 1_500_000;

/**
 * Phases that mean "dispatched, outcome unknown".
 *
 * Nothing in this process survives a restart, so a gate found in one of these
 * is by definition not being driven by a live call: the request went out and
 * its answer never came back. `review_plan` and `resolve` are not idempotent,
 * so the only safe move from here is a read-only reconciliation — never a
 * repeat. `failed` is included because rows written by earlier versions used it
 * for exactly this case, and those rows must be recoverable too.
 */
const RECONCILABLE_STATUSES = ['opening', 'reviewing', 'resolving', 'failed'] as const;

/**
 * Phases from which a new, non-idempotent round may safely be dispatched.
 *
 * `interrupted` belongs here because the provider's own record proves the
 * previous round produced no result: it is not running, it did not finish, and
 * nothing awaits decisions. Starting one now repeats nothing.
 */
const STARTABLE_STATUSES = ['prepared', 'changes_requested', 'interrupted'] as const;

const RECONCILE_FIRST =
  'Reconcile the external state first: the previous call may already have taken effect.';

/**
 * The provider records a completed round but its status surface carries no
 * findings, so there is nothing to decide against and nothing to invent.
 */
const FINDINGS_UNRECOVERABLE =
  'The provider has recorded a completed plan round for this session, but its read-only status does not return that round\'s findings. Agent Relay will not repeat the round, and will not invent a result. Resolve the round in the provider, or generate the specification again to start a new one.';

const STATE_UNRECOVERABLE =
  'The provider answered, but its state does not say whether the pending round was closed. Nothing was repeated and nothing was assumed.';

const ROUND_STILL_RUNNING =
  'The provider is still executing a plan round for this session. Nothing was repeated, and no new round may start until that one ends. Reconcile again once it has.';

const SESSION_MISMATCH =
  'The provider answered for a different session than the one this gate recorded, so nothing it said can be applied here. The gate was left exactly as it was.';

const INCOHERENT_STATUS =
  'The provider answered, but the answer contradicts itself and cannot be used as evidence for anything. Nothing was changed, nothing was repeated, and no external call was made a second time.';

/**
 * Statuses that must not be superseded by a new specification identity.
 *
 * Each of them has something outstanding at the provider: a dispatched call
 * whose outcome is unknown, or a finished round whose findings still await
 * decisions. Creating a second gate row over one of these does not resolve it —
 * it hides it, because the task's current gate is the most recent row, and the
 * hidden round can then be doubled by a review started against the new one.
 */
const SUPERSEDE_BLOCKING = [
  'opening',
  'reviewing',
  'awaiting_resolve',
  'resolving',
  'failed'
] as const;

const NO_TERMINAL_EVIDENCE =
  'The provider records no plan round for this session, which is not proof that the round already dispatched from here was refused: an empty list is equally consistent with a request the provider has accepted and not yet recorded. Nothing was repeated and no new round may start. Resolve or close the round in the provider, or reconcile again once it appears.';

const STOPPED_OUTCOME_UNKNOWN =
  'The task was stopped while an external call was in flight, so its outcome is unknown and was not recorded. Reconcile the round before repeating anything.';
const STOPPED_BEFORE_WRITE = 'The task was stopped before anything further was sent or written.';
const STOPPED_DURING_OPERATION = 'The task was stopped while this operation was running. Nothing further was changed.';
const STALE_ROUND =
  'These decisions were taken against a plan-review round that is no longer the current one, so nothing was sent to the provider. Re-read the round and decide its findings again.';

const INTERRUPTED_ROUND =
  'The provider records a plan round that started and never finished. It produced no findings and nothing awaits decisions, so a new round may be started by hand. Nothing was repeated.';

/**
 * What a gate records when its session belongs to another review. The words are Agent
 * Relay's own: a session, however it came to be reused, is not evidence about this
 * gate's specification, and nothing read from it may settle the gate.
 */
const SESSION_FOREIGN =
  'The provider session recorded for this review belongs to a different plan review of this task, so nothing read from it can be evidence about this specification. Nothing was repeated and nothing was assumed. Retry the review in a fresh review session.';

const OPENING_FOUND_ROUNDS =
  'The provider reports plan rounds in the session this review opened, although this review never sent one. Those rounds belong to something else and cannot be evidence about this specification. Nothing was repeated. Retry the review in a fresh review session.';

const NO_NEW_ROUND =
  'The provider records no plan round beyond the ones the session already held when this review opened it, so nothing it reports can be this review\'s result. Nothing was repeated and no new round may start. Resolve or close the round in the provider, or reconcile again once it appears.';

const RETRY_IN_FRESH_SESSION = 'Retry the review in a fresh review session.';

/** Why a session the provider handed back cannot host this gate's review. */
const SESSION_PROBLEMS: Record<'session_foreign' | 'session_not_fresh' | 'session_changed' | 'plan_stage_over', string> = {
  session_foreign:
    'The provider handed back a session that another plan review of this task already used, so it cannot host a review of this specification.',
  session_not_fresh:
    'The provider handed back a session that already holds plan rounds, or whose state could not be proven empty, so a new review cannot be told apart from what is already there.',
  session_changed:
    'The provider answered for a different session than the one this review recorded, so nothing was sent.',
  plan_stage_over:
    'The provider handed back a session that is already past the plan stage, so no plan round can run in it.'
};

/**
 * The Coai tool contract changed between two calls of the SAME live
 * operation — `open` and `review_plan`, or `review_plan` and `resolve` — so
 * whatever the later call produced was not proven against the contract the
 * earlier one bound. Applying it anyway would let a verdict or a resolution
 * be measured against tools that no longer mean what they meant a moment
 * ago; refusing it here, before either result reaches the gate's own
 * findings or status, is the only place that can still cost nothing.
 */
const CONTRACT_DRIFTED_MID_OPERATION =
  'The Coai server’s tool contract changed partway through this operation, so its answer was not applied. The gate stays where it was; reconcile once the server is confirmed stable.';

/**
 * What a status answer proves, or that it proves nothing.
 *
 * Every reading below is a claim about the world that some durable transition
 * depends on, which is why they are named rather than recomputed inline: the
 * one thing this recovery must never do is let two different call sites read
 * the same four fields two different ways.
 */
export type StatusReading =
  /** The fields contradict each other. Evidence of nothing, not even failure. */
  | { readonly kind: 'incoherent'; readonly reason: string }
  /** A plan round is executing right now. */
  | { readonly kind: 'running' }
  /** No plan round exists for this session at all. */
  | { readonly kind: 'no-rounds' }
  /** A finished round is waiting for decisions the status cannot show. */
  | { readonly kind: 'awaiting-decisions' }
  /** The plan gate is behind us and the provider says so on every field. */
  | { readonly kind: 'proceeded' }
  /** A finished round was resolved into a revision inside the provider. */
  | { readonly kind: 'revised' }
  /** A round started and never finished, and nothing waits on it. */
  | { readonly kind: 'interrupted' }
  /** Coherent, but it does not settle the pending round either way. */
  | { readonly kind: 'indeterminate' };

function incoherent(reason: string): StatusReading {
  return { kind: 'incoherent', reason };
}

/**
 * Read a status answer, refusing to read a self-contradictory one at all.
 *
 * The cross-field checks come first and they are fail-closed: a combination
 * that cannot describe any real session is not resolved in the caller's favour,
 * or in anyone's — it yields `incoherent`, and `incoherent` licenses no durable
 * transition whatsoever. That matters because the dangerous answers here are
 * not the malformed ones, which the adapter already rejects, but the well-typed
 * ones that are internally impossible. `awaitingResolve` with no finished round
 * is the worst of them: read field by field it looks like "nothing has run",
 * and acting on that reopens a gate whose round may be mid-flight.
 */
export function readStatus(state: ExternalPlanReviewStatus): StatusReading {
  const rounds = state.planRounds;
  const { total, running, done, interrupted } = rounds;

  // The port is an interface, not this adapter. A second implementation that
  // reported a negative or unbalanced tally would otherwise be believed.
  if (total < 0 || running < 0 || done < 0 || interrupted < 0) {
    return incoherent('a round count is negative');
  }
  if (total !== running + done + interrupted) {
    return incoherent('the round tally does not add up to the number of rounds');
  }

  // `planProceeded` and the stage are two views of one fact and must agree.
  // Past the plan stage without the flag, or the flag while the plan stage is
  // still open, is a state no session can be in.
  const pastPlanStage = state.stage !== 'PlanReview';
  if (pastPlanStage !== state.planProceeded) {
    return incoherent(`stage "${state.stage}" and planProceeded=${state.planProceeded} disagree`);
  }
  // Nothing can be past the plan gate without a plan round having finished.
  if (state.planProceeded && done === 0) {
    return incoherent('the plan stage is reported complete with no finished plan round');
  }
  // A pending decision needs a finished round behind it. Without one there is
  // nothing to decide, and "awaiting" would be describing a round that does
  // not exist — which is exactly the answer that must never read as "prepared".
  if (state.awaitingResolve && !pastPlanStage && done === 0) {
    return incoherent('decisions are awaited for a plan round that has not finished');
  }

  if (total === 0) {
    // "No round has ever run" is the strongest claim in this whole recovery,
    // because it is the only one that permits a new non-idempotent dispatch.
    // Every other field must agree with it before it is believed.
    if (state.awaitingResolve || state.planProceeded || state.stage !== 'PlanReview') {
      return incoherent('no plan round is recorded, but the session is not at the start of one');
    }
    return { kind: 'no-rounds' };
  }

  if (running > 0) return { kind: 'running' };
  if (state.awaitingResolve) return { kind: 'awaiting-decisions' };
  if (state.stage === 'CodeReview' && state.planProceeded && done > 0) {
    return { kind: 'proceeded' };
  }
  if (state.stage === 'PlanReview' && !state.planProceeded && done > 0) {
    return { kind: 'revised' };
  }
  if (done === 0 && interrupted > 0) return { kind: 'interrupted' };
  return { kind: 'indeterminate' };
}

/**
 * Map a settled provider stage onto a durable gate status.
 *
 * One function so the live `resolve` answer and a later read-back can never
 * drift into two different readings of the same external state. `null` means
 * the state does not close the pending round, which is never a failure — only
 * an absence of evidence.
 */
function settledStatus(
  stage: string,
  awaitingResolve: boolean
): 'proceeded' | 'changes_requested' | null {
  if (awaitingResolve) return null;
  if (stage === 'CodeReview') return 'proceeded';
  if (stage === 'PlanReview') return 'changes_requested';
  return null;
}

/**
 * Decisions, and the exact round they were taken against.
 *
 * The identity is not decoration: `resolve` is not idempotent, and a caller
 * that has been looking at a stale screen must be refused rather than have its
 * answers applied to whatever round happens to be current now.
 */
export interface PlanReviewResolveRequest {
  readonly gateId: string;
  readonly expectedRevision: number;
  readonly decisions: readonly PlanReviewDecision[];
  /**
   * Internal to the correction loop; the IPC schema cannot express it.
   *
   * A round with an accepted finding may only be resolved by the loop that then
   * revises the specification. Without this a caller could record "accept and
   * address", let the provider move on, and carry the unchanged specification
   * forward — the exact defect the loop exists to remove.
   */
  readonly allowAccepted?: boolean;
}

const CORRECTION_REQUIRED =
  'This round accepts at least one finding, so it must be resolved together with a revision of the plan. Resolving it alone would leave the accepted findings out of the specification.';

/**
 * The identity of one round's findings: the SHA-256 of the exact stored text.
 *
 * Every per-finding request and every merge is pinned by it, because a finding
 * is only identified by its index within one round. It is the round's content
 * identity, so it does not move when an unrelated column of the gate is written.
 */
export function planFindingsSha256(findingsJson: string): string {
  return createHash('sha256').update(findingsJson).digest('hex');
}

/**
 * The stored recommendations that still describe this gate's findings, with
 * `incoming` written over any earlier ones for the same findings.
 *
 * Merged BY FINDING INDEX rather than replaced: a per-finding analysis knows
 * nothing about its siblings, and replacing would erase what they already
 * learned. A stored set for other findings (a previous round) is dropped.
 */
export function mergeRecommendations(
  gate: Pick<PlanReviewGate, 'triageJson' | 'triageForFindings' | 'findingsJson'>,
  incoming: readonly PlanReviewTriageRecommendation[]
): PlanReviewTriageRecommendation[] {
  const existing =
    gate.triageForFindings !== null && gate.triageForFindings === gate.findingsJson
      ? (parsePlanReviewTriage(gate.triageJson)?.recommendations ?? [])
      : [];
  const replaced = new Set(incoming.map((entry) => entry.finding));
  return [...existing.filter((entry) => !replaced.has(entry.finding)), ...incoming].sort(
    (a, b) => a.finding - b.finding
  );
}

/** Names exactly one finding of exactly one round. */
export interface PlanReviewAutoDecideRequest {
  readonly gateId: string;
  readonly findingsSha256: string;
  readonly findingIndex: number;
}

export interface PlanReviewAutoDecideResult {
  readonly gate: PlanReviewGate;
  readonly outcome: PlanAutoDecideOutcome;
}

export interface PlanReviewGateDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly gates: PlanReviewGateRepository;
  readonly reviewer: ExternalPlanReviewer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Process-wide arbitration of the non-idempotent operations.
   *
   * One instance per process, shared by every service built from the container,
   * so that a second window, a direct IPC call and a remounted panel all
   * contend for the same claim rather than each holding their own.
   */
  readonly claims: PlanReviewClaims;
  /**
   * The process-wide register `Orchestrator.stop()` consults. Every claim-taking
   * entry point below registers here, so Stop reaches an operation started by any
   * IPC call, not only one that happens to share this service instance.
   * Required, not optional: a service built without it would start provider calls
   * that Stop cannot reach, silently bringing the defect back, so omitting the
   * wiring is a compile-time error.
   */
  readonly operations: TaskOperationRegistry;
  /**
   * Gives a gate that is not the task's first a review identity of its own.
   * Required, not optional: without it a corrected specification would be reviewed
   * under the task branch again, in the session the first review already finished —
   * the defect this exists to close — so omitting the wiring is a compile-time error.
   */
  readonly subjects: PlanReviewSubjectFactory;
  /** For `triage()` only — a fresh, read-only, independent analysis call. Optional
   *  so existing tests that never exercise triage need not fake it. */
  readonly codex?: Pick<CodexAdapter, 'triageFindings'>;
  readonly settings?: SettingsRepository;
}

export interface PlanReviewTriageRequest {
  readonly gateId: string;
  readonly expectedRevision: number;
  /** Exactly which findings to triage. Omitted means every finding in the round —
   *  the durable gate has no notion of "already decided" until `resolve` runs;
   *  only the renderer's local draft knows which findings are still undecided. */
  readonly findingIndexes?: readonly number[];
}


export function readBoundRuleEvidence(
  taskId: string,
  repository: TaskRuleEvidenceRepository
): RuleEvidenceSnapshot | null {
  const binding = repository.findByTask(taskId);
  if (binding === null) return null;
  const parsedBinding = taskRuleEvidenceBindingSchema.parse(binding);
  let value: unknown;
  try {
    value = JSON.parse(parsedBinding.snapshotJson);
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored rule evidence is not valid JSON.', {
      cause: error
    });
  }
  const snapshot = validateRuleEvidenceSnapshot(value);
  if (snapshot.sha256 !== parsedBinding.snapshotSha256) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored rule-evidence binding does not match its snapshot.');
  }
  return snapshot;
}

/**
 * Does the task's latest gate describe the specification it has right now?
 *
 * Answers with one of four states rather than a boolean, and the distinction
 * that matters is between `obsolete` and `unknown`. `obsolete` is a claim: both
 * identities were read and they differ, so the review really does belong to an
 * earlier specification and preparing a new one is exactly the right next step.
 * `unknown` is the absence of a claim: the binding or the specification could
 * not be read, so nothing at all was compared. Reporting the second as the
 * first tells an operator their review is stale on no evidence, and offers them
 * a preparation that cannot succeed, because it needs the very evidence that
 * could not be read.
 *
 * Computed here so no other layer has to. A renderer that recomputed these
 * hashes would be a second implementation of the approval rule, free to drift
 * from {@link assertPlanReviewAllowsApproval}, which is the one that decides.
 */
export function planReviewGateIdentity(input: {
  readonly task: Task;
  readonly gate: PlanReviewGate | null;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
}): PlanReviewGateIdentity {
  if (input.gate === null) return 'no_gate';

  let snapshot: RuleEvidenceSnapshot | null;
  try {
    snapshot = readBoundRuleEvidence(input.task.id, input.ruleEvidence);
  } catch {
    // The binding exists but its bytes no longer parse or no longer match their
    // hash. Nothing can be compared against it.
    return 'unknown';
  }
  // A gate cannot be created without a binding, so its absence here is a state
  // this application has no account of — which is not the same as staleness.
  if (snapshot === null) return 'unknown';

  let specificationSha256: string;
  try {
    specificationSha256 = specificationIdentity(input.task.specificationJson).sha256;
  } catch {
    return 'unknown';
  }

  return input.gate.specificationSha256 === specificationSha256 &&
    input.gate.ruleEvidenceSha256 === snapshot.sha256
    ? 'current'
    : 'obsolete';
}

export function assertPlanReviewAllowsApproval(input: {
  readonly task: Task;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly gates: PlanReviewGateRepository;
}): void {
  const snapshot = readBoundRuleEvidence(input.task.id, input.ruleEvidence);
  if (snapshot === null) return;
  const gate = input.gates.findByTask(input.task.id);
  const specification = specificationIdentity(input.task.specificationJson);
  if (
    gate === null ||
    gate.status !== 'proceeded' ||
    gate.specificationSha256 !== specification.sha256 ||
    gate.ruleEvidenceSha256 !== snapshot.sha256
  ) {
    throw new AgentRelayError(
      'APPROVAL_REQUIRED',
      'The specification is bound to rule evidence and has not passed its external plan review.',
      { remediation: 'Complete the plan review and resolve every finding before approving the specification.' }
    );
  }
  // "Proceeded" is only as good as the evidence it was reached from. A gate that was
  // settled by reading a session that belongs to another review has not reviewed this
  // specification at all, whatever that session says.
  if (planReviewRecovery(gate, input.gates.listByTask(input.task.id)) !== null) {
    throw new AgentRelayError(
      'APPROVAL_REQUIRED',
      'The external plan review that passed is not evidence about this specification: it was read back from a provider session that belongs to a different review.',
      { remediation: 'Retry the plan review in a fresh review session, then approve the specification.' }
    );
  }
  // Accepting a finding says it is valid; it does not put it into the
  // specification. A round that accepted something and still describes THIS
  // specification has passed with its own accepted findings uncorrected, and
  // approving it would carry them forward unaddressed.
  if (gateHasAcceptedDecisions(gate)) {
    throw new AgentRelayError(
      'APPROVAL_REQUIRED',
      'The external plan review accepted findings that the specification does not yet reflect.',
      { remediation: 'Use "Resolve and revise plan" (or "Continue correction") so the plan is revised and reviewed again before approval.' }
    );
  }
}

/** A recorded stop, reported the way a fresh one is. */
function stoppedOutcome(stop: PlanReviewTriageRecommendation): PlanAutoDecideOutcome {
  return { kind: 'needs_user', reason: stop.reason, evidenceRef: stop.evidenceRef, confidence: stop.confidence };
}

function planText(specification: TaskSpecification, snapshot: RuleEvidenceSnapshot): string {
  const text = [
    '## Specification under review',
    JSON.stringify(specification),
    '',
    '## Immutable project rule evidence',
    renderRuleEvidence(snapshot)
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAN_BYTES) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The plan and rule evidence exceed the external review budget.');
  }
  if (containsSecretShape(text)) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The plan or rule evidence contains credential-shaped text and cannot be sent to an external reviewer.'
    );
  }
  return text;
}

function subject(task: Task, repositoryPath: string): ExternalPlanReviewSubject {
  if (task.branchName === null) {
    throw new AgentRelayError(
      'WORKTREE_INVALID',
      'A unique task branch must exist before opening an external review session.'
    );
  }
  return { repositoryPath, branch: task.branchName };
}

/**
 * The identity a gate's review is run under: its own ref once it has one, the task's
 * branch for a gate that has none (every gate before the ref was recorded, and a task's
 * first). Every provider call for one gate — open, review, status, resolve — goes
 * through here, so they cannot disagree about which session they mean.
 */
function subjectOf(task: Task, repositoryPath: string, gate: Pick<PlanReviewGate, 'reviewSubject'>): ExternalPlanReviewSubject {
  const base = subject(task, repositoryPath);
  return gate.reviewSubject === null ? base : { repositoryPath, branch: gate.reviewSubject };
}

export class PlanReviewGateService {
  constructor(private readonly deps: PlanReviewGateDeps) {}

  bindRules(taskId: string, snapshotValue: unknown): ReturnType<TaskRuleEvidenceRepository['create']> {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) {
      throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    }
    if (task.status !== 'DRAFT') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'Rule evidence must be bound before specification generation starts.'
      );
    }
    const snapshot = validateRuleEvidenceSnapshot(snapshotValue);
    const existing = this.deps.ruleEvidence.findByTask(taskId);
    if (existing !== null) {
      if (existing.snapshotSha256 === snapshot.sha256) return existing;
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'Rule evidence is immutable once bound to a task.'
      );
    }
    return this.deps.ruleEvidence.create({
      taskId,
      snapshotSha256: snapshot.sha256,
      snapshotJson: JSON.stringify(snapshot),
      boundAt: this.deps.clock.nowIso()
    });
  }

  /**
   * Everything `prepare` needs, validated, with nothing written.
   *
   * Separated so the same refusals can be raised before any local Git mutation
   * happens. Preparing a task creates a branch and a worktree, and discovering
   * only afterwards that the rule evidence is missing or unreadable leaves a
   * task carrying review infrastructure it can never use — rule evidence is
   * bindable only in `DRAFT`, so the obvious repair is closed by then.
   */
  private preparable(taskId: string): {
    task: Task;
    snapshot: RuleEvidenceSnapshot;
    specificationSha256: string;
    latest: PlanReviewGate | null;
    /** The existing gate, when it already describes this exact identity. */
    reusable: PlanReviewGate | null;
  } {
    const task = this.requireReadyTask(taskId);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Bind rule evidence before preparing plan review.');
    }
    const specification = specificationIdentity(task.specificationJson);
    const latest = this.deps.gates.findByTask(taskId);
    const reusable =
      latest !== null &&
      latest.specificationSha256 === specification.sha256 &&
      latest.ruleEvidenceSha256 === snapshot.sha256
        ? latest
        : null;

    // A new specification identity would mean a new row, and the task's current
    // gate is whichever row is newest. Refusing here is what keeps the older
    // gate reachable: it stays the answer to `findByTask`, so the operator can
    // still reconcile or resolve it.
    //
    // The statuses that are NOT blocking are the ones with nothing outstanding.
    // `prepared` never dispatched anything. `proceeded` and `changes_requested`
    // are settled — the round finished and its decisions are recorded here or in
    // the provider. `interrupted` is settled too, in the only sense that
    // matters: the provider's own record says the round produced no result and
    // nothing awaits it. Superseding any of those repeats nothing and hides no
    // pending outcome, and approval is unaffected either way because it is
    // checked against the specification and rule hashes of the gate itself.
    if (
      reusable === null &&
      latest !== null &&
      SUPERSEDE_BLOCKING.includes(latest.status as (typeof SUPERSEDE_BLOCKING)[number]) &&
      // A round that provably belongs to no review of this task is not outstanding: it
      // hides nothing and doubles nothing, and refusing over it would trap the task.
      planReviewRecovery(latest, this.deps.gates.listByTask(taskId)) === null
    ) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This task's plan-review gate is "${latest.status}", which has an outstanding external round. A new specification cannot open a second gate over it.`,
        {
          remediation:
            'Reconcile the external state, or resolve the round that is awaiting decisions, before preparing a review for the regenerated specification.'
        }
      );
    }

    return { task, snapshot, specificationSha256: specification.sha256, latest, reusable };
  }

  /**
   * Refuse now, for the reasons `prepare` would refuse later — and write nothing.
   *
   * Called before the worktree is created so a refusal costs no local state.
   */
  assertPreparable(taskId: string): void {
    this.preparable(taskId);
  }

  /**
   * The gate for the task's current specification identity, created if needed.
   *
   * `inheritContractFrom` is for the correction loop: a gate for a REVISED
   * specification is a new row, and starting it without a fingerprint would let
   * a provider whose contract changed between rounds be adopted silently. The
   * previous row's fingerprint is carried over so `open` compares against it and
   * flags a difference exactly as it does for a re-opened row.
   */
  prepare(taskId: string, options: { inheritContractFrom?: PlanReviewGate | null } = {}): PlanReviewGate {
    const { snapshot, specificationSha256, reusable } = this.preparable(taskId);
    if (reusable !== null) {
      // A gate for this specification may already exist — prepared by an earlier
      // attempt or from another screen before the loop got here — without a
      // fingerprint. Reusing it as it is would let the review adopt whatever
      // contract the provider now has; the previous round's fingerprint is
      // carried onto it, so `open` compares against it as it would for a new row.
      const inherited = options.inheritContractFrom?.contractFingerprint ?? null;
      if (inherited !== null && reusable.status === 'prepared' && reusable.contractFingerprint === null) {
        return this.deps.gates.update(reusable.id, { contractFingerprint: inherited });
      }
      return reusable;
    }
    return this.deps.gates.create({
      id: this.deps.ids.next(),
      taskId,
      specificationSha256,
      ruleEvidenceSha256: snapshot.sha256,
      sessionId: null,
      serverName: null,
      serverVersion: null,
      contractFingerprint: options.inheritContractFrom?.contractFingerprint ?? null,
      contractMismatchAt: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null,
      triageJson: null,
      triageForFindings: null,
      autoDecisionsJson: null,
      // Assigned when the review is dispatched, not here: making it can take a Git call,
      // and `prepare` is a synchronous write that must stay one.
      reviewSubject: null,
      roundsAtOpen: null,
      failureKind: null,
      supersededBy: null
    });
  }

  async review(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    // Taken before anything is read or dispatched, so a refusal costs a caller
    // nothing and reaches no provider.
    return this.underOperation(
      taskId,
      'plan_review',
      true,
      () => this.deps.claims.acquire(taskId, 'review'),
      signal,
      (effective) => this.runReview(taskId, effective)
    );
  }

  /**
   * Run `body` as a registered, stoppable operation: register it (so Stop can
   * reach it), take the plan-review claim (so it cannot overlap), and release both
   * whatever happens. The registration comes first because a refusal there costs
   * nothing, and the claim is released before the registration so a task is never
   * visible as stoppable with nothing behind it.
   */
  private async underOperation<T>(
    taskId: string,
    kind: TaskOperationKind,
    exclusive: boolean,
    claim: () => () => void,
    signal: AbortSignal | undefined,
    body: (effective: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    return runAsOperation(
      this.deps.operations,
      taskId,
      kind,
      { exclusive, signal, claim, stoppedMessage: STOPPED_DURING_OPERATION },
      body
    );
  }

  /**
   * Refuse to go on when the task was stopped or is no longer where this
   * operation started. Called before every durable write that follows an awaited
   * provider call, because the signal alone is not enough: Stop writes the task's
   * status first, and a write that re-reads the task cannot outlive it.
   *
   * `dispatched` says whether an external call had already gone out. If it had,
   * its outcome is UNKNOWN and is deliberately not recorded here — the gate keeps
   * the phase it wrote before the call (`opening`, `reviewing`, `resolving`), which
   * is exactly the evidence reconciliation reads, and the message says so.
   */
  private assertStillActive(taskId: string, signal: AbortSignal | undefined, dispatched: boolean): void {
    const task = this.deps.tasks.findById(taskId);
    if (signal?.aborted === true || task?.status === 'CANCELLED') {
      throw new AgentRelayError('CANCELLED', dispatched ? STOPPED_OUTCOME_UNKNOWN : STOPPED_BEFORE_WRITE);
    }
    this.requireReadyTask(taskId);
  }

  /**
   * The note kept on a gate whose call ended with an error. When the operation was
   * stopped, what the provider threw for it is beside the point — a killed process
   * or request can throw anything — so the note says the outcome is unknown and
   * keeps the provider's own words after it.
   */
  private failureNote(error: unknown, signal: AbortSignal | undefined): string {
    const raw = error instanceof Error ? error.message : String(error);
    if (signal?.aborted === true && !raw.startsWith(STOPPED_OUTCOME_UNKNOWN)) {
      return redactAndTruncate(`${STOPPED_OUTCOME_UNKNOWN} (${raw})`, 10_000);
    }
    return redactAndTruncate(raw, 10_000);
  }

  /**
   * The unclaimed body of {@link review}. Public only for the correction loop,
   * which holds the task's exclusive claim for its whole run; any other caller
   * must use {@link review}, which takes the claim itself.
   */
  async runReview(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const specification = specificationIdentity(task.specificationJson);
    // Resolved before `prepare`, not after. A task with no isolated branch
    // cannot be reviewed at all, and discovering that after `prepare` has run
    // leaves behind a durable `prepared` gate for a review that can never
    // start — a row the screen then offers to run. Every refusal that costs
    // nothing belongs in front of the first write.
    subject(task, project.localPath);
    let gate = this.prepare(taskId);
    if (!STARTABLE_STATUSES.includes(gate.status as (typeof STARTABLE_STATUSES)[number])) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `Plan review cannot start while its durable status is "${gate.status}". ${RECONCILE_FIRST}`
      );
    }
    // An attempt whose review identity is spent, or whose session belongs to another
    // review, is replaced, never re-run: running it again would ask the same session
    // the same question and be refused the same way — or, worse, be answered.
    if (planReviewRecovery(gate, this.deps.gates.listByTask(taskId)) !== null) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This plan-review attempt cannot be continued. ${RETRY_IN_FRESH_SESSION}`,
        { remediation: 'Use "Retry in a fresh review session". Nothing is repeated, and the failed attempt stays on record.' }
      );
    }
    // Built before anything is dispatched. A refusal here — an oversized plan
    // or credential-shaped rule text — leaves the gate exactly where it was,
    // and provably without any external effect.
    const text = planText(specification.specification, snapshot);
    // Before the first write: a stop that already happened must leave the gate
    // exactly as it was, not in an `opening` phase for a call that never went out.
    this.assertStillActive(taskId, signal, false);
    // The review identity is settled before anything is dispatched, and written down: it
    // is what every later call for this gate — including a read-back after a crash —
    // must name. A local Git call at most, so a refusal here costs the provider nothing.
    const assigned = this.assignReviewSubject(task, project.localPath, gate, signal);
    // Awaited only when a Git call was needed: the common case is a plain write, and
    // yielding for it would let another caller in between two steps that were never
    // meant to be separable.
    gate = assigned instanceof Promise ? await assigned : assigned;
    this.assertStillActive(taskId, signal, false);
    const reviewSubject = subjectOf(task, project.localPath, gate);

    try {
      // The round that is starting owns this row from here on. Whatever the
      // previous round left behind — its verdict, its findings, the decisions
      // taken on them, the reviewer roster and the counts they were measured
      // against — describes a round that has ended, and leaving it in place
      // would make `opening` read as though it carried a result. `reconciledAt`
      // goes with them: the provenance of the last outcome is not the
      // provenance of this dispatch.
      gate = this.deps.gates.update(gate.id, {
        status: 'opening',
        lastError: null,
        reconciledAt: null,
        verdict: null,
        findingsJson: null,
        decisionsJson: null,
        reviewers: null,
        gatingCount: null,
        threshold: null,
        // A new round means new findings; a triage of the previous round's
        // findings describes rows that no longer exist. So do the decisions
        // Auto decide derived from it.
        triageJson: null,
        triageForFindings: null,
        autoDecisionsJson: null
      });
      const session = await this.deps.reviewer.open(reviewSubject, signal);
      // Stopped while `open` was in flight: nothing further is dispatched and
      // nothing is recorded from it. The gate stays `opening`, which is the true
      // state of knowledge, and reconciliation reads the session back.
      this.assertStillActive(taskId, signal, true);
      // `open` is idempotent, so what it returns is not necessarily new. Before the
      // non-idempotent call, prove the session can host THIS review: not another gate's,
      // not past the plan stage, and — for a first dispatch — holding no round at all.
      // Anything short of that is refused here, when nothing has been sent.
      const problem = this.sessionProblem(gate, session, this.deps.gates.listByTask(taskId));
      if (problem !== null) throw problem;
      gate = this.deps.gates.update(gate.id, {
        sessionId: session.sessionId,
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        // What the session held when this dispatch opened it, so a read-back can tell a
        // round this dispatch made from one that was already there.
        roundsAtOpen: session.planRounds === null ? null : session.planRounds.total,
        // Compared against whatever the row already held — null for a fresh
        // gate, or a previous round's fingerprint for one being re-opened —
        // so a contract that changed since the last time this task was
        // reviewed is flagged rather than silently adopted.
        ...this.contractEvidence(gate.contractFingerprint, session.contractFingerprint),
        status: 'reviewing'
      });
      const round = await this.deps.reviewer.reviewPlan(reviewSubject, text, signal);
      // Stopped while the round ran: the round may well have completed at the
      // provider, so its findings are neither applied nor called a failure. The
      // gate keeps `reviewing` — an unknown outcome to be reconciled.
      this.assertStillActive(taskId, signal, true);
      if (containsSecretShape(JSON.stringify(round))) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'The external reviewer returned credential-shaped text; the round was not persisted.'
        );
      }
      // Checked against what `open` bound moments ago, within THIS operation —
      // not against an earlier round's evidence, which `contractEvidence` above
      // already compared and merely flagged. A drift here means review_plan's
      // verdict and findings were produced under a contract this gate never
      // agreed to, so they must not be applied.
      this.assertContractStable(gate.contractFingerprint, round.contractFingerprint, gate.id);
      // Unconditional, and deliberately so. This write is not an inference
      // from a snapshot that may have gone stale — it is the call that caused
      // the new state, holding the claim that makes it the only writer. A
      // conditional write here could discard a real round's findings, which is
      // a worse outcome than any it would prevent.
      return this.deps.gates.update(gate.id, {
        serverName: round.serverName,
        serverVersion: round.serverVersion,
        status: 'awaiting_resolve',
        verdict: round.verdict,
        findingsJson: JSON.stringify(round.findings),
        decisionsJson: null,
        reviewers: round.reviewers,
        gatingCount: round.gatingCount,
        threshold: round.threshold,
        reconciledAt: null,
        lastError: null
      });
    } catch (error) {
      // Refused BEFORE a round existed — by the provider, in words it documents, or by the
      // check of the session `open` returned. Nothing was sent, so this is not an unknown
      // outcome: the attempt goes back to `prepared`, marked as spent, and is replaced by a
      // fresh identity instead of being repeated. A stop wins over this: a stopped call is
      // reported as a stop whatever it threw.
      if (error instanceof PlanReviewNotDispatchedError && signal?.aborted !== true) {
        this.deps.gates.update(gate.id, {
          status: 'prepared',
          failureKind: error.reason === 'session_foreign' ? 'foreign_session' : 'not_dispatched',
          lastError: this.failureNote(error, signal)
        });
        throw error;
      }
      // The phase stays exactly as far as the dispatch got — `opening` or
      // `reviewing`. Overwriting it with `failed` would assert the call did not
      // take effect, and nothing on this side can know that: the request left
      // the process and only its answer was lost. The phase is the evidence,
      // and reconciliation is what turns it back into knowledge.
      this.deps.gates.update(gate.id, { lastError: this.failureNote(error, signal) });
      throw asStopped(error, signal, STOPPED_OUTCOME_UNKNOWN);
    }
  }

  /**
   * The review identity for a gate that has none yet, made and written down.
   *
   * A gate that is the task's first keeps the task's branch — the identity every gate
   * has always had, recorded now so it is no longer implied. A later gate is given a ref
   * of its own, because the provider's session for the task's branch is the first
   * gate's, and by now it has been resolved. A gate that was already dispatched under the
   * old implied identity keeps it: its session is the only place its round exists.
   */
  private assignReviewSubject(
    task: Task,
    repositoryPath: string,
    gate: PlanReviewGate,
    signal: AbortSignal | undefined
  ): PlanReviewGate | Promise<PlanReviewGate> {
    if (gate.reviewSubject !== null || gate.sessionId !== null) return gate;
    const branch = subject(task, repositoryPath).branch;
    const others = this.deps.gates.listByTask(task.id).filter((entry) => entry.id !== gate.id);
    if (others.length === 0) return this.deps.gates.update(gate.id, { reviewSubject: branch });
    return this.deps.subjects
      .createIsolatedSubject(
        {
          repositoryPath,
          branch,
          gateId: gate.id,
          specificationSha256: gate.specificationSha256,
          // The row's own creation time, so the same gate always names the same subject.
          createdAt: gate.createdAt
        },
        signal
      )
      .then((isolated) => {
        // Re-checked at the write: the Git call was an await, and Stop can land in it.
        if (signal?.aborted === true) throw new AgentRelayError('CANCELLED', STOPPED_BEFORE_WRITE);
        return this.deps.gates.update(gate.id, { reviewSubject: isolated });
      });
  }

  /**
   * Can the session `open` returned host THIS gate's round? Null when it can, otherwise
   * the refusal to raise — before `review_plan`, when nothing has been sent.
   *
   * `open` is idempotent per repository and ref, so "the session came back" proves nothing
   * about it. The order below is from the most specific fact to the least:
   * it is another review's session; it is not the one this gate recorded; it is past the
   * plan stage or waiting on a resolution nobody here asked for; and — for a first dispatch —
   * it must be provably empty, because a round already in it could not be told from this
   * review's own when read back. A provider that does not report its rounds proves nothing,
   * and nothing is not accepted as "none".
   */
  private sessionProblem(
    gate: PlanReviewGate,
    session: ExternalPlanReviewSession,
    gates: readonly PlanReviewGate[]
  ): PlanReviewNotDispatchedError | null {
    const owner = planReviewSessionOwner(
      gates.filter((entry) => entry.id !== gate.id),
      session.sessionId
    );
    const problem = (reason: keyof typeof SESSION_PROBLEMS): PlanReviewNotDispatchedError =>
      new PlanReviewNotDispatchedError(reason, `${SESSION_PROBLEMS[reason]} ${RETRY_IN_FRESH_SESSION}`, {
        remediation: 'Use "Retry in a fresh review session". Nothing was sent, and nothing is repeated.'
      });
    if (owner !== null) return problem('session_foreign');
    if (gate.sessionId !== null && gate.sessionId !== session.sessionId) return problem('session_changed');
    if (session.stage !== 'PlanReview' || session.planProceeded) return problem('plan_stage_over');
    if (session.awaitingResolve) return problem('session_not_fresh');
    if (gate.sessionId === null && (session.planRounds === null || session.planRounds.total > 0)) {
      return problem('session_not_fresh');
    }
    return null;
  }

  /**
   * Replace a review whose identity cannot be used again with a new attempt under a fresh
   * one — the ONLY way out of a gate the provider refused, or one whose session belongs to
   * another review.
   *
   * What it does, and does not do:
   * - It proves the attempt is one a fresh identity may replace ({@link planReviewRecovery}).
   *   A gate whose call has an unknown outcome on a session of its own is refused: that is
   *   reconciled, never repeated.
   * - It writes ONE new gate for the SAME specification and rule evidence — the specification
   *   and its hash are not touched — with a review ref no other gate has, and marks the old
   *   attempt superseded in the same transaction. The old row keeps its status, session and
   *   error text untouched: it is evidence.
   * - It sends nothing to the provider. Reviewing is a separate, explicit step, so recovery
   *   can never start a round, and never starts implementation.
   * - If the old attempt had led to an approval, the approval is withdrawn: it rested on a
   *   review that has just been discarded.
   */
  async retryInFreshSession(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    return this.underOperation(
      taskId,
      'plan_review',
      true,
      () => this.deps.claims.acquire(taskId, 'review'),
      signal,
      (effective) => this.runRetryInFreshSession(taskId, effective)
    );
  }

  private async runRetryInFreshSession(taskId: string, signal: AbortSignal | undefined): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const specification = specificationIdentity(task.specificationJson);
    const gates = this.deps.gates.listByTask(taskId);
    const gate = gates[0] ?? null;
    if (gate === null) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There is no plan-review attempt to replace.');
    }
    const reason = planReviewRecovery(gate, gates);
    if (reason === null) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This plan-review attempt is "${gate.status}", and nothing about it proves its review identity is spent or its session foreign, so a fresh session may not replace it.`,
        {
          remediation:
            gate.status === 'opening' || gate.status === 'reviewing' || gate.status === 'resolving' || gate.status === 'failed'
              ? 'Reconcile the external state first: the call may already have taken effect.'
              : 'Nothing needs recovering.'
        }
      );
    }
    // The specification is not this operation's to change: only a gate for the SAME
    // specification and rule evidence is replaced. A moved specification is prepared the
    // ordinary way.
    if (gate.specificationSha256 !== specification.sha256 || gate.ruleEvidenceSha256 !== snapshot.sha256) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The specification changed after this review, so a fresh session for it is prepared the ordinary way.',
        { remediation: 'Prepare the plan review for the current specification.' }
      );
    }
    this.assertStillActive(taskId, signal, false);

    const id = this.deps.ids.next();
    const isolated = await this.deps.subjects.createIsolatedSubject(
      {
        repositoryPath: project.localPath,
        branch: subject(task, project.localPath).branch,
        gateId: id,
        specificationSha256: gate.specificationSha256,
        createdAt: this.deps.clock.nowIso()
      },
      signal
    );
    this.assertStillActive(taskId, signal, false);
    const fresh = this.deps.gates.supersede(gate.id, {
      id,
      taskId,
      specificationSha256: gate.specificationSha256,
      ruleEvidenceSha256: gate.ruleEvidenceSha256,
      sessionId: null,
      serverName: null,
      serverVersion: null,
      // Carried over, so a provider whose contract changed since is flagged, not adopted.
      contractFingerprint: gate.contractFingerprint,
      contractMismatchAt: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null,
      triageJson: null,
      triageForFindings: null,
      autoDecisionsJson: null,
      reviewSubject: isolated,
      roundsAtOpen: null,
      failureKind: null,
      supersededBy: null
    });
    // An approval that rested on the attempt just discarded rests on nothing.
    if (task.specificationApprovedAt !== null) {
      this.deps.tasks.update(taskId, { specificationApprovedAt: null });
    }
    return fresh;
  }

  /**
   * Read the external session back and settle an unknown outcome — read-only.
   *
   * Calls exactly one provider method, the one that changes nothing. It never
   * calls `review_plan` or `resolve`, because those may already have run. Every
   * transition below is justified by evidence the provider actually returned;
   * where the evidence does not reach, the gate keeps its unknown phase and the
   * operator is told which fact is missing.
   */
  async reconcile(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    return this.underOperation(
      taskId,
      'plan_reconcile',
      true,
      () => this.deps.claims.acquire(taskId, 'reconcile'),
      signal,
      (effective) => this.runReconcile(taskId, effective)
    );
  }

  private async runReconcile(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There is no plan-review gate to reconcile.');
    }
    if (!RECONCILABLE_STATUSES.includes(gate.status as (typeof RECONCILABLE_STATUSES)[number])) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `A gate whose durable status is "${gate.status}" has no unknown outcome to reconcile.`
      );
    }

    // The version this reading will be decided against, captured before the
    // call goes out. Everything below is an inference from a snapshot taken at
    // this moment, and none of it may be written if the moment has passed.
    const decidedAgainst = gate.revision;

    /**
     * Apply a conclusion, unless the gate moved while the provider was read.
     *
     * The whole reason reconciliation is dangerous is that it decides late: it
     * looks at a snapshot, waits on a network round trip, and then writes. If
     * the round it was reading about finished in that window, its conclusion is
     * about a world that no longer exists — and the worst of those conclusions,
     * `prepared`, would re-arm a non-idempotent dispatch over a completed
     * round. So the write is conditional on the version, and a lost race is
     * resolved by discarding this answer, never the newer state.
     */
    const settle = (patch: PlanReviewGatePatch): PlanReviewGate => {
      const applied = this.deps.gates.updateIfUnchanged(gate.id, patch, decidedAgainst);
      if (applied !== null) return applied;
      const current = this.deps.gates.findByTask(taskId);
      return current ?? gate;
    };

    // A gate whose review cannot count is not read against the provider at all: whatever
    // the provider says about its session is about another review, and the only useful
    // thing to record is why. Decided from durable rows, so it costs no call.
    const gates = this.deps.gates.listByTask(taskId);
    const known = planReviewRecovery(gate, gates);
    if (known === 'foreign_session') {
      return settle({ failureKind: 'foreign_session', lastError: redactAndTruncate(SESSION_FOREIGN, 10_000) });
    }
    if (known === 'refused_before_dispatch') {
      return settle({ failureKind: 'not_dispatched' });
    }

    let state: ExternalPlanReviewStatus;
    try {
      state = await this.deps.reviewer.status(subjectOf(task, project.localPath, gate), signal);
    } catch (error) {
      // `opening` is written before `open` is called. A positive provider answer
      // that no session exists therefore proves both that open did not take
      // effect and that review_plan was never reached. Re-arming this one phase
      // can only repeat the provider's idempotent open(repo, branch), never a
      // plan round. The same answer after `reviewing` or `resolving` proves no
      // such thing and is deliberately rethrown.
      if (gate.status === 'opening' && error instanceof AgentRelayError && error.code === 'NOT_FOUND') {
        this.assertStillActive(taskId, signal, false);
        return settle({ status: 'prepared', lastError: null });
      }
      throw error;
    }
    // A reading that arrives after a stop settles nothing: the gate keeps the
    // unknown phase it had, and the next reconciliation reads it again.
    this.assertStillActive(taskId, signal, false);

    // Classified before anything is taken from the answer, because "evidence of
    // nothing" has to include the identity the answer claims to speak for. A
    // self-contradictory reply that was allowed to write its `sessionId` into a
    // gate that had none would name the session every later reply is checked
    // against — so a malformed answer would decide which valid answers are
    // rejected as mismatches. Only a bounded diagnostic is written here; the
    // status, session, server identity, provenance and round evidence are all
    // left exactly as they were.
    const reading = readStatus(state);
    if (reading.kind === 'incoherent') {
      return settle({
        lastError: redactAndTruncate(`${INCOHERENT_STATUS} (${reading.reason})`, 10_000)
      });
    }

    // Whether the server's CURRENT contract disagrees with what this gate was
    // bound to — independent of `sessionId`, since a fingerprint never
    // encodes session identity. Shared by the session-mismatch branch below
    // and by `identity`, so a simultaneous session mismatch and contract
    // drift still durably records the drift instead of the session problem
    // silently crowding it out.
    const contractMismatchAt = (): string | null =>
      gate.contractFingerprint !== null && gate.contractFingerprint !== state.contractFingerprint
        ? this.deps.clock.nowIso()
        : null;

    // A session this gate never recorded cannot speak for it. The identity is
    // adopted only where there was none — a gate stuck in `opening` never got
    // one — and the read-back is already scoped to this repository and branch.
    if (gate.sessionId !== null && gate.sessionId !== state.sessionId) {
      return settle({
        lastError: redactAndTruncate(SESSION_MISMATCH, 10_000),
        contractMismatchAt: contractMismatchAt()
      });
    }
    // Past the identity check above, so a gate that recorded a session of its own and was
    // answered for another keeps the unknown outcome of ITS session (a mismatch, above) — that
    // round may well have run, and the gate is not replaced over it.
    //
    // What remains: a session another review of this task already used cannot speak for a
    // gate that recorded none, and neither can rounds a gate never sent. Both fail closed: the
    // state that was read is not applied, not even to say "proceeded".
    const answeredFor = planReviewSessionOwner(gates, state.sessionId);
    if (answeredFor !== null && answeredFor.id !== gate.id) {
      return settle({ failureKind: 'foreign_session', lastError: redactAndTruncate(SESSION_FOREIGN, 10_000) });
    }
    if (gate.status === 'opening' && reading.kind !== 'no-rounds') {
      // `review_plan` is sent only after `open` returned and `reviewing` was written, so a
      // gate that never left `opening` never sent a round. Rounds in its session are not its.
      return settle({ failureKind: 'foreign_session', lastError: redactAndTruncate(OPENING_FOUND_ROUNDS, 10_000) });
    }

    // `serverName`/`serverVersion`/`contractFingerprint` are deliberately
    // ABSENT from this object. `status` is a read-only PROBE of whatever
    // server answers right now — it is not the operation that reviewed this
    // gate, and reconciliation must never let it silently rewrite the
    // evidence a real `open`/`review_plan`/`resolve` call already recorded.
    // A contract that has genuinely changed since is surfaced explicitly via
    // `contractMismatchAt` below, alongside the UNCHANGED historical value —
    // never in place of it.
    const identity = {
      sessionId: gate.sessionId ?? state.sessionId,
      contractMismatchAt: contractMismatchAt()
    };

    // A dispatch's result is a round the session did not already hold. If the count did
    // not go up since this dispatch opened it, everything the read-back describes is older
    // than the dispatch — a previous round "returned by status" — and settles nothing.
    if (
      (gate.status === 'reviewing' || gate.status === 'failed') &&
      gate.roundsAtOpen !== null &&
      reading.kind !== 'no-rounds' &&
      state.planRounds.total <= gate.roundsAtOpen
    ) {
      return settle({ ...identity, lastError: NO_NEW_ROUND });
    }

    // A round still executing settles nothing at all, and is the one state in
    // which starting another would double a call that has not finished. The
    // gate keeps its phase, whatever that phase is.
    if (reading.kind === 'running') {
      return settle({ ...identity, lastError: ROUND_STILL_RUNNING });
    }

    const reconciledAt = this.deps.clock.nowIso();

    if (gate.status === 'resolving') {
      switch (reading.kind) {
        case 'awaiting-decisions':
          // The decisions never reached the round: it is still pending. The
          // findings already stored are that same round's, so the operator can
          // decide them again without anything being repeated externally.
          return settle({ ...identity, status: 'awaiting_resolve', lastError: null });
        case 'proceeded':
          return settle({ ...identity, status: 'proceeded', reconciledAt, lastError: null });
        case 'revised':
          return settle({ ...identity, status: 'changes_requested', reconciledAt, lastError: null });
        // `no-rounds` here contradicts this gate's own history — a resolution
        // was dispatched, so a round existed — and `interrupted` and
        // `indeterminate` do not say whether the decisions landed. None of them
        // may close a pending resolution in either direction.
        case 'no-rounds':
        case 'interrupted':
        case 'indeterminate':
          return settle({ ...identity, lastError: STATE_UNRECOVERABLE });
      }
    }

    switch (reading.kind) {
      case 'awaiting-decisions':
        // A round finished and its findings are not readable here. Checked
        // before anything that could re-arm a dispatch, so that a pending round
        // can never be mistaken for an absent one.
        return settle({ ...identity, lastError: FINDINGS_UNRECOVERABLE });
      case 'no-rounds':
        // What an empty round list proves depends entirely on what this gate
        // had already dispatched, and only one phase makes it conclusive.
        //
        // From `opening` it is conclusive: `review_plan` is sent only after
        // `open` returns, so a gate that never left `opening` never sent one.
        // The single call that did go out is `open`, which the provider
        // documents as idempotent per repository and branch — the same pair
        // resumes the same session rather than starting a second one — so
        // re-arming here repeats nothing that was not already repeatable.
        //
        // From `reviewing` it proves nothing of the kind. `review_plan` was
        // dispatched, and an empty list is equally consistent with "the
        // provider never accepted it" and "the provider accepted it and has
        // not recorded it yet". Reading the second as the first is precisely
        // how a non-idempotent call gets sent twice. `failed` cannot even be
        // narrowed that far: it is a legacy row whose original phase was not
        // recorded, so it may have been either.
        if (gate.status === 'opening') {
          return settle({ ...identity, status: 'prepared', lastError: null });
        }
        return settle({ ...identity, lastError: NO_TERMINAL_EVIDENCE });
      case 'proceeded':
        return settle({ ...identity, status: 'proceeded', reconciledAt, lastError: null });
      case 'revised':
        return settle({ ...identity, status: 'changes_requested', reconciledAt, lastError: null });
      case 'interrupted':
        // Started, never finished, nothing pending: no result exists to recover
        // and none is invented. Its own state, so `prepared` keeps meaning what
        // it says and the operator can see a round was really consumed.
        return settle({
          ...identity,
          status: 'interrupted',
          reconciledAt,
          lastError: INTERRUPTED_ROUND
        });
      case 'indeterminate':
        return settle({ ...identity, lastError: FINDINGS_UNRECOVERABLE });
    }
  }

  async resolve(
    taskId: string,
    request: PlanReviewResolveRequest,
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    return this.underOperation(
      taskId,
      'plan_resolve',
      true,
      () => this.deps.claims.acquire(taskId, 'resolve'),
      signal,
      (effective) => this.runResolve(taskId, request, effective)
    );
  }

  /** The unclaimed body of {@link resolve}; see {@link runReview} for who may call it. */
  async runResolve(
    taskId: string,
    request: PlanReviewResolveRequest,
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null || gate.status !== 'awaiting_resolve') {
      throw new AgentRelayError('VALIDATION_FAILED', 'No completed plan-review round awaits resolution.');
    }
    // Decisions are answers to specific findings, and a finding is only
    // identified by its index within one round. Two rounds of the same length
    // therefore accept each other's decisions perfectly — the indices line up
    // and the reasons are about the wrong findings. Naming the round the caller
    // was actually looking at is the only thing that tells them apart.
    if (gate.id !== request.gateId || gate.revision !== request.expectedRevision) {
      throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
        remediation: 'Reload the plan review and decide the findings of the current round.'
      });
    }
    const findings = parsePlanReviewFindings(gate.findingsJson);
    const decisions = z.array(planReviewDecisionSchema).max(256).parse(request.decisions);
    const decisionsJson = JSON.stringify(decisions);
    if (containsSecretShape(decisionsJson)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A plan-review decision contains credential-shaped text and cannot be sent externally.'
      );
    }
    const indexes = decisions.map((decision) => decision.finding).sort((a, b) => a - b);
    if (
      indexes.length !== findings.length ||
      indexes.some((index, position) => index !== position)
    ) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'Resolve requires exactly one decision for every finding index.'
      );
    }
    // Before anything is written or dispatched: an accepted finding may only be
    // resolved by the loop that also revises the specification.
    if (request.allowAccepted !== true && decisions.some((decision) => decision.action === 'accept')) {
      throw new AgentRelayError('VALIDATION_FAILED', CORRECTION_REQUIRED, {
        remediation: 'Use "Resolve and revise plan".'
      });
    }

    // Conditional, and the last thing before the provider is touched. The
    // check above is what gives the caller a clear reason; this is what closes
    // the window between that check and the write, so no `resolve` can be
    // dispatched for a round that stopped being current in between.
    // A stop that already happened is honoured first: no `resolving` phase is
    // written for a call that will not be made.
    this.assertStillActive(taskId, signal, false);
    const resolving = this.deps.gates.updateIfUnchanged(
      gate.id,
      { status: 'resolving', decisionsJson, lastError: null },
      request.expectedRevision
    );
    if (resolving === null) {
      throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
        remediation: 'Reload the plan review and decide the findings of the current round.'
      });
    }
    try {
      const result = await this.deps.reviewer.resolve(
        subjectOf(task, project.localPath, gate),
        decisions,
        signal
      );
      // Stopped while the resolve was in flight: it may already have been applied
      // at the provider. It is neither recorded as settled nor called a failure;
      // `resolving` stays, and reconciliation reads the truth back.
      this.assertStillActive(taskId, signal, true);
      const status = settledStatus(result.stage, result.awaitingResolve);
      if (status === null) {
        // The call was made and may well have been applied; only its meaning is
        // unclear. That is an unknown outcome, not a proven failure, so the
        // catch below keeps the `resolving` phase rather than closing it.
        throw new AgentRelayError(
          'PARSE_FAILED',
          'Coai resolve returned a state that does not close the pending plan round.'
        );
      }
      // Checked against the fingerprint `review_plan` bound onto this same
      // awaiting-resolve round — not a fresh probe's opinion. A drift here
      // means the decisions the caller made were rendered against findings
      // whose contract the provider has since moved past, so applying this
      // resolution's outcome would settle the gate on a foundation nobody
      // ever agreed to.
      this.assertContractStable(gate.contractFingerprint, result.contractFingerprint, resolving.id);
      // `reconciledAt` is cleared: this outcome was driven from here, with
      // decisions recorded in this row, and must stay distinguishable from one
      // that was only read back out of the provider.
      return this.deps.gates.update(resolving.id, {
        serverName: result.serverName,
        serverVersion: result.serverVersion,
        status,
        reconciledAt: null,
        lastError: null
      });
    } catch (error) {
      // `resolving` is kept for the same reason `reviewing` is: the decisions
      // were dispatched, and a lost answer is not evidence that they were
      // refused. Calling this "failed" would be a claim, not a fact.
      this.deps.gates.update(resolving.id, { lastError: this.failureNote(error, signal) });
      throw asStopped(error, signal, STOPPED_OUTCOME_UNKNOWN);
    }
  }

  /**
   * Codex-assisted, independent recommendations for a bounded set of
   * undecided findings — never a decision, never a resolve, never an
   * approval or a correction. A fresh, read-only Codex call every time: no
   * implementation session or tool access is reused or granted.
   */
  async triage(taskId: string, request: PlanReviewTriageRequest, signal?: AbortSignal): Promise<PlanReviewGate> {
    return this.underOperation(
      taskId,
      'plan_triage',
      true,
      () => this.deps.claims.acquire(taskId, 'triage'),
      signal,
      (effective) => this.runTriage(taskId, request, effective)
    );
  }

  private async runTriage(
    taskId: string,
    request: PlanReviewTriageRequest,
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    if (!this.deps.codex || !this.deps.settings) {
      throw new AgentRelayError('TOOL_MISSING', 'Automatic finding triage is not configured in this build.');
    }
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null || gate.status !== 'awaiting_resolve') {
      throw new AgentRelayError('VALIDATION_FAILED', 'No completed plan-review round awaits decisions.');
    }
    if (gate.id !== request.gateId || gate.revision !== request.expectedRevision) {
      throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
        remediation: 'Reload the plan review and try again against the current round.'
      });
    }

    const findings = parsePlanReviewFindings(gate.findingsJson);
    const requestedIndexes = [...new Set(request.findingIndexes ?? findings.map((_, index) => index))].sort((a, b) => a - b);
    if (requestedIndexes.length === 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There are no findings to analyze.');
    }
    if (requestedIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= findings.length)) {
      throw new AgentRelayError('VALIDATION_FAILED', 'One or more requested finding indexes do not exist in the current round.');
    }

    const validated = await this.analyzeFindings(task, project.localPath, findings, requestedIndexes, signal);
    // A result that arrives after a stop is discarded, not stored.
    this.assertStillActive(taskId, signal, false);

    // `triageForFindings` is set to the exact `findingsJson` this analysis
    // was computed against — captured before the Codex call, and never a
    // revision number: `revision` bumps on every durable write to this row,
    // including this one, so predicting a post-write value would couple this
    // service to the repository's own bump-by-one implementation, and any
    // OTHER field changing later would make a still-valid result look stale.
    // The conditional write itself still guards against the gate moving
    // (another decision, a new round, a resolve) while the Codex call was in
    // flight — if it did, `gate.revision` is no longer current and the write
    // is refused, discarding the analysis rather than applying it to
    // evidence that may no longer describe the current round.
    const applied = this.deps.gates.updateIfUnchanged(
      gate.id,
      {
        triageJson: JSON.stringify({
          recommendations: mergeRecommendations(gate, validated.recommendations)
        }),
        triageForFindings: gate.findingsJson
      },
      gate.revision
    );
    if (applied === null) {
      throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
        remediation: 'The round changed while the analysis was running. Reload and try again.'
      });
    }
    return applied;
  }

  /**
   * One fresh, read-only Codex analysis of the named findings, validated.
   *
   * Reads everything it sends from durable state; the caller supplies only which
   * findings. Returns the validated recommendations — nothing is written here.
   */
  private async analyzeFindings(
    task: Task,
    projectPath: string,
    findings: ReturnType<typeof parsePlanReviewFindings>,
    requestedIndexes: readonly number[],
    signal?: AbortSignal
  ): Promise<PlanReviewTriageResult> {
    if (!this.deps.codex || !this.deps.settings) {
      throw new AgentRelayError('TOOL_MISSING', 'Automatic finding triage is not configured in this build.');
    }
    const snapshot = readBoundRuleEvidence(task.id, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const specification = specificationIdentity(task.specificationJson);

    const triageableFindings: TriageableFinding<number>[] = requestedIndexes.map((index) => {
      const finding = findings[index]!;
      return {
        ref: index,
        severity: finding.severity,
        category: finding.category,
        file: finding.file.length > 0 ? finding.file : null,
        line: finding.line,
        title: finding.title,
        body: finding.why,
        fix: finding.fix
      };
    });

    const settings = this.deps.settings.get();
    const context: AgentRunContext = {
      signal: signal ?? new AbortController().signal,
      timeoutMs: settings.processTimeoutMs,
      onProgress: () => undefined
    };

    const outcome = await this.deps.codex.triageFindings(
      {
        // A plan gate's findings are named by index, so the model is held to
        // JSON numbers; a string reference would fail `validateTriageOutcome`.
        refKind: 'index',
        worktreePath: projectPath,
        specification: specification.specification,
        ruleEvidence: renderRuleEvidence(snapshot),
        findings: triageableFindings,
        priorDecisions: [],
        model: settings.codexModel
      },
      context
    );

    return this.validateTriageOutcome(outcome.recommendations, requestedIndexes);
  }

  /**
   * Analyze ONE finding with Codex and, for accept/reject, put the decision
   * into the round's durable draft — one click, no second "apply" step.
   *
   * It never resolves anything: only `resolve` sends decisions to the provider.
   * Several different findings may be analyzed at once (the claim is per
   * finding); the same finding twice, or any dispatching operation, is refused.
   */
  async autoDecide(
    taskId: string,
    request: PlanReviewAutoDecideRequest,
    signal?: AbortSignal
  ): Promise<PlanReviewAutoDecideResult> {
    // Shared, like its claim: several different findings may be analyzed at once,
    // and a stop reaches every one of them.
    return this.underOperation(
      taskId,
      'plan_auto_decide',
      false,
      () => this.deps.claims.acquireFinding(taskId, request.findingIndex),
      signal,
      (effective) => this.runAutoDecide(taskId, request, effective)
    );
  }

  /** The unclaimed body of {@link autoDecide}; the caller holds a claim that excludes overlap. */
  async runAutoDecide(
    taskId: string,
    request: PlanReviewAutoDecideRequest,
    signal?: AbortSignal
  ): Promise<PlanReviewAutoDecideResult> {
    if (!this.deps.codex || !this.deps.settings) {
      throw new AgentRelayError('TOOL_MISSING', 'Automatic finding triage is not configured in this build.');
    }
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null || gate.status !== 'awaiting_resolve') {
      throw new AgentRelayError('VALIDATION_FAILED', 'No completed plan-review round awaits decisions.');
    }
    this.assertSameRound(gate, request);
    const findings = parsePlanReviewFindings(gate.findingsJson);
    if (
      !Number.isInteger(request.findingIndex) ||
      request.findingIndex < 0 ||
      request.findingIndex >= findings.length
    ) {
      throw new AgentRelayError('VALIDATION_FAILED', 'That finding does not exist in the current round.');
    }

    // A request repeated after the first one committed — a refresh, a second
    // window, a click after a lost answer — must not run a second analysis that
    // could contradict the saved one. The saved decision is the answer; the
    // operator overrides it by deciding the finding themselves, not by asking again.
    const saved = this.savedAutoDecision(gate, request.findingIndex);
    if (saved !== null) return { gate, outcome: { kind: 'decided', decision: saved } };
    // Likewise a stop: once automation has stopped on a finding of this round because
    // it needs a person, asking again cannot turn that into an automatic decision.
    // The operator decides it; nothing is re-analyzed on their behalf.
    const stopped = this.savedStop(gate, request.findingIndex);
    if (stopped !== null) return { gate, outcome: stoppedOutcome(stopped) };

    // A stopped task dispatches nothing, and a result that arrives after a stop is
    // dropped: no automatic decision or stop is recorded for a task that has ended.
    this.assertStillActive(taskId, signal, false);
    const validated = await this.analyzeFindings(task, project.localPath, findings, [request.findingIndex], signal);
    this.assertStillActive(taskId, signal, false);
    const recommendation = validated.recommendations[0]!;

    // Persisted in ONE synchronous read-modify-write: nothing here awaits, so
    // two per-finding results finishing together cannot interleave inside this
    // process, and the round identity (not the revision, which every sibling's
    // result bumps) is what decides whether the answer still applies. Another
    // process writing between the read and the conditional write makes it
    // return null, and the merge is simply redone against the newer row.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.deps.gates.findByTask(taskId);
      if (current === null || current.status !== 'awaiting_resolve') break;
      try {
        this.assertSameRound(current, request);
      } catch {
        break;
      }
      // Written by another process while this analysis ran: the first saved answer stands.
      const winner = this.savedAutoDecision(current, request.findingIndex);
      if (winner !== null) return { gate: current, outcome: { kind: 'decided', decision: winner } };
      const halted = this.savedStop(current, request.findingIndex);
      if (halted !== null) return { gate: current, outcome: stoppedOutcome(halted) };
      const merged = this.mergeAutoResult(current, recommendation);
      const applied = this.deps.gates.updateIfUnchanged(current.id, merged.patch, current.revision);
      if (applied !== null) return { gate: applied, outcome: merged.outcome };
    }
    throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
      remediation: 'The round changed while the analysis was running. Reload and analyze the current round.'
    });
  }

  /** The automatic decision already saved for this finding of this round, if any. */
  private savedAutoDecision(gate: PlanReviewGate, findingIndex: number): PlanReviewAutoDecision | null {
    if (gate.findingsJson === null) return null;
    return (
      parsePlanReviewAutoDecisions(gate.autoDecisionsJson, planFindingsSha256(gate.findingsJson)).find(
        (decision) => decision.finding === findingIndex
      ) ?? null
    );
  }

  /** The stop Auto decide already recorded for this finding of this round, if any. */
  private savedStop(gate: PlanReviewGate, findingIndex: number): PlanReviewTriageRecommendation | null {
    if (gate.findingsJson === null || gate.triageForFindings !== gate.findingsJson) return null;
    return (
      parsePlanReviewTriage(gate.triageJson)?.recommendations.find(
        (entry) => entry.finding === findingIndex && entry.recommendation === 'needs_user'
      ) ?? null
    );
  }

  /** The gate is the round the caller named: same row, same findings. */
  private assertSameRound(gate: PlanReviewGate, request: PlanReviewAutoDecideRequest): void {
    if (
      gate.id !== request.gateId ||
      gate.findingsJson === null ||
      planFindingsSha256(gate.findingsJson) !== request.findingsSha256
    ) {
      throw new AgentRelayError('VALIDATION_FAILED', STALE_ROUND, {
        remediation: 'Reload the plan review and analyze the findings of the current round.'
      });
    }
  }

  /**
   * Fold one recommendation into a gate's stored triage and auto decisions,
   * without disturbing what other findings already have.
   */
  private mergeAutoResult(
    gate: PlanReviewGate,
    recommendation: PlanReviewTriageRecommendation
  ): { patch: PlanReviewGatePatch; outcome: PlanAutoDecideOutcome } {
    const findingsJson = gate.findingsJson as string;
    const sha = planFindingsSha256(findingsJson);
    const retained = parsePlanReviewAutoDecisions(gate.autoDecisionsJson, sha).filter(
      (decision) => decision.finding !== recommendation.finding
    );

    let decisions = retained;
    let outcome: PlanAutoDecideOutcome;
    if (recommendation.recommendation === 'needs_user') {
      // Only reached for a finding with no saved decision (see `savedAutoDecision`),
      // so nothing is lost: the analysis stopped on purpose and says so.
      outcome = {
        kind: 'needs_user',
        reason: recommendation.reason,
        evidenceRef: recommendation.evidenceRef,
        confidence: recommendation.confidence
      };
    } else {
      const decision: PlanReviewAutoDecision = {
        finding: recommendation.finding,
        action: recommendation.recommendation,
        reason: `Auto-decided by Codex triage (${recommendation.confidence} confidence): ${recommendation.reason} Evidence: ${recommendation.evidenceRef}`,
        evidenceRef: recommendation.evidenceRef,
        confidence: recommendation.confidence,
        decidedAt: this.deps.clock.nowIso()
      };
      if (containsSecretShape(JSON.stringify(decision))) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The analysis contained credential-shaped text and was not stored.'
        );
      }
      decisions = [...retained, decision].sort((a, b) => a.finding - b.finding);
      outcome = { kind: 'decided', decision };
    }

    return {
      outcome,
      patch: {
        triageJson: JSON.stringify({ recommendations: mergeRecommendations(gate, [recommendation]) }),
        triageForFindings: findingsJson,
        autoDecisionsJson: JSON.stringify({ forFindingsSha256: sha, decisions })
      }
    };
  }

  /**
   * Fails closed on anything short of exactly one well-formed recommendation
   * per requested finding index: a partial response, an unrequested ref, a
   * duplicate, or a malformed shape all discard the WHOLE result rather than
   * applying whatever parsed. A partial automatic triage silently presented
   * as complete is worse than none.
   */
  private validateTriageOutcome(
    recommendations: readonly FindingTriageRecommendation[],
    requestedIndexes: readonly number[]
  ): PlanReviewTriageResult {
    const parsed = planReviewTriageResultSchema.safeParse({
      recommendations: recommendations.map((entry) => ({
        finding: entry.findingRef,
        recommendation: entry.recommendation,
        reason: entry.reason,
        evidenceRef: entry.evidenceRef,
        confidence: entry.confidence
      }))
    });
    if (!parsed.success) {
      throw new AgentRelayError('PARSE_FAILED', 'Codex returned recommendations that do not match the expected shape.');
    }
    const seen = new Set<number>();
    for (const recommendation of parsed.data.recommendations) {
      if (!requestedIndexes.includes(recommendation.finding)) {
        throw new AgentRelayError('PARSE_FAILED', 'Codex returned a recommendation for a finding that was not requested.');
      }
      if (seen.has(recommendation.finding)) {
        throw new AgentRelayError('PARSE_FAILED', 'Codex returned more than one recommendation for the same finding.');
      }
      seen.add(recommendation.finding);
    }
    if (seen.size !== requestedIndexes.length) {
      throw new AgentRelayError('PARSE_FAILED', 'Codex did not return a recommendation for every requested finding.');
    }
    return parsed.data;
  }

  /**
   * The fields a LIVE dispatch (`open`, `review_plan`, `resolve` — never a
   * read-only `status` probe; see `runReconcile`) writes for the contract it
   * just proved: the fresh fingerprint always replaces the old one, because a
   * live call is genuinely new evidence, but `contractMismatchAt` is set
   * explicitly whenever it disagrees with what was already recorded rather
   * than the disagreement being silently absorbed.
   */
  private contractEvidence(
    previous: string | null,
    fresh: string
  ): { contractFingerprint: string; contractMismatchAt: string | null } {
    return {
      contractFingerprint: fresh,
      contractMismatchAt: previous !== null && previous !== fresh ? this.deps.clock.nowIso() : null
    };
  }

  /**
   * Refuses to let a later call's answer settle the gate when the contract it
   * was just proven against is not the one an earlier call in this SAME
   * operation already bound.
   *
   * `bound` is null only when nothing has bound a contract yet, which cannot
   * happen at either call site below — both run after `contractEvidence` has
   * already written a fresh, non-null fingerprint moments earlier in the same
   * operation — but a null is treated as nothing to compare against rather
   * than assumed impossible, matching `contractEvidence`'s own leniency.
   *
   * Records the drift durably (without touching the ORIGINAL fingerprint —
   * the update patch below omits it on purpose) and throws, so the caller's
   * outer catch leaves the gate exactly where the dispatch got to. That is
   * `runReview`'s `reviewing` or `runResolve`'s `resolving`: unresolved,
   * available to `reconcile`, and never silently advanced on a foundation the
   * gate never agreed to.
   */
  private assertContractStable(bound: string | null, fresh: string, gateId: string): void {
    if (bound === null || bound === fresh) return;
    this.deps.gates.update(gateId, {
      contractMismatchAt: this.deps.clock.nowIso(),
      lastError: redactAndTruncate(CONTRACT_DRIFTED_MID_OPERATION, 10_000)
    });
    throw new AgentRelayError('VALIDATION_FAILED', CONTRACT_DRIFTED_MID_OPERATION, {
      remediation: 'Confirm the Coai server is stable, then reconcile or start a new review.'
    });
  }

  private requireReadyTask(taskId: string): Task {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'External plan review is available only after specification generation and before implementation.'
      );
    }
    return task;
  }
}
