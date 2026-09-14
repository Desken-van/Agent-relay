import { providerLabel } from './execution-providers';
import type { ContinuationEntryAction, Run, Task } from './models';
import type { LocalInferenceStateKind } from './local-inference';
import { latestVerification, verificationNeedsImplementationRepair } from './verification';

/**
 * The one workflow transition Run → Actions may offer right now.
 *
 * Every caller — the renderer's primary button and its "Next action" text —
 * reads the same descriptor, so a label and a recommendation can never say two
 * different things. `key` names an IPC dispatch the renderer already owns;
 * this module never invents a new one.
 */
export type RunActionKey =
  | 'capture_rules'
  | 'generate_specification'
  | 'prepare_plan_review'
  | 'run_plan_review'
  | 'reconcile_plan_review'
  | 'resolve_plan_review'
  | 'approve_specification'
  | 'run_implementation'
  | 'run_verification'
  | 'run_review'
  | 'send_corrections'
  | 'approve_publishing'
  | 'continue_in_new_run';

export interface RunPrimaryAction {
  readonly key: RunActionKey;
  /** Exactly the text rendered on the button and echoed by "Next action". */
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, for a tooltip. Null when enabled. */
  readonly disabledReason: string | null;
}

export type PlanReviewPreparation =
  | 'not_required'
  | 'loading'
  | 'capture_rules'
  | 'ready'
  | 'prepare_review'
  | 'run_review'
  | 'run_next_review'
  | 'reconcile'
  | 'resolve'
  | 'resolve_blocked'
  | 'passed'
  | 'working'
  | 'unavailable';

export type RunGuidanceTone = 'active' | 'success' | 'warning' | 'error';

export interface RunGuidance {
  readonly happened: string;
  readonly stage: string;
  readonly result: string;
  /** Free text while `action` is null; otherwise exactly `action.label`. */
  readonly next: string;
  /** The one primary workflow control to render, or null to render none. */
  readonly action: RunPrimaryAction | null;
  readonly activeStep: number;
  readonly tone: RunGuidanceTone;
}

/** Extra, optional signals a plain `Task`/`Run[]` pair cannot carry on its own. */
export interface RunGuidanceExtra {
  /**
   * Verdict of `task.lastReviewJson`, precomputed by the caller so this module
   * stays free of JSON parsing. Consulted for review-limit and legacy FAILED tasks.
   */
  readonly lastReviewVerdict?: 'approved' | 'changes_requested' | 'blocked' | null;
  /** Set once a continuation already exists for this closed task. */
  readonly continuationTaskId?: string | null;
  readonly continuationCreationStatus?: 'creating' | 'ready' | null;
  /**
   * Set when THIS task is itself a continuation still sitting at the entry
   * state it was created with. Only `'verification'` changes anything here:
   * it turns a fresh READY_FOR_IMPLEMENTATION task's "Run implementation"
   * into "Run verification", because the inherited evidence could not be
   * trusted without recomputing it against the current worktree first.
   */
  readonly continuationEntryAction?: ContinuationEntryAction | null;
  /** True for every linked continuation, including after its entry lease is consumed. */
  readonly isContinuation?: boolean;
  /**
   * The renderer's last passively-read `localInference:getState` kind.
   *
   * Consulted only when `task.implementationProvider === 'ornith'`, and only to
   * disable the implementation/correction action with remediation — this
   * module never starts, stops or health-checks anything, and the backend
   * re-checks health itself before every Ornith run regardless of what this
   * says. `null`/`undefined` means "not read yet", and is treated as not ready.
   */
  readonly ornithLocalInferenceState?: LocalInferenceStateKind | null;
}

const ORNITH_NOT_READY_REASON =
  'Start the local runtime and confirm it is Healthy in Settings → Local inference before running Ornith.';

