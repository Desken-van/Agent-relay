/**
 * The real 13C engine against the examples docs/roadmap.md §4 names — continuation resolution, the
 * start/done graph, and readiness judged by the same resolved edges.
 */

import { describe, expect, it } from 'vitest';
import type {
  RoadmapDependency,
  RoadmapNode,
  RoadmapTaskFact,
  RoadmapTaskPlacement
} from '../../src/shared/domain/roadmap';
import {
  buildWaitGraph,
  continuationResolver,
  introducedCycleEdges
} from '../../src/shared/domain/roadmap-graph';
import { deriveReadiness } from '../../src/shared/domain/roadmap-progress';
import { parseRoadmapSnapshot } from '../../src/shared/domain/roadmap-structure';
import { dependency, nodeRef, placement, PROJECT, roadmapNode, taskFact, taskRef } from '../helpers/roadmap-fixtures';

const BASE_NODES: readonly RoadmapNode[] = [
  roadmapNode({ id: 'g1', kind: 'goal', position: 0 }),
  roadmapNode({ id: 'p1', kind: 'phase', parentId: 'g1', position: 0 }),
  roadmapNode({ id: 'e1', kind: 'epic', parentId: 'p1', position: 0 }),
  roadmapNode({ id: 'e2', kind: 'epic', parentId: 'p1', position: 1 })
];

function roadmap(parts: {
  tasks: RoadmapTaskFact[];
  placements?: RoadmapTaskPlacement[];
  dependencies?: RoadmapDependency[];
  nodes?: RoadmapNode[];
}) {
  return {
    projectId: PROJECT,
    revision: 1,
    nodes: parts.nodes ?? [...BASE_NODES],
    placements: parts.placements ?? [],
    dependencies: parts.dependencies ?? [],
    tasks: parts.tasks
  };
}

const cyclic = (snapshot: ReturnType<typeof roadmap>) => [...buildWaitGraph(snapshot).cyclicDependencyIds].sort();
const waitOf = (snapshot: ReturnType<typeof roadmap>, taskId: string) =>
  deriveReadiness(snapshot).tasks.get(taskId)!;

describe('continuation resolution R', () => {
  it('ends at the last task of the chain, ignores a continuation on a task that is not stopped, and never loops', () => {
    const resolve = continuationResolver([
      taskFact('A', 'REVIEW_LIMIT_REACHED', 'B'),
      taskFact('B', 'FAILED', 'C'),
      taskFact('C', 'DRAFT'),
      taskFact('D', 'COMPLETED', 'C'),
      taskFact('L1', 'FAILED', 'L2'),
      taskFact('L2', 'FAILED', 'L1'),
      taskFact('M', 'FAILED', 'ghost')
    ]);
    expect(resolve(taskRef('A'))).toEqual({ ok: true, ref: taskRef('C') });
    expect(resolve(taskRef('D'))).toEqual({ ok: true, ref: taskRef('D') });
    expect(resolve(nodeRef('e1'))).toEqual({ ok: true, ref: nodeRef('e1') });
    expect(resolve(taskRef('L1'))).toEqual({ ok: false, reason: 'continuation_loop', chain: ['L1', 'L2', 'L1'] });
    expect(resolve(taskRef('M'))).toEqual({ ok: false, reason: 'continuation_missing', chain: ['M', 'ghost'] });
  });
});

