/**
 * Composition root.
 *
 * The only place where concrete implementations are chosen. Everything below
 * this file depends on the interfaces in `ports.ts`, which is what lets the
 * orchestration tests swap in fake Codex/Claude/Git/GitHub adapters without a
 * single mock of a module.
 *
 * Note the settings-aware adapter construction: executable paths and timeouts
 * come from the database, so changing them in Settings takes effect on the next
 * operation without restarting the app.
 */

import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_VERIFICATION_TOOLS,
  type Settings
} from '../shared/domain/models';
import { defaultLocalInferenceSettings } from '../shared/domain/local-inference';
import { ClaudeCliAdapter } from './adapters/claude/claude-adapter';
import { CodexSdkAdapter } from './adapters/codex/codex-adapter';
import { CodexAppServerModelCatalog } from './adapters/codex/codex-model-catalog';
import { CliGitAdapter } from './adapters/git/git-adapter';
import { GhGitHubAdapter } from './adapters/github/github-adapter';
import { CoaiPlanReviewer } from './adapters/mcp/coai-plan-reviewer';
import { StdioMcpClient } from './adapters/mcp/stdio-mcp-client';
import { LocalSqliteProbeAdapter } from './adapters/operations/local-sqlite-adapter';
import {
  LlamaCppLocalInference,
  type LocalInferenceProcessRunner
} from './adapters/local-inference/llama-cpp-local-inference';
import { ExecaProcessRunner, type ProcessRunner } from './adapters/process/process-runner';
import { FilesystemRuleSourceReader } from './adapters/rules/filesystem-rule-source';
import { closeDatabase, openDatabase, type Db } from './db/database';
import { SqliteTransactionRunner } from './db/transaction-runner';
import { SqliteApprovalRepository } from './db/repositories/approval-repository';
import { SqliteOperationDiagnosticRepository } from './db/repositories/operation-diagnostic-repository';
import { SqliteOperationTargetRepository } from './db/repositories/operation-target-repository';
import { SqlitePlanReviewGateRepository } from './db/repositories/plan-review-gate-repository';
import { SqliteProjectRepository } from './db/repositories/project-repository';
import { SqliteRunEventRepository } from './db/repositories/run-event-repository';
import { SqliteRunRepository } from './db/repositories/run-repository';
import { SqliteSettingsRepository } from './db/repositories/settings-repository';
import { SqliteTaskContinuationRepository } from './db/repositories/task-continuation-repository';
import { SqliteTaskRepository } from './db/repositories/task-repository';
import { SqliteTaskRuleEvidenceRepository } from './db/repositories/task-rule-evidence-repository';
import { SystemClock, UuidGenerator } from './infra/clock';
import type {
  ApprovalRepository,
  ClaudeAdapter,
  OperationDiagnosticRepository,
  OperationTargetRepository,
  Clock,
  CodexAdapter,
  CodexModelCatalog,
  ConfirmationService,
  EventPublisher,
  ExternalMcpServerConfig,
  GitAdapter,
  GitHubAdapter,
  IdGenerator,
  CodeReviewRepository,
  PlanReviewGateRepository,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SettingsRepository,
  LocalInferenceLifecycleService,
  TaskContinuationRepository,
  TaskRepository,
  TaskRuleEvidenceRepository
} from './ports';
import { ToolDiagnosticsService } from './services/diagnostics-service';
import { CoaiCapabilityService } from './services/coai-capability-service';
import { ContinuationService, reconcileContinuationClaims } from './services/continuation-service';
import { OperationsDiagnosticsService } from './services/operations-diagnostics-service';
import { OperationsRegistry } from './services/operations-registry';
import { Orchestrator } from './services/orchestrator';
import { WorktreeVerification } from './services/worktree-verification';
import { LocalWorktreeDependencyPreparer } from './services/worktree-dependencies';
import { ProjectService } from './services/project-service';
import { reconcileInterruptedWork, type ReconciliationPlan } from './services/startup-reconciliation';
import { PublishService } from './services/publish-service';
import { TaskService } from './services/task-service';
import { SqliteCodeReviewRepository } from './db/repositories/code-review-repository';
import { GitCodeSnapshotSource } from './adapters/git/git-code-snapshot';
import { CodeReviewClaims, CodeReviewService } from './services/code-review';
import { SettingsBoundCodeReviewer } from './services/code-review-provider';
import { PlanReviewClaims } from './services/plan-review-claims';
import { PlanReviewGateService } from './services/plan-review-gate';
import { RuleEvidenceService } from './services/rule-evidence';
import {
  LocalInferenceService,
  type LocalInferenceProviderFactory
} from './services/local-inference-service';
import { OrnithImplementationService } from './services/ornith-implementation';

