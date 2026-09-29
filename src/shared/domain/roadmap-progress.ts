/**
 * Readiness and roll-up progress (docs/roadmap.md §3 "Node progress" and §4 "Readiness").
 *
 * Both are derived on every read from the snapshot and the workflow's own task facts; nothing here is
 * stored, and nothing here changes a task. Readiness is advisory: the workflow never reads it, so a person
 * can still start any task by hand.
 *
 * Sizes stay linear in the roadmap: each dependency is judged once, and an item lists only the ids of its own
 * dependencies and the ancestors whose waits it inherits — never a copy of every inherited wait, which at the
 * documented limits would multiply thousands of tasks by thousands of edges.
 */

import { roadmapItemKey, taskProgressKind, type RoadmapItemRef, type RoadmapNode, type RoadmapTaskFact } from './roadmap';
import {
  buildWaitGraph,
  continuationResolver,
  isInert,
  type RoadmapGraphInput,
  type WaitGraph
} from './roadmap-graph';

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProgressCounts {
  readonly notStarted: number;
  readonly inProgress: number;
  readonly done: number;
  readonly stopped: number;
  /** notStarted + inProgress + done + stopped: the work owed. */
  readonly total: number;
  /** Reported for display only; never part of `total`. */
  readonly cancelled: number;
  readonly superseded: number;
}

export const NODE_DISPLAY_STATES = [
  'cancelled',
  'accepted',
  'empty',
  'awaiting_acceptance',
  'not_started',
  'in_progress'
] as const;
export type NodeDisplayState = (typeof NODE_DISPLAY_STATES)[number];

export interface NodeProgress {
  readonly counts: ProgressCounts;
  readonly display: NodeDisplayState;
  readonly hasStoppedWork: boolean;
  /** Stopped tasks counted beneath the node — what accepting it has to acknowledge. */
  readonly stoppedTaskIds: readonly string[];
}

const ZERO: ProgressCounts = { notStarted: 0, inProgress: 0, done: 0, stopped: 0, total: 0, cancelled: 0, superseded: 0 };

function add(a: ProgressCounts, b: ProgressCounts): ProgressCounts {
  return {
    notStarted: a.notStarted + b.notStarted,
    inProgress: a.inProgress + b.inProgress,
    done: a.done + b.done,
    stopped: a.stopped + b.stopped,
    total: a.total + b.total,
    cancelled: a.cancelled + b.cancelled,
    superseded: a.superseded + b.superseded
  };
}

function countTask(fact: RoadmapTaskFact): ProgressCounts {
  switch (taskProgressKind(fact)) {
    case 'not_started': return { ...ZERO, notStarted: 1, total: 1 };
    case 'in_progress': return { ...ZERO, inProgress: 1, total: 1 };
    case 'done': return { ...ZERO, done: 1, total: 1 };
    case 'stopped': return { ...ZERO, stopped: 1, total: 1 };
    case 'superseded': return { ...ZERO, superseded: 1 };
    case 'cancelled': return { ...ZERO, cancelled: 1 };
  }
}

function displayState(node: RoadmapNode, counts: ProgressCounts): NodeDisplayState {
  if (node.state === 'cancelled') return 'cancelled';
  if (node.state === 'accepted') return 'accepted';
  if (counts.total === 0) return 'empty';
  if (counts.done === counts.total) return 'awaiting_acceptance';
  if (counts.notStarted === counts.total) return 'not_started';
  return 'in_progress';
}

/**
 * Counts, not averaged percentages: an epic counts its placed tasks; a phase or goal sums its children
 * EXCEPT a cancelled child, whose subtree is shown under it and counted nowhere above it. Unassigned tasks
 * are in no node's totals.
 */
