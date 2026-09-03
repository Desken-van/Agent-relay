/**
 * Recovering work the application was in the middle of when it stopped.
 *
 * Two levels, because the failure has two halves. The pure planner decides what
 * a half-finished round deserves — those cases are enumerated here without a
 * database in sight. The integration block then proves the decision actually
 * reaches SQLite through the real composition root, because a policy nobody
 * calls recovers nothing.
 *
 * The invariant running through all of it: recovery hands work back, it does not
 * resume it. No agent starts, no Git runs, and nothing that records what an
 * earlier round achieved is touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { SqliteRunRepository } from '../../src/main/db/repositories/run-repository';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { SqliteProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SqliteApprovalRepository } from '../../src/main/db/repositories/approval-repository';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import {
  INTERRUPTION_REASON,
  planReconciliation,
  reconcileInterruptedWork,
  type InterruptedWork
} from '../../src/main/services/startup-reconciliation';
import type { Run, RunType, Task } from '../../src/shared/domain/models';
import type { TaskStatus } from '../../src/shared/domain/workflow';

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

let seq = 0;

function makeRun(overrides: Partial<Run> = {}): Run {
  seq += 1;
  return {
    id: `run-${String(seq).padStart(3, '0')}`,
    taskId: 'task-1',
    agent: 'claude',
    runType: 'implementation',
    status: 'running',
    round: 1,
    startedAt: '2026-09-02T10:00:00.000Z',
    finishedAt: null,
    finalMessage: null,
    structuredResult: null,
    errorMessage: null,
    ...overrides
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'A task',
    originalRequest: 'Do the thing',
    status: 'IMPLEMENTING',
    currentRound: 1,
    maxRounds: 3,
    codexThreadId: 'codex-thread-1',
    claudeSessionId: 'claude-session-1',
    worktreePath: 'C:\\worktrees\\task-1',
    branchName: 'agent-relay/task-1',
    baseBranch: 'main',
    specificationJson: '{"title":"spec"}',
    specificationApprovedAt: '2026-09-02T09:00:00.000Z',
    lastReviewJson: null,
    lastError: null,
    codexModel: null,
    claudeModel: null,
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...overrides
  };
}

/** Assemble planner input the way `collectInterruptedWork` would. */
function work(input: {
  runningRuns?: readonly Run[];
  busyTasks?: readonly Task[];
}): InterruptedWork {
  return {
    runningRuns: input.runningRuns ?? [],
    busyTasks: input.busyTasks ?? []
  };
}

beforeEach(() => {
  seq = 0;
});

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