export interface ApplicationPaths {
  /** Directory holding the SQLite database and worktrees. */
  readonly dataDir: string;
  /** Default parent folder for newly created projects. */
  readonly documentsDir: string;
}

export function defaultSettings(paths: ApplicationPaths): Settings {
  return {
    localInference: defaultLocalInferenceSettings(),
    claudeExecutablePath: process.env.AGENT_RELAY_CLAUDE_PATH ?? null,
    codexExecutablePath: process.env.AGENT_RELAY_CODEX_PATH ?? null,
    ghExecutablePath: process.env.AGENT_RELAY_GH_PATH ?? null,
    externalPlanReviewEnabled: false,
    externalCodeReviewEnabled: false,
    coaiMcpExecutablePath: null,
    coaiMcpArguments: [],
    coaiMcpWorkingDirectory: null,
    coaiLastKnownContractFingerprint: null,
    coaiLastKnownContractCheckedAt: null,
    conventionsRepositoryPath: null,
    conventionsExpectedRevision: null,
    conventionsRulePaths: [],
    githubOwner: 'Desken-van',
    projectsRoot: join(paths.documentsDir, 'AgentRelayProjects'),
    worktreesRoot: join(paths.dataDir, 'worktrees'),
    maxReviewRounds: 3,
    processTimeoutMs: 30 * 60_000,
    maxStoredLogBytes: 2_000_000,
    maxDiffBytes: 400_000,
    claudeMaxTurns: 80,
    claudeAllowedTools: [...DEFAULT_CLAUDE_ALLOWED_TOOLS],
    claudeVerificationTools: [...DEFAULT_CLAUDE_VERIFICATION_TOOLS],
    // Defaults for the *new task* form only. A task snapshots its own pair.
    codexModel: null,
    claudeModel: null
  };
}

export interface Application {
  readonly db: Db;
  readonly settings: SettingsRepository;
  /** One process-local lifecycle owner for the configured local runtime. */
  readonly localInference: LocalInferenceLifecycleService;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly runEvents: RunEventRepository;
  readonly approvals: ApprovalRepository;
  readonly taskRuleEvidence: TaskRuleEvidenceRepository;
  readonly planReviewGates: PlanReviewGateRepository;
  readonly taskContinuations: TaskContinuationRepository;
  readonly codeReviews: CodeReviewRepository;
  /**
   * INT-D-A: the durable code-review foundation.
   *
   * Its external provider is not wired yet — see
   * {@link UnconfiguredCodeReviewer}. Capturing subjects, reading identity and
   * deciding findings all work; running a round waits for INT-D-B.
   */
  readonly codeReview: CodeReviewService;
  readonly operationTargets: OperationTargetRepository;
  readonly operationDiagnosticRuns: OperationDiagnosticRepository;
  readonly projectService: ProjectService;
  readonly taskService: TaskService;
  readonly orchestrator: Orchestrator;
  readonly continuationService: ContinuationService;
  readonly publishService: PublishService;
  readonly diagnostics: ToolDiagnosticsService;
  /** The Operations registry. Read-only: it can inspect, never change. */
  readonly operations: OperationsRegistry;
  readonly operationDiagnostics: OperationsDiagnosticsService;
  readonly codexModels: CodexModelCatalog;
  readonly ruleEvidenceCollector: RuleEvidenceService;
  /** Read-only Coai connection/capability diagnostic for Settings. Never calls a tool. */
  readonly coaiCapability: CoaiCapabilityService;
  createPlanReviewGate(config: ExternalMcpServerConfig): PlanReviewGateService;
  /**
   * What startup reconciliation corrected, if anything.
   *
   * Exposed so the value is observable — a recovery that leaves no trace is one
   * nobody can prove ran.
   */
  readonly reconciliation: ReconciliationPlan;
  readonly close: () => void;
}

