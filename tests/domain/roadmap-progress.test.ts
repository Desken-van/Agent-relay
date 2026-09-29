import { describe, expect, it } from 'vitest';
import { rollUpProgress } from '../../src/shared/domain/roadmap-progress';
import { placement, roadmapNode, taskFact } from '../helpers/roadmap-fixtures';

/**
 *   g1 ─ p1 ─ e1  t1 DRAFT, t2 IMPLEMENTING, t3 COMPLETED, t4 FAILED, t5 CANCELLED,
 *      │    │      t6 REVIEW_LIMIT_REACHED → continued by t7, t7 DRAFT
 *      │    ├ e2 (accepted)  t8 COMPLETED, t9 FAILED
 *      │    └ e3 (cancelled) t10 COMPLETED, t11 FAILED
 *      └ p2 ─ e4 (empty)
 *   g2 (no children)
 *   g3 ─ p3 ─ e5  t12 COMPLETED
 *   g4 ─ p4 ─ e6  t13 DRAFT
 *   Unassigned: u1 DRAFT
 */
function world() {
  const nodes = [
    roadmapNode({ id: 'g1', kind: 'goal', position: 0 }),
    roadmapNode({ id: 'g2', kind: 'goal', position: 1 }),
    roadmapNode({ id: 'g3', kind: 'goal', position: 2 }),
    roadmapNode({ id: 'g4', kind: 'goal', position: 3 }),
    roadmapNode({ id: 'p1', kind: 'phase', parentId: 'g1', position: 0 }),
    roadmapNode({ id: 'p2', kind: 'phase', parentId: 'g1', position: 1 }),
    roadmapNode({ id: 'p3', kind: 'phase', parentId: 'g3', position: 0 }),
    roadmapNode({ id: 'p4', kind: 'phase', parentId: 'g4', position: 0 }),
    roadmapNode({ id: 'e1', kind: 'epic', parentId: 'p1', position: 0 }),
    roadmapNode({ id: 'e2', kind: 'epic', parentId: 'p1', position: 1, state: 'accepted' }),
    roadmapNode({ id: 'e3', kind: 'epic', parentId: 'p1', position: 2, state: 'cancelled' }),
    roadmapNode({ id: 'e4', kind: 'epic', parentId: 'p2', position: 0 }),
    roadmapNode({ id: 'e5', kind: 'epic', parentId: 'p3', position: 0 }),
    roadmapNode({ id: 'e6', kind: 'epic', parentId: 'p4', position: 0 })
  ];
  const tasks = [
    taskFact('t1', 'DRAFT'), taskFact('t2', 'IMPLEMENTING'), taskFact('t3', 'COMPLETED'), taskFact('t4', 'FAILED'),
    taskFact('t5', 'CANCELLED'), taskFact('t6', 'REVIEW_LIMIT_REACHED', 't7'), taskFact('t7', 'DRAFT'),
    taskFact('t8', 'COMPLETED'), taskFact('t9', 'FAILED'), taskFact('t10', 'COMPLETED'), taskFact('t11', 'FAILED'),
    taskFact('t12', 'COMPLETED'), taskFact('t13', 'DRAFT'), taskFact('u1', 'DRAFT')
  ];
  const placements = [
    ...['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((id, index) => placement(id, 'e1', index)),
    placement('t8', 'e2', 0), placement('t9', 'e2', 1),
    placement('t10', 'e3', 0), placement('t11', 'e3', 1),
    placement('t12', 'e5', 0), placement('t13', 'e6', 0)
  ];
  return rollUpProgress({ nodes, tasks, placements });
}

describe('roll-up progress', () => {
  const progress = world();

  it('counts an epic’s tasks by their workflow status, reporting cancelled and superseded apart from the total', () => {
    expect(progress.get('e1')).toEqual({
      counts: { notStarted: 2, inProgress: 1, done: 1, stopped: 1, total: 5, cancelled: 1, superseded: 1 },
      display: 'in_progress',
      hasStoppedWork: true,
      stoppedTaskIds: ['t4']
    });
  });

  it('sums children into a parent, except a cancelled child, which is shown under itself only', () => {
    expect(progress.get('e3')).toMatchObject({ display: 'cancelled', counts: { done: 1, stopped: 1, total: 2 } });
    expect(progress.get('p1')).toMatchObject({
      counts: { notStarted: 2, inProgress: 1, done: 2, stopped: 2, total: 7, cancelled: 1, superseded: 1 },
      display: 'in_progress',
      stoppedTaskIds: ['t4', 't9']
    });
    expect(progress.get('g1')?.counts).toEqual(progress.get('p1')?.counts);
  });

  it('counts an accepted child normally and keeps the authored state as its display', () => {
    expect(progress.get('e2')).toMatchObject({ display: 'accepted', hasStoppedWork: true, counts: { done: 1, stopped: 1, total: 2 } });
  });

  it('calls a node with nothing owed empty — never done — and a parent of only empty children empty', () => {
    for (const id of ['e4', 'p2', 'g2']) expect(progress.get(id)).toMatchObject({ display: 'empty', counts: { total: 0 } });
  });

  it('reads all-done work as awaiting acceptance and untouched work as not started, at every level', () => {
    for (const id of ['e5', 'p3', 'g3']) expect(progress.get(id)?.display).toBe('awaiting_acceptance');
    for (const id of ['e6', 'p4', 'g4']) expect(progress.get(id)?.display).toBe('not_started');
  });

  it('counts an Unassigned task in no node', () => {
    const everyTotal = [...progress.entries()]
      .filter(([id]) => id.startsWith('g'))
      .reduce((sum, [, node]) => sum + node.counts.total + node.counts.cancelled + node.counts.superseded, 0);
    // g1: 7 + 1 + 1, g3: 1, g4: 1 — u1 is nowhere.
    expect(everyTotal).toBe(11);
  });
});
