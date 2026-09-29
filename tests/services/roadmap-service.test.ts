/**
 * The Roadmap service against the real SQLite repository: every operation, every policy, and every refusal
 * proved by the database contents and the event log staying exactly as they were.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { SqliteRoadmapRepository } from '../../src/main/db/repositories/roadmap-repository';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { RoadmapCycleError, RoadmapService } from '../../src/main/services/roadmap-service';
import { AgentRelayError } from '../../src/shared/domain/errors';
import type { RoadmapView } from '../../src/shared/domain/roadmap-operations';

const P = 'project-1';
const Q = 'project-2';
const AT = '2026-09-29T10:00:00.000Z';

let db: Db;
let events: InMemoryEventPublisher;
let clock: FixedClock;
let service: RoadmapService;

function seed(): void {
  for (const project of [P, Q]) {
    db.prepare(`INSERT INTO projects(id,name,local_path,project_type,default_branch,github_visibility,created_at,updated_at)
      VALUES (?,?,?,'existing','main','private',?,?)`).run(project, project, `C:/${project}`, AT, AT);
  }
  const task = db.prepare(`INSERT INTO tasks(id,project_id,title,original_request,status,created_at,updated_at)
    VALUES (?,?,'Task','Request',?,?,?)`);
  const rows: [string, string, string, string][] = [
    ['t1', P, 'DRAFT', '2026-09-29T10:00:01.000Z'],
    ['t2', P, 'IMPLEMENTING', '2026-09-29T10:00:02.000Z'],
    ['t3', P, 'COMPLETED', '2026-09-29T10:00:03.000Z'],
    ['t4', P, 'FAILED', '2026-09-29T10:00:04.000Z'],
    ['t5', P, 'CANCELLED', '2026-09-29T10:00:05.000Z'],
    ['q1', Q, 'DRAFT', AT]
  ];
  for (const [id, project, status, created] of rows) task.run(id, project, status, created, AT);
}

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  seed();
  events = new InMemoryEventPublisher();
  clock = new FixedClock(new Date(AT));
  service = new RoadmapService({
    roadmap: new SqliteRoadmapRepository(db, clock),
    transactions: new SqliteTransactionRunner(db),
    clock,
    ids: new SequentialIdGenerator('rm'),
    events
  });
});
afterEach(() => db.close());

function contents() {
  return Object.fromEntries(
    ['roadmap_heads', 'roadmap_nodes', 'roadmap_task_placements', 'roadmap_dependencies', 'tasks', 'task_continuations']
      .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}
const roadmapEvents = () => events.events.filter((event) => event.kind === 'roadmap-updated');
const idOf = (view: RoadmapView, title: string) => view.nodes.find((node) => node.title === title)!.id;

/** The refusal happens, with this code, and changes nothing anywhere — rows or events. */
function refused(action: () => unknown, code: string, message?: RegExp): AgentRelayError {
  const before = contents();
  const published = events.events.length;
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentRelayError);
  expect(caught).toMatchObject({ code });
  if (message) expect((caught as Error).message).toMatch(message);
  expect(contents()).toEqual(before);
  expect(events.events).toHaveLength(published);
  return caught as AgentRelayError;
}

/** Goal → Phase A, Phase B; Epic A1, A2 under Phase A; Epic B1 under Phase B. */
function hierarchy(): RoadmapView {
  let view = service.createNode({ projectId: P, expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
  const goal = idOf(view, 'Goal');
  view = service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'phase', parentId: goal, title: 'Phase A' });
  view = service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'phase', parentId: goal, title: 'Phase B' });
  for (const [title, phase] of [['Epic A1', 'Phase A'], ['Epic A2', 'Phase A'], ['Epic B1', 'Phase B']] as const) {
    view = service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'epic', parentId: idOf(view, phase), title });
  }
  return view;
}

describe('reading', () => {
  it('reads an empty roadmap: every task Unassigned in Tasks-list order, nothing written, no event', () => {
    const before = contents();
    const view = service.view({ projectId: P });
    expect(view).toMatchObject({ revision: 0, nodes: [], placements: [], dependencies: [], cyclicDependencyIds: [] });
    expect(view.unassignedTaskIds).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(contents()).toEqual(before);
    expect(events.events).toEqual([]);
  });
});

