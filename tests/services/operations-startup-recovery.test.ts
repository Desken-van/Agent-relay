/**
 * Recovering an interrupted diagnostic.
 *
 * A diagnostic run is written as `running` before its probe is spawned, exactly
 * like an agent run. If the application dies in between, that row is the only
 * trace left, and nothing else will ever clear it — the same shape of problem
 * Phase 7A solved for tasks, and solved here in the same place, so a restart has
 * one pass rather than two.
 *
 * What is different is what recovery may claim. An interrupted probe proved
 * nothing at all, so the row is closed with no result and a reason that says the
 * outcome is *unknown* — never a failure of the target, which nothing here has
 * any evidence for.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../src/main/container';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import {
  DIAGNOSTIC_INTERRUPTION_REASON,
  INTERRUPTION_REASON,
  planReconciliation
} from '../../src/main/services/startup-reconciliation';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { OPERATION_CONFIG_VERSION } from '../../src/shared/domain/operations';
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
  root = mkdtempSync(join(tmpdir(), 'agent-relay-ops-recovery-'));
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

/** Leave a diagnostic mid-probe and drop the connection, as a crash would. */
function seedInterruptedDiagnostic(): { targetId: string; diagnosticId: string } {
  const app = start();

  const target = app.operations.create({
    name: 'Reporting snapshot',
    environment: 'local',
    config: {
      version: OPERATION_CONFIG_VERSION,
      adapterType: 'local_sqlite',
      databasePath: join(root, 'reports.sqlite')
    }
  });

  const run = app.operationDiagnosticRuns.start({
    id: 'diag-1',
    targetId: target.id,
    probeId: 'schema_summary',
    startedAt: '2026-09-03T10:00:00.000Z'
  });

  // The connection goes away with the probe still open — exactly what is on
  // disk after a crash or a forced quit.
  app.close();

  return { targetId: target.id, diagnosticId: run.id };
}

/* -------------------------------------------------------------------------- */
/* The pure planner                                                            */
/* -------------------------------------------------------------------------- */

