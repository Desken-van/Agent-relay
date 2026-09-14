/**
 * Safe linked continuations.
 *
 * A continuation is what "Continue in a new run" creates once a task has
 * closed REVIEW_LIMIT_REACHED (its final successful review requested changes
 * at an exhausted round budget) or REVIEW_BLOCKED (a successful review found
 * the approach itself needs rework). It is a new Task that reuses the closed
 * task's worktree, branch, base branch, approved specification and provider
 * context, with a fresh bounded review budget — never a mutation of the
 * closed task itself.
 *
 * Two invariants make this safe:
 *
 *  * **Exactly one continuation per source.** Enforced first by a durable
 *    database claim, then by the continuation relationship's UNIQUE keys.
 *    The claim is process-wide (all application instances using the database
 *    see it) and survives a renderer timeout or main-process crash.
 *  * **Exactly one non-terminal task per worktree.** The source stays
 *    REVIEW_LIMIT_REACHED or REVIEW_BLOCKED (terminal) and keeps its own
 *    `worktree_path`; the continuation is the only *non-terminal* task now
 *    pointing at that path, which is exactly what the partial unique index
 *    on `tasks.worktree_path` allows. Nothing
 *  * **Validation-to-dispatch lease.** The durable claim owns the canonical
 *    worktree path from the first eligibility read until the continuation's
 *    first action has revalidated identity and durably entered its busy state.
 *
 * Creating a continuation never starts a provider, verification, review, Git,
 * GitHub, commit, publish or specification operation. The first such
 * operation happens only when the continuation's own displayed primary
 * action is clicked, same as any other task.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type {
  ContinuationEntryAction,
  Project,
  Settings,
  Task,
  TaskContinuation
} from '../../shared/domain/models';
import { isBusy, isTerminal } from '../../shared/domain/workflow';
import { latestVerification, readVerification } from '../../shared/domain/verification';
import { codexReviewResultSchema, taskSpecificationSchema } from '../../shared/schemas/codex';
import type { TaskStatus } from '../../shared/domain/workflow';
import type {
  Clock,
  EventPublisher,
  IdGenerator,
  PlanReviewGateRepository,
  ProjectRepository,
  RunRepository,
  SettingsRepository,
  TaskContinuationRepository,
  TaskRepository,
  TaskRuleEvidenceRepository,
  TransactionRunner
} from '../ports';
import { assertPlanReviewAllowsApproval, readBoundRuleEvidence } from './plan-review-gate';
import type { VerificationExecutor } from './worktree-verification';

export interface ContinuationServiceDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly runs: RunRepository;
  readonly settings: SettingsRepository;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly planReviews: PlanReviewGateRepository;
  readonly continuations: TaskContinuationRepository;
  readonly transactions: TransactionRunner;
  readonly verification?: VerificationExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  /** True while the orchestrator still has a live operation for this task. */
  readonly isSourceBusy: (taskId: string) => boolean;
}
export interface ContinuationResult {
  readonly task: Task;
  readonly continuation: TaskContinuation;
}

/**
 * Startup recovery for durable creation claims. `creating` can never have
 * committed task/link/evidence rows because those writes share one transaction;
 * after a restart it is therefore safe to remove. A bound claim is retained
 * only while its exact linked continuation is still non-terminal and waiting
 * for its first action.
 */
export function reconcileContinuationClaims(deps: {
  readonly tasks: TaskRepository;
  readonly continuations: TaskContinuationRepository;
  readonly transactions: TransactionRunner;
}): number {
  let removed = 0;
  deps.transactions.run(() => {
    for (const claim of deps.continuations.listClaims()) {
      const link = deps.continuations.findBySource(claim.sourceTaskId);
      const continuation = claim.continuationTaskId
        ? deps.tasks.findById(claim.continuationTaskId)
        : null;
      const validBoundClaim =
        claim.state === 'awaiting_first_action' &&
        link?.continuationTaskId === claim.continuationTaskId &&
        continuation !== null &&
        !isTerminal(continuation.status);
      if (!validBoundClaim) {
        deps.continuations.deleteClaim(claim.sourceTaskId);
        removed += 1;
      }
    }
  });
  return removed;
}

export type ProtectedContinuationAction = 'implementation' | 'verification' | 'review' | 'corrections';