describe('nodes', () => {
  it('creates goal → phase → epic, normalising text and minting ids, one revision and one event per write', () => {
    let view = service.createNode({
      projectId: P, expectedRevision: 0, kind: 'goal', parentId: null, title: '  Ship the roadmap  ',
      description: 'Line one\r\nLine two  ', acceptanceCriteria: ['  Survives restart. ']
    });
    const goal = view.nodes[0]!;
    expect(goal).toMatchObject({
      title: 'Ship the roadmap', description: 'Line one\nLine two', position: 0, state: 'open', createdAt: AT,
      acceptanceCriteria: [{ text: 'Survives restart.' }]
    });
    expect(goal.acceptanceCriteria[0]!.id).toMatch(/^rm-/);
    view = service.createNode({ projectId: P, expectedRevision: 1, kind: 'phase', parentId: goal.id, title: 'Phase' });
    view = service.createNode({ projectId: P, expectedRevision: 2, kind: 'epic', parentId: idOf(view, 'Phase'), title: 'Epic' });
    expect(view.revision).toBe(3);
    expect(roadmapEvents()).toEqual([1, 2, 3].map((revision) => ({ kind: 'roadmap-updated', projectId: P, revision })));
  });

  it('inserts at a position and renumbers the siblings densely; a position past the end is refused', () => {
    let view = hierarchy();
    view = service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'phase', parentId: idOf(view, 'Goal'), title: 'Phase 0', position: 0 });
    expect(view.nodes.filter((node) => node.kind === 'phase').sort((a, b) => a.position - b.position).map((node) => node.title))
      .toEqual(['Phase 0', 'Phase A', 'Phase B']);
    refused(() => service.createNode({
      projectId: P, expectedRevision: view.revision, kind: 'phase', parentId: idOf(view, 'Goal'), title: 'Far', position: 9
    }), 'VALIDATION_FAILED', /past the end/);
  });

  it('refuses a wrong or missing parent, another project’s parent and a stale revision, writing nothing', () => {
    const view = hierarchy();
    const phase = idOf(view, 'Phase A');
    refused(() => service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'phase', parentId: null, title: 'x' }),
      'VALIDATION_FAILED', /must be a goal/);
    refused(() => service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'epic', parentId: idOf(view, 'Goal'), title: 'x' }),
      'VALIDATION_FAILED', /must be a phase, not a goal/);
    refused(() => service.createNode({ projectId: Q, expectedRevision: 0, kind: 'epic', parentId: phase, title: 'x' }), 'NOT_FOUND');
    refused(() => service.createNode({ projectId: P, expectedRevision: view.revision - 1, kind: 'goal', parentId: null, title: 'x' }),
      'VALIDATION_FAILED', /Roadmap changed/);
    refused(() => service.createNode({ projectId: 'missing', expectedRevision: 0, kind: 'goal', parentId: null, title: 'x' }), 'NOT_FOUND');
    refused(() => service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'goal', parentId: null, title: '   ' }),
      'VALIDATION_FAILED', /invalid/);
  });

  it('edits title, description and criteria, keeping named criterion ids; an identical edit writes nothing', () => {
    let view = service.createNode({ projectId: P, expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal', acceptanceCriteria: ['Kept', 'Dropped'] });
    const goal = view.nodes[0]!;
    const kept = goal.acceptanceCriteria[0]!.id;
    clock.advance(1000);
    view = service.updateNode({
      projectId: P, expectedRevision: 1, nodeId: goal.id, title: 'Renamed',
      acceptanceCriteria: [{ text: 'New first' }, { id: kept, text: 'Kept, reworded' }]
    });
    expect(view.nodes[0]).toMatchObject({ title: 'Renamed', createdAt: AT, updatedAt: '2026-09-29T10:00:01.000Z' });
    expect(view.nodes[0]!.acceptanceCriteria.map((criterion) => criterion.text)).toEqual(['New first', 'Kept, reworded']);
    expect(view.nodes[0]!.acceptanceCriteria[1]!.id).toBe(kept);

    const published = roadmapEvents().length;
    const same = service.updateNode({ projectId: P, expectedRevision: 2, nodeId: goal.id, title: '  Renamed ' });
    expect(same.revision).toBe(2);
    expect(roadmapEvents()).toHaveLength(published);
    refused(() => service.updateNode({ projectId: P, expectedRevision: 2, nodeId: goal.id, acceptanceCriteria: [{ id: 'foreign', text: 'x' }] }),
      'VALIDATION_FAILED', /does not belong/);
  });

  it('reorders and moves nodes; a move to where the node already is writes nothing', () => {
    let view = hierarchy();
    view = service.moveNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A2'), parentId: idOf(view, 'Phase A'), position: 0 });
    const phaseA = idOf(view, 'Phase A');
    expect(view.nodes.filter((node) => node.parentId === phaseA).sort((a, b) => a.position - b.position).map((node) => node.title))
      .toEqual(['Epic A2', 'Epic A1']);
    view = service.moveNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1'), parentId: idOf(view, 'Phase B'), position: 1 });
    expect(view.nodes.find((node) => node.title === 'Epic A1')).toMatchObject({ parentId: idOf(view, 'Phase B'), position: 1 });

    const revision = view.revision;
    const unchanged = service.moveNode({ projectId: P, expectedRevision: revision, nodeId: idOf(view, 'Epic A1'), parentId: idOf(view, 'Phase B'), position: 1 });
    expect(unchanged.revision).toBe(revision);
    refused(() => service.moveNode({ projectId: P, expectedRevision: revision, nodeId: idOf(view, 'Epic A1'), parentId: idOf(view, 'Goal'), position: 0 }),
      'VALIDATION_FAILED', /must be a phase/);
  });

  it('removes only an open, empty node nothing refers to', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: idOf(view, 'Epic A1') });
    view = service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'node', nodeId: idOf(view, 'Epic B1') }, prerequisite: { kind: 'node', nodeId: idOf(view, 'Epic A2') } });
    refused(() => service.removeNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Phase A') }), 'VALIDATION_FAILED', /without children/);
    refused(() => service.removeNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1') }), 'VALIDATION_FAILED', /without tasks/);
    refused(() => service.removeNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A2') }), 'VALIDATION_FAILED', /dependencies/);
    view = service.removeDependency({ projectId: P, expectedRevision: view.revision, dependencyId: view.dependencies[0]!.id });
    view = service.removeNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A2') });
    expect(view.nodes.map((node) => node.title)).not.toContain('Epic A2');
  });
});