export function rollUpProgress(input: Pick<RoadmapGraphInput, 'nodes' | 'placements' | 'tasks'>): Map<string, NodeProgress> {
  const facts = new Map(input.tasks.map((fact) => [fact.id, fact]));
  const children = groupBy(input.nodes.flatMap((node) => (node.parentId === null ? [] : [[node.parentId, node] as const])));
  const placed = groupBy(input.placements.flatMap((placement) => {
    const fact = facts.get(placement.taskId);
    return fact === undefined ? [] : [[placement.epicId, fact] as const];
  }));

  const result = new Map<string, NodeProgress>();
  const visit = (node: RoadmapNode): NodeProgress => {
    const known = result.get(node.id);
    if (known !== undefined) return known;
    let counts = ZERO;
    const stoppedTaskIds: string[] = [];
    for (const fact of placed.get(node.id) ?? []) {
      counts = add(counts, countTask(fact));
      if (taskProgressKind(fact) === 'stopped') stoppedTaskIds.push(fact.id);
    }
    for (const child of children.get(node.id) ?? []) {
      const childProgress = visit(child);
      if (child.state === 'cancelled') continue;
      counts = add(counts, childProgress.counts);
      stoppedTaskIds.push(...childProgress.stoppedTaskIds);
    }
    const progress = { counts, display: displayState(node, counts), hasStoppedWork: counts.stopped > 0, stoppedTaskIds };
    result.set(node.id, progress);
    return progress;
  };
  for (const node of input.nodes) visit(node);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

export type PrerequisiteState = 'satisfied' | 'pending' | 'unsatisfiable';

export const WAIT_REASONS = [
  /** satisfied */
  'accepted',
  'completed',
  /** pending */
  'node_open',
  'task_not_done',
  /** unsatisfiable: a person has to act (continue the work, or remove or retarget the edge) */
  'node_cancelled',
  'task_cancelled',
  'task_stopped',
  'continuation_unresolvable',
  'dependency_cycle'
] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

/** One stored dependency, judged once. */
export interface JudgedDependency {
  readonly dependencyId: string;
  /** `R(dependent)`: the item this edge binds. Null when the chain could not be resolved. */
  readonly resolvedDependent: RoadmapItemRef | null;
  /** `R(prerequisite)`: what is actually judged. Null when the chain could not be resolved. */
  readonly resolvedPrerequisite: RoadmapItemRef | null;
  /** The resolved dependent will never start (a cancelled node or a `CANCELLED` task): the edge binds nothing. */
  readonly inert: boolean;
  readonly state: PrerequisiteState;
  readonly reason: WaitReason;
}

export type ReadinessStatus = 'ready' | 'pending' | 'blocked' | 'not_applicable';

export interface ItemReadiness {
  /** blocked: some wait is unsatisfiable; pending: some wait is not yet satisfied; ready: none of those. */
  readonly status: ReadinessStatus;
  /** Dependencies that bind this item itself, after resolution — stored on it or on a task it supersedes. */
  readonly dependencyIds: readonly string[];
  /** Ancestors, nearest first, whose own `dependencyIds` this item also waits on. */
  readonly inheritsFrom: readonly string[];
  /** Why readiness does not apply, when it does not: the item will never start itself. */
  readonly notApplicable: 'superseded' | 'cancelled' | null;
  /** For a superseded task: `R(task)`, which carries its work (null when the chain is malformed). */
  readonly successorTaskId: string | null;
}

export interface RoadmapReadiness {
  readonly dependencies: ReadonlyMap<string, JudgedDependency>;
  readonly nodes: ReadonlyMap<string, ItemReadiness>;
  readonly tasks: ReadonlyMap<string, ItemReadiness>;
}

const SEVERITY: Record<Exclude<ReadinessStatus, 'not_applicable'>, number> = { ready: 0, pending: 1, blocked: 2 };

function worst(
  a: Exclude<ReadinessStatus, 'not_applicable'>,
  b: Exclude<ReadinessStatus, 'not_applicable'>
): Exclude<ReadinessStatus, 'not_applicable'> {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function statusOf(state: PrerequisiteState): Exclude<ReadinessStatus, 'not_applicable'> {
  return state === 'unsatisfiable' ? 'blocked' : state === 'pending' ? 'pending' : 'ready';
}

/**
 * Readiness of every node and task, from the same resolved edges the cycle check uses. A dependent whose
 * resolved wait lies on a cycle is blocked with `dependency_cycle` whatever the edge's own satisfaction,
 * so readiness and the cycle check can never disagree.
 */
export function deriveReadiness(input: RoadmapGraphInput, graph: WaitGraph = buildWaitGraph(input)): RoadmapReadiness {
  const resolve = continuationResolver(input.tasks);
  const facts = new Map(input.tasks.map((fact) => [fact.id, fact]));
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const epicOfTask = new Map(input.placements.map((placement) => [placement.taskId, placement.epicId]));

  const judge = (dependencyId: string, prerequisite: RoadmapItemRef): Pick<JudgedDependency, 'resolvedPrerequisite' | 'state' | 'reason'> => {
    const resolved = resolve(prerequisite);
    const resolvedPrerequisite = resolved.ok ? resolved.ref : null;
    if (graph.cyclicDependencyIds.has(dependencyId)) return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'dependency_cycle' };
    if (!resolved.ok) return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'continuation_unresolvable' };
    if (resolved.ref.kind === 'node') {
      const state = nodes.get(resolved.ref.nodeId)?.state;
      if (state === 'accepted') return { resolvedPrerequisite, state: 'satisfied', reason: 'accepted' };
      if (state === 'cancelled') return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'node_cancelled' };
      return { resolvedPrerequisite, state: 'pending', reason: 'node_open' };
    }
    const fact = facts.get(resolved.ref.taskId);
    const kind = fact === undefined ? null : taskProgressKind(fact);
    if (kind === 'done') return { resolvedPrerequisite, state: 'satisfied', reason: 'completed' };
    if (kind === 'cancelled') return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'task_cancelled' };
    if (kind === 'stopped') return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'task_stopped' };
    if (kind === null) return { resolvedPrerequisite, state: 'unsatisfiable', reason: 'continuation_unresolvable' };
    return { resolvedPrerequisite, state: 'pending', reason: 'task_not_done' };
  };

  const dependencies = new Map<string, JudgedDependency>();
  const bound = new Map<string, string[]>();
  for (const dependency of input.dependencies) {
    const dependent = resolve(dependency.dependent);
    const resolvedDependent = dependent.ok ? dependent.ref : null;
    const inert = resolvedDependent !== null && isInert(resolvedDependent, nodes, facts);
    dependencies.set(dependency.id, { dependencyId: dependency.id, resolvedDependent, inert, ...judge(dependency.id, dependency.prerequisite) });
    if (resolvedDependent === null || inert) continue;
    const key = roadmapItemKey(resolvedDependent);
    const list = bound.get(key);
    if (list === undefined) bound.set(key, [dependency.id]);
    else list.push(dependency.id);
  }

  const ownStatus = (key: string): Exclude<ReadinessStatus, 'not_applicable'> =>
    (bound.get(key) ?? []).reduce<Exclude<ReadinessStatus, 'not_applicable'>>(
      (status, id) => worst(status, statusOf(dependencies.get(id)!.state)), 'ready');

  /** A node's status with every ancestor's waits folded in; memoised, so each chain is walked once. */
  const chain = new Map<string, Exclude<ReadinessStatus, 'not_applicable'>>();
  const chainStatus = (nodeId: string | null, seen: ReadonlySet<string> = new Set()): Exclude<ReadinessStatus, 'not_applicable'> => {
    if (nodeId === null || seen.has(nodeId)) return 'ready';
    const known = chain.get(nodeId);
    if (known !== undefined) return known;
    const own = ownStatus(roadmapItemKey({ kind: 'node', nodeId }));
    const status = worst(own, chainStatus(nodes.get(nodeId)?.parentId ?? null, new Set([...seen, nodeId])));
    chain.set(nodeId, status);
    return status;
  };
  const ancestors = (nodeId: string | null): string[] => {
    const list: string[] = [];
    for (let current = nodeId; current !== null && !list.includes(current); current = nodes.get(current)?.parentId ?? null) {
      list.push(current);
    }
    return list;
  };

  const nodeReadiness = new Map<string, ItemReadiness>();
  for (const node of input.nodes) {
    const key = roadmapItemKey({ kind: 'node', nodeId: node.id });
    nodeReadiness.set(node.id, node.state === 'cancelled'
      ? notApplicable('cancelled', null)
      : {
          status: chainStatus(node.id),
          dependencyIds: bound.get(key) ?? [],
          inheritsFrom: ancestors(node.parentId),
          notApplicable: null,
          successorTaskId: null
        });
  }
  const taskReadiness = new Map<string, ItemReadiness>();
  for (const fact of input.tasks) {
    const kind = taskProgressKind(fact);
    if (kind === 'superseded') {
      const successor = resolve({ kind: 'task', taskId: fact.id });
      taskReadiness.set(fact.id, notApplicable('superseded', successor.ok && successor.ref.kind === 'task' ? successor.ref.taskId : null));
      continue;
    }
    if (kind === 'cancelled') {
      taskReadiness.set(fact.id, notApplicable('cancelled', null));
      continue;
    }
    const key = roadmapItemKey({ kind: 'task', taskId: fact.id });
    const epic = epicOfTask.get(fact.id) ?? null;
    taskReadiness.set(fact.id, {
      status: worst(ownStatus(key), chainStatus(epic)),
      dependencyIds: bound.get(key) ?? [],
      inheritsFrom: ancestors(epic),
      notApplicable: null,
      successorTaskId: null
    });
  }
  return { dependencies, nodes: nodeReadiness, tasks: taskReadiness };
}

function notApplicable(reason: 'superseded' | 'cancelled', successorTaskId: string | null): ItemReadiness {
  return { status: 'not_applicable', dependencyIds: [], inheritsFrom: [], notApplicable: reason, successorTaskId };
}

/** Groups pairs by key in one pass; each group keeps the input order. */
function groupBy<K, V>(pairs: readonly (readonly [K, V])[]): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const [key, value] of pairs) {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [value]);
    else group.push(value);
  }
  return groups;
}
