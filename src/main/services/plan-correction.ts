/**
 * The plan-correction loop: external plan review that actually changes the plan.
 *
 * ```
 * round awaits decisions ──resolve──▶ settled round ──accepted findings──▶ Codex revises
 *        ▲                                                                       │
 *        │                                                          new immutable specification version
 *   Auto decide (Codex triage)                                                   │
 *        └──── fresh external plan review ◀── prepare a gate for the revised hash ┘
 * ```
 *
 * The loop owns no state of its own. Every step is derived from durable rows —
 * the gate, its decisions, the correction row for that gate, the task's
 * specification — by {@link planCorrectionNextStep}, so a crash, a restart or a
 * second window simply resumes from what is recorded. What makes it safe:
 *
 * - **Coai is never repeated blindly.** `resolve` and `review_plan` keep their
 *   existing `resolving`/`reviewing` durable phases; a gate left in one of them
 *   makes the next step `reconcile`, and the loop stops there.
 * - **The Codex revision is repeatable because it commits atomically.** It has no
 *   external effect until `PlanCorrectionRepository.complete` runs, which swaps
 *   the specification (compare-and-swap), appends the version and closes the
 *   correction in one transaction. A crash before that leaves a `running` row,
 *   read as `interrupted`; retrying reopens the SAME row (UNIQUE source gate), so
 *   there is never a second correction, version or review round for one gate.
 * - **It never approves, and never advances past an accepted finding.**
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Task } from '../../shared/domain/models';
import {
  parseAcceptedPlanFindings,
  parsePlanRevisionAddressed,
  planCorrectionNextStep,
  revisionAddressesProblem,
  type AcceptedPlanFinding,
  type PlanAdvanceOutcome,
  type PlanAdvanceStop,
  type PlanCorrection,
  type PlanCorrectionDetail,
  type PlanCorrectionNextStep,
  type PlanRevisionAddressed
} from '../../shared/domain/plan-correction';
import {
  parsePlanReviewAutoDecisions,
  parsePlanReviewDecisions,
  parsePlanReviewFindings,
  type PlanReviewDecision,
  type PlanReviewGate
} from '../../shared/domain/plan-review';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import type {
  AgentRunContext,
  Clock,
  CodexAdapter,
  EventPublisher,
  IdGenerator,
  PlanCorrectionRepository,
  PlanReviewGateRepository,
  ProjectRepository,
  SettingsRepository,
  TaskRepository,
  TaskRuleEvidenceRepository
} from '../ports';
import type { PlanReviewClaims } from './plan-review-claims';
import type { TaskOperationRegistry } from './task-operations';
import {
  planFindingsSha256,
  planReviewGateIdentity,
  readBoundRuleEvidence,
  type PlanReviewGateService
} from './plan-review-gate';
import { renderRuleEvidence } from './rule-evidence';
import { specificationIdentity } from './specification-identity';

const MAX_SPECIFICATION_BYTES = 1_500_000;
/** A hard ceiling on loop iterations. The real bound is the correction budget; this only guards a logic error. */
const MAX_LOOP_STEPS = 64;
/** How many findings of one round are analyzed at once. */
const AUTO_DECIDE_CONCURRENCY = 3;

export interface PlanResolveAndReviseRequest {
  readonly gateId: string;
  readonly expectedRevision: number;
  readonly decisions: readonly PlanReviewDecision[];
  /** Keep going through further rounds while every finding can be auto-decided. */
  readonly autoContinue: boolean;
}

export interface PlanCorrectionDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly gates: PlanReviewGateRepository;
  readonly corrections: PlanCorrectionRepository;
  /** Built over the SAME claims object as this service; the loop drives its unclaimed steps. */
  readonly gateService: PlanReviewGateService;
  readonly codex: Pick<CodexAdapter, 'reviseSpecification'>;
  readonly settings: SettingsRepository;
  readonly claims: PlanReviewClaims;
  /**
   * The process-wide register of stoppable operations — the SAME instance the
   * orchestrator's `stop()` reads. Required, not optional: a loop that could not
   * be stopped would be the defect this exists to prevent.
   */
  readonly operations: TaskOperationRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events?: EventPublisher;
}

