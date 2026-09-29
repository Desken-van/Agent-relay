/**
 * Roadmap authoring (Milestone 13C): typed operations over the 13B repository.
 *
 * Every write is one transaction that reads the snapshot, checks the caller's `expectedRevision`, builds the
 * complete next state under the authoring policies, refuses a structurally invalid result or a new dependency
 * cycle, and hands the difference to `RoadmapRepository.apply`. An operation that changes nothing writes
 * nothing — an empty `apply` would still advance the revision. The change event is registered with
 * `afterCommit`, so it is published once the OUTERMOST transaction has committed and never after a rollback,
 * however deeply this service was called.
 *
 * The roadmap never touches a task: it reads task facts, and places or unassigns them. Readiness is advisory.
 */

import type { z } from 'zod';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  isRoadmapNodeClosed,
  ROADMAP_KIND_NOUN,
  ROADMAP_PARENT_KIND,
  transitionRoadmapNode,
  type RoadmapDependency,
  type RoadmapItemRef,
  type RoadmapNode,
  type RoadmapTaskPlacement
} from '../../shared/domain/roadmap';
import { buildWaitGraph, introducedCycleEdges, type WaitEdge } from '../../shared/domain/roadmap-graph';
import {
  roadmapAddDependencyInputSchema,
  roadmapCreateNodeInputSchema,
  roadmapGetInputSchema,
  roadmapMoveNodeInputSchema,
  roadmapPlaceTaskInputSchema,
  roadmapRemoveDependencyInputSchema,
  roadmapRemoveNodeInputSchema,
  roadmapTransitionNodeInputSchema,
  roadmapUnassignTaskInputSchema,
  roadmapUpdateNodeInputSchema,
  roadmapView,
  type ContinuationPlacement,
  type RoadmapAddDependencyInput,
  type RoadmapCreateNodeInput,
  type RoadmapMoveNodeInput,
  type RoadmapPlaceTaskInput,
  type RoadmapRemoveDependencyInput,
  type RoadmapRemoveNodeInput,
  type RoadmapTransitionNodeInput,
  type RoadmapUnassignTaskInput,
  type RoadmapUpdateNodeInput,
  type RoadmapView
} from '../../shared/domain/roadmap-operations';
import { rollUpProgress } from '../../shared/domain/roadmap-progress';
import { parseRoadmapSnapshot, type RoadmapSnapshot } from '../../shared/domain/roadmap-structure';
import { isTerminal } from '../../shared/domain/workflow';
import type { Clock, EventPublisher, IdGenerator, RoadmapRepository, TransactionRunner } from '../ports';
import { diffRoadmap, isEmptyChange, ordered, renumber, replaceRows, type RoadmapDraft } from './roadmap-change';

export interface RoadmapServiceDeps {
  readonly roadmap: RoadmapRepository;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
}

/** The repository's own words for a stale revision; the service uses the same ones. */
const STALE_MESSAGE = 'Roadmap changed. Refresh.';

/** A write refused because it would close a dependency cycle. */
export class RoadmapCycleError extends AgentRelayError {
  constructor(details: string) {
    super('VALIDATION_FAILED', 'This change would create a dependency cycle.', {
      details,
      remediation: 'Remove or retarget one of the dependencies named.'
    });
    this.name = 'RoadmapCycleError';
  }
}

export class RoadmapService {
  constructor(private readonly deps: RoadmapServiceDeps) {}

  /* ------------------------------------------------------------------------ */
  /* Reads                                                                     */
  /* ------------------------------------------------------------------------ */

  /** The stored roadmap with readiness, progress and current cycles — one consistent read. */
  view(input: { readonly projectId: string }): RoadmapView {
    const { projectId } = parse(roadmapGetInputSchema, input);
    let view: RoadmapView | null = null;
    this.deps.transactions.run(() => {
      view = this.viewOf(this.deps.roadmap.read(projectId));
    });
    return required<RoadmapView>(view);
  }

