/**
 * Exclusive claims on the external plan-review operations of one task.
 *
 * ## Why this is not a renderer concern
 *
 * The renderer's synchronous ref stops one screen double-submitting, and that
 * is all it can do. It cannot stop a second window, a direct IPC call, or the
 * same screen after a navigation that unmounted and remounted the panel: the
 * only state a remount is guaranteed to lose is the renderer's own. `open`,
 * `review_plan` and `resolve` are not idempotent, so the arbitration has to
 * live where the calls are actually made.
 *
 * ## Why it is not durable
 *
 * A claim is deliberately in-memory and dies with the process. It means "a call
 * is in flight right now", which is only ever true of a live process — nothing
 * here can be in flight across a restart. What survives a restart is the gate's
 * durable phase (`opening`, `reviewing`, `resolving`), and that already says
 * "dispatched, outcome unknown" and already demands a reconciliation before
 * anything is dispatched again. Persisting the claim would add a lock that
 * outlives the thing it protects and would have to be broken by hand.
 *
 * One instance is shared by every service built for the process, so the map is
 * the process-wide truth rather than a per-call-site opinion.
 */

import { AgentRelayError } from '../../shared/domain/errors';

/** The three operations that reach the provider and must not overlap. */
export type PlanReviewOperation = 'review' | 'reconcile' | 'resolve';

export class PlanReviewClaims {
  private readonly held = new Map<string, PlanReviewOperation>();

  /**
   * Take the claim for a task, or refuse.
   *
   * Returns the release function. It is idempotent, so a `finally` that runs
   * twice cannot hand the claim to a caller that never took it.
   */
  acquire(taskId: string, operation: PlanReviewOperation): () => void {
    const current = this.held.get(taskId);
    if (current !== undefined) {
      throw new AgentRelayError(
        'BUSY',
        `An external plan-review ${current} is already running for this task.`,
        {
          remediation:
            'Wait for the operation in flight to finish, then read the gate again before starting another.'
        }
      );
    }
    this.held.set(taskId, operation);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(taskId);
    };
  }

  /** The operation holding this task's claim, if any. For diagnostics only. */
  heldBy(taskId: string): PlanReviewOperation | null {
    return this.held.get(taskId) ?? null;
  }
}
