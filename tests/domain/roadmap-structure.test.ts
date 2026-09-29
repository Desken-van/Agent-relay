import { describe, expect, it } from 'vitest';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { ROADMAP_LIMITS } from '../../src/shared/domain/roadmap';
import {
  parseRoadmapSnapshot,
  roadmapSnapshotSchema,
  roadmapStructureViolations,
  type RoadmapSnapshotInput,
  type RoadmapViolationCode
} from '../../src/shared/domain/roadmap-structure';
import {
  dependency,
  nodeRef,
  OTHER_PROJECT,
  placement,
  roadmapNode,
  taskFact,
  taskRef,
  validSnapshot
} from '../helpers/roadmap-fixtures';

type Snapshot = ReturnType<typeof validSnapshot>;

/** The valid fixture with one section replaced — never mutated in place. */
function withSnapshot(change: (base: Snapshot) => Partial<RoadmapSnapshotInput>): Snapshot {
  const base = validSnapshot();
  return { ...base, ...change(base) };
}

function codesOf(snapshot: RoadmapSnapshotInput): RoadmapViolationCode[] {
  return roadmapStructureViolations(snapshot).map((violation) => violation.code);
}

function only(snapshot: RoadmapSnapshotInput): { code: RoadmapViolationCode; path: readonly (string | number)[] } {
  const violations = roadmapStructureViolations(snapshot);
  expect(violations).toHaveLength(1);
  const [first] = violations;
  if (first === undefined) throw new Error('unreachable');
  return { code: first.code, path: first.path };
}

describe('a valid roadmap', () => {
  it('has no violations, and parses through the snapshot boundary unchanged', () => {
    const snapshot = validSnapshot();
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
    expect(parseRoadmapSnapshot(snapshot)).toEqual(snapshot);
  });

  it('allows an empty roadmap: a project whose tasks are all unassigned', () => {
    const snapshot = withSnapshot(() => ({ nodes: [], placements: [], dependencies: [] }));
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
  });

  it('allows the same position in different sibling groups', () => {
    const snapshot = validSnapshot();
    // g1/p1/e1 and g2/p3/e3 all sit at position 0 of their own groups, as do t1 and t6.
    expect(snapshot.nodes.filter((node) => node.position === 0).length).toBeGreaterThan(3);
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
  });
});

describe('ownership: one project throughout', () => {
  it('refuses a node, placement, dependency or task fact from another project', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'g2' ? { ...node, projectId: OTHER_PROJECT } : node)),
      placements: base.placements.map((row) => (row.taskId === 't1' ? { ...row, projectId: OTHER_PROJECT } : row)),
      dependencies: base.dependencies.map((row) => (row.id === 'd1' ? { ...row, projectId: OTHER_PROJECT } : row)),
      tasks: base.tasks.map((task) => (task.id === 't5' ? { ...task, projectId: OTHER_PROJECT } : task))
    }));
    expect(roadmapStructureViolations(snapshot).map((violation) => [violation.code, violation.path])).toEqual([
      ['project_mismatch', ['nodes', 1, 'projectId']],
      ['project_mismatch', ['placements', 0, 'projectId']],
      ['project_mismatch', ['dependencies', 0, 'projectId']],
      ['project_mismatch', ['tasks', 4, 'projectId']]
    ]);
  });
});

describe('identity', () => {
  it('refuses a repeated node id, dependency id or task fact', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: [...base.nodes, roadmapNode({ id: 'g1', kind: 'goal', position: 9 })],
      dependencies: [...base.dependencies, dependency('d1', taskRef('t1'), taskRef('t2'))],
      tasks: [...base.tasks, taskFact('t1', 'DRAFT')]
    }));
    expect(codesOf(snapshot)).toEqual(['duplicate_id', 'duplicate_id', 'duplicate_id']);
  });

  it('refuses placing one task twice, even in different epics', () => {
    const snapshot = withSnapshot((base) => ({ placements: [...base.placements, placement('t1', 'e3', 5)] }));
    expect(only(snapshot)).toEqual({ code: 'duplicate_id', path: ['placements', 6, 'taskId'] });
  });
});