describe('closed nodes, acceptance and reopen', () => {
  it('refuses accept or cancel over an open child or an unfinished task, naming them', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't2', epicId: idOf(view, 'Epic A1') });
    const error = refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1'), event: 'accept' }),
      'VALIDATION_FAILED', /must be finished/);
    expect(error.details).toBe('t2');
    refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Phase A'), event: 'cancel' }),
      'VALIDATION_FAILED', /Close every child first/);
  });

  it('requires explicit acknowledgement to accept over stopped work anywhere beneath, except under a cancelled child', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't3', epicId: idOf(view, 'Epic A1') });
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't4', epicId: idOf(view, 'Epic A1') });
    const epic = idOf(view, 'Epic A1');
    const error = refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: epic, event: 'accept' }), 'APPROVAL_REQUIRED');
    expect(error.details).toBe('t4');
    view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: epic, event: 'accept', acknowledgeStoppedWork: true });
    expect(view.progress[epic]).toMatchObject({ display: 'accepted', hasStoppedWork: true, stoppedTaskIds: ['t4'] });

    view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A2'), event: 'cancel' });
    // Phase A: the acknowledged stopped task still sits beneath it, so accepting the phase asks again.
    refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Phase A'), event: 'accept' }), 'APPROVAL_REQUIRED');
    view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Phase A'), event: 'accept', acknowledgeStoppedWork: true });
    expect(view.nodes.find((node) => node.title === 'Phase A')?.state).toBe('accepted');
  });

  it('freezes a closed node’s contents: no child, task, move or dependency in or out until it is reopened', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't3', epicId: idOf(view, 'Epic A1') });
    view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1'), event: 'accept' });
    const r = view.revision;
    const epic = idOf(view, 'Epic A1');
    refused(() => service.placeTask({ projectId: P, expectedRevision: r, taskId: 't5', epicId: epic }), 'VALIDATION_FAILED', /accepted; reopen it first/);
    refused(() => service.placeTask({ projectId: P, expectedRevision: r, taskId: 't3', epicId: idOf(view, 'Epic A2') }), 'VALIDATION_FAILED', /move a task out of/);
    refused(() => service.unassignTask({ projectId: P, expectedRevision: r, taskId: 't3' }), 'VALIDATION_FAILED', /move a task out of/);
    refused(() => service.updateNode({ projectId: P, expectedRevision: r, nodeId: epic, title: 'x' }), 'VALIDATION_FAILED', /Cannot edit/);
    refused(() => service.addDependency({ projectId: P, expectedRevision: r, dependent: { kind: 'node', nodeId: epic }, prerequisite: { kind: 'node', nodeId: idOf(view, 'Epic B1') } }),
      'VALIDATION_FAILED', /add a dependency inside/);
    refused(() => service.removeNode({ projectId: P, expectedRevision: r, nodeId: epic }), 'VALIDATION_FAILED', /Cannot remove/);

    view = service.transitionNode({ projectId: P, expectedRevision: r, nodeId: epic, event: 'reopen' });
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't5', epicId: epic });
    expect(view.placements.map((row) => row.taskId)).toEqual(['t3', 't5']);
  });

  it('reopens without cascading, and refuses reopening a child under a closed parent', () => {
    let view = hierarchy();
    for (const title of ['Epic A1', 'Epic A2', 'Phase A']) {
      view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, title), event: 'accept' });
    }
    refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1'), event: 'reopen' }),
      'VALIDATION_FAILED', /Reopen the parent first/);
    view = service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Phase A'), event: 'reopen' });
    expect(Object.fromEntries(view.nodes.map((node) => [node.title, node.state]))).toMatchObject({
      'Phase A': 'open', 'Epic A1': 'accepted', 'Epic A2': 'accepted'
    });
    refused(() => service.transitionNode({ projectId: P, expectedRevision: view.revision, nodeId: idOf(view, 'Epic A1'), event: 'accept' }),
      'INVALID_TRANSITION');
  });
});

