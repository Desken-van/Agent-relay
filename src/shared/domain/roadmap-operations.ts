/**
 * The authoring surface of the Roadmap (Milestone 13C): what a caller may ask for, and what it reads back.
 *
 * Input schemas are strict and NORMALISE what a person typed — surrounding whitespace, Windows line
 * endings — and then hand the result to the persisted 13A schemas, so a value that passes here is already
 * a value storage accepts. The service parses its input through these same schemas, so a caller that
 * bypasses IPC gets the same normalisation and the same refusals.
 */

import { z } from 'zod';
import { AgentRelayError } from './errors';
import { idSchema } from './models';
import {
  ROADMAP_LIMITS,
  ROADMAP_NODE_EVENTS,
  ROADMAP_NODE_KINDS,
  roadmapAcceptanceCriterionSchema,
  roadmapDescriptionSchema,
  roadmapItemRefSchema,
  roadmapTitleSchema,
  type RoadmapDependency,
  type RoadmapItemRef,
  type RoadmapNode,
  type RoadmapTaskFact,
  type RoadmapTaskPlacement
} from './roadmap';
import { buildWaitGraph, type UnresolvedDependency } from './roadmap-graph';
import {
  deriveReadiness,
  rollUpProgress,
  type ItemReadiness,
  type JudgedDependency,
  type NodeProgress
} from './roadmap-progress';
import type { RoadmapSnapshot } from './roadmap-structure';

/* -------------------------------------------------------------------------- */
/* Normalised text                                                             */
/* -------------------------------------------------------------------------- */

/** Generous raw bounds: the persisted schema applies the real limits after normalisation. */
const RAW_TEXT_FACTOR = 4;

const trimmed = (max: number) =>
  z.string().max(max * RAW_TEXT_FACTOR).transform((value) => value.trim());

export const authoredTitleSchema = trimmed(ROADMAP_LIMITS.titleLength).pipe(roadmapTitleSchema);
export const authoredDescriptionSchema = z
  .string()
  .max(ROADMAP_LIMITS.descriptionLength * RAW_TEXT_FACTOR)
  .transform((value) => value.replace(/\r\n?/g, '\n').trim())
  .pipe(roadmapDescriptionSchema);
export const authoredCriterionTextSchema = trimmed(ROADMAP_LIMITS.criterionLength)
  .pipe(roadmapAcceptanceCriterionSchema.shape.text);

/* -------------------------------------------------------------------------- */
/* Operation inputs                                                            */
/* -------------------------------------------------------------------------- */

const revisionSchema = z.number().int().nonnegative();
const positionSchema = z.number().int().nonnegative();
const scope = { projectId: idSchema, expectedRevision: revisionSchema };

export const roadmapGetInputSchema = z.object({ projectId: idSchema }).strict();

export const roadmapCreateNodeInputSchema = z
  .object({
    ...scope,
    kind: z.enum(ROADMAP_NODE_KINDS),
    /** Null exactly for a goal. */
    parentId: idSchema.nullable(),
    title: authoredTitleSchema,
    description: authoredDescriptionSchema.optional(),
    acceptanceCriteria: z.array(authoredCriterionTextSchema).max(ROADMAP_LIMITS.acceptanceCriteriaPerNode).optional(),
    /** Index among the new siblings; omitted means last. */
    position: positionSchema.optional()
  })
  .strict();

export const roadmapUpdateNodeInputSchema = z
  .object({
    ...scope,
    nodeId: idSchema,
    title: authoredTitleSchema.optional(),
    description: authoredDescriptionSchema.optional(),
    /**
     * The complete new list, in display order. An entry naming an `id` keeps that criterion's identity (it
     * must be one of this node's); an entry without one is a new criterion.
     */
    acceptanceCriteria: z
      .array(z.object({ id: idSchema.optional(), text: authoredCriterionTextSchema }).strict())
      .max(ROADMAP_LIMITS.acceptanceCriteriaPerNode)
      .optional()
  })
  .strict();

export const roadmapMoveNodeInputSchema = z
  .object({ ...scope, nodeId: idSchema, parentId: idSchema.nullable(), position: positionSchema })
  .strict();

export const roadmapRemoveNodeInputSchema = z.object({ ...scope, nodeId: idSchema }).strict();

export const roadmapTransitionNodeInputSchema = z
  .object({
    ...scope,
    nodeId: idSchema,
    event: z.enum(ROADMAP_NODE_EVENTS),
    /** Required to accept over stopped work beneath the node; meaningless otherwise. */
    acknowledgeStoppedWork: z.boolean().optional()
  })
  .strict();

export const roadmapPlaceTaskInputSchema = z
  .object({ ...scope, taskId: idSchema, epicId: idSchema, position: positionSchema.optional() })
  .strict();

export const roadmapUnassignTaskInputSchema = z.object({ ...scope, taskId: idSchema }).strict();

export const roadmapAddDependencyInputSchema = z
  .object({ ...scope, dependent: roadmapItemRefSchema, prerequisite: roadmapItemRefSchema })
  .strict();

export const roadmapRemoveDependencyInputSchema = z.object({ ...scope, dependencyId: idSchema }).strict();

