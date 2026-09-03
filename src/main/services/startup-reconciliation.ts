/**
 * Putting the database back into a state a person can act on, after the
 * application stopped in the middle of something.
 *
 * A run is written as `running` before an agent is spawned and finished
 * afterwards, and a task is moved into a busy status around the same moment. If
 * the process dies in between — a crash, a machine reboot, someone closing the
 * window mid-round — those two rows are left claiming that work is in progress
 * that no longer is. Nothing later clears them: the orchestrator only ever
 * finishes runs it started itself, so on the next launch the task sits in
 * `IMPLEMENTING` for ever and every button that matters is disabled.
 *
 * This module answers one question: given what the database still claims, what
 * should be corrected? It is split in two on purpose.
 *
 * {@link planReconciliation} is pure. It takes the rows and returns the changes,
 * so the interesting decisions — which abort event a half-finished round
 * deserves, what to do when the evidence is contradictory — are testable
 * without a database, a clock, or a transaction.
 *
 * {@link applyReconciliation} performs that plan through the repositories,
 * inside one transaction, so a failure part-way leaves the database exactly as
 * it was rather than half-recovered.
 *
 * What it deliberately does **not** do: resume anything. No agent is started, no
 * Git command runs, no worktree is touched, no session or thread id is
 * disturbed, no round is counted, and no approval is granted or revoked. The
 * point is to hand the work back to the user in a state they can restart
 * themselves — not to guess that restarting is what they wanted.
 */

import type { Run, RunType, Task } from '../../shared/domain/models';
import { canTransition, transition, type TaskStatus, type WorkflowEvent } from '../../shared/domain/workflow';
import type {
  Clock,
  OperationDiagnosticRepository,
  RunRepository,
  TaskRepository,
  TransactionRunner
} from '../ports';

/**
 * What a recovered run and task are told about themselves.
 *
 * Deliberately flat and factual. It is not an error the user caused, and it is
 * not a result: it is the absence of one.
 */
export const INTERRUPTION_REASON =
  'Agent Relay stopped before this run completed; recovered during startup.';

/**
 * What a recovered diagnostic run is told about itself.
 *
 * Worded to say the outcome is *unknown*, not that the probe failed. A probe
 * that was interrupted may well have been about to succeed; recording it as a
 * failure of the target would be a claim about that target which nothing here
 * has any evidence for.
 */
export const DIAGNOSTIC_INTERRUPTION_REASON =
  'Agent Relay stopped before this diagnostic finished; its result is unknown.';

export interface RunClosure {
  readonly runId: string;
  readonly taskId: string;
  readonly runType: RunType;
  readonly reason: string;
}

export interface TaskRecovery {
  readonly taskId: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly event: WorkflowEvent;
  readonly reason: string;
}

/** A diagnostic run an abrupt exit left open. */
export interface DiagnosticClosure {
  readonly diagnosticId: string;
  readonly targetId: string;
  readonly reason: string;
}

export interface ReconciliationPlan {
  readonly closures: readonly RunClosure[];
  readonly recoveries: readonly TaskRecovery[];
  /**
   * Interrupted read-only diagnostics.
   *
   * Kept as its own list rather than folded into {@link closures}: a
   * diagnostic belongs to an operational target, not to a task, and nothing
   * about the development workflow should have to filter it out.
   */
  readonly diagnostics: readonly DiagnosticClosure[];
}

export const EMPTY_PLAN: ReconciliationPlan = { closures: [], recoveries: [], diagnostics: [] };

/** Everything the plan is derived from. */
export interface InterruptedWork {
  /** Every diagnostic run still marked `running`, whatever target it belongs to. */
  readonly runningDiagnostics?: readonly { id: string; targetId: string }[];
  /** Every run still marked `running`, whatever task it belongs to. */
  readonly runningRuns: readonly Run[];
  /** Every task sitting in a busy status. */
  readonly busyTasks: readonly Task[];
}

/** The abort event each busy status is recovered with. */
const RECOVERY_EVENTS: Partial<Record<TaskStatus, WorkflowEvent>> = {
  SPECIFYING: 'specification_aborted',
  REVIEWING: 'review_aborted',
  PUBLISHING: 'publish_aborted'
};

