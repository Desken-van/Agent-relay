/**
 * Continuation resolution and the start/done wait graph (docs/roadmap.md §4).
 *
 * One rule, used by readiness and by the cycle check alike: every stored dependency is read as
 * `R(dependent)` waits for `R(prerequisite)`, where `R` follows a superseded task to the last task of its
 * continuation chain. Nothing here reads the raw reference of a superseded task, so the two consumers can
 * never disagree about what an edge means.
 *
 * Pure: the snapshot goes in, facts come out. Resolution is recomputed on every read because a continuation
 * is a workflow event that changes what an edge means without any roadmap write.
 */

import { roadmapItemKey, taskProgressKind, type RoadmapItemRef, type RoadmapTaskFact } from './roadmap';
import type { RoadmapSnapshotInput } from './roadmap-structure';

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/** Why a reference could not be resolved. Both are malformed data, never a normal state. */
export type ResolutionFailure = 'continuation_loop' | 'continuation_missing';

export type Resolution =
  | { readonly ok: true; readonly ref: RoadmapItemRef }
  | { readonly ok: false; readonly reason: ResolutionFailure; readonly chain: readonly string[] };

/**
 * `R`: a node is itself; a task is itself unless it is superseded (stopped AND continued, exactly as
 * `taskProgressKind` says), in which case it is `R(its continuation)`.
 *
 * Bounded by the number of tasks it could visit: a chain that revisits a task, or names a task the project
 * does not have, ends with the reason instead of looping or guessing.
 */
