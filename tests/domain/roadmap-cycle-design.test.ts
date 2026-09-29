/**
 * Design contract for docs/roadmap.md §4 — a MODEL of the text, not product code.
 *
 * Agent Relay derives no readiness and detects no dependency cycles until Milestone 13C. This file holds a
 * deliberately small model of the documented rules — continuation resolution `R`, inert edges, the
 * start/done graph — so the documented examples are executable and the text cannot quietly contradict itself.
 * Nothing in the application calls it. 13C implements its own engine from docs/roadmap.md and may replace this
 * file with tests of that engine.
 */

import { describe, expect, it } from 'vitest';
import {
  roadmapItemKey,
  taskProgressKind,
  type RoadmapDependency,
  type RoadmapItemRef,
  type RoadmapNode,
  type RoadmapTaskFact,
  type RoadmapTaskPlacement
} from '../../src/shared/domain/roadmap';
import { parseRoadmapSnapshot, type RoadmapSnapshotInput } from '../../src/shared/domain/roadmap-structure';
import { dependency, nodeRef, placement, PROJECT, roadmapNode, taskFact, taskRef } from '../helpers/roadmap-fixtures';

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

/** `resolved` follows §4; `raw` reads stored references as they are, which is what the earlier text did. */
type Reading = 'resolved' | 'raw';

/** R(ref): a node is itself; a superseded task is R(its continuation). Null for a chain that revisits a task. */
function resolve(ref: RoadmapItemRef, snapshot: RoadmapSnapshotInput, reading: Reading): RoadmapItemRef | null {
  if (ref.kind === 'node' || reading === 'raw') return ref;
  const facts = new Map(snapshot.tasks.map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  let current = ref.taskId;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const fact = facts.get(current);
    if (fact === undefined || taskProgressKind(fact) !== 'superseded' || fact.continuedByTaskId === null) {
      return { kind: 'task', taskId: current };
    }
    current = fact.continuedByTaskId;
  }
}

function isVertexTask(fact: RoadmapTaskFact, reading: Reading): boolean {
  return reading === 'raw' || taskProgressKind(fact) !== 'superseded';
}

/** An edge whose resolved dependent will never start constrains nothing. */
function isInert(ref: RoadmapItemRef, snapshot: RoadmapSnapshotInput): boolean {
  return ref.kind === 'node'
    ? snapshot.nodes.find((node) => node.id === ref.nodeId)?.state === 'cancelled'
    : snapshot.tasks.find((fact) => fact.id === ref.taskId)?.status === 'CANCELLED';
}

const vertex = (phase: 'start' | 'done', ref: RoadmapItemRef) => `${phase}:${roadmapItemKey(ref)}`;

/** Ids of the stored dependencies whose (resolved) edge lies on a cycle of the start/done graph. */
function cyclicDependencies(snapshot: RoadmapSnapshotInput, reading: Reading = 'resolved'): string[] {
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);

  for (const node of snapshot.nodes) {
    add(vertex('done', nodeRef(node.id)), vertex('start', nodeRef(node.id)));
    if (node.parentId === null) continue;
    add(vertex('start', nodeRef(node.id)), vertex('start', nodeRef(node.parentId)));
    if (node.state !== 'cancelled') add(vertex('done', nodeRef(node.parentId)), vertex('done', nodeRef(node.id)));
  }
  for (const fact of snapshot.tasks.filter((candidate) => isVertexTask(candidate, reading))) {
    add(vertex('done', taskRef(fact.id)), vertex('start', taskRef(fact.id)));
    const placed = snapshot.placements.find((row) => row.taskId === fact.id);
    if (placed === undefined) continue;
    add(vertex('start', taskRef(fact.id)), vertex('start', nodeRef(placed.epicId)));
    if (fact.status !== 'CANCELLED') add(vertex('done', nodeRef(placed.epicId)), vertex('done', taskRef(fact.id)));
  }
  const waits = snapshot.dependencies.flatMap((stored) => {
    const dependent = resolve(stored.dependent, snapshot, reading);
    const prerequisite = resolve(stored.prerequisite, snapshot, reading);
    if (dependent === null || prerequisite === null || isInert(dependent, snapshot)) return [];
    const wait = { id: stored.id, from: vertex('start', dependent), to: vertex('done', prerequisite) };
    add(wait.from, wait.to);
    return [wait];
  });

  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      if (current === target) return true;
      for (const next of edges.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  return waits.filter((wait) => reaches(wait.to, wait.from)).map((wait) => wait.id);
}