describe('planning a diagnostic recovery', () => {
  it('closes every running diagnostic, and moves nothing else', () => {
    const plan = planReconciliation({
      runningRuns: [],
      busyTasks: [],
      runningDiagnostics: [
        { id: 'b', targetId: 'target-2' },
        { id: 'a', targetId: 'target-1' }
      ]
    });

    // Sorted by id, so the plan does not depend on the order rows came back in.
    expect(plan.diagnostics).toEqual([
      { diagnosticId: 'a', targetId: 'target-1', reason: DIAGNOSTIC_INTERRUPTION_REASON },
      { diagnosticId: 'b', targetId: 'target-2', reason: DIAGNOSTIC_INTERRUPTION_REASON }
    ]);
    // A read-only probe leaves nothing half-done, so there is no status anywhere
    // to roll back.
    expect(plan.closures).toEqual([]);
    expect(plan.recoveries).toEqual([]);
  });

  it('says the outcome is unknown, not that the target failed', () => {
    // The wording is the point: an interrupted probe may well have been about to
    // succeed. Calling it a failure would be a claim about the target.
    expect(DIAGNOSTIC_INTERRUPTION_REASON).toMatch(/unknown/i);
    expect(DIAGNOSTIC_INTERRUPTION_REASON).not.toMatch(/failed|error|broken/i);
    // And it is not the task-side wording either; the two are different facts.
    expect(DIAGNOSTIC_INTERRUPTION_REASON).not.toBe(INTERRUPTION_REASON);
  });

  it('produces an empty plan when nothing was interrupted', () => {
    expect(
      planReconciliation({ runningRuns: [], busyTasks: [], runningDiagnostics: [] })
    ).toEqual({ closures: [], recoveries: [], diagnostics: [] });
  });

  it('still works for a caller that knows nothing about diagnostics', () => {
    // Phase 7A's shape, unchanged: the field is optional so an older caller — or
    // a build without the registry — simply has nothing to recover.
    expect(planReconciliation({ runningRuns: [], busyTasks: [] }).diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Through the composition root                                                */
/* -------------------------------------------------------------------------- */

describe('starting up on a database left mid-probe', () => {
  it('closes the diagnostic before returning an application', () => {
    const { diagnosticId } = seedInterruptedDiagnostic();

    const app = start();
    const recovered = app.operationDiagnosticRuns.findById(diagnosticId);

    expect(recovered?.status).toBe('failed');
    expect(recovered?.failureKind).toBe('cancelled');
    expect(recovered?.errorMessage).toBe(DIAGNOSTIC_INTERRUPTION_REASON);
    expect(recovered?.finishedAt).not.toBeNull();
  });

  it('invents no result for a probe that never reported', () => {
    const { diagnosticId } = seedInterruptedDiagnostic();

    const app = start();
    const recovered = app.operationDiagnosticRuns.findById(diagnosticId);

    // The absence is the record. Nothing plausible was filled in.
    expect(recovered?.result).toBeNull();
    expect(recovered?.status).not.toBe('succeeded');
  });

  it('reports what it corrected', () => {
    const { targetId, diagnosticId } = seedInterruptedDiagnostic();

    const app = start();

    expect(app.reconciliation.diagnostics).toEqual([
      { diagnosticId, targetId, reason: DIAGNOSTIC_INTERRUPTION_REASON }
    ]);
  });

  it('leaves the target itself untouched', () => {
    const { targetId } = seedInterruptedDiagnostic();

    const app = start();
    const target = app.operations.get(targetId);

    expect(target).toMatchObject({
      name: 'Reporting snapshot',
      environment: 'local',
      adapterType: 'local_sqlite',
      enabled: true
    });
  });

  it('has already finished by the time anything can be called', () => {
    // `buildApplication` is what `bootstrap()` runs before `registerIpc` and
    // `createWindow`. Doing the work inside it means the first moment any caller
    // can see the application is a moment when nothing is left stuck.
    const { targetId } = seedInterruptedDiagnostic();

    const app = start();

    expect(app.operationDiagnosticRuns.listRunning()).toEqual([]);
    expect(app.operationDiagnosticRuns.findRunningForTarget(targetId)).toBeNull();
    expect(app.operationDiagnostics).toBeDefined();
  });

  it('starts no process while recovering', () => {
    // `inertRunner` throws if anything tries to spawn. Reaching this assertion
    // is the proof that recovery re-runs nothing.
    seedInterruptedDiagnostic();
    expect(() => start()).not.toThrow();
  });

  it('does nothing on a subsequent start', () => {
    seedInterruptedDiagnostic();

    const first = start();
    expect(first.reconciliation.diagnostics).toHaveLength(1);
    const snapshot = first.operationDiagnosticRuns.findById('diag-1');
    first.close();

    const second = start();
    expect(second.reconciliation).toEqual({ closures: [], recoveries: [], diagnostics: [] });
    // The first pass's finish time and reason were not rewritten.
    expect(second.operationDiagnosticRuns.findById('diag-1')).toEqual(snapshot);
  });

  it('leaves a finished diagnostic alone', () => {
    const app = start();
    const target = app.operations.create({
      name: 'Reporting snapshot',
      environment: 'local',
      config: {
        version: OPERATION_CONFIG_VERSION,
        adapterType: 'local_sqlite',
        databasePath: join(root, 'reports.sqlite')
      }
    });
    app.operationDiagnosticRuns.start({
      id: 'diag-done',
      targetId: target.id,
      probeId: 'connection_health',
      startedAt: '2026-09-03T10:00:00.000Z'
    });
    app.operationDiagnosticRuns.finish('diag-done', {
      status: 'failed',
      finishedAt: '2026-09-03T10:00:01.000Z',
      failureKind: 'error',
      errorMessage: 'the file was missing'
    });
    const before = app.operationDiagnosticRuns.findById('diag-done');
    app.close();

    const restarted = start();
    expect(restarted.reconciliation.diagnostics).toEqual([]);
    expect(restarted.operationDiagnosticRuns.findById('diag-done')).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* The Phase 7A behaviour is unchanged                                         */
/* -------------------------------------------------------------------------- */

describe('task recovery still works alongside it', () => {
  it('recovers a stuck task and an interrupted diagnostic in one pass', () => {
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

    const target = app.operations.create({
      name: 'Reporting snapshot',
      environment: 'local',
      config: {
        version: OPERATION_CONFIG_VERSION,
        adapterType: 'local_sqlite',
        databasePath: join(root, 'reports.sqlite')
      }
    });
    app.operationDiagnosticRuns.start({
      id: 'diag-1',
      targetId: target.id,
      probeId: 'connection_health',
      startedAt: '2026-09-02T10:00:00.000Z'
    });
    app.close();

    const restarted = start();

    // Phase 7A, exactly as before.
    expect(restarted.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(restarted.runs.findById(run.id)?.status).toBe('failed');
    expect(restarted.runs.findById(run.id)?.errorMessage).toBe(INTERRUPTION_REASON);

    // And the diagnostic, in the same pass, with its own wording.
    expect(restarted.operationDiagnosticRuns.findById('diag-1')?.status).toBe('failed');
    expect(restarted.operationDiagnosticRuns.findById('diag-1')?.errorMessage).toBe(
      DIAGNOSTIC_INTERRUPTION_REASON
    );

    expect(restarted.reconciliation.closures).toHaveLength(1);
    expect(restarted.reconciliation.recoveries).toHaveLength(1);
    expect(restarted.reconciliation.diagnostics).toHaveLength(1);
  });
});
