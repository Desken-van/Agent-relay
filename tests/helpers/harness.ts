/**
 * Builds a fully wired application against an in-memory SQLite database and
 * fake adapters. Every orchestration test uses this, so the code under test is
 * the real orchestrator, the real repositories and the real state machine.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApprovalRepository } from '../../src/main/db/repositories/approval-repository';
import { SqliteProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SqlitePlanReviewGateRepository } from '../../src/main/db/repositories/plan-review-gate-repository';
import { SqliteRunEventRepository } from '../../src/main/db/repositories/run-event-repository';
import { SqliteRunRepository } from '../../src/main/db/repositories/run-repository';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { SqliteTaskContinuationRepository } from '../../src/main/db/repositories/task-continuation-repository';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { SqliteTaskRuleEvidenceRepository } from '../../src/main/db/repositories/task-rule-evidence-repository';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { ContinuationService } from '../../src/main/services/continuation-service';
import { Orchestrator, type OrchestratorDeps } from '../../src/main/services/orchestrator';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import type { WorktreeDependencyInstaller, WorktreeDependencyPreparer } from '../../src/main/services/worktree-dependencies';
import { ProjectService } from '../../src/main/services/project-service';
import { PublishService } from '../../src/main/services/publish-service';
import { TaskService } from '../../src/main/services/task-service';
import { defaultSettings } from '../../src/main/container';
import type { OrnithInferenceLeaseService } from '../../src/main/ports';
import type { OrnithImplementationService } from '../../src/main/services/ornith-implementation';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { TaskOperationRegistry } from '../../src/main/services/task-operations';
import { localInferenceProfileFingerprint } from '../../src/main/services/local-inference-profile-fingerprint';
import type { Project, Settings, Task } from '../../src/shared/domain/models';
import {
  FakeClaudeAdapter,
  FakeCodexAdapter,
  FakeGitAdapter,
  FakeGitHubAdapter,
  RecordingConfirmationService,
  makeReview
} from './fakes';

export interface Harness {
  readonly db: Db;
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly events: InMemoryEventPublisher;
  readonly codex: FakeCodexAdapter;
  readonly claude: FakeClaudeAdapter;
  readonly git: FakeGitAdapter;
  readonly github: FakeGitHubAdapter;
  readonly confirmation: RecordingConfirmationService;
  readonly projects: SqliteProjectRepository;
  readonly tasks: SqliteTaskRepository;
  readonly taskRuleEvidence: SqliteTaskRuleEvidenceRepository;
  readonly planReviewGates: SqlitePlanReviewGateRepository;
  readonly taskContinuations: SqliteTaskContinuationRepository;
  readonly runs: SqliteRunRepository;
  readonly runEvents: SqliteRunEventRepository;
  readonly approvals: SqliteApprovalRepository;
  readonly settings: SqliteSettingsRepository;
  readonly orchestrator: Orchestrator;
  /** The process-wide register of stoppable operations, shared with `orchestrator.stop()`. */
  readonly operations: TaskOperationRegistry;
  readonly publishService: PublishService;
  readonly continuationService: ContinuationService;
  readonly projectService: ProjectService;
  readonly taskService: TaskService;
  readonly worktreesRoot: string;
  createProject(overrides?: Partial<Project>): Project;
  createTask(projectId: string, overrides?: Partial<Task>): Task;
  dispose(): void;
}