describe('parents', () => {
  it('refuses a phase or epic whose parent does not exist', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: [...base.nodes, roadmapNode({ id: 'p9', kind: 'phase', parentId: 'missing', position: 0 })]
    }));
    expect(only(snapshot)).toEqual({ code: 'unknown_parent', path: ['nodes', 8, 'parentId'] });
  });

  it('refuses a parent of the wrong kind: an epic under a goal, a phase under a phase, an epic under an epic', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: [
        ...base.nodes,
        roadmapNode({ id: 'x1', kind: 'epic', parentId: 'g1', position: 5 }),
        roadmapNode({ id: 'x2', kind: 'phase', parentId: 'p1', position: 5 }),
        roadmapNode({ id: 'x3', kind: 'epic', parentId: 'e1', position: 5 })
      ]
    }));
    expect(roadmapStructureViolations(snapshot).map((violation) => [violation.code, violation.message])).toEqual([
      ['parent_kind_mismatch', 'The parent of an epic must be a phase, not a goal.'],
      ['parent_kind_mismatch', 'The parent of a phase must be a goal, not a phase.'],
      ['parent_kind_mismatch', 'The parent of an epic must be a phase, not an epic.']
    ]);
  });

  it('refuses a goal with a parent even when the per-record check was bypassed', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'g2' ? { ...node, parentId: 'g1', position: 9 } : node)),
      // d4 (g2 on g1) would now also be a containment edge; this test is about the parent alone.
      dependencies: base.dependencies.filter((row) => row.id !== 'd4')
    }));
    expect(only(snapshot)).toEqual({ code: 'parent_kind_mismatch', path: ['nodes', 1, 'parentId'] });
  });

  it('terminates on a malformed parent loop and reports it, even with a dependency across the loop', () => {
    const snapshot = withSnapshot(() => ({
      nodes: [
        roadmapNode({ id: 'a', kind: 'phase', parentId: 'b', position: 0 }),
        roadmapNode({ id: 'b', kind: 'phase', parentId: 'a', position: 0 })
      ],
      placements: [],
      dependencies: [dependency('d1', nodeRef('a'), nodeRef('b'))]
    }));
    const codes = codesOf(snapshot);
    expect(codes.filter((code) => code === 'parent_kind_mismatch')).toHaveLength(2);
  });
});

describe('order', () => {
  it('refuses two goals, two children of one parent, or two tasks of one epic at the same position', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: [
        ...base.nodes,
        roadmapNode({ id: 'g3', kind: 'goal', position: 1 }),
        roadmapNode({ id: 'e4', kind: 'epic', parentId: 'p1', position: 0 })
      ],
      placements: [...base.placements, placement('t5', 'e1', 1)]
    }));
    expect(roadmapStructureViolations(snapshot).map((violation) => [violation.code, violation.path])).toEqual([
      ['duplicate_position', ['nodes', 8, 'position']],
      ['duplicate_position', ['nodes', 9, 'position']],
      ['duplicate_position', ['placements', 6, 'position']]
    ]);
  });
});

describe('placements', () => {
  it('refuses a placement of a task the project does not have', () => {
    const snapshot = withSnapshot((base) => ({ placements: [...base.placements, placement('ghost', 'e1', 7)] }));
    expect(only(snapshot)).toEqual({ code: 'unknown_task', path: ['placements', 6, 'taskId'] });
  });

  it('refuses a placement under a missing node, and under a goal or a phase', () => {
    const snapshot = withSnapshot((base) => ({
      placements: [...base.placements, placement('t5', 'gone', 0)]
    }));
    expect(only(snapshot)).toEqual({ code: 'unknown_node', path: ['placements', 6, 'epicId'] });
    for (const target of ['g1', 'p1']) {
      const misplaced = withSnapshot((base) => ({ placements: [...base.placements, placement('t5', target, 0)] }));
      expect(only(misplaced)).toEqual({ code: 'placement_not_epic', path: ['placements', 6, 'epicId'] });
    }
  });
});