export type RoadmapCreateNodeInput = z.input<typeof roadmapCreateNodeInputSchema>;
export type RoadmapUpdateNodeInput = z.input<typeof roadmapUpdateNodeInputSchema>;
export type RoadmapMoveNodeInput = z.input<typeof roadmapMoveNodeInputSchema>;
export type RoadmapRemoveNodeInput = z.input<typeof roadmapRemoveNodeInputSchema>;
export type RoadmapTransitionNodeInput = z.input<typeof roadmapTransitionNodeInputSchema>;
export type RoadmapPlaceTaskInput = z.input<typeof roadmapPlaceTaskInputSchema>;
export type RoadmapUnassignTaskInput = z.input<typeof roadmapUnassignTaskInputSchema>;
export type RoadmapAddDependencyInput = z.input<typeof roadmapAddDependencyInputSchema>;
export type RoadmapRemoveDependencyInput = z.input<typeof roadmapRemoveDependencyInputSchema>;

/* -------------------------------------------------------------------------- */
/* Read model                                                                  */
/* -------------------------------------------------------------------------- */

/** A project's roadmap as stored, with everything derived from it. JSON-safe: maps are records. */
export interface RoadmapView {
  readonly projectId: string;
  readonly revision: number;
  readonly nodes: readonly RoadmapNode[];
  readonly placements: readonly RoadmapTaskPlacement[];
  readonly dependencies: readonly RoadmapDependency[];
  /** The workflow's own facts, read at the same moment; the roadmap stores none of them. */
  readonly tasks: readonly RoadmapTaskFact[];
  /** Tasks with no placement, in the Tasks-list order (`created_at DESC, id ASC`). */
  readonly unassignedTaskIds: readonly string[];
  readonly progress: Readonly<Record<string, NodeProgress>>;
  /** Linear in size: each dependency judged once; items list ids only. See {@link effectiveWaits}. */
  readonly readiness: RoadmapViewReadiness;
  /** Stored dependencies whose resolved edge lies on a cycle right now. */
  readonly cyclicDependencyIds: readonly string[];
  readonly unresolvedDependencies: readonly UnresolvedDependency[];
}

export interface RoadmapViewReadiness {
  readonly dependencies: Readonly<Record<string, JudgedDependency>>;
  readonly nodes: Readonly<Record<string, ItemReadiness>>;
  readonly tasks: Readonly<Record<string, ItemReadiness>>;
}

export function roadmapView(snapshot: RoadmapSnapshot, unassignedTaskIds: readonly string[]): RoadmapView {
  const graph = buildWaitGraph(snapshot);
  const readiness = deriveReadiness(snapshot, graph);
  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    nodes: snapshot.nodes,
    placements: snapshot.placements,
    dependencies: snapshot.dependencies,
    tasks: snapshot.tasks,
    unassignedTaskIds,
    progress: Object.fromEntries(rollUpProgress(snapshot)),
    readiness: {
      dependencies: Object.fromEntries(readiness.dependencies),
      nodes: Object.fromEntries(readiness.nodes),
      tasks: Object.fromEntries(readiness.tasks)
    },
    cyclicDependencyIds: [...graph.cyclicDependencyIds].sort(),
    unresolvedDependencies: graph.unresolved
  };
}

/** One wait of an item, own or inherited, as a screen shows it. */
export interface EffectiveWait extends JudgedDependency {
  /** Null for the item's own edge; otherwise the ancestor node whose edge it inherits. */
  readonly inheritedFrom: string | null;
}

/**
 * Every wait an item has, expanded on demand from the linear readiness: its own dependencies first, then each
 * ancestor's, nearest first. Nothing here is stored or sent; a screen asks for the item it is showing.
 */
export function effectiveWaits(readiness: RoadmapViewReadiness, ref: RoadmapItemRef): EffectiveWait[] {
  const item = ref.kind === 'node' ? readiness.nodes[ref.nodeId] : readiness.tasks[ref.taskId];
  if (item === undefined) return [];
  const expand = (ids: readonly string[], inheritedFrom: string | null) =>
    ids.flatMap((id) => {
      const judged = readiness.dependencies[id];
      return judged === undefined ? [] : [{ ...judged, inheritedFrom }];
    });
  return [
    ...expand(item.dependencyIds, null),
    ...item.inheritsFrom.flatMap((ancestor) => expand(readiness.nodes[ancestor]?.dependencyIds ?? [], ancestor))
  ];
}

/* -------------------------------------------------------------------------- */
/* Revision conflict                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The roadmap moved on since the caller read it. Recognised by type in the main process and by its stable
 * code across IPC, never by its words. Never retried.
 */
export class RoadmapRevisionConflictError extends AgentRelayError {
  constructor(details?: string) {
    super('ROADMAP_CHANGED', 'Roadmap changed. Refresh.', details === undefined ? undefined : { details });
    this.name = 'RoadmapRevisionConflictError';
  }
}

/* -------------------------------------------------------------------------- */
/* Continuation placement                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What happened to a new continuation's roadmap placement. It is created Unassigned either way; only
 * `placed` means the roadmap now shows it after its source. `unassigned` is policy — there was nowhere
 * to put it. `failed` means placement was attempted and refused; it is never reported as a success.
 */
export type ContinuationPlacement =
  | { readonly outcome: 'placed'; readonly epicId: string; readonly position: number; readonly revision: number }
  | { readonly outcome: 'unassigned'; readonly reason: 'source_unassigned' | 'epic_closed'; readonly message: string }
  | {
      readonly outcome: 'failed';
      readonly reason: 'roadmap_changed' | 'roadmap_invalid' | 'dependency_cycle' | 'refused';
      readonly message: string;
    };
