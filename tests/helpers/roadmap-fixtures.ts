import type {
  RoadmapDependency,
  RoadmapItemRef,
  RoadmapNode,
  RoadmapTaskFact,
  RoadmapTaskPlacement
} from '../../src/shared/domain/roadmap';
import type { RoadmapSnapshotInput } from '../../src/shared/domain/roadmap-structure';

export const PROJECT = 'project-1';
export const OTHER_PROJECT = 'project-2';
const AT = '2026-09-29T10:00:00.000Z';

export function roadmapNode(
  fields: Pick<RoadmapNode, 'id' | 'kind'> & Partial<RoadmapNode>
): RoadmapNode {
  return {
    projectId: PROJECT,
    parentId: null,
    title: `Node ${fields.id}`,
    description: '',
    acceptanceCriteria: [],
    position: 0,
    state: 'open',
    createdAt: AT,
    updatedAt: AT,
    ...fields
  };
}

export function placement(taskId: string, epicId: string, position: number): RoadmapTaskPlacement {
  return { taskId, projectId: PROJECT, epicId, position, createdAt: AT, updatedAt: AT };
}

export function taskFact(
  id: string,
  status: RoadmapTaskFact['status'],
  continuedByTaskId: string | null = null
): RoadmapTaskFact {
  return { id, projectId: PROJECT, status, continuedByTaskId };
}

export const nodeRef = (nodeId: string): RoadmapItemRef => ({ kind: 'node', nodeId });
export const taskRef = (taskId: string): RoadmapItemRef => ({ kind: 'task', taskId });

export function dependency(id: string, dependent: RoadmapItemRef, prerequisite: RoadmapItemRef): RoadmapDependency {
  return { id, projectId: PROJECT, dependent, prerequisite, createdAt: AT };
}

/**
 * A structurally valid roadmap exercising every level and every kind of edge:
 *
 *   g1 ─ p1 ─ e1 [t1 DRAFT, t2 IMPLEMENTING]
 *      │    └ e2 (accepted) [t3 COMPLETED, t4 CANCELLED]
 *      └ p2 (cancelled, empty)
 *   g2 ─ p3 ─ e3 [t6 REVIEW_LIMIT_REACHED → continued by t7, t7 DRAFT]
 *   Unassigned: t5 REVIEWING
 *
 * Dependencies: e1 ← e2 (siblings), t5 ← t3 (unassigned on placed), t7 ← p1
 * (across goals), g2 ← g1 (goals).
 */
export function validSnapshot(): RoadmapSnapshotInput & { readonly revision: number } {
  return {
    projectId: PROJECT,
    revision: 7,
    nodes: [
      roadmapNode({ id: 'g1', kind: 'goal', position: 0 }),
      roadmapNode({ id: 'g2', kind: 'goal', position: 1 }),
      roadmapNode({ id: 'p1', kind: 'phase', parentId: 'g1', position: 0 }),
      roadmapNode({ id: 'p2', kind: 'phase', parentId: 'g1', position: 1, state: 'cancelled' }),
      roadmapNode({ id: 'p3', kind: 'phase', parentId: 'g2', position: 0 }),
      roadmapNode({ id: 'e1', kind: 'epic', parentId: 'p1', position: 0 }),
      roadmapNode({
        id: 'e2',
        kind: 'epic',
        parentId: 'p1',
        position: 1,
        state: 'accepted',
        acceptanceCriteria: [{ id: 'c1', text: 'Every task row reads back unchanged.' }]
      }),
      roadmapNode({ id: 'e3', kind: 'epic', parentId: 'p3', position: 0 })
    ],
    placements: [
      placement('t1', 'e1', 0),
      placement('t2', 'e1', 1),
      placement('t3', 'e2', 0),
      placement('t4', 'e2', 1),
      placement('t6', 'e3', 0),
      placement('t7', 'e3', 1)
    ],
    dependencies: [
      dependency('d1', nodeRef('e1'), nodeRef('e2')),
      dependency('d2', taskRef('t5'), taskRef('t3')),
      dependency('d3', taskRef('t7'), nodeRef('p1')),
      dependency('d4', nodeRef('g2'), nodeRef('g1'))
    ],
    tasks: [
      taskFact('t1', 'DRAFT'),
      taskFact('t2', 'IMPLEMENTING'),
      taskFact('t3', 'COMPLETED'),
      taskFact('t4', 'CANCELLED'),
      taskFact('t5', 'REVIEWING'),
      taskFact('t6', 'REVIEW_LIMIT_REACHED', 't7'),
      taskFact('t7', 'DRAFT')
    ]
  };
}
