/**
 * Reconciliation as the application actually reaches it.
 *
 * The policy tests prove the decision is right; these prove it is wired. They
 * write a stuck state to a real file, close the connection the way an abrupt
 * exit would leave it, and then start the application through the same
 * composition root the Electron bootstrap uses.
 *
 * The ordering claim matters as much as the recovery: `buildApplication` is what
 * `bootstrap()` calls, and it registers no IPC and opens no window. Doing the
 * work inside it is what guarantees a stuck task cannot be acted on before it
 * has been corrected — there is no window in which both are true.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../src/main/container';
import { INTERRUPTION_REASON } from '../../src/main/services/startup-reconciliation';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { RecordingConfirmationService } from '../helpers/fakes';

/** Never used: nothing in this test spawns anything. */
const inertRunner: ProcessRunner = {
  async run() {
    throw new Error('no process should be spawned during startup reconciliation');
  }
};

let root: string;
let databaseFile: string;
let opened: Application[] = [];

function start(): Application {
  const app = buildApplication({
    paths: { dataDir: root, documentsDir: root },
    databaseFile,
    events: new InMemoryEventPublisher(),
    confirmation: new RecordingConfirmationService(false),
    clock: new FixedClock(),
    ids: new SequentialIdGenerator('boot'),
    processRunner: inertRunner
  });
  opened.push(app);
  return app;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-reconcile-'));
  databaseFile = join(root, 'agent-relay.sqlite');
  opened = [];
});

afterEach(() => {
  for (const app of opened) {
    try {
      app.close();
    } catch {
      // Already closed by the test.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Leave a task mid-round and drop the connection, as a crash would. */
function seedInterruptedRound(): { taskId: string; runId: string } {
  const app = start();

  const project = app.projects.create({
    id: 'project-1',
    name: 'fixture',
    projectType: 'existing',
    localPath: join(root, 'repo'),
    githubOwner: null,
    githubRepo: null,
    githubVisibility: 'private',
    defaultBranch: 'main'
  });

  const task = app.tasks.create({
    id: 'task-1',
    projectId: project.id,
    title: 'Interrupted work',
    originalRequest: 'Do the thing',
    status: 'IMPLEMENTING',
    currentRound: 1,
    maxRounds: 3,
    codexThreadId: 'codex-thread-1',
    claudeSessionId: 'claude-session-1',
    worktreePath: join(root, 'worktrees', 'task-1'),
    branchName: 'agent-relay/task-1',
    baseBranch: 'main',
    specificationJson: '{"title":"spec"}',
    specificationApprovedAt: '2026-09-02T09:00:00.000Z',
    lastReviewJson: null,
    lastError: null,
    codexModel: null,
    claudeModel: null
  });

  const run = app.runs.create({
    id: 'run-1',
    taskId: task.id,
    agent: 'claude',
    runType: 'implementation',
    status: 'running',
    round: 1,
    startedAt: '2026-09-02T10:00:00.000Z'
  });

  // The connection goes away with the run still open and the task still busy —
  // exactly what is on disk after a crash or a forced quit.
  app.close();

  return { taskId: task.id, runId: run.id };
}

describe('starting up on a database left mid-round', () => {
  it('recovers the task and closes the run before returning an application', () => {
    const { taskId, runId } = seedInterruptedRound();

    const app = start();

    expect(app.tasks.findById(taskId)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(app.runs.findById(runId)?.status).toBe('failed');
    expect(app.runs.findById(runId)?.errorMessage).toBe(INTERRUPTION_REASON);
  });

  it('reports what it corrected', () => {
    const { taskId, runId } = seedInterruptedRound();

    const app = start();

    expect(app.reconciliation.recoveries).toEqual([
      expect.objectContaining({
        taskId,
        from: 'IMPLEMENTING',
        to: 'READY_FOR_IMPLEMENTATION',
        event: 'implementation_aborted'
      })
    ]);
    expect(app.reconciliation.closures).toEqual([expect.objectContaining({ runId })]);
  });

  it('has already finished by the time anything can be called', () => {
    // `buildApplication` is what `bootstrap()` runs before `registerIpc` and
    // `createWindow`. Since recovery happens inside it, the first moment any
    // caller — IPC, a service, the renderer — can see the application is a
    // moment when nothing is left stuck.
    const { taskId } = seedInterruptedRound();

    const app = start();

    expect(app.tasks.listBusy()).toEqual([]);
    expect(app.runs.listRunning()).toEqual([]);
    expect(app.orchestrator).toBeDefined();
    expect(app.tasks.findById(taskId)?.status).not.toBe('IMPLEMENTING');
  });

  it('starts no process while recovering', () => {
    // `inertRunner` throws if anything tries to spawn. Reaching this assertion
    // is the proof that recovery resumes nothing.
    seedInterruptedRound();

    expect(() => start()).not.toThrow();
  });

  it('leaves the worktree, branch and session untouched', () => {
    const { taskId } = seedInterruptedRound();

    const app = start();
    const task = app.tasks.findById(taskId);

    expect(task).toMatchObject({
      currentRound: 1,
      codexThreadId: 'codex-thread-1',
      claudeSessionId: 'claude-session-1',
      branchName: 'agent-relay/task-1',
      specificationJson: '{"title":"spec"}'
    });
    expect(task?.worktreePath).toBe(join(root, 'worktrees', 'task-1'));
  });

  it('does nothing on a subsequent start', () => {
    seedInterruptedRound();

    const first = start();
    expect(first.reconciliation.recoveries).toHaveLength(1);
    first.close();

    const second = start();
    expect(second.reconciliation).toEqual({ closures: [], recoveries: [], diagnostics: [] });
  });

  it('reports nothing for a database that was closed cleanly', () => {
    const app = start();
    app.projects.create({
      id: 'project-1',
      name: 'fixture',
      projectType: 'existing',
      localPath: join(root, 'repo'),
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private',
      defaultBranch: 'main'
    });
    app.close();

    expect(start().reconciliation).toEqual({ closures: [], recoveries: [], diagnostics: [] });
  });
});
