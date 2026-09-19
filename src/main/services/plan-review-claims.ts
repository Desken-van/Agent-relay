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
import type { PlanCorrectionLoopPhase } from '../../shared/domain/plan-correction';

/**
 * The operations that reach an external provider (Coai or Codex) and must not
 * overlap. `advance` is the whole correction loop: it holds the task for its
 * entire run and drives the other operations itself, so nothing can slip in
 * between two of its steps.
 */
export type PlanReviewOperation = 'review' | 'reconcile' | 'resolve' | 'triage' | 'advance';

/** What the correction loop is doing, published for the detail read while it runs. */
export interface PlanCorrectionLoopState {
  readonly phase: PlanCorrectionLoopPhase;
  readonly round: number;
}

const BUSY_REMEDIATION =
  'Wait for the operation in flight to finish, then read the gate again before starting another.';

export class PlanReviewClaims {
  private readonly exclusive = new Map<string, PlanReviewOperation>();
  /**
   * Findings being analyzed right now, per task. Analysis of one finding is
   * read-only towards every provider, so several DIFFERENT findings may be
   * analyzed at once; anything that writes or dispatches is exclusive against
   * all of them.
   */
  private readonly analyzing = new Map<string, Set<number>>();
  private readonly loops = new Map<string, PlanCorrectionLoopState>();

  /**
   * Take the exclusive claim for a task, or refuse.
   *
   * Returns the release function. It is idempotent, so a `finally` that runs
   * twice cannot hand the claim to a caller that never took it.
   */
  acquire(taskId: string, operation: PlanReviewOperation): () => void {
    const current = this.heldBy(taskId);
    if (current !== null) {
      throw new AgentRelayError(
        'BUSY',
        `An external plan-review ${current} is already running for this task.`,
        { remediation: BUSY_REMEDIATION }
      );
    }
    this.exclusive.set(taskId, operation);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exclusive.delete(taskId);
      this.loops.delete(taskId);
    };
  }

  /**
   * Take a shared claim on ONE finding's analysis, or refuse.
   *
   * Refused while any exclusive operation holds the task, and refused for a
   * finding that is already being analyzed — two analyses of the same finding
   * would race to write different answers.
   */
  acquireFinding(taskId: string, findingIndex: number): () => void {
    const exclusive = this.exclusive.get(taskId);
    if (exclusive !== undefined) {
      throw new AgentRelayError(
        'BUSY',
        `An external plan-review ${exclusive} is already running for this task.`,
        { remediation: BUSY_REMEDIATION }
      );
    }
    const held = this.analyzing.get(taskId) ?? new Set<number>();
    if (held.has(findingIndex)) {
      throw new AgentRelayError('BUSY', 'This finding is already being analyzed.', {
        remediation: 'Wait for its result.'
      });
    }
    held.add(findingIndex);
    this.analyzing.set(taskId, held);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.analyzing.get(taskId);
      current?.delete(findingIndex);
      if (current !== undefined && current.size === 0) this.analyzing.delete(taskId);
    };
  }

  /** The findings being analyzed in this process right now, ascending. For the detail read. */
  analyzingFindings(taskId: string): number[] {
    return [...(this.analyzing.get(taskId) ?? [])].sort((a, b) => a - b);
  }

  /** Publish the loop's phase. Cleared automatically when its claim is released. */
  setLoop(taskId: string, state: PlanCorrectionLoopState): void {
    if (this.exclusive.get(taskId) === 'advance') this.loops.set(taskId, state);
  }

  /** The correction loop running for this task in this process, if any. */
  loopOf(taskId: string): PlanCorrectionLoopState | null {
    return this.loops.get(taskId) ?? null;
  }

  /** The operation holding this task's claim, if any. For diagnostics only. */
  heldBy(taskId: string): PlanReviewOperation | null {
    const exclusive = this.exclusive.get(taskId);
    if (exclusive !== undefined) return exclusive;
    return (this.analyzing.get(taskId)?.size ?? 0) > 0 ? 'triage' : null;
  }
}