describe('cycles through continuation, containment and inheritance', () => {
  const continued = [taskFact('A', 'REVIEW_LIMIT_REACHED', 'B'), taskFact('B', 'DRAFT')];
  const sameEpic = [placement('A', 'e1', 0), placement('B', 'e1', 1)];

  it('reads "B depends on A", with A continued by B, as B waiting for itself — while the snapshot stays valid', () => {
    const snapshot = roadmap({ tasks: continued, placements: sameEpic, dependencies: [dependency('d1', taskRef('B'), taskRef('A'))] });
    expect(cyclic(snapshot)).toEqual(['d1']);
    expect(waitOf(snapshot, 'B')).toMatchObject({ status: 'blocked', waits: [{ dependencyId: 'd1', reason: 'dependency_cycle' }] });
    expect(() => parseRoadmapSnapshot(snapshot)).not.toThrow();
  });

  it('reads the reverse edge, "A depends on B", as the same loop', () => {
    const snapshot = roadmap({ tasks: continued, placements: sameEpic, dependencies: [dependency('d1', taskRef('A'), taskRef('B'))] });
    expect(cyclic(snapshot)).toEqual(['d1']);
  });

  it('sees an accepted edge turn cyclic when a continuation appears, with no roadmap write', () => {
    const stored = { placements: sameEpic, dependencies: [dependency('d1', taskRef('B'), taskRef('A'))] };
    const before = roadmap({ ...stored, tasks: [taskFact('A', 'FAILED'), taskFact('B', 'DRAFT')] });
    expect(cyclic(before)).toEqual([]);
    expect(waitOf(before, 'B')).toMatchObject({ status: 'blocked', waits: [{ reason: 'task_stopped' }] });

    const after = roadmap({ ...stored, tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'DRAFT')] });
    expect(cyclic(after)).toEqual(['d1']);
    expect(waitOf(after, 'B').waits[0]?.reason).toBe('dependency_cycle');
  });

  it('passes a superseded dependent’s waits to its successor', () => {
    const snapshot = roadmap({
      tasks: [...continued, taskFact('X', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('A'), taskRef('X')), dependency('d2', taskRef('X'), taskRef('B'))]
    });
    expect(cyclic(snapshot)).toEqual(['d1', 'd2']);
    expect(waitOf(snapshot, 'A')).toMatchObject({ status: 'not_applicable', notApplicable: 'superseded', successorTaskId: 'B' });
  });

  it('finds a successor that its own epic waits on through the superseded source', () => {
    const snapshot = roadmap({
      tasks: continued,
      placements: [placement('A', 'e1', 0), placement('B', 'e2', 0)],
      dependencies: [dependency('d1', nodeRef('e2'), taskRef('A'))]
    });
    expect(() => parseRoadmapSnapshot(snapshot)).not.toThrow();
    expect(cyclic(snapshot)).toEqual(['d1']);
  });

  it('finds the cross-epic deadlock no single edge shows, and ignores the edges of a cancelled dependent', () => {
    const placements = [placement('t1', 'e1', 0), placement('t2', 'e2', 0)];
    const dependencies = [dependency('d1', nodeRef('e1'), nodeRef('e2')), dependency('d2', taskRef('t2'), taskRef('t1'))];
    expect(cyclic(roadmap({ tasks: [taskFact('t1', 'DRAFT'), taskFact('t2', 'DRAFT')], placements, dependencies })))
      .toEqual(['d1', 'd2']);

    const cancelled = roadmap({
      tasks: [taskFact('t1', 'CANCELLED'), taskFact('t2', 'DRAFT')],
      placements,
      dependencies,
      nodes: BASE_NODES.map((node) => (node.id === 'e1' ? { ...node, state: 'cancelled' as const } : node))
    });
    expect(cyclic(cancelled)).toEqual([]);
    expect(waitOf(cancelled, 't2')).toMatchObject({ status: 'blocked', waits: [{ reason: 'task_cancelled' }] });
  });

  it('terminates on a malformed chain and blocks what relies on it with a named reason', () => {
    const snapshot = roadmap({
      tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'FAILED', 'A'), taskFact('C', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('C'), taskRef('A'))]
    });
    const graph = buildWaitGraph(snapshot);
    expect([...graph.cyclicDependencyIds]).toEqual([]);
    expect(graph.unresolved).toEqual([
      { dependencyId: 'd1', end: 'prerequisite', reason: 'continuation_loop', chain: ['A', 'B', 'A'] }
    ]);
    expect(waitOf(snapshot, 'C')).toMatchObject({
      status: 'blocked',
      waits: [{ dependencyId: 'd1', resolvedPrerequisite: null, state: 'unsatisfiable', reason: 'continuation_unresolvable' }]
    });
  });

  it('blocks a wait on a cycle even when its prerequisite is itself completed', () => {
    const snapshot = roadmap({
      tasks: [taskFact('A', 'COMPLETED'), taskFact('B', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('A'), taskRef('B')), dependency('d2', taskRef('B'), taskRef('A'))]
    });
    expect(waitOf(snapshot, 'B')).toMatchObject({ status: 'blocked', waits: [{ dependencyId: 'd2', reason: 'dependency_cycle' }] });
  });

  it('follows a 5 000-edge chain without a cycle and without exhausting the stack', () => {
    const tasks = Array.from({ length: 5_001 }, (_, index) => taskFact(`t${index}`, 'DRAFT'));
    const dependencies = Array.from({ length: 5_000 }, (_, index) =>
      dependency(`d${index}`, taskRef(`t${index}`), taskRef(`t${index + 1}`)));
    expect(cyclic(roadmap({ tasks, dependencies }))).toEqual([]);
  });
});