interface DerivedState {
  readonly task: Task;
  readonly gate: PlanReviewGate | null;
  readonly correctionForGate: PlanCorrection | null;
  readonly all: readonly PlanCorrection[];
  readonly next: PlanCorrectionNextStep;
  readonly max: number;
}

/**
 * Run `work` over `items` with at most `limit` in flight; every item that starts
 * settles, none is skipped on failure. Once `stopped()` is true no further item is
 * DISPATCHED (those already running finish on their own), and the result holds only
 * the items that ran.
 */
async function settleAll<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
  stopped: () => boolean = () => false
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length && !stopped()) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results.filter((entry) => entry !== undefined);
}

/** The dependencies the read side needs — no Codex, no Coai. */
export type PlanCorrectionReadDeps = Pick<
  PlanCorrectionDeps,
  'tasks' | 'gates' | 'corrections' | 'ruleEvidence' | 'settings' | 'claims'
>;

const budgetSpentMessage = (max: number): string =>
  `The correction budget of ${max} round(s) is spent, so accepted findings could not be revised.`;

function deriveState(deps: PlanCorrectionReadDeps, taskId: string): DerivedState {
  const task = deps.tasks.findById(taskId);
  if (task === null) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
  const gate = deps.gates.findByTask(taskId);
  const all = deps.corrections.listByTask(taskId);
  const correctionForGate = gate === null ? null : deps.corrections.findBySourceGate(gate.id);
  const max = deps.settings.get().maxReviewRounds;
  const next = planCorrectionNextStep({
    gate,
    identity: planReviewGateIdentity({ task, gate, ruleEvidence: deps.ruleEvidence }),
    correctionForGate,
    used: all.filter((entry) => entry.id !== correctionForGate?.id).length,
    max
  });
  return { task, gate, correctionForGate, all, next, max };
}

/**
 * What `planReview:get` reports about the correction workflow. Read-only, and a
 * plain function so the IPC layer can call it without building the service.
 */
export function describePlanCorrection(deps: PlanCorrectionReadDeps, taskId: string): PlanCorrectionDetail {
  const { gate, all, next, max } = deriveState(deps, taskId);
  const latest = all.at(-1) ?? null;
  const loop = deps.claims.loopOf(taskId);
  // A `running` row with no live loop in this process is a crash's leftover.
  const interrupted = latest?.status === 'running' && deps.claims.heldBy(taskId) !== 'advance';

  let acceptedCount = 0;
  const titles = new Map<number, string>();
  if (latest !== null) {
    try {
      const accepted = parseAcceptedPlanFindings(latest.acceptedJson);
      acceptedCount = accepted.length;
      for (const entry of accepted) titles.set(entry.finding, entry.title);
    } catch {
      acceptedCount = 0;
    }
  }
  let acceptedPending = 0;
  if (gate !== null && (next === 'revise' || next === 'round_limit')) {
    acceptedPending = parsePlanReviewDecisions(gate.decisionsJson).filter(
      (decision) => decision.action === 'accept'
    ).length;
  }

  return {
    used: all.length,
    max,
    nextStep: next,
    loop,
    latest:
      latest === null
        ? null
        : {
            round: latest.round,
            status: interrupted ? 'interrupted' : latest.status,
            attempts: latest.attempts,
            lastError: latest.lastError,
            acceptedCount,
            addressed: parsePlanRevisionAddressed(latest.addressedJson).map((entry) => ({
              ...entry,
              title: titles.get(entry.finding) ?? `Finding ${entry.finding}`
            }))
          },
    acceptedPending,
    versions: deps.corrections.listVersions(taskId).map((version) => ({
      version: version.version,
      specificationSha256: version.specificationSha256,
      origin: version.origin,
      createdAt: version.createdAt
    }))
  };
}

export class PlanCorrectionService {
  constructor(private readonly deps: PlanCorrectionDeps) {}

  /* ------------------------------------------------------------------------ */
  /* Reading                                                                   */
  /* ------------------------------------------------------------------------ */

