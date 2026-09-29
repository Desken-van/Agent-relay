import { describe, expect, it } from 'vitest';
import { AgentRelayError } from '../../src/shared/domain/errors';
import {
  countsTowardProgress,
  isRoadmapNodeClosed,
  ROADMAP_LIMITS,
  ROADMAP_NODE_EVENTS,
  ROADMAP_NODE_STATES,
  ROADMAP_NODE_TRANSITIONS,
  ROADMAP_PARENT_KIND,
  roadmapDependencySchema,
  roadmapItemKey,
  roadmapNodeSchema,
  roadmapTaskFactSchema,
  roadmapTaskLocation,
  roadmapTaskPlacementSchema,
  TASK_PROGRESS_KINDS,
  TASK_STATUS_PROGRESS,
  taskProgressKind,
  transitionRoadmapNode
} from '../../src/shared/domain/roadmap';
import { TASK_STATUSES, TERMINAL_STATUSES } from '../../src/shared/domain/workflow';
import { dependency, nodeRef, placement, roadmapNode, taskFact, taskRef } from '../helpers/roadmap-fixtures';

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const goal = roadmapNode({ id: 'g1', kind: 'goal' });
const phase = roadmapNode({ id: 'p1', kind: 'phase', parentId: 'g1' });

describe('roadmap nodes', () => {
  it('parses a node back to exactly what was stored', () => {
    const epic = roadmapNode({
      id: 'e1',
      kind: 'epic',
      parentId: 'p1',
      position: 4,
      description: 'Line one.\n\tLine two.',
      acceptanceCriteria: [{ id: 'c1', text: 'Restart keeps the order.' }]
    });
    expect(roadmapNodeSchema.parse(epic)).toEqual(epic);
  });

  it('refuses a key it does not know, so storage cannot carry fields the model never defined', () => {
    expect(roadmapNodeSchema.safeParse({ ...goal, status: 'COMPLETED' }).success).toBe(false);
  });

  it('fixes the parent kind of every level exactly one level up', () => {
    expect(ROADMAP_PARENT_KIND).toEqual({ goal: null, phase: 'goal', epic: 'phase' });
  });

  it('requires a goal to have no parent and every other level to have one', () => {
    expect(roadmapNodeSchema.safeParse({ ...goal, parentId: 'g0' }).success).toBe(false);
    expect(roadmapNodeSchema.safeParse({ ...phase, parentId: null }).success).toBe(false);
    const orphan = roadmapNodeSchema.safeParse(roadmapNode({ id: 'e1', kind: 'epic', parentId: null }));
    expect(orphan.error?.issues.map((issue) => issue.message)).toEqual(['The parent of an epic must be a phase.']);
  });

  it('refuses a node that names itself as its parent', () => {
    expect(roadmapNodeSchema.safeParse({ ...phase, parentId: 'p1' }).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['leading whitespace', ' Title'],
    ['trailing newline', 'Title\n'],
    ['a control character', 'Ti\u0007tle'],
    ['a C1 control character', 'Ti\u0085tle'],
    ['more than the limit', 'x'.repeat(ROADMAP_LIMITS.titleLength + 1)]
  ])('refuses a title with %s rather than rewriting it', (_label, title) => {
    expect(roadmapNodeSchema.safeParse({ ...goal, title }).success).toBe(false);
  });

  it('accepts a title at exactly the limit', () => {
    expect(roadmapNodeSchema.safeParse({ ...goal, title: 'x'.repeat(ROADMAP_LIMITS.titleLength) }).success).toBe(true);
  });

  it('lets a description break lines but not carry other control characters', () => {
    expect(roadmapNodeSchema.safeParse({ ...goal, description: 'a\r\nb\tc' }).success).toBe(true);
    expect(roadmapNodeSchema.safeParse({ ...goal, description: 'a\u0000b' }).success).toBe(false);
    expect(
      roadmapNodeSchema.safeParse({ ...goal, description: 'x'.repeat(ROADMAP_LIMITS.descriptionLength) }).success
    ).toBe(true);
    expect(
      roadmapNodeSchema.safeParse({ ...goal, description: 'x'.repeat(ROADMAP_LIMITS.descriptionLength + 1) }).success
    ).toBe(false);
  });

  it('identifies acceptance criteria by id and refuses a repeated one', () => {
    const repeated = roadmapNodeSchema.safeParse({
      ...goal,
      acceptanceCriteria: [
        { id: 'c1', text: 'First.' },
        { id: 'c1', text: 'Second.' }
      ]
    });
    expect(repeated.success).toBe(false);
    expect(repeated.error?.issues.map((issue) => issue.path)).toEqual([['acceptanceCriteria', 1, 'id']]);
  });

  it('bounds the criteria count and keeps each criterion to one line', () => {
    const criteria = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `c${index}`, text: `Criterion ${index}.` }));
    const limit = ROADMAP_LIMITS.acceptanceCriteriaPerNode;
    expect(roadmapNodeSchema.safeParse({ ...goal, acceptanceCriteria: criteria(limit) }).success).toBe(true);
    expect(roadmapNodeSchema.safeParse({ ...goal, acceptanceCriteria: criteria(limit + 1) }).success).toBe(false);
    expect(
      roadmapNodeSchema.safeParse({ ...goal, acceptanceCriteria: [{ id: 'c1', text: 'One.\nTwo.' }] }).success
    ).toBe(false);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses position %s', (position) => {
    expect(roadmapNodeSchema.safeParse({ ...goal, position }).success).toBe(false);
  });

  it('refuses a state outside the authored vocabulary, including every workflow status', () => {
    for (const state of ['done', 'in_progress', ...TASK_STATUSES]) {
      expect(roadmapNodeSchema.safeParse({ ...goal, state }).success).toBe(false);
    }
  });
});

