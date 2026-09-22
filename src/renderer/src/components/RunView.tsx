import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canChangeProviders,
  providerLabel,
  type ImplementationProvider,
  type ReviewProvider
} from '@shared/domain/execution-providers';
import { latestClaudeRoundResult } from '@shared/domain/claude-assessment';
import type { LocalInferenceStateKind } from '@shared/domain/local-inference';
import type { GitChangeSet } from '@shared/domain/git';
import { APPROVAL_ACTIONS, type ApprovalAction, type Run, type Task } from '@shared/domain/models';
import {
  runGuidance,
  type PlanReviewPreparation,
  type RunActionKey,
  type RunGuidance,
  type RunPrimaryAction
} from '@shared/domain/run-guidance';
import {
  formatVerificationDuration,
  type OrnithVerificationOutcome
} from '@shared/domain/ornith-verification';
import { isBusy, isTerminal } from '@shared/domain/workflow';
import { verificationRerunPolicy, type VerificationReadiness } from '@shared/domain/verification';
import {
  WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES,
  type WorktreeDependencyStatus
} from '@shared/domain/worktree-dependencies';
import type { PublishConfirmation, PublishOutcome, TaskDetail } from '@shared/ipc';
import type { CodexReviewResult, FindingSeverity, TaskSpecification } from '@shared/schemas/codex';
import { ApiError, call, describeError, expect } from '../lib/api';
import { formatDateTime, pluralize } from '../lib/format';
import { useStore } from '../state/store';
import { ChangesPanel } from './ChangesPanel';
import { codexModelLabel } from './TasksView';
import { CodeReviewPanel } from './CodeReviewPanel';
import { PlanReviewPanel } from './PlanReviewPanel';
import { Card, Empty, Field, Notice, Rounds, Scope, Spinner, StatusBadge } from './primitives';
import { RelayTimeline } from './RelayTimeline';

const FLOW_STEPS = ['Specification', 'Implementation', 'Verification', 'Review', 'Publish'] as const;

export function publishRecoveryFor(
  detail: Pick<TaskDetail, 'task' | 'effectivePublishRefusal'>
): false | 'correction' | 'verification' {
  if (detail.task.status !== 'READY_TO_PUBLISH' || detail.effectivePublishRefusal === null) return false;
  return detail.effectivePublishRefusal === 'security' ? 'correction' : 'verification';
}

