/**
 * Continuation placement through the real continuation path: a real source stopped at its review limit, a
 * real `ContinuationService` whose creation transaction runs the roadmap hook, and the real repository.
 * Whatever the roadmap does, the continuation is created; only `placed` means it was placed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../../src/main/adapters/process/process-runner';
import { SqliteRoadmapRepository } from '../../src/main/db/repositories/roadmap-repository';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';
import type { RoadmapRepository } from '../../src/main/ports';
import { ContinuationService } from '../../src/main/services/continuation-service';
import { RoadmapService } from '../../src/main/services/roadmap-service';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import { AgentRelayError } from '../../src/shared/domain/errors';
import type { RoadmapView } from '../../src/shared/domain/roadmap-operations';
import { createHarness, runToFailedRoundExhaustion, type Harness } from '../helpers/harness';

const passed: ProcessResult = {
  command: 'npm run verify', exitCode: 0, stdout: 'ok', stderr: '', failed: false, timedOut: false, cancelled: false, durationMs: 4
};
const verification: VerificationExecutor = { identity: async () => 'a'.repeat(64), execute: async () => passed };

let harness: Harness;
beforeEach(() => {
  harness = createHarness({ verification, settings: { maxReviewRounds: 3 } });
});
afterEach(() => harness.dispose());

function roadmapService(repository: RoadmapRepository = new SqliteRoadmapRepository(harness.db, harness.clock)) {
  return new RoadmapService({
    roadmap: repository,
    transactions: new SqliteTransactionRunner(harness.db),
    clock: harness.clock,
    ids: harness.ids,
    events: harness.events
  });
}

function continuations(roadmap: RoadmapService) {
  return new ContinuationService({
    tasks: harness.tasks,
    projects: harness.projects,
    runs: harness.runs,
    settings: harness.settings,
    ruleEvidence: harness.taskRuleEvidence,
    planReviews: harness.planReviewGates,
    continuations: harness.taskContinuations,
    transactions: new SqliteTransactionRunner(harness.db),
    verification,
    clock: harness.clock,
    ids: harness.ids,
    events: harness.events,
    isSourceBusy: () => false,
    placeContinuation: (input) => roadmap.placeContinuation(input)
  });
}

const idOf = (view: RoadmapView, title: string) => view.nodes.find((node) => node.title === title)!.id;
const roadmapRows = () => Object.fromEntries(
  ['roadmap_heads', 'roadmap_nodes', 'roadmap_task_placements', 'roadmap_dependencies']
    .map((table) => [table, harness.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
);
const roadmapEvents = () => harness.events.events.filter((event) => event.kind === 'roadmap-updated');

/** A source stopped at its review limit, placed between two siblings in "Epic". */
async function placedSource(roadmap: RoadmapService) {
  const { project, task: source } = await runToFailedRoundExhaustion(harness);
  const before = harness.createTask(project.id, { title: 'Before' });
  const after = harness.createTask(project.id, { title: 'After' });
  let view = roadmap.createNode({ projectId: project.id, expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
  view = roadmap.createNode({ projectId: project.id, expectedRevision: view.revision, kind: 'phase', parentId: idOf(view, 'Goal'), title: 'Phase' });
  view = roadmap.createNode({ projectId: project.id, expectedRevision: view.revision, kind: 'epic', parentId: idOf(view, 'Phase'), title: 'Epic' });
  const epic = idOf(view, 'Epic');
  for (const task of [before, source, after]) {
    view = roadmap.placeTask({ projectId: project.id, expectedRevision: view.revision, taskId: task.id, epicId: epic });
  }
  return { project, source, before, after, epic, view };
}

describe('continuation placement', () => {
  it('places the continuation right after its source, and announces it after the creation commits', async () => {
    const roadmap = roadmapService();
    const { project, source, before, after, epic, view } = await placedSource(roadmap);
    const published = harness.events.events.length;

    const created = await continuations(roadmap).create(source.id);

    expect(created.roadmapPlacement).toEqual({ outcome: 'placed', epicId: epic, position: 2, revision: view.revision + 1 });
    const now = roadmap.view({ projectId: project.id });
    expect(now.placements.filter((row) => row.epicId === epic).sort((a, b) => a.position - b.position).map((row) => row.taskId))
      .toEqual([before.id, source.id, created.task.id, after.id]);
    expect(now.readiness.tasks[source.id]).toMatchObject({ notApplicable: 'superseded', successorTaskId: created.task.id });
    const fresh = harness.events.events.slice(published);
    expect(fresh.filter((event) => event.kind === 'roadmap-updated')).toEqual([
      { kind: 'roadmap-updated', projectId: project.id, revision: view.revision + 1 }
    ]);
    expect(fresh.some((event) => event.kind === 'task-updated' && event.task.id === created.task.id)).toBe(true);
  });

  it('leaves the continuation Unassigned when its source is Unassigned', async () => {
    const roadmap = roadmapService();
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const rows = roadmapRows();
    const created = await continuations(roadmap).create(source.id);
    expect(created.roadmapPlacement).toMatchObject({ outcome: 'unassigned', reason: 'source_unassigned' });
    expect(roadmapRows()).toEqual(rows);
    expect(roadmapEvents()).toEqual([]);
  });

  it('leaves the continuation Unassigned when the source’s epic is closed', async () => {
    const roadmap = roadmapService();
    const { project, epic, view } = await placedSource(roadmap);
    // Every task in the epic must be terminal before it can be accepted.
    for (const row of view.placements) {
      const task = harness.tasks.findById(row.taskId)!;
      if (task.status === 'DRAFT') harness.tasks.update(task.id, { status: 'CANCELLED' });
    }
    const accepted = roadmap.transitionNode({ projectId: project.id, expectedRevision: view.revision, nodeId: epic, event: 'accept', acknowledgeStoppedWork: true });
    const rows = roadmapRows();
    const published = roadmapEvents().length;
    const source = accepted.placements.find((row) => harness.tasks.findById(row.taskId)?.status === 'REVIEW_LIMIT_REACHED')!;

    const created = await continuations(roadmap).create(source.taskId);

    expect(created.roadmapPlacement).toMatchObject({ outcome: 'unassigned', reason: 'epic_closed' });
    expect(roadmapRows()).toEqual(rows);
    expect(roadmapEvents()).toHaveLength(published);
    expect(roadmap.view({ projectId: project.id }).unassignedTaskIds).toContain(created.task.id);
  });

  it('still creates the continuation when the roadmap is damaged, and says the placement failed', async () => {
    const roadmap = roadmapService();
    const { project, source, epic } = await placedSource(roadmap);
    harness.db.prepare('UPDATE roadmap_nodes SET acceptance_criteria_json = ? WHERE id = ?').run('not-json', epic);
    const rows = roadmapRows();
    const published = roadmapEvents().length;

    const created = await continuations(roadmap).create(source.id);

    expect(created.task.status).not.toBe('FAILED');
    expect(harness.taskContinuations.findBySource(source.id)?.continuationTaskId).toBe(created.task.id);
    expect(created.roadmapPlacement).toMatchObject({ outcome: 'failed', reason: 'roadmap_invalid' });
    expect(roadmapRows()).toEqual(rows);
    expect(roadmapEvents()).toHaveLength(published);
    expect(() => roadmap.view({ projectId: project.id })).toThrow(AgentRelayError);
  });

  it('reports a revision conflict as a failed placement, with nothing placed and the continuation created', async () => {
    const real = new SqliteRoadmapRepository(harness.db, harness.clock);
    const conflicting: RoadmapRepository = {
      read: (projectId) => real.read(projectId),
      listUnassigned: (projectId) => real.listUnassigned(projectId),
      apply: () => {
        throw new AgentRelayError('VALIDATION_FAILED', 'Roadmap changed. Refresh.');
      }
    };
    const setup = roadmapService(real);
    const { source } = await placedSource(setup);
    const rows = roadmapRows();

    const created = await continuations(roadmapService(conflicting)).create(source.id);

    expect(created.roadmapPlacement).toMatchObject({ outcome: 'failed', reason: 'roadmap_changed' });
    expect(harness.taskContinuations.findBySource(source.id)?.continuationTaskId).toBe(created.task.id);
    expect(roadmapRows()).toEqual(rows);
  });

  it('refuses a placement that would re-form a deadlock the continuation had broken', async () => {
    const roadmap = roadmapService();
    const { project, source, epic, view } = await placedSource(roadmap);
    let current = roadmap.createNode({ projectId: project.id, expectedRevision: view.revision, kind: 'epic', parentId: view.nodes.find((node) => node.kind === 'phase')!.id, title: 'Other' });
    const other = idOf(current, 'Other');
    // Stored as older data could hold it: "Other waits for the source" and "Epic waits for Other" — a cycle
    // through the source's placement. The repository stores it; only the service refuses new cycles.
    const repository = new SqliteRoadmapRepository(harness.db, harness.clock);
    current = roadmap.view({ projectId: project.id });
    repository.apply(project.id, current.revision, {
      dependencyInserts: [
        { id: 'd-other', projectId: project.id, dependent: { kind: 'node', nodeId: other }, prerequisite: { kind: 'task', taskId: source.id }, createdAt: harness.clock.nowIso() },
        { id: 'd-epic', projectId: project.id, dependent: { kind: 'node', nodeId: epic }, prerequisite: { kind: 'node', nodeId: other }, createdAt: harness.clock.nowIso() }
      ]
    });
    const rows = roadmapRows();

    const created = await continuations(roadmap).create(source.id);

    expect(created.roadmapPlacement).toMatchObject({ outcome: 'failed', reason: 'dependency_cycle' });
    expect(roadmapRows()).toEqual(rows);
    expect(roadmap.view({ projectId: project.id }).unassignedTaskIds).toContain(created.task.id);
  });

  it('publishes nothing and keeps nothing when the transaction around the hook rolls back', async () => {
    const roadmap = roadmapService();
    const { project, source } = await placedSource(roadmap);
    const rows = roadmapRows();
    const published = roadmapEvents().length;
    const continuation = harness.createTask(project.id, { title: 'Continuation' });

    expect(() => new SqliteTransactionRunner(harness.db).run(() => {
      const outcome = roadmap.placeContinuation({ projectId: project.id, sourceTaskId: source.id, continuationTaskId: continuation.id });
      expect(outcome.outcome).toBe('placed');
      throw new Error('creation failed after the hook');
    })).toThrow('creation failed after the hook');

    expect(roadmapRows()).toEqual(rows);
    expect(roadmapEvents()).toHaveLength(published);
  });
});