  private derive(taskId: string): DerivedState {
    return deriveState(this.deps, taskId);
  }

  /** What `planReview:get` reports about the correction workflow. Read-only. */
  detail(taskId: string): PlanCorrectionDetail {
    return describePlanCorrection(this.deps, taskId);
  }

  /* ------------------------------------------------------------------------ */
  /* Entry points                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * Record the decisions for the round on screen, and carry them through:
   * resolve (Coai), and — when anything was accepted — revise the specification
   * (Codex) and start a fresh external review of it.
   */
  async resolveAndRevise(
    taskId: string,
    request: PlanResolveAndReviseRequest,
    signal?: AbortSignal
  ): Promise<PlanAdvanceOutcome> {
    return this.drive(taskId, request.autoContinue, request, signal);
  }

  /**
   * Resume from durable state: retry a failed or interrupted correction, run the
   * review a completed correction is waiting for, or (for a round resolved
   * before this loop existed) revise the plan from its accepted decisions.
   */
  async continueCorrection(
    taskId: string,
    options: { autoContinue: boolean },
    signal?: AbortSignal
  ): Promise<PlanAdvanceOutcome> {
    return this.drive(taskId, options.autoContinue, null, signal);
  }

  /* ------------------------------------------------------------------------ */
  /* The loop                                                                  */
  /* ------------------------------------------------------------------------ */

