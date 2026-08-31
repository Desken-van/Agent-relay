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
import { SqliteRunEventRepository } from '../../src/main/db/repositories/run-event-repository';
import { SqliteRunRepository } from '../../src/main/db/repositories/run-repository';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { Orchestrator } from '../../src/main/services/orchestrator';
import { ProjectService } from '../../src/main/services/project-service';
import { PublishService } from '../../src/main/services/publish-service';
import { TaskService } from '../../src/main/services/task-service';
import { defaultSettings } from '../../src/main/container';
import type { Project, Settings, Task } from '../../src/shared/domain/models';
import {
  FakeClaudeAdapter,
  FakeCodexAdapter,
  FakeGitAdapter,
  FakeGitHubAdapter,
  RecordingConfirmationService
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
  readonly runs: SqliteRunRepository;
  readonly runEvents: SqliteRunEventRepository;
  readonly approvals: SqliteApprovalRepository;
  readonly settings: SqliteSettingsRepository;
  readonly orchestrator: Orchestrator;
  readonly publishService: PublishService;
  readonly projectService: ProjectService;
  readonly taskService: TaskService;
  readonly worktreesRoot: string;
  createProject(overrides?: Partial<Project>): Project;
  createTask(projectId: string, overrides?: Partial<Task>): Task;
  dispose(): void;
}

export function createHarness(
  options: { confirmAnswer?: boolean; settings?: Partial<Settings> } = {}
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
  const runs = new SqliteRunRepository(db);
  const runEvents = new SqliteRunEventRepository(db);
  const approvals = new SqliteApprovalRepository(db);

  const codex = new FakeCodexAdapter();
  const claude = new FakeClaudeAdapter();
  const git = new FakeGitAdapter();
  const github = new FakeGitHubAdapter();
  const confirmation = new RecordingConfirmationService(options.confirmAnswer ?? true);

  const orchestrator = new Orchestrator({
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
    events
  });

  const publishService = new PublishService({
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
    events
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

  const taskService = new TaskService({
    tasks,
    projects,
    runs,
    approvals,
    settings,
    clock,
    ids,
    events
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
    runs,
    runEvents,
    approvals,
    settings,
    orchestrator,
    publishService,
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