const ENTRY_STATUS: Record<ContinuationEntryAction, TaskStatus> = {
  verification: 'READY_FOR_IMPLEMENTATION',
  corrections: 'CHANGES_REQUESTED',
  review: 'READY_FOR_REVIEW'
};

interface ContinuationEntrySelection {
  readonly entryAction: ContinuationEntryAction;
  readonly inheritedVerificationRunId: string | null;
  readonly inheritedImplementationRunId: string | null;
  readonly inheritedReviewRunId: string | null;
  readonly validatedIdentity: string;
}

export class ContinuationService {
  /**
   * Source task ids with a continuation request currently in flight, each
   * mapped to the one promise every concurrent caller for that source shares.
   *
   * A second call arriving while the first is still doing its async
   * eligibility work does not restart that work or race it — it awaits the
   * exact same promise, so two overlapping calls resolve to the exact same
   * continuation (or the exact same failure) rather than one of them being
   * turned away with a "try again" error. The database's UNIQUE constraint on
   * `source_task_id` remains the final arbiter for a caller this map cannot
   * see — a second process, or a call made after this one already finished.
   */
  private readonly inFlight = new Map<string, Promise<ContinuationResult>>();

  constructor(private readonly deps: ContinuationServiceDeps) {}

  async create(sourceTaskId: string): Promise<ContinuationResult> {
    const existing = this.existingLink(sourceTaskId);
    if (existing) return existing;

    const pending = this.inFlight.get(sourceTaskId);
    if (pending) return pending;

    const attempt = this.createClaimed(sourceTaskId);

    this.inFlight.set(sourceTaskId, attempt);
    try {
      return await attempt;
    } finally {
      // Only the caller that registered this exact attempt clears it — a
      // later, different attempt for the same source must not be deleted by
      // an earlier one still unwinding its own `finally`.
      if (this.inFlight.get(sourceTaskId) === attempt) {
        this.inFlight.delete(sourceTaskId);
      }
    }
  }

  private async createClaimed(sourceTaskId: string): Promise<ContinuationResult> {
    const claimId = this.deps.ids.next();
    let acquired = false;
    let committed = false;
    try {
      this.deps.transactions.run(() => {
        const raced = this.existingLink(sourceTaskId);
        if (raced) return;
        const source = this.requireTask(sourceTaskId);
        this.assertEligible(source);
        this.deps.continuations.acquireClaim({
          sourceTaskId,
          claimId,
          worktreePath: source.worktreePath as string
        });
        acquired = true;
      });

      const raced = this.existingLink(sourceTaskId);
      if (raced) return raced;
      if (!acquired) {
        const existing = await this.waitForCommitted(sourceTaskId);
        return existing ?? this.createClaimed(sourceTaskId);
      }

      const source = this.requireTask(sourceTaskId);
      this.assertEligible(source);
      const entry = await this.selectEntry(
        source,
        this.requireProject(source.projectId),
        this.deps.settings.get()
      );
      const boundaryEntry = await this.revalidateEntryAtCreationBoundary(sourceTaskId, entry);
      const result = this.commit(sourceTaskId, claimId, boundaryEntry);
      committed = true;
      return result;
    } catch (error) {
      if (error instanceof AgentRelayError && error.code === 'BUSY' && !acquired) {
        const existing = await this.waitForCommitted(sourceTaskId);
        return existing ?? this.createClaimed(sourceTaskId);
      }
      throw error;
    } finally {
      if (acquired && !committed) {
        this.deps.continuations.releaseClaim(sourceTaskId, claimId);
      }
    }
  }

