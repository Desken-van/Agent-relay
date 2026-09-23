import { providerLabel } from './execution-providers';
import type { ContinuationEntryAction, Run, Task } from './models';
import type { LocalInferenceStateKind } from './local-inference';
import {
  describeUnverifiedOrnithOutcome,
  describeVerificationAttempt,
  latestExecutedAttempt,
  preservedOrnithChanges,
  readOrnithRunEvidence,
  type OrnithRunEvidence,
  type OrnithVerificationOutcome
} from './ornith-verification';
import {
  latestVerification, readVerification, verificationFailureKind, verificationRerunPolicy,
  type VerificationReadiness, type VerificationRerunCause
} from './verification';

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
  | 'retry_plan_review'
  | 'resolve_plan_review'
  | 'continue_plan_correction'
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
  /**
   * The latest review attempt cannot count: the provider refused it before a round existed,
   * or its session belongs to a different review. The specification has no successful
   * review, and the one safe action is to retry it under a fresh review identity.
   */
  | 'recover_review'
  | 'resolve'
  /** Every finding is decided and at least one is accepted: the plan must be revised, not just resolved. */
  | 'resolve_and_revise'
  | 'resolve_blocked'
  /** Accepted findings await a revision of the specification (Codex), or the review of a revised one. */
  | 'continue_correction'
  /** Accepted findings remain but the configured correction budget is spent. */
  | 'correction_limit'
  | 'passed'
  | 'working'
  | 'unavailable';

export type RunGuidanceTone = 'active' | 'success' | 'warning' | 'error';

/**
 * What a verification attempt actually was, for the Run screen: the command, how it ended, and — when it
 * is known — the exit code, duration, the explicit reason and the bounded, sanitized tail of its output.
 * Built only from records that were sanitized and bounded when they were stored.
 */
export interface RunVerificationDetail {
  /** Whose verification this is: Ornith's own in-loop attempt, or Agent Relay's verification of the worktree. */
  readonly source: 'ornith' | 'relay';
  readonly command: string;
  readonly outcome: OrnithVerificationOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly reason: string | null;
  readonly output: string | null;
  /** Which local-model profile actually served this attempt. Null for `source: 'relay'`, or when unrecorded. */
  readonly modelProfileDisplayName: string | null;
}

export interface RunGuidance {
  readonly happened: string;
  readonly stage: string;
  readonly result: string;
  /** Free text while `action` is null; otherwise exactly `action.label`. */
  readonly next: string;
  /**
   * The one workflow control to render, or null to render none. Exactly one, by product decision: two
   * "next steps" side by side (a repair beside a re-run, a retry beside a verification) sent operators down
   * the wrong one, so which single step is right is decided here, from the recorded evidence, and the
   * `result` text says why it is the right one.
   */
  readonly action: RunPrimaryAction | null;
  /** The verification attempt behind this state, when there is one. */
  readonly verification?: RunVerificationDetail | null;
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
  /**
   * The renderer's last read of `workflow:verificationReadiness` for the gated verification it is showing:
   * the main process's answer, from the current worktree identity and settings, to whether a verification
   * the re-run policy gated may start now. Consulted only in those two states. `null`/`undefined` means
   * "not read yet" and renders no control, exactly like a `blocked` answer: a button the main-process gate
   * would refuse is not a next step.
   */
  readonly verificationReadiness?: VerificationReadiness | null;
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
    if (typeof counters !== 'object' || counters === null) return false;
    const record = counters as { readonly changedFiles?: unknown; readonly worktreeChangedFiles?: unknown };
    // This run changed nothing — and, when the run could tell, the worktree holds nothing either.
    return record.changedFiles === 0
      && !(typeof record.worktreeChangedFiles === 'number' && record.worktreeChangedFiles > 0);
  } catch {
    return false;
  }
}

/** The verification attempt an Ornith run ended on: the latest that ran, else its last refusal. */
function ornithVerificationDetail(evidence: OrnithRunEvidence): RunVerificationDetail | null {
  const attempt = latestExecutedAttempt(evidence.attempts) ?? evidence.attempts.at(-1) ?? null;
  if (attempt === null) return null;
  return {
    source: 'ornith',
    command: attempt.command,
    outcome: attempt.outcome,
    exitCode: attempt.exitCode,
    durationMs: attempt.outcome === 'not_run' ? null : attempt.durationMs,
    reason: attempt.reason,
    output: attempt.summary.length > 0 ? attempt.summary : null,
    modelProfileDisplayName: evidence.modelProfileDisplayName
  };
}

/**
 * A record written before `outcome` existed said only `passed`, an exit code and a reason string. The
 * reason is the one place a timeout was told apart from a cancel, so read it rather than call every
 * exit-less failure a cancellation.
 */