describe('the write-time rule', () => {
  const tasks = [taskFact('t1', 'DRAFT'), taskFact('t2', 'DRAFT'), taskFact('t3', 'DRAFT')];

  it('refuses an edge that closes a cycle and names the edges that would be cyclic', () => {
    const before = roadmap({ tasks, dependencies: [dependency('d1', taskRef('t1'), taskRef('t2'))] });
    const after = roadmap({ tasks, dependencies: [...before.dependencies, dependency('d2', taskRef('t2'), taskRef('t1'))] });
    const introduced = introducedCycleEdges(buildWaitGraph(before), buildWaitGraph(after));
    expect(introduced.flatMap((edge) => (edge.link.kind === 'dependency' ? [edge.link.dependencyId] : []))).toEqual(['d2']);
  });

  it('lets an unrelated change through a cycle that already exists, and never refuses a removal', () => {
    const existing = roadmap({
      tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'DRAFT'), taskFact('C', 'DRAFT'), taskFact('D', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('B'), taskRef('A'))]
    });
    const unrelated = { ...existing, dependencies: [...existing.dependencies, dependency('d2', taskRef('C'), taskRef('D'))] };
    expect(introducedCycleEdges(buildWaitGraph(existing), buildWaitGraph(unrelated))).toEqual([]);
    const removed = { ...existing, dependencies: [] };
    expect(introducedCycleEdges(buildWaitGraph(existing), buildWaitGraph(removed))).toEqual([]);
  });

  it('lets a task join an epic whose own wait is cyclic, and reports the inherited cycle as its blocker', () => {
    const before = roadmap({
      tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'DRAFT'), taskFact('t9', 'DRAFT')],
      placements: [placement('B', 'e2', 0)],
      dependencies: [dependency('d1', nodeRef('e2'), taskRef('A'))]
    });
    const after = { ...before, placements: [...before.placements, placement('t9', 'e2', 1)] };
    // Nothing on the cycle reaches start(t9): the task waits on it, it is not part of it.
    expect(introducedCycleEdges(buildWaitGraph(before), buildWaitGraph(after))).toEqual([]);
    expect(waitOf(after, 't9')).toMatchObject({
      status: 'blocked',
      waits: [{ dependencyId: 'd1', inheritedFrom: 'e2', reason: 'dependency_cycle' }]
    });
  });

  it('counts a reopened node’s reactivated edges as new', () => {
    const cancelledE1 = BASE_NODES.map((node) => (node.id === 'e1' ? { ...node, state: 'cancelled' as const } : node));
    const before = roadmap({
      tasks: [taskFact('t2', 'DRAFT')],
      placements: [placement('t2', 'e2', 0)],
      dependencies: [dependency('d1', nodeRef('e1'), nodeRef('e2')), dependency('d2', taskRef('t2'), nodeRef('e1'))],
      nodes: cancelledE1
    });
    expect(cyclic(before)).toEqual([]);
    const reopened = { ...before, nodes: [...BASE_NODES] };
    expect(introducedCycleEdges(buildWaitGraph(before), buildWaitGraph(reopened)).length).toBeGreaterThan(0);
  });
});