describe('roadmap node state', () => {
  const legal: Record<string, string> = {
    'open/accept': 'accepted',
    'open/cancel': 'cancelled',
    'accepted/reopen': 'open',
    'cancelled/reopen': 'open'
  };

  it('allows exactly the listed moves and refuses every other one as an invalid transition', () => {
    for (const state of ROADMAP_NODE_STATES) {
      for (const event of ROADMAP_NODE_EVENTS) {
        const expected = legal[`${state}/${event}`];
        if (expected === undefined) {
          const error = thrown(() => transitionRoadmapNode(state, event));
          expect(error, `${state}/${event}`).toBeInstanceOf(AgentRelayError);
          expect(error).toMatchObject({ code: 'INVALID_TRANSITION', details: `from=${state} event=${event}` });
        } else {
          expect(transitionRoadmapNode(state, event)).toBe(expected);
        }
      }
    }
    expect(Object.values(ROADMAP_NODE_TRANSITIONS).flatMap((moves) => Object.keys(moves))).toHaveLength(4);
  });

  it('treats accepted and cancelled as closed and open as the only open state', () => {
    expect(ROADMAP_NODE_STATES.filter(isRoadmapNodeClosed)).toEqual(['accepted', 'cancelled']);
  });
});

describe('task placements and locations', () => {
  it('always names an epic: there is no placement meaning "unassigned"', () => {
    expect(roadmapTaskPlacementSchema.safeParse(placement('t1', 'e1', 0)).success).toBe(true);
    expect(roadmapTaskPlacementSchema.safeParse({ ...placement('t1', 'e1', 0), epicId: null }).success).toBe(false);
    expect(roadmapTaskPlacementSchema.safeParse({ ...placement('t1', 'e1', 0), status: 'DRAFT' }).success).toBe(false);
  });

  it('reads a task without a placement as unassigned and a placed task as sitting in its epic', () => {
    const placements = [placement('t1', 'e1', 3)];
    expect(roadmapTaskLocation('t1', placements)).toEqual({ kind: 'epic', epicId: 'e1', position: 3 });
    expect(roadmapTaskLocation('t2', placements)).toEqual({ kind: 'unassigned' });
    expect(roadmapTaskLocation('t1', [])).toEqual({ kind: 'unassigned' });
  });
});