export function continuationResolver(tasks: readonly RoadmapTaskFact[]): (ref: RoadmapItemRef) => Resolution {
  const facts = new Map(tasks.map((fact) => [fact.id, fact]));
  return (ref) => {
    if (ref.kind === 'node') return { ok: true, ref };
    const chain: string[] = [];
    const visited = new Set<string>();
    let current = ref.taskId;
    for (;;) {
      if (visited.has(current)) return { ok: false, reason: 'continuation_loop', chain: [...chain, current] };
      visited.add(current);
      chain.push(current);
      const fact = facts.get(current);
      if (fact === undefined) return { ok: false, reason: 'continuation_missing', chain };
      if (taskProgressKind(fact) !== 'superseded' || fact.continuedByTaskId === null) {
        return { ok: true, ref: { kind: 'task', taskId: current } };
      }
      current = fact.continuedByTaskId;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* The graph                                                                   */
/* -------------------------------------------------------------------------- */

/** What put an edge in the graph — so a cycle can be reported, and a write judged, by what caused it. */
export type WaitLink =
  | { readonly kind: 'dependency'; readonly dependencyId: string }
  | { readonly kind: 'parent'; readonly nodeId: string; readonly parentId: string }
  | { readonly kind: 'placement'; readonly taskId: string; readonly epicId: string }
  | { readonly kind: 'self' };

export interface WaitEdge {
  readonly from: string;
  readonly to: string;
  readonly link: WaitLink;
}

export interface UnresolvedDependency {
  readonly dependencyId: string;
  readonly end: 'dependent' | 'prerequisite';
  readonly reason: ResolutionFailure;
  readonly chain: readonly string[];
}

export interface WaitGraph {
  readonly edges: readonly WaitEdge[];
  /** Edges whose two ends lie on one cycle. */
  readonly cyclicEdges: readonly WaitEdge[];
  /** Stored dependencies whose resolved edge lies on a cycle: their dependents are blocked. */
  readonly cyclicDependencyIds: ReadonlySet<string>;
  /** Dependencies with an end `R` could not resolve; they add no edge and block what relies on them. */
  readonly unresolved: readonly UnresolvedDependency[];
}

export type RoadmapGraphInput = Pick<RoadmapSnapshotInput, 'nodes' | 'placements' | 'dependencies' | 'tasks'>;

export const startOf = (ref: RoadmapItemRef): string => `start:${roadmapItemKey(ref)}`;
export const doneOf = (ref: RoadmapItemRef): string => `done:${roadmapItemKey(ref)}`;

export function edgeKey(edge: WaitEdge): string {
  const { link } = edge;
  const cause =
    link.kind === 'dependency' ? `d:${link.dependencyId}`
      : link.kind === 'parent' ? `p:${link.nodeId}>${link.parentId}`
        : link.kind === 'placement' ? `t:${link.taskId}>${link.epicId}`
          : 'self';
  return JSON.stringify([edge.from, edge.to, cause]);
}

/**
 * The start/done graph over resolved items (docs/roadmap.md §4 "Cycles"):
 *
 * - `start(R(d)) → done(R(p))` for each stored dependency that is not inert;
 * - `start(child) → start(parent)` for each node with a parent and each placed, not superseded task;
 * - `done(parent) → done(child)` for each child node that is not cancelled and each placed task that is
 *   neither `CANCELLED` nor superseded;
 * - `done(x) → start(x)` for every vertex.
 */
export function buildWaitGraph(input: RoadmapGraphInput): WaitGraph {
  const resolve = continuationResolver(input.tasks);
  const facts = new Map(input.tasks.map((fact) => [fact.id, fact]));
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const edges: WaitEdge[] = [];
  const unresolved: UnresolvedDependency[] = [];

  for (const node of input.nodes) {
    const self = { kind: 'node', nodeId: node.id } as const;
    edges.push({ from: doneOf(self), to: startOf(self), link: { kind: 'self' } });
    if (node.parentId === null) continue;
    const parent = { kind: 'node', nodeId: node.parentId } as const;
    const link = { kind: 'parent', nodeId: node.id, parentId: node.parentId } as const;
    edges.push({ from: startOf(self), to: startOf(parent), link });
    if (node.state !== 'cancelled') edges.push({ from: doneOf(parent), to: doneOf(self), link });
  }
  for (const fact of input.tasks) {
    if (taskProgressKind(fact) === 'superseded') continue;
    const self = { kind: 'task', taskId: fact.id } as const;
    edges.push({ from: doneOf(self), to: startOf(self), link: { kind: 'self' } });
  }
  for (const placement of input.placements) {
    const fact = facts.get(placement.taskId);
    if (fact === undefined || taskProgressKind(fact) === 'superseded') continue;
    const task = { kind: 'task', taskId: fact.id } as const;
    const epic = { kind: 'node', nodeId: placement.epicId } as const;
    const link = { kind: 'placement', taskId: fact.id, epicId: placement.epicId } as const;
    edges.push({ from: startOf(task), to: startOf(epic), link });
    if (fact.status !== 'CANCELLED') edges.push({ from: doneOf(epic), to: doneOf(task), link });
  }
  for (const dependency of input.dependencies) {
    const dependent = resolve(dependency.dependent);
    const prerequisite = resolve(dependency.prerequisite);
    if (!dependent.ok || !prerequisite.ok) {
      for (const [end, resolution] of [['dependent', dependent], ['prerequisite', prerequisite]] as const) {
        if (!resolution.ok) {
          unresolved.push({ dependencyId: dependency.id, end, reason: resolution.reason, chain: resolution.chain });
        }
      }
      continue;
    }
    if (isInert(dependent.ref, nodes, facts)) continue;
    edges.push({
      from: startOf(dependent.ref),
      to: doneOf(prerequisite.ref),
      link: { kind: 'dependency', dependencyId: dependency.id }
    });
  }

  const component = stronglyConnectedComponents(edges);
  const cyclicEdges = edges.filter((edge) => {
    const group = component.get(edge.from);
    return group !== undefined && group === component.get(edge.to) && (group.size > 1 || edge.from === edge.to);
  });
  const cyclicDependencyIds = new Set(
    cyclicEdges.flatMap((edge) => (edge.link.kind === 'dependency' ? [edge.link.dependencyId] : []))
  );
  return { edges, cyclicEdges, cyclicDependencyIds, unresolved };
}

/** An item that will never start constrains nothing: a cancelled node or a `CANCELLED` task. */
export function isInert(
  ref: RoadmapItemRef,
  nodes: ReadonlyMap<string, { readonly state: string }>,
  facts: ReadonlyMap<string, RoadmapTaskFact>
): boolean {
  return ref.kind === 'node'
    ? nodes.get(ref.nodeId)?.state === 'cancelled'
    : facts.get(ref.taskId)?.status === 'CANCELLED';
}

/**
 * The cyclic edges a change would introduce: those on a cycle after it that did not exist before it.
 *
 * A cycle made only of edges that already existed — one a continuation created without any roadmap write —
 * does not block an unrelated change, and a change that only removes edges introduces nothing, so a cycle
 * can always be undone (docs/roadmap.md §4 "Write time").
 */
export function introducedCycleEdges(before: WaitGraph, after: WaitGraph): WaitEdge[] {
  const existing = new Set(before.edges.map(edgeKey));
  return after.cyclicEdges.filter((edge) => !existing.has(edgeKey(edge)));
}

/* -------------------------------------------------------------------------- */
/* Strongly connected components (iterative Tarjan)                             */
/* -------------------------------------------------------------------------- */

/** Maps every vertex to the set of vertices in its component. Iterative, so depth never meets the stack. */
function stronglyConnectedComponents(edges: readonly WaitEdge[]): Map<string, ReadonlySet<string>> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const successors = adjacency.get(edge.from);
    if (successors === undefined) adjacency.set(edge.from, [edge.to]);
    else successors.push(edge.to);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, ReadonlySet<string>>();
  let counter = 0;

  for (const root of adjacency.keys()) {
    if (index.has(root)) continue;
    const work: { vertex: string; next: number }[] = [{ vertex: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const successors = adjacency.get(frame.vertex)!;
      if (frame.next < successors.length) {
        const successor = successors[frame.next]!;
        frame.next += 1;
        if (!index.has(successor)) {
          index.set(successor, counter);
          low.set(successor, counter);
          counter += 1;
          stack.push(successor);
          onStack.add(successor);
          work.push({ vertex: successor, next: 0 });
        } else if (onStack.has(successor)) {
          low.set(frame.vertex, Math.min(low.get(frame.vertex)!, index.get(successor)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.vertex, Math.min(low.get(parent.vertex)!, low.get(frame.vertex)!));
      if (low.get(frame.vertex) === index.get(frame.vertex)) {
        const members = new Set<string>();
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          members.add(member);
          if (member === frame.vertex) break;
        }
        for (const member of members) result.set(member, members);
      }
    }
  }
  return result;
}