describe('tasks', () => {
  it('assigns, reorders, moves between epics and unassigns, leaving the task rows untouched', () => {
    const tasksBefore = contents().tasks;
    let view = hierarchy();
    const a1 = idOf(view, 'Epic A1');
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: a1 });
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't2', epicId: a1, position: 0 });
    expect(view.placements.map((row) => [row.taskId, row.position])).toEqual([['t2', 0], ['t1', 1]]);
    const unchanged = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: a1 });
    expect(unchanged.revision).toBe(view.revision);
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: idOf(view, 'Epic B1') });
    expect(view.placements.find((row) => row.taskId === 't1')).toMatchObject({ epicId: idOf(view, 'Epic B1'), position: 0, createdAt: AT });
    view = service.unassignTask({ projectId: P, expectedRevision: view.revision, taskId: 't1' });
    expect(view.unassignedTaskIds).toContain('t1');
    expect(service.unassignTask({ projectId: P, expectedRevision: view.revision, taskId: 't1' }).revision).toBe(view.revision);
    expect(contents().tasks).toEqual(tasksBefore);
  });

  it('never reaches across projects', () => {
    const view = hierarchy();
    refused(() => service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 'q1', epicId: idOf(view, 'Epic A1') }), 'NOT_FOUND');
    refused(() => service.placeTask({ projectId: Q, expectedRevision: 0, taskId: 'q1', epicId: idOf(view, 'Epic A1') }), 'NOT_FOUND');
    refused(() => service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 'q1' } }), 'NOT_FOUND');
    refused(() => service.transitionNode({ projectId: Q, expectedRevision: 0, nodeId: idOf(view, 'Goal'), event: 'cancel' }), 'NOT_FOUND');
    expect(service.view({ projectId: Q })).toMatchObject({ revision: 0, nodes: [], unassignedTaskIds: ['q1'] });
  });
});