export interface BuildApplicationOptions {
  readonly paths: ApplicationPaths;
  readonly events: EventPublisher;
  readonly confirmation: ConfirmationService;
  /** Overridden in tests. */
  readonly databaseFile?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly processRunner?: ProcessRunner;
  /** Separate managed-process seam; ordinary ProcessRunner test doubles need not implement launch(). */
  readonly localInferenceProcessRunner?: LocalInferenceProcessRunner;
  /** Test seam for adding fixture-only construction details such as a temporary cwd. */
  readonly localInferenceProviderFactory?: LocalInferenceProviderFactory;
}

/**
 * Adapters read their executable paths from Settings at construction time, so
 * they are built lazily per call through these small factories. That keeps a
 * Settings change from requiring a restart.
 */
function adapterFactories(
  settings: SettingsRepository,
  runner: ProcessRunner
): {
  codex: () => CodexAdapter;
  claude: () => ClaudeAdapter;
  git: () => GitAdapter;
  github: () => GitHubAdapter;
} {
  return {
    codex: () => {
      const current = settings.get();
      return new CodexSdkAdapter(runner, {
        configuredPath: current.codexExecutablePath
      });
    },
    claude: () => {
      const current = settings.get();
      return new ClaudeCliAdapter(runner, {
        configuredPath: current.claudeExecutablePath,
        allowedTools: current.claudeAllowedTools
      });
    },
    git: () => new CliGitAdapter(runner, {}),
    github: () => {
      const current = settings.get();
      return new GhGitHubAdapter(runner, { configuredPath: current.ghExecutablePath });
    }
  };
}

/** Thin façades that resolve the concrete adapter on every call. */
function lateBound(factories: ReturnType<typeof adapterFactories>): {
  codex: CodexAdapter;
  claude: ClaudeAdapter;
  git: GitAdapter;
  github: GitHubAdapter;
} {
  return {
    codex: {
      implement: (request, context) => factories.codex().implement(request, context),
      createSpecification: (request, context) =>
        factories.codex().createSpecification(request, context),
      reviewImplementation: (request, context) =>
        factories.codex().reviewImplementation(request, context),
      diagnose: () => factories.codex().diagnose()
    },
    claude: {
      reviewImplementation: (request, context) => factories.claude().reviewImplementation(request, context),
      run: (request, context) => factories.claude().run(request, context),
      diagnose: () => factories.claude().diagnose()
    },
    git: {
      inspect: (path) => factories.git().inspect(path),
      branchExists: (path, branch) => factories.git().branchExists(path, branch),
      createWorktree: (request) => factories.git().createWorktree(request),
      listWorktrees: (path) => factories.git().listWorktrees(path),
      removeWorktree: (repo, path) => factories.git().removeWorktree(repo, path),
      collectChanges: (path, base, options) => factories.git().collectChanges(path, base, options),
      initRepository: (path, branch) => factories.git().initRepository(path, branch),
      stageAll: (path) => factories.git().stageAll(path),
      commit: (path, message) => factories.git().commit(path, message),
      push: (path, remote, branch) => factories.git().push(path, remote, branch),
      diagnose: () => factories.git().diagnose()
    },
    github: {
      diagnose: () => factories.github().diagnose(),
      hasAccessToOwner: (owner) => factories.github().hasAccessToOwner(owner),
      createRepository: (request) => factories.github().createRepository(request),
      createPullRequest: (request) => factories.github().createPullRequest(request),
      repositoryExists: (owner, name) => factories.github().repositoryExists(owner, name)
    }
  };
}

