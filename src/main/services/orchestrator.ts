/**
 * The relay loop.
 *
 * Codex specifies -> the user approves -> an isolated worktree is created ->
 * Claude implements -> Agent Relay collects the evidence -> Codex reviews it in
 * read-only mode -> either it approves, or its follow-up goes back to the *same*
 * Claude session for another round.
 *
 * Three properties are enforced here rather than hoped for:
 *
 *  * **Termination.** A correction round can only start while
 *    `currentRound < maxRounds`; the check lives in {@link decideReviewOutcome}
 *    and is applied the moment a review returns.
 *  * **One run at a time per task.** A task with a live AbortController refuses
 *    to start another operation, so two Claude sessions can never edit the same
 *    worktree concurrently.
 *  * **Nothing is published here.** This class never commits, pushes, or talks
 *    to GitHub. That lives in the publish service, behind an approval.
 */

import {
  resolveVerificationConfig,
  type RuleProblem,
  type VerificationConfigProblem
} from '../../shared/domain/claude-tool-rules';
import {
  correctionAction,
  latestImplementationRoundResult as latestClaudeRoundResult,
  readClaudeAssessment
} from '../../shared/domain/claude-assessment';
import { AgentRelayError, InvalidTransitionError } from '../../shared/domain/errors';
import type { GitChangeSet } from '../../shared/domain/git';
import type { Project, Settings, Task } from '../../shared/domain/models';
import type { VerificationRecord } from '../../shared/domain/verification';
import {
  parsePlanReviewDecisions,
  parsePlanReviewFindings
} from '../../shared/domain/plan-review';
import {
  decideReviewOutcome,
  isBusy,
  transition,
  type TaskStatus,
  type WorkflowEvent
} from '../../shared/domain/workflow';
import {
  codexReviewResultSchema,
  taskSpecificationSchema,
  type CodexReviewResult,
  type TaskSpecification
} from '../../shared/schemas/codex';
import { buildBranchName, buildWorktreeDirName, isValidBranchName } from '../../shared/util/slug';
import {
  buildCorrectionPrompt,
  buildImplementationPrompt,
  buildVerificationFailurePrompt,
  buildVerificationRetryPrompt
} from '../adapters/codex/prompts';
import type {
  ClaudeAdapter,
  Clock,
  CodexAdapter,
  EventPublisher,
  GitAdapter,
  IdGenerator,
  OrnithHealthyLease,
  OrnithInferenceLeaseService,
  ProjectRepository,
  PlanReviewGateRepository,
  RunEventRepository,
  RunRepository,
  SettingsRepository,
  TaskContinuationRepository,
  TaskRepository,
  TaskRuleEvidenceRepository
} from '../ports';
import type { ProcessRunner } from '../adapters/process/process-runner';
import {
  preflightOrnithPrompt,
  type OrnithImplementationService
} from './ornith-implementation';
import { assertSafeWorktreePath, isSamePath } from './path-safety';
import { assessClaudeRound } from './claude-round-policy';
import {
  denialDetails,
  describeFailure,
  describeWarning,
  toAssessmentRecord
} from './claude-round-report';
import { RunRecorder } from './run-recorder';
import {
  assertPlanReviewAllowsApproval,
  readBoundRuleEvidence
} from './plan-review-gate';
import { renderRuleEvidence } from './rule-evidence';
import { join } from 'node:path';
import {
  canChangeProviders,
  implementationProviderSchema,
  reviewProviderSchema,
  type ImplementationProvider,
  type ReviewProvider
} from '../../shared/domain/execution-providers';
import {
  latestVerification,
  readVerification,
  verificationNeedsImplementationRepair
} from '../../shared/domain/verification';
import type { VerificationExecutor } from './worktree-verification';
import type { WorktreeDependencyPreparer } from './worktree-dependencies';
import type { ProtectedContinuationAction } from './continuation-service';
import { redactAndTruncate, redactSecrets } from '../../shared/util/redact';
import { ORNITH_LIMITS, ornithRelativePathSchema, redactAbsoluteMachinePaths } from '../../shared/domain/ornith';

const MAX_VERIFICATION_REPAIR_OUTPUT_CHARS = 64_000;

function storedRunEventText(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || !('text' in parsed)) return null;
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

export interface ContinuationActionGuard {
  prepareFirstAction(
    taskId: string,
    action: ProtectedContinuationAction,
    observedIdentity?: string
  ): Promise<() => void>;
  retargetFirstActionToVerification(taskId: string, reason: string): Promise<boolean>;
  assertSpecificationAllowed(taskId: string): void;
}

export interface OrchestratorDeps {
  readonly verification?: VerificationExecutor;
  readonly worktreeDependencies?: WorktreeDependencyPreparer;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly runEvents: RunEventRepository;
  readonly settings: SettingsRepository;
  readonly codex: CodexAdapter;
  readonly claude: ClaudeAdapter;
  readonly git: GitAdapter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly planReviews: PlanReviewGateRepository;
  readonly continuationGuard?: ContinuationActionGuard;
  readonly continuations?: TaskContinuationRepository;
  /** Present only when Ornith is wired; absent build configurations simply cannot select it. */
  readonly ornith?: OrnithImplementationService;
  readonly ornithLease?: OrnithInferenceLeaseService;
  /** Used only to invoke fixed, read-only Git argv for the Ornith worktree tools. */
  readonly processRunner?: ProcessRunner;
}

export class Orchestrator {
  /** Live cancellation handles, keyed by task id. Presence == a run in flight. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /* ------------------------------------------------------------------ */
  /* Shared plumbing                                                     */
  /* ------------------------------------------------------------------ */

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

  private recorder(settings: Settings): RunRecorder {
    return new RunRecorder(
      this.deps.runs,
      this.deps.runEvents,
      this.deps.clock,
      this.deps.ids,
      this.deps.events,
      settings.maxStoredLogBytes
    );
  }

  private ruleEvidenceText(taskId: string): string | undefined {
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    return snapshot === null ? undefined : renderRuleEvidence(snapshot);
  }