export function createHarness(
  options: {
    confirmAnswer?: boolean;
    settings?: Partial<Settings>;
    verification?: VerificationExecutor;
    worktreeDependencies?: WorktreeDependencyPreparer;
    worktreeDependencyInstaller?: WorktreeDependencyInstaller;
    /** Present only in tests that exercise Ornith routing; absent everywhere else, matching production's optional wiring. */
    ornith?: OrnithImplementationService;
    ornithLease?: OrnithInferenceLeaseService;
    processRunner?: ProcessRunner;
    /** Findings accepted from an external code review; absent in every test that is not about them. */
    externalCodeRequirements?: OrchestratorDeps['externalCodeRequirements'];
  } = {}
): Harness {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agent-relay-test-'));
  const db = openDatabase({ file: ':memory:' });

  const clock = new FixedClock();
  const ids = new SequentialIdGenerator('t');
  const events = new InMemoryEventPublisher();

  const baseDefaults = defaultSettings({
    dataDir: tempRoot,
    documentsDir: tempRoot
  });
  const worktreesRoot = join(tempRoot, 'worktrees');

  const settings = new SqliteSettingsRepository(db, {
    ...baseDefaults,
    worktreesRoot,
    projectsRoot: join(tempRoot, 'projects'),
    ...options.settings
  });

  const projects = new SqliteProjectRepository(db, clock);
  const tasks = new SqliteTaskRepository(db, clock);
  const taskRuleEvidence = new SqliteTaskRuleEvidenceRepository(db);
  const planReviewGates = new SqlitePlanReviewGateRepository(db, clock);
  const taskContinuations = new SqliteTaskContinuationRepository(db, clock);
  const runs = new SqliteRunRepository(db);
  const runEvents = new SqliteRunEventRepository(db);
  const approvals = new SqliteApprovalRepository(db);

  const codex = new FakeCodexAdapter();
  const claude = new FakeClaudeAdapter();
  const git = new FakeGitAdapter();
  const github = new FakeGitHubAdapter();
  const confirmation = new RecordingConfirmationService(options.confirmAnswer ?? true);

  const runtime: { orchestrator?: Orchestrator } = {};
  // The one process-wide register, exactly as the composition root builds it: the
  // orchestrator's stop() and every plan-review service a test builds share it.
  const operations = new TaskOperationRegistry();
  const continuationService = new ContinuationService({
    tasks,
    projects,
    runs,
    settings,
    ruleEvidence: taskRuleEvidence,
    planReviews: planReviewGates,
    continuations: taskContinuations,
    transactions: new SqliteTransactionRunner(db),
    verification: options.verification,
    clock,
    ids,
    events,
    isSourceBusy: (taskId) => runtime.orchestrator?.isRunning(taskId) ?? false
  });

  const orchestrator = new Orchestrator({
    verification: options.verification,
    worktreeDependencies: options.worktreeDependencies,
    worktreeDependencyInstaller: options.worktreeDependencyInstaller,
    projects,
    tasks,
    runs,
    runEvents,
    settings,
    codex,
    claude,
    git,
    clock,
    ids,
    events,
    ruleEvidence: taskRuleEvidence,
    planReviews: planReviewGates,
    continuations: taskContinuations,
    externalCodeRequirements: options.externalCodeRequirements,
    continuationGuard: {
      prepareFirstAction: (...args) => continuationService.prepareFirstAction(...args),
      retargetFirstActionToVerification: (...args) =>
        continuationService.retargetFirstActionToVerification(...args),
      assertSpecificationAllowed: (taskId) => continuationService.assertSpecificationAllowed(taskId)
    },
    ornith: options.ornith,
    ornithLease: options.ornithLease,
    processRunner: options.processRunner,
    operations
  });

  const publishService = new PublishService({
    verification: options.verification,
    tasks,
    projects,
    approvals,
    runs,
    runEvents,
    settings,
    git,
    github,
    confirmation,
    clock,
    ids,
    events,
    continuations: taskContinuations
  });

  const projectService = new ProjectService({
    projects,
    settings,
    git,
    confirmation,
    clock,
    ids,
    events
  });

  runtime.orchestrator = orchestrator;

  const taskService = new TaskService({
    tasks,
    projects,
    runs,
    approvals,
    settings,
    clock,
    ids,
    events,
    continuations: taskContinuations
  });

  return {
    db,
    clock,
    ids,
    events,
    codex,
    claude,
    git,
    github,
    confirmation,
    projects,
    tasks,
    taskRuleEvidence,
    planReviewGates,
    taskContinuations,
    runs,
    runEvents,
    approvals,
    settings,
    orchestrator,
    operations,
    publishService,
    continuationService,
    projectService,
    taskService,
    worktreesRoot,

    createProject(overrides = {}) {
      return projects.create({
        id: ids.next(),
        name: 'Demo',
        localPath: 'C:\\repo',
        projectType: 'existing',
        defaultBranch: 'main',
        githubOwner: 'Desken-van',
        githubRepo: 'demo',
        githubVisibility: 'private',
        ...overrides
      });
    },

    createTask(projectId, overrides = {}) {
      // A caller asking for `implementationProvider: 'ornith'` without naming a profile gets bound to
      // whichever profile Settings currently marks default — exactly what `configureProviders`/`create()`
      // would have resolved and snapshotted for a real task, so every existing Ornith-routing test keeps
      // working without each one having to name a profile explicitly. An override that already sets either
      // profile field is left untouched.
      const ornithBinding =
        overrides.implementationProvider === 'ornith' &&
        overrides.ornithModelProfileId === undefined &&
        overrides.ornithModelProfileFingerprint === undefined
          ? (() => {
              const localInference = settings.get().localInference;
              const profile = localInference.profiles.find((p) => p.id === localInference.defaultProfileId);
              return profile === undefined
                ? null
                : {
                    ornithModelProfileId: profile.id,
                    ornithModelProfileFingerprint: localInferenceProfileFingerprint(profile)
                  };
            })()
          : null;
      return tasks.create({
        id: ids.next(),
        projectId,
        title: 'Add health endpoint',
        originalRequest: 'Please add a health endpoint.',
        status: 'DRAFT',
        currentRound: 0,
        maxRounds: 3,
        codexThreadId: null,
        claudeSessionId: null,
        codexModel: null,
        claudeModel: null,
        worktreePath: null,
        branchName: null,
        baseBranch: null,
        specificationJson: null,
        specificationApprovedAt: null,
        lastReviewJson: null,
        lastError: null,
        ...(ornithBinding ?? {}),
        ...overrides
      });
    },

    dispose() {
      closeDatabase(db);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

/** Drive a task from DRAFT to READY_FOR_REVIEW using the fake adapters. */
export async function runToReview(harness: Harness): Promise<{ project: Project; task: Task }> {
  const project = harness.createProject();
  const created = harness.createTask(project.id);

  await harness.orchestrator.generateSpecification(created.id);
  harness.orchestrator.approveSpecification(created.id);
  await harness.orchestrator.sendToClaude(created.id);

  const task = harness.tasks.findById(created.id);
  if (!task) throw new Error('task disappeared');
  return { project, task };
}

export async function runToFailedRoundExhaustion(
  harness: Harness,
  options: { maxRounds?: number } = {}
): Promise<{ project: Project; task: Task }> {
  const maxRounds = options.maxRounds ?? 1;
  const { project, task: afterImplementation } = await runToReview(harness);
  harness.tasks.update(afterImplementation.id, { maxRounds });

  await harness.orchestrator.runVerification(afterImplementation.id);
  harness.codex.reviewQueue.push(makeReview({ verdict: 'changes_requested', summary: 'Needs one more pass.' }));
  const reviewed = await harness.orchestrator.reviewWithCodex(afterImplementation.id);
  if (reviewed.status !== 'REVIEW_LIMIT_REACHED') {
    throw new Error(`Expected the task to stop at its review limit, got ${reviewed.status}.`);
  }
  return { project, task: reviewed };
}

/** Drive a task from DRAFT to REVIEW_BLOCKED using the fake adapters. */
export async function runToBlockedReview(
  harness: Harness,
  options: { maxRounds?: number } = {}
): Promise<{ project: Project; task: Task }> {
  const maxRounds = options.maxRounds ?? 3;
  const { project, task: afterImplementation } = await runToReview(harness);
  harness.tasks.update(afterImplementation.id, { maxRounds });

  await harness.orchestrator.runVerification(afterImplementation.id);
  harness.codex.reviewQueue.push(makeReview({ verdict: 'blocked', summary: 'Wrong approach.' }));
  const reviewed = await harness.orchestrator.reviewWithCodex(afterImplementation.id);
  if (reviewed.status !== 'REVIEW_BLOCKED') {
    throw new Error(`Expected the task to be blocked by review, got ${reviewed.status}.`);
  }
  return { project, task: reviewed };
}
