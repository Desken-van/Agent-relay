import { afterEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../src/main/container';
import type { ExternalMcpServerConfig } from '../../src/main/ports';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { RecordingConfirmationService } from '../helpers/fakes';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
const applications: Application[] = [];

afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONFIG: ExternalMcpServerConfig = {
  id: 'coai',
  enabled: true,
  // Never launched: every call below is refused before any provider is reached.
  executablePath: 'C:\\tools\\never-started.exe',
  args: [],
  allowedTools: ['open', 'status', 'review_plan', 'resolve'],
  timeoutMs: 30_000,
  maxMessageBytes: 1_000_000,
  maxContentBytes: 1_000_000,
  maxContentBlocks: 16
};

function build(): Application {
  const root = mkdtempSync(join(tmpdir(), 'agent-relay-operations-'));
  roots.push(root);
  const app = buildApplication({
    paths: { dataDir: root, documentsDir: root },
    databaseFile: ':memory:',
    events: new InMemoryEventPublisher(),
    confirmation: new RecordingConfirmationService(false)
  });
  applications.push(app);
  return app;
}

function taskIn(app: Application) {
  const project = app.projects.create({
    id: 'project-1',
    name: 'Demo',
    localPath: 'C:\\repo',
    projectType: 'existing',
    defaultBranch: 'main',
    githubOwner: 'Desken-van',
    githubRepo: 'demo',
    githubVisibility: 'private'
  });
  return app.tasks.create({
    id: 'task-1',
    projectId: project.id,
    title: 'Add health endpoint',
    originalRequest: 'Please add a health endpoint.',
    status: 'READY_FOR_IMPLEMENTATION',
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
    lastError: null
  });
}

describe('composition-root wiring of the task-operation register', () => {
  it('is built once: the singleton orchestrator stops an operation that any service the factories build has registered', () => {
    const app = build();
    const task = taskIn(app);
    // An operation started through one IPC call's service graph …
    const operation = app.taskOperations.begin(task.id, 'plan_correction', { exclusive: true });

    // … is stopped by the singleton orchestrator, which is what `workflow:stop` calls.
    const stopped = app.orchestrator.stop(task.id);

    expect(operation.signal.aborted).toBe(true);
    expect(stopped.status).toBe('CANCELLED');
    expect(app.tasks.findById(task.id)?.status).toBe('CANCELLED');
    operation.release();
    expect(app.taskOperations.isActive(task.id)).toBe(false);
  });

  it('is shared by every per-call service: each refuses to start anything while an operation is registered', async () => {
    const app = build();
    const task = taskIn(app);
    const operation = app.taskOperations.begin(task.id, 'plan_correction', { exclusive: true });

    // Two different service instances, neither of which registered anything itself.
    await expect(app.createPlanCorrection(CONFIG).continueCorrection(task.id, { autoContinue: false })).rejects.toMatchObject({
      code: 'BUSY'
    });
    await expect(app.createPlanReviewGate(CONFIG).review(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(app.orchestrator.generateSpecification(task.id)).rejects.toThrow(/already has a plan-review operation running/i);

    operation.release();
  });

  it('hands out the same register every time, and a fresh service instance every call', () => {
    const app = build();

    expect(app.createPlanCorrection(CONFIG)).not.toBe(app.createPlanCorrection(CONFIG));
    expect(app.taskOperations).toBe(app.taskOperations);
  });
});