/**
 * Disable an implementation/correction action when it would dispatch Ornith
 * against a runtime this renderer has not last observed as Healthy.
 *
 * Purely a UI convenience: the backend performs its own bounded health check
 * immediately before every Ornith run and refuses independently. This exists
 * only so the button does not invite a click that is certain to be refused.
 */
function guardOrnithReadiness(
  candidate: RunPrimaryAction,
  task: Task,
  extra: RunGuidanceExtra
): RunPrimaryAction {
  if (task.implementationProvider !== 'ornith' || !candidate.enabled) return candidate;
  if (extra.ornithLocalInferenceState === 'healthy') return candidate;
  return { ...candidate, enabled: false, disabledReason: ORNITH_NOT_READY_REASON };
}

function latestRun(runs: readonly Run[], types?: readonly Run['runType'][]): Run | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run && (!types || types.includes(run.runType))) return run;
  }
  return null;
}

function hasImplementationAttempt(runs: readonly Run[]): boolean {
  return latestRun(runs, ['implementation', 'correction']) !== null;
}

/**
 * Ornith's application-authored audit record can prove that a failed attempt
 * stopped before any mutation. Only that exact, fail-closed signal permits a
 * retry: missing/malformed evidence still routes to verification so possible
 * preserved edits are never overwritten.
 */
function failedOrnithAttemptProvedNoChanges(run: Run | null): run is Run {
  if (run?.agent !== 'ornith' || run.status !== 'failed' || run.structuredResult === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(run.structuredResult);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const counters = (parsed as { readonly counters?: unknown }).counters;
    return typeof counters === 'object'
      && counters !== null
      && (counters as { readonly changedFiles?: unknown }).changedFiles === 0;
  } catch {
    return false;
  }
}

function stoppedResult(task: Task, runs: readonly Run[]): string {
  if (task.lastError) return task.lastError;
  const run = latestRun(runs);
  if (run?.errorMessage) return run.errorMessage;
  return 'The task cannot continue in this run.';
}

function action(key: RunActionKey, label: string, enabled = true, disabledReason: string | null = null): RunPrimaryAction {
  return { key, label, enabled, disabledReason };
}

/** A guidance record with no primary action: `next` carries its own free text. */
function waiting(input: Omit<RunGuidance, 'action' | 'next'> & { readonly next: string }): RunGuidance {
  return { ...input, action: null };
}

/** A guidance record whose `next` is always exactly the action's label. */
function acting(input: Omit<RunGuidance, 'action' | 'next'> & { readonly action: RunPrimaryAction }): RunGuidance {
  return { ...input, next: input.action.label };
}

/**
 * User-facing interpretation of the workflow state.
 *
 * This deliberately does not create new workflow rules. The state machine and
 * backend remain authoritative; this function only turns their durable state
 * into an explanation and at most one recommended next action. The renderer
 * must not independently choose a button label or a recommendation — every
 * value it shows comes from the descriptor this function returns.
 */
