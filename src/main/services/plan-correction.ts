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
  planCorrectionNextStep,
  type AcceptedPlanFinding,
  type PlanAdvanceOutcome,
  type PlanAdvanceStop,
  type PlanCorrection,
  type PlanCorrectionDetail,
  type PlanCorrectionNextStep
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

/** Run `work` over `items` with at most `limit` in flight; every item settles, none is skipped on failure. */
async function settleAll<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
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
  return results;
}

/** The dependencies the read side needs — no Codex, no Coai. */
export type PlanCorrectionReadDeps = Pick<
  PlanCorrectionDeps,
  'tasks' | 'gates' | 'corrections' | 'ruleEvidence' | 'settings' | 'claims'
>;

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
  if (latest !== null) {
    try {
      acceptedCount = parseAcceptedPlanFindings(latest.acceptedJson).length;
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
            acceptedCount
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
    signal?: AbortSignal
  ): Promise<PlanAdvanceOutcome> {
    // One exclusive claim for the whole run: nothing else may touch this task's
    // plan review between two of these steps.
    const release = this.deps.claims.acquire(taskId, 'advance');
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
        const state = this.derive(taskId);
        const round = state.all.length;

        if (pending !== null) {
          const request = pending;
          pending = null;
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
            if (decided.kind === 'stop') return outcome('needs_user', decided.message);
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
            const revised = await this.revise(state);
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
      release();
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
    signal?: AbortSignal
  ): Promise<{ kind: 'decided'; decisions: PlanReviewDecision[] } | { kind: 'stop'; message: string }> {
    const findingsJson = gate.findingsJson;
    const total = parsePlanReviewFindings(findingsJson).length;
    if (findingsJson === null || total === 0) return { kind: 'decided', decisions: [] };

    const sha = planFindingsSha256(findingsJson);
    const already = new Set(parsePlanReviewAutoDecisions(gate.autoDecisionsJson, sha).map((entry) => entry.finding));
    const todo = Array.from({ length: total }, (_, index) => index).filter((index) => !already.has(index));

    const settled = await settleAll(todo, AUTO_DECIDE_CONCURRENCY, (findingIndex) =>
      this.deps.gateService.runAutoDecide(taskId, { gateId: gate.id, findingsSha256: sha, findingIndex }, signal)
    );
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
  private async revise(state: DerivedState): Promise<boolean> {
    const { task, gate, max } = state;
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
      signal: new AbortController().signal,
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
    } catch (error) {
      this.deps.corrections.fail(
        correction.id,
        redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      );
      throw error;
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

    try {
      this.deps.corrections.complete({
        correctionId: correction.id,
        versionId: this.deps.ids.next(),
        expectedSpecificationJson: specificationJson,
        newSpecificationJson: revisedJson,
        newSpecificationSha256: revised.sha256
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