describe('dependencies', () => {
  const adding = (...added: ReturnType<typeof dependency>[]) =>
    withSnapshot((base) => ({ dependencies: [...base.dependencies, ...added] }));

  it('refuses an endpoint that does not exist, naming which end', () => {
    expect(only(adding(dependency('d9', nodeRef('nowhere'), nodeRef('e1'))))).toEqual({
      code: 'unknown_node',
      path: ['dependencies', 4, 'dependent']
    });
    expect(only(adding(dependency('d9', taskRef('t1'), taskRef('ghost'))))).toEqual({
      code: 'unknown_task',
      path: ['dependencies', 4, 'prerequisite']
    });
  });

  it('refuses an item depending on itself', () => {
    expect(only(adding(dependency('d9', taskRef('t2'), taskRef('t2'))))).toEqual({
      code: 'self_dependency',
      path: ['dependencies', 4, 'prerequisite']
    });
  });

  it('refuses the same edge twice under different ids, but not the reverse edge', () => {
    expect(only(adding(dependency('d9', nodeRef('e1'), nodeRef('e2'))))).toEqual({
      code: 'duplicate_dependency',
      path: ['dependencies', 4, 'prerequisite']
    });
    // e2 → e1 reverses d1: a cycle, which the services detect; structurally it is a distinct edge.
    expect(codesOf(adding(dependency('d9', nodeRef('e2'), nodeRef('e1'))))).toEqual([]);
  });

  it.each([
    ['an epic on its own goal', nodeRef('e1'), nodeRef('g1')],
    ['a goal on its own epic', nodeRef('g1'), nodeRef('e1')],
    ['a phase on its own epic', nodeRef('p1'), nodeRef('e2')],
    ['a placed task on its own epic', taskRef('t1'), nodeRef('e1')],
    ['a placed task on its own goal', taskRef('t1'), nodeRef('g1')],
    ['a goal on a task beneath it', nodeRef('g2'), taskRef('t6')]
  ])('refuses %s: containment already relates them', (_label, dependent, prerequisite) => {
    expect(only(adding(dependency('d9', dependent, prerequisite)))).toEqual({
      code: 'containment_dependency',
      path: ['dependencies', 4, 'prerequisite']
    });
  });

  it.each([
    ['sibling epics', nodeRef('e2'), nodeRef('e1')],
    ['epics in different goals', nodeRef('e2'), nodeRef('e3')],
    ['a task on an epic in another goal', taskRef('t1'), nodeRef('e3')],
    ['an unassigned task on any node', taskRef('t5'), nodeRef('g1')],
    ['a node on an unassigned task', nodeRef('g1'), taskRef('t5')],
    ['two tasks of the same epic', taskRef('t2'), taskRef('t1')]
  ])('allows %s', (_label, dependent, prerequisite) => {
    expect(codesOf(adding(dependency('d9', dependent, prerequisite)))).toEqual([]);
  });
});

describe('closed nodes', () => {
  it('refuses an open child under an accepted or cancelled parent', () => {
    const acceptedGoal = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'g2' ? { ...node, state: 'accepted' as const } : node))
    }));
    // p3 is open under the accepted g2, and e3 (open) is fine under the still-open p3.
    expect(only(acceptedGoal)).toEqual({ code: 'closed_node_open_child', path: ['nodes', 4, 'state'] });

    const underCancelled = withSnapshot((base) => ({
      nodes: [...base.nodes, roadmapNode({ id: 'e9', kind: 'epic', parentId: 'p2', position: 0 })]
    }));
    expect(only(underCancelled)).toEqual({ code: 'closed_node_open_child', path: ['nodes', 8, 'state'] });
  });

  it('allows closed children under a closed parent', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: base.nodes.map((node) =>
        node.id === 'p1' ? { ...node, state: 'accepted' as const }
          : node.id === 'e1' ? { ...node, state: 'cancelled' as const }
            : node
      ),
      tasks: base.tasks.map((task) =>
        task.id === 't1' || task.id === 't2' ? { ...task, status: 'CANCELLED' as const } : task
      )
    }));
    // p1 accepted over the accepted e2 and the cancelled e1, whose tasks are all terminal.
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
  });

  it('allows an open parent with closed children: a reopened parent keeps them as they are', () => {
    const snapshot = validSnapshot();
    // g1 is open over the cancelled p2, and p1 is open over the accepted e2.
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
  });

  it('refuses a closed epic holding a task that is not terminal', () => {
    for (const state of ['accepted', 'cancelled'] as const) {
      const snapshot = withSnapshot((base) => ({
        nodes: base.nodes.map((node) => (node.id === 'e1' ? { ...node, state } : node))
      }));
      expect(roadmapStructureViolations(snapshot).map((violation) => [violation.code, violation.path])).toEqual([
        ['closed_node_active_task', ['placements', 0, 'taskId']],
        ['closed_node_active_task', ['placements', 1, 'taskId']]
      ]);
    }
  });

  it('allows a closed epic whose tasks are all terminal, whatever their outcome', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'e3' ? { ...node, state: 'cancelled' as const } : node)),
      tasks: base.tasks.map((task) => (task.id === 't7' ? { ...task, status: 'FAILED' as const } : task))
    }));
    expect(roadmapStructureViolations(snapshot)).toEqual([]);
  });
});

