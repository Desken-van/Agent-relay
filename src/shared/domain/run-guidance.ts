import type { Run, Task } from './models';

export type RunAction =
  | 'capture_rules'
  | 'generate_specification'
  | 'approve_specification'
  | 'run_implementation'
  | 'run_verification'
  | 'run_review'
  | 'send_corrections'
  | 'approve_publishing'
  | 'publish'
  | 'none';

export type PlanReviewPreparation =
  | 'not_required'
  | 'loading'
  | 'capture_rules'
  | 'ready'
  | 'unavailable';

export type RunGuidanceTone = 'active' | 'success' | 'warning' | 'error';

export interface RunGuidance {
  readonly happened: string;
  readonly stage: string;
  readonly result: string;
  readonly next: string;
  readonly recommendedAction: RunAction;
  readonly activeStep: number;
  readonly tone: RunGuidanceTone;
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

function stoppedResult(task: Task, runs: readonly Run[]): string {
  if (task.lastError) return task.lastError;
  const run = latestRun(runs);
  if (run?.errorMessage) return run.errorMessage;
  return 'The task cannot continue in this run.';
}

/**
 * User-facing interpretation of the workflow state.
 *
 * This deliberately does not create new workflow rules. The state machine and
 * backend remain authoritative; this function only turns their durable state
 * into an explanation and one recommended next action.
 */
export function runGuidance(
  task: Task,
  runs: readonly Run[],
  hasSpecification: boolean,
  publishRetryAvailable = false,
  planReviewPreparation: PlanReviewPreparation = 'not_required'
): RunGuidance {
  switch (task.status) {
    case 'DRAFT': {
      if (planReviewPreparation === 'loading') {
        return {
          happened: 'External plan review is enabled for this task.',
          stage: 'Step 1 of 5 · Preparing specification',
          result: 'Checking whether the project rules are already bound.',
          next: 'Wait for the External plan review panel to finish loading.',
          recommendedAction: 'none',
          activeStep: 0,
          tone: 'active'
        };
      }
      if (planReviewPreparation === 'unavailable') {
        return {
          happened: 'External plan review is enabled, but its preparation state could not be confirmed.',
          stage: 'Step 1 of 5 · Specification is blocked',
          result: 'Agent Relay cannot safely choose the next specification action.',
          next: 'Read the error in External plan review, then retry or fix its configuration.',
          recommendedAction: 'none',
          activeStep: 0,
          tone: 'warning'
        };
      }
      if (planReviewPreparation === 'capture_rules') {
        return {
          happened: 'The task was created with external plan review enabled.',
          stage: 'Step 1 of 5 · Bind project rules',
          result: 'No immutable rule snapshot is bound to this task yet.',
          next: 'Click “Capture and bind rules” in External plan review.',
          recommendedAction: 'capture_rules',
          activeStep: 0,
          tone: 'active'
        };
      }
      if (planReviewPreparation === 'ready') {
        return {
          happened: 'The project rules were captured and bound to this task.',
          stage: 'Step 1 of 5 · Specification',
          result: 'The specification can now be generated against that rule snapshot.',
          next: 'Click “Generate specification”.',
          recommendedAction: 'generate_specification',
          activeStep: 0,
          tone: 'active'
        };
      }
      return {
        happened: 'The task was created. No specification has been accepted yet.',
        stage: 'Step 1 of 5 · Specification',
        result: 'No implementation has started.',
        next: 'Click “Generate specification”.',
        recommendedAction: 'generate_specification',
        activeStep: 0,
        tone: 'active'
      };
    }
    case 'SPECIFYING':
      return {
        happened: 'The specification request was sent to Codex.',
        stage: 'Step 1 of 5 · Specification is running',
        result: 'Waiting for Codex to finish.',
        next: 'Wait for this run to finish. No other action is required.',
        recommendedAction: 'none',
        activeStep: 0,
        tone: 'active'
      };
    case 'READY_FOR_IMPLEMENTATION': {
      if (!hasSpecification) {
        return {
          happened: 'The task has no readable specification.',
          stage: 'Step 1 of 5 · Specification',
          result: 'Implementation is blocked until a specification exists.',
          next: 'Click “Generate specification”.',
          recommendedAction: 'generate_specification',
          activeStep: 0,
          tone: 'warning'
        };
      }
      if (!task.specificationApprovedAt) {
        return {
          happened: 'Codex produced a specification.',
          stage: 'Step 1 of 5 · Specification approval',
          result: 'The specification is waiting for your approval.',
          next: 'Read it, then click “Approve specification”.',
          recommendedAction: 'approve_specification',
          activeStep: 0,
          tone: 'active'
        };
      }
      if (hasImplementationAttempt(runs)) {
        return {
          happened: 'An implementation attempt finished without proving the current files are verified.',
          stage: 'Step 3 of 5 · Verification',
          result: task.lastError ?? 'The files were preserved. Review is blocked until verification passes.',
          next: 'Click “Run verification”. This checks the existing files without asking an AI to rewrite them.',
          recommendedAction: 'run_verification',
          activeStep: 2,
          tone: 'warning'
        };
      }
      return {
        happened: 'The specification was approved.',
        stage: 'Step 2 of 5 · Implementation',
        result: 'The selected implementation provider is ready to write the code.',
        next: 'Click “Run implementation”.',
        recommendedAction: 'run_implementation',
        activeStep: 1,
        tone: 'active'
      };
    }
    case 'IMPLEMENTING':
      return {
        happened: 'The implementation provider is working in the task worktree.',
        stage: 'Step 2 of 5 · Implementation is running',
        result: 'Files may still be changing.',
        next: 'Wait for the implementation run to finish.',
        recommendedAction: 'none',
        activeStep: 1,
        tone: 'active'
      };
    case 'VERIFYING':
      return {
        happened: 'Agent Relay started the project verification command.',
        stage: 'Step 3 of 5 · Verification is running',
        result: 'The current code snapshot is being checked.',
        next: 'Wait for verification to finish.',
        recommendedAction: 'none',
        activeStep: 2,
        tone: 'active'
      };
    case 'READY_FOR_REVIEW':
      return {
        happened: 'Verification passed for the current code snapshot.',
        stage: 'Step 4 of 5 · Review',
        result: 'The verified files are ready for the selected reviewer.',
        next: 'Click “Run review”.',
        recommendedAction: 'run_review',
        activeStep: 3,
        tone: 'success'
      };
    case 'REVIEWING':
      return {
        happened: 'The selected reviewer is reading the verified changes.',
        stage: 'Step 4 of 5 · Review is running',
        result: 'Waiting for the review verdict.',
        next: 'Wait for the review to finish.',
        recommendedAction: 'none',
        activeStep: 3,
        tone: 'active'
      };
    case 'CHANGES_REQUESTED': {
      const spent = task.currentRound >= task.maxRounds;
      return {
        happened: 'The reviewer requested code changes.',
        stage: 'Step 4 of 5 · Review found issues',
        result: spent
          ? `All ${task.maxRounds} implementation rounds have been used.`
          : `Another implementation round is available (${task.currentRound}/${task.maxRounds} used).`,
        next: spent
          ? 'This run cannot start another correction. Inspect the findings and continue in a new task.'
          : 'Read the findings, then click “Send corrections”.',
        recommendedAction: spent ? 'none' : 'send_corrections',
        activeStep: 3,
        tone: 'warning'
      };
    }
    case 'APPROVED':
      return {
        happened: 'The reviewer approved the verified changes.',
        stage: 'Step 5 of 5 · Publishing approval',
        result: 'Nothing has been committed or pushed yet.',
        next: 'Click “Approve for publishing” to unlock publishing controls.',
        recommendedAction: 'approve_publishing',
        activeStep: 4,
        tone: 'success'
      };
    case 'READY_TO_PUBLISH':
      if (publishRetryAvailable) {
        return {
          happened: 'The publishing gate refused the latest implementation evidence.',
          stage: 'Step 4 of 5 · Verification must be repaired',
          result: 'Publishing remains locked until a new implementation round is verified and reviewed.',
          next: 'Click “Retry verification”.',
          recommendedAction: 'send_corrections',
          activeStep: 3,
          tone: 'warning'
        };
      }
      return {
        happened: 'You approved the task for publishing.',
        stage: 'Step 5 of 5 · Publishing',
        result: 'Publishing actions are unlocked, but no remote action happens automatically.',
        next: 'Use the Publishing panel below to choose the exact Git or GitHub action.',
        recommendedAction: 'publish',
        activeStep: 4,
        tone: 'active'
      };
    case 'PUBLISHING':
      return {
        happened: 'Agent Relay started the publishing action you approved.',
        stage: 'Step 5 of 5 · Publishing is running',
        result: 'Waiting for the Git or GitHub operation to finish.',
        next: 'Wait for the publishing action to finish.',
        recommendedAction: 'none',
        activeStep: 4,
        tone: 'active'
      };
    case 'COMPLETED':
      return {
        happened: 'The task workflow finished.',
        stage: 'Complete',
        result: 'No further action is required in this run.',
        next: 'Open the resulting pull request or create the next task.',
        recommendedAction: 'none',
        activeStep: 5,
        tone: 'success'
      };
    case 'FAILED':
      return {
        happened: latestRun(runs)?.runType === 'review'
          ? 'The workflow stopped after the final review did not approve the changes.'
          : 'The workflow stopped after a failed step.',
        stage: 'Stopped',
        result: stoppedResult(task, runs),
        next: 'This run is closed. Preserve its worktree, then create a new task for any remaining work.',
        recommendedAction: 'none',
        activeStep: Math.min(4, latestRun(runs)?.runType === 'review' ? 3 : 1),
        tone: 'error'
      };
    case 'CANCELLED':
      return {
        happened: 'The task was stopped by the user.',
        stage: 'Cancelled',
        result: 'Its existing files and history were preserved.',
        next: 'Create a new task if you want to continue this work.',
        recommendedAction: 'none',
        activeStep: 0,
        tone: 'warning'
      };
  }
}