function legacyRelayOutcome(data: { passed: boolean; exitCode: number | null; reason: string | null }): OrnithVerificationOutcome {
  if (data.passed) return 'passed';
  if (data.exitCode !== null && data.exitCode !== 0) return 'failed';
  const reason = data.reason?.toLowerCase() ?? '';
  if (reason.includes('timed out')) return 'timed_out';
  if (reason.includes('cancelled')) return 'cancelled';
  return 'failed';
}

/** Agent Relay's own verification record for a verification run, when it can be read. */
function relayVerificationDetail(run: Run): RunVerificationDetail | null {
  const record = readVerification(run);
  if (!record.success) return null;
  const { data } = record;
  return {
    source: 'relay',
    command: data.command,
    outcome: data.outcome ?? legacyRelayOutcome(data),
    exitCode: data.exitCode,
    durationMs: data.durationMs,
    reason: data.reason,
    output: data.outputSummary !== undefined && data.outputSummary.length > 0 ? data.outputSummary : null,
    modelProfileDisplayName: null
  };
}

function filesPhrase(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/**
 * The words for "files are preserved and unverified", by what actually happened to the verification.
 * `happened` names the situation; `result` is the reason, from the task's own explanation when it has one.
 */
function describePreservedAttempt(
  task: Task,
  evidence: OrnithRunEvidence | null,
  preserved: number,
  detail: RunVerificationDetail | null
): { readonly happened: string; readonly result: string } {
  const changed = preserved > 0 ? `Implementation changed ${filesPhrase(preserved)}` : 'An implementation attempt finished';
  const manual = 'Manual verification is required before review.';
  // Agent Relay's own verification is the LATEST event whenever it exists (guidance only sees a record that
  // came after the last implementation attempt). What it found is the state of the task now, so it must not be
  // masked by the earlier round's deadline: "the time limit expired" is history once the operator has verified.
  const relayVerificationFailed = detail !== null && detail.source === 'relay' && detail.outcome !== 'passed';
  if (evidence?.deadlineExpired && !relayVerificationFailed) {
    return {
      happened: `The implementation time limit expired. ${changed}.`,
      result: `${task.lastError ?? describeUnverifiedOrnithOutcome({
        changedFiles: evidence.changedFiles ?? 0,
        worktreeChangedFiles: evidence.worktreeChangedFiles,
        attempts: evidence.attempts,
        deadlineExpired: true
      })} ${manual}`
    };
  }
  if (detail !== null && detail.outcome !== 'passed') {
    const what: Record<OrnithVerificationOutcome, string> = {
      passed: 'verification passed',
      failed: 'verification failed',
      timed_out: 'verification timed out',
      cancelled: 'verification was cancelled',
      not_run: 'verification was not started'
    };
    // The explanation comes from the attempt the headline is about: Relay's own record when that is what
    // failed, never an earlier Ornith round's attempt.
    const ornithAttempt = detail.source === 'ornith' && evidence !== null && evidence.attempts.length > 0
      ? describeVerificationAttempt(latestExecutedAttempt(evidence.attempts) ?? evidence.attempts.at(-1)!)
      : null;
    return {
      happened: `${changed}; ${what[detail.outcome]}.`,
      result: `${task.lastError ?? ornithAttempt ?? detail.reason ?? 'The verification result was not recorded.'} ${manual}`
    };
  }
  if (detail !== null && detail.source === 'ornith' && detail.outcome === 'passed') {
    // Ornith's OWN check passed but the round did not end cleanly (or Relay has not verified yet). That check
    // is diagnostic — it never makes the files publishable — so say both halves rather than "has not run",
    // which the attempt panel shown beneath this line would contradict.
    return {
      happened: `${changed}; Ornith's own verification passed, but Agent Relay has not verified the files yet.`,
      result: task.lastError ?? 'The files were preserved. Review is blocked until Agent Relay verification passes.'
    };
  }
  return {
    // Files are known to be preserved but no verification was recorded: say so plainly. With nothing known
    // (an older run, a crash before any counters) the wording stays the general one it always was.
    happened: preserved > 0
      ? `${changed}; verification has not run.`
      : 'An implementation attempt finished without proving the current files are verified.',
    result: task.lastError ?? 'The files were preserved. Review is blocked until verification passes.'
  };
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

const GATED_VERIFICATION_STAGE = 'Step 3 of 5 · Verification';

/**
 * The two states in which running the same verification again cannot end differently: an output that
 * overflowed the stored log budget, and a diagnostic re-run that ended in a materially identical unknown
 * result. Whether a run may start NOW is the main process's answer (`workflow:verificationReadiness`, from
 * the current worktree identity and settings — the same values its gate compares). Until it has answered,
 * while it says no, and while the check itself is unavailable, there is no workflow control at all — a
 * button the gate would refuse is not a next step — and the text says what the operator must change. On
 * `ready` there is exactly one: Run verification. Stop task stays throughout.
 */
function gatedVerification(input: {
  readonly cause: VerificationRerunCause;
  readonly finding: string;
  readonly readiness: VerificationReadiness | null | undefined;
  readonly relayDetail: RunVerificationDetail | null;
}): RunGuidance {
  const { cause, finding, relayDetail } = input;
  // An answer about another state (read before the newest run was recorded) is no answer for this one.
  const readiness = input.readiness != null && input.readiness.state !== 'not_blocked' && input.readiness.cause === cause
    ? input.readiness
    : null;
  const happened = cause === 'output_limit'
    ? 'Agent Relay ran verification, but its output exceeded the stored log budget before the result could be judged.'
    : 'Agent Relay ran verification twice on these exact files, and neither result could be classified.';
  const why = cause === 'output_limit'
    ? 'Running it again under the same files and settings would stop at the same limit, so no verification step is ' +
      'offered and no implementation round is spent.'
    : 'The one diagnostic re-run for this snapshot was already used and ended the same way, so no verification step is ' +
      'offered and no implementation round is spent; the failure was not classified as a defect of the files, so no ' +
      'implementation round is recommended either. The Verification attempt panel holds the bounded output.';
  const required = cause === 'output_limit'
    ? 'User action required: raise "Stored log budget" in Settings or reduce what npm run verify prints. This screen ' +
      're-checks and offers Run verification once the files or that setting have changed.'
    : 'User action required: change the files or the verification settings (time limit, stored log budget) before ' +
      'another run, or stop the task. This screen re-checks and offers Run verification once something has changed.';
  const base = { happened, stage: GATED_VERIFICATION_STAGE, activeStep: 2, tone: 'warning' as const, verification: relayDetail };
  switch (readiness?.state) {
    case 'ready': {
      const changed = readiness.filesChanged && readiness.settingsChanged
        ? 'The files and the verification settings changed'
        : readiness.filesChanged
          ? 'The files changed'
          : 'The verification settings changed';
      return acting({
        ...base,
        result: `${finding} ${changed} since that run, so verification can run again on the current conditions. No ` +
          'implementation round is spent.',
        action: action('run_verification', 'Run verification')
      });
    }
    case 'blocked':
      return waiting({ ...base, result: `${finding} ${why}`, next: required });
    case 'unavailable':
      return waiting({ ...base, result: `${finding} ${why}`, next: `${required} (${readiness.detail} Use Check for changes to try again.)` });
    default:
      return waiting({ ...base, result: `${finding} ${why}`, next: 'Checking whether the files or the verification settings changed since that run…' });
  }
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
        if (planReviewPreparation === 'recover_review') {
          return acting({
            happened: 'The external review of the current specification did not happen: the provider refused it, or answered from a session that belongs to a different review.',
            stage: 'Step 1 of 5 · Plan review needs recovery',
            result: 'The current specification has no successful review, so it cannot be approved and implementation is not available.',
            action: action('retry_plan_review', 'Retry in a fresh review session'),
            activeStep: 0,
            tone: 'error'
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
        if (
          planReviewPreparation === 'resolve' ||
          planReviewPreparation === 'resolve_and_revise' ||
          planReviewPreparation === 'resolve_blocked'
        ) {
          const revising = planReviewPreparation === 'resolve_and_revise';
          return acting({
            happened: 'External reviewers returned findings that require decisions.',
            stage: 'Step 1 of 5 · Resolve plan-review findings',
            result: revising
              ? 'Accepted findings are folded into the specification by Codex, which is then reviewed again. Nothing is approved automatically.'
              : 'The specification is not approved until every finding has a decision.',
            action: action(
              'resolve_plan_review',
              revising ? 'Resolve and revise plan' : 'Resolve external plan review',
              planReviewPreparation !== 'resolve_blocked',
              planReviewPreparation === 'resolve_blocked'
                ? 'Decide every finding and provide a reason for each rejection.'
                : null
            ),
            activeStep: 0,
            tone: 'warning'
          });
        }
        if (planReviewPreparation === 'continue_correction') {
          return acting({
            happened: 'Findings were accepted, but the plan has not been fully revised and reviewed again for them.',
            stage: 'Step 1 of 5 · Correct the plan',
            result: 'The specification cannot be approved until its accepted findings are addressed and the revision passes review.',
            action: action('continue_plan_correction', 'Continue correction'),
            activeStep: 0,
            tone: 'warning'
          });
        }
        if (planReviewPreparation === 'correction_limit') {
          return waiting({
            happened: 'Findings were accepted, but the plan-correction budget is spent.',
            stage: 'Step 1 of 5 · Plan correction limit reached',
            result: 'The specification still has accepted findings it does not reflect, so it cannot be approved.',
            next: 'Raise the maximum review rounds in Settings and continue, or regenerate the specification.',
            activeStep: 0,
            tone: 'error'
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
      const relayDetail = verification === null ? null : relayVerificationDetail(verification);
      const failureKind = verificationFailureKind(verification);
      if (verification !== null && failureKind !== null) {
        // Agent Relay's own verification ran on the current files and did not pass. WHAT it found — recorded
        // by the classifier before the result was stored — decides the one next step, and the explanation
        // says why that step and not another. Never two: a re-run beside a repair sent operators down the
        // wrong one.
        const finding = task.lastError ?? verification.errorMessage ?? relayDetail?.reason ?? 'The verification result was not recorded.';
        switch (failureKind) {
          case 'implementation':
            return {
              ...acting({
                happened: 'Agent Relay ran verification and the current files did not pass.',
                stage: 'Step 2 of 5 · Fix verification failures',
                result: `${finding} The failing output is handed to ${providerLabel(task.implementationProvider)} as correction ` +
                  'evidence; running the same command on the same files again would fail the same way.',
                action: guardOrnithReadiness(
                  action('run_implementation', `Fix verification failures · ${providerLabel(task.implementationProvider)}`),
                  task,
                  extra
                ),
                activeStep: 1,
                tone: 'warning'
              }),
              verification: relayDetail
            };
          case 'infrastructure':
            return {
              ...acting({
                happened: 'Agent Relay ran verification, but the verification tooling failed before it could judge the files.',
                stage: 'Step 3 of 5 · Verification',
                result: `${finding} The files are untouched and no implementation round is spent: the same command is simply run again.`,
                action: action('run_verification', 'Run verification again'),
                activeStep: 2,
                tone: 'warning'
              }),
              verification: relayDetail
            };
          case 'cancelled':
            return {
              ...acting({
                happened: 'Verification was stopped before it finished.',
                stage: 'Step 3 of 5 · Verification',
                result: `${finding} The files were not judged; run verification to completion.`,
                action: action('run_verification', 'Run verification'),
                activeStep: 2,
                tone: 'warning'
              }),
              verification: relayDetail
            };
          case 'output_limit':
            return gatedVerification({ cause: 'output_limit', finding, readiness: extra.verificationReadiness, relayDetail });
          case 'unknown': {
            if (verificationRerunPolicy(runs).state === 'changes_required') {
              // The one diagnostic re-run for this snapshot already ended in a materially identical result.
              return gatedVerification({ cause: 'unknown_exhausted', finding, readiness: extra.verificationReadiness, relayDetail });
            }
            return {
              ...acting({
                happened: relayDetail?.outcome === 'timed_out'
                  ? 'Agent Relay ran verification and it did not finish within its time limit.'
                  : 'Agent Relay ran verification and it failed for a reason the output does not make clear.',
                stage: 'Step 3 of 5 · Verification',
                result: `${finding} Nothing is retried automatically and no implementation round is spent: one diagnostic ` +
                  're-run is offered for this snapshot to obtain a classified result; if it ends the same way, the files or ' +
                  'the verification settings must change before another. The Verification attempt panel holds the bounded output.',
                action: action('run_verification', 'Run verification to diagnose'),
                activeStep: 2,
                tone: 'warning'
              }),
              verification: relayDetail
            };
          }
        }
      }
      const implementationAttempt = latestRun(runs, ['implementation', 'correction']);
      const preserved = preservedOrnithChanges(runs);
      if (failedOrnithAttemptProvedNoChanges(implementationAttempt) && preserved === 0) {
        // A retry, not a first run: an attempt exists and provably left nothing behind, so running the
        // provider again is the only step that can make progress — and it is the only one offered.
        return acting({
          happened: 'Ornith stopped before changing any files.',
          stage: 'Step 2 of 5 · Implementation',
          result: `${task.lastError ?? implementationAttempt.errorMessage ?? 'No worktree changes were made.'} There is nothing to verify; the round is retried.`,
          action: guardOrnithReadiness(
            action('run_implementation', `Retry implementation · ${providerLabel(task.implementationProvider)}`),
            task,
            extra
          ),
          activeStep: 1,
          tone: 'warning'
        });
      }
      if (hasImplementationAttempt(runs)) {
        const evidence = implementationAttempt === null ? null : readOrnithRunEvidence(implementationAttempt);
        const detail = relayDetail ?? (evidence === null ? null : ornithVerificationDetail(evidence));
        const story = describePreservedAttempt(task, evidence, preserved, detail);
        return {
          ...acting({
            happened: story.happened,
            stage: 'Step 3 of 5 · Verification',
            result: story.result,
            action: action('run_verification', 'Run verification'),
            activeStep: 2,
            tone: 'warning'
          }),
          // Verification is the stage: the preserved files are judged first, and only a failure of the files
          // themselves (classified above once it has run) ever leads back to the provider.
          verification: detail
        };
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
