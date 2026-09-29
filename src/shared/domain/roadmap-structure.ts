/**
 * Cross-record rules of one project's roadmap, checked over the whole snapshot.
 *
 * `roadmap.ts` checks each record alone. What no single record can show — a
 * parent that exists and has the right kind, one project throughout, siblings
 * in distinct positions, dependencies naming real items outside each other's
 * containment, closed nodes with no open work beneath them — is checked here.
 * Storage parses every read, and every write before it commits, through
 * {@link roadmapSnapshotSchema}, so a structure rejected here is never stored.
 *
 * General dependency cycles are deliberately NOT detected here: finding one is
 * a graph search over inherited dependencies and belongs to the roadmap
 * services. The two cycles visible without a search are: an item depending on
 * itself, and an item depending on its own ancestor or descendant.
 */

import { z } from 'zod';
import { AgentRelayError } from './errors';
import { idSchema } from './models';
import {
  isRoadmapNodeClosed,
  ROADMAP_KIND_NOUN,
  ROADMAP_LIMITS,
  ROADMAP_PARENT_KIND,
  roadmapDependencySchema,
  roadmapItemKey,
  roadmapNodeSchema,
  roadmapTaskFactSchema,
  roadmapTaskPlacementSchema,
  type RoadmapDependency,
  type RoadmapItemRef,
  type RoadmapNode,
  type RoadmapTaskFact,
  type RoadmapTaskPlacement
} from './roadmap';
import { isTerminal } from './workflow';

export const ROADMAP_VIOLATION_CODES = [
  'project_mismatch',
  'duplicate_id',
  'unknown_parent',
  'parent_kind_mismatch',
  'duplicate_position',
  'unknown_node',
  'unknown_task',
  'placement_not_epic',
  'self_dependency',
  'duplicate_dependency',
  'containment_dependency',
  'closed_node_open_child',
  'closed_node_active_task'
] as const;
export type RoadmapViolationCode = (typeof ROADMAP_VIOLATION_CODES)[number];

export interface RoadmapViolation {
  readonly code: RoadmapViolationCode;
  readonly message: string;
  /** Where in the snapshot, e.g. `['nodes', 3, 'parentId']`. */
  readonly path: readonly (string | number)[];
}

/** One project's roadmap together with the task facts it is checked against. */
export interface RoadmapSnapshotInput {
  readonly projectId: string;
  readonly nodes: readonly RoadmapNode[];
  readonly placements: readonly RoadmapTaskPlacement[];
  readonly dependencies: readonly RoadmapDependency[];
  /** Every task of the project, read from the workflow. The roadmap stores none of this. */
  readonly tasks: readonly RoadmapTaskFact[];
}

/**
 * Every structural rule the snapshot breaks, section by section in the order
 * the snapshot lists its records — the same input always yields the same list.
 */
export function roadmapStructureViolations(snapshot: RoadmapSnapshotInput): RoadmapViolation[] {
  const index = indexSnapshot(snapshot);
  return [
    ...ownershipViolations(snapshot),
    ...identityViolations(snapshot),
    ...parentViolations(snapshot, index),
    ...positionViolations(snapshot),
    ...placementViolations(snapshot, index),
    ...dependencyViolations(snapshot, index),
    ...closureViolations(snapshot, index)
  ];
}

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

interface SnapshotIndex {
  readonly nodes: ReadonlyMap<string, RoadmapNode>;
  readonly tasks: ReadonlyMap<string, RoadmapTaskFact>;
  readonly placements: ReadonlyMap<string, RoadmapTaskPlacement>;
}

/** First occurrence wins; a repeated id is reported by {@link identityViolations}. */
function firstBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(key(item))) map.set(key(item), item);
  }
  return map;
}

function indexSnapshot(snapshot: RoadmapSnapshotInput): SnapshotIndex {
  return {
    nodes: firstBy(snapshot.nodes, (node) => node.id),
    tasks: firstBy(snapshot.tasks, (task) => task.id),
    placements: firstBy(snapshot.placements, (placement) => placement.taskId)
  };
}