describe('dependencies and cycles', () => {
  it('refuses a direct cycle and a cycle through inheritance, naming the edge, and writes nothing', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: idOf(view, 'Epic A1') });
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't2', epicId: idOf(view, 'Epic B1') });
    view = service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't2' } });
    const direct = refused(() => service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't2' }, prerequisite: { kind: 'task', taskId: 't1' } }),
      'VALIDATION_FAILED', /dependency cycle/);
    expect(direct).toBeInstanceOf(RoadmapCycleError);
    // Epic B1 waits for Epic A1; t1 (in A1) waits for t2 (in B1): a deadlock no single edge shows.
    refused(() => service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'node', nodeId: idOf(view, 'Epic B1') }, prerequisite: { kind: 'node', nodeId: idOf(view, 'Epic A1') } }),
      'VALIDATION_FAILED', /dependency cycle/);
  });

  it('refuses the structural shapes: self, repeated and containment edges', () => {
    let view = hierarchy();
    view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: 't1', epicId: idOf(view, 'Epic A1') });
    view = service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't2' } });
    const r = view.revision;
    refused(() => service.addDependency({ projectId: P, expectedRevision: r, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't1' } }), 'VALIDATION_FAILED');
    refused(() => service.addDependency({ projectId: P, expectedRevision: r, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't2' } }), 'VALIDATION_FAILED', /not structurally valid/);
    refused(() => service.addDependency({ projectId: P, expectedRevision: r, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'node', nodeId: idOf(view, 'Goal') } }), 'VALIDATION_FAILED', /not structurally valid/);
  });

  it('refuses a dependency that is a cycle only after continuation resolution', () => {
    db.prepare(`INSERT INTO task_continuations(id,source_task_id,continuation_task_id,entry_action,created_at) VALUES ('c1','t4','t1','verification',?)`).run(AT);
    const view = service.view({ projectId: P });
    // t4 (FAILED) is continued by t1, so "t1 depends on t4" is t1 waiting for itself.
    refused(() => service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't4' } }),
      'VALIDATION_FAILED', /dependency cycle/);
  });

  it('reports a cycle a continuation created at read time, lets unrelated writes through, and lets the edge be removed', () => {
    let view = service.addDependency({ projectId: P, expectedRevision: 0, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'task', taskId: 't4' } });
    expect(view.readiness.tasks['t1']).toMatchObject({ status: 'blocked', waits: [{ reason: 'task_stopped' }] });
    const edge = view.dependencies[0]!.id;
    // A workflow event, not a roadmap write: t4 is now continued by t1.
    db.prepare(`INSERT INTO task_continuations(id,source_task_id,continuation_task_id,entry_action,created_at) VALUES ('c1','t4','t1','verification',?)`).run(AT);
    view = service.view({ projectId: P });
    expect(view.cyclicDependencyIds).toEqual([edge]);
    expect(view.readiness.tasks['t1']).toMatchObject({ status: 'blocked', waits: [{ dependencyId: edge, reason: 'dependency_cycle' }] });
    view = service.createNode({ projectId: P, expectedRevision: view.revision, kind: 'goal', parentId: null, title: 'Unrelated' });
    view = service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'task', taskId: 't2' }, prerequisite: { kind: 'task', taskId: 't3' } });
    view = service.removeDependency({ projectId: P, expectedRevision: view.revision, dependencyId: edge });
    expect(view.cyclicDependencyIds).toEqual([]);
    expect(view.readiness.tasks['t1']?.status).toBe('ready');
  });
});

describe('readiness and progress in the view', () => {
  it('rolls progress up and derives readiness across levels and mixed statuses', () => {
    let view = hierarchy();
    for (const [task, epic] of [['t1', 'Epic A1'], ['t2', 'Epic A1'], ['t3', 'Epic A2'], ['t5', 'Epic A2']] as const) {
      view = service.placeTask({ projectId: P, expectedRevision: view.revision, taskId: task, epicId: idOf(view, epic) });
    }
    view = service.addDependency({ projectId: P, expectedRevision: view.revision, dependent: { kind: 'node', nodeId: idOf(view, 'Phase B') }, prerequisite: { kind: 'node', nodeId: idOf(view, 'Phase A') } });
    expect(view.progress[idOf(view, 'Phase A')]).toMatchObject({
      counts: { notStarted: 1, inProgress: 1, done: 1, stopped: 0, total: 3, cancelled: 1, superseded: 0 },
      display: 'in_progress'
    });
    expect(view.progress[idOf(view, 'Epic A2')]?.display).toBe('awaiting_acceptance');
    expect(view.progress[idOf(view, 'Epic B1')]?.display).toBe('empty');
    expect(view.readiness.nodes[idOf(view, 'Epic B1')]).toMatchObject({
      status: 'pending', waits: [{ inheritedFrom: idOf(view, 'Phase B'), reason: 'node_open' }]
    });
    expect(view.unassignedTaskIds).toEqual(['t4']);
  });
});

describe('events and transactions', () => {
  it('publishes only after the caller’s outer transaction commits', () => {
    const transactions = new SqliteTransactionRunner(db);
    const seen: number[] = [];
    transactions.run(() => {
      service.createNode({ projectId: P, expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
      seen.push(roadmapEvents().length);
    });
    expect(seen).toEqual([0]);
    expect(roadmapEvents()).toEqual([{ kind: 'roadmap-updated', projectId: P, revision: 1 }]);
  });

  it('publishes nothing, and keeps nothing, when the caller’s outer transaction rolls back', () => {
    const before = contents();
    expect(() => new SqliteTransactionRunner(db).run(() => {
      service.createNode({ projectId: P, expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
      throw new Error('caller rollback');
    })).toThrow('caller rollback');
    expect(roadmapEvents()).toEqual([]);
    expect(contents()).toEqual(before);
  });

  it('refuses a writer holding a stale revision after another writer committed', () => {
    const first = service.view({ projectId: P });
    service.createNode({ projectId: P, expectedRevision: first.revision, kind: 'goal', parentId: null, title: 'One' });
    refused(() => service.createNode({ projectId: P, expectedRevision: first.revision, kind: 'goal', parentId: null, title: 'Two' }),
      'VALIDATION_FAILED', /Roadmap changed/);
  });
});
