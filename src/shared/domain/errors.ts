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
