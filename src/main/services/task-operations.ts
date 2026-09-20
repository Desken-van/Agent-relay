/**
 * The process-wide register of operations that are running for a task and can
 * be stopped.
 *
 * `Orchestrator.stop()` used to know only its own agent runs, so an operation
 * that lives elsewhere — the plan-correction loop, an external plan-review call, a
 * code-review round, an analysis or an Auto decide — was invisible to it: Stop moved
 * the task to CANCELLED and the operation carried on in the background, free to
 * write a specification, a review result or a decision, or to start another provider
 * call, for a task that had already ended. This registry is what Stop consults for
 * everything that is not an agent run.
 *
 * It is built ONCE, in the composition root, and handed to the orchestrator and to
 * every service that runs an external call for a task, however that service is
 * built. A per-call instance would give each invocation a private map and stop
 * nothing. In memory on purpose: an entry means
 * "a call is in flight in this process right now", which is only ever true of a
 * live process; what survives a crash is the durable status of the rows.
 *
 * This is deliberately separate from `PlanReviewClaims`. Claims arbitrate which
 * plan-review operations may overlap; this decides who can be cancelled. The two
 * answer different questions and each keeps its own guarantees.
 */

import { AgentRelayError } from '../../shared/domain/errors';

export type TaskOperationKind =
  | 'plan_correction'
  | 'plan_review'
  | 'plan_reconcile'
  | 'plan_resolve'
  | 'plan_triage'
  | 'plan_auto_decide'
  | 'code_review'
  | 'code_reconcile'
  | 'code_triage'
  | 'code_auto_decide';

export interface TaskOperation {
  readonly kind: TaskOperationKind;
  /** The one signal every step of the operation must observe: Stop aborts it, and so does the caller's own. */
  readonly signal: AbortSignal;
  /** Idempotent. Always called in a `finally`, so an operation can never leave a stale entry behind. */
  release(): void;
}

interface Entry {
  readonly kind: TaskOperationKind;
  readonly exclusive: boolean;
  readonly controller: AbortController;
}

/**
 * What an operation should throw when it ends after a stop.
 *
 * A stop kills a provider's process or request, and what the provider throws for
 * that is up to its adapter — usually a typed CANCELLED, but a generic exit or
 * transport error is possible. Whatever it was, an operation whose own signal was
 * aborted ended because it was stopped, so it is reported as a stop and not as a
 * fault of the provider. An error that is already a CANCELLED is kept as it is.
 */
export function asStopped(error: unknown, signal: AbortSignal | undefined, message: string): unknown {
  if (signal?.aborted !== true) return error;
  if (error instanceof AgentRelayError && error.code === 'CANCELLED') return error;
  return new AgentRelayError('CANCELLED', message, { cause: error });
}

/**
 * Run `body` as a registered, stoppable operation: register it (so Stop can reach
 * it), take the caller's overlap claim, and release both whatever happens.
 *
 * The registration comes first because a refusal there costs nothing, and the
 * claim is released before the registration so a task is never visible as
 * stoppable with nothing behind it. Whatever `body` throws after its signal was
 * aborted is reported as a stop (see {@link asStopped}); an ordinary failure is
 * reported as itself.
 *
 * Shared by every service that runs an external call for a task — the plan gate and
 * the code-review service — so there is one registration discipline and not two that
 * drift.
 */
export async function runAsOperation<T>(
  operations: TaskOperationRegistry,
  taskId: string,
  kind: TaskOperationKind,
  options: {
    readonly exclusive: boolean;
    readonly signal?: AbortSignal;
    /** Takes the caller's own overlap claim once registered, and returns its release. */
    readonly claim: () => () => void;
    /** What a body that ends after the stop is reported as. */
    readonly stoppedMessage: string;
  },
  body: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const operation = operations.begin(taskId, kind, { exclusive: options.exclusive, signal: options.signal });
  try {
    const release = options.claim();
    try {
      return await body(operation.signal);
    } catch (error) {
      throw asStopped(error, operation.signal, options.stoppedMessage);
    } finally {
      release();
    }
  } finally {
    operation.release();
  }
}

export class TaskOperationRegistry {
  private readonly active = new Map<string, Set<Entry>>();

  /**
   * Register an operation for a task, or refuse.
   *
   * An `exclusive` operation is refused while anything else is registered for the
   * task; a shared one (the analysis of one finding, of which several different
   * findings may run at once) is refused only while an exclusive one is. Any
   * `signal` the caller passes is linked to the operation's own controller, so
   * aborting either stops the work.
   */
  begin(
    taskId: string,
    kind: TaskOperationKind,
    options: { readonly exclusive: boolean; readonly signal?: AbortSignal }
  ): TaskOperation {
    const held = this.active.get(taskId);
    if (held !== undefined && held.size > 0) {
      const blocking = [...held].find((entry) => entry.exclusive || options.exclusive);
      if (blocking !== undefined) {
        throw new AgentRelayError(
          'BUSY',
          `This task already has an operation running (${blocking.kind.replace(/_/g, ' ')}). Stop it or wait for it to finish.`,
          { remediation: 'Wait for the operation in flight to finish, or stop the task.' }
        );
      }
    }

    const controller = new AbortController();
    const entry: Entry = { kind, exclusive: options.exclusive, controller };
    const caller = options.signal;
    const linked = (): void => controller.abort(caller?.reason);
    if (caller?.aborted) controller.abort(caller.reason);
    else caller?.addEventListener('abort', linked, { once: true });

    const set = held ?? new Set<Entry>();
    set.add(entry);
    this.active.set(taskId, set);

    let released = false;
    return {
      kind,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        caller?.removeEventListener('abort', linked);
        const current = this.active.get(taskId);
        current?.delete(entry);
        if (current !== undefined && current.size === 0) this.active.delete(taskId);
      }
    };
  }

  /** Abort everything registered for the task. Returns how many operations were signalled. */
  abort(taskId: string): number {
    const held = this.active.get(taskId);
    if (held === undefined) return 0;
    let signalled = 0;
    for (const entry of [...held]) {
      if (!entry.controller.signal.aborted) signalled += 1;
      entry.controller.abort();
    }
    return signalled;
  }

  /** Whether any stoppable operation is registered for the task. */
  isActive(taskId: string): boolean {
    return (this.active.get(taskId)?.size ?? 0) > 0;
  }
}