describe('roadmap dependencies', () => {
  it('accepts any level or a task on either end', () => {
    for (const [dependent, prerequisite] of [
      [nodeRef('e1'), nodeRef('e2')],
      [taskRef('t1'), nodeRef('g1')],
      [nodeRef('p1'), taskRef('t1')],
      [taskRef('t1'), taskRef('t2')]
    ] as const) {
      expect(roadmapDependencySchema.safeParse(dependency('d1', dependent, prerequisite)).success).toBe(true);
    }
  });

  it('refuses an item depending on itself', () => {
    expect(roadmapDependencySchema.safeParse(dependency('d1', nodeRef('e1'), nodeRef('e1'))).success).toBe(false);
    expect(roadmapDependencySchema.safeParse(dependency('d1', taskRef('t1'), taskRef('t1'))).success).toBe(false);
  });

  it('never confuses a node and a task that happen to share an id', () => {
    expect(roadmapItemKey(nodeRef('x'))).not.toBe(roadmapItemKey(taskRef('x')));
    expect(roadmapDependencySchema.safeParse(dependency('d1', nodeRef('x'), taskRef('x'))).success).toBe(true);
  });

  it('refuses a reference whose fields do not match its kind', () => {
    const mixed = { ...dependency('d1', nodeRef('e1'), nodeRef('e2')), prerequisite: { kind: 'node', taskId: 't1' } };
    expect(roadmapDependencySchema.safeParse(mixed).success).toBe(false);
  });
});

describe('progress inputs', () => {
  it('maps every workflow status, and nothing else', () => {
    expect(Object.keys(TASK_STATUS_PROGRESS).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('agrees with the workflow on which statuses are terminal', () => {
    for (const status of TASK_STATUSES) {
      const terminalKind = ['done', 'stopped', 'cancelled'].includes(TASK_STATUS_PROGRESS[status]);
      expect(terminalKind, status).toBe(TERMINAL_STATUSES.includes(status));
    }
  });

  it('calls only DRAFT not started and only COMPLETED done', () => {
    const having = (kind: string) => TASK_STATUSES.filter((status) => TASK_STATUS_PROGRESS[status] === kind);
    expect(having('not_started')).toEqual(['DRAFT']);
    expect(having('done')).toEqual(['COMPLETED']);
    expect(having('cancelled')).toEqual(['CANCELLED']);
    // Exactly the statuses a continuation may start from (continuation-service).
    expect(having('stopped').sort()).toEqual(['FAILED', 'REVIEW_BLOCKED', 'REVIEW_LIMIT_REACHED']);
  });

  it('marks a stopped task superseded only once a continuation carries its work', () => {
    expect(taskProgressKind(taskFact('t1', 'REVIEW_LIMIT_REACHED'))).toBe('stopped');
    expect(taskProgressKind(taskFact('t1', 'REVIEW_LIMIT_REACHED', 't2'))).toBe('superseded');
    expect(taskProgressKind(taskFact('t1', 'FAILED', 't2'))).toBe('superseded');
    expect(taskProgressKind(taskFact('t1', 'COMPLETED', 't2'))).toBe('done');
    expect(taskProgressKind(taskFact('t1', 'CANCELLED', 't2'))).toBe('cancelled');
    expect(taskProgressKind(taskFact('t1', 'IMPLEMENTING', 't2'))).toBe('in_progress');
  });

  it('leaves only cancelled and superseded work out of a progress total', () => {
    expect(TASK_PROGRESS_KINDS.filter((kind) => !countsTowardProgress(kind))).toEqual(['superseded', 'cancelled']);
  });

  it('reads task facts strictly, with the workflow status vocabulary', () => {
    expect(roadmapTaskFactSchema.safeParse(taskFact('t1', 'DRAFT')).success).toBe(true);
    expect(roadmapTaskFactSchema.safeParse({ ...taskFact('t1', 'DRAFT'), status: 'DONE' }).success).toBe(false);
    expect(roadmapTaskFactSchema.safeParse({ ...taskFact('t1', 'DRAFT'), epicId: 'e1' }).success).toBe(false);
  });
});
