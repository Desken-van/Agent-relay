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
import { ClaudeCliAdapter } from './adapters/claude/claude-adapter';
import { CodexSdkAdapter } from './adapters/codex/codex-adapter';
import { CodexAppServerModelCatalog } from './adapters/codex/codex-model-catalog';
import { CliGitAdapter } from './adapters/git/git-adapter';
import { GhGitHubAdapter } from './adapters/github/github-adapter';
import { ExecaProcessRunner, type ProcessRunner } from './adapters/process/process-runner';
import { closeDatabase, openDatabase, type Db } from './db/database';
import { SqliteApprovalRepository } from './db/repositories/approval-repository';
import { SqliteProjectRepository } from './db/repositories/project-repository';
import { SqliteRunEventRepository } from './db/repositories/run-event-repository';
import { SqliteRunRepository } from './db/repositories/run-repository';
import { SqliteSettingsRepository } from './db/repositories/settings-repository';
import { SqliteTaskRepository } from './db/repositories/task-repository';
import { SystemClock, UuidGenerator } from './infra/clock';
import type {
  ApprovalRepository,
  ClaudeAdapter,
  Clock,
  CodexAdapter,
  CodexModelCatalog,
  ConfirmationService,
  EventPublisher,
  GitAdapter,
  GitHubAdapter,
  IdGenerator,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SettingsRepository,
  TaskRepository
} from './ports';
import { ToolDiagnosticsService } from './services/diagnostics-service';
import { Orchestrator } from './services/orchestrator';
import { ProjectService } from './services/project-service';
import { PublishService } from './services/publish-service';
import { TaskService } from './services/task-service';

export interface ApplicationPaths {
  /** Directory holding the SQLite database and worktrees. */
  readonly dataDir: string;
  /** Default parent folder for newly created projects. */
  readonly documentsDir: string;
}

export function defaultSettings(paths: ApplicationPaths): Settings {
  return {
    claudeExecutablePath: process.env.AGENT_RELAY_CLAUDE_PATH ?? null,
    codexExecutablePath: process.env.AGENT_RELAY_CODEX_PATH ?? null,
    ghExecutablePath: process.env.AGENT_RELAY_GH_PATH ?? null,
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
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly runEvents: RunEventRepository;
  readonly approvals: ApprovalRepository;
  readonly projectService: ProjectService;
  readonly taskService: TaskService;
  readonly orchestrator: Orchestrator;
  readonly publishService: PublishService;
  readonly diagnostics: ToolDiagnosticsService;
  readonly codexModels: CodexModelCatalog;
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
      createSpecification: (request, context) =>
        factories.codex().createSpecification(request, context),
      reviewImplementation: (request, context) =>
        factories.codex().reviewImplementation(request, context),
      diagnose: () => factories.codex().diagnose()
    },
    claude: {
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
  const projects = new SqliteProjectRepository(db, clock);
  const tasks = new SqliteTaskRepository(db, clock);
  const runs = new SqliteRunRepository(db);
  const runEvents = new SqliteRunEventRepository(db);
  const approvals = new SqliteApprovalRepository(db);

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
    events: options.events
  });

  const orchestrator = new Orchestrator({
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
    events: options.events
  });

  const publishService = new PublishService({
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
    events: options.events
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

  const diagnostics = new ToolDiagnosticsService({
    codex: adapters.codex,
    claude: adapters.claude,
    git: adapters.git,
    github: adapters.github,
    events: options.events
  });

  return {
    db,
    settings,
    projects,
    tasks,
    runs,
    runEvents,
    approvals,
    projectService,
    taskService,
    orchestrator,
    publishService,
    diagnostics,
    codexModels,
    close: () => closeDatabase(db)
  };
}