export function runGuidance(
  task: Task,
  runs: readonly Run[],
  hasSpecification: boolean,
  publishRecovery: false | 'verification' | 'correction' = false,
  planReviewPreparation: PlanReviewPreparation = 'not_required',
  extra: RunGuidanceExtra = {}
): RunGuidance {
  const implementationLabel = `Run implementation · ${providerLabel(task.implementationProvider)}`;
  const reviewLabel = `Run review · ${providerLabel(task.reviewProvider)}`;

  switch (task.status) {
    case 'DRAFT': {
      if (planReviewPreparation === 'loading') {
        return waiting({
          happened: 'External plan review is enabled for this task.',
          stage: 'Step 1 of 5 · Preparing specification',
          result: 'Checking whether the project rules are already bound.',
          next: 'Wait for the External plan review panel to finish loading.',
          activeStep: 0,
          tone: 'active'
        });
      }
      if (planReviewPreparation === 'unavailable') {
        return waiting({
          happened: 'External plan review is enabled, but its preparation state could not be confirmed.',
          stage: 'Step 1 of 5 · Specification is blocked',
          result: 'Agent Relay cannot safely choose the next specification action.',
          next: 'Read the error in External plan review, then retry or fix its configuration.',
          activeStep: 0,
          tone: 'warning'
        });
      }
      if (planReviewPreparation === 'working') {
        return waiting({
          happened: 'Agent Relay is completing an External plan review action.',
          stage: 'Step 1 of 5 · Preparing specification',
          result: 'The task state may still change.',
          next: 'Wait for the current action to finish.',
          activeStep: 0,
          tone: 'active'
        });
      }
      if (planReviewPreparation === 'capture_rules') {
        return acting({
          happened: 'The task was created with external plan review enabled.',
          stage: 'Step 1 of 5 · Bind project rules',
          result: 'No immutable rule snapshot is bound to this task yet.',
          action: action('capture_rules', 'Capture and bind rules'),
          activeStep: 0,
          tone: 'active'
        });
      }
      return acting({
        happened: planReviewPreparation === 'ready'
          ? 'The project rules were captured and bound to this task.'
          : 'The task was created. No specification has been accepted yet.',
        stage: 'Step 1 of 5 · Specification',
        result: planReviewPreparation === 'ready'
          ? 'The specification can now be generated against that rule snapshot.'
          : 'No implementation has started.',
        action: action('generate_specification', 'Generate specification'),
        activeStep: 0,
        tone: 'active'
      });
    }
    case 'SPECIFYING':
      return waiting({
        happened: 'The specification request was sent to Codex.',
        stage: 'Step 1 of 5 · Specification is running',
        result: 'Waiting for Codex to finish.',
        next: 'Wait for this run to finish. No other action is required.',
        activeStep: 0,
        tone: 'active'
      });
    case 'READY_FOR_IMPLEMENTATION': {
      if (!hasSpecification) {
        return acting({
          happened: 'The task has no readable specification.',
          stage: 'Step 1 of 5 · Specification',
          result: 'Implementation is blocked until a specification exists.',
          action: action('generate_specification', 'Generate specification'),
          activeStep: 0,
          tone: 'warning'
        });
      }
      if (!task.specificationApprovedAt) {
        if (planReviewPreparation === 'loading') {
          return waiting({
            happened: 'Codex produced a specification and External plan review is enabled.',
            stage: 'Step 1 of 5 · Checking external review state',
            result: 'Agent Relay is reading the durable plan-review evidence.',
            next: 'Wait for the External plan review panel to finish loading.',
            activeStep: 0,
            tone: 'active'
          });
        }
        if (planReviewPreparation === 'working') {
          return waiting({
            happened: 'Agent Relay is completing an External plan review action.',
            stage: 'Step 1 of 5 · External plan review',
            result: 'The review gate may still change.',
            next: 'Wait for the current action to finish.',
            activeStep: 0,
            tone: 'active'
          });
        }
        if (planReviewPreparation === 'unavailable') {
          return waiting({
            happened: 'The specification exists, but its External plan review cannot continue safely.',
            stage: 'Step 1 of 5 · External plan review is blocked',
            result: 'The exact review state or evidence could not be established.',
            next: 'Read the External plan review notice and resolve that problem before approval.',
            activeStep: 0,
            tone: 'warning'
          });
        }
        if (planReviewPreparation === 'prepare_review') {
          return acting({
            happened: 'Codex produced a specification against the bound project rules.',
            stage: 'Step 1 of 5 · Prepare external review',
            result: 'No isolated plan-review branch exists for this specification yet.',
            action: action('prepare_plan_review', 'Prepare isolated review branch'),
            activeStep: 0,
            tone: 'active'
          });
        }
        if (planReviewPreparation === 'run_review' || planReviewPreparation === 'run_next_review') {
          const nextRound = planReviewPreparation === 'run_next_review';
          return acting({
            happened: nextRound
              ? 'The previous external round did not finish the plan-review gate.'
              : 'The isolated branch is ready for external plan review.',
            stage: 'Step 1 of 5 · External plan review',
            result: nextRound
              ? 'Another plan-review round is available.'
              : 'No external reviewer has approved this specification yet.',
            action: action('run_plan_review', 'Run external plan review'),
            activeStep: 0,
            tone: 'active'
          });
        }
        if (planReviewPreparation === 'reconcile') {
          return acting({
            happened: 'An external call was recorded, but its answer did not reach Agent Relay.',
            stage: 'Step 1 of 5 · Recover external review state',
            result: 'The call will not be repeated because it may already have taken effect.',
            action: action('reconcile_plan_review', 'Reconcile external state'),
            activeStep: 0,
            tone: 'warning'
          });
        }
        if (planReviewPreparation === 'resolve' || planReviewPreparation === 'resolve_blocked') {
          return acting({
            happened: 'External reviewers returned findings that require decisions.',
            stage: 'Step 1 of 5 · Resolve plan-review findings',
            result: 'The specification is not approved until every finding has a decision.',
            action: action(
              'resolve_plan_review',
              'Resolve external plan review',
              planReviewPreparation === 'resolve',
              planReviewPreparation === 'resolve_blocked'
                ? 'Decide every finding and provide a reason for each rejection.'
                : null
            ),
            activeStep: 0,
            tone: 'warning'
          });
        }
        return acting({
          happened: 'Codex produced a specification.',
          stage: 'Step 1 of 5 · Specification approval',
          result: 'The specification is waiting for your approval.',
          action: action('approve_specification', 'Approve specification'),
          activeStep: 0,
          tone: 'active'
        });
      }
      const verification = latestVerification(runs);
      if (verificationNeedsImplementationRepair(verification)) {
        const repairLabel = `Fix verification failures · ${providerLabel(task.implementationProvider)}`;
        return acting({
          happened: 'Agent Relay ran verification and the current files did not pass.',
          stage: 'Step 2 of 5 · Fix verification failures',
          result: task.lastError ?? verification.errorMessage ?? 'The verification output is saved for the implementation provider.',
          action: guardOrnithReadiness(action('run_implementation', repairLabel), task, extra),
          activeStep: 1,
          tone: 'warning'
        });
      }
      const implementationAttempt = latestRun(runs, ['implementation', 'correction']);
      if (failedOrnithAttemptProvedNoChanges(implementationAttempt)) {
        return acting({
          happened: 'Ornith stopped before changing any files.',
          stage: 'Step 2 of 5 · Implementation',
          result: task.lastError ?? implementationAttempt.errorMessage ?? 'No worktree changes were made.',
          action: guardOrnithReadiness(action('run_implementation', implementationLabel), task, extra),
          activeStep: 1,
          tone: 'warning'
        });
      }
      if (hasImplementationAttempt(runs)) {
        return acting({
          happened: 'An implementation attempt finished without proving the current files are verified.',
          stage: 'Step 3 of 5 · Verification',
          result: task.lastError ?? 'The files were preserved. Review is blocked until verification passes.',
          action: action('run_verification', 'Run verification'),
          activeStep: 2,
          tone: 'warning'
        });
      }
      if (extra.continuationEntryAction === 'verification' || extra.isContinuation) {
        return acting({
          happened: 'This run continues a closed task and its current files require verification.',
          stage: 'Step 3 of 5 · Verification',
          result: task.lastError ?? 'The existing files were carried over. No current verification is available.',
          action: action('run_verification', 'Run verification'),
          activeStep: 2,
          tone: 'warning'
        });
      }
      return acting({
        happened: 'The specification was approved.',
        stage: 'Step 2 of 5 · Implementation',
        result: 'The selected implementation provider is ready to write the code.',
        action: guardOrnithReadiness(action('run_implementation', implementationLabel), task, extra),
        activeStep: 1,
        tone: 'active'
      });
    }
    case 'IMPLEMENTING':
      return waiting({
        happened: 'The implementation provider is working in the task worktree.',
        stage: 'Step 2 of 5 · Implementation is running',
        result: 'Files may still be changing.',
        next: 'Wait for the implementation run to finish.',
        activeStep: 1,
        tone: 'active'
      });
    case 'VERIFYING':
      return waiting({
        happened: 'Agent Relay started the project verification command.',
        stage: 'Step 3 of 5 · Verification is running',
        result: 'The current code snapshot is being checked.',
        next: 'Wait for verification to finish.',
        activeStep: 2,
        tone: 'active'
      });
    case 'READY_FOR_REVIEW':
      return acting({
        happened: 'Verification passed for the current code snapshot.',
        stage: 'Step 4 of 5 · Review',
        result: 'The verified files are ready for the selected reviewer.',
        action: action('run_review', reviewLabel),
        activeStep: 3,
        tone: 'success'
      });
    case 'REVIEWING':
      return waiting({
        happened: 'The selected reviewer is reading the verified changes.',
        stage: 'Step 4 of 5 · Review is running',
        result: 'Waiting for the review verdict.',
        next: 'Wait for the review to finish.',
        activeStep: 3,
        tone: 'active'
      });
    case 'CHANGES_REQUESTED': {
      const spent = task.currentRound >= task.maxRounds;
      if (spent) {
        return waiting({
          happened: 'The reviewer requested code changes.',
          stage: 'Step 4 of 5 · Review found issues',
          result: `All ${task.maxRounds} implementation rounds have been used.`,
          next: 'This run cannot start another correction. Inspect the findings and continue in a new task.',
          activeStep: 3,
          tone: 'warning'
        });
      }
      return acting({
        happened: 'The reviewer requested code changes.',
        stage: 'Step 4 of 5 · Review found issues',
        result: `Another implementation round is available (${task.currentRound}/${task.maxRounds} used).`,
        action: guardOrnithReadiness(action('send_corrections', 'Send corrections'), task, extra),
        activeStep: 3,
        tone: 'warning'
      });
    }
    case 'APPROVED':
      return acting({
        happened: 'The reviewer approved the verified changes.',
        stage: 'Step 5 of 5 · Publishing approval',
        result: 'Nothing has been committed or pushed yet.',
        action: action('approve_publishing', 'Approve for publishing'),
        activeStep: 4,
        tone: 'success'
      });
    case 'READY_TO_PUBLISH':
      if (publishRecovery) {
        if (publishRecovery === 'verification') {
          return acting({
            happened: 'The publishing gate refused the latest verification evidence.',
            stage: 'Step 3 of 5 · Verification must be refreshed',
            result: 'Publishing remains locked until the current files are verified and reviewed again.',
            action: action('run_verification', 'Run verification'),
            activeStep: 2,
            tone: 'warning'
          });
        }
        const spent = task.currentRound >= task.maxRounds;
        return acting({
          happened: 'The publishing gate refused the latest implementation evidence.',
          stage: 'Step 4 of 5 · Evidence must be repaired',
          result: spent
            ? `All ${task.maxRounds} implementation rounds have been used.`
            : 'Publishing remains locked until a new implementation round is verified and reviewed.',
          action: guardOrnithReadiness(
            action(
              'send_corrections',
              'Send corrections',
              !spent,
              spent ? 'The review round budget for this task is exhausted.' : null
            ),
            task,
            extra
          ),
          activeStep: 3,
          tone: 'warning'
        });
      }
      return waiting({
        happened: 'You approved the task for publishing.',
        stage: 'Step 5 of 5 · Publishing',
        result: 'Publishing actions are unlocked, but no remote action happens automatically.',
        next: 'Use the Publishing panel below to choose the exact Git or GitHub action.',
        activeStep: 4,
        tone: 'active'
      });
    case 'PUBLISHING':
      return waiting({
        happened: 'Agent Relay started the publishing action you approved.',
        stage: 'Step 5 of 5 · Publishing is running',
        result: 'Waiting for the Git or GitHub operation to finish.',
        next: 'Wait for the publishing action to finish.',
        activeStep: 4,
        tone: 'active'
      });
    case 'COMPLETED':
      return waiting({
        happened: 'The task workflow finished.',
        stage: 'Complete',
        result: 'No further action is required in this run.',
        next: 'Open the resulting pull request or create the next task.',
        activeStep: 5,
        tone: 'success'
      });
    case 'REVIEW_LIMIT_REACHED': {
      const happened = 'The bounded review cycle ended with changes still requested.';
      const stage = 'Review limit reached';
      const result = stoppedResult(task, runs);
      const activeStep = 3;

      if (extra.continuationTaskId) {
        return waiting({
          happened, stage, result,
          next: 'This review cycle is closed. Open the linked continuation to keep working.',
          activeStep, tone: 'warning'
        });
      }

      if (extra.continuationCreationStatus === 'creating') {
        return acting({
          happened, stage, result,
          action: action(
            'continue_in_new_run',
            'Continue in a new run',
            false,
            'Continuation creation is already in progress.'
          ),
          activeStep, tone: 'warning'
        });
      }

      return acting({
        happened, stage, result,
        action: action('continue_in_new_run', 'Continue in a new run'),
        activeStep, tone: 'warning'
      });
    }
    case 'REVIEW_BLOCKED': {
      const happened = 'The review completed and found that the approach itself needs rework.';
      const stage = 'Review blocked';
      const result = stoppedResult(task, runs);
      const activeStep = 3;

      if (extra.continuationTaskId) {
        return waiting({
          happened, stage, result,
          next: 'This review is closed. Open the linked continuation to keep working.',
          activeStep, tone: 'warning'
        });
      }

      if (extra.continuationCreationStatus === 'creating') {
        return acting({
          happened, stage, result,
          action: action(
            'continue_in_new_run',
            'Continue in a new run',
            false,
            'Continuation creation is already in progress.'
          ),
          activeStep, tone: 'warning'
        });
      }

      return acting({
        happened, stage, result,
        action: action('continue_in_new_run', 'Continue in a new run'),
        activeStep, tone: 'warning'
      });
    }
    case 'FAILED': {
      const happened = latestRun(runs)?.runType === 'review'
        ? 'The workflow stopped after the final review did not approve the changes.'
        : 'The workflow stopped after a failed step.';
      const stage = 'Stopped';
      const result = stoppedResult(task, runs);
      const activeStep = Math.min(4, latestRun(runs)?.runType === 'review' ? 3 : 1);

      if (extra.continuationTaskId) {
        return waiting({
          happened, stage, result,
          next: 'This run is closed. Open the linked continuation to keep working.',
          activeStep, tone: 'error'
        });
      }

      if (extra.continuationCreationStatus === 'creating') {
        return acting({
          happened, stage, result,
          action: action(
            'continue_in_new_run',
            'Continue in a new run',
            false,
            'Continuation creation is already in progress.'
          ),
          activeStep, tone: 'error'
        });
      }

      const finalReview = latestRun(runs, ['review']);
      const reviewExhausted =
        task.currentRound >= task.maxRounds &&
        finalReview?.status === 'succeeded' &&
        extra.lastReviewVerdict === 'changes_requested';
      if (reviewExhausted) {
        return acting({
          happened, stage, result,
          action: action('continue_in_new_run', 'Continue in a new run'),
          activeStep, tone: 'error'
        });
      }

      return waiting({
        happened, stage, result,
        next: 'This run is closed. Preserve its worktree, then create a new task for any remaining work.',
        activeStep, tone: 'error'
      });
    }
    case 'CANCELLED':
      return waiting({
        happened: 'The task was stopped by the user.',
        stage: 'Cancelled',
        result: 'Its existing files and history were preserved.',
        next: 'Create a new task if you want to continue this work.',
        activeStep: 0,
        tone: 'warning'
      });
  }
}
