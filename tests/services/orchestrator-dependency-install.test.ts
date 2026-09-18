/**
 * Orchestrator-level wiring for the dependency status/install actions:
 * concurrency guarding, run recording, and task/lastError updates. The real
 * filesystem/`npm ci` behavior is covered directly, against a real worktree,
 * in `tests/services/worktree-dependencies.test.ts` — this file uses a fake
 * installer, exactly as `run-verification.test.ts` fakes `VerificationExecutor`,
 * so it can exercise the orchestrator's own guards in isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WorktreeDependencyInstallOutcome } from '../../src/shared/domain/worktree-dependencies';
import type { WorktreeDependencyInstaller } from '../../src/main/services/worktree-dependencies';
import { createHarness, type Harness } from './../helpers/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.dispose();
  harness = null;
});

function fakeInstaller(overrides: Partial<WorktreeDependencyInstaller> = {}): WorktreeDependencyInstaller {
  return {
    checkStatus: async () => ({ state: 'ready_linked', detail: 'ready' }),
    installDependencies: async () => ({
      kind: 'succeeded',
      detail: 'Dependencies installed in the task worktree.',
      status: { state: 'ready_local', detail: 'ready' }
    }),
    ...overrides
  };
}

describe('Orchestrator: dependency status and install wiring', () => {
  it('returns the installer\'s read-only status, resolving repository/worktree paths from durable task state', async () => {
    const seen: { repositoryPath: string; worktreePath: string }[] = [];
    const installer = fakeInstaller({
      checkStatus: async (target) => {
        seen.push(target);
        return { state: 'manifest_mismatch', detail: 'differs' };
      }
    });
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, {
      status: 'READY_FOR_IMPLEMENTATION',
      worktreePath: '/fake/worktree',
      branchName: 'agent-relay/task'
    });

    const status = await harness.orchestrator.dependencyStatus(task.id);

    expect(status.state).toBe('manifest_mismatch');
    expect(seen).toEqual([{ repositoryPath: project.localPath, worktreePath: '/fake/worktree' }]);
  });

  it('refuses to install while a run is already active for the task, without ever calling the installer', async () => {
    let calls = 0;
    const installer = fakeInstaller({
      installDependencies: async () => {
        calls += 1;
        return { kind: 'succeeded', detail: 'installed', status: { state: 'ready_local', detail: 'ready' } };
      }
    });
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, {
      status: 'READY_FOR_IMPLEMENTATION',
      worktreePath: '/fake/worktree',
      branchName: 'agent-relay/task'
    });
    harness.runs.create({
      id: harness.ids.next(),
      taskId: task.id,
      agent: 'system',
      runType: 'verification',
      status: 'running',
      round: 0,
      startedAt: harness.clock.nowIso()
    });

    await expect(harness.orchestrator.installDependencies(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(calls).toBe(0);
  });

  it('refuses to install while the task itself is in a busy status', async () => {
    let calls = 0;
    const installer = fakeInstaller({ checkStatus: async () => { calls += 1; return { state: 'ready_linked', detail: 'ready' }; } });
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, {
      status: 'IMPLEMENTING',
      worktreePath: '/fake/worktree',
      branchName: 'agent-relay/task',
      currentRound: 1
    });

    await expect(harness.orchestrator.installDependencies(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(calls).toBe(0);
  });

  it('records a succeeded run and clears lastError on success', async () => {
    const installer = fakeInstaller();
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, {
      status: 'READY_FOR_IMPLEMENTATION',
      worktreePath: `${harness.worktreesRoot}/task`,
      branchName: 'agent-relay/task',
      lastError: 'The worktree dependency manifest differs from the registered checkout.'
    });

    const after = await harness.orchestrator.installDependencies(task.id);

    expect(after.lastError).toBeNull();
    const run = harness.runs.listByTask(task.id).find((candidate) => candidate.runType === 'dependencies');
    expect(run?.status).toBe('succeeded');
    expect(run?.agent).toBe('system');
    expect(run?.structuredResult).toContain('"outcome":"succeeded"');
  });

  it('records a failed run and sets lastError to the outcome detail on failure, without throwing', async () => {
    const outcome: WorktreeDependencyInstallOutcome = {
      kind: 'package_manager_failed',
      detail: 'npm ci failed (exit 1). See the operation log for details.',
      status: { state: 'manifest_mismatch', detail: 'still mismatched' }
    };
    const installer = fakeInstaller({ installDependencies: async () => outcome });
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, {
      status: 'READY_FOR_IMPLEMENTATION',
      worktreePath: `${harness.worktreesRoot}/task`,
      branchName: 'agent-relay/task'
    });

    const after = await harness.orchestrator.installDependencies(task.id);

    expect(after.lastError).toBe(outcome.detail);
    const run = harness.runs.listByTask(task.id).find((candidate) => candidate.runType === 'dependencies');
    expect(run?.status).toBe('failed');
    expect(run?.errorMessage).toBe(outcome.detail);
  });

  it('refuses when no worktree exists yet, without calling the installer', async () => {
    let calls = 0;
    const installer = fakeInstaller({ checkStatus: async () => { calls += 1; return { state: 'ready_linked', detail: 'ready' }; } });
    harness = createHarness({ worktreeDependencyInstaller: installer });
    const project = harness.createProject();
    const task = harness.createTask(project.id, { status: 'DRAFT' });

    await expect(harness.orchestrator.installDependencies(task.id)).rejects.toThrow();
    expect(calls).toBe(0);
    const status = await harness.orchestrator.dependencyStatus(task.id);
    expect(status.state).toBe('not_node_project');
  });
});