export function RunFlowOverview({ guidance }: { guidance: RunGuidance }): React.JSX.Element {
  return <section className={`run-guide run-guide--${guidance.tone}`} aria-label="Run progress and next action">
    <ol className="run-steps" aria-label="Task workflow">
      {FLOW_STEPS.map((step, index) => {
        const state = guidance.activeStep > index ? 'done' : guidance.activeStep === index ? 'current' : 'upcoming';
        return <li key={step} className={`run-step run-step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span className="run-step__mark">{state === 'done' ? '✓' : index + 1}</span>
          <span>{step}</span>
        </li>;
      })}
    </ol>
    <dl className="run-guide__facts">
      <div><dt>What happened</dt><dd>{guidance.happened}</dd></div>
      <div><dt>Current stage</dt><dd>{guidance.stage}</dd></div>
      <div><dt>Result</dt><dd>{guidance.result}</dd></div>
      <div className="run-guide__next"><dt>Next action</dt><dd>{guidance.next}</dd></div>
    </dl>
    {guidance.verification ? <VerificationDetail detail={guidance.verification} /> : null}
  </section>;
}

const VERIFICATION_OUTCOME_LABEL: Record<OrnithVerificationOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
  not_run: 'Not started'
};

/**
 * The verification attempt behind the current state, in its own words: which command, how it ended, the exit
 * code, how long it ran, why it did not pass, and — collapsed — the bounded, sanitized tail of its output.
 * Everything shown was bounded and sanitized when it was stored.
 */
function VerificationDetail({ detail }: { detail: NonNullable<RunGuidance['verification']> }): React.JSX.Element {
  return <section className="run-guide__verification" aria-label="Verification attempt">
    <h4>{detail.source === 'ornith' ? 'Ornith verification attempt' : 'Agent Relay verification'}</h4>
    <dl>
      <div><dt>Command</dt><dd className="mono">{detail.command}</dd></div>
      <div><dt>Outcome</dt><dd>{VERIFICATION_OUTCOME_LABEL[detail.outcome]}</dd></div>
      {detail.exitCode !== null ? <div><dt>Exit code</dt><dd>{detail.exitCode}</dd></div> : null}
      {detail.durationMs !== null ? <div><dt>Duration</dt><dd>{formatVerificationDuration(detail.durationMs)}</dd></div> : null}
      {detail.reason ? <div><dt>Reason</dt><dd>{detail.reason}</dd></div> : null}
    </dl>
    {detail.output ? (
      <details>
        <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>Command output (bounded)</summary>
        <pre className="pre selectable" style={{ marginTop: 8 }}>{detail.output}</pre>
      </details>
    ) : null}
  </section>;
}

/** Blast-radius icon for a primary action, mirrored from what the dispatched channel actually does. */
const ACTION_SCOPE: Record<RunActionKey, 'read' | 'local' | 'remote'> = {
  capture_rules: 'read',
  generate_specification: 'read',
  prepare_plan_review: 'local',
  run_plan_review: 'read',
  reconcile_plan_review: 'read',
  // Writes a local Git object and database rows; contacts no provider.
  retry_plan_review: 'local',
  resolve_plan_review: 'read',
  continue_plan_correction: 'read',
  approve_specification: 'read',
  run_implementation: 'local',
  run_verification: 'local',
  run_review: 'read',
  send_corrections: 'local',
  approve_publishing: 'read',
  continue_in_new_run: 'local'
};

/**
 * The one contextual primary workflow button.
 *
 * A single synchronous ref-based claim, checked before any state update, is
 * what makes a double-click issue exactly one request: React state (`pending`)
 * only becomes true *after* the first click has already scheduled its async
 * work, which is too late to stop a second click in the same tick.
 */
export function PrimaryActionButton({
  action,
  onClick,
  pending,
  blocked
}: {
  action: RunPrimaryAction;
  onClick: () => void;
  pending: boolean;
  /** True while an unrelated operation (another busy flag, Stop, …) is in flight. */
  blocked: boolean;
}): React.JSX.Element {
  const claim = useRef(false);
  return (
    <button
      type="button"
      className="btn btn--wide btn--primary btn--recommended"
      disabled={!action.enabled || pending || blocked}
      title={action.disabledReason ?? undefined}
      onClick={() => {
        if (claim.current) return;
        claim.current = true;
        try {
          onClick();
        } finally {
          // Cleared on the next tick rather than in a `finally` inside the
          // caller's async work: the caller's own `pending` flag covers the
          // duration of the request, and this ref only needs to survive the
          // synchronous burst a double-click produces.
          window.setTimeout(() => { claim.current = false; }, 0);
        }
      }}
    >
      {pending ? <Spinner /> : <Scope kind={ACTION_SCOPE[action.key]} />}
      {action.label}
    </button>
  );
}

export function ProviderControls({ task, busy, onChanged }: { task: Task; busy: boolean; onChanged: (task: Task) => void | Promise<void> }): React.JSX.Element {
  const [implementation, setImplementation] = useState<ImplementationProvider | null>(null);
  const [review, setReview] = useState<ReviewProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = useRef(false);
  const implementationValue = implementation ?? task.implementationProvider;
  const reviewValue = review ?? task.reviewProvider;
  const disabled = busy || saving || !canChangeProviders(task.status);
  const differs = implementationValue !== task.implementationProvider || reviewValue !== task.reviewProvider;
  return <details className="provider-controls" aria-label="AI provider settings">
    <summary>
      <span>AI providers</span>
      <span className="provider-controls__summary">
        {providerLabel(task.implementationProvider)} implements · {providerLabel(task.reviewProvider)} reviews
      </span>
    </summary>
    <div className="stack provider-controls__body">
      <Field label="Implementation provider">
        <select className="input" aria-label="Implementation provider" value={implementationValue} disabled={disabled} onChange={(e) => setImplementation(e.target.value as ImplementationProvider)}>
          <option value="claude">Claude</option><option value="codex">Codex</option><option value="ornith">Ornith</option>
        </select>
      </Field>
      {implementationValue === 'ornith' ? (
        <p className="hint">
          Ornith uses the local runtime configured under Settings → Local inference. It must
          already be started and Healthy — Agent Relay never starts or restarts it.
        </p>
      ) : null}
      <Field label="Review provider">
        <select className="input" aria-label="Review provider" value={reviewValue} disabled={disabled} onChange={(e) => setReview(e.target.value as ReviewProvider)}>
          <option value="codex">Codex</option><option value="claude">Claude</option>
        </select>
      </Field>
      {/* Absent rather than merely disabled while the selection matches the
          persisted providers — there is nothing to apply, so there is no
          control to show. It reappears the moment either selection differs. */}
      {differs || saving ? (
        <button type="button" className="btn btn--sm" disabled={disabled} onClick={() => {
          if (claim.current) return;
          claim.current = true; setSaving(true); setError(null);
          void (async () => {
            try {
              const updated = await expect('workflow:configureProviders', { taskId: task.id, expectedRevision: task.providerRevision, implementationProvider: implementationValue, reviewProvider: reviewValue });
              await onChanged(updated); setImplementation(null); setReview(null);
            } catch (err) { setError(err instanceof Error ? err.message : 'Could not update providers.'); }
            finally { claim.current = false; setSaving(false); }
          })();
        }}>{saving ? 'Saving…' : 'Apply providers'}</button>
      ) : null}
      <p className="hint">Changing the executor preserves files and history, but starts a new implementation session. No automatic fallback. Coai settings are separate.</p>
      {error ? <Notice tone="warn">{error}</Notice> : null}
    </div>
  </details>;
}

function ContinuationLink({ detail, onOpen }: { detail: TaskDetail; onOpen: (taskId: string) => void }): React.JSX.Element | null {
  const { continuationOf, continuedAs } = detail;
  if (!continuationOf && !continuedAs) return null;
  return (
    <div className="stack stack--tight">
      {continuationOf ? (
        <div className="filerow">
          <span className="tag">continuation of</span>
          <span className="filerow__path selectable">{continuationOf.title}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpen(continuationOf.taskId)}>Open</button>
        </div>
      ) : null}
      {continuedAs ? (
        <div className="filerow">
          <span className="tag tag--ok">continued as</span>
          <span className="filerow__path selectable">{continuedAs.title}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpen(continuedAs.taskId)}>Open</button>
        </div>
      ) : null}
    </div>
  );
}

function CompletedHistory({ runs }: { runs: readonly Run[] }): React.JSX.Element | null {
  const completed = runs.filter((run) => run.status === 'succeeded');
  if (completed.length === 0) return null;
  return (
    <details aria-label="Completed workflow history">
      <summary className="faint" style={{ cursor: 'pointer' }}>
        Completed operations ({completed.length})
      </summary>
      <div className="stack stack--tight" style={{ marginTop: 8 }}>
        {completed.map((run) => (
          <div className="filerow" key={run.id}>
            <span className="tag tag--ok">complete</span>
            <span className="filerow__path">{run.runType.replace(/_/g, ' ')}</span>
            <span className="filerow__stat faint">round {run.round}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function RunView(): React.JSX.Element {
  const store = useStore();
  const { selectedTaskId, detail, refreshDetail, openTaskDetail, acceptTask, perform, notify, busy, codexModels, settings, openSettings } = store;

  const [changes, setChanges] = useState<GitChangeSet | null>(null);
  const [planReviewPreparation, setPlanReviewPreparation] = useState<{
    readonly taskId: string;
    readonly state: PlanReviewPreparation;
  } | null>(null);
  const updatePlanReviewPreparation = useCallback((state: PlanReviewPreparation): void => {
    if (!selectedTaskId) return;
    setPlanReviewPreparation((current) =>
      current?.taskId === selectedTaskId && current.state === state
        ? current
        : { taskId: selectedTaskId, state }
    );
  }, [selectedTaskId]);

  const [loadingChanges, setLoadingChanges] = useState(false);
  const [dirtyPrompt, setDirtyPrompt] = useState<string | null>(null);
  /** Non-null while the one primary action is in flight; names the action key. */
  const [primaryPending, setPrimaryPending] = useState<RunActionKey | null>(null);
  const stopInFlight = useRef(false);
  const planPrimaryDispatch = useRef<((key: RunActionKey) => void) | null>(null);
  /** Synchronous double-click guard for "Continue anyway", mirroring `PrimaryActionButton`'s claim. */
  const continueAnywayClaim = useRef(false);
  const registerPlanDispatcher = useCallback((dispatcher: ((key: RunActionKey) => void) | null) => {
    planPrimaryDispatch.current = dispatcher;
  }, []);

  useEffect(() => {
    // Avoid an immediate second request when the detail already matches the
    // selection — e.g. right after `workflow:continue` hands the renderer a
    // full TaskDetail for the task it just switched to.
    if (selectedTaskId && detail?.task.id !== selectedTaskId) {
      void refreshDetail(selectedTaskId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, refreshDetail]);

  /** Fetches the change set without touching component state. */
  const fetchChanges = useCallback(async (): Promise<GitChangeSet | null> => {
    if (!selectedTaskId) return null;
    const result = await call('git:changes', { taskId: selectedTaskId });
    return result.ok ? result.data : null;
  }, [selectedTaskId]);

  /** Explicit refresh from a button — state changes here are event-driven. */
  const loadChanges = useCallback(async () => {
    setLoadingChanges(true);
    try {
      setChanges(await fetchChanges());
    } finally {
      setLoadingChanges(false);
    }
  }, [fetchChanges]);

  const status = detail?.task.status;
  useEffect(() => {
    if (status !== 'READY_FOR_REVIEW' && status !== 'CHANGES_REQUESTED' && status !== 'APPROVED') {
      return undefined;
    }
    let active = true;
    void fetchChanges().then((value) => {
      if (active) setChanges(value);
    });
    return () => {
      active = false;
    };
  }, [status, fetchChanges]);

  // Declared before the early return below so every render calls the same
  // hooks in the same order, regardless of whether a task is selected yet.
  const openTask = useCallback((taskId: string) => {
    void perform('open-linked-task', 'Could not open the linked task', async () => {
      openTaskDetail(await expect('tasks:get', { taskId }));
    });
  }, [openTaskDetail, perform]);

  // Passive only: periodically refresh the retained lifecycle snapshot, never
  // start or health-check it. Runtime exit/start can happen while this view is
  // mounted, so a one-time read would leave the action incorrectly enabled or
  // disabled until navigation. The backend still performs the authoritative
  // health check immediately before every Ornith run.
  const [ornithReadiness, setOrnithReadiness] = useState<{
    taskId: string;
    kind: LocalInferenceStateKind | null;
  } | null>(null);
  const implementationProviderForReadiness = detail?.task.implementationProvider ?? null;
  useEffect(() => {
    if (implementationProviderForReadiness !== 'ornith' || selectedTaskId === null) return undefined;
    let cancelled = false;
    let pending = false;
    const refresh = (): void => {
      if (pending || cancelled) return;
      pending = true;
      void call('localInference:getState', {}).then((response) => {
        if (!cancelled) {
          setOrnithReadiness({ taskId: selectedTaskId, kind: response.ok ? response.data.kind : null });
        }
      }).finally(() => {
        pending = false;
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [implementationProviderForReadiness, selectedTaskId]);

  // Passive, read-only: whether a verification the re-run policy has gated may start NOW — the main
  // process's answer from the current worktree identity and settings, the same values its gate compares —
  // so this screen never offers a step that gate would refuse. Re-read whenever the gated run, the task or
  // the verification settings change, and on demand ("Check for changes") after edits made outside the app.
  const gatedVerificationRerun = detail !== null && detail.task.status === 'READY_FOR_IMPLEMENTATION'
    ? verificationRerunPolicy(detail.runs)
    : null;
  const gatedVerificationRunId = detail !== null && gatedVerificationRerun?.state === 'changes_required'
    ? [...detail.runs].reverse().find((run) => run.runType === 'verification')?.id ?? null
    : null;
  const gatedVerificationCause = gatedVerificationRerun?.state === 'changes_required' ? gatedVerificationRerun.cause : null;
  const [verificationReadiness, setVerificationReadiness] = useState<{
    taskId: string;
    runId: string;
    readiness: VerificationReadiness;
  } | null>(null);
  const [readinessCheck, setReadinessCheck] = useState(0);
  const verificationSettingsRevision = settings === null ? null : `${settings.processTimeoutMs}:${settings.maxStoredLogBytes}`;
  useEffect(() => {
    if (selectedTaskId === null || gatedVerificationRunId === null || gatedVerificationCause === null) return undefined;
    let cancelled = false;
    const taskId = selectedTaskId;
    const runId = gatedVerificationRunId;
    // The IPC call itself failing (rejected, or the main process answering `{ok:false}`) is distinct from a
    // domain-level "cannot check" answer, which `verificationReadiness` already returns as `unavailable` —
    // but the operator must see the same thing either way: a fixed message and, critically, the "Check for
    // changes" retry control, never silently stuck on "Checking…" forever with nothing to press.
    const unavailable: VerificationReadiness = {
      state: 'unavailable', cause: gatedVerificationCause,
      detail: 'Agent Relay could not confirm whether verification may run yet.'
    };
    void call('workflow:verificationReadiness', { taskId }).then(
      (response) => {
        if (cancelled) return;
        setVerificationReadiness({ taskId, runId, readiness: response.ok ? response.data : unavailable });
      },
      () => {
        if (cancelled) return;
        setVerificationReadiness({ taskId, runId, readiness: unavailable });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, gatedVerificationRunId, gatedVerificationCause, verificationSettingsRevision, readinessCheck]);
  const currentVerificationReadiness =
    verificationReadiness !== null && verificationReadiness.taskId === selectedTaskId && verificationReadiness.runId === gatedVerificationRunId
      ? verificationReadiness.readiness
      : null;

  // Passive, read-only: shows the dependency blocker (and its install action)
  // before the user ever attempts implementation, rather than only after a
  // failed attempt. Refetched whenever the task changes; `installDependencies`
  // below additionally re-fetches directly once the install settles, since
  // `workflow:installDependencies` returns only a `Task` — `acceptTask` never
  // touches `detail.runs`, so a key derived from it would never change and
  // the effect would never re-fire on its own.
  const [dependencyStatus, setDependencyStatus] = useState<{
    taskId: string;
    status: WorktreeDependencyStatus;
  } | null>(null);
  const hasWorktree = detail?.task.worktreePath != null;
  const fetchDependencyStatus = useCallback((taskId: string): void => {
    void call('dependencies:status', { taskId }).then((response) => {
      if (response.ok) setDependencyStatus({ taskId, status: response.data });
    });
  }, []);
  useEffect(() => {
    if (!selectedTaskId || !hasWorktree) return;
    fetchDependencyStatus(selectedTaskId);
    // Deliberately keyed on the task id and worktree presence only — see the
    // comment above for why `detail`'s own fields cannot drive this reliably.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, hasWorktree]);
  const currentDependencyStatus = dependencyStatus?.taskId === selectedTaskId ? dependencyStatus.status : null;
  const dependencyBlocker = currentDependencyStatus && WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES.has(currentDependencyStatus.state)
    ? currentDependencyStatus
    : null;
  const dependencyUnsupported = currentDependencyStatus?.state === 'unsupported_package_manager' ? currentDependencyStatus : null;
  const installDependenciesClaim = useRef(false);
  const installDependencies = (): void => {
    if (!selectedTaskId) return;
    const taskId = selectedTaskId;
    void perform('install-dependencies', 'Installing dependencies failed', async () => {
      try {
        const updated = await expect('workflow:installDependencies', { taskId });
        acceptTask(updated);
        if (!updated.lastError) notify({ tone: 'success', title: 'Dependencies installed' });
      } finally {
        // Always re-read the real state afterward — success, failure, or a
        // thrown error all leave the worktree in some actual state, and only
        // a fresh read (never a local guess) may report it.
        fetchDependencyStatus(taskId);
      }
    });
  };

  if (!selectedTaskId || !detail) {
    return (
      <Card>
        <Empty title="No task selected" hint="Choose a task on the Tasks screen." />
      </Card>
    );
  }

  const { task, project, specification, lastReview } = detail;
  const planReviewEnabled = settings?.externalPlanReviewEnabled ?? false;
  const codeReviewEnabled = settings?.externalCodeReviewEnabled ?? false;
  const planReviewMayControlNextAction =
    task.status === 'DRAFT' ||
    (task.status === 'READY_FOR_IMPLEMENTATION' && !task.specificationApprovedAt);
  const effectivePlanReviewPreparation: PlanReviewPreparation =
    planReviewMayControlNextAction
      ? planReviewPreparation?.taskId === task.id
        ? planReviewPreparation.state
        : 'loading'
      : 'not_required';

  // TaskService applies PublishService's own-first/inherited-until-superseded
  // evidence selection and exposes only the bounded refusal code. The
  // renderer uses that read model solely to choose recovery guidance; the
  // backend publication gate remains authoritative.
  const publishRecovery = publishRecoveryFor(detail);

  const guidance = runGuidance(
    task,
    detail.runs,
    specification !== null,
    publishRecovery,
    effectivePlanReviewPreparation,
    {
      lastReviewVerdict: lastReview?.verdict ?? null,
      continuationTaskId: detail.continuedAs?.taskId ?? null,
      continuationCreationStatus: detail.continuationCreationStatus,
      continuationEntryAction: detail.continuationEntryAction,
      isContinuation: detail.continuationOf !== null,
      ornithLocalInferenceState: ornithReadiness?.taskId === task.id ? ornithReadiness.kind : null,
      verificationReadiness: currentVerificationReadiness
    }
  );
  const running = isBusy(task.status);
  const anyBusy = Object.values(busy).some(Boolean);
  // Blocks every OTHER control while any operation is in flight. Does not
  // include `primaryPending` itself — the button's own `pending` prop already
  // covers that case, and folding it in here would also disable it the
  // instant its own click sets `primaryPending`, before `busy`/`running` have
  // had a chance to catch up.
  const otherOperationBusy = anyBusy || running;

  const sendToClaude = (acceptDirty: boolean): void => {
    setDirtyPrompt(null);
    setPrimaryPending('run_implementation');
    void perform('send-claude', 'Implementation run failed', async () => {
      try {
        const updated = await expect('workflow:implement', {
          taskId: task.id,
          ...(acceptDirty ? { acceptDirtyWorkingTree: true } : {})
        });
        acceptTask(updated);
        notify({ tone: 'success', title: 'Implementation round finished' });
        await loadChanges();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GIT_DIRTY') {
          setDirtyPrompt(error.message + (error.details ? `\n\n${error.details}` : ''));
          return;
        }
        throw error;
      } finally {
        setPrimaryPending(null);
      }
    });
  };

  /** Every non-plan-review action: exactly one bounded IPC call, then one read-only refresh. */
  const dispatchAction = (action: RunPrimaryAction | null | undefined): void => {
    if (!action || !action.enabled) return;
    switch (action.key) {
      case 'generate_specification':
        setPrimaryPending(action.key);
        void perform('spec', 'Specification failed', async () => {
          try {
            acceptTask(await expect('workflow:generateSpecification', { taskId: task.id }));
            notify({ tone: 'success', title: 'Codex produced a specification' });
          } finally {
            setPrimaryPending(null);
          }
        });
        return;
      case 'approve_specification':
        setPrimaryPending(action.key);
        void perform('approve-spec', 'Could not approve', async () => {
          try {
            acceptTask(await expect('workflow:approveSpecification', { taskId: task.id }));
            notify({ tone: 'success', title: 'Specification approved' });
          } finally {
            setPrimaryPending(null);
          }
        });
        return;
      case 'run_implementation':
        sendToClaude(false);
        return;
      case 'run_verification':
        setPrimaryPending(action.key);
        void perform('verify', 'Verification could not be confirmed', async () => {
          try {
            const result = await expect('workflow:verify', { taskId: task.id });
            acceptTask(result);
            notify({
              tone: result.status === 'READY_FOR_REVIEW' ? 'success' : 'info',
              title: result.status === 'READY_FOR_REVIEW' ? 'Verification passed' : 'Verification did not pass'
            });
          } finally {
            setPrimaryPending(null);
          }
        });
        return;
      case 'run_review':
        setPrimaryPending(action.key);
        void perform('review', 'Review failed', async () => {
          try {
            acceptTask(await expect('workflow:review', { taskId: task.id }));
            notify({ tone: 'success', title: 'Review complete' });
          } finally {
            await loadChanges();
            setPrimaryPending(null);
          }
        });
        return;
      case 'send_corrections':
        setPrimaryPending(action.key);
        void perform('corrections', 'Correction round failed', async () => {
          try {
            acceptTask(await expect('workflow:sendCorrections', { taskId: task.id }));
            notify({ tone: 'success', title: 'Implementation round finished' });
          } finally {
            await loadChanges();
            setPrimaryPending(null);
          }
        });
        return;
      case 'approve_publishing':
        setPrimaryPending(action.key);
        void perform('approve-publish', 'Could not approve for publishing', async () => {
          try {
            acceptTask(await expect('workflow:approveForPublishing', { taskId: task.id }));
            // The workflow response contains only Task. Re-read the full detail
            // so backend-computed fields such as effectivePublishRefusal cannot
            // leave the renderer offering an obsolete verification action.
            await refreshDetail(task.id);
            notify({ tone: 'success', title: 'Approved for publishing' });
          } finally {
            setPrimaryPending(null);
          }
        });
        return;
      case 'continue_in_new_run':
        setPrimaryPending(action.key);
        void perform('continue', 'Could not create the continuation', async () => {
          try {
            const continuationDetail = await expect('workflow:continue', { taskId: task.id });
            notify({ tone: 'success', title: 'Continuation created', body: continuationDetail.task.title });
            // The response already carries the full detail the renderer
            // needs; opening it directly avoids a second `tasks:get`.
            openTaskDetail(continuationDetail);
          } finally {
            setPrimaryPending(null);
          }
        });
        return;
      case 'capture_rules':
      case 'prepare_plan_review':
      case 'run_plan_review':
      case 'reconcile_plan_review':
      case 'retry_plan_review':
      case 'resolve_plan_review':
        planPrimaryDispatch.current?.(action.key);
        return;
    }
  };
  const dispatchPrimary = (): void => dispatchAction(guidance.action);

  // Reasonable per-stage defaults for the sidebar's collapsible sections.
  // Each `key` includes the condition that drives its default so the panel
  // remounts — and re-defaults — exactly when that condition flips, while a
  // manual toggle still wins for as long as the key stays the same.
  const specificationAwaitingApproval = !task.specificationApprovedAt;
  const reviewActionable = task.status === 'CHANGES_REQUESTED';
  const approvalsRelevant = task.status === 'READY_TO_PUBLISH' || task.status === 'PUBLISHING' || task.status === 'COMPLETED';
  const changesRelevant = task.status === 'READY_FOR_REVIEW' || task.status === 'CHANGES_REQUESTED' || task.status === 'APPROVED';
  const publishing = task.status === 'READY_TO_PUBLISH' || task.status === 'PUBLISHING';

  return (
    <div className="run-layout">
      {/* ------------------------------- main ------------------------------- */}
      <div className="run-layout__main">
        <Card title="Actions">
          {dependencyBlocker ? (
            <Notice tone="warn">
              <div className="stack stack--tight" style={{ width: '100%' }}>
                <div>
                  {busy['install-dependencies']
                    ? 'Installing dependencies in this task worktree…'
                    : dependencyBlocker.detail}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={anyBusy || running}
                    onClick={() => {
                      if (installDependenciesClaim.current) return;
                      installDependenciesClaim.current = true;
                      try {
                        installDependencies();
                      } finally {
                        window.setTimeout(() => { installDependenciesClaim.current = false; }, 0);
                      }
                    }}
                  >
                    {busy['install-dependencies'] ? <Spinner /> : null}
                    Install dependencies in task worktree
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}
          {dependencyUnsupported ? (
            <Notice tone="warn">{dependencyUnsupported.detail}</Notice>
          ) : null}
          <RunFlowOverview guidance={guidance} />
          <ProviderControls key={`providers-${task.id}`} task={task} busy={anyBusy || running}
            onChanged={acceptTask} />
          <CompletedHistory runs={detail.runs} />

          <PlanReviewPanel
            key={`plan-review-${task.id}`}
            task={task}
            integrationEnabled={planReviewEnabled}
            onChanged={() => refreshDetail(task.id)}
            onGuidanceStateChanged={updatePlanReviewPreparation}
            renderPrimary={false}
            onDispatchReady={registerPlanDispatcher}
          />

          <CodeReviewPanel
            key={`code-review-${task.id}`}
            task={task}
            integrationEnabled={codeReviewEnabled}
            latestClaudeResult={latestClaudeRoundResult(detail.runs)}
            onCorrectionsSent={acceptTask}
          />

          {dirtyPrompt ? (
            <Notice tone="warn">
              <div className="stack stack--tight" style={{ width: '100%' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{dirtyPrompt}</div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={otherOperationBusy || primaryPending !== null}
                    onClick={() => {
                      if (continueAnywayClaim.current) return;
                      continueAnywayClaim.current = true;
                      try {
                        sendToClaude(true);
                      } finally {
                        window.setTimeout(() => { continueAnywayClaim.current = false; }, 0);
                      }
                    }}
                  >
                    Continue anyway
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => setDirtyPrompt(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}

          {guidance.action ? (
            <div className="actions">
              <PrimaryActionButton
                action={guidance.action}
                pending={primaryPending === guidance.action.key}
                blocked={otherOperationBusy || (
                  dependencyBlocker !== null &&
                  (guidance.action.key === 'run_implementation' || guidance.action.key === 'send_corrections')
                )}
                onClick={dispatchPrimary}
              />
              {dependencyBlocker !== null &&
              (guidance.action.key === 'run_implementation' || guidance.action.key === 'send_corrections') ? (
                <p className="hint">Install dependencies in this task worktree first (above) before running {providerLabel(task.implementationProvider)}.</p>
              ) : null}
            </div>
          ) : null}

          {guidance.action === null && currentVerificationReadiness !== null &&
          (currentVerificationReadiness.state === 'blocked' || currentVerificationReadiness.state === 'unavailable') ? (
            // A waiting state, not a workflow step: what the operator must change, a way to Settings when a setting
            // is what must change, and a re-check for changes made outside the app. Neither control runs anything.
            <Notice tone="warn" role="status">
              <div className="stack">
                <p>
                  <strong>User action required.</strong>{' '}
                  {currentVerificationReadiness.cause === 'output_limit'
                    ? 'Verification output exceeded the Stored log budget, so its result could not be classified. Raise the budget in Settings or reduce what npm run verify prints; verification is offered again once the files or that setting have changed.'
                    : 'One diagnostic re-run was already used for these exact files and ended the same way. Change the files or the verification settings (time limit, stored log budget) before another run, or stop the task; verification is offered again once something has changed.'}
                </p>
                <div className="actions">
                  {currentVerificationReadiness.cause === 'output_limit' ? (
                    <button type="button" className="btn btn--sm" onClick={() => openSettings('maxStoredLogBytes')}>
                      Open Settings · Stored log budget
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setReadinessCheck((value) => value + 1)}>
                    Check for changes
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}

          {publishing || detail.runs.some(isPublishRun) ? (
            <div className="stack" aria-label="Publish">
              <div className="section-title">Publish</div>
              <PublishActivity runs={detail.runs} />
              {publishing ? (
                <PublishPanel
                  key={`publish-${task.id}`}
                  taskId={task.id}
                  runs={detail.runs}
                  onDone={() => refreshDetail(task.id)}
                />
              ) : null}
            </div>
          ) : null}

          <div className="actions actions--control">
            <button
              type="button"
              className="btn btn--danger btn--wide"
              // Stays usable while a correction loop or an agent runs — that is when it is
              // needed — but not while its own request is pending, so a double click cannot
              // send a second Stop for a task that is already ending.
              disabled={busy['stop'] === true || (!running && isTerminal(task.status))}
              aria-busy={busy['stop'] === true}
              onClick={() => {
                // Synchronous, like the other single-flight guards here: the disabled
                // prop above only changes on the next render, and a burst of clicks in
                // one tick must still send one Stop.
                if (stopInFlight.current) return;
                stopInFlight.current = true;
                void perform('stop', 'Could not stop the task', async () => {
                  acceptTask(await expect('workflow:stop', { taskId: task.id }));
                  // What was running read the task back and ended; show the result, not the old state.
                  // Best-effort: the task IS stopped, so a failed read-back must never be reported as a
                  // failed Stop (and must not hide the confirmation below).
                  try {
                    await refreshDetail(task.id);
                  } catch {
                    // The stopped task above is already what the screen holds.
                  }
                  notify({ tone: 'info', title: 'Task stopped' });
                }).finally(() => {
                  stopInFlight.current = false;
                });
              }}
            >
              {busy['stop'] === true ? <Spinner /> : null} {busy['stop'] === true ? 'Stopping…' : 'Stop task'}
            </button>
          </div>
        </Card>

        <Card title="Relay timeline" flush>
          <div style={{ padding: '8px 16px 0' }}>
            <RelayTimeline runs={detail.runs} />
          </div>
          <div className="legend">
            <span className="legend__item">
              <span className="relay__dot relay__dot--codex" style={{ width: 9, height: 9 }} /> Codex
            </span>
            <span className="legend__item">
              <span className="relay__dot relay__dot--claude" style={{ width: 9, height: 9 }} /> Claude Code
            </span>
            <span className="legend__item">
              <span className="relay__dot relay__dot--system" style={{ width: 9, height: 9 }} /> Agent Relay
            </span>
          </div>
        </Card>
      </div>

      {/* ------------------------------ side -------------------------------- */}
      <div className="run-layout__side">
        <Card title="Task" collapsible defaultOpen key={`task-${task.id}`}>
          <div className="stack">
            <div className="row row--wrap">
              <StatusBadge status={task.status} specificationApprovedAt={task.specificationApprovedAt} />
              <Rounds used={task.currentRound} max={task.maxRounds} />
              <span className="faint">
                round {task.currentRound} of {task.maxRounds}
              </span>
            </div>

            <div style={{ fontSize: 15, fontWeight: 600 }}>{task.title}</div>

            <ContinuationLink detail={detail} onOpen={openTask} />

            <div className="kv">
              <span className="kv__k">Project</span>
              <span className="kv__v">{project.name}</span>
              <span className="kv__k">Branch</span>
              <span className="kv__v mono selectable">{task.branchName ?? 'not created yet'}</span>
              <span className="kv__k">Base branch</span>
              <span className="kv__v mono">{task.baseBranch ?? project.defaultBranch}</span>
              <span className="kv__k">Worktree</span>
              <span className="kv__v mono selectable">{task.worktreePath ?? 'not created yet'}</span>
              <span className="kv__k">Codex thread</span>
              <span className="kv__v mono selectable">{task.codexThreadId ?? '—'}</span>
              <span className="kv__k">Claude session</span>
              <span className="kv__v mono selectable">{task.claudeSessionId ?? '—'}</span>
              {/* Snapshotted when the task was created; not editable afterwards. */}
              <span className="kv__k">Codex model</span>
              <span className="kv__v mono selectable" title={task.codexModel ?? undefined}>
                {task.codexModel === null
                  ? 'Tool default'
                  : codexModelLabel(task.codexModel, codexModels?.models ?? [])}
              </span>
              <span className="kv__k">Claude model</span>
              <span className="kv__v mono selectable">{task.claudeModel ?? 'Tool default'}</span>
              <span className="kv__k">Created</span>
              <span className="kv__v">{formatDateTime(task.createdAt)}</span>
            </div>

            {task.worktreePath ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                style={{ alignSelf: 'flex-start' }}
                onClick={() =>
                  void perform('reveal', 'Could not open the folder', async () => {
                    await expect('shell:revealPath', { path: task.worktreePath ?? '' });
                  })
                }
              >
                Open worktree folder
              </button>
            ) : null}

            {task.lastError ? (
              <Notice
                tone={
                  task.status === 'REVIEW_LIMIT_REACHED' || task.status === 'REVIEW_BLOCKED'
                    ? 'warn'
                    : 'error'
                }
              >
                {task.lastError}
              </Notice>
            ) : null}

            <details>
              <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>
                Original request
              </summary>
              <pre className="pre selectable" style={{ marginTop: 8 }}>
                {task.originalRequest}
              </pre>
            </details>
          </div>
        </Card>

        {specification ? (
          <Card
            title="Specification"
            collapsible
            defaultOpen={specificationAwaitingApproval}
            key={`spec-${task.id}-${specificationAwaitingApproval}`}
            actions={<SpecificationStatusTag approvedAt={task.specificationApprovedAt} />}
          >
            <SpecificationPanel specification={specification} />
          </Card>
        ) : null}

        {lastReview ? (
          <Card
            title="Review"
            flush
            collapsible
            defaultOpen={reviewActionable}
            key={`review-${task.id}-${reviewActionable}`}
            actions={<ReviewVerdictTag verdict={lastReview.verdict} />}
          >
            <ReviewPanel review={lastReview} />
          </Card>
        ) : null}

        {detail.approvals.length > 0 ? (
          <Card
            title="Approval trail"
            flush
            collapsible
            defaultOpen={approvalsRelevant}
            key={`approvals-${task.id}-${approvalsRelevant}`}
          >
            {detail.approvals.map((approval) => (
              <div key={approval.id} className="filerow">
                <span className={`tag ${approval.status === 'granted' ? 'tag--ok' : approval.status === 'denied' ? 'tag--danger' : 'tag--warn'}`}>
                  {approval.status}
                </span>
                <span className="filerow__path">{approval.action.replace(/_/g, ' ')}</span>
                <span className="filerow__stat faint">{formatDateTime(approval.resolvedAt ?? approval.requestedAt)}</span>
              </div>
            ))}
          </Card>
        ) : null}

        <Card
          title="Changes and diff"
          flush
          collapsible
          defaultOpen={changesRelevant}
          key={`changes-${task.id}-${changesRelevant}`}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void loadChanges()} disabled={loadingChanges}>
              {loadingChanges ? 'Collecting…' : 'Refresh'}
            </button>
          }
        >
          <ChangesPanel changes={changes} />
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// The two external-review panels live in their own files; existing importers of
// this module (tests, the app) keep working.
export { PlanReviewPanel } from './PlanReviewPanel';
export { CodeReviewPanel } from './CodeReviewPanel';

/* -------------------------------------------------------------------------- */

/** The approval tag shown in the Specification section's collapsed header. */
function SpecificationStatusTag({ approvedAt }: { approvedAt: string | null }): React.JSX.Element {
  return approvedAt ? (
    <span className="tag tag--ok">approved {formatDateTime(approvedAt)}</span>
  ) : (
    <span className="tag tag--warn">awaiting approval</span>
  );
}

function SpecificationPanel({ specification }: { specification: TaskSpecification }): React.JSX.Element {
  return (
    <div className="stack">
      <div style={{ fontWeight: 600 }}>{specification.title}</div>
      <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>
        {specification.summary}
      </div>

      <div>
        <div className="section-title">Acceptance criteria</div>
        <ol className="bullets selectable">
          {specification.acceptanceCriteria.map((criterion, index) => (
            <li key={index}>{criterion}</li>
          ))}
        </ol>
      </div>

      {specification.constraints.length > 0 ? (
        <div>
          <div className="section-title">Constraints</div>
          <ul className="bullets selectable">
            {specification.constraints.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {specification.assumptions.length > 0 ? (
        <div>
          <div className="section-title">Assumptions</div>
          <ul className="bullets selectable">
            {specification.assumptions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {specification.suggestedTests.length > 0 ? (
        <div>
          <div className="section-title">Suggested tests</div>
          <ul className="bullets selectable">
            {specification.suggestedTests.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <details>
        <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>
          Implementation prompt
        </summary>
        <pre className="pre selectable" style={{ marginTop: 8 }}>
          {specification.implementationPrompt}
        </pre>
      </details>
    </div>
  );
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

/** The verdict tag shown in the Review section's collapsed header. */
function ReviewVerdictTag({ verdict }: { verdict: CodexReviewResult['verdict'] }): React.JSX.Element {
  return (
    <span
      className={`tag ${
        verdict === 'approved' ? 'tag--ok' : verdict === 'blocked' ? 'tag--danger' : 'tag--warn'
      }`}
    >
      {verdict.replace(/_/g, ' ')}
    </span>
  );
}

function ReviewPanel({ review }: { review: CodexReviewResult }): React.JSX.Element {
  const counts = SEVERITY_ORDER.map(
    (severity) => [severity, review.findings.filter((f) => f.severity === severity).length] as const
  ).filter(([, count]) => count > 0);

  return (
    <>
      <div style={{ padding: 16, borderBottom: review.findings.length > 0 ? '1px solid var(--border)' : 'none' }}>
        <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>
          {review.summary}
        </div>
        {counts.length > 0 ? (
          <div className="row row--wrap" style={{ marginTop: 10 }}>
            {counts.map(([severity, count]) => (
              <span key={severity} className={`sev sev--${severity}`}>
                {count} {severity}
              </span>
            ))}
            <span className="faint">{pluralize(review.findings.length, 'finding')}</span>
          </div>
        ) : null}
      </div>

      {SEVERITY_ORDER.flatMap((severity) =>
        review.findings
          .filter((finding) => finding.severity === severity)
          .map((finding, index) => (
            <div key={`${severity}-${index}`} className={`finding finding--${severity}`}>
              <div className="finding__head">
                <span className={`sev sev--${severity}`}>{severity}</span>
                <span className="finding__title selectable">{finding.title}</span>
                {finding.file ? (
                  <span className="finding__where selectable">
                    {finding.file}
                    {finding.line != null ? `:${finding.line}` : ''}
                  </span>
                ) : null}
              </div>
              <div className="finding__desc selectable">{finding.description}</div>
            </div>
          ))
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

interface PublishActionOption {
  readonly value: ApprovalAction;
  readonly label: string;
  readonly buttonLabel: string;
  readonly pendingLabel: string;
}

const PUBLISH_ACTIONS: readonly PublishActionOption[] = [
  {
    value: 'commit',
    label: 'Commit changes (local)',
    buttonLabel: 'Create local commit',
    pendingLabel: 'Creating local commit…'
  },
  {
    value: 'create_repository',
    label: 'Create GitHub repository',
    buttonLabel: 'Create GitHub repository',
    pendingLabel: 'Creating GitHub repository…'
  },
  {
    value: 'push',
    label: 'Push branch to origin',
    buttonLabel: 'Push branch to origin',
    pendingLabel: 'Pushing branch to origin…'
  },
  {
    value: 'create_pull_request',
    label: 'Open pull request',
    buttonLabel: 'Open pull request',
    pendingLabel: 'Opening pull request…'
  }
];

function isPublishRun(run: Run): boolean {
  return (
    run.agent === 'system' &&
    (run.runType === 'git' || run.runType === 'github') &&
    readPublishAction(run) !== null
  );
}

function readPublishAction(run: Run): { action: ApprovalAction; url: string | null } | null {
  if (!run.structuredResult) return null;
  try {
    const value = JSON.parse(run.structuredResult) as { action?: unknown; url?: unknown };
    if (!APPROVAL_ACTIONS.includes(value.action as ApprovalAction)) return null;
    return {
      action: value.action as ApprovalAction,
      url: typeof value.url === 'string' ? value.url : null
    };
  } catch {
    return null;
  }
}

function publishOption(action: ApprovalAction): PublishActionOption {
  const option = PUBLISH_ACTIONS.find((candidate) => candidate.value === action);
  if (!option) throw new Error(`Unknown publish action: ${action}`);
  return option;
}

function recommendedPublishAction(runs: readonly Run[]): ApprovalAction {
  const completed = new Set(
    runs
      .filter((run) => isPublishRun(run) && run.status === 'succeeded')
      .map(readPublishAction)
      .filter((value): value is { action: ApprovalAction; url: string | null } => value !== null)
      .map((value) => value.action)
  );
  if (!completed.has('commit')) return 'commit';
  if (!completed.has('push')) return 'push';
  if (!completed.has('create_pull_request')) return 'create_pull_request';
  return 'commit';
}

function nextPublishAction(action: ApprovalAction): ApprovalAction {
  if (action === 'commit' || action === 'create_repository') return 'push';
  if (action === 'push') return 'create_pull_request';
  return 'commit';
}

function PublishActivity({ runs }: { runs: readonly Run[] }): React.JSX.Element | null {
  const published = runs.filter(isPublishRun).slice(-4).reverse();
  if (published.length === 0) return null;

  return (
    <section className="publish-activity" aria-label="Publishing activity">
      <div className="publish-activity__title">Publishing activity</div>
      {published.map((run) => {
        const stored = readPublishAction(run);
        const option = stored ? publishOption(stored.action) : null;
        const state = run.status === 'succeeded' ? 'success' : run.status === 'running' ? 'running' : 'error';
        const message = run.finalMessage ?? run.errorMessage ?? (run.status === 'running' ? 'Operation in progress…' : 'No result was recorded.');
        return (
          <div key={run.id} className={`publish-activity__item publish-activity__item--${state}`}>
            <span className="publish-activity__mark" aria-hidden="true">
              {run.status === 'succeeded' ? '✓' : run.status === 'running' ? <Spinner /> : '!'}
            </span>
            <div className="publish-activity__result">
              <strong>{option?.buttonLabel ?? (run.runType === 'git' ? 'Git operation' : 'GitHub operation')}</strong>
              <span className="selectable">{message}</span>
            </div>
            <span className="publish-activity__time">{formatDateTime(run.finishedAt ?? run.startedAt)}</span>
            {stored?.url ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost publish-activity__link"
                onClick={() => void call('shell:openExternal', { url: stored.url as string })}
              >
                Open
              </button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

interface PublishFeedback {
  readonly tone: 'info' | 'success' | 'error';
  readonly title: string;
  readonly body: string;
}

function feedbackForOutcome(outcome: PublishOutcome): PublishFeedback {
  return {
    tone: outcome.performed ? 'success' : 'info',
    title: outcome.performed ? `${publishOption(outcome.action).buttonLabel} succeeded` : 'Action cancelled',
    body: outcome.message
  };
}

function PublishPanel({
  taskId,
  runs,
  onDone
}: {
  taskId: string;
  runs: readonly Run[];
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const { perform, notify, detail, busy } = useStore();
  const [action, setAction] = useState<ApprovalAction>(() => recommendedPublishAction(runs));
  const [commitMessage, setCommitMessage] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [owner, setOwner] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [confirmation, setConfirmation] = useState<PublishConfirmation | null>(null);
  const [pendingAction, setPendingAction] = useState<ApprovalAction | null>(null);
  const [feedback, setFeedback] = useState<PublishFeedback | null>(null);
  const claim = useRef(false);
  const blocked = pendingAction !== null || busy['publish'] === true;
  const selectedOption = publishOption(action);

  // `publish:prepare` is side-effect free by contract, so previewing on every
  // edit is safe. It shows the user exactly what the confirmation dialog will
  // say before they commit to it.
  const fetchPreview = useCallback(async (): Promise<PublishConfirmation | null> => {
    const result = await call('publish:prepare', {
      taskId,
      action,
      ...(commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {}),
      ...(repositoryName.trim() ? { repositoryName: repositoryName.trim() } : {}),
      ...(owner.trim() ? { owner: owner.trim() } : {}),
      ...(prTitle.trim() ? { pullRequestTitle: prTitle.trim() } : {})
    });
    return result.ok ? result.data : null;
  }, [taskId, action, commitMessage, repositoryName, owner, prTitle]);

  useEffect(() => {
    let active = true;
    void fetchPreview().then((value) => {
      if (active) setConfirmation(value);
    });
    return () => {
      active = false;
    };
  }, [fetchPreview]);

  return (
    <div className="stack">
      <Notice tone="warn">
        Every action below opens a confirmation dialog owned by the application itself. Nothing is
        committed, pushed, or created on GitHub until you accept that dialog.
      </Notice>

      <Field label="Action">
        <select
          className="select"
          value={action}
          disabled={blocked}
          onChange={(e) => {
            setAction(e.target.value as ApprovalAction);
            setFeedback(null);
          }}
        >
          {PUBLISH_ACTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>

      {action === 'commit' ? (
        <Field label="Commit message" hint="Leave empty to use the generated message.">
          <textarea
            className="textarea"
            rows={3}
            value={commitMessage}
            disabled={blocked}
            placeholder={detail?.task.title ?? ''}
            onChange={(e) => setCommitMessage(e.target.value)}
          />
        </Field>
      ) : null}

      {action === 'create_repository' ? (
        <div className="grid-2">
          <Field label="Owner">
            <input
              className="input input--mono"
              value={owner}
              disabled={blocked}
              placeholder={detail?.project.githubOwner ?? ''}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
          <Field label="Repository name">
            <input
              className="input input--mono"
              value={repositoryName}
              disabled={blocked}
              placeholder={detail?.project.githubRepo ?? detail?.project.name ?? ''}
              onChange={(e) => setRepositoryName(e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {action === 'create_pull_request' ? (
        <Field label="Pull request title" hint="Leave empty to use the task title.">
          <input className="input" value={prTitle} disabled={blocked} onChange={(e) => setPrTitle(e.target.value)} />
        </Field>
      ) : null}

      {confirmation ? (
        <div className="pre selectable" style={{ maxHeight: 220 }}>
          {[
            confirmation.headline,
            '',
            `Account / owner:  ${confirmation.account}`,
            `Repository:       ${confirmation.repository}`,
            `Visibility:       ${confirmation.visibility}`,
            `Branch:           ${confirmation.branch}`,
            '',
            ...confirmation.details
          ].join('\n')}
        </div>
      ) : null}

      {feedback ? (
        <Notice tone={feedback.tone}>
          <div className="publish-feedback" role="status" aria-live="polite">
            <strong>{feedback.title}</strong>
            <span className="selectable">{feedback.body}</span>
          </div>
        </Notice>
      ) : null}

      <button
        type="button"
        className="btn btn--primary btn--wide"
        disabled={blocked || confirmation === null}
        onClick={() => {
          if (claim.current) return;
          claim.current = true;
          const requestedAction = action;
          const requestedOption = publishOption(requestedAction);
          setPendingAction(requestedAction);
          setFeedback({
            tone: 'info',
            title: requestedOption.pendingLabel,
            body: 'Waiting for the operation to finish. Keep this task open.'
          });
          void perform('publish', 'The publish step failed', async () => {
            try {
              const outcome = await expect('publish:execute', {
                taskId,
                action: requestedAction,
                ...(commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {}),
                ...(repositoryName.trim() ? { repositoryName: repositoryName.trim() } : {}),
                ...(owner.trim() ? { owner: owner.trim() } : {}),
                ...(prTitle.trim() ? { pullRequestTitle: prTitle.trim() } : {})
              });

              const nextFeedback = feedbackForOutcome(outcome);
              setFeedback(nextFeedback);
              notify({
                tone: outcome.performed ? 'success' : 'info',
                title: nextFeedback.title,
                body: outcome.message
              });

              if (outcome.performed) setAction(nextPublishAction(requestedAction));
              if (outcome.url) await call('shell:openExternal', { url: outcome.url });
            } catch (error) {
              const described = describeError(error);
              setFeedback({
                tone: 'error',
                title: `${requestedOption.buttonLabel} failed`,
                body: described.remediation
                  ? `${described.message} ${described.remediation}`
                  : described.message
              });
              throw error;
            } finally {
              try {
                await onDone();
              } finally {
                setPendingAction(null);
                claim.current = false;
              }
            }
          });
        }}
      >
        {pendingAction !== null ? <Spinner /> : <Scope kind={confirmation?.affectsRemote ? 'remote' : 'local'} />}
        {pendingAction !== null ? publishOption(pendingAction).pendingLabel : selectedOption.buttonLabel}
      </button>
    </div>
  );
}