/** Indexes of every item whose key was already used by an earlier item. */
function repeatedIndexes<T>(items: readonly T[], key: (item: T) => string): number[] {
  const seen = new Set<string>();
  return items.flatMap((item, position) => {
    const value = key(item);
    if (seen.has(value)) return [position];
    seen.add(value);
    return [];
  });
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

function ownershipViolations(snapshot: RoadmapSnapshotInput): RoadmapViolation[] {
  const sections: readonly (readonly [string, readonly { readonly projectId: string }[]])[] = [
    ['nodes', snapshot.nodes],
    ['placements', snapshot.placements],
    ['dependencies', snapshot.dependencies],
    ['tasks', snapshot.tasks]
  ];
  return sections.flatMap(([section, items]) =>
    items.flatMap((item, position) =>
      item.projectId === snapshot.projectId
        ? []
        : [violation('project_mismatch', [section, position, 'projectId'],
            `Belongs to project ${item.projectId}, not ${snapshot.projectId}; a roadmap never spans projects.`)]
    )
  );
}

function identityViolations(snapshot: RoadmapSnapshotInput): RoadmapViolation[] {
  const duplicates = (section: string, field: string, positions: number[], what: string) =>
    positions.map((position) => violation('duplicate_id', [section, position, field], `${what} appears twice.`));
  return [
    ...duplicates('nodes', 'id', repeatedIndexes(snapshot.nodes, (node) => node.id), 'This node id'),
    ...duplicates('placements', 'taskId', repeatedIndexes(snapshot.placements, (placement) => placement.taskId),
      'A task may be placed only once; this task'),
    ...duplicates('dependencies', 'id', repeatedIndexes(snapshot.dependencies, (dependency) => dependency.id),
      'This dependency id'),
    ...duplicates('tasks', 'id', repeatedIndexes(snapshot.tasks, (task) => task.id), 'This task')
  ];
}

function parentViolations(snapshot: RoadmapSnapshotInput, index: SnapshotIndex): RoadmapViolation[] {
  return snapshot.nodes.flatMap((node, position): RoadmapViolation[] => {
    const path = ['nodes', position, 'parentId'];
    const expected = ROADMAP_PARENT_KIND[node.kind];
    if (expected === null) {
      return node.parentId === null ? [] : [violation('parent_kind_mismatch', path, 'A goal has no parent.')];
    }
    const parent = node.parentId === null ? undefined : index.nodes.get(node.parentId);
    if (parent === undefined) {
      return [violation('unknown_parent', path,
        `The parent of ${ROADMAP_KIND_NOUN[node.kind]} must be an existing ${expected}.`)];
    }
    return parent.kind === expected
      ? []
      : [violation('parent_kind_mismatch', path,
          `The parent of ${ROADMAP_KIND_NOUN[node.kind]} must be ${ROADMAP_KIND_NOUN[expected]}, ` +
          `not ${ROADMAP_KIND_NOUN[parent.kind]}.`)];
  });
}

function positionViolations(snapshot: RoadmapSnapshotInput): RoadmapViolation[] {
  const clash = (section: string, positions: number[]) =>
    positions.map((position) =>
      violation('duplicate_position', [section, position, 'position'], 'Another sibling already has this position.')
    );
  // A goal's sibling group is the project's goals: parent `null`, which no id can spell.
  return [
    ...clash('nodes', repeatedIndexes(snapshot.nodes, (node) => JSON.stringify([node.parentId, node.position]))),
    ...clash('placements', repeatedIndexes(snapshot.placements, (placement) =>
      JSON.stringify([placement.epicId, placement.position])))
  ];
}

function placementViolations(snapshot: RoadmapSnapshotInput, index: SnapshotIndex): RoadmapViolation[] {
  return snapshot.placements.flatMap((placement, position): RoadmapViolation[] => {
    const found: RoadmapViolation[] = index.tasks.has(placement.taskId)
      ? []
      : [violation('unknown_task', ['placements', position, 'taskId'], 'The placed task is not a task of this project.')];
    const epic = index.nodes.get(placement.epicId);
    if (epic === undefined) {
      return [...found, violation('unknown_node', ['placements', position, 'epicId'], 'The placement names no existing epic.')];
    }
    return epic.kind === 'epic'
      ? found
      : [...found, violation('placement_not_epic', ['placements', position, 'epicId'],
          `A task can be placed only under an epic, not under ${ROADMAP_KIND_NOUN[epic.kind]}.`)];
  });
}

function dependencyViolations(snapshot: RoadmapSnapshotInput, index: SnapshotIndex): RoadmapViolation[] {
  const seenPairs = new Set<string>();
  return snapshot.dependencies.flatMap((dependency, position): RoadmapViolation[] => {
    const at = (field: string) => ['dependencies', position, field];
    const missing = (['dependent', 'prerequisite'] as const).flatMap((end) =>
      refExists(dependency[end], index) ? [] : [unknownRef(dependency[end], at(end))]
    );
    const pair = JSON.stringify([roadmapItemKey(dependency.dependent), roadmapItemKey(dependency.prerequisite)]);
    const repeated = seenPairs.has(pair);
    seenPairs.add(pair);
    if (roadmapItemKey(dependency.dependent) === roadmapItemKey(dependency.prerequisite)) {
      return [...missing, violation('self_dependency', at('prerequisite'), 'An item cannot depend on itself.')];
    }
    if (repeated) {
      return [...missing, violation('duplicate_dependency', at('prerequisite'), 'This dependency is already recorded.')];
    }
    if (missing.length === 0 && containsEachOther(dependency, index)) {
      return [violation('containment_dependency', at('prerequisite'),
        'An item cannot depend on its own ancestor or descendant; containment already relates them.')];
    }
    return missing;
  });
}

function closureViolations(snapshot: RoadmapSnapshotInput, index: SnapshotIndex): RoadmapViolation[] {
  const openChildren = snapshot.nodes.flatMap((node, position): RoadmapViolation[] => {
    const parent = node.parentId === null ? undefined : index.nodes.get(node.parentId);
    return parent !== undefined && isRoadmapNodeClosed(parent.state) && node.state === 'open'
      ? [violation('closed_node_open_child', ['nodes', position, 'state'],
          `An open child cannot sit under ${ROADMAP_KIND_NOUN[parent.kind]} that is ${parent.state}.`)]
      : [];
  });
  const activeTasks = snapshot.placements.flatMap((placement, position): RoadmapViolation[] => {
    const epic = index.nodes.get(placement.epicId);
    const task = index.tasks.get(placement.taskId);
    return epic !== undefined && task !== undefined && isRoadmapNodeClosed(epic.state) && !isTerminal(task.status)
      ? [violation('closed_node_active_task', ['placements', position, 'taskId'],
          `A task that is still ${task.status} cannot sit under ${ROADMAP_KIND_NOUN[epic.kind]} that is ${epic.state}.`)]
      : [];
  });
  return [...openChildren, ...activeTasks];
}

/* -------------------------------------------------------------------------- */
/* Containment                                                                 */
/* -------------------------------------------------------------------------- */

function refExists(ref: RoadmapItemRef, index: SnapshotIndex): boolean {
  return ref.kind === 'node' ? index.nodes.has(ref.nodeId) : index.tasks.has(ref.taskId);
}

function unknownRef(ref: RoadmapItemRef, path: readonly (string | number)[]): RoadmapViolation {
  return ref.kind === 'node'
    ? violation('unknown_node', path, 'The dependency names no existing node.')
    : violation('unknown_task', path, 'The dependency names no task of this project.');
}

/**
 * The node ids above an item: a node's parent chain, or a task's epic and the
 * epic's chain. Guarded against a malformed chain looping, which the parent
 * rules report on their own.
 */
function ancestorsOf(ref: RoadmapItemRef, index: SnapshotIndex): ReadonlySet<string> {
  const start = ref.kind === 'node'
    ? index.nodes.get(ref.nodeId)?.parentId ?? null
    : index.placements.get(ref.taskId)?.epicId ?? null;
  const ancestors = new Set<string>();
  let current = start;
  while (current !== null && !ancestors.has(current)) {
    ancestors.add(current);
    current = index.nodes.get(current)?.parentId ?? null;
  }
  return ancestors;
}

function containsEachOther(dependency: RoadmapDependency, index: SnapshotIndex): boolean {
  const { dependent, prerequisite } = dependency;
  return (
    (dependent.kind === 'node' && ancestorsOf(prerequisite, index).has(dependent.nodeId)) ||
    (prerequisite.kind === 'node' && ancestorsOf(dependent, index).has(prerequisite.nodeId))
  );
}

function violation(
  code: RoadmapViolationCode,
  path: readonly (string | number)[],
  message: string
): RoadmapViolation {
  return { code, path, message };
}

/* -------------------------------------------------------------------------- */
/* The boundary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One project's roadmap as storage reads it and as every write must leave it.
 *
 * `revision` is the project-wide optimistic revision: one number for the whole
 * roadmap, because a move or a reorder touches many rows and has to be checked
 * against a single value. Task facts ride along so the rules above can be
 * checked; they are read from the workflow each time and never written back.
 */
export const roadmapSnapshotSchema = z
  .object({
    projectId: idSchema,
    revision: z.number().int().nonnegative(),
    nodes: z.array(roadmapNodeSchema).max(ROADMAP_LIMITS.nodesPerProject),
    placements: z.array(roadmapTaskPlacementSchema),
    dependencies: z.array(roadmapDependencySchema).max(ROADMAP_LIMITS.dependenciesPerProject),
    tasks: z.array(roadmapTaskFactSchema)
  })
  .strict()
  .superRefine((snapshot, context) => {
    // A few structural rules restate a record's own (a goal's parent, a self-dependency) for callers
    // that use the function directly. Through the schema that record's issue already stands at the same
    // path, so it is not repeated — a duplicate would also crowd real issues out of the quoted ten.
    const reported = new Set(context.issues.map((issue) => JSON.stringify(issue.path)));
    for (const found of roadmapStructureViolations(snapshot)) {
      if (reported.has(JSON.stringify(found.path))) continue;
      context.addIssue({
        code: 'custom',
        path: [...found.path],
        message: found.message,
        params: { roadmapViolation: found.code }
      });
    }
  });
export type RoadmapSnapshot = z.infer<typeof roadmapSnapshotSchema>;

/** How many issues an integrity error quotes; the rest are counted, not listed. */
const QUOTED_ISSUES = 10;

/**
 * Parse a roadmap snapshot, refusing any record or structural violation.
 *
 * @throws {AgentRelayError} `VALIDATION_FAILED`, quoting the first issues by path.
 */
export function parseRoadmapSnapshot(input: unknown): RoadmapSnapshot {
  const parsed = roadmapSnapshotSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues;
  const quoted = issues.slice(0, QUOTED_ISSUES).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  const more = issues.length > QUOTED_ISSUES ? [`…and ${issues.length - QUOTED_ISSUES} more.`] : [];
  throw new AgentRelayError('VALIDATION_FAILED', 'The roadmap is not structurally valid.', {
    details: [...quoted, ...more].join('\n')
  });
}
