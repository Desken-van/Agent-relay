/**
 * The durable Roadmap: Goal → Phase → Epic → Task.
 *
 * ## One execution system, not two
 *
 * A task row is still the only thing Agent Relay runs. The roadmap never owns a
 * task's status, never transitions it and never stores a copy of it: a task is
 * attached to an epic by a placement, and everything the roadmap says about a
 * task's progress is derived at read time from the task's own workflow status
 * (see {@link taskProgressKind}). A second, separately written status would be a
 * second source of truth, and two sources of truth eventually disagree.
 *
 * ## Unassigned is an absence
 *
 * A task with no placement is Unassigned. There is deliberately no placement
 * with a null epic: two representations of one fact would both have to be
 * handled everywhere, and one of them would not be. It also means every task
 * that existed before the roadmap is Unassigned without a single row written.
 *
 * Cross-record rules — parents exist, one project, no containment dependency,
 * closed nodes stay closed — live in `roadmap-structure.ts`. This module is the
 * vocabulary and the shape of each record. `docs/roadmap.md` is the whole
 * contract, including the storage design.
 */

import { z } from 'zod';
import { AgentRelayError } from './errors';
import { idSchema, isoDateTime, taskStatusSchema } from './models';
import { hasControlCharacter } from './operations';
import type { TaskStatus } from './workflow';

/* -------------------------------------------------------------------------- */
/* Hierarchy                                                                   */
/* -------------------------------------------------------------------------- */

/** The authored levels. A task is not one of them: it is placed under an epic. */
export const ROADMAP_NODE_KINDS = ['goal', 'phase', 'epic'] as const;
export type RoadmapNodeKind = (typeof ROADMAP_NODE_KINDS)[number];

/**
 * The only parent kind each node kind may have.
 *
 * Exactly one level up, never skipping one. That is also why a parent chain
 * cannot loop: a phase's parent is a goal, and a goal has no parent.
 */
export const ROADMAP_PARENT_KIND: { readonly [K in RoadmapNodeKind]: RoadmapNodeKind | null } = {
  goal: null,
  phase: 'goal',
  epic: 'phase'
};

/** A kind as a sentence names it: "a goal", "an epic". */
export const ROADMAP_KIND_NOUN: { readonly [K in RoadmapNodeKind]: string } = {
  goal: 'a goal',
  phase: 'a phase',
  epic: 'an epic'
};

/** Bounds on what an operator can author. Tasks are not bounded here: they already exist. */
export const ROADMAP_LIMITS = {
  nodesPerProject: 2_000,
  dependenciesPerProject: 5_000,
  acceptanceCriteriaPerNode: 50,
  titleLength: 200,
  criterionLength: 2_000,
  descriptionLength: 20_000
} as const;

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One line of authored text, validated as it is stored.
 *
 * Refused rather than trimmed: this is the persisted shape, and a schema that
 * rewrote a stored value on read would make a row and its parse disagree.
 * Normalising what a person typed belongs to the authoring input (13C).
 */
function lineTextSchema(what: string, max: number) {
  return z
    .string()
    .min(1, `A ${what} cannot be empty.`)
    .max(max, `A ${what} may be at most ${max} characters.`)
    .refine((value) => value === value.trim(), `A ${what} may not start or end with whitespace.`)
    .refine((value) => !hasControlCharacter(value), `A ${what} may not contain control characters.`);
}

export const roadmapTitleSchema = lineTextSchema('roadmap title', ROADMAP_LIMITS.titleLength);

/** Free prose: may be empty, and may break lines; nothing else below U+0020 is accepted. */
export const roadmapDescriptionSchema = z
  .string()
  .max(
    ROADMAP_LIMITS.descriptionLength,
    `A roadmap description may be at most ${ROADMAP_LIMITS.descriptionLength} characters.`
  )
  .refine(
    (value) => !hasControlCharacter(value.replace(/[\t\n\r]/g, '')),
    'A roadmap description may not contain control characters other than tabs and line breaks.'
  );

/* -------------------------------------------------------------------------- */
/* Acceptance criteria                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One statement that must hold before a person accepts the node.
 *
 * The id is the identity and the array order is only display order — an index
 * is not an identity once criteria are inserted, removed or reordered. Tasks keep
 * their own criteria in their specification; the roadmap never copies them.
 */
export const roadmapAcceptanceCriterionSchema = z
  .object({
    id: idSchema,
    text: lineTextSchema('acceptance criterion', ROADMAP_LIMITS.criterionLength)
  })
  .strict();
export type RoadmapAcceptanceCriterion = z.infer<typeof roadmapAcceptanceCriterionSchema>;

