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
  latestClaudeRoundResult,
  readClaudeAssessment
} from '../../shared/domain/claude-assessment';
import { AgentRelayError, InvalidTransitionError } from '../../shared/domain/errors';
import type { GitChangeSet } from '../../shared/domain/git';
import type { Project, Settings, Task } from '../../shared/domain/models';
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
  buildVerificationRetryPrompt
} from '../adapters/codex/prompts';
import type {
  ClaudeAdapter,
  Clock,
  CodexAdapter,
  EventPublisher,
  GitAdapter,
  IdGenerator,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SettingsRepository,
  TaskRepository
} from '../ports';
import { assertSafeWorktreePath, isSamePath } from './path-safety';
import { assessClaudeRound } from './claude-round-policy';
import {
  denialDetails,
  describeFailure,
  describeWarning,
  toAssessmentRecord
} from './claude-round-report';
import { RunRecorder } from './run-recorder';
import { join } from 'node:path';

export interface OrchestratorDeps {
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

    return this.patchTask(taskId, { specificationApprovedAt: this.deps.clock.nowIso() });
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

    const specification = readSpecification(task);

    // Before the worktree, not after: creating a branch and a directory for a
    // round that cannot legally start leaves debris the user has to clean up,
    // for a failure that was knowable before any of it happened.
    Orchestrator.assertVerificationConfigured(settings);

    const controller = this.beginExclusive(taskId);
    try {
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

      task = this.applyEvent(task, 'implementation_started', {
        currentRound: 1,
        lastError: null
      });

      const prompt = buildImplementationPrompt({
        specification,
        worktreePath,
        branchName,
        originalRequest: task.originalRequest
      });

      return await this.runClaude(task, controller, prompt, {
        runType: 'implementation',
        recoverableFailure: 'implementation_aborted'
      });
    } catch (error) {
      this.recordFailureIfStillRunning(taskId, error, 'implementation_aborted');
      throw error;
    } finally {
      this.endExclusive(taskId);
    }
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
    Orchestrator.assertVerificationConfigured(settings);

    const review = readReview(task);
    if (!review && !recovering) {
      throw new AgentRelayError('VALIDATION_FAILED', 'There is no review to send corrections from.');
    }
    if (!task.worktreePath || !task.branchName) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task has no worktree to work in.');
    }

    const controller = this.beginExclusive(taskId);
    try {
      const nextRound = task.currentRound + 1;
      task = this.applyEvent(task, 'corrections_sent', {
        currentRound: nextRound,
        lastError: null
      });

      const prompt = recovering
        ? buildVerificationRetryPrompt({
            reason: this.describeBlockedRound(task.id),
            round: nextRound,
            maxRounds: task.maxRounds
          })
        : buildCorrectionPrompt({
            // Checked above for the non-recovery path.
            review: review as NonNullable<typeof review>,
            round: nextRound,
            maxRounds: task.maxRounds
          });

      return await this.runClaude(task, controller, prompt, {
        runType: 'correction',
        recoverableFailure: 'correction_aborted'
      });
    } catch (error) {
      this.recordFailureIfStillRunning(taskId, error, 'correction_aborted');
      throw error;
    } finally {
      this.endExclusive(taskId);
    }
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

  /** Shared body of the first implementation round and every correction round. */
  private async runClaude(
    task: Task,
    controller: AbortController,
    prompt: string,
    options: { runType: 'implementation' | 'correction'; recoverableFailure: WorkflowEvent }
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
          onProgress: (event) => handle.append(event)
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
        status: failed ? 'failed' : 'succeeded',
        finalMessage: result.finalMessage,
        errorMessage: failureMessage ?? undefined,
        structuredResult: {
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
        return this.applyEvent(this.requireTask(task.id), options.recoverableFailure, {
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

    const controller = this.beginExclusive(taskId);
    const handle = this.recorder(settings).start({
      taskId,
      agent: 'codex',
      runType: 'review',
      round: task.currentRound
    });

    try {
      task = this.applyEvent(task, 'review_started', { lastError: null });

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

      const outcome = await this.deps.codex.reviewImplementation(
        {
          worktreePath,
          threadId: task.codexThreadId,
          specification,
          changes,
          claudeReport,
          testOutput: extractTestOutput(claudeReport),
          round: task.currentRound,
          maxRounds: task.maxRounds,
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
        finalMessage: outcome.review.summary,
        structuredResult: outcome.review
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
   * the task is moved to FAILED with an explanatory message instead of being
   * left in a state from which another Claude round could start.
   */
  private applyReviewOutcome(
    taskId: string,
    review: CodexReviewResult,
    threadId: string | null,
    _settings: Settings
  ): Task {
    const task = this.requireTask(taskId);
    const decision = decideReviewOutcome(review.verdict, task.currentRound, task.maxRounds);

    const updated = this.applyEvent(task, decision.event, {
      codexThreadId: threadId ?? task.codexThreadId,
      lastReviewJson: JSON.stringify(review),
      lastError: decision.haltReason ?? null
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

    return this.applyEvent(task, 'cancelled', { lastError: 'Stopped by the user.' });
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