  private async drive(
    taskId: string,
    autoContinue: boolean,
    initial: PlanResolveAndReviseRequest | null,
    callerSignal?: AbortSignal
  ): Promise<PlanAdvanceOutcome> {
    // Registered as a stoppable operation BEFORE any provider work, in the
    // process-wide register `Orchestrator.stop()` reads. Its signal is the ONE
    // signal every step below observes — the caller's own is linked to it — and it
    // is removed in the `finally`, whatever happens.
    const operation = this.deps.operations.begin(taskId, 'plan_correction', {
      exclusive: true,
      signal: callerSignal
    });
    const signal = operation.signal;
    // One exclusive claim for the whole run: nothing else may touch this task's
    // plan review between two of these steps. (Ownership, not cancellation: the
    // claim and the registration answer different questions and both are kept.)
    let release: () => void;
    try {
      release = this.deps.claims.acquire(taskId, 'advance');
    } catch (error) {
      operation.release();
      throw error;
    }
    let correctionsRun = 0;
    let roundsReviewed = 0;
    const outcome = (stopped: PlanAdvanceStop, message: string): PlanAdvanceOutcome => ({
      stopped,
      message,
      correctionsRun,
      roundsReviewed
    });

    try {
      let pending = initial;
      for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
        // Before every step, so a stop that landed while the previous one was in
        // flight ends the loop here — no further provider call, no further write.
        this.assertActive(taskId, signal);
        const state = this.derive(taskId);
        const round = state.all.length;

        if (pending !== null) {
          const request = pending;
          pending = null;
          // Before anything is sent: accepted findings the budget cannot revise
          // must not be recorded with the external reviewer as if they could be.
          if (request.decisions.some((decision) => decision.action === 'accept') && state.all.length >= state.max) {
            throw new AgentRelayError('VALIDATION_FAILED', budgetSpentMessage(state.max), {
              remediation: 'Reject the findings you do not want revised, or raise the maximum review rounds in Settings, then resolve again.'
            });
          }
          this.deps.claims.setLoop(taskId, { phase: 'resolving', round });
          await this.deps.gateService.runResolve(
            taskId,
            {
              gateId: request.gateId,
              expectedRevision: request.expectedRevision,
              decisions: request.decisions,
              allowAccepted: true
            },
            signal
          );
          continue;
        }

        switch (state.next) {
          case 'decide': {
            const gate = state.gate as PlanReviewGate;
            if (gate.verdict === 'call_human' || gate.verdict === 'escalated') {
              return outcome(
                'verdict_needs_human',
                'The external reviewer asked for a person to decide this round, so nothing was decided automatically.'
              );
            }
            if (!autoContinue) {
              return outcome(
                'awaiting_decisions',
                `Round ${round + 1} of the plan review is waiting for decisions.`
              );
            }
            // Durable, so it also holds after a restart or a resumed loop: a round
            // reviewed under a contract that changed is never decided automatically.
            if (gate.contractMismatchAt !== null) {
              return outcome(
                'contract_drift',
                'The Coai tool contract changed since this gate was opened, so nothing was decided automatically.'
              );
            }
            this.deps.claims.setLoop(taskId, { phase: 'deciding', round });
            const decided = await this.autoDecideRound(taskId, gate, signal);
            this.assertActive(taskId, signal);
            if (decided.kind === 'stop') return outcome('needs_user', decided.message);
            // Same rule as an explicit resolve: never record accepted findings the
            // budget cannot revise. The round stays open with its decisions saved.
            if (decided.decisions.some((decision) => decision.action === 'accept') && state.all.length >= state.max) {
              return outcome('round_limit', `${budgetSpentMessage(state.max)} Nothing was sent to the external reviewer; the round is still waiting for decisions.`);
            }
            const fresh = this.deps.gates.findByTask(taskId) as PlanReviewGate;
            this.deps.claims.setLoop(taskId, { phase: 'resolving', round });
            await this.deps.gateService.runResolve(
              taskId,
              {
                gateId: fresh.id,
                expectedRevision: fresh.revision,
                decisions: decided.decisions,
                allowAccepted: true
              },
              signal
            );
            continue;
          }

          case 'revise': {
            this.deps.claims.setLoop(taskId, { phase: 'revising', round: round + 1 });
            const revised = await this.revise(state, signal);
            if (revised) correctionsRun += 1;
            continue;
          }

          case 'run_review': {
            this.deps.claims.setLoop(taskId, { phase: 'reviewing', round });
            const reviewed = await this.reviewRevised(taskId, state.gate, signal);
            roundsReviewed += 1;
            if (reviewed.contractMismatchAt !== null) {
              return outcome(
                'contract_drift',
                'The Coai tool contract changed since the previous round, so the loop stopped for a person to look.'
              );
            }
            continue;
          }

          case 'run_next_review':
            // A settled round with nothing accepted has nothing to revise, so
            // another round of the SAME specification would repeat itself.
            return outcome(
              'settled',
              'The round was resolved without accepting any finding, so the specification is unchanged. Start another review if you want one.'
            );

          case 'reconcile':
            return outcome(
              'reconcile_required',
              'A dispatched external call has an unknown outcome. Reconcile it first; nothing was repeated.'
            );

          case 'round_limit':
            return outcome(
              'round_limit',
              `The correction budget of ${state.max} round(s) is spent and accepted findings remain, so nothing was revised.`
            );

          case 'clean':
            return outcome('clean', 'The current specification passed its external plan review with nothing left to correct.');

          case 'none':
            return outcome('none', 'There is nothing for the plan-correction loop to do.');
        }
      }
      throw new AgentRelayError(
        'INTERNAL',
        'The plan-correction loop exceeded its step limit; it stopped without changing anything further.'
      );
    } finally {
      // The claim first, then the registration: a task is never visible as
      // stoppable with nothing running behind it. Both, on every exit.
      release();
      operation.release();
    }
  }

  /**
   * Refuse to take another step once the task was stopped.
   *
   * The signal is what a step in flight observes; the task's own status is
   * what survives a signal that was never delivered (or a stop that raced the
   * operation's registration), and it is what every durable write re-reads.
   */
  private assertActive(taskId: string, signal: AbortSignal): void {
    if (signal.aborted || this.deps.tasks.findById(taskId)?.status === 'CANCELLED') {
      throw new AgentRelayError('CANCELLED', 'The plan-correction loop was stopped. Nothing further was changed.');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Steps                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Analyze every undecided finding of the round, isolating failures.
   *
   * Returns the complete decision set only when EVERY finding now has an
   * automatic decision. Anything else leaves the partial results durably in the
   * gate's draft and stops: a finding that needs a person, or whose analysis
   * failed, is never guessed at.
   */
  private async autoDecideRound(
    taskId: string,
    gate: PlanReviewGate,
    signal: AbortSignal
  ): Promise<{ kind: 'decided'; decisions: PlanReviewDecision[] } | { kind: 'stop'; message: string }> {
    const findingsJson = gate.findingsJson;
    const total = parsePlanReviewFindings(findingsJson).length;
    if (findingsJson === null || total === 0) return { kind: 'decided', decisions: [] };

    const sha = planFindingsSha256(findingsJson);
    const already = new Set(parsePlanReviewAutoDecisions(gate.autoDecisionsJson, sha).map((entry) => entry.finding));
    const todo = Array.from({ length: total }, (_, index) => index).filter((index) => !already.has(index));

    const settled = await settleAll(
      todo,
      AUTO_DECIDE_CONCURRENCY,
      (findingIndex) =>
        this.deps.gateService.runAutoDecide(taskId, { gateId: gate.id, findingsSha256: sha, findingIndex }, signal),
      () => signal.aborted
    );
    // A stop ends the round here. What the analyses that were already running
    // report is not applied (each refuses to write for a stopped task) and is not
    // presented as a stop for a person: the loop simply ends.
    this.assertActive(taskId, signal);
    const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0]!.reason;
      const reason = redactAndTruncate(first instanceof Error ? first.message : String(first), 500);
      return {
        kind: 'stop',
        message: `${failures.length} of ${todo.length} finding(s) could not be analyzed (${reason}). The others were decided; retry the rest.`
      };
    }

    const latest = this.deps.gates.findByTask(taskId);
    const decisions = latest === null ? [] : parsePlanReviewAutoDecisions(latest.autoDecisionsJson, sha);
    const decided = new Set(decisions.map((entry) => entry.finding));
    const undecided = Array.from({ length: total }, (_, index) => index).filter((index) => !decided.has(index));
    if (undecided.length > 0) {
      return {
        kind: 'stop',
        message: `${undecided.length} finding(s) need your decision; Codex stopped on purpose. The others were decided.`
      };
    }
    return {
      kind: 'decided',
      decisions: decisions
        .map((entry) => ({ finding: entry.finding, action: entry.action, reason: entry.reason }))
        .sort((a, b) => a.finding - b.finding)
    };
  }

  /** Ask Codex to revise the specification from the accepted findings. Returns whether a new version was committed. */
  private async revise(state: DerivedState, signal: AbortSignal): Promise<boolean> {
    const { task, gate, max } = state;
    // Before the correction row exists: a stop that already happened opens nothing.
    this.assertActive(task.id, signal);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'The plan can be revised only after specification generation and before implementation.'
      );
    }
    const source = gate as PlanReviewGate;
    const snapshot = readBoundRuleEvidence(task.id, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const current = specificationIdentity(task.specificationJson);
    const specificationJson = task.specificationJson as string;

    const accepted = this.acceptedFindings(source);
    if (accepted.length === 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'This round accepted no finding, so there is nothing to revise.');
    }

    const correction = this.deps.corrections.begin({
      id: this.deps.ids.next(),
      versionId: this.deps.ids.next(),
      taskId: task.id,
      sourceGateId: source.id,
      fromSpecificationSha256: current.sha256,
      currentSpecificationJson: specificationJson,
      acceptedJson: JSON.stringify(accepted)
    });
    // Already applied (a retry after the commit but before the review): nothing to ask.
    if (correction.status === 'completed') return false;

    const settings = this.deps.settings.get();
    const context: AgentRunContext = {
      // The operation's own signal — the one Stop aborts — never a fresh one: a
      // revision whose process the caller cannot reach would run to its timeout.
      signal,
      timeoutMs: settings.processTimeoutMs,
      onProgress: () => undefined
    };
    const fail = (message: string): never => {
      this.deps.corrections.fail(correction.id, redactAndTruncate(message, 10_000));
      throw new AgentRelayError('VALIDATION_FAILED', message, {
        remediation: 'Nothing was changed. Use "Continue correction" to try again.'
      });
    };

    let revisedJson: string;
    let addressed: readonly PlanRevisionAddressed[];
    try {
      const outcome = await this.deps.codex.reviseSpecification(
        {
          projectPath: project.localPath,
          taskTitle: task.title,
          originalRequest: task.originalRequest,
          currentSpecification: current.specification,
          acceptedFindings: accepted,
          ruleEvidence: renderRuleEvidence(snapshot),
          round: correction.round,
          maxRounds: max,
          model: settings.codexModel
        },
        context
      );
      revisedJson = JSON.stringify(outcome.specification);
      addressed = outcome.addressed;
    } catch (error) {
      this.deps.corrections.fail(
        correction.id,
        redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      );
      throw error;
    }
    // Stopped while Codex was revising. The revision is read-only and has no
    // external effect, so discarding it is exact, not a guess: the row says it was
    // stopped and that nothing was changed, and nothing below is reached.
    if (signal.aborted || this.deps.tasks.findById(task.id)?.status === 'CANCELLED') {
      const message = 'Stopped while Codex was revising the specification. The revision had no external effect and was discarded; nothing was changed.';
      this.deps.corrections.fail(correction.id, message);
      throw new AgentRelayError('CANCELLED', message);
    }

    if (Buffer.byteLength(revisedJson, 'utf8') > MAX_SPECIFICATION_BYTES) {
      return fail('The revised specification is larger than the external review budget allows.');
    }
    if (containsSecretShape(revisedJson)) {
      return fail('The revised specification contains credential-shaped text and was not stored.');
    }
    const revised = specificationIdentity(revisedJson);
    if (revised.sha256 === current.sha256) {
      return fail(
        `Codex returned the specification unchanged although ${accepted.length} finding(s) were accepted, so they were not addressed.`
      );
    }
    // Every accepted finding must be accounted for, in a field that really changed.
    // Anything less would be carried into a fresh review as though it were dealt with.
    const unaddressed = revisionAddressesProblem({
      accepted,
      addressed,
      current: current.specification,
      revised: revised.specification
    });
    if (unaddressed !== null) {
      return fail(`${unaddressed} The revision was not stored, so the accepted findings are still not addressed.`);
    }

    try {
      this.deps.corrections.complete({
        correctionId: correction.id,
        versionId: this.deps.ids.next(),
        expectedSpecificationJson: specificationJson,
        newSpecificationJson: revisedJson,
        newSpecificationSha256: revised.sha256,
        // The write refuses a task that is no longer where it started: a stop that
        // lands between the check above and this transaction still changes nothing.
        expectedTaskStatus: task.status,
        addressedJson: JSON.stringify(addressed)
      });
    } catch (error) {
      this.deps.corrections.fail(
        correction.id,
        redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      );
      throw error;
    }
    const updated = this.deps.tasks.findById(task.id);
    if (updated !== null) this.deps.events?.publishTask(updated);
    return true;
  }

  /** The accepted findings of a settled round, frozen for Codex and for the audit record. */
  private acceptedFindings(gate: PlanReviewGate): AcceptedPlanFinding[] {
    const findings = parsePlanReviewFindings(gate.findingsJson);
    return parsePlanReviewDecisions(gate.decisionsJson)
      .filter((decision) => decision.action === 'accept')
      .map((decision) => {
        const finding = findings[decision.finding];
        if (finding === undefined) {
          throw new AgentRelayError('PARSE_FAILED', 'A stored plan-review decision does not identify a stored finding.');
        }
        return {
          finding: decision.finding,
          severity: finding.severity,
          category: finding.category,
          file: finding.file,
          line: finding.line,
          title: finding.title,
          why: finding.why,
          fix: finding.fix,
          operatorNote: decision.reason.trim()
        };
      });
  }

  /** Review the (revised) specification: a new gate row for its hash, on the same provider session. */
  private async reviewRevised(
    taskId: string,
    previous: PlanReviewGate | null,
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    // Carries the previous row's contract fingerprint forward, so a provider
    // whose tool contract changed between rounds is flagged, not adopted.
    this.deps.gateService.prepare(taskId, { inheritContractFrom: previous });
    return this.deps.gateService.runReview(taskId, signal);
  }
}