  /* ------------------------------------------------------------------------ */
  /* Nodes                                                                     */
  /* ------------------------------------------------------------------------ */

  createNode(raw: RoadmapCreateNodeInput): RoadmapView {
    const input = parse(roadmapCreateNodeInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      const parent = requireParentFor(input.kind, input.parentId, byId(before.nodes));
      if (parent !== null) refuseIfFrozen(parent, 'add a child under');
      const node: RoadmapNode = {
        id: this.deps.ids.next(),
        projectId: input.projectId,
        kind: input.kind,
        parentId: input.parentId,
        title: input.title,
        description: input.description ?? '',
        acceptanceCriteria: (input.acceptanceCriteria ?? []).map((text) => ({ id: this.deps.ids.next(), text })),
        position: 0,
        state: 'open',
        createdAt: now,
        updatedAt: now
      };
      const siblings = childrenOf(before.nodes, input.parentId);
      const group = renumber(insertAt(siblings, node, input.position ?? siblings.length), now);
      return { ...before, nodes: replaceRows(before.nodes, group, nodeKey) };
    });
  }

  /** Title, description and criteria. A closed node is read-only until reopened. */
  updateNode(raw: RoadmapUpdateNodeInput): RoadmapView {
    const input = parse(roadmapUpdateNodeInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      const node = requireNode(byId(before.nodes), input.nodeId);
      refuseIfFrozen(node, 'edit');
      const known = new Set(node.acceptanceCriteria.map((criterion) => criterion.id));
      const criteria = input.acceptanceCriteria?.map(({ id, text }) => {
        if (id !== undefined && !known.has(id)) invalid(`Acceptance criterion ${id} does not belong to this node.`);
        return { id: id ?? this.deps.ids.next(), text };
      });
      const edited = {
        ...node,
        title: input.title ?? node.title,
        description: input.description ?? node.description,
        acceptanceCriteria: criteria ?? node.acceptanceCriteria
      };
      if (sameContent(node, edited)) return before;
      return { ...before, nodes: replaceRows(before.nodes, [{ ...edited, updatedAt: now }], nodeKey) };
    });
  }

  /** Reorder among siblings, or move under another parent of the right kind. */
  moveNode(raw: RoadmapMoveNodeInput): RoadmapView {
    const input = parse(roadmapMoveNodeInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      const nodes = byId(before.nodes);
      const node = requireNode(nodes, input.nodeId);
      const parent = requireParentFor(node.kind, input.parentId, nodes);
      if (parent !== null) refuseIfFrozen(parent, 'move a node into');
      if (node.parentId !== null) refuseIfFrozen(requireNode(nodes, node.parentId), 'move a node out of');
      const siblings = childrenOf(before.nodes, input.parentId).filter((row) => row.id !== node.id);
      if (input.parentId === node.parentId && indexOfNode(childrenOf(before.nodes, node.parentId), node.id) === input.position) {
        return before;
      }
      const moved = input.parentId === node.parentId ? node : { ...node, parentId: input.parentId, updatedAt: now };
      const group = renumber(insertAt(siblings, moved, input.position), now);
      return { ...before, nodes: replaceRows(before.nodes, group, nodeKey) };
    });
  }

  /** Only an open, empty node nothing refers to; cancelling is how finished or abandoned work is kept. */
  removeNode(raw: RoadmapRemoveNodeInput): RoadmapView {
    const input = parse(roadmapRemoveNodeInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before) => {
      const nodes = byId(before.nodes);
      const node = requireNode(nodes, input.nodeId);
      refuseIfFrozen(node, 'remove');
      if (node.parentId !== null) refuseIfFrozen(requireNode(nodes, node.parentId), 'remove a child of');
      if (before.nodes.some((row) => row.parentId === node.id)) invalid('Only a node without children can be removed.');
      if (before.placements.some((row) => row.epicId === node.id)) invalid('Only an epic without tasks can be removed.');
      const edges = before.dependencies.filter((row) =>
        [row.dependent, row.prerequisite].some((end) => end.kind === 'node' && end.nodeId === node.id));
      if (edges.length > 0) {
        invalid('Remove the dependencies that name this node first.', edges.map((row) => row.id).join(', '));
      }
      return { ...before, nodes: before.nodes.filter((row) => row.id !== node.id) };
    });
  }

  /**
   * accept / cancel / reopen. Reopen never cascades and needs an open parent; accept and cancel need every
   * child closed and every task beneath terminal; accept over stopped work needs the operator's explicit
   * acknowledgement.
   */
  transitionNode(raw: RoadmapTransitionNodeInput): RoadmapView {
    const input = parse(roadmapTransitionNodeInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      const nodes = byId(before.nodes);
      const node = requireNode(nodes, input.nodeId);
      const state = transitionRoadmapNode(node.state, input.event);
      if (input.event === 'reopen') {
        if (node.parentId !== null && isRoadmapNodeClosed(requireNode(nodes, node.parentId).state)) {
          invalid('Reopen the parent first: an open node cannot sit under a closed one.');
        }
      } else {
        const openChildren = before.nodes.filter((row) => row.parentId === node.id && row.state === 'open');
        if (openChildren.length > 0) {
          invalid(`Close every child first (${input.event} needs a closed subtree).`, openChildren.map((row) => row.id).join(', '));
        }
        const facts = new Map(before.tasks.map((fact) => [fact.id, fact]));
        const active = before.placements.filter((row) => {
          const fact = facts.get(row.taskId);
          return row.epicId === node.id && fact !== undefined && !isTerminal(fact.status);
        });
        if (active.length > 0) {
          invalid('Every task in the epic must be finished, cancelled or stopped first.', active.map((row) => row.taskId).join(', '));
        }
        const stopped = rollUpProgress(before).get(node.id)?.stoppedTaskIds ?? [];
        if (input.event === 'accept' && stopped.length > 0 && input.acknowledgeStoppedWork !== true) {
          throw new AgentRelayError('APPROVAL_REQUIRED', 'Accepting this node accepts stopped work beneath it.', {
            details: stopped.join(', '),
            remediation: 'Continue or move those tasks, or accept again acknowledging the stopped work.'
          });
        }
      }
      return { ...before, nodes: replaceRows(before.nodes, [{ ...node, state, updatedAt: now }], nodeKey) };
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Tasks                                                                     */
  /* ------------------------------------------------------------------------ */

  /** Assign a task to an epic, move it to another, or reorder it within its own. */
  placeTask(raw: RoadmapPlaceTaskInput): RoadmapView {
    const input = parse(roadmapPlaceTaskInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      requireTask(before, input.taskId);
      const nodes = byId(before.nodes);
      const epic = requireNode(nodes, input.epicId);
      if (epic.kind !== 'epic') invalid(`A task can be placed only under an epic, not under ${ROADMAP_KIND_NOUN[epic.kind]}.`);
      refuseIfFrozen(epic, 'place a task into');
      const current = before.placements.find((row) => row.taskId === input.taskId);
      if (current !== undefined) refuseIfFrozen(requireNode(nodes, current.epicId), 'move a task out of');
      const siblings = tasksOf(before.placements, epic.id).filter((row) => row.taskId !== input.taskId);
      const position = input.position ?? siblings.length;
      if (current !== undefined && current.epicId === epic.id && indexOfTask(tasksOf(before.placements, epic.id), input.taskId) === position) {
        return before;
      }
      const moved: RoadmapTaskPlacement = current === undefined
        ? { taskId: input.taskId, projectId: input.projectId, epicId: epic.id, position: 0, createdAt: now, updatedAt: now }
        : current.epicId === epic.id ? current : { ...current, epicId: epic.id, updatedAt: now };
      const group = renumber(insertAt(siblings, moved, position), now);
      return { ...before, placements: replaceRows(before.placements, group, placementKey) };
    });
  }

  /** Back to Unassigned. The task itself is untouched. */
  unassignTask(raw: RoadmapUnassignTaskInput): RoadmapView {
    const input = parse(roadmapUnassignTaskInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before) => {
      requireTask(before, input.taskId);
      const current = before.placements.find((row) => row.taskId === input.taskId);
      if (current === undefined) return before;
      refuseIfFrozen(requireNode(byId(before.nodes), current.epicId), 'move a task out of');
      return { ...before, placements: before.placements.filter((row) => row.taskId !== input.taskId) };
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Dependencies                                                              */
  /* ------------------------------------------------------------------------ */

  addDependency(raw: RoadmapAddDependencyInput): RoadmapView {
    const input = parse(roadmapAddDependencyInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before, now) => {
      const nodes = byId(before.nodes);
      for (const end of [input.dependent, input.prerequisite]) requireItem(before, nodes, end);
      const closed = closedAround(before, nodes, input.dependent);
      if (closed !== null) refuseIfFrozen(closed, 'add a dependency inside');
      const dependency: RoadmapDependency = {
        id: this.deps.ids.next(),
        projectId: input.projectId,
        dependent: input.dependent,
        prerequisite: input.prerequisite,
        createdAt: now
      };
      return { ...before, dependencies: [...before.dependencies, dependency] };
    });
  }

  /** Always allowed: removing an edge can never create a cycle, so a cycle can always be undone. */
  removeDependency(raw: RoadmapRemoveDependencyInput): RoadmapView {
    const input = parse(roadmapRemoveDependencyInputSchema, raw);
    return this.write(input.projectId, input.expectedRevision, (before) => {
      if (!before.dependencies.some((row) => row.id === input.dependencyId)) {
        throw new AgentRelayError('NOT_FOUND', 'No such dependency in this roadmap.');
      }
      return { ...before, dependencies: before.dependencies.filter((row) => row.id !== input.dependencyId) };
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Continuations                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Place a new continuation right after its source, in the source's epic, if that epic is open.
   *
   * Called INSIDE the continuation's own creation transaction, so it runs in a savepoint: whatever it wrote
   * is undone if it fails, and its event waits for that outer commit. It never throws — a damaged roadmap,
   * a stale revision or a refused write must not stop a continuation from being created — and it never
   * reports a refusal as a placement.
   */
  placeContinuation(input: {
    readonly projectId: string;
    readonly sourceTaskId: string;
    readonly continuationTaskId: string;
  }): ContinuationPlacement {
    let outcome: ContinuationPlacement | null = null;
    try {
      this.deps.transactions.run(() => {
        let before: RoadmapSnapshot;
        try {
          before = this.deps.roadmap.read(input.projectId);
        } catch (error) {
          outcome = { outcome: 'failed', reason: 'roadmap_invalid', message: messageOf(error) };
          return;
        }
        const source = before.placements.find((row) => row.taskId === input.sourceTaskId);
        if (source === undefined) {
          outcome = { outcome: 'unassigned', reason: 'source_unassigned', message: 'The source task is Unassigned.' };
          return;
        }
        const epic = requireNode(byId(before.nodes), source.epicId);
        if (isRoadmapNodeClosed(epic.state)) {
          outcome = { outcome: 'unassigned', reason: 'epic_closed', message: `The source's epic is ${epic.state}.` };
          return;
        }
        const now = this.deps.clock.nowIso();
        const siblings = tasksOf(before.placements, epic.id).filter((row) => row.taskId !== input.continuationTaskId);
        const placement: RoadmapTaskPlacement = {
          taskId: input.continuationTaskId, projectId: input.projectId, epicId: epic.id, position: 0, createdAt: now, updatedAt: now
        };
        const group = renumber(insertAt(siblings, placement, indexOfTask(siblings, source.taskId) + 1), now);
        const after = this.applyDraft(before, { ...before, placements: replaceRows(before.placements, group, placementKey) });
        const position = group.findIndex((row) => row.taskId === input.continuationTaskId);
        outcome = after === null
          ? { outcome: 'failed', reason: 'refused', message: 'The placement changed nothing.' }
          : { outcome: 'placed', epicId: epic.id, position, revision: after.revision };
      });
    } catch (error) {
      return {
        outcome: 'failed',
        reason: error instanceof RoadmapCycleError ? 'dependency_cycle'
          : messageOf(error) === STALE_MESSAGE ? 'roadmap_changed' : 'refused',
        message: messageOf(error)
      };
    }
    return required<ContinuationPlacement>(outcome);
  }

  /* ------------------------------------------------------------------------ */
  /* The write path                                                            */
  /* ------------------------------------------------------------------------ */

  private write(
    projectId: string,
    expectedRevision: number,
    build: (before: RoadmapSnapshot, now: string) => RoadmapDraft
  ): RoadmapView {
    let view: RoadmapView | null = null;
    this.deps.transactions.run(() => {
      const before = this.deps.roadmap.read(projectId);
      if (before.revision !== expectedRevision) {
        throw new AgentRelayError('VALIDATION_FAILED', STALE_MESSAGE, {
          details: `expected revision ${expectedRevision}, current ${before.revision}`
        });
      }
      const after = this.applyDraft(before, build(before, this.deps.clock.nowIso()));
      view = this.viewOf(after ?? before);
    });
    return required<RoadmapView>(view);
  }

  /**
   * Validate the complete next state, refuse a new cycle, apply the difference, and schedule the event for
   * after the outermost commit. Returns null — having written nothing — when there is no difference.
   */
  private applyDraft(before: RoadmapSnapshot, draft: RoadmapDraft): RoadmapSnapshot | null {
    const change = diffRoadmap(before, draft);
    if (isEmptyChange(change)) return null;
    const candidate = parseRoadmapSnapshot({ ...draft, projectId: before.projectId, revision: before.revision, tasks: before.tasks });
    const introduced = introducedCycleEdges(buildWaitGraph(before), buildWaitGraph(candidate));
    if (introduced.length > 0) throw new RoadmapCycleError(describeCycle(introduced));
    const after = this.deps.roadmap.apply(before.projectId, before.revision, change);
    const { projectId, revision } = after;
    this.deps.transactions.afterCommit(() => this.deps.events.publishRoadmap(projectId, revision));
    return after;
  }

  private viewOf(snapshot: RoadmapSnapshot): RoadmapView {
    return roadmapView(snapshot, this.deps.roadmap.listUnassigned(snapshot.projectId).map((fact) => fact.id));
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The same strict, normalising parse IPC applies, for callers that reach the service another way. */
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new AgentRelayError('VALIDATION_FAILED', 'The roadmap request is invalid.', {
    details: parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
  });
}

function invalid(message: string, details?: string): never {
  throw new AgentRelayError('VALIDATION_FAILED', message, details === undefined ? undefined : { details });
}

function required<T>(value: T | null): T {
  if (value === null) throw new AgentRelayError('INTERNAL', 'The roadmap operation produced no result.');
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const nodeKey = (node: RoadmapNode): string => node.id;
const placementKey = (row: RoadmapTaskPlacement): string => row.taskId;

function byId(nodes: readonly RoadmapNode[]): ReadonlyMap<string, RoadmapNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function requireNode(nodes: ReadonlyMap<string, RoadmapNode>, id: string | null): RoadmapNode {
  const node = id === null ? undefined : nodes.get(id);
  if (node === undefined) throw new AgentRelayError('NOT_FOUND', 'No such node in this roadmap.', { details: id ?? '(none)' });
  return node;
}

function requireTask(snapshot: RoadmapSnapshot, taskId: string): void {
  if (!snapshot.tasks.some((fact) => fact.id === taskId)) {
    throw new AgentRelayError('NOT_FOUND', 'No such task in this project.', { details: taskId });
  }
}

function requireItem(snapshot: RoadmapSnapshot, nodes: ReadonlyMap<string, RoadmapNode>, ref: RoadmapItemRef): void {
  if (ref.kind === 'node') requireNode(nodes, ref.nodeId);
  else requireTask(snapshot, ref.taskId);
}

/** A closed node's contents are frozen (docs/roadmap.md §3): reopen it first. */
function refuseIfFrozen(node: RoadmapNode, action: string): void {
  if (isRoadmapNodeClosed(node.state)) {
    invalid(`Cannot ${action} ${ROADMAP_KIND_NOUN[node.kind]} that is ${node.state}; reopen it first.`, node.id);
  }
}

/** The closed node an item sits in or is, nearest first; null when all around it is open. */
function closedAround(
  snapshot: RoadmapSnapshot,
  nodes: ReadonlyMap<string, RoadmapNode>,
  ref: RoadmapItemRef
): RoadmapNode | null {
  let current: string | null = ref.kind === 'node'
    ? ref.nodeId
    : snapshot.placements.find((row) => row.taskId === ref.taskId)?.epicId ?? null;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node = nodes.get(current);
    if (node === undefined) return null;
    if (isRoadmapNodeClosed(node.state)) return node;
    current = node.parentId;
  }
  return null;
}

function childrenOf(nodes: readonly RoadmapNode[], parentId: string | null): RoadmapNode[] {
  return ordered(nodes.filter((node) => node.parentId === parentId), nodeKey);
}

function tasksOf(placements: readonly RoadmapTaskPlacement[], epicId: string): RoadmapTaskPlacement[] {
  return ordered(placements.filter((row) => row.epicId === epicId), placementKey);
}

function indexOfNode(rows: readonly RoadmapNode[], id: string): number {
  return rows.findIndex((row) => row.id === id);
}

function indexOfTask(rows: readonly RoadmapTaskPlacement[], taskId: string): number {
  return rows.findIndex((row) => row.taskId === taskId);
}

/** A phase or epic names its parent; a goal names none. */
function requireParentFor(
  kind: RoadmapNode['kind'],
  parentId: string | null,
  nodes: ReadonlyMap<string, RoadmapNode>
): RoadmapNode | null {
  const expected = ROADMAP_PARENT_KIND[kind];
  if (expected === null) {
    if (parentId !== null) invalid('A goal has no parent.');
    return null;
  }
  if (parentId === null) invalid(`The parent of ${ROADMAP_KIND_NOUN[kind]} must be ${ROADMAP_KIND_NOUN[expected]}.`);
  const parent = requireNode(nodes, parentId);
  if (parent.kind !== expected) {
    invalid(`The parent of ${ROADMAP_KIND_NOUN[kind]} must be ${ROADMAP_KIND_NOUN[expected]}, not ${ROADMAP_KIND_NOUN[parent.kind]}.`);
  }
  return parent;
}

/** Insert at `index` (0 … length). Beyond the end is refused rather than clamped. */
function insertAt<T>(rows: readonly T[], row: T, index: number): T[] {
  if (index > rows.length) invalid(`Position ${index} is past the end; the last position is ${rows.length}.`);
  return [...rows.slice(0, index), row, ...rows.slice(index)];
}

function sameContent(a: RoadmapNode, b: RoadmapNode): boolean {
  return a.title === b.title && a.description === b.description &&
    JSON.stringify(a.acceptanceCriteria) === JSON.stringify(b.acceptanceCriteria);
}

function describeCycle(edges: readonly WaitEdge[]): string {
  return edges
    .map(({ link }) =>
      link.kind === 'dependency' ? `dependency ${link.dependencyId}`
        : link.kind === 'placement' ? `task ${link.taskId} in epic ${link.epicId}`
          : link.kind === 'parent' ? `node ${link.nodeId} under ${link.parentId}`
            : 'completion')
    .filter((item, index, all) => all.indexOf(item) === index)
    .join(', ');
}

