/**
 * Typed client for the preload bridge.
 *
 * Two shapes are offered on purpose:
 *
 *   `call`   — returns the discriminated result, for call sites that want to
 *              render the error inline (most of the UI).
 *   `expect` — throws {@link ApiError}, for call sites inside a try/catch.
 *
 * Neither knows anything about how the operation is carried out. The renderer's
 * entire view of the outside world is this file.
 */

import type { SerializedError } from '@shared/domain/errors';
import type { IpcChannel, IpcInput, IpcResponseMap, IpcResult } from '@shared/ipc';

export class ApiError extends Error {
  readonly code: SerializedError['code'];
  readonly remediation: string | undefined;
  readonly details: string | undefined;

  constructor(error: SerializedError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.remediation = error.remediation;
    this.details = error.details;
  }
}

export async function call<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>
): Promise<IpcResult<IpcResponseMap[C]>> {
  if (typeof window.agentRelay?.invoke !== 'function') {
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'The Agent Relay bridge is unavailable.',
        remediation: 'Restart the application.'
      }
    };
  }
  return window.agentRelay.invoke(channel, input);
}

export async function expect<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>
): Promise<IpcResponseMap[C]> {
  const result = await call(channel, input);
  if (!result.ok) throw new ApiError(result.error);
  return result.data;
}

export function describeError(error: unknown): SerializedError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error)
  };
}