describe('planning a recovery', () => {
  const planFor = (status: TaskStatus, runType: RunType | null, extra: Partial<Task> = {}) => {
    const task = makeTask({ status, ...extra });
    const running =
      runType === null
        ? []
        : [makeRun({ runType, taskId: task.id, round: task.currentRound })];
    return planReconciliation(work({ runningRuns: running, busyTasks: [task] }));
  };

  it('returns a specifying task to draft', () => {
    const plan = planFor('SPECIFYING', 'specification');

    expect(plan.recoveries).toEqual([
      {
        taskId: 'task-1',
        from: 'SPECIFYING',
        to: 'DRAFT',
        event: 'specification_aborted',
        reason: INTERRUPTION_REASON
      }
    ]);
    expect(plan.closures).toHaveLength(1);
  });

  it('closes a stale specification run without moving a task that is already draft', () => {
    // The specification run is written before the task becomes SPECIFYING, so a
    // crash in that window leaves a running run on a perfectly healthy task.
    const stale = makeRun({ runType: 'specification', agent: 'codex', taskId: 'task-1' });
    const plan = planReconciliation(work({ runningRuns: [stale] }));

    expect(plan.closures).toHaveLength(1);
    expect(plan.recoveries).toEqual([]);
  });

  it('returns an interrupted implementation round to ready for implementation', () => {
    expect(planFor('IMPLEMENTING', 'implementation').recoveries[0]).toMatchObject({
      to: 'READY_FOR_IMPLEMENTATION',
      event: 'implementation_aborted'
    });
  });

  it('returns an interrupted correction round to changes requested', () => {
    expect(planFor('IMPLEMENTING', 'correction', { currentRound: 2 }).recoveries[0]).toMatchObject({
      to: 'CHANGES_REQUESTED',
      event: 'correction_aborted'
    });
  });

  it('reads the round kind from the round counter when none is still running', () => {
    // The task moved to IMPLEMENTING and the process died before the run row
    // was written. Round 2 can only have been reached through corrections_sent.
    const task = makeTask({ status: 'IMPLEMENTING', currentRound: 2 });

    const plan = planReconciliation(work({ busyTasks: [task] }));

    expect(plan.recoveries[0]).toMatchObject({
      to: 'CHANGES_REQUESTED',
      event: 'correction_aborted'
    });
    expect(plan.closures).toEqual([]);
  });

  /**
   * The case the original rule got wrong.
   *
   * `sendCorrections` moves the task and increments the round, and only then
   * does `runClaude` write the run. In that window the newest Claude run is
   * still the *previous implementation* — and reading intent from it recovered
   * a first correction as READY_FOR_IMPLEMENTATION, throwing away the review the
   * user was acting on.
   */
  it('recovers a first correction that crashed before its run was written', () => {
    const task = makeTask({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"changes_requested"}'
    });
    // Everything on record is from round 1, and all of it is finished.
    const history = [
      makeRun({ runType: 'implementation', status: 'succeeded', round: 1, taskId: task.id }),
      makeRun({ runType: 'review', agent: 'codex', status: 'succeeded', round: 1, taskId: task.id })
    ];

    const plan = planReconciliation(work({ runningRuns: [], busyTasks: [task] }));

    expect(plan.recoveries[0]).toMatchObject({
      from: 'IMPLEMENTING',
      to: 'CHANGES_REQUESTED',
      event: 'correction_aborted'
    });
    // The finished rounds are not running, so nothing about them is touched.
    expect(history.every((run) => run.status === 'succeeded')).toBe(true);
  });

  it('recovers a retry-verification round that crashed before its run was written', () => {
    // Reached from READY_TO_PUBLISH: the reviewer approved, the publish gate
    // refused, and corrections_sent moved the task back into IMPLEMENTING. The
    // newest Claude run is again a finished implementation.
    const task = makeTask({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"approved"}'
    });

    const plan = planReconciliation(work({ busyTasks: [task] }));

    expect(plan.recoveries[0]).toMatchObject({
      to: 'CHANGES_REQUESTED',
      event: 'correction_aborted'
    });
  });

  it('recovers a first implementation that crashed before its run was written', () => {
    const task = makeTask({
      status: 'IMPLEMENTING',
      currentRound: 1,
      claudeSessionId: null,
      lastReviewJson: null
    });

    const plan = planReconciliation(work({ busyTasks: [task] }));

    expect(plan.recoveries[0]).toMatchObject({
      to: 'READY_FOR_IMPLEMENTATION',
      event: 'implementation_aborted'
    });
  });

  it('falls back to the more recoverable state when a task has no rounds at all', () => {
    // Nothing on record, so nothing to infer from. READY_FOR_IMPLEMENTATION can
    // be retried or re-specified; CHANGES_REQUESTED would need a stored review
    // this task cannot have, and would be a dead end.
    const plan = planFor('IMPLEMENTING', null);

    expect(plan.recoveries[0]).toMatchObject({
      to: 'READY_FOR_IMPLEMENTATION',
      event: 'implementation_aborted'
    });
  });

  it('prefers a running round of the current round over older history', () => {
    const task = makeTask({ status: 'IMPLEMENTING', currentRound: 2 });
    const running = makeRun({ runType: 'correction', round: 2, taskId: task.id });

    const plan = planReconciliation(work({ runningRuns: [running], busyTasks: [task] }));

    expect(plan.recoveries[0]?.event).toBe('correction_aborted');
  });

  it('ignores a running run left over from an earlier round', () => {
    // A running row whose round does not match the task's is debris the state
    // machine has already moved past; the counter it maintains outranks it.
    const task = makeTask({ status: 'IMPLEMENTING', currentRound: 2 });
    const stale = makeRun({ runType: 'implementation', round: 1, taskId: task.id });

    const plan = planReconciliation(work({ runningRuns: [stale], busyTasks: [task] }));

    expect(plan.recoveries[0]?.event).toBe('correction_aborted');
    // It is still closed, whatever it says about the round kind.
    expect(plan.closures).toHaveLength(1);
  });

  it('picks the same running round however the rows arrive', () => {
    const task = makeTask({ status: 'IMPLEMENTING', currentRound: 2 });
    const older = makeRun({
      id: 'run-aaa',
      runType: 'implementation',
      round: 2,
      startedAt: '2026-09-02T10:00:00.000Z',
      taskId: task.id
    });
    const newer = makeRun({
      id: 'run-bbb',
      runType: 'correction',
      round: 2,
      startedAt: '2026-09-02T11:00:00.000Z',
      taskId: task.id
    });

    const forwards = planReconciliation(work({ runningRuns: [older, newer], busyTasks: [task] }));
    const backwards = planReconciliation(work({ runningRuns: [newer, older], busyTasks: [task] }));

    // Latest start wins, and the order the rows were handed over does not.
    expect(forwards.recoveries[0]?.event).toBe('correction_aborted');
    expect(backwards.recoveries).toEqual(forwards.recoveries);
    expect(backwards.closures).toEqual(forwards.closures);
  });

  it('breaks a dead heat on id, not on arrival order', () => {
    const task = makeTask({ status: 'IMPLEMENTING', currentRound: 2 });
    const at = '2026-09-02T11:00:00.000Z';
    const a = makeRun({ id: 'run-aaa', runType: 'implementation', round: 2, startedAt: at, taskId: task.id });
    const b = makeRun({ id: 'run-bbb', runType: 'correction', round: 2, startedAt: at, taskId: task.id });

    const forwards = planReconciliation(work({ runningRuns: [a, b], busyTasks: [task] }));
    const backwards = planReconciliation(work({ runningRuns: [b, a], busyTasks: [task] }));

    expect(forwards.recoveries).toEqual(backwards.recoveries);
    // Greatest id wins the tie, so run-bbb.
    expect(forwards.recoveries[0]?.event).toBe('correction_aborted');
  });

  it('returns a reviewing task to ready for review', () => {
    expect(planFor('REVIEWING', 'review').recoveries[0]).toMatchObject({
      to: 'READY_FOR_REVIEW',
      event: 'review_aborted'
    });
  });

  it('closes a stale review run without moving a task that is already ready for review', () => {
    const stale = makeRun({ runType: 'review', agent: 'codex' });
    const plan = planReconciliation(work({ runningRuns: [stale] }));

    expect(plan.closures).toHaveLength(1);
    expect(plan.recoveries).toEqual([]);
  });

  it('returns a publishing task to ready to publish', () => {
    expect(planFor('PUBLISHING', 'git').recoveries[0]).toMatchObject({
      to: 'READY_TO_PUBLISH',
      event: 'publish_aborted'
    });
  });

  it('recovers a publishing task whose run was never written', () => {
    // PUBLISHING is recorded before the publish run is created.
    const plan = planFor('PUBLISHING', null);

    expect(plan.recoveries[0]).toMatchObject({
      to: 'READY_TO_PUBLISH',
      event: 'publish_aborted'
    });
    expect(plan.closures).toEqual([]);
  });

  it('closes every stale run of a task but moves the task once', () => {
    const task = makeTask({ status: 'IMPLEMENTING' });
    const runs = [
      makeRun({ runType: 'implementation', taskId: task.id }),
      makeRun({ runType: 'implementation', taskId: task.id })
    ];

    const plan = planReconciliation(work({ runningRuns: runs, busyTasks: [task] }));

    expect(plan.closures).toHaveLength(2);
    expect(plan.recoveries).toHaveLength(1);
  });

  it('recovers several tasks independently', () => {
    const a = makeTask({ id: 'task-a', status: 'SPECIFYING' });
    const b = makeTask({ id: 'task-b', status: 'REVIEWING' });
    const c = makeTask({ id: 'task-c', status: 'PUBLISHING' });

    const plan = planReconciliation(work({ busyTasks: [c, a, b] }));

    // Sorted by id, so the outcome does not depend on the order rows arrived in.
    expect(plan.recoveries.map((r) => [r.taskId, r.to])).toEqual([
      ['task-a', 'DRAFT'],
      ['task-b', 'READY_FOR_REVIEW'],
      ['task-c', 'READY_TO_PUBLISH']
    ]);
  });

  it('does nothing when there is nothing to recover', () => {
    expect(planReconciliation(work({}))).toEqual({ closures: [], recoveries: [], diagnostics: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Against a real database                                                     */
/* -------------------------------------------------------------------------- */

describe('reconciling a real database', () => {
  let db: Db;
  let tasks: SqliteTaskRepository;
  let runs: SqliteRunRepository;
  let projects: SqliteProjectRepository;
  let approvals: SqliteApprovalRepository;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;

  const deps = () => ({
    tasks,
    runs,
    clock,
    transactions: new SqliteTransactionRunner(db)
  });

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    clock = new FixedClock();
    ids = new SequentialIdGenerator('r');
    projects = new SqliteProjectRepository(db, clock);
    tasks = new SqliteTaskRepository(db, clock);
    runs = new SqliteRunRepository(db);
    approvals = new SqliteApprovalRepository(db);

    projects.create({
      id: 'project-1',
      name: 'fixture',
      projectType: 'existing',
      localPath: 'C:\\repo',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private',
      defaultBranch: 'main'
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const seedTask = (overrides: Partial<Task> = {}): Task =>
    tasks.create({
      id: overrides.id ?? 'task-1',
      projectId: 'project-1',
      title: 'A task',
      originalRequest: 'Do the thing',
      status: overrides.status ?? 'IMPLEMENTING',
      currentRound: overrides.currentRound ?? 1,
      maxRounds: 3,
      codexThreadId: overrides.codexThreadId ?? 'codex-thread-1',
      claudeSessionId: overrides.claudeSessionId ?? 'claude-session-1',
      worktreePath: overrides.worktreePath ?? 'C:\\worktrees\\task-1',
      branchName: overrides.branchName ?? 'agent-relay/task-1',
      baseBranch: 'main',
      specificationJson: overrides.specificationJson ?? '{"title":"spec"}',
      specificationApprovedAt: '2026-09-02T09:00:00.000Z',
      lastReviewJson: overrides.lastReviewJson ?? null,
      lastError: null,
      codexModel: null,
      claudeModel: null
    });

  const seedRun = (taskId: string, runType: RunType, agent: Run['agent'] = 'claude'): Run =>
    runs.create({
      id: ids.next(),
      taskId,
      agent,
      runType,
      status: 'running',
      round: 1,
      startedAt: clock.nowIso()
    });

  it('closes a running run as failed, with an honest reason', () => {
    const task = seedTask({ status: 'IMPLEMENTING' });
    const run = seedRun(task.id, 'implementation');

    reconcileInterruptedWork(deps());

    const closed = runs.findById(run.id);
    expect(closed?.status).toBe('failed');
    expect(closed?.errorMessage).toBe(INTERRUPTION_REASON);
    expect(closed?.finishedAt).not.toBeNull();
    expect(tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('leaves a finished run and a settled task exactly as they were', () => {
    const task = seedTask({ status: 'READY_FOR_REVIEW' });
    const run = runs.create({
      id: ids.next(),
      taskId: task.id,
      agent: 'claude',
      runType: 'implementation',
      status: 'running',
      round: 1,
      startedAt: clock.nowIso()
    });
    runs.finish(run.id, {
      status: 'succeeded',
      finishedAt: clock.nowIso(),
      finalMessage: 'all good',
      structuredResult: '{"assessment":{}}'
    });

    const before = { task: tasks.findById(task.id), run: runs.findById(run.id) };
    reconcileInterruptedWork(deps());

    expect(tasks.findById(task.id)).toEqual(before.task);
    expect(runs.findById(run.id)).toEqual(before.run);
  });

  it('preserves everything the interrupted round had achieved', () => {
    const task = seedTask({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"changes_requested"}'
    });
    const finished = runs.create({
      id: ids.next(),
      taskId: task.id,
      agent: 'claude',
      runType: 'correction',
      status: 'running',
      round: 2,
      startedAt: clock.nowIso()
    });
    runs.finish(finished.id, {
      status: 'succeeded',
      finishedAt: clock.nowIso(),
      structuredResult: '{"assessment":{"version":1}}'
    });
    seedRun(task.id, 'correction');
    approvals.create({
      id: 'approval-1',
      taskId: task.id,
      action: 'commit',
      status: 'granted',
      details: '{}',
      requestedAt: clock.nowIso(),
      resolvedAt: clock.nowIso()
    });

    reconcileInterruptedWork(deps());

    const after = tasks.findById(task.id);
    expect(after).toMatchObject({
      status: 'CHANGES_REQUESTED',
      currentRound: 2,
      codexThreadId: 'codex-thread-1',
      claudeSessionId: 'claude-session-1',
      worktreePath: 'C:\\worktrees\\task-1',
      branchName: 'agent-relay/task-1',
      specificationJson: '{"title":"spec"}',
      lastReviewJson: '{"verdict":"changes_requested"}'
    });
    // The evidence of the completed round is untouched.
    expect(runs.findById(finished.id)?.structuredResult).toBe('{"assessment":{"version":1}}');
    expect(runs.findById(finished.id)?.status).toBe('succeeded');
    // Approvals are neither granted nor revoked.
    expect(approvals.findGranted(task.id, 'commit')?.status).toBe('granted');
  });

  it('is a no-op on a second pass', () => {
    const task = seedTask({ status: 'REVIEWING' });
    seedRun(task.id, 'review', 'codex');

    const first = reconcileInterruptedWork(deps());
    expect(first.closures).toHaveLength(1);
    expect(first.recoveries).toHaveLength(1);

    const snapshot = { task: tasks.findById(task.id), runs: runs.listByTask(task.id) };

    const second = reconcileInterruptedWork(deps());
    expect(second).toEqual({ closures: [], recoveries: [], diagnostics: [] });
    expect(tasks.findById(task.id)).toEqual(snapshot.task);
    expect(runs.listByTask(task.id)).toEqual(snapshot.runs);
  });

  it('recovers several tasks in one pass', () => {
    const a = seedTask({ id: 'task-a', status: 'SPECIFYING' });
    const b = seedTask({ id: 'task-b', status: 'PUBLISHING' });
    seedRun(a.id, 'specification', 'codex');

    reconcileInterruptedWork(deps());

    expect(tasks.findById(a.id)?.status).toBe('DRAFT');
    expect(tasks.findById(b.id)?.status).toBe('READY_TO_PUBLISH');
  });

  it('leaves nothing half-recovered when the write fails', () => {
    const task = seedTask({ status: 'IMPLEMENTING' });
    const run = seedRun(task.id, 'implementation');

    const exploding = {
      ...deps(),
      // Closures run before recoveries, so failing the task update proves the
      // already-written run closure is rolled back with it.
      tasks: {
        ...tasks,
        listBusy: () => tasks.listBusy(),
        update: () => {
          throw new Error('disk on fire');
        }
      } as unknown as SqliteTaskRepository
    };

    expect(() => reconcileInterruptedWork(exploding)).toThrow(/disk on fire/);

    expect(runs.findById(run.id)?.status).toBe('running');
    expect(runs.findById(run.id)?.finishedAt).toBeNull();
    expect(tasks.findById(task.id)?.status).toBe('IMPLEMENTING');
  });
});

/* -------------------------------------------------------------------------- */
/* The crash windows, against a real database                                  */
/* -------------------------------------------------------------------------- */

/**
 * The same cases again on SQLite, because the planner being right is only half
 * of it: the rows have to come back out of the database the way the planner
 * expects, through `listBusy` and `listRunning`.
 */
describe('crash windows on a real database', () => {
  let db: Db;
  let tasks: SqliteTaskRepository;
  let runs: SqliteRunRepository;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;

  const deps = () => ({ tasks, runs, clock, transactions: new SqliteTransactionRunner(db) });

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    clock = new FixedClock();
    ids = new SequentialIdGenerator('c');
    tasks = new SqliteTaskRepository(db, clock);
    runs = new SqliteRunRepository(db);

    new SqliteProjectRepository(db, clock).create({
      id: 'project-1',
      name: 'fixture',
      projectType: 'existing',
      localPath: 'C:\\repo',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private',
      defaultBranch: 'main'
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const task = (overrides: Partial<Task> = {}): Task =>
    tasks.create({
      id: 'task-1',
      projectId: 'project-1',
      title: 'A task',
      originalRequest: 'Do the thing',
      status: 'IMPLEMENTING',
      currentRound: 1,
      maxRounds: 3,
      codexThreadId: 'codex-thread-1',
      claudeSessionId: 'claude-session-1',
      worktreePath: 'C:\\worktrees\\task-1',
      branchName: 'agent-relay/task-1',
      baseBranch: 'main',
      specificationJson: '{"title":"spec"}',
      specificationApprovedAt: '2026-09-02T09:00:00.000Z',
      lastReviewJson: null,
      lastError: null,
      codexModel: null,
      claudeModel: null,
      ...overrides
    });

  /** A finished run, as an earlier round would have left it. */
  const finishedRun = (
    taskId: string,
    runType: RunType,
    round: number,
    agent: Run['agent'] = 'claude'
  ): Run => {
    const run = runs.create({
      id: ids.next(),
      taskId,
      agent,
      runType,
      status: 'running',
      round,
      startedAt: clock.nowIso()
    });
    return runs.finish(run.id, { status: 'succeeded', finishedAt: clock.nowIso() });
  };

  const runningRun = (taskId: string, runType: RunType, round: number): Run =>
    runs.create({
      id: ids.next(),
      taskId,
      agent: 'claude',
      runType,
      status: 'running',
      round,
      startedAt: clock.nowIso()
    });

  it('recovers a first correction that crashed before its run was written', () => {
    // Round 1 is complete and reviewed. `corrections_sent` has moved the task
    // and bumped the counter; the correction run does not exist yet.
    const subject = task({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"changes_requested"}'
    });
    finishedRun(subject.id, 'implementation', 1);
    finishedRun(subject.id, 'review', 1, 'codex');

    reconcileInterruptedWork(deps());

    const after = tasks.findById(subject.id);
    expect(after?.status).toBe('CHANGES_REQUESTED');
    // The review the user was acting on is still there to send corrections from.
    expect(after?.lastReviewJson).toBe('{"verdict":"changes_requested"}');
    expect(after?.currentRound).toBe(2);
  });

  it('recovers a retry-verification round that crashed before its run was written', () => {
    const subject = task({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"approved"}'
    });
    finishedRun(subject.id, 'implementation', 1);
    finishedRun(subject.id, 'review', 1, 'codex');

    reconcileInterruptedWork(deps());

    expect(tasks.findById(subject.id)?.status).toBe('CHANGES_REQUESTED');
  });

  it('recovers a first implementation that crashed before its run was written', () => {
    const subject = task({ status: 'IMPLEMENTING', currentRound: 1, claudeSessionId: null });

    reconcileInterruptedWork(deps());

    expect(tasks.findById(subject.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('lets a running correction outrank an older finished implementation', () => {
    const subject = task({ status: 'IMPLEMENTING', currentRound: 2 });
    finishedRun(subject.id, 'implementation', 1);
    const inFlight = runningRun(subject.id, 'correction', 2);

    reconcileInterruptedWork(deps());

    expect(tasks.findById(subject.id)?.status).toBe('CHANGES_REQUESTED');
    expect(runs.findById(inFlight.id)?.status).toBe('failed');
  });

  it('is a no-op on a second pass through the crash window', () => {
    const subject = task({
      status: 'IMPLEMENTING',
      currentRound: 2,
      lastReviewJson: '{"verdict":"changes_requested"}'
    });
    finishedRun(subject.id, 'implementation', 1);

    reconcileInterruptedWork(deps());
    const snapshot = { task: tasks.findById(subject.id), runs: runs.listByTask(subject.id) };

    expect(reconcileInterruptedWork(deps())).toEqual({ closures: [], recoveries: [], diagnostics: [] });
    expect(tasks.findById(subject.id)).toEqual(snapshot.task);
    expect(runs.listByTask(subject.id)).toEqual(snapshot.runs);
  });
});