/** Satisfaction of one prerequisite, judged by R (§4 Readiness). */
function prerequisiteState(ref: RoadmapItemRef, snapshot: RoadmapSnapshotInput): 'satisfied' | 'pending' | 'unsatisfiable' {
  const resolved = resolve(ref, snapshot, 'resolved');
  if (resolved === null) return 'unsatisfiable';
  if (resolved.kind === 'node') {
    const state = snapshot.nodes.find((node) => node.id === resolved.nodeId)?.state;
    return state === 'accepted' ? 'satisfied' : state === 'cancelled' ? 'unsatisfiable' : 'pending';
  }
  const fact = snapshot.tasks.find((candidate) => candidate.id === resolved.taskId);
  if (fact === undefined) return 'unsatisfiable';
  const kind = taskProgressKind(fact);
  return kind === 'done' ? 'satisfied' : kind === 'stopped' || kind === 'cancelled' ? 'unsatisfiable' : 'pending';
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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
}): RoadmapSnapshotInput & { revision: number } {
  return {
    projectId: PROJECT,
    revision: 1,
    nodes: parts.nodes ?? [...BASE_NODES],
    placements: parts.placements ?? [],
    dependencies: parts.dependencies ?? [],
    tasks: parts.tasks
  };
}

/* ------------------------------------------------------------------ */
/* The documented examples                                             */
/* ------------------------------------------------------------------ */