describe('the snapshot boundary', () => {
  it('reports violations section by section, in snapshot order, identically on every call', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: [...base.nodes, roadmapNode({ id: 'e9', kind: 'epic', parentId: 'g1', position: 7 })],
      placements: [...base.placements, placement('ghost', 'e1', 9)],
      dependencies: [...base.dependencies, dependency('d9', taskRef('t2'), taskRef('t2'))],
      tasks: [...base.tasks, { ...taskFact('tz', 'DRAFT'), projectId: OTHER_PROJECT }]
    }));
    const first = roadmapStructureViolations(snapshot);
    expect(first.map((violation) => violation.code)).toEqual([
      'project_mismatch',
      'parent_kind_mismatch',
      'unknown_task',
      'self_dependency'
    ]);
    expect(roadmapStructureViolations(snapshot)).toEqual(first);
  });

  it('turns every structural violation into a schema issue carrying its code', () => {
    const snapshot = withSnapshot((base) => ({ placements: [...base.placements, placement('t5', 'p1', 0)] }));
    const parsed = roadmapSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ['placements', 6, 'epicId'],
        params: { roadmapViolation: 'placement_not_epic' }
      })
    ]);
  });

  it('throws a validation error quoting the first issues and counting the rest', () => {
    const extraGoals = Array.from({ length: 12 }, (_, index) =>
      roadmapNode({ id: `dup${index}`, kind: 'goal', position: 0 })
    );
    const snapshot = withSnapshot((base) => ({ nodes: [...base.nodes, ...extraGoals] }));
    let caught: unknown;
    try {
      parseRoadmapSnapshot(snapshot);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRelayError);
    expect(caught).toMatchObject({ code: 'VALIDATION_FAILED' });
    const details = caught instanceof AgentRelayError ? (caught.details ?? '') : '';
    expect(details.split('\n')).toHaveLength(11);
    expect(details).toContain('nodes.8.position: Another sibling already has this position.');
    expect(details).toContain('…and 2 more.');
  });

  it('reports a rule the record already checks once, while the function alone still reports it', () => {
    const snapshot = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'g2' ? { ...node, parentId: 'g1', position: 9 } : node)),
      dependencies: [
        ...base.dependencies.filter((row) => row.id !== 'd4'),
        dependency('d9', taskRef('t2'), taskRef('t2'))
      ]
    }));
    expect(codesOf(snapshot)).toEqual(['parent_kind_mismatch', 'self_dependency']);
    const issues = roadmapSnapshotSchema.safeParse(snapshot).error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['nodes.1.parentId', 'dependencies.3.prerequisite']);
  });

  it('refuses records that fail their own schema and unknown keys', () => {
    expect(roadmapSnapshotSchema.safeParse({ ...validSnapshot(), revision: -1 }).success).toBe(false);
    expect(roadmapSnapshotSchema.safeParse({ ...validSnapshot(), unassigned: [] }).success).toBe(false);
    const badTitle = withSnapshot((base) => ({
      nodes: base.nodes.map((node) => (node.id === 'g1' ? { ...node, title: '' } : node))
    }));
    expect(roadmapSnapshotSchema.safeParse(badTitle).success).toBe(false);
  });

  it('refuses more nodes or dependencies than a project may hold, on the limit itself', () => {
    const tooManyNodes = withSnapshot(() => ({
      nodes: Array.from({ length: ROADMAP_LIMITS.nodesPerProject + 1 }, (_, index) =>
        roadmapNode({ id: `g${index}`, kind: 'goal', position: index })
      ),
      placements: [],
      dependencies: []
    }));
    expect(roadmapSnapshotSchema.safeParse(tooManyNodes).error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['nodes'] })
    ]);
    // Edges to nodes that do not exist: each is also unknown_node, so look for the size issue itself.
    const sizeIssues = (count: number) => {
      const edges = Array.from({ length: count }, (_, index) =>
        dependency(`d${index}`, taskRef('t5'), nodeRef(`n${index}`))
      );
      const issues = roadmapSnapshotSchema.safeParse(withSnapshot(() => ({ dependencies: edges }))).error?.issues ?? [];
      return issues.filter((issue) => issue.code === 'too_big');
    };
    expect(sizeIssues(ROADMAP_LIMITS.dependenciesPerProject)).toEqual([]);
    expect(sizeIssues(ROADMAP_LIMITS.dependenciesPerProject + 1)).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['dependencies'] })
    ]);
  });
});