export const roadmapAcceptanceCriteriaSchema = z
  .array(roadmapAcceptanceCriterionSchema)
  .max(
    ROADMAP_LIMITS.acceptanceCriteriaPerNode,
    `A roadmap node may have at most ${ROADMAP_LIMITS.acceptanceCriteriaPerNode} acceptance criteria.`
  )
  .superRefine((criteria, context) => {
    const seen = new Set<string>();
    criteria.forEach((criterion, index) => {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Acceptance criterion id ${criterion.id} is used twice.`
        });
      }
      seen.add(criterion.id);
    });
  });

/* -------------------------------------------------------------------------- */
/* Node state                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one status a person writes on a node.
 *
 * `accepted` is a human confirmation that the node's acceptance criteria hold.
 * It is deliberately not "every task completed": merged work and accepted work
 * are different facts, and only the second may satisfy a dependency. Everything
 * else a node shows — empty, not started, in progress, awaiting acceptance — is
 * derived from its tasks and never stored.
 */
export const ROADMAP_NODE_STATES = ['open', 'accepted', 'cancelled'] as const;
export type RoadmapNodeState = (typeof ROADMAP_NODE_STATES)[number];

export const ROADMAP_NODE_EVENTS = ['accept', 'cancel', 'reopen'] as const;
export type RoadmapNodeEvent = (typeof ROADMAP_NODE_EVENTS)[number];

/**
 * Legal moves of a node's authored state.
 *
 * Reopening never cascades, in either direction. A reopened parent keeps its
 * accepted and cancelled children as they are, because an open node may hold
 * closed children — that is how acceptance proceeds from the bottom up. A child
 * cannot be reopened under a closed parent (the structure check refuses an open
 * child of a closed node), so reopening runs from the top down, one node at a
 * time, each an explicit decision.
 */
export const ROADMAP_NODE_TRANSITIONS: {
  readonly [S in RoadmapNodeState]: { readonly [E in RoadmapNodeEvent]?: RoadmapNodeState };
} = {
  open: { accept: 'accepted', cancel: 'cancelled' },
  accepted: { reopen: 'open' },
  cancelled: { reopen: 'open' }
};

/** Accepted and cancelled nodes are closed: their subtree may hold no open work. */
export function isRoadmapNodeClosed(state: RoadmapNodeState): boolean {
  return state !== 'open';
}

/**
 * Apply `event` to a node's authored state.
 *
 * @throws {AgentRelayError} `INVALID_TRANSITION` for a move not in {@link ROADMAP_NODE_TRANSITIONS}.
 */
export function transitionRoadmapNode(state: RoadmapNodeState, event: RoadmapNodeEvent): RoadmapNodeState {
  const next = ROADMAP_NODE_TRANSITIONS[state][event];
  if (next === undefined) {
    throw new AgentRelayError('INVALID_TRANSITION', `A roadmap node that is ${state} cannot be sent "${event}".`, {
      details: `from=${state} event=${event}`
    });
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** Order among siblings. Unique within a sibling group; gaps carry no meaning. */
export const roadmapPositionSchema = z.number().int().nonnegative();

export const roadmapNodeSchema = z
  .object({
    /** Minted once and never changed: a move changes `parentId`, never `id`. */
    id: idSchema,
    projectId: idSchema,
    kind: z.enum(ROADMAP_NODE_KINDS),
    /** Null exactly for a goal; otherwise a node of kind {@link ROADMAP_PARENT_KIND}[kind]. */
    parentId: idSchema.nullable(),
    title: roadmapTitleSchema,
    description: roadmapDescriptionSchema,
    acceptanceCriteria: roadmapAcceptanceCriteriaSchema,
    position: roadmapPositionSchema,
    state: z.enum(ROADMAP_NODE_STATES),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict()
  .superRefine((node, context) => {
    if (node.kind === 'goal' && node.parentId !== null) {
      context.addIssue({ code: 'custom', path: ['parentId'], message: 'A goal has no parent.' });
    }
    const parentKind = ROADMAP_PARENT_KIND[node.kind];
    if (parentKind !== null && node.parentId === null) {
      context.addIssue({
        code: 'custom',
        path: ['parentId'],
        message: `The parent of ${ROADMAP_KIND_NOUN[node.kind]} must be ${ROADMAP_KIND_NOUN[parentKind]}.`
      });
    }
    if (node.parentId === node.id) {
      context.addIssue({ code: 'custom', path: ['parentId'], message: 'A roadmap node cannot be its own parent.' });
    }
  });
export type RoadmapNode = z.infer<typeof roadmapNodeSchema>;

/**
 * A task attached to an epic.
 *
 * At most one per task, and only ever to an epic: the task row stays where it
 * is and keeps every workflow field; this row only says where the task sits.
 */
export const roadmapTaskPlacementSchema = z
  .object({
    taskId: idSchema,
    projectId: idSchema,
    epicId: idSchema,
    position: roadmapPositionSchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type RoadmapTaskPlacement = z.infer<typeof roadmapTaskPlacementSchema>;

export type RoadmapTaskLocation =
  | { readonly kind: 'epic'; readonly epicId: string; readonly position: number }
  | { readonly kind: 'unassigned' };

/** Where a task sits. Expects placements that passed the structure check (at most one per task). */
export function roadmapTaskLocation(
  taskId: string,
  placements: readonly RoadmapTaskPlacement[]
): RoadmapTaskLocation {
  const placement = placements.find((candidate) => candidate.taskId === taskId);
  return placement === undefined
    ? { kind: 'unassigned' }
    : { kind: 'epic', epicId: placement.epicId, position: placement.position };
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

/** Either end of a dependency: a node of any level, or an existing task. */
export const roadmapItemRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), nodeId: idSchema }).strict(),
  z.object({ kind: z.literal('task'), taskId: idSchema }).strict()
]);
export type RoadmapItemRef = z.infer<typeof roadmapItemRefSchema>;

/** A stable key for a reference; a node id and a task id can never produce the same key. */
export function roadmapItemKey(ref: RoadmapItemRef): string {
  return ref.kind === 'node' ? `node:${ref.nodeId}` : `task:${ref.taskId}`;
}

/**
 * `dependent` may not start until `prerequisite` is satisfied.
 *
 * Satisfaction, inheritance by descendants and the cycle rule are defined in
 * docs/roadmap.md and evaluated by the roadmap services; this is the stored edge.
 */
export const roadmapDependencySchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    dependent: roadmapItemRefSchema,
    prerequisite: roadmapItemRefSchema,
    createdAt: isoDateTime
  })
  .strict()
  .superRefine((dependency, context) => {
    if (roadmapItemKey(dependency.dependent) === roadmapItemKey(dependency.prerequisite)) {
      context.addIssue({
        code: 'custom',
        path: ['prerequisite'],
        message: 'An item cannot depend on itself.'
      });
    }
  });
export type RoadmapDependency = z.infer<typeof roadmapDependencySchema>;

/* -------------------------------------------------------------------------- */
/* Progress inputs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the roadmap reads about an existing task — read, never stored by it.
 *
 * `status` is the task row's workflow status and `continuedByTaskId` the
 * continuation recorded for it, if any. Both are owned by the workflow.
 */
export const roadmapTaskFactSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    status: taskStatusSchema,
    continuedByTaskId: idSchema.nullable()
  })
  .strict();
export type RoadmapTaskFact = z.infer<typeof roadmapTaskFactSchema>;

/**
 * What a task contributes to progress.
 *
 * - `not_started`: nothing has been produced yet (DRAFT).
 * - `in_progress`: any other non-terminal status.
 * - `done`: COMPLETED.
 * - `stopped`: a terminal outcome that delivered nothing — the work is still owed.
 * - `superseded`: stopped, and continued by another task that now carries the work.
 * - `cancelled`: abandoned on purpose.
 */
export const TASK_PROGRESS_KINDS = [
  'not_started',
  'in_progress',
  'done',
  'stopped',
  'superseded',
  'cancelled'
] as const;
export type TaskProgressKind = (typeof TASK_PROGRESS_KINDS)[number];

/**
 * Every workflow status and what it means for progress.
 *
 * A total record on purpose: adding a status to the workflow does not compile
 * until someone decides what it means here. The stopped statuses are exactly
 * the ones a continuation may start from.
 */
export const TASK_STATUS_PROGRESS: {
  readonly [S in TaskStatus]: Exclude<TaskProgressKind, 'superseded'>;
} = {
  DRAFT: 'not_started',
  SPECIFYING: 'in_progress',
  READY_FOR_IMPLEMENTATION: 'in_progress',
  IMPLEMENTING: 'in_progress',
  VERIFYING: 'in_progress',
  READY_FOR_REVIEW: 'in_progress',
  REVIEWING: 'in_progress',
  CHANGES_REQUESTED: 'in_progress',
  APPROVED: 'in_progress',
  READY_TO_PUBLISH: 'in_progress',
  PUBLISHING: 'in_progress',
  COMPLETED: 'done',
  REVIEW_LIMIT_REACHED: 'stopped',
  REVIEW_BLOCKED: 'stopped',
  FAILED: 'stopped',
  CANCELLED: 'cancelled'
};

/**
 * A task's progress kind, derived from the workflow's own facts.
 *
 * A continuation replaces only a stopped task. A continuation recorded against
 * any other status is not the roadmap's to reinterpret, so the status wins.
 */
export function taskProgressKind(
  fact: Pick<RoadmapTaskFact, 'status' | 'continuedByTaskId'>
): TaskProgressKind {
  const kind = TASK_STATUS_PROGRESS[fact.status];
  return kind === 'stopped' && fact.continuedByTaskId !== null ? 'superseded' : kind;
}

/**
 * Whether a task of this kind belongs in a progress total.
 *
 * Cancelled work was dropped and superseded work lives on in its successor, so
 * neither is owed. A stopped task is: it counts, and it is not done.
 */
export function countsTowardProgress(kind: TaskProgressKind): boolean {
  return kind !== 'cancelled' && kind !== 'superseded';
}