describe('continuation resolution in the cycle check (docs/roadmap.md §4)', () => {
  const continued = [taskFact('A', 'REVIEW_LIMIT_REACHED', 'B'), taskFact('B', 'DRAFT')];
  const sameEpic = [placement('A', 'e1', 0), placement('B', 'e1', 1)];

  it('reads "B depends on A", with A continued by B, as B waiting for itself; raw references miss it', () => {
    const snapshot = roadmap({
      tasks: continued,
      placements: sameEpic,
      dependencies: [dependency('d1', taskRef('B'), taskRef('A'))]
    });
    expect(cyclicDependencies(snapshot)).toEqual(['d1']);
    expect(cyclicDependencies(snapshot, 'raw')).toEqual([]);
    // Structurally valid on purpose: a resolved cycle is never an I1–I7 invariant.
    expect(() => parseRoadmapSnapshot(snapshot)).not.toThrow();
  });

  it('reads the reverse edge, "A depends on B", as the same loop', () => {
    const snapshot = roadmap({
      tasks: continued,
      placements: sameEpic,
      dependencies: [dependency('d1', taskRef('A'), taskRef('B'))]
    });
    expect(cyclicDependencies(snapshot)).toEqual(['d1']);
  });

  it('sees an accepted edge turn cyclic when a continuation appears, with no roadmap write (read-time check)', () => {
    const stored = {
      placements: sameEpic,
      dependencies: [dependency('d1', taskRef('B'), taskRef('A'))]
    };
    const before = roadmap({ ...stored, tasks: [taskFact('A', 'FAILED'), taskFact('B', 'DRAFT')] });
    expect(cyclicDependencies(before)).toEqual([]);
    expect(prerequisiteState(taskRef('A'), before)).toBe('unsatisfiable');

    const after = roadmap({ ...stored, tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'DRAFT')] });
    expect(cyclicDependencies(after)).toEqual(['d1']);
    expect(() => parseRoadmapSnapshot(after)).not.toThrow();
  });

  it('passes a superseded dependent’s waits to its successor', () => {
    const snapshot = roadmap({
      tasks: [...continued, taskFact('X', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('A'), taskRef('X')), dependency('d2', taskRef('X'), taskRef('B'))]
    });
    expect(cyclicDependencies(snapshot)).toEqual(['d1', 'd2']);
    expect(cyclicDependencies(snapshot, 'raw')).toEqual([]);
  });

  it('finds a successor that its own epic waits on, through the superseded source', () => {
    const snapshot = roadmap({
      tasks: continued,
      placements: [placement('A', 'e1', 0), placement('B', 'e2', 0)],
      dependencies: [dependency('d1', nodeRef('e2'), taskRef('A'))]
    });
    expect(() => parseRoadmapSnapshot(snapshot)).not.toThrow();
    expect(cyclicDependencies(snapshot)).toEqual(['d1']);
  });

  it('still finds the cross-epic deadlock, and ignores the edges of a cancelled dependent', () => {
    const tasks = [taskFact('t1', 'DRAFT'), taskFact('t2', 'DRAFT')];
    const placements = [placement('t1', 'e1', 0), placement('t2', 'e2', 0)];
    const dependencies = [dependency('d1', nodeRef('e1'), nodeRef('e2')), dependency('d2', taskRef('t2'), taskRef('t1'))];
    expect(cyclicDependencies(roadmap({ tasks, placements, dependencies }))).toEqual(['d1', 'd2']);

    const cancelled = roadmap({
      tasks: [taskFact('t1', 'CANCELLED'), taskFact('t2', 'DRAFT')],
      placements,
      dependencies,
      nodes: BASE_NODES.map((node) => (node.id === 'e1' ? { ...node, state: 'cancelled' as const } : node))
    });
    expect(cyclicDependencies(cancelled)).toEqual([]);
    expect(prerequisiteState(taskRef('t1'), cancelled)).toBe('unsatisfiable');
  });

  it('terminates on a malformed chain that revisits a task and blocks what relies on it', () => {
    const snapshot = roadmap({
      tasks: [taskFact('A', 'FAILED', 'B'), taskFact('B', 'FAILED', 'A'), taskFact('C', 'DRAFT')],
      dependencies: [dependency('d1', taskRef('C'), taskRef('A'))]
    });
    expect(cyclicDependencies(snapshot)).toEqual([]);
    expect(prerequisiteState(taskRef('A'), snapshot)).toBe('unsatisfiable');
  });
});

describe('readiness judges a superseded prerequisite by its successor (docs/roadmap.md §4)', () => {
  const judged = (successor: RoadmapTaskFact, ...rest: RoadmapTaskFact[]) =>
    prerequisiteState(taskRef('A'), roadmap({ tasks: [taskFact('A', 'REVIEW_LIMIT_REACHED', 'B'), successor, ...rest] }));

  it.each([
    ['COMPLETED', 'satisfied'],
    ['IMPLEMENTING', 'pending'],
    ['CANCELLED', 'unsatisfiable'],
    ['FAILED', 'unsatisfiable']
  ] as const)('is %s → %s, never unsatisfiable merely because A was superseded', (status, expected) => {
    expect(judged(taskFact('B', status))).toBe(expected);
  });

  it('follows the whole chain to its last task', () => {
    expect(judged(taskFact('B', 'FAILED', 'D'), taskFact('D', 'COMPLETED'))).toBe('satisfied');
  });

  it('ignores a continuation recorded against a task that is not stopped, as progress does', () => {
    const snapshot = roadmap({ tasks: [taskFact('A', 'COMPLETED', 'B'), taskFact('B', 'DRAFT')] });
    expect(prerequisiteState(taskRef('A'), snapshot)).toBe('satisfied');
  });
});
