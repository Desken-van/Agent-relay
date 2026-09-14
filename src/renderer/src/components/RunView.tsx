import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canChangeProviders,
  providerLabel,
  type ImplementationProvider,
  type ReviewProvider
} from '@shared/domain/execution-providers';
import type { LocalInferenceStateKind } from '@shared/domain/local-inference';
import type { GitChangeSet } from '@shared/domain/git';
import type { ApprovalAction, Run, Task } from '@shared/domain/models';
import type { PlanReviewDecision } from '@shared/domain/plan-review';
import {
  runGuidance,
  type PlanReviewPreparation,
  type RunActionKey,
  type RunGuidance,
  type RunPrimaryAction
} from '@shared/domain/run-guidance';
import { isBusy } from '@shared/domain/workflow';
import type { PlanReviewDetail, PublishConfirmation, TaskDetail } from '@shared/ipc';
import type { CodexReviewResult, FindingSeverity, TaskSpecification } from '@shared/schemas/codex';
import { ApiError, call, expect } from '../lib/api';
import { formatDateTime, pluralize } from '../lib/format';
import { useStore } from '../state/store';
import { ChangesPanel } from './ChangesPanel';
import { codexModelLabel } from './TasksView';
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
  </section>;
}

/** Blast-radius icon for a primary action, mirrored from what the dispatched channel actually does. */
const ACTION_SCOPE: Record<RunActionKey, 'read' | 'local' | 'remote'> = {
  capture_rules: 'read',
  generate_specification: 'read',
  prepare_plan_review: 'local',
  run_plan_review: 'read',
  reconcile_plan_review: 'read',
  resolve_plan_review: 'read',
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
  const { selectedTaskId, detail, refreshDetail, openTaskDetail, acceptTask, perform, notify, busy, codexModels, settings } = store;

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
  const planPrimaryDispatch = useRef<((key: RunActionKey) => void) | null>(null);
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

  if (!selectedTaskId || !detail) {
    return (
      <Card>
        <Empty title="No task selected" hint="Choose a task on the Tasks screen." />
      </Card>
    );
  }

  const { task, project, specification, lastReview } = detail;
  const planReviewEnabled = settings?.externalPlanReviewEnabled ?? false;
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
      ornithLocalInferenceState: ornithReadiness?.taskId === task.id ? ornithReadiness.kind : null
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

  /** Every non-plan-review primary action: exactly one bounded IPC call, then one read-only refresh. */
  const dispatchPrimary = (): void => {
    const action = guidance.action;
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
      case 'resolve_plan_review':
        planPrimaryDispatch.current?.(action.key);
        return;
    }
  };

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

          {dirtyPrompt ? (
            <Notice tone="warn">
              <div className="stack stack--tight" style={{ width: '100%' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{dirtyPrompt}</div>
                <div className="row">
                  <button type="button" className="btn btn--sm" onClick={() => sendToClaude(true)}>
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
                blocked={otherOperationBusy}
                onClick={dispatchPrimary}
              />
            </div>
          ) : null}

          {publishing ? (
            <div className="stack" aria-label="Publish">
              <div className="section-title">Publish</div>
              <PublishPanel taskId={task.id} onDone={() => void refreshDetail(task.id)} />
            </div>
          ) : null}

          <div className="actions actions--control">
            <button
              type="button"
              className="btn btn--danger btn--wide"
              disabled={!running && isTerminal(task.status)}
              onClick={() =>
                void perform('stop', 'Could not stop the task', async () => {
                  acceptTask(await expect('workflow:stop', { taskId: task.id }));
                  notify({ tone: 'info', title: 'Task stopped' });
                })
              }
            >
              Stop task
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
              <StatusBadge status={task.status} />
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

            {task.lastError ? <Notice tone="error">{task.lastError}</Notice> : null}

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

type DecisionDraft = { action: '' | 'accept' | 'reject'; reason: string };

/** Decision drafts, tagged with the round they answer. */
type DecisionDrafts = {
  readonly roundKey: string | null;
  readonly drafts: Record<number, DecisionDraft>;
};

/** Shared empty map, so a stale round renders no drafts and no new objects. */
const NO_DRAFTS: Record<number, DecisionDraft> = {};
const NO_PLAN_REVIEW_FINDINGS: PlanReviewDetail['findings'] = [];

function planReviewPreparationState(input: {
  readonly task: Task;
  readonly integrationEnabled: boolean;
  readonly loading: boolean;
  readonly busy: string | null;
  readonly error: string | null;
  readonly detail: PlanReviewDetail | null;
  readonly resolutionReady?: boolean;
}): PlanReviewPreparation {
  const { task, integrationEnabled, loading, busy, error, detail, resolutionReady = false } = input;
  const awaitingApproval =
    task.status === 'DRAFT' ||
    (task.status === 'READY_FOR_IMPLEMENTATION' && !task.specificationApprovedAt);
  if (!awaitingApproval) return 'not_required';
  if (loading) return 'loading';
  if (error !== null || detail === null || detail.ruleEvidenceProblem !== null) return 'unavailable';
  if (!integrationEnabled) return detail.ruleEvidence ? 'unavailable' : 'not_required';
  if (busy !== null) return 'working';
  if (task.status === 'DRAFT') return detail.ruleEvidence ? 'ready' : 'capture_rules';
  if (!detail.ruleEvidence) return 'not_required';

  const gate = detail.gate;
  if (gate === null) return 'prepare_review';
  if (['opening', 'reviewing', 'resolving', 'failed'].includes(gate.status)) return 'reconcile';
  if (gate.status === 'awaiting_resolve') return resolutionReady ? 'resolve' : 'resolve_blocked';
  if (detail.gateIdentity === 'current') {
    if (gate.status === 'prepared') return 'run_review';
    if (gate.status === 'changes_requested' || gate.status === 'interrupted') return 'run_next_review';
    if (gate.status === 'proceeded') return 'passed';
  }
  if (detail.gateIdentity === 'obsolete' &&
      !['opening', 'reviewing', 'awaiting_resolve', 'resolving', 'failed'].includes(gate.status)) {
    return 'prepare_review';
  }
  return 'unavailable';
}

/**
 * External plan review, folded into Run → Actions.
 *
 * Renders active status, verdict, findings, decision inputs, the last error
 * and any evidence problem as passive content, plus — at most — the single
 * primary button this state calls for. There is no separate card for it: it
 * lives inside Actions, right alongside the rest of the workflow.
 *
 * This component decides its own button from the same durable state
 * `runGuidance` reads (via {@link planReviewPreparationState}, reported
 * upward through `onGuidanceStateChanged`), so the two can never disagree —
 * `RunView` uses that same reported state to know when to suppress its own,
 * separate primary button rather than duplicating this one. No plan-review
 * success handler here ever triggers a second plan-review operation.
 */
export function PlanReviewPanel({
  task,
  integrationEnabled,
  onChanged,
  onGuidanceStateChanged,
  renderPrimary = true,
  onDispatchReady
}: {
  task: Task;
  integrationEnabled: boolean;
  onChanged: () => Promise<void>;
  onGuidanceStateChanged?: (state: PlanReviewPreparation) => void;
  renderPrimary?: boolean;
  onDispatchReady?: (dispatcher: ((key: RunActionKey) => void) | null) => void;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<PlanReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtyPrompt, setDirtyPrompt] = useState(false);
  const [draftState, setDraftState] = useState<DecisionDrafts>({ roundKey: null, drafts: {} });
  const roundKey = detail?.gate ? `${detail.gate.id}:${detail.gate.revision}` : null;
  const decisions = draftState.roundKey === roundKey ? draftState.drafts : NO_DRAFTS;
  const setDecisions = useCallback(
    (update: (current: Record<number, DecisionDraft>) => Record<number, DecisionDraft>): void => {
      setDraftState((current) => ({
        roundKey,
        drafts: update(current.roundKey === roundKey ? current.drafts : {})
      }));
    },
    [roundKey]
  );

  useEffect(() => {
    let active = true;
    void call('planReview:get', { taskId: task.id }).then((result) => {
      if (!active) return;
      if (result.ok) {
        setDetail(result.data);
        setError(null);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [task.id]);

  const gate = detail?.gate ?? null;
  const findings = detail?.findings ?? NO_PLAN_REVIEW_FINDINGS;
  const allDecided = findings.every((_, index) => {
    const decision = decisions[index];
    return decision?.action === 'accept' ||
      (decision?.action === 'reject' && decision.reason.trim().length > 0);
  });
  const guidanceState = planReviewPreparationState({
    task,
    integrationEnabled,
    loading,
    busy,
    error,
    detail,
    resolutionReady: allDecided
  });
  useEffect(() => {
    onGuidanceStateChanged?.(guidanceState);
  }, [guidanceState, onGuidanceStateChanged]);

  const act = useCallback(async (
    key: string,
    operation: () => Promise<PlanReviewDetail>
  ): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(key);
    setError(null);
    try {
      const next = await operation();
      setDetail(next);
      setDirtyPrompt(false);
      await onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'GIT_DIRTY' && key === 'prepare') {
        setDirtyPrompt(true);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        // A failed `review` or `resolve` is the one case where the screen is now
        // lying. Both write their durable phase before they dispatch, so a lost
        // answer leaves the gate at `reviewing` or `resolving` in the main
        // process while this panel still holds the `prepared` or
        // `awaiting_resolve` it rendered before the click. One read-only
        // read-back fixes the display — never the operation itself, since
        // `review` and `resolve` are not idempotent and may already have
        // taken effect.
        if (key === 'review' || key === 'resolve') {
          try {
            setDetail(await expect('planReview:get', { taskId: task.id }));
          } catch {
            // Nothing to add: the operator already has the failure that matters.
          }
        }
      }
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  }, [onChanged, task.id]);

  const dispatchPlanPrimary = useCallback((key: RunActionKey): void => {
    switch (key) {
      case 'capture_rules':
        void act('bind', () => expect('planReview:bindRules', { taskId: task.id }));
        return;
      case 'prepare_plan_review':
        void act('prepare', () => expect('planReview:prepare', {
          taskId: task.id,
          ...(dirtyPrompt ? { acceptDirtyWorkingTree: true } : {})
        }));
        return;
      case 'run_plan_review':
        void act('review', () => expect('planReview:review', { taskId: task.id }));
        return;
      case 'reconcile_plan_review':
        void act('reconcile', () => expect('planReview:reconcile', { taskId: task.id }));
        return;
      case 'resolve_plan_review': {
        if (!gate || !allDecided) return;
        const payload: PlanReviewDecision[] = findings.map((_, index) => ({
          finding: index,
          action: decisions[index]!.action as 'accept' | 'reject',
          reason: decisions[index]!.reason.trim()
        }));
        void act('resolve', () => expect('planReview:resolve', {
          taskId: task.id,
          gateId: gate.id,
          expectedRevision: gate.revision,
          decisions: payload
        }));
        return;
      }
      default:
        return;
    }
  }, [act, allDecided, decisions, dirtyPrompt, findings, gate, task.id]);
  useEffect(() => {
    onDispatchReady?.(dispatchPlanPrimary);
    return () => onDispatchReady?.(null);
  }, [onDispatchReady, dispatchPlanPrimary]);

  const corrupt = detail?.ruleEvidenceProblem ?? null;
  if (!integrationEnabled && !detail?.ruleEvidence && corrupt === null) return null;

  const unknownOutcome =
    gate !== null && ['opening', 'reviewing', 'resolving', 'failed'].includes(gate.status);

  const identity = detail?.gateIdentity ?? 'no_gate';
  const obsolete = gate !== null && identity === 'obsolete';
  const obsoleteBlocking =
    obsolete &&
    ['opening', 'reviewing', 'awaiting_resolve', 'resolving', 'failed'].includes(gate.status);
  const obsoleteSettled = obsolete && !obsoleteBlocking;
  const identityUnknown = gate !== null && identity === 'unknown';

  return (
    <div className="stack" aria-label="External plan review">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">External plan review</div>
        {gate ? <span className={`tag ${gate.status === 'proceeded' ? 'tag--ok' : gate.status === 'failed' ? 'tag--danger' : 'tag--warn'}`}>{gate.status.replace(/_/g, ' ')}</span> : null}
      </div>
      {loading ? <div className="muted">Loading rule and review evidence…</div> : null}
      {!integrationEnabled ? (
        <Notice tone="warn">This task is bound to external review evidence. Re-enable the integration in Settings to continue it.</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {gate && gate.status !== 'awaiting_resolve' ? (
        <div className="kv" aria-label="External plan review result">
          <span className="kv__k">Result</span><span className="kv__v">{gate.verdict ?? 'No verdict recorded'}</span>
          <span className="kv__k">Required action</span><span className="kv__v">{guidanceState.replace(/_/g, ' ')}</span>
          <span className="kv__k">Reviewers</span><span className="kv__v selectable">{gate.reviewers}</span>
        </div>
      ) : null}
      {gate && gate.status !== 'awaiting_resolve' && findings.length > 0 ? (
        <details>
          <summary className="faint" style={{ cursor: 'pointer' }}>
            Findings ({findings.length})
          </summary>
          <div className="stack stack--tight" style={{ marginTop: 8 }}>
            {findings.map((finding, index) => (
              <div className="finding" key={`${index}:${finding.title}`}>
                <div className="finding__head">
                  <span className={`tag ${finding.severity === 'blocking' || finding.severity === 'major' ? 'tag--danger' : 'tag--warn'}`}>{finding.severity}</span>
                  <span className="finding__title selectable">{finding.title}</span>
                </div>
                <div className="finding__desc selectable">{finding.why}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {corrupt !== null ? (
        <Notice tone="error">
          <strong>The bound rule evidence cannot be read.</strong> This task is bound to a
          rule snapshot, but the stored bytes no longer match their recorded hash or no
          longer parse. Rebinding is refused because the binding is immutable, and Agent
          Relay will not silently replace evidence a specification was reviewed against.
          <div className="mono selectable" style={{ marginTop: 6 }}>{corrupt}</div>
        </Notice>
      ) : !detail?.ruleEvidence ? (
        <>
          <div className="muted">
            Capture the project&apos;s current rule files and the configured conventions before
            generating the specification. The resulting bytes and Git identity are immutable.
          </div>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || task.status !== 'DRAFT'}
            onClick={() => void act('bind', () => expect('planReview:bindRules', { taskId: task.id }))}
          >
            {busy === 'bind' ? <Spinner /> : <Scope kind="read" />} Capture and bind rules
          </button> : null}
          {task.status !== 'DRAFT' ? (
            <Notice tone="info">This existing task did not opt in before specification generation. Its normal workflow remains unchanged.</Notice>
          ) : null}
        </>
      ) : (
        <>
          <div className="kv">
            <span className="kv__k">Evidence</span>
            <span className="kv__v mono selectable">{detail.ruleEvidence.snapshotSha256}</span>
            <span className="kv__k">Sources</span>
            <span className="kv__v">{detail.ruleEvidence.sources.length}</span>
            <span className="kv__k">Files</span>
            <span className="kv__v">{detail.ruleEvidence.files.length}</span>
            <span className="kv__k">Bytes</span>
            <span className="kv__v">{detail.ruleEvidence.totalBytes.toLocaleString()}</span>
          </div>
          <details>
            <summary className="faint" style={{ cursor: 'pointer' }}>Captured files and omissions</summary>
            <div className="stack stack--tight" style={{ marginTop: 8 }}>
              {detail.ruleEvidence.files.map((file) => (
                <div className="filerow" key={`${file.sourceId}:${file.path}`}>
                  <span className="tag">{file.sourceId}</span>
                  <span className="filerow__path mono selectable">{file.path}</span>
                  <span className="filerow__stat faint">{file.bytes} B</span>
                </div>
              ))}
              {detail.ruleEvidence.omitted.map((item) => (
                <div className="filerow" key={`${item.sourceId}:${item.path}:${item.reason}`}>
                  <span className="tag tag--warn">omitted</span>
                  <span className="filerow__path mono selectable">{item.sourceId}: {item.path}</span>
                  <span className="filerow__stat faint">{item.reason}</span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      {renderPrimary && detail?.ruleEvidence && task.status === 'READY_FOR_IMPLEMENTATION' && gate === null ? (
        <button
          type="button"
          className="btn btn--wide btn--primary btn--recommended"
          disabled={!integrationEnabled || busy !== null}
          onClick={() => void act('prepare', () => expect('planReview:prepare', { taskId: task.id }))}
        >
          {busy === 'prepare' ? <Spinner /> : <Scope kind="local" />} Prepare isolated review branch
        </button>
      ) : null}

      {obsoleteSettled ? (
        <div className="stack stack--tight">
          <Notice tone="warn">
            This review settled against an earlier specification. The one on screen now has
            not been reviewed, so it cannot be approved on the strength of that round.
          </Notice>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || task.status !== 'READY_FOR_IMPLEMENTATION'}
            onClick={() => void act('prepare', () => expect('planReview:prepare', { taskId: task.id }))}
          >
            {busy === 'prepare' ? <Spinner /> : <Scope kind="local" />} Prepare isolated review branch
          </button> : null}
        </div>
      ) : null}

      {obsoleteBlocking ? (
        <Notice tone="warn">
          This review settled against an earlier specification, and its previous round is
          still outstanding. Finish that round first — regenerating the specification does
          not close it, and nothing here may start a second one over it.
        </Notice>
      ) : null}

      {identityUnknown ? (
        <Notice tone="warn">
          Whether this review still matches the current specification could not be
          established, because the bound evidence or the specification itself could not be
          read. That is not the same as the review being out of date, and Agent Relay will
          not say it is: nothing here is approved, and preparing a new review would need
          the evidence that could not be read.
        </Notice>
      ) : null}

      {dirtyPrompt ? (
        <Notice tone="warn">
          The project checkout is dirty. The isolated task branch can still be based on its
          current HEAD, but uncommitted project changes are not copied.
          {renderPrimary ? (
            <button
              type="button"
              className="btn btn--sm"
              style={{ marginTop: 8 }}
              disabled={busy !== null}
              onClick={() => dispatchPlanPrimary('prepare_plan_review')}
            >
              Continue with current HEAD
            </button>
          ) : ' Click “Prepare isolated review branch” again to continue from the current HEAD.'}
        </Notice>
      ) : null}

      {gate?.status === 'interrupted' && identity === 'current' ? (
        <Notice tone="warn">
          A previous round was started in the provider and never finished. It produced no
          findings and nothing is waiting on decisions, so a new round can be started by
          hand — nothing will be repeated.
        </Notice>
      ) : null}

      {/*
        Starting a round is offered only when the gate is PROVEN to describe the
        specification on screen. `obsolete` would review the wrong document, and
        `unknown` cannot say which document it would review — and a round is
        non-idempotent, so an unverifiable one is not worth spending. The same
        fixed label is used for a first round and a next round: the operator is
        starting the external review either way, and the distinction is already
        carried by "What happened" and "Result" above.
      */}
      {renderPrimary && gate && identity === 'current' && ['prepared', 'changes_requested', 'interrupted'].includes(gate.status) ? (
        <button
          type="button"
          className="btn btn--wide btn--primary btn--recommended"
          disabled={!integrationEnabled || busy !== null}
          onClick={() => void act('review', () => expect('planReview:review', { taskId: task.id }))}
        >
          {busy === 'review' ? <Spinner /> : <Scope kind="read" />} Run external plan review
        </button>
      ) : null}

      {unknownOutcome ? (
        <div className="stack stack--tight">
          <Notice tone="warn">
            The external call was recorded as {gate?.status.replace(/_/g, ' ')} and its answer
            never arrived. Agent Relay will not repeat it: a plan round and a resolution are
            not idempotent, and either may already have taken effect. Reconciling reads the
            provider&apos;s own state back without changing it.
          </Notice>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null}
            onClick={() => void act('reconcile', () => expect('planReview:reconcile', { taskId: task.id }))}
          >
            {busy === 'reconcile' ? <Spinner /> : <Scope kind="read" />} Reconcile external state
          </button> : null}
        </div>
      ) : null}
      {gate?.lastError ? <Notice tone="error">{gate.lastError}</Notice> : null}

      {gate?.status === 'awaiting_resolve' ? (
        <div className="stack">
          <Notice tone="warn">
            The verdict does not approve the plan. Decide every finding, then resolve the
            external round. Rejecting a finding requires a written reason.
          </Notice>
          <div className="kv">
            <span className="kv__k">Verdict</span><span className="kv__v">{gate.verdict}</span>
            <span className="kv__k">Gating</span><span className="kv__v">{gate.gatingCount} / threshold {gate.threshold}</span>
            <span className="kv__k">Reviewers</span><span className="kv__v selectable">{gate.reviewers}</span>
          </div>
          {findings.map((finding, index) => {
            const decision = decisions[index] ?? { action: '', reason: '' };
            return (
              <div className="finding" key={`${index}:${finding.title}`}>
                <div className="finding__head">
                  <span className={`tag ${finding.severity === 'blocking' || finding.severity === 'major' ? 'tag--danger' : 'tag--warn'}`}>{finding.severity}</span>
                  <span className="finding__title selectable">{finding.title}</span>
                  <span className="finding__where selectable">{finding.category}{finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}</span>
                </div>
                <div className="finding__desc selectable">{finding.why}</div>
                <div className="muted selectable" style={{ marginTop: 6 }}>Suggested: {finding.fix}</div>
                <div className="grid-2" style={{ marginTop: 10 }}>
                  <Field label="Decision">
                    <select
                      className="select"
                      value={decision.action}
                      onChange={(event) => setDecisions((current) => ({
                        ...current,
                        [index]: { ...decision, action: event.target.value as DecisionDraft['action'] }
                      }))}
                    >
                      <option value="">Choose…</option>
                      <option value="accept">Accept and address</option>
                      <option value="reject">Reject with reason</option>
                    </select>
                  </Field>
                  <Field label="Reason" hint={decision.action === 'reject' ? 'Required' : 'Optional audit note'}>
                    <input
                      className="input"
                      value={decision.reason}
                      onChange={(event) => setDecisions((current) => ({
                        ...current,
                        [index]: { ...decision, reason: event.target.value }
                      }))}
                    />
                  </Field>
                </div>
              </div>
            );
          })}
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || !allDecided}
            onClick={() => {
              if (!gate) return;
              const payload: PlanReviewDecision[] = findings.map((_, index) => ({
                finding: index,
                action: decisions[index]!.action as 'accept' | 'reject',
                reason: decisions[index]!.reason.trim()
              }));
              void act('resolve', () => expect('planReview:resolve', {
                taskId: task.id,
                gateId: gate.id,
                expectedRevision: gate.revision,
                decisions: payload
              }));
            }}
          >
            {busy === 'resolve' ? <Spinner /> : <Scope kind="read" />} Resolve external plan review
          </button> : null}
        </div>
      ) : null}

      {gate?.status === 'proceeded' && identity === 'current' ? (
        <Notice tone="info">The exact specification and rule snapshot passed resolution. You may now approve the specification.</Notice>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

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

const PUBLISH_ACTIONS: ReadonlyArray<{ value: ApprovalAction; label: string }> = [
  { value: 'commit', label: 'Commit changes (local)' },
  { value: 'create_repository', label: 'Create GitHub repository' },
  { value: 'push', label: 'Push branch to origin' },
  { value: 'create_pull_request', label: 'Open pull request' }
];

function PublishPanel({ taskId, onDone }: { taskId: string; onDone: () => void }): React.JSX.Element {
  const { perform, notify, detail } = useStore();
  const [action, setAction] = useState<ApprovalAction>('commit');
  const [commitMessage, setCommitMessage] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [owner, setOwner] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [confirmation, setConfirmation] = useState<PublishConfirmation | null>(null);

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
          onChange={(e) => setAction(e.target.value as ApprovalAction)}
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
              placeholder={detail?.project.githubOwner ?? ''}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
          <Field label="Repository name">
            <input
              className="input input--mono"
              value={repositoryName}
              placeholder={detail?.project.githubRepo ?? detail?.project.name ?? ''}
              onChange={(e) => setRepositoryName(e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {action === 'create_pull_request' ? (
        <Field label="Pull request title" hint="Leave empty to use the task title.">
          <input className="input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
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

      <button
        type="button"
        className="btn btn--danger btn--wide"
        onClick={() =>
          void perform('publish', 'The publish step failed', async () => {
            const outcome = await expect('publish:execute', {
              taskId,
              action,
              ...(commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {}),
              ...(repositoryName.trim() ? { repositoryName: repositoryName.trim() } : {}),
              ...(owner.trim() ? { owner: owner.trim() } : {}),
              ...(prTitle.trim() ? { pullRequestTitle: prTitle.trim() } : {})
            });

            notify({
              tone: outcome.performed ? 'success' : 'info',
              title: outcome.performed ? 'Done' : 'Cancelled',
              body: outcome.message
            });

            if (outcome.url) {
              await call('shell:openExternal', { url: outcome.url });
            }
            onDone();
          })
        }
      >
        <Scope kind={confirmation?.affectsRemote ? 'remote' : 'local'} />
        Confirm and run…
      </button>
    </div>
  );
}