  /**
   * Follow the durable owner rather than guessing how long its identity read
   * should take. A committed link is the result; a released claim means the
   * owner failed before commit and licenses this caller to try acquisition.
   */
  private async waitForCommitted(sourceTaskId: string): Promise<ContinuationResult | null> {
    for (;;) {
      const existing = this.existingLink(sourceTaskId);
      if (existing) return existing;
      if (!this.deps.continuations.findClaimBySource(sourceTaskId)) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private existingLink(sourceTaskId: string): ContinuationResult | null {
    const link = this.deps.continuations.findBySource(sourceTaskId);
    if (!link) return null;
    const task = this.deps.tasks.findById(link.continuationTaskId);
    if (!task) {
      throw new AgentRelayError(
        'INTERNAL',
        'A continuation link exists but its task cannot be found.'
      );
    }
    return { task, continuation: link };
  }

  /** Specification generation is never a continuation's protected first action. */
  assertSpecificationAllowed(taskId: string): void {
    const claim = this.deps.continuations.findClaimByContinuation(taskId);
    if (!claim) return;
    throw new AgentRelayError(
      'INVALID_TRANSITION',
      `This continuation must begin with ${claim.effectiveEntryAction ?? 'its required first action'}.`
    );
  }

  private requireTask(taskId: string): Task {
    const task = this.deps.tasks.findById(taskId);
    if (!task) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    return task;
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${projectId}.`);
    return project;
  }

  /**
   * Every check the spec requires before anything is created, re-run inside
   * the transaction too (see {@link commit}) so a race cannot slip a
   * continuation past a check that was true only when it was first read.
   */
  private assertEligible(task: Task): void {
    // REVIEW_LIMIT_REACHED and REVIEW_BLOCKED are the two durable outcomes this
    // service continues from; FAILED is kept as a legacy fallback so a historical
    // row a migration has not (or could not) reclassify is still judged on its
    // actual evidence below rather than rejected on status alone.
    if (task.status !== 'REVIEW_LIMIT_REACHED' && task.status !== 'REVIEW_BLOCKED' && task.status !== 'FAILED') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'Only a task stopped at its review limit or blocked by review can be continued.'
      );
    }
    if (this.deps.isSourceBusy(task.id) || this.deps.runs.listByTask(task.id).some((run) => run.status === 'running')) {
      throw new AgentRelayError('BUSY', 'This task still has an operation in flight.');
    }

    const review = parseJson(task.lastReviewJson, codexReviewResultSchema);
    const reviewRun = this.deps.runs.findLatestByType(task.id, 'review');
    const durableReview = reviewRun?.status === 'succeeded'
      ? parseJson(reviewRun.structuredResult, codexReviewResultSchema)
      : null;

    // The task's own status is authoritative once it already carries one of
    // the two current terminal review outcomes — REVIEW_BLOCKED always gets
    // the blocked-evidence check, REVIEW_LIMIT_REACHED always gets the
    // round-exhaustion check, even if lastReviewJson is missing or corrupt
    // (that fails the check below with an accurate message instead of the
    // wrong one). Only a legacy FAILED row, which carries no such signal,
    // falls back to whatever its own review evidence actually says.
    const wantsBlockedEvidence = task.status === 'REVIEW_BLOCKED'
      || (task.status === 'FAILED' && review?.verdict === 'blocked');

    if (wantsBlockedEvidence) {
      if (!review || review.verdict !== 'blocked' || durableReview?.verdict !== 'blocked') {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'This task did not stop on a review that blocked the approach.'
        );
      }
    } else {
      if (task.currentRound < task.maxRounds) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'This task did not stop because its review round budget was exhausted.'
        );
      }
      if (!review || review.verdict !== 'changes_requested' || durableReview?.verdict !== 'changes_requested') {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'This task did not stop on a review that requested changes.'
        );
      }
    }
    if (!task.specificationApprovedAt || !parseJson(task.specificationJson, taskSpecificationSchema)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'This task has no readable, approved specification to continue from.'
      );
    }
    if (!task.worktreePath || !task.branchName || !task.baseBranch) {
      throw new AgentRelayError('WORKTREE_INVALID', 'This task has no worktree to continue.');
    }
    // Reuses the exact rule the orchestrator applies before implementation: if
    // the task is bound to rule evidence, that evidence and a proceeded gate
    // for the exact specification and evidence hash must still be readable.
    // Fails closed — including when the evidence exists but no longer parses.
    assertPlanReviewAllowsApproval({
      task,
      ruleEvidence: this.deps.ruleEvidence,
      gates: this.deps.planReviews
    });
  }

  private async selectEntry(
    source: Task,
    project: Project,
    settings: Settings
  ): Promise<ContinuationEntrySelection> {
    const sourceRuns = this.deps.runs.listByTask(source.id);
    const verificationRun = latestVerification(sourceRuns);
    const implementationRun = [...sourceRuns].reverse().find(
      (run) => run.runType === 'implementation' || run.runType === 'correction'
    ) ?? null;
    const reviewRun = [...sourceRuns].reverse().find((run) => run.runType === 'review') ?? null;

    if (!this.deps.verification) {
      throw new AgentRelayError('TOOL_MISSING', 'Verification identity is unavailable; no continuation was created.');
    }
    const currentIdentity = await this.deps.verification.identity({ task: source, project, settings });
    let verificationCurrent = false;
    if (verificationRun) {
      const parsed = readVerification(verificationRun);
      if (parsed.success && parsed.data.passed && verificationRun.status === 'succeeded') {
        try {
          verificationCurrent = currentIdentity === parsed.data.identity;
        } catch {
          // Unreadable now is exactly as unusable as stale — fail closed to
          // "run verification", never to a state that trusts it.
          verificationCurrent = false;
        }
      }
    }

    if (!verificationCurrent) {
      return {
        entryAction: 'verification',
        inheritedVerificationRunId: null,
        inheritedImplementationRunId: implementationRun?.id ?? null,
        inheritedReviewRunId: null,
        validatedIdentity: currentIdentity
      };
    }

    // Eligibility above already established that the source's last review
    // either requested changes or blocked the approach; either way it left a
    // followUpPrompt meant for the implementing agent (empty only when
    // approved, per the review schema), and with verification still current
    // for the same worktree that review still describes it, so corrections
    // apply.
    const review = parseJson(source.lastReviewJson, codexReviewResultSchema);
    const reviewStillApplies = Boolean(
      review &&
      (review.verdict === 'changes_requested' || review.verdict === 'blocked') &&
      reviewRun?.status === 'succeeded' &&
      (!verificationRun?.finishedAt || !reviewRun.finishedAt || reviewRun.finishedAt >= verificationRun.finishedAt)
    );
    if (reviewStillApplies) {
      return {
        entryAction: 'corrections',
        inheritedVerificationRunId: verificationRun?.id ?? null,
        inheritedImplementationRunId: implementationRun?.id ?? null,
        inheritedReviewRunId: reviewRun?.id ?? null,
        validatedIdentity: currentIdentity
      };
    }

    return {
      entryAction: 'review',
      inheritedVerificationRunId: verificationRun?.id ?? null,
      inheritedImplementationRunId: implementationRun?.id ?? null,
      inheritedReviewRunId: null,
      validatedIdentity: currentIdentity
    };
  }

  /**
   * Identity collection is asynchronous, so re-read it at the last boundary
   * before the all-or-nothing database transaction. If the checkout changed
   * since entry selection, the transaction creates a verification-entry task
   * and claim together; the renderer never observes the stale action.
   */
  private async revalidateEntryAtCreationBoundary(
    sourceTaskId: string,
    entry: ContinuationEntrySelection
  ): Promise<ContinuationEntrySelection> {
    const source = this.requireTask(sourceTaskId);
    this.assertEligible(source);
    const executor = this.deps.verification;
    if (!executor) {
      throw new AgentRelayError('TOOL_MISSING', 'Verification identity is unavailable; no continuation was created.');
    }
    const identity = await executor.identity({
      task: source,
      project: this.requireProject(source.projectId),
      settings: this.deps.settings.get()
    });
    if (identity === entry.validatedIdentity) return { ...entry, validatedIdentity: identity };
    return {
      entryAction: 'verification',
      inheritedVerificationRunId: null,
      inheritedImplementationRunId: entry.inheritedImplementationRunId,
      inheritedReviewRunId: null,
      validatedIdentity: identity
    };
  }

  private commit(
    sourceTaskId: string,
    claimId: string,
    entry: ContinuationEntrySelection
  ): ContinuationResult {
    let result: ContinuationResult | null = null;

    this.deps.transactions.run(() => {
      // Re-read and re-validate under the transaction: the async identity
      // read above cannot hold a lock, so everything it depended on is
      // checked again against whatever is true right now.
      const raced = this.existingLink(sourceTaskId);
      if (raced) {
        result = raced;
        return;
      }
      const source = this.requireTask(sourceTaskId);
      this.assertEligible(source);

      const settings = this.deps.settings.get();
      const continuationId = this.deps.ids.next();

      const continuationTask = this.deps.tasks.create({
        id: continuationId,
        projectId: source.projectId,
        title: source.title,
        originalRequest: source.originalRequest,
        status: ENTRY_STATUS[entry.entryAction],
        currentRound: 0,
        maxRounds: settings.maxReviewRounds,
        codexThreadId: source.codexThreadId,
        claudeSessionId: source.claudeSessionId,
        implementationProvider: source.implementationProvider,
        reviewProvider: source.reviewProvider,
        providerRevision: source.providerRevision,
        implementationThreadId: source.implementationThreadId,
        worktreePath: source.worktreePath,
        branchName: source.branchName,
        baseBranch: source.baseBranch,
        specificationJson: source.specificationJson,
        specificationApprovedAt: source.specificationApprovedAt,
        // Corrections needs the review it is correcting; the other two entry
        // states start from evidence that already justifies them without it,
        // but carrying it forward regardless is harmless audit context — it
        // is display-only and never re-evaluated as a fresh verdict.
        lastReviewJson: source.lastReviewJson,
        lastError: null,
        codexModel: source.codexModel,
        claudeModel: source.claudeModel
      });

      this.cloneRuleEvidenceAndGate(source.id, continuationId);

      const continuation = this.deps.continuations.create({
        id: this.deps.ids.next(),
        sourceTaskId: source.id,
        continuationTaskId: continuationId,
        entryAction: entry.entryAction,
        inheritedVerificationRunId: entry.inheritedVerificationRunId,
        inheritedImplementationRunId: entry.inheritedImplementationRunId,
        inheritedReviewRunId: entry.inheritedReviewRunId
      });

      this.deps.continuations.bindClaim({
        sourceTaskId: source.id,
        claimId,
        continuationTaskId: continuationId,
        validatedIdentity: entry.validatedIdentity,
        effectiveEntryAction: entry.entryAction
      });

      result = { task: continuationTask, continuation };
    });

    const created = result as ContinuationResult | null;
    if (!created) throw new AgentRelayError('INTERNAL', 'Continuation creation produced nothing.');
    this.deps.events.publishTask(created.task);
    return created;
  }

  /**
   * Repair a continuation whose inherited verification became unusable after
   * its review-entry lease was prepared. Claim and task move together in one
   * transaction so TaskDetail can never observe contradictory entry metadata.
   */
  async retargetFirstActionToVerification(taskId: string, reason: string): Promise<boolean> {
    const initial = this.deps.continuations.findClaimByContinuation(taskId);
    if (!initial || initial.state !== 'awaiting_first_action') return false;
    const task = this.requireTask(taskId);
    if (initial.effectiveEntryAction === 'verification' && task.status === 'READY_FOR_IMPLEMENTATION') {
      return true;
    }
    const executor = this.deps.verification;
    if (!executor) throw new AgentRelayError('TOOL_MISSING', 'Verification identity is unavailable.');
    const identity = await executor.identity({
      task,
      project: this.requireProject(task.projectId),
      settings: this.deps.settings.get()
    });
    let retargeted = false;
    this.deps.transactions.run(() => {
      const claim = this.deps.continuations.findClaimByContinuation(taskId);
      if (!claim || claim.state !== 'awaiting_first_action') return;
      this.deps.continuations.retargetClaimToVerification(claim.sourceTaskId, claim.claimId, identity);
      this.deps.tasks.update(taskId, {
        status: 'READY_FOR_IMPLEMENTATION',
        lastError: reason
      });
      retargeted = true;
    });
    if (retargeted) this.deps.events.publishTask(this.requireTask(taskId));
    return retargeted;
  }

  /**
   * Revalidate the shared checkout while the durable claim is still held.
   * The returned callback must be invoked immediately after the action's busy
   * state is persisted; until then a failure deliberately leaves the claim in
   * place so a retry cannot race an action whose start was never established.
   */
  async prepareFirstAction(
    taskId: string,
    requested: ProtectedContinuationAction,
    observedIdentity?: string
  ): Promise<() => void> {
    const claim = this.deps.continuations.findClaimByContinuation(taskId);
    if (!claim) return () => undefined;
    const task = this.requireTask(taskId);
    const link = this.deps.continuations.findByContinuation(taskId);
    if (!link || claim.state !== 'awaiting_first_action' || !claim.validatedIdentity || !claim.effectiveEntryAction) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The continuation creation lease is incomplete. Restart Agent Relay to reconcile it.');
    }
    const expected: Record<ContinuationEntryAction, ProtectedContinuationAction> = {
      corrections: 'corrections',
      verification: 'verification',
      review: 'review'
    };
    if (requested !== expected[claim.effectiveEntryAction]) {
      throw new AgentRelayError('INVALID_TRANSITION', `This continuation must begin with ${claim.effectiveEntryAction}.`);
    }
    const executor = this.deps.verification;
    if (!executor) throw new AgentRelayError('TOOL_MISSING', 'Verification identity is unavailable.');
    const identity = observedIdentity ?? await executor.identity({
      task,
      project: this.requireProject(task.projectId),
      settings: this.deps.settings.get()
    });

    if (identity !== claim.validatedIdentity && requested !== 'verification') {
      this.deps.transactions.run(() => {
        this.deps.continuations.retargetClaimToVerification(claim.sourceTaskId, claim.claimId, identity);
        this.deps.tasks.update(task.id, {
          status: 'READY_FOR_IMPLEMENTATION',
          lastError: 'The worktree changed after continuation creation. Run verification before continuing.'
        });
      });
      const retargeted = this.requireTask(task.id);
      this.deps.events.publishTask(retargeted);
      throw new AgentRelayError('VALIDATION_FAILED', 'The worktree changed after continuation creation. Run verification before continuing.');
    }
    if (identity !== claim.validatedIdentity) {
      this.deps.continuations.retargetClaimToVerification(claim.sourceTaskId, claim.claimId, identity);
    }

    let released = false;
    return () => {
      if (released) return;
      const current = this.requireTask(taskId);
      if (!isBusy(current.status)) {
        throw new AgentRelayError('INTERNAL', 'A continuation lease can only be released after its first action starts.');
      }
      this.deps.continuations.releaseClaim(claim.sourceTaskId, claim.claimId);
      released = true;
    };
  }

  /**
   * Give the continuation task its own rule-evidence binding and settled
   * plan-review gate, byte-identical to the source's, rather than teaching
   * every reader to look the evidence up through the link.
   *
   * `task_rule_evidence` is keyed one row per task, so "reuse" here means an
   * explicit second row holding the exact same snapshot bytes and hash — the
   * source's row is never read from again by this write, and nothing about
   * it changes.
   */
  private cloneRuleEvidenceAndGate(sourceTaskId: string, continuationTaskId: string): void {
    const binding = this.deps.ruleEvidence.findByTask(sourceTaskId);
    if (!binding) return;
    // Re-validates the bytes against the hash; assertEligible already proved
    // this succeeds, so a failure here means something changed underneath
    // this call and the whole creation must fail rather than clone garbage.
    readBoundRuleEvidence(sourceTaskId, this.deps.ruleEvidence);
    this.deps.ruleEvidence.create({
      taskId: continuationTaskId,
      snapshotSha256: binding.snapshotSha256,
      snapshotJson: binding.snapshotJson,
      boundAt: binding.boundAt
    });

    const gate = this.deps.planReviews.findByTask(sourceTaskId);
    if (!gate || gate.status !== 'proceeded') return;
    this.deps.planReviews.create({
      id: this.deps.ids.next(),
      taskId: continuationTaskId,
      specificationSha256: gate.specificationSha256,
      ruleEvidenceSha256: gate.ruleEvidenceSha256,
      sessionId: gate.sessionId,
      serverName: gate.serverName,
      serverVersion: gate.serverVersion,
      status: gate.status,
      verdict: gate.verdict,
      findingsJson: gate.findingsJson,
      decisionsJson: gate.decisionsJson,
      reviewers: gate.reviewers,
      gatingCount: gate.gatingCount,
      threshold: gate.threshold,
      lastError: gate.lastError,
      reconciledAt: gate.reconciledAt
    });
  }
}

function parseJson<T>(
  raw: string | null,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } }
): T | null {
  if (!raw) return null;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success && result.data !== undefined ? result.data : null;
  } catch {
    return null;
  }
}