export function buildApplication(options: BuildApplicationOptions): Application {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidGenerator();
  const runner = options.processRunner ?? new ExecaProcessRunner();

  const db = openDatabase({
    file: options.databaseFile ?? join(options.paths.dataDir, 'agent-relay.sqlite')
  });

  const settings = new SqliteSettingsRepository(db, defaultSettings(options.paths));
  const localInferenceRunner =
    options.localInferenceProcessRunner ??
    (runner instanceof ExecaProcessRunner ? runner : new ExecaProcessRunner());
  const createLocalInferenceProvider: LocalInferenceProviderFactory =
    options.localInferenceProviderFactory ??
    ((config) => new LlamaCppLocalInference(localInferenceRunner, config));
  const localInference = new LocalInferenceService({
    settings,
    createProvider: createLocalInferenceProvider,
    ids
  });
  const projects = new SqliteProjectRepository(db, clock);
  const tasks = new SqliteTaskRepository(db, clock);
  const runs = new SqliteRunRepository(db);
  const runEvents = new SqliteRunEventRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const taskRuleEvidence = new SqliteTaskRuleEvidenceRepository(db);
  const planReviewGates = new SqlitePlanReviewGateRepository(db, clock);
  const taskContinuations = new SqliteTaskContinuationRepository(db, clock);
  const planReviewClaims = new PlanReviewClaims();
  const codeReviews = new SqliteCodeReviewRepository(db, clock);
  const codeReviewClaims = new CodeReviewClaims();
  const operationTargets = new SqliteOperationTargetRepository(db, clock);
  const operationDiagnosticRuns = new SqliteOperationDiagnosticRepository(db);

  // Before anything else can act on the database: an abrupt exit leaves runs
  // marked running and tasks stuck in a busy status, and nothing later clears
  // them. Running here means it is finished before IPC is registered and before
  // a window exists, so no new work can race the recovery.
  const codeReview = new CodeReviewService({
    tasks,
    projects,
    reviews: codeReviews,
    // Read-only by contract: it never stages, commits or checks anything out.
    snapshots: new GitCodeSnapshotSource(runner),
    // Settings-bound and resolved per call: enabling the integration, or
    // clearing its executable, takes effect on the next call rather than the
    // next restart. Nothing the renderer sends reaches this.
    reviewer: new SettingsBoundCodeReviewer({
      settings: () => settings.get(),
      client: new StdioMcpClient(
        runner instanceof ExecaProcessRunner ? runner : new ExecaProcessRunner()
      )
    }),
    claims: codeReviewClaims,
    clock,
    ids
  });

  const reconciliation = reconcileInterruptedWork({
    tasks,
    runs,
    clock,
    transactions: new SqliteTransactionRunner(db),
    // A read-only diagnostic interrupted by the same exit is closed here
    // too, for the same reason: the row saying it is running is the only
    // trace left, and nothing else will ever clear it.
    operationDiagnostics: operationDiagnosticRuns
  });
  reconcileContinuationClaims({
    tasks,
    continuations: taskContinuations,
    transactions: new SqliteTransactionRunner(db)
  });

  const adapters = lateBound(adapterFactories(settings, runner));

  const projectService = new ProjectService({
    projects,
    settings,
    git: adapters.git,
    confirmation: options.confirmation,
    clock,
    ids,
    events: options.events
  });

  const taskService = new TaskService({
    tasks,
    projects,
    runs,
    approvals,
    settings,
    clock,
    ids,
    events: options.events,
    continuations: taskContinuations
  });

  const runtime: { orchestrator?: Orchestrator } = {};
  const verification = new WorktreeVerification(runner);
  const continuationService = new ContinuationService({
    tasks,
    projects,
    runs,
    settings,
    ruleEvidence: taskRuleEvidence,
    planReviews: planReviewGates,
    continuations: taskContinuations,
    transactions: new SqliteTransactionRunner(db),
    verification,
    clock,
    ids,
    events: options.events,
    isSourceBusy: (taskId) => runtime.orchestrator?.isRunning(taskId) ?? false
  });

  const orchestrator = new Orchestrator({
    verification,
    worktreeDependencies: new LocalWorktreeDependencyPreparer(runner),
    projects,
    tasks,
    runs,
    runEvents,
    settings,
    codex: adapters.codex,
    claude: adapters.claude,
    git: adapters.git,
    clock,
    ids,
    events: options.events,
    ruleEvidence: taskRuleEvidence,
    planReviews: planReviewGates,
    continuations: taskContinuations,
    continuationGuard: {
      prepareFirstAction: (...args) => continuationService.prepareFirstAction(...args),
      retargetFirstActionToVerification: (...args) =>
        continuationService.retargetFirstActionToVerification(...args),
      assertSpecificationAllowed: (taskId) => continuationService.assertSpecificationAllowed(taskId)
    },
    // Ornith reuses the same LocalInferenceService instance the Local
    // inference lifecycle IPC handlers use; the Ornith surface it exposes
    // here is a separate, non-IPC interface — see `OrnithInferenceLeaseService`.
    ornith: new OrnithImplementationService(),
    ornithLease: localInference,
    processRunner: runner
  });

  runtime.orchestrator = orchestrator;

  const publishService = new PublishService({
    verification: new WorktreeVerification(runner),
    tasks,
    projects,
    approvals,
    runs,
    runEvents,
    settings,
    git: adapters.git,
    github: adapters.github,
    confirmation: options.confirmation,
    clock,
    ids,
    events: options.events,
    continuations: taskContinuations
  });

  // One long-lived instance: the cache only earns its keep if it outlives a
  // single call, and it keys on the resolved executable so a Settings change
  // that repoints Codex invalidates it on its own.
  const codexModels = new CodexAppServerModelCatalog(
    runner instanceof ExecaProcessRunner ? runner : new ExecaProcessRunner(),
    // Read on every list, not captured here: changing the Codex path in
    // Settings must take effect without restarting the application.
    { getConfiguredPath: () => settings.get().codexExecutablePath }
  );

  // Adapters are keyed by the same enum the registry stores, so a target can
  // only ever resolve to an implementation this build compiled in.
  const operations = new OperationsRegistry({
    targets: operationTargets,
    diagnostics: operationDiagnosticRuns,
    ids,
    adapters: { local_sqlite: new LocalSqliteProbeAdapter(runner) }
  });

  const operationDiagnostics = new OperationsDiagnosticsService({
    registry: operations,
    diagnostics: operationDiagnosticRuns,
    clock,
    ids
  });

  const diagnostics = new ToolDiagnosticsService({
    codex: adapters.codex,
    claude: adapters.claude,
    git: adapters.git,
    github: adapters.github,
    localInference,
    events: options.events
  });

  const ruleEvidenceCollector = new RuleEvidenceService(
    adapters.git,
    new FilesystemRuleSourceReader(),
    clock
  );

  const coaiCapability = new CoaiCapabilityService({
    settings,
    client: new StdioMcpClient(
      runner instanceof ExecaProcessRunner ? runner : new ExecaProcessRunner()
    )
  });

  return {
    db,
    settings,
    localInference,
    projects,
    tasks,
    runs,
    runEvents,
    approvals,
    taskRuleEvidence,
    planReviewGates,
    taskContinuations,
    codeReviews,
    codeReview,
    operationTargets,
    operationDiagnosticRuns,
    projectService,
    taskService,
    orchestrator,
    continuationService,
    publishService,
    diagnostics,
    operations,
    operationDiagnostics,
    codexModels,
    ruleEvidenceCollector,
    coaiCapability,
    // Built once, here, and closed over by every service the factory makes.
    // A per-call instance would give each IPC invocation its own private map
    // and arbitrate nothing, which is the whole failure this guards against.
    createPlanReviewGate: (config) =>
      new PlanReviewGateService({
        tasks,
        projects,
        ruleEvidence: taskRuleEvidence,
        gates: planReviewGates,
        claims: planReviewClaims,
        reviewer: new CoaiPlanReviewer(
          new StdioMcpClient(
            runner instanceof ExecaProcessRunner ? runner : new ExecaProcessRunner()
          ),
          config
        ),
        clock,
        ids
      }),
    reconciliation,
    close: () => closeDatabase(db)
  };
}
