/**
 * The Agent Relay task workflow, expressed as an explicit finite state machine.
 *
 * This module is deliberately free of I/O: it is pure data plus pure functions so
 * that it can be exhaustively unit tested, and so that *every* status change in
 * the application has to go through one auditable place.
 *
 * Rule of the house: a status is only ever changed by calling {@link transition}.
 * Repositories persist whatever the machine returns; they never invent a status.
 */

import { InvalidTransitionError } from './errors';

export const TASK_STATUSES = [
  'DRAFT',
  'SPECIFYING',
  'READY_FOR_IMPLEMENTATION',
  'IMPLEMENTING',
  'READY_FOR_REVIEW',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'APPROVED',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKFLOW_EVENTS = [
  'specification_started',
  'specification_completed',
  'specification_failed',
  'specification_retry',
  'specification_aborted',
  'implementation_started',
  'implementation_completed',
  'implementation_failed',
  'implementation_aborted',
  'correction_aborted',
  'review_started',
  'review_approved',
  'review_changes_requested',
  'review_blocked',
  'review_failed',
  'review_aborted',
  'corrections_sent',
  'max_rounds_reached',
  'publish_approved',
  'publish_started',
  'publish_step_completed',
  'publish_completed',
  'publish_failed',
  'publish_aborted',
  'cancelled'
] as const;

export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Statuses in which an agent process may currently be running. Used to block a
 * second concurrent run against the same task and to decide whether "Stop" is
 * meaningful.
 */
export const BUSY_STATUSES: readonly TaskStatus[] = [
  'SPECIFYING',
  'IMPLEMENTING',
  'REVIEWING',
  'PUBLISHING'
];

type TransitionTable = {
  readonly [S in TaskStatus]: { readonly [E in WorkflowEvent]?: TaskStatus };
};

/**
 * The single source of truth for legal moves.
 *
 * Read it as: "while the task is in <status>, event <event> moves it to <status>".
 * Anything not listed here is rejected by {@link transition}.
 */
export const TRANSITIONS: TransitionTable = {
  DRAFT: {
    specification_started: 'SPECIFYING',
    cancelled: 'CANCELLED'
  },
  SPECIFYING: {
    specification_completed: 'READY_FOR_IMPLEMENTATION',
    specification_failed: 'FAILED',
    // A *recoverable* failure (Codex offline, unparseable JSON, timeout) returns
    // the task to where it can simply be retried, rather than killing it. The
    // Codex thread id is preserved, so a retry continues the same conversation.
    specification_aborted: 'DRAFT',
    cancelled: 'CANCELLED'
  },
  READY_FOR_IMPLEMENTATION: {
    // Regenerating the spec (e.g. the user did not like it, or parsing failed).
    specification_retry: 'SPECIFYING',
    implementation_started: 'IMPLEMENTING',
    cancelled: 'CANCELLED'
  },
  IMPLEMENTING: {
    implementation_completed: 'READY_FOR_REVIEW',
    implementation_failed: 'FAILED',
    // Recoverable failure during the first implementation round.
    implementation_aborted: 'READY_FOR_IMPLEMENTATION',
    // Recoverable failure during a correction round — back to the review result
    // so the same corrections can be re-sent.
    correction_aborted: 'CHANGES_REQUESTED',
    cancelled: 'CANCELLED'
  },
  READY_FOR_REVIEW: {
    review_started: 'REVIEWING',
    cancelled: 'CANCELLED'
  },
  REVIEWING: {
    review_approved: 'APPROVED',
    review_changes_requested: 'CHANGES_REQUESTED',
    review_blocked: 'FAILED',
    review_failed: 'FAILED',
    review_aborted: 'READY_FOR_REVIEW',
    cancelled: 'CANCELLED'
  },
  CHANGES_REQUESTED: {
    corrections_sent: 'IMPLEMENTING',
    max_rounds_reached: 'FAILED',
    cancelled: 'CANCELLED'
  },
  APPROVED: {
    // Requires an explicitly granted publishing approval; see `assertPublishable`.
    publish_approved: 'READY_TO_PUBLISH',
    cancelled: 'CANCELLED'
  },
  READY_TO_PUBLISH: {
    publish_started: 'PUBLISHING',
    // Explicit "I'm done" without opening a pull request.
    publish_completed: 'COMPLETED',
    // A round can be approved by a reviewer and still be refused by the publish
    // gate — a reviewer reads the change, the gate checks whether it was ever
    // run. Without this edge that combination is a dead end: the only way out
    // would be to cancel a task whose code is probably fine and needs one more
    // round. Going back through IMPLEMENTING means the new round must be
    // reviewed and approved again before it can be published.
    corrections_sent: 'IMPLEMENTING',
    cancelled: 'CANCELLED'
  },
  PUBLISHING: {
    // Publishing is a sequence (commit -> create repo -> push -> open PR), so an
    // individual step returns to READY_TO_PUBLISH for the next one. Only opening
    // the pull request, or an explicit finish, completes the task.
    publish_step_completed: 'READY_TO_PUBLISH',
    publish_completed: 'COMPLETED',
    publish_failed: 'FAILED',
    // A publish step that failed before changing anything remote (e.g. `gh` was
    // logged out) returns to the approved-to-publish state so it can be retried.
    publish_aborted: 'READY_TO_PUBLISH',
    cancelled: 'CANCELLED'
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {}
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isBusy(status: TaskStatus): boolean {
  return BUSY_STATUSES.includes(status);
}

/** All events that are currently legal for `status`. */
export function allowedEvents(status: TaskStatus): WorkflowEvent[] {
  return Object.keys(TRANSITIONS[status]) as WorkflowEvent[];
}

export function canTransition(status: TaskStatus, event: WorkflowEvent): boolean {
  return TRANSITIONS[status][event] !== undefined;
}

/**
 * Apply `event` to `status`.
 *
 * @throws {InvalidTransitionError} when the move is not in {@link TRANSITIONS}.
 */
export function transition(status: TaskStatus, event: WorkflowEvent): TaskStatus {
  const next = TRANSITIONS[status][event];
  if (next === undefined) {
    throw new InvalidTransitionError(status, event);
  }
  return next;
}

/**
 * Decide what a Codex review verdict means for the workflow, taking the review
 * round budget into account.
 *
 * This is the rule that guarantees the relay loop terminates: once
 * `roundsUsed >= maxRounds` a `changes_requested` verdict can no longer be
 * turned into another Claude correction round.
 */
export interface ReviewOutcomeDecision {
  /** Event to apply to a task currently in REVIEWING. */
  readonly event: Extract<
    WorkflowEvent,
    'review_approved' | 'review_changes_requested' | 'review_blocked'
  >;
  /** True when the orchestrator may start another Claude correction round. */
  readonly canContinue: boolean;
  /** Set when the loop must halt because the round budget is exhausted. */
  readonly haltReason?: string;
}

export function decideReviewOutcome(
  verdict: 'approved' | 'changes_requested' | 'blocked',
  roundsUsed: number,
  maxRounds: number
): ReviewOutcomeDecision {
  if (verdict === 'approved') {
    return { event: 'review_approved', canContinue: false };
  }
  if (verdict === 'blocked') {
    return { event: 'review_blocked', canContinue: false };
  }
  if (roundsUsed >= maxRounds) {
    return {
      event: 'review_changes_requested',
      canContinue: false,
      haltReason: `Review round limit reached (${roundsUsed}/${maxRounds}). Codex still requested changes; the relay loop was stopped so it cannot run forever.`
    };
  }
  return { event: 'review_changes_requested', canContinue: true };
}

/**
 * Publishing gate used by the domain layer.
 *
 * Even if a caller somehow reaches the publish code path, it cannot proceed
 * without a granted approval for the specific action.
 */
export function assertPublishable(
  status: TaskStatus,
  approvalGranted: boolean,
  action: string
): void {
  if (!approvalGranted) {
    throw new InvalidTransitionError(status, `publish:${action}`);
  }
  if (status !== 'READY_TO_PUBLISH' && status !== 'PUBLISHING') {
    throw new InvalidTransitionError(status, `publish:${action}`, 'PUBLISHING');
  }
}

/** Human-readable label used in the UI timeline. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  DRAFT: 'Draft',
  SPECIFYING: 'Specifying',
  READY_FOR_IMPLEMENTATION: 'Ready for implementation',
  IMPLEMENTING: 'Implementing',
  READY_FOR_REVIEW: 'Ready for review',
  REVIEWING: 'Reviewing',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  READY_TO_PUBLISH: 'Ready to publish',
  PUBLISHING: 'Publishing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled'
};
