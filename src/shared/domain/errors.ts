/**
 * Error types shared between the main process and the renderer.
 *
 * Every error that crosses the IPC boundary is normalised into
 * {@link SerializedError} so the renderer can render something actionable
 * instead of `[object Object]`, and so stack traces / environment details
 * never leak into the UI by accident.
 */

export type AgentRelayErrorCode =
  | 'INVALID_TRANSITION'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'TOOL_MISSING'
  | 'TOOL_UNAUTHENTICATED'
  | 'TOOL_FAILED'
  | 'GIT_DIRTY'
  | 'GIT_FAILED'
  | 'WORKTREE_CONFLICT'
  | 'WORKTREE_INVALID'
  | 'APPROVAL_REQUIRED'
  /** Another operation already holds the exclusive claim on this subject. */
  | 'BUSY'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'PARSE_FAILED'
  | 'UNSAFE_PATH'
  | 'INTERNAL';

export interface SerializedError {
  readonly code: AgentRelayErrorCode;
  readonly message: string;
  /** Operator-facing hint: what the user should actually do about it. */
  readonly remediation?: string;
  /** Safe, non-secret extra context (e.g. exit code, offending path). */
  readonly details?: string;
}

export class AgentRelayError extends Error {
  readonly code: AgentRelayErrorCode;
  readonly remediation: string | undefined;
  readonly details: string | undefined;

  constructor(
    code: AgentRelayErrorCode,
    message: string,
    options?: { remediation?: string; details?: string; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentRelayError';
    this.code = code;
    this.remediation = options?.remediation;
    this.details = options?.details;
  }

  toSerialized(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.remediation === undefined ? {} : { remediation: this.remediation }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

/**
 * Why a plan round was not sent or was refused before it existed — a KNOWN reason, never
 * an inference from a failure.
 *
 * Raised by the provider adapter, from the provider's own documented refusals:
 * - `plan_stage_over`: the session it was asked to review in has already moved past the
 *   plan stage, so it can run no further plan round.
 * - `no_session`: the provider holds no session for the repository and ref it was asked
 *   about, so nothing could have run.
 *
 * Raised by the gate service, from what `open` returned, BEFORE any round was sent:
 * - `session_foreign`: the session was already used by another plan review of the task.
 * - `session_not_fresh`: the session holds plan rounds, is awaiting a resolution, or could
 *   not be proven empty.
 * - `session_changed`: the session is not the one this review recorded.
 */
export type PlanReviewRefusalReason =
  | 'plan_stage_over'
  | 'no_session'
  | 'session_foreign'
  | 'session_not_fresh'
  | 'session_changed';

/**
 * The provider positively refused `review_plan` BEFORE creating a round.
 *
 * Recognised by type, never by parsing a message downstream: only the adapter, which
 * sees the provider's own words, may say a refusal is one of the documented ones. Every
 * other failure of the call — a timeout, a lost connection, a refusal in words this build
 * has not audited — stays an unknown outcome, because a request that reached the provider
 * and lost its answer looks exactly like one it never accepted. Its code is the ordinary
 * `TOOL_FAILED`, so a caller that does not care keeps the behaviour it always had.
 */
export class PlanReviewNotDispatchedError extends AgentRelayError {
  readonly reason: PlanReviewRefusalReason;

  constructor(reason: PlanReviewRefusalReason, message: string, options?: { remediation?: string }) {
    super('TOOL_FAILED', message, options);
    this.name = 'PlanReviewNotDispatchedError';
    this.reason = reason;
  }
}

/** Thrown by the domain layer when a workflow transition is not permitted. */
export class InvalidTransitionError extends AgentRelayError {
  constructor(from: string, event: string, to?: string) {
    super(
      'INVALID_TRANSITION',
      to
        ? `Cannot move a task from "${from}" to "${to}" via "${event}".`
        : `Event "${event}" is not allowed while a task is in state "${from}".`,
      { details: `from=${from} event=${event}${to ? ` to=${to}` : ''}` }
    );
    this.name = 'InvalidTransitionError';
  }
}

export function toSerializedError(error: unknown): SerializedError {
  if (error instanceof AgentRelayError) {
    return error.toSerialized();
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}