/** Claude rounds, which are the only ones `IMPLEMENTING` can have been running. */
const CLAUDE_ROUNDS: readonly RunType[] = ['implementation', 'correction'];

/**
 * Order two candidate runs, most authoritative first.
 *
 * Greatest round, then latest start, then greatest id. The last key is not
 * meaningful on its own — it is there so two runs that are otherwise identical
 * still order the same way every time, rather than however SQLite returned them.
 */
function mostAuthoritativeFirst(a: Run, b: Run): number {
  if (a.round !== b.round) return b.round - a.round;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Which kind of Claude round a task in `IMPLEMENTING` was part-way through.
 *
 * Only two things are allowed to answer this, in order.
 *
 *  1. **A run still marked `running` for the current round.** The orchestrator
 *     writes a run with `round: task.currentRound`, so a running row carrying
 *     that round is the work that was actually in flight. Several of them is not
 *     expected; if it happens, {@link mostAuthoritativeFirst} picks one the same
 *     way every time.
 *
 *  2. **The round counter.** The first implementation sets `currentRound` to 1
 *     and every `corrections_sent` increments it, so a task sitting in
 *     `IMPLEMENTING` at round 2 or higher can only have got there through a
 *     correction. At round 1 or below it is the first implementation.
 *
 * What is deliberately **not** consulted is the task's finished runs. That was
 * the original rule and it was wrong in the case that matters most: between
 * `corrections_sent` and the recorder writing the new run, the most recent
 * Claude run is still the *previous implementation*. Reading intent from it
 * recovered a first correction as `READY_FOR_IMPLEMENTATION` — losing the
 * review the user was acting on. A finished round says what already happened,
 * never what the next one was going to be.
 *
 * Contradictory data falls to the counter: a running run whose round does not
 * match the task's is a leftover the counter outranks, because the counter is
 * what the state machine itself maintains.
 */
function claudeRoundKind(task: Task, work: InterruptedWork): RunType {
  const inFlight = work.runningRuns
    .filter(
      (run) =>
        run.taskId === task.id &&
        CLAUDE_ROUNDS.includes(run.runType) &&
        run.round === task.currentRound
    )
    .sort(mostAuthoritativeFirst);

  const chosen = inFlight[0];
  if (chosen) return chosen.runType;

  return task.currentRound >= 2 ? 'correction' : 'implementation';
}

function recoveryEventFor(task: Task, work: InterruptedWork): WorkflowEvent | null {
  if (task.status === 'IMPLEMENTING') {
    return claudeRoundKind(task, work) === 'correction'
      ? 'correction_aborted'
      : 'implementation_aborted';
  }
  return RECOVERY_EVENTS[task.status] ?? null;
}

/**
 * Decide what to correct. Pure: same rows in, same plan out.
 *
 * Two independent decisions, and keeping them independent is the point:
 *
 * - **Every** run still marked `running` is closed, whatever its task now
 *   claims. A specification run is written before the task becomes `SPECIFYING`
 *   and a review run can outlive `REVIEWING`, so a stale run routinely belongs
 *   to a task that is already in a perfectly good state.
 * - **Only** a task in a busy status is moved, and only once, however many
 *   stale runs it turns out to have. A task that is not busy is left exactly
 *   where it is: rolling it back because of a leftover run would undo work the
 *   user can see.
 *
 * See {@link claudeRoundKind} for how an interrupted `IMPLEMENTING` task is told
 * apart from a correction — the one decision here that a finished run cannot
 * answer.
 *
 * Both lists are sorted by id, so the plan does not depend on the order SQLite
 * happened to return rows in.
 */
export function planReconciliation(work: InterruptedWork): ReconciliationPlan {
  // A third, independent list. A read-only diagnostic belongs to an
  // operational target, never to a task, so an interrupted one closes on its
  // own and moves nothing else — there is no status to roll back, because a
  // probe that reads cannot have left anything half-done.
  const diagnostics: DiagnosticClosure[] = (work.runningDiagnostics ?? [])
    .map((run) => ({
      diagnosticId: run.id,
      targetId: run.targetId,
      reason: DIAGNOSTIC_INTERRUPTION_REASON
    }))
    .sort((a, b) => (a.diagnosticId < b.diagnosticId ? -1 : a.diagnosticId > b.diagnosticId ? 1 : 0));

  const closures: RunClosure[] = work.runningRuns
    .map((run) => ({
      runId: run.id,
      taskId: run.taskId,
      runType: run.runType,
      reason: INTERRUPTION_REASON
    }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  const recoveries: TaskRecovery[] = [];
  for (const task of work.busyTasks) {
    const event = recoveryEventFor(task, work);
    // Every busy status has an abort event, so this is belt and braces: an
    // unrecoverable task is left untouched rather than aborting the whole pass.
    if (event === null || !canTransition(task.status, event)) continue;

    recoveries.push({
      taskId: task.id,
      from: task.status,
      to: transition(task.status, event),
      event,
      reason: INTERRUPTION_REASON
    });
  }
  recoveries.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  return { closures, recoveries, diagnostics };
}

export interface ReconciliationDeps {
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly clock: Clock;
  readonly transactions: TransactionRunner;
  /**
   * Optional so every existing caller and test keeps working unchanged, and
   * so a build without the Operations registry simply has nothing to recover.
   */
  readonly operationDiagnostics?: OperationDiagnosticRepository;
}

/** Read the rows a plan is built from. */
export function collectInterruptedWork(deps: {
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly operationDiagnostics?: OperationDiagnosticRepository;
}): InterruptedWork {
  return {
    runningRuns: deps.runs.listRunning(),
    busyTasks: deps.tasks.listBusy(),
    runningDiagnostics: (deps.operationDiagnostics?.listRunning() ?? []).map((run) => ({
      id: run.id,
      targetId: run.targetId
    }))
  };
}

/**
 * Apply a plan, all of it or none of it.
 *
 * One transaction covers both the run closures and the task moves. A partial
 * recovery would be worse than none: a task returned to a usable status while
 * its run still claims to be running invites a second agent against the same
 * worktree.
 */
export function applyReconciliation(
  plan: ReconciliationPlan,
  deps: ReconciliationDeps
): ReconciliationPlan {
  if (
    plan.closures.length === 0 &&
    plan.recoveries.length === 0 &&
    plan.diagnostics.length === 0
  ) {
    return plan;
  }

  deps.transactions.run(() => {
    const finishedAt = deps.clock.nowIso();

    for (const closure of plan.closures) {
      // `failed`, not `cancelled`: nobody chose to stop this, and calling it a
      // cancellation would put a decision in the user's mouth. Not a success
      // either — there is no result to report, which is exactly the problem.
      deps.runs.finish(closure.runId, {
        status: 'failed',
        finishedAt,
        errorMessage: closure.reason
      });
    }

    for (const closure of plan.diagnostics) {
      // `failed`, with no structured result. There is nothing to invent: the
      // probe never reported, so the honest record is that the run ended
      // without an answer — which is exactly what a null result means here.
      deps.operationDiagnostics?.finish(closure.diagnosticId, {
        status: 'failed',
        finishedAt,
        failureKind: 'cancelled',
        errorMessage: closure.reason
      });
    }

    for (const recovery of plan.recoveries) {
      // A narrow patch on purpose: the round counter, session and thread ids,
      // branch, worktree, specification, review and stored evidence all stay
      // exactly as the interrupted round left them.
      deps.tasks.update(recovery.taskId, {
        status: recovery.to,
        lastError: recovery.reason
      });
    }
  });

  return plan;
}

/**
 * Find interrupted work and correct it.
 *
 * Idempotent: a successful pass leaves no running runs and no busy tasks, so
 * running it again produces an empty plan and touches nothing.
 */
export function reconcileInterruptedWork(deps: ReconciliationDeps): ReconciliationPlan {
  return applyReconciliation(planReconciliation(collectInterruptedWork(deps)), deps);
}