  /**
   * Carry only findings the operator explicitly accepted into every
   * implementation prompt. Resolve is an audit operation and does not rewrite
   * the immutable specification, so omitting this bridge would make “Accept
   * and address” record a promise that the implementing agent never sees.
   */
  private acceptedPlanReviewRequirements(taskId: string): string | undefined {
    const gate = this.deps.planReviews.findByTask(taskId);
    if (gate === null || gate.status !== 'proceeded' || gate.decisionsJson === null) {
      return undefined;
    }
    const findings = parsePlanReviewFindings(gate.findingsJson);
    const decisions = parsePlanReviewDecisions(gate.decisionsJson);
    const accepted = decisions.filter((decision) => decision.action === 'accept');
    if (accepted.length === 0) return undefined;

    return accepted.map((decision, position) => {
      const finding = findings[decision.finding];
      if (finding === undefined) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'A stored plan-review decision does not identify a stored finding.'
        );
      }
      return [
        `${position + 1}. ${finding.title}`,
        `   Why: ${finding.why}`,
        `   Required correction: ${finding.fix}`,
        ...(decision.reason.trim().length > 0
          ? [`   Operator note: ${decision.reason.trim()}`]
          : [])
      ].join('\n');
    }).join('\n\n');
  }

  private implementationPrompt(task: Task, specification: TaskSpecification): string {
    if (!task.worktreePath || !task.branchName) {
      throw new AgentRelayError('INTERNAL', 'The task has no worktree for an implementation prompt.');
    }
    return buildImplementationPrompt({
      specification,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      originalRequest: task.originalRequest,
      ruleEvidence: this.ruleEvidenceText(task.id),
      acceptedPlanReviewRequirements: this.acceptedPlanReviewRequirements(task.id)
    });
  }

  /** Build a bounded continuation prompt from Relay's newest failed verification. */
  private verificationFailurePrompt(taskId: string): string | null {
    const run = latestVerification(this.deps.runs.listByTask(taskId));
    if (!verificationNeedsImplementationRepair(run)) return null;

    const record = readVerification(run);
    const command = record.success ? record.data.command : 'npm run verify';
    const reason = record.success
      ? record.data.reason ?? run.errorMessage ?? 'Verification failed.'
      : run.errorMessage ?? 'The stored verification result could not be read.';
    const stored = this.deps.runEvents.listByRun(run.id)
      .map((event) => storedRunEventText(event.payload))
      .filter((text): text is string => text !== null && text.length > 0)
      .join('\n');
    const safe = redactSecrets(stored);
    const output = safe.length <= MAX_VERIFICATION_REPAIR_OUTPUT_CHARS
      ? safe
      : `…[earlier verification output omitted]\n${safe.slice(-MAX_VERIFICATION_REPAIR_OUTPUT_CHARS)}`;

    return buildVerificationFailurePrompt({ command, reason, output });
  }

  /** Relay-authored status only; stored verification logs may contain absolute machine paths. */
  private ornithVerificationFailureEvidence(taskId: string): string | null {
    const run = latestVerification(this.deps.runs.listByTask(taskId));
    if (!verificationNeedsImplementationRepair(run)) return null;
    const record = readVerification(run);
    return record.success
      ? `Relay verification status: failed; exitCode=${record.data.exitCode ?? 'unknown'}; durationMs=${record.data.durationMs}.`
      : 'Relay verification status: failed; stored verification evidence was unavailable.';
  }

  private applyEvent(task: Task, event: WorkflowEvent, patch: Partial<Task> = {}): Task {
    const status: TaskStatus = transition(task.status, event);
    const updated = this.deps.tasks.update(task.id, { ...patch, status });
    this.deps.events.publishTask(updated);
    return updated;
  }

  private patchTask(taskId: string, patch: Partial<Task>): Task {
    const updated = this.deps.tasks.update(taskId, patch);
    this.deps.events.publishTask(updated);
    return updated;
  }

  private beginExclusive(taskId: string): AbortController {
    if (this.inFlight.has(taskId)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'This task already has an agent running. Stop it before starting another operation.'
      );
    }
    const controller = new AbortController();
    this.inFlight.set(taskId, controller);
    return controller;
  }

  private endExclusive(taskId: string): void {
    this.inFlight.delete(taskId);
  }

  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /** Re-check existing files, without spending an implementation/review round. */
  async runVerification(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (!['READY_FOR_IMPLEMENTATION', 'READY_FOR_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'READY_TO_PUBLISH'].includes(task.status)) {
      throw new InvalidTransitionError(task.status, 'verification_started');
    }
    if (!task.specificationApprovedAt || !task.worktreePath || !task.branchName) {
      throw new AgentRelayError('APPROVAL_REQUIRED', 'Approve the specification and create an implementation worktree first.');
    }
    const executor = this.deps.verification;
    if (!executor) throw new AgentRelayError('TOOL_MISSING', 'Verification is not configured in this build.');
    if (this.deps.runs.listByTask(taskId).some(run => run.status === 'running')) {
      throw new AgentRelayError('BUSY', 'A run is still outstanding for this task.');
    }
    const settings = this.deps.settings.get();
    const project = this.requireProject(task.projectId);
    assertPlanReviewAllowsApproval({ task, ruleEvidence: this.deps.ruleEvidence, gates: this.deps.planReviews });
    // A test pass is not permission to erase an implementation security denial.
    const previous = readClaudeAssessment(latestClaudeRoundResult(this.deps.runs.listByTask(taskId)));
    if (previous.ok && previous.assessment.publishBlock === 'security') {
      throw new AgentRelayError('VALIDATION_FAILED', 'Resolve the implementation security denial before verification recovery.');
    }
    const controller = this.beginExclusive(taskId);
    let handle: ReturnType<RunRecorder['start']> | undefined;
    let identity = '';
    let completeContinuationStart: (() => void) | undefined;
    try {
      await this.deps.worktreeDependencies?.prepare({
        repositoryPath: project.localPath,
        worktreePath: task.worktreePath
      });
      identity = await executor.identity({ task, settings, project });
      if (controller.signal.aborted) throw new AgentRelayError('CANCELLED', 'Verification cancelled before execution.');
      completeContinuationStart = await this.deps.continuationGuard?.prepareFirstAction(
        taskId,
        'verification',
        identity
      );
      task = this.requireTask(taskId);
      task = this.applyEvent(task, 'verification_started', { lastError: null, lastReviewJson: null });
      handle = this.recorder(settings).start({ taskId, agent: 'system', runType: 'verification', round: task.currentRound });
      completeContinuationStart?.();
      const result = await executor.execute({ task, settings, project }, controller.signal, event => handle!.append(event));
      const after = await executor.identity({ task: this.requireTask(taskId), settings: this.deps.settings.get(), project: this.requireProject(task.projectId) });
      const passed = result.exitCode === 0 && !result.failed && !result.timedOut && !result.cancelled && !controller.signal.aborted && after === identity;
      const reason = passed ? null : after !== identity ? 'Files or task inputs changed during verification. Run verification again.' : result.cancelled || controller.signal.aborted ? 'Verification cancelled; success was not established.' : result.timedOut ? 'Verification timed out; success was not established.' : `npm run verify failed (exit ${result.exitCode ?? 'unknown'}). See command output.`;
      handle.finish({ status: passed ? 'succeeded' : 'failed', finalMessage: passed ? 'Verification passed for this code snapshot. Ready for review.' : reason,
        errorMessage: reason, structuredResult: { version: 1, command: 'npm run verify', identity, passed, exitCode: result.exitCode, durationMs: result.durationMs, reason } });
      if (this.requireTask(taskId).status !== 'VERIFYING') return this.requireTask(taskId);
      return this.applyEvent(this.requireTask(taskId), passed ? 'verification_completed' : 'verification_aborted', { lastError: reason });
    } catch (error) {
      const message = Orchestrator.describeError(error);
      handle?.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: message,
        structuredResult: { version: 1, command: 'npm run verify', identity, passed: false, exitCode: null, durationMs: 0, reason: message } });
      if (this.requireTask(taskId).status === 'VERIFYING') this.applyEvent(this.requireTask(taskId), 'verification_aborted', { lastError: message });
      throw error;
    } finally { this.endExclusive(taskId); }
  }

  private effectiveVerificationRun(taskId: string) {
    const ownRuns = this.deps.runs.listByTask(taskId);
    const ownVerification = latestVerification(ownRuns);
    if (ownVerification) return ownVerification;
    if (ownRuns.some((run) => run.runType === 'implementation' || run.runType === 'correction')) return null;
    const inheritedId = this.deps.continuations
      ?.findByContinuation(taskId)
      ?.inheritedVerificationRunId;
    return inheritedId ? this.deps.runs.findById(inheritedId) : null;
  }

  private async assertVerificationCurrent(task: Task): Promise<VerificationRecord | null> {
    const run = this.effectiveVerificationRun(task.id);
    if (!run) return null;
    const record = readVerification(run);
    if (!record.success || !record.data.passed || run.status !== 'succeeded' || !this.deps.verification ||
      record.data.identity !== await this.deps.verification.identity({ task, settings: this.deps.settings.get(), project: this.requireProject(task.projectId) })) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Verification is missing, failed or stale. Choose Run verification before review.');
    }
    return record.data;
  }

  configureProviders(input: { taskId: string; expectedRevision: number; implementationProvider: ImplementationProvider; reviewProvider: ReviewProvider }): Task {
    const task = this.requireTask(input.taskId);
    if (this.isRunning(task.id) || !canChangeProviders(task.status) || this.deps.runs.listByTask(task.id).some((r) => r.status === 'running')) {
      throw new AgentRelayError('INVALID_TRANSITION', 'Providers can only change while the task is idle and not approved for publication.');
    }
    const implementation = implementationProviderSchema.parse(input.implementationProvider);
    const review = reviewProviderSchema.parse(input.reviewProvider);
    const updated = this.deps.tasks.changeProviders(task.id, input.expectedRevision, implementation, review);
    this.deps.events.publishTask(updated);
    return updated;
  }

  /**
   * Decide which workflow event a failure maps to.
   * Cancellations are terminal; everything else returns to a retryable state.
   */
  private failureEvent(
    error: unknown,
    recoverable: WorkflowEvent,
    fatal: WorkflowEvent
  ): WorkflowEvent {
    if (error instanceof AgentRelayError && error.code === 'CANCELLED') return 'cancelled';
    // A transition error means our own state assumptions were wrong: fail hard
    // rather than pretending the operation can be retried.
    if (error instanceof InvalidTransitionError) return fatal;
    return recoverable;
  }

  private static describeError(error: unknown): string {
    if (error instanceof AgentRelayError) {
      return error.remediation ? `${error.message} — ${error.remediation}` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /* ------------------------------------------------------------------ */
  /* 1. Specification                                                    */
  /* ------------------------------------------------------------------ */

  async generateSpecification(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (this.inFlight.has(taskId)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'This task already has an agent running. Stop it before starting another operation.'
      );
    }
    if (task.status !== 'DRAFT' && task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new InvalidTransitionError(task.status, 'specification_started');
    }
    this.deps.continuationGuard?.assertSpecificationAllowed(taskId);
    const project = this.requireProject(task.projectId);
    const settings = this.deps.settings.get();

    // DRAFT on the first attempt, READY_FOR_IMPLEMENTATION when regenerating.
    const startEvent: WorkflowEvent =
      task.status === 'READY_FOR_IMPLEMENTATION' ? 'specification_retry' : 'specification_started';

    const controller = this.beginExclusive(taskId);
    const handle = this.recorder(settings).start({
      taskId,
      agent: 'codex',
      runType: 'specification',
      round: task.currentRound
    });

    try {
      task = this.applyEvent(task, startEvent, { lastError: null });

      const result = await this.deps.codex.createSpecification(
        {
          projectPath: project.localPath,
          taskTitle: task.title,
          originalRequest: task.originalRequest,
          ruleEvidence: this.ruleEvidenceText(task.id),
          threadId: task.codexThreadId,
          // Snapshotted on the task: a regenerated spec keeps the same model.
          model: task.codexModel
        },
        {
          signal: controller.signal,
          timeoutMs: settings.processTimeoutMs,
          onProgress: (event) => handle.append(event)
        }
      );

      handle.finish({
        status: 'succeeded',
        finalMessage: result.specification.summary,
        structuredResult: result.specification
      });

      return this.applyEvent(task, 'specification_completed', {
        codexThreadId: result.threadId ?? task.codexThreadId,
        specificationJson: JSON.stringify(result.specification),
        // Regenerating invalidates a previous approval — the user must look again.
        specificationApprovedAt: null,
        title: result.specification.title || task.title,
        lastError: null
      });
    } catch (error) {
      const message = Orchestrator.describeError(error);
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: message });
      this.applyEvent(this.requireTask(taskId), this.failureEvent(error, 'specification_aborted', 'specification_failed'), {
        lastError: message
      });
      throw error;
    } finally {
      this.endExclusive(taskId);
    }
  }

  /**
   * Record the user's explicit acceptance of the specification.
   * Nothing may be sent to Claude until this has happened.
   */
  approveSpecification(taskId: string): Task {
    const task = this.requireTask(taskId);

    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new InvalidTransitionError(task.status, 'approve_specification');
    }
    if (!task.specificationJson) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'There is no specification to approve yet. Generate one first.'
      );
    }

    assertPlanReviewAllowsApproval({
      task,
      ruleEvidence: this.deps.ruleEvidence,
      gates: this.deps.planReviews
    });

    return this.patchTask(taskId, { specificationApprovedAt: this.deps.clock.nowIso() });
  }

  /** Allocate the unique task branch used as the external review-session key. */
  async preparePlanReviewWorktree(
    taskId: string,
    options: { acceptDirtyWorkingTree?: boolean } = {}
  ): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new InvalidTransitionError(task.status, 'prepare_plan_review');
    }
    const project = this.requireProject(task.projectId);
    const settings = this.deps.settings.get();
    this.beginExclusive(taskId);
    try {
      return await this.ensureWorktree(task, project, settings, {
        acceptDirtyWorkingTree: options.acceptDirtyWorkingTree ?? false
      });
    } finally {
      this.endExclusive(taskId);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2. Isolation: branch + worktree                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Create the task's dedicated branch and worktree, if it does not have one.
   *
   * Refuses when: the project is not a Git repository, the base branch is
   * missing, the working tree is dirty and the user has not accepted that, the
   * computed path is unsafe, or another live task already owns the directory.
   */
  private async ensureWorktree(
    task: Task,
    project: Project,
    settings: Settings,
    options: { acceptDirtyWorkingTree: boolean }
  ): Promise<Task> {
    if (task.worktreePath && task.branchName) {
      return task;
    }

    const handle = this.recorder(settings).start({
      taskId: task.id,
      agent: 'system',
      runType: 'git',
      round: task.currentRound
    });

    try {
      handle.append({ type: 'started', text: `Inspecting ${project.localPath}` });

      const info = await this.deps.git.inspect(project.localPath);
      if (!info.isRepository) {
        throw new AgentRelayError(
          'GIT_FAILED',
          `${project.localPath} is not a Git repository.`,
          { remediation: 'Initialise Git for this project first, or register a different folder.' }
        );
      }

      const baseBranch = project.defaultBranch;
      if (!(await this.deps.git.branchExists(project.localPath, baseBranch))) {
        throw new AgentRelayError(
          'GIT_FAILED',
          `The project's base branch "${baseBranch}" does not exist in ${project.localPath}.`,
          {
            details: `Available branches: ${info.branches.join(', ') || '(none)'}`,
            remediation: 'Update the project settings to point at a branch that exists.'
          }
        );
      }

      if (!info.isClean && !options.acceptDirtyWorkingTree) {
        throw new AgentRelayError(
          'GIT_DIRTY',
          `${project.localPath} has uncommitted changes.`,
          {
            details: info.dirtyFiles.slice(0, 20).join('\n'),
            remediation:
              'Commit or stash them, or re-run and explicitly accept the dirty working tree. Agent Relay works in a separate worktree, so your changes are not touched — but the branch you are cutting from will not include them.'
          }
        );
      }

      const branchName = buildBranchName(task.id, task.title);
      if (!isValidBranchName(branchName)) {
        throw new AgentRelayError('VALIDATION_FAILED', `Computed an invalid branch name: ${branchName}`);
      }

      const worktreePath = join(settings.worktreesRoot, buildWorktreeDirName(task.id, task.title));

      // Hard path checks before anything is created on disk.
      assertSafeWorktreePath({
        worktreePath,
        worktreesRoot: settings.worktreesRoot,
        repositoryPath: info.root ?? project.localPath
      });

      // No two live tasks may share a worktree.
      const conflict = this.deps.tasks
        .listActiveWorktreePaths()
        .find((entry) => entry.taskId !== task.id && isSamePath(entry.worktreePath, worktreePath));
      if (conflict) {
        throw new AgentRelayError(
          'WORKTREE_CONFLICT',
          `Task ${conflict.taskId} is already using that worktree directory.`,
          { details: worktreePath }
        );
      }

      handle.append({
        type: 'log',
        text: `Creating branch ${branchName} from ${baseBranch} at ${worktreePath}`
      });

      const worktree = await this.deps.git.createWorktree({
        repositoryPath: info.root ?? project.localPath,
        baseBranch,
        branchName,
        worktreePath
      });

      handle.append({ type: 'log', text: `Worktree ready at ${worktree.path}` });
      handle.finish({
        status: 'succeeded',
        finalMessage: `Created ${branchName} in ${worktree.path}`,
        structuredResult: { branchName, worktreePath: worktree.path, baseBranch }
      });

      return this.patchTask(task.id, {
        branchName,
        worktreePath: worktree.path,
        baseBranch
      });
    } catch (error) {
      const message = Orchestrator.describeError(error);
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: message });
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3. Implementation                                                   */
  /* ------------------------------------------------------------------ */

  async sendToClaude(taskId: string, options: { acceptDirtyWorkingTree?: boolean } = {}): Promise<Task> {
    let task = this.requireTask(taskId);
    const project = this.requireProject(task.projectId);
    const settings = this.deps.settings.get();

    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new InvalidTransitionError(task.status, 'implementation_started');
    }
    if (!task.specificationApprovedAt) {
      throw new AgentRelayError(
        'APPROVAL_REQUIRED',
        'The specification has not been approved yet.',
        { remediation: 'Review the specification and choose "Approve specification" first.' }
      );
    }
    assertPlanReviewAllowsApproval({
      task,
      ruleEvidence: this.deps.ruleEvidence,
      gates: this.deps.planReviews
    });

    const specification = readSpecification(task);

    // Before the worktree, not after: creating a branch and a directory for a
    // round that cannot legally start leaves debris the user has to clean up,
    // for a failure that was knowable before any of it happened.
    this.assertImplementationConfigured(task, settings);

    const controller = this.beginExclusive(taskId);
    let completed: Task;
    let ornithLease: OrnithHealthyLease | null = null;
    try {
      // Before worktree creation, the IMPLEMENTING transition, or round
      // consumption: an Ornith round that cannot even start must leave
      // nothing durable behind.
      ornithLease = await this.acquireOrnithLeaseIfNeeded(task, controller);

      // Read this before creating a worktree or consuming a round. In
      // particular, the immutable specification itself may already be larger
      // than the retained model's context window; that is a settings preflight
      // failure, not a failed implementation attempt.
      const verificationRepair = task.implementationProvider === 'ornith'
        ? this.ornithVerificationFailureEvidence(taskId)
        : this.verificationFailurePrompt(taskId);
      if (ornithLease !== null) {
        this.assertOrnithPromptFits({
          task,
          lease: ornithLease,
          specification,
          correctionFindings: verificationRepair,
          round: Math.max(1, task.currentRound)
        });
      }

      const completeContinuationStart = await this.deps.continuationGuard?.prepareFirstAction(
        taskId,
        'implementation'
      );
      // Worktree creation happens before the state moves to IMPLEMENTING, so a
      // Git failure leaves the task retryable rather than stuck.
      task = await this.ensureWorktree(task, project, settings, {
        acceptDirtyWorkingTree: options.acceptDirtyWorkingTree ?? false
      });

      const worktreePath = task.worktreePath;
      const branchName = task.branchName;
      if (!worktreePath || !branchName) {
        throw new AgentRelayError('INTERNAL', 'The task has no worktree after creation.');
      }

      // Worktree preparation may have taken real time; reconfirm the lease
      // immediately before the run is recorded rather than trusting the
      // preflight above.
      await this.recheckOrnithLeaseIfNeeded(ornithLease, controller.signal);

      const roundBeforeAttempt = task.currentRound;
      task = this.applyEvent(task, 'implementation_started', {
        // Verification recovery can return a later round here; never reset its budget.
        currentRound: Math.max(1, task.currentRound),
        lastError: null
      });
      completeContinuationStart?.();

      const prompt = [this.implementationPrompt(task, specification), verificationRepair]
        .filter((part): part is string => part !== null)
        .join('\n\n');

      completed = await this.runImplementation(task, controller, prompt, {
        runType: 'implementation',
        recoverableFailure: 'implementation_aborted',
        ornithLease,
        ornithCorrectionFindings: verificationRepair,
        roundBeforeAttempt
      });
    } catch (error) {
      this.recordFailureIfStillRunning(taskId, error, 'implementation_aborted');
      throw error;
    } finally {
      ornithLease?.release();
      this.endExclusive(taskId);
    }

    return await this.runRelayVerificationAfterProvider(completed);
  }

  /**
   * Start another Claude round on an existing worktree.
   *
   * Two entry states, because there are two ways a task ends up needing one:
   * the reviewer asked for changes, or the reviewer was happy and the publish
   * gate refused the round on its evidence. The second is not a failure of the
   * code, so it gets its own prompt.
   */
  async sendCorrections(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    const settings = this.deps.settings.get();

    // The same decision the button makes, from the same function. Asking it
    // here is what makes it a rule rather than a UI convenience: a renderer is
    // not a domain boundary, and this entry point is reachable without one.
    const action = correctionAction({
      status: task.status,
      currentRound: task.currentRound,
      maxRounds: task.maxRounds,
      latestClaudeStructuredResult: latestClaudeRoundResult(this.deps.runs.listByTask(taskId))
    });

    if (action.kind === 'unavailable') {
      throw new InvalidTransitionError(task.status, 'corrections_sent');
    }
    const recovering = action.kind === 'retry_verification';

    // The round budget is the reason this loop terminates. Re-checked here as
    // well as at review time, because this entry point is reachable from the UI.
    if (!action.enabled) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This task has already used its ${task.maxRounds} review round(s).`,
        { remediation: 'Raise the maximum for new tasks in Settings, or finish this one manually.' }
      );
    }

    // Same gate as the first round, and for the same reason: an unusable
    // configuration must not reach the point of writing a run row.
    this.assertImplementationConfigured(task, settings);

    const review = readReview(task);
    if (!review && !recovering) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There is no review to send corrections from.');
    }
    if (!task.worktreePath || !task.branchName) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree to work in.');
    }

    const controller = this.beginExclusive(taskId);
    let completed: Task;
    let ornithLease: OrnithHealthyLease | null = null;
    try {
      ornithLease = await this.acquireOrnithLeaseIfNeeded(task, controller);

      const nextRound = task.currentRound + 1;
      const roundBeforeAttempt = task.currentRound;

      const correctionFindings = recovering
        ? this.describeBlockedRound(task.id)
        : renderOrnithCorrectionFindings(review as NonNullable<typeof review>);
      if (ornithLease !== null) {
        this.assertOrnithPromptFits({
          task,
          lease: ornithLease,
          specification: readSpecification(task),
          correctionFindings,
          round: nextRound
        });
      }

      const completeContinuationStart = await this.deps.continuationGuard?.prepareFirstAction(
        taskId,
        'corrections'
      );

      await this.recheckOrnithLeaseIfNeeded(ornithLease, controller.signal);

      task = this.applyEvent(task, 'corrections_sent', {
        currentRound: nextRound,
        lastError: null
      });
      completeContinuationStart?.();

      const prompt = recovering
        ? buildVerificationRetryPrompt({
            reason: this.describeBlockedRound(task.id),
            round: nextRound,
            maxRounds: task.maxRounds,
            ruleEvidence: this.ruleEvidenceText(task.id)
          })
        : buildCorrectionPrompt({
            // Checked above for the non-recovery path.
            review: review as NonNullable<typeof review>,
            round: nextRound,
            maxRounds: task.maxRounds,
            ruleEvidence: this.ruleEvidenceText(task.id)
          });

      completed = await this.runImplementation(task, controller, `${this.implementationPrompt(task, readSpecification(task))}\n\n${prompt}`, {
        runType: 'correction',
        recoverableFailure: 'correction_aborted',
        unverifiedFailure: 'correction_unverified',
        ornithLease,
        ornithCorrectionFindings: correctionFindings,
        roundBeforeAttempt
      });
    } catch (error) {
      this.recordFailureIfStillRunning(taskId, error, 'correction_aborted');
      throw error;
    } finally {
      ornithLease?.release();
      this.endExclusive(taskId);
    }

    return await this.runRelayVerificationAfterProvider(completed);
  }

  /**
   * Provider-side checks are useful diagnostics, but their sandbox is not the
   * authority for the repository. Once an implementation turn returns
   * normally, run Relay's verifier from the host process before review.
   *
   * Security, telemetry and configuration blocks deliberately do not reach
   * this path: a green test command must never hide an unsafe or incomplete
   * provider run.
   */
  private async runRelayVerificationAfterProvider(task: Task): Promise<Task> {
    if (!this.deps.verification) {
      return task;
    }
    if (task.status !== 'READY_FOR_IMPLEMENTATION' && task.status !== 'READY_FOR_REVIEW') {
      return task;
    }

    const result = readClaudeAssessment(
      latestClaudeRoundResult(this.deps.runs.listByTask(task.id))
    );
    if (!result.ok || result.assessment.publishBlock !== 'verification') {
      return task;
    }

    return await this.runVerification(task.id);
  }

  /**
   * Why the last round could not be published, for the retry prompt.
   *
   * Read back from the stored assessment rather than remembered in the task, so
   * it says what was actually recorded. A round with no readable assessment
   * gets a neutral sentence instead of a guess.
   */
  private describeBlockedRound(taskId: string): string {
    const stored = readClaudeAssessment(
      latestClaudeRoundResult(this.deps.runs.listByTask(taskId))
    );
    if (!stored.ok) {
      return 'The previous round left no usable record of whether its checks ran.';
    }

    const { assessment } = stored;
    if (assessment.verificationStatus === 'failed') {
      const command = assessment.verification?.command ?? 'the verification command';
      return `The previous round ran \u2018${command}\u2019 and it failed.`;
    }
    if (assessment.verificationStatus === 'not_run') {
      return 'The previous round never ran the project\u2019s verification command.';
    }
    return 'The previous round did not leave clear evidence that its checks passed.';
  }

  /**
   * Refuse to start Claude at all when the verification rules cannot be used.
   *
   * Checked here rather than trusting the Settings form: the renderer validates
   * for the user's benefit, but it is not a security boundary, and Settings can
   * be changed by other means between rounds. Throwing before the recorder
   * starts means no run row is written — an unusable configuration must not
   * leave behind something that looks like an implementation attempt.
   */
  private static assertVerificationConfigured(settings: Settings): void {
    const configured = resolveVerificationConfig(
      settings.claudeAllowedTools,
      settings.claudeVerificationTools
    );
    if (configured.ok) return;

    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'Claude verification rules are not usable, so this round cannot be judged.',
      {
        remediation:
          'Open Settings → Claude permissions and fix the verification commands. Each rule must ' +
          'be Bash(...) or PowerShell(...), may end in a single *, and must also appear in the ' +
          'pre-approved list.',
        details: configured.problems.map(describeConfigProblem).join(' ')
      }
    );
  }

  private assertImplementationConfigured(task: Task, settings: Settings): void {
    if (task.implementationProvider === 'claude') { Orchestrator.assertVerificationConfigured(settings); return; }
    const configured = resolveVerificationConfig(settings.claudeVerificationTools, settings.claudeVerificationTools);
    if (!configured.ok) throw new AgentRelayError('VALIDATION_FAILED', 'Configure valid implementation verification commands in Settings.');
  }

  /**
   * Before anything durable happens for an Ornith round: acquire the one
   * application-wide lease and confirm the already-retained runtime is
   * Healthy with a bounded health check. Never calls `start()`.
   *
   * Returns null for every other provider, so both call sites can treat this
   * uniformly with a single `ornithLease?.release()` in their `finally`.
   */
  private async acquireOrnithLeaseIfNeeded(task: Task, controller: AbortController): Promise<OrnithHealthyLease | null> {
    if (task.implementationProvider !== 'ornith') return null;
    if (!this.deps.ornithLease) {
      throw new AgentRelayError('TOOL_MISSING', 'Ornith is not configured in this build.');
    }
    const lease = await this.deps.ornithLease.acquireOrnithLease(controller.signal);
    // The independently callable `localInference:stop` may stop the runtime
    // this lease is using. When it does, abort this task's own controller so
    // the Ornith loop unwinds through its normal cancellation path — release
    // the lease, record the run cancelled, reconcile task state — rather than
    // only discovering the runtime is gone on its next turn.
    lease.onIndependentStop(() => controller.abort());
    return lease;
  }

  private assertOrnithPromptFits(input: {
    task: Task;
    lease: OrnithHealthyLease;
    specification: TaskSpecification;
    correctionFindings: string | null;
    round: number;
  }): void {
    const checked = preflightOrnithPrompt({
      specification: input.specification,
      ruleEvidence: this.ruleEvidenceText(input.task.id) ?? null,
      acceptedPlanReviewAddenda: this.acceptedPlanReviewRequirements(input.task.id) ?? null,
      correctionFindings: input.correctionFindings,
      round: input.round,
      maxRounds: input.task.maxRounds,
      lease: input.lease
    });
    if (checked.ok) return;
    throw new AgentRelayError('VALIDATION_FAILED', checked.reason, {
      remediation:
        `Increase Settings → Local inference → Context limit to at least ` +
        `${checked.requiredContextTokens} tokens, restart the runtime, and retry. No round was consumed.`
    });
  }

  /** Re-confirm a held lease immediately before the run is recorded. No-op when there is no lease. */
  private async recheckOrnithLeaseIfNeeded(lease: OrnithHealthyLease | null, signal: AbortSignal): Promise<void> {
    if (lease === null || !this.deps.ornithLease) return;
    const ok = await this.deps.ornithLease.recheckOrnithLease(lease, signal);
    if (!ok) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The local runtime is no longer Healthy, or its identity changed while the worktree was being prepared.',
        { remediation: 'Confirm the runtime is Healthy in Settings → Local inference, then try again.' }
      );
    }
  }

  private async runImplementation(task: Task, controller: AbortController, prompt: string,
    options: {
      runType: 'implementation' | 'correction';
      recoverableFailure: WorkflowEvent;
      /** Normal return with saved files but no trustworthy verification proof. */
      unverifiedFailure?: WorkflowEvent;
      /** Present only when `task.implementationProvider === 'ornith'`. */
      ornithLease?: OrnithHealthyLease | null;
      ornithCorrectionFindings?: string | null;
      /** Round value before this provider attempt began. */
      roundBeforeAttempt: number;
    }): Promise<Task> {
    const settings = this.deps.settings.get();
    const project = this.requireProject(task.projectId);
    const worktreePath = task.worktreePath;
    if (!worktreePath || !task.branchName) throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree.');
    assertSafeWorktreePath({ worktreePath, worktreesRoot: settings.worktreesRoot, repositoryPath: project.localPath });
    await this.deps.worktreeDependencies?.prepare({ repositoryPath: project.localPath, worktreePath });
    if (task.implementationProvider === 'claude') return this.runClaude(task, controller, prompt, options);
    if (task.implementationProvider === 'ornith') {
      if (!options.ornithLease) throw new AgentRelayError('INTERNAL', 'Ornith run started without a held lease.');
      return this.runOrnith(task, controller, options.ornithLease, {
        runType: options.runType,
        recoverableFailure: options.recoverableFailure,
        unverifiedFailure: options.unverifiedFailure,
        correctionFindings: options.ornithCorrectionFindings ?? null,
        roundBeforeAttempt: options.roundBeforeAttempt
      });
    }
    if (!this.deps.codex.implement) throw new AgentRelayError('TOOL_MISSING', 'This Codex adapter does not support implementation.');
    const configured = resolveVerificationConfig(settings.claudeVerificationTools, settings.claudeVerificationTools);
    if (!configured.ok) throw new AgentRelayError('VALIDATION_FAILED', 'Configure valid verification commands in Settings.');
    const handle = this.recorder(settings).start({ taskId: task.id, agent: 'codex', runType: options.runType, round: task.currentRound });
    try {
      const result = await this.deps.codex.implement({ worktreePath, prompt, sessionId: task.implementationThreadId,
        model: task.codexModel, verificationCommands: settings.claudeVerificationTools }, {
        signal: controller.signal, timeoutMs: settings.processTimeoutMs,
        onProgress: (event) => {
          handle.append(event);
          const thread = event.type === 'started' ? event.data?.['threadId'] : undefined;
          if (typeof thread === 'string' && thread.length > 0 && thread.length < 256) this.patchTask(task.id, { implementationThreadId: thread });
        }
      });
      const checked = readClaudeAssessment(JSON.stringify({ assessment: result.assessment }));
      const failed = !checked.ok || checked.assessment.disposition !== 'pass' || checked.assessment.publishBlock !== 'none' || checked.assessment.verificationStatus !== 'passed';
      const verificationOnly = checked.ok && checked.assessment.publishBlock === 'verification';
      const runFailed = failed && !(verificationOnly && this.deps.verification);
      const error = failed
        ? 'Changes were saved, but this Codex run did not prove verification passed. Run verification in Agent Relay to check the current files.'
        : null;
      const failureEvent = failed && checked.ok && checked.assessment.publishBlock !== 'security'
        ? (options.unverifiedFailure ?? options.recoverableFailure)
        : options.recoverableFailure;
      handle.finish({ status: runFailed ? 'failed' : 'succeeded', finalMessage: result.finalMessage,
        errorMessage: runFailed ? error ?? undefined : undefined, structuredResult: { provider: 'codex', providerRevision: task.providerRevision,
          sessionId: result.sessionId, assessment: result.assessment } });
      return this.applyEvent(
        this.requireTask(task.id),
        failed ? failureEvent : 'implementation_completed',
        {
          implementationThreadId: result.sessionId ?? this.requireTask(task.id).implementationThreadId,
          lastError: error
        }
      );
    } catch (error) {
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: Orchestrator.describeError(error) });
      throw error;
    }
  }

  /**
   * Ornith: a fresh stateless loop through the already-leased local runtime.
   *
   * Structurally mirrors the Codex branch above — the same `checked`/`failed`/
   * `runFailed` verdict mapping, the same `applyEvent` — with three
   * differences that follow directly from Ornith's contract: no session id is
   * ever persisted, the request is built from the specification and bounded
   * evidence directly rather than the Claude-style `buildImplementationPrompt`
   * text, and every completion is required to match the identity the lease
   * established.
   */
  private async runOrnith(
    task: Task,
    controller: AbortController,
    lease: OrnithHealthyLease,
    options: {
      runType: 'implementation' | 'correction';
      recoverableFailure: WorkflowEvent;
      unverifiedFailure?: WorkflowEvent;
      correctionFindings: string | null;
      roundBeforeAttempt: number;
    }
  ): Promise<Task> {
    const worktreePath = task.worktreePath;
    const branchName = task.branchName;
    if (!worktreePath || !branchName) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree to work in.');
    }
    if (!this.deps.ornith) {
      throw new AgentRelayError('TOOL_MISSING', 'Ornith is not configured in this build.');
    }
    if (!this.deps.ornithLease) {
      throw new AgentRelayError('TOOL_MISSING', 'Ornith is not configured in this build.');
    }
    if (!this.deps.processRunner) {
      throw new AgentRelayError('TOOL_MISSING', 'Ornith is not configured in this build.');
    }

    const settings = this.deps.settings.get();
    const project = this.requireProject(task.projectId);
    const specification = readSpecification(task);
    const handle = this.recorder(settings).start({
      taskId: task.id,
      agent: 'ornith',
      runType: options.runType,
      round: task.currentRound
    });

    try {
      const result = await this.deps.ornith.implement({
        worktreePath,
        worktreesRoot: settings.worktreesRoot,
        repositoryPath: project.localPath,
        branchName,
        specification,
        ruleEvidence: this.ruleEvidenceText(task.id) ?? null,
        acceptedPlanReviewAddenda: this.acceptedPlanReviewRequirements(task.id) ?? null,
        correctionFindings: options.correctionFindings,
        runType: options.runType,
        round: task.currentRound,
        maxRounds: task.maxRounds,
        loopDeadlineMs: Math.min(settings.processTimeoutMs, ORNITH_LIMITS.maxLoopDeadlineMs),
        signal: controller.signal,
        onProgress: (event) => handle.append(event),
        // `WorktreeVerification.execute` already applies its own timeout from
        // `settings.processTimeoutMs`; the remaining-loop-time budget the
        // caller passes here is diagnostic only, matching the fact that this
        // whole call is diagnostic — see the class comment.
        runVerification: async (signal, timeoutMs) => {
          const executor = this.deps.verification;
          if (!executor) return { passed: false, summary: 'Verification is not configured in this build.' };
          const outcome = await executor.execute(
            { task: this.requireTask(task.id), settings, project },
            AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
            () => undefined
          );
          const passed = outcome.exitCode === 0 && !outcome.failed && !outcome.timedOut && !outcome.cancelled;
          return { passed, summary: passed ? 'npm run verify passed.' : 'npm run verify did not pass.' };
        },
        lease,
        leaseService: this.deps.ornithLease,
        runner: this.deps.processRunner
      });

      const checked = readClaudeAssessment(JSON.stringify({ assessment: result.assessment }));
      const failed = !checked.ok || checked.assessment.disposition !== 'pass' || checked.assessment.publishBlock !== 'none' || checked.assessment.verificationStatus !== 'passed';
      const verificationOnly = checked.ok && checked.assessment.publishBlock === 'verification';
      const runFailed = failed && !(verificationOnly && this.deps.verification);
      const changedFiles = result.ornithAudit.changedFiles;
      const error = failed
        ? changedFiles === 0
          ? `Ornith stopped before changing any files. ${result.finalMessage}`
          : 'Ornith changed files, but this run did not prove verification passed. Run verification in Agent Relay to check the current files.'
        : null;
      const failureEvent = failed && changedFiles > 0 && checked.ok && checked.assessment.publishBlock !== 'security'
        ? (options.unverifiedFailure ?? options.recoverableFailure)
        : options.recoverableFailure;
      handle.finish({
        status: runFailed ? 'failed' : 'succeeded',
        finalMessage: result.finalMessage,
        errorMessage: runFailed ? error ?? undefined : undefined,
        structuredResult: {
          provider: 'ornith',
          providerRevision: task.providerRevision,
          runtimeProviderId: lease.providerId,
          runtimeInstanceId: lease.runtimeInstanceId,
          modelId: lease.modelId,
          counters: result.ornithAudit,
          providerFailure: result.providerFailure ?? null,
          assessment: result.assessment
        }
      });
      return this.applyEvent(
        this.requireTask(task.id),
        failed ? failureEvent : 'implementation_completed',
        {
          // Ornith never has a durable session; keep this explicitly null
          // regardless of what a stale value might otherwise hold.
          implementationThreadId: null,
          // Provider/configuration failures before the first mutation are
          // attempts, not review rounds. A retry must not silently lose budget.
          currentRound: failed && changedFiles === 0
            ? options.roundBeforeAttempt
            : task.currentRound,
          lastError: error
        }
      );
    } catch (error) {
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: Orchestrator.describeError(error) });
      throw error;
    }
  }

  /** Claude's existing evidence contract remains unchanged. */
  private async runClaude(
    task: Task,
    controller: AbortController,
    prompt: string,
    options: {
      runType: 'implementation' | 'correction';
      recoverableFailure: WorkflowEvent;
      unverifiedFailure?: WorkflowEvent;
    }
  ): Promise<Task> {
    const worktreePath = task.worktreePath;
    const branchName = task.branchName;
    if (!worktreePath || !branchName) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree to work in.');
    }

    // Read once, here, and use this one object for everything that follows: the
    // permission rules the CLI is given, the rules the round is judged against,
    // the timeout, the turn limit and the log budget. Preparing a worktree is
    // slow enough for Settings to change underneath it, and a round argued
    // against rules the process never had is worse than either version alone.
    const settings = this.deps.settings.get();

    // Re-validate the path every round: settings could have changed, or the
    // directory could have been moved between rounds.
    const project = this.requireProject(task.projectId);
    assertSafeWorktreePath({
      worktreePath,
      worktreesRoot: settings.worktreesRoot,
      repositoryPath: project.localPath
    });

    // Before anything is spawned and before a run exists: an unusable
    // configuration is a settings problem, not a failed implementation.
    Orchestrator.assertVerificationConfigured(settings);

    const handle = this.recorder(settings).start({
      taskId: task.id,
      agent: 'claude',
      runType: options.runType,
      round: task.currentRound
    });

    try {
      const result = await this.deps.claude.run(
        {
          worktreePath,
          branchName,
          prompt,
          // Resuming keeps every correction round inside one conversation.
          sessionId: task.claudeSessionId,
          maxTurns: settings.claudeMaxTurns,
          // From the same snapshot the policy will use below.
          allowedTools: settings.claudeAllowedTools,
          // From the task, never from current Settings: a correction round must
          // resume the same session on the same model it started with.
          model: task.claudeModel
        },
        {
          signal: controller.signal,
          timeoutMs: settings.processTimeoutMs,
          onProgress: (event) => handle.append(event),
          onSessionId: (sessionId) => {
            const current = this.requireTask(task.id);
            if (current.claudeSessionId !== sessionId) {
              this.patchTask(task.id, { claudeSessionId: sessionId });
            }
          }
        }
      );

      // What the round actually proved. Evidence from this process only:
      // invocation numbers restart with every Claude process, so a resumed
      // correction round is judged entirely on its own stream.
      const assessment = assessClaudeRound(result, {
        allowedTools: settings.claudeAllowedTools,
        verificationTools: settings.claudeVerificationTools
      });
      const record = toAssessmentRecord(assessment);
      const failed = assessment.disposition === 'fail';
      const verificationOnly = assessment.publishBlock === 'verification';
      const runFailed = failed && !(verificationOnly && this.deps.verification);

      // Appended before the run is closed, so it belongs to this round and is
      // replayed from the database in the same place after a restart.
      const warning = describeWarning(assessment);
      if (warning !== null) {
        handle.append({
          type: 'warning',
          text: warning,
          data: {
            verificationStatus: assessment.verificationStatus,
            publishBlock: assessment.publishBlock,
            denials: denialDetails(assessment.classifiedDenials)
          }
        });
      }

      const failureMessage = failed ? describeFailure(assessment) : null;

      handle.finish({
        status: runFailed ? 'failed' : 'succeeded',
        finalMessage: result.finalMessage,
        errorMessage: runFailed ? failureMessage ?? undefined : undefined,
        structuredResult: {
          provider: 'claude', providerRevision: task.providerRevision,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
          // Kept for diagnostics. It conflates a CLI failure with a denial, so
          // it is no longer what decides the outcome.
          cliReportedError: result.isError,
          evidence: {
            toolCalls: result.evidence.toolExecutions.length,
            resultEnvelopeSeen: result.evidence.resultEnvelopeSeen,
            resultEnvelopeIsError: result.evidence.resultEnvelopeIsError,
            resultEnvelopeConflict: result.evidence.resultEnvelopeConflict,
            malformedLineCount: result.evidence.malformedLineCount,
            incompleteToolUseCount: result.evidence.incompleteToolUseCount,
            orphanToolResultCount: result.evidence.orphanToolResultCount
          },
          assessment: record
        }
      });

      if (failed) {
        const failureEvent = assessment.publishBlock !== 'security'
          ? (options.unverifiedFailure ?? options.recoverableFailure)
          : options.recoverableFailure;
        return this.applyEvent(this.requireTask(task.id), failureEvent, {
          claudeSessionId: result.sessionId ?? task.claudeSessionId,
          lastError: failureMessage
        });
      }

      return this.applyEvent(this.requireTask(task.id), 'implementation_completed', {
        claudeSessionId: result.sessionId ?? task.claudeSessionId,
        lastError: null
      });
    } catch (error) {
      const message = Orchestrator.describeError(error);
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: message });
      this.applyEvent(
        this.requireTask(task.id),
        this.failureEvent(error, options.recoverableFailure, 'implementation_failed'),
        { lastError: message }
      );
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4. Review                                                           */
  /* ------------------------------------------------------------------ */

  async reviewWithCodex(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    const settings = this.deps.settings.get();

    if (task.status !== 'READY_FOR_REVIEW') {
      throw new InvalidTransitionError(task.status, 'review_started');
    }

    const specification = readSpecification(task);
    const worktreePath = task.worktreePath;
    const baseBranch = task.baseBranch;
    if (!worktreePath || !baseBranch) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree to review.');
    }

    // Verification itself costs no round. A NEW review after a completed review
    // still does: externally corrected files must not bypass the review budget.
    const priorReview = this.deps.runs.findLatestByType(taskId, 'review');
    const nextRound = this.effectiveVerificationRun(taskId) &&
      priorReview?.status === 'succeeded' && priorReview.round >= task.currentRound
      ? priorReview.round + 1 : Math.max(1, task.currentRound);
    if (nextRound > task.maxRounds) throw new AgentRelayError('VALIDATION_FAILED', 'The review round budget is exhausted. Verification does not reset it.');

    const controller = this.beginExclusive(taskId);
    let relayVerification: VerificationRecord | null;
    let completeContinuationStart: (() => void) | undefined;
    try {
      completeContinuationStart = await this.deps.continuationGuard?.prepareFirstAction(taskId, 'review');
      relayVerification = await this.assertVerificationCurrent(task);
    } catch (error) {
      const message = Orchestrator.describeError(error);
      const current = this.requireTask(taskId);
      const alreadyRetargeted = current.status === 'READY_FOR_IMPLEMENTATION';
      const retargeted = alreadyRetargeted || (completeContinuationStart !== undefined
        ? await this.deps.continuationGuard?.retargetFirstActionToVerification(taskId, message) ?? false
        : false);
      this.endExclusive(taskId);
      if (!retargeted) {
        this.applyEvent(this.requireTask(taskId), 'verification_invalidated', { lastError: message });
      }
      throw error;
    }
    const handle = this.recorder(settings).start({
      taskId,
      agent: task.reviewProvider,
      runType: 'review',
      round: nextRound
    });

    try {
      task = this.applyEvent(task, 'review_started', { lastError: null, currentRound: nextRound });
      completeContinuationStart?.();

      handle.append({ type: 'log', text: 'Collecting Git changes from the worktree…' });
      const changes = await this.deps.git.collectChanges(worktreePath, baseBranch, {
        maxDiffBytes: settings.maxDiffBytes
      });
      handle.append({
        type: 'log',
        text: `${changes.changedFiles.length} changed file(s), ${changes.diffBytes} diff characters${changes.diffTruncated ? ' (truncated for review)' : ''}.`,
        data: { changedFiles: changes.changedFiles.length, diffBytes: changes.diffBytes }
      });

      const claudeReport = this.deps.runs.findLatestByType(taskId, 'correction')?.finalMessage
        ?? this.deps.runs.findLatestByType(taskId, 'implementation')?.finalMessage
        ?? '';

      const reviewer = task.reviewProvider === 'claude' ? this.deps.claude : this.deps.codex;
      if (!reviewer.reviewImplementation) throw new AgentRelayError('TOOL_MISSING', 'The selected provider does not support review.');
      const outcome = await reviewer.reviewImplementation(
        {
          worktreePath,
          threadId: null,
          specification,
          ruleEvidence: this.ruleEvidenceText(task.id),
          changes,
          claudeReport,
          testOutput: extractTestOutput(claudeReport),
          relayVerification: relayVerification ?? undefined,
          round: task.currentRound,
          maxRounds: task.maxRounds,
          model: task.reviewProvider === 'claude' ? task.claudeModel : task.codexModel
        },
        {
          signal: controller.signal,
          timeoutMs: settings.processTimeoutMs,
          onProgress: (event) => handle.append(event)
        }
      );

      await this.assertVerificationCurrent(this.requireTask(taskId));
      handle.finish({
        status: 'succeeded',
        finalMessage: outcome.review.summary,
        structuredResult: { ...outcome.review, provider: task.reviewProvider, threadId: outcome.threadId }
      });

      return this.applyReviewOutcome(taskId, outcome.review, outcome.threadId, settings);
    } catch (error) {
      const message = Orchestrator.describeError(error);
      handle.finish({ status: isCancelled(error) ? 'cancelled' : 'failed', errorMessage: message });
      this.applyEvent(this.requireTask(taskId), this.failureEvent(error, 'review_aborted', 'review_failed'), {
        lastError: message
      });
      throw error;
    } finally {
      this.endExclusive(taskId);
    }
  }

  /**
   * Turn a Codex verdict into a state change, applying the round budget.
   *
   * This is where the loop is guaranteed to end: when the budget is exhausted
   * the task is moved to REVIEW_LIMIT_REACHED with an explanatory message,
   * and a `blocked` verdict moves it to REVIEW_BLOCKED (via `decideReviewOutcome`
   * and the `review_blocked` transition) — neither is mislabeled as a
   * technical failure, and neither leaves the task in a state from which
   * another implementation round could start automatically.
   */
  private applyReviewOutcome(
    taskId: string,
    review: CodexReviewResult,
    _threadId: string | null,
    _settings: Settings
  ): Task {
    const task = this.requireTask(taskId);
    const decision = decideReviewOutcome(review.verdict, task.currentRound, task.maxRounds);

    // `lastError` is the durable explanatory note the UI shows for why a task
    // stopped, not strictly a technical error — REVIEW_LIMIT_REACHED already
    // uses it for the round-budget halt reason below. A blocked verdict has no
    // halt reason (it isn't round-dependent), so it carries the reviewer's own
    // summary instead of leaving the note empty.
    const lastError = decision.haltReason ?? (review.verdict === 'blocked' ? review.summary : null);

    const updated = this.applyEvent(task, decision.event, {
      lastReviewJson: JSON.stringify(review),
      lastError
    });

    if (decision.haltReason) {
      return this.applyEvent(updated, 'max_rounds_reached', { lastError: decision.haltReason });
    }

    return updated;
  }

  /* ------------------------------------------------------------------ */
  /* 5. Control                                                          */
  /* ------------------------------------------------------------------ */

  /** Approve the finished work for publishing. Does not publish anything. */
  approveForPublishing(taskId: string): Task {
    const task = this.requireTask(taskId);
    return this.applyEvent(task, 'publish_approved');
  }

  /**
   * Stop the task. Aborts any in-flight agent process and moves the task to
   * CANCELLED — one of the three ways the relay loop is allowed to end.
   */
  stop(taskId: string): Task {
    const task = this.requireTask(taskId);
    const controller = this.inFlight.get(taskId);

    if (controller) {
      controller.abort();
      // The in-flight operation's own catch block writes the CANCELLED state and
      // closes its run record; returning the current task avoids racing it.
      return task;
    }

    const stopped = this.applyEvent(task, 'cancelled', { lastError: 'Stopped by the user.' });
    const continuation = this.deps.continuations?.findByContinuation(taskId);
    if (continuation) this.deps.continuations?.deleteClaim(continuation.sourceTaskId);
    return stopped;
  }

  async collectChanges(taskId: string): Promise<GitChangeSet> {
    const task = this.requireTask(taskId);
    const settings = this.deps.settings.get();

    if (!task.worktreePath || !task.baseBranch) {
      throw new AgentRelayError('WORKTREE_INVALID', 'This task does not have a worktree yet.');
    }

    const project = this.requireProject(task.projectId);
    assertSafeWorktreePath({
      worktreePath: task.worktreePath,
      worktreesRoot: settings.worktreesRoot,
      repositoryPath: project.localPath
    });

    return this.deps.git.collectChanges(task.worktreePath, task.baseBranch, {
      maxDiffBytes: settings.maxDiffBytes
    });
  }

  /**
   * If an error escaped before the inner handler could record it, make sure the
   * task does not stay stuck in a busy state.
   */
  private recordFailureIfStillRunning(
    taskId: string,
    error: unknown,
    recoverable: WorkflowEvent
  ): void {
    const task = this.deps.tasks.findById(taskId);
    if (!task || !isBusy(task.status)) return;

    try {
      this.applyEvent(task, this.failureEvent(error, recoverable, 'implementation_failed'), {
        lastError: Orchestrator.describeError(error)
      });
    } catch {
      // The inner handler already moved the task; nothing further to do.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isCancelled(error: unknown): boolean {
  return error instanceof AgentRelayError && error.code === 'CANCELLED';
}

export function readSpecification(task: Task): TaskSpecification {
  if (!task.specificationJson) {
    throw new AgentRelayError('VALIDATION_FAILED', 'This task has no specification yet.');
  }
  try {
    return taskSpecificationSchema.parse(JSON.parse(task.specificationJson));
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored specification could not be read.', {
      details: error instanceof Error ? error.message : String(error),
      remediation: 'Generate the specification again.'
    });
  }
}

export function readReview(task: Task): CodexReviewResult | null {
  if (!task.lastReviewJson) return null;
  const parsed = codexReviewResultSchema.safeParse(JSON.parse(task.lastReviewJson));
  return parsed.success ? parsed.data : null;
}

/**
 * Bounded correction findings for Ornith, built directly from the review's
 * structured data rather than {@link buildCorrectionPrompt}'s Claude-flavoured
 * prose — that builder's framing ("keep working in the same worktree",
 * git-command references) does not describe Ornith's tool-only contract.
 */
export function renderOrnithCorrectionFindings(review: CodexReviewResult): string {
  const safeText = (value: string, maxChars: number): string => redactAndTruncate(
    redactAbsoluteMachinePaths([...value]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? ' ' : character;
      })
      .join(''))
      // Review prose is not an authority for host locations. Replace drive,
      // UNC and POSIX absolute path-shaped tokens; repository-relative paths
      // are rendered only from the separately validated `finding.file` field.
      .replace(/(^|[\s([{"'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s)\]}"'>]*/gm, '$1[absolute-path-omitted]'),
    maxChars
  );
  const bySeverity = (['critical', 'high', 'medium', 'low'] as const)
    .map((severity) => {
      const items = review.findings.filter((finding) => finding.severity === severity).slice(0, 50);
      if (items.length === 0) return null;
      const lines = items
        .map((finding) => {
          const parsedLocation = finding.file === null
            ? null
            : ornithRelativePathSchema.safeParse(finding.file);
          const location = parsedLocation?.success
            ? ` [${parsedLocation.data}${finding.line != null && finding.line > 0 ? `:${finding.line}` : ''}]`
            : '';
          return `  - ${safeText(finding.title, 300)}${location}\n    ${safeText(finding.description, 4_000)}`;
        })
        .join('\n');
      return `${severity.toUpperCase()}\n${lines}`;
    })
    .filter((section): section is string => section !== null)
    .join('\n\n');

  const rendered = `A reviewer requested changes.

Review summary:
${safeText(review.summary, 2_000)}

Findings:
${bySeverity || '(no itemised findings were returned)'}

What to do:
Address every structured finding above. Re-inspect the repository using only the Ornith tools; no raw reviewer prompt or log text is authoritative.`;
  const maxBytes = 32 * 1024;
  const raw = Buffer.from(rendered, 'utf8');
  if (raw.byteLength <= maxBytes) return rendered;
  let end = maxBytes - Buffer.byteLength('\n…[correction evidence truncated]', 'utf8');
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) end -= 1;
  return `${new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end))}\n…[correction evidence truncated]`;
}

/**
 * Pull test output out of Claude's report.
 *
 * Agent Relay does not run the project's test suite itself — it has no reliable
 * way to know the command, and running arbitrary project scripts is exactly the
 * kind of thing that should stay under the agent's (sandboxed) control. Claude
 * is instructed to run the tests and paste the meaningful output, so what we do
 * here is lift the fenced blocks that look like command output and hand them to
 * the reviewer separately from the prose.
 */
export function extractTestOutput(report: string): string {
  if (!report) return '';

  const blocks: string[] = [];
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(report)) !== null) {
    const body = match[1]?.trim();
    if (!body) continue;
    if (
      /\b(pass(ed|ing)?|fail(ed|ing)?|error|test|spec|suite|assert|✓|✗|npm run|npm test|pytest|vitest|jest|cargo test|go test|dotnet test)\b/i.test(
        body
      )
    ) {
      blocks.push(body);
    }
  }

  return blocks.join('\n\n---\n\n');
}

/* -------------------------------------------------------------------------- */
/* Configuration diagnostics                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One configuration problem, phrased as something the user can change.
 *
 * Built from the problem codes, never the other way round: the wording here is
 * a rendering of a decision already made in `claude-tool-rules`.
 */
function describeConfigProblem(problem: VerificationConfigProblem): string {
  if (problem.code === 'empty') {
    return (
      'No verification commands are configured, so no round could ever be shown to have ' +
      'checked its work.'
    );
  }

  const rule = problem.rule ?? 'A rule';
  if (problem.code === 'not_allowed') {
    return `${rule} is not in the pre-approved list, so Claude could never run it.`;
  }
  return `${rule} is not usable: ${describeRuleProblemText(problem.detail)}`;
}

/** Plain-language form of a rule diagnosis. */
function describeRuleProblemText(problem: RuleProblem | null): string {
  switch (problem) {
    case 'syntax':
      return 'it is not written as Tool(command).';
    case 'unsupported_tool':
      return 'only Bash(...) and PowerShell(...) are supported.';
    case 'empty_body':
      return 'it names no command.';
    case 'wildcard':
      return 'a * is only allowed as the single final character.';
    case 'compound':
      return (
        'chained commands are not accepted, and a separator inside a quoted argument counts ' +
        'as chaining.'
      );
    case 'wrapper':
      return 'a command that runs another command, such as cmd /c, cannot be verified.';
    default:
      return 'it could not be parsed.';
  }
}