describe('readiness', () => {
  it('judges a superseded prerequisite by its successor, over the whole chain', () => {
    const judged = (...successors: RoadmapTaskFact[]) =>
      waitOf(roadmap({
        tasks: [taskFact('A', 'REVIEW_LIMIT_REACHED', 'B'), ...successors, taskFact('C', 'DRAFT')],
        dependencies: [dependency('d1', taskRef('C'), taskRef('A'))]
      }), 'C').waits[0];
    expect(judged(taskFact('B', 'COMPLETED'))).toMatchObject({ state: 'satisfied', reason: 'completed', resolvedPrerequisite: taskRef('B') });
    expect(judged(taskFact('B', 'IMPLEMENTING'))).toMatchObject({ state: 'pending', reason: 'task_not_done' });
    expect(judged(taskFact('B', 'CANCELLED'))).toMatchObject({ state: 'unsatisfiable', reason: 'task_cancelled' });
    expect(judged(taskFact('B', 'FAILED'))).toMatchObject({ state: 'unsatisfiable', reason: 'task_stopped' });
    expect(judged(taskFact('B', 'FAILED', 'D'), taskFact('D', 'COMPLETED'))).toMatchObject({ state: 'satisfied', resolvedPrerequisite: taskRef('D') });
  });

  it('inherits every ancestor’s waits through the item’s own placement; an Unassigned task has only its own', () => {
    const nodes = [
      ...BASE_NODES,
      roadmapNode({ id: 'g2', kind: 'goal', position: 1, state: 'accepted' }),
      roadmapNode({ id: 'g3', kind: 'goal', position: 2 })
    ];
    const snapshot = roadmap({
      nodes,
      tasks: [taskFact('t1', 'DRAFT'), taskFact('u1', 'DRAFT'), taskFact('x', 'IMPLEMENTING')],
      placements: [placement('t1', 'e1', 0)],
      dependencies: [
        dependency('onGoal', nodeRef('g1'), nodeRef('g2')),
        dependency('onPhase', nodeRef('p1'), nodeRef('g3')),
        dependency('own', taskRef('t1'), taskRef('x')),
        dependency('unassigned', taskRef('u1'), nodeRef('g2'))
      ]
    });
    expect(waitOf(snapshot, 't1')).toMatchObject({
      status: 'pending',
      waits: [
        { dependencyId: 'own', inheritedFrom: null, state: 'pending' },
        { dependencyId: 'onPhase', inheritedFrom: 'p1', state: 'pending', reason: 'node_open' },
        { dependencyId: 'onGoal', inheritedFrom: 'g1', state: 'satisfied', reason: 'accepted' }
      ]
    });
    expect(waitOf(snapshot, 'u1')).toMatchObject({ status: 'ready', waits: [{ dependencyId: 'unassigned' }] });
    expect(deriveReadiness(snapshot).nodes.get('e1')).toMatchObject({ status: 'pending' });
  });

  it('marks a cancelled item and a superseded task as not applicable', () => {
    const snapshot = roadmap({
      tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'DRAFT'), taskFact('X', 'CANCELLED')],
      nodes: BASE_NODES.map((node) => (node.id === 'e2' ? { ...node, state: 'cancelled' as const } : node))
    });
    const readiness = deriveReadiness(snapshot);
    expect(readiness.tasks.get('A')).toMatchObject({ status: 'not_applicable', notApplicable: 'superseded', successorTaskId: 'B' });
    expect(readiness.tasks.get('X')).toMatchObject({ status: 'not_applicable', notApplicable: 'cancelled' });
    expect(readiness.nodes.get('e2')).toMatchObject({ status: 'not_applicable', notApplicable: 'cancelled' });
    expect(readiness.tasks.get('B')).toMatchObject({ status: 'ready', waits: [] });
  });
});
