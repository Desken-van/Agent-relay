/** Optional, durable external plan-review gate. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Task } from '../../shared/domain/models';
import {
  parsePlanReviewFindings,
  planReviewDecisionSchema,
  taskRuleEvidenceBindingSchema,
  type PlanReviewDecision,
  type PlanReviewGate
} from '../../shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../shared/domain/rule-evidence';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import { taskSpecificationSchema, type TaskSpecification } from '../../shared/schemas/codex';
import type {
  Clock,
  ExternalPlanReviewer,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject,
  IdGenerator,
  PlanReviewGatePatch,
  PlanReviewGateRepository,
  ProjectRepository,
  TaskRepository,
  TaskRuleEvidenceRepository
} from '../ports';
import type { PlanReviewClaims } from './plan-review-claims';
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

const INTERRUPTED_ROUND =
  'The provider records a plan round that started and never finished. It produced no findings and nothing awaits decisions, so a new round may be started by hand. Nothing was repeated.';

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
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function specificationIdentity(raw: string | null): {
  specification: TaskSpecification;
  canonical: string;
  sha256: string;
} {
  if (raw === null) {
    throw new AgentRelayError('VALIDATION_FAILED', 'This task has no specification to review.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored specification is not valid JSON.', {
      cause: error
    });
  }
  const specification = taskSpecificationSchema.parse(value);
  const canonical = JSON.stringify(specification);
  return { specification, canonical, sha256: hash(canonical) };
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

  prepare(taskId: string): PlanReviewGate {
    const task = this.requireReadyTask(taskId);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Bind rule evidence before preparing plan review.');
    }
    const specification = specificationIdentity(task.specificationJson);
    const latest = this.deps.gates.findByTask(taskId);
    if (
      latest !== null &&
      latest.specificationSha256 === specification.sha256 &&
      latest.ruleEvidenceSha256 === snapshot.sha256
    ) {
      return latest;
    }
    return this.deps.gates.create({
      id: this.deps.ids.next(),
      taskId,
      specificationSha256: specification.sha256,
      ruleEvidenceSha256: snapshot.sha256,
      sessionId: null,
      serverName: null,
      serverVersion: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null
    });
  }

  async review(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    // Taken before anything is read or dispatched, so a refusal costs a caller
    // nothing and reaches no provider.
    const release = this.deps.claims.acquire(taskId, 'review');
    try {
      return await this.runReview(taskId, signal);
    } finally {
      release();
    }
  }

  private async runReview(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const specification = specificationIdentity(task.specificationJson);
    let gate = this.prepare(taskId);
    if (!STARTABLE_STATUSES.includes(gate.status as (typeof STARTABLE_STATUSES)[number])) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `Plan review cannot start while its durable status is "${gate.status}". ${RECONCILE_FIRST}`
      );
    }
    const reviewSubject = subject(task, project.localPath);
    // Built before anything is dispatched. A refusal here — an oversized plan,
    // credential-shaped rule text, a task without a branch — leaves the gate
    // exactly where it was, and provably without any external effect.
    const text = planText(specification.specification, snapshot);

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
        threshold: null
      });
      const session = await this.deps.reviewer.open(reviewSubject, signal);
      gate = this.deps.gates.update(gate.id, {
        sessionId: session.sessionId,
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        status: 'reviewing'
      });
      const round = await this.deps.reviewer.reviewPlan(reviewSubject, text, signal);
      if (containsSecretShape(JSON.stringify(round))) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'The external reviewer returned credential-shaped text; the round was not persisted.'
        );
      }
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
      // The phase stays exactly as far as the dispatch got — `opening` or
      // `reviewing`. Overwriting it with `failed` would assert the call did not
      // take effect, and nothing on this side can know that: the request left
      // the process and only its answer was lost. The phase is the evidence,
      // and reconciliation is what turns it back into knowledge.
      this.deps.gates.update(gate.id, {
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }
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
    const release = this.deps.claims.acquire(taskId, 'reconcile');
    try {
      return await this.runReconcile(taskId, signal);
    } finally {
      release();
    }
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
    const state = await this.deps.reviewer.status(subject(task, project.localPath), signal);

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

    // A session this gate never recorded cannot speak for it. The identity is
    // adopted only where there was none — a gate stuck in `opening` never got
    // one — and the read-back is already scoped to this repository and branch.
    if (gate.sessionId !== null && gate.sessionId !== state.sessionId) {
      return settle({ lastError: redactAndTruncate(SESSION_MISMATCH, 10_000) });
    }
    const identity = {
      sessionId: gate.sessionId ?? state.sessionId,
      serverName: state.serverName,
      serverVersion: state.serverVersion
    };

    const reading = readStatus(state);

    // An answer that contradicts itself is not weak evidence to be resolved
    // generously; it is evidence of nothing. It settles no phase, permits no
    // dispatch, and above all does not trigger a retry of the external call.
    if (reading.kind === 'incoherent') {
      return settle({
        ...identity,
        lastError: redactAndTruncate(`${INCOHERENT_STATUS} (${reading.reason})`, 10_000)
      });
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
        // Proven by the provider's own record, and cross-checked against every
        // other field before it got this far: no plan round exists for this
        // session, so dispatching one now repeats nothing.
        return settle({ ...identity, status: 'prepared', lastError: null });
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
    decisionsValue: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    const release = this.deps.claims.acquire(taskId, 'resolve');
    try {
      return await this.runResolve(taskId, decisionsValue, signal);
    } finally {
      release();
    }
  }

  private async runResolve(
    taskId: string,
    decisionsValue: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null || gate.status !== 'awaiting_resolve') {
      throw new AgentRelayError('VALIDATION_FAILED', 'No completed plan-review round awaits resolution.');
    }
    const findings = parsePlanReviewFindings(gate.findingsJson);
    const decisions = z.array(planReviewDecisionSchema).max(256).parse(decisionsValue);
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

    const resolving = this.deps.gates.update(gate.id, {
      status: 'resolving',
      decisionsJson,
      lastError: null
    });
    try {
      const result = await this.deps.reviewer.resolve(
        subject(task, project.localPath),
        decisions,
        signal
      );
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
      this.deps.gates.update(resolving.id, {
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }
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
