import { useCallback, useEffect, useRef, useState } from 'react';
import { correctionAction, latestClaudeRoundResult } from '@shared/domain/claude-assessment';
import type { GitChangeSet } from '@shared/domain/git';
import type { ApprovalAction, Task } from '@shared/domain/models';
import type { PlanReviewDecision } from '@shared/domain/plan-review';
import { isBusy } from '@shared/domain/workflow';
import type { PlanReviewDetail, PublishConfirmation } from '@shared/ipc';
import type { CodexReviewResult, FindingSeverity, TaskSpecification } from '@shared/schemas/codex';
import { ApiError, call, expect } from '../lib/api';
import { formatDateTime, pluralize } from '../lib/format';
import { useStore } from '../state/store';
import { ChangesPanel } from './ChangesPanel';
import { codexModelLabel } from './TasksView';
import { Card, Empty, Field, Notice, Rounds, Scope, Spinner, StatusBadge } from './primitives';
import { RelayTimeline } from './RelayTimeline';

export function RunView(): React.JSX.Element {
  const store = useStore();
  const { selectedTaskId, detail, refreshDetail, perform, notify, busy, codexModels, settings } = store;

  const [changes, setChanges] = useState<GitChangeSet | null>(null);

  /**
   * Whether another Claude round can be started, and what to call it.
   *
   * Two situations lead here: a review that asked for changes, and a round the
   * publish gate refused after the reviewer approved it. The second used to be
   * a dead end in the UI — the orchestrator allowed it, the button did not.
   */
  const correction = correctionAction({
    status: detail?.task.status ?? null,
    currentRound: detail?.task.currentRound ?? 0,
    maxRounds: detail?.task.maxRounds ?? 0,
    latestClaudeStructuredResult: latestClaudeRoundResult(detail?.runs ?? [])
  });
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [dirtyPrompt, setDirtyPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTaskId) void refreshDetail(selectedTaskId);
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

  // Refresh the diff whenever the task reaches a state where it is meaningful.
  // State is written only after the request resolves, so this cannot cascade.
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

  if (!selectedTaskId || !detail) {
    return (
      <Card>
        <Empty title="No task selected" hint="Choose a task on the Tasks screen." />
      </Card>
    );
  }

  const { task, project, specification, lastReview } = detail;
  const running = isBusy(task.status);
  const anyBusy = Object.values(busy).some(Boolean);

  const sendToClaude = (acceptDirty: boolean): void => {
    setDirtyPrompt(null);
    void perform('send-claude', 'Claude run failed', async () => {
      try {
        await expect('workflow:sendToClaude', {
          taskId: task.id,
          ...(acceptDirty ? { acceptDirtyWorkingTree: true } : {})
        });
        notify({ tone: 'success', title: 'Claude finished the implementation round' });
        await loadChanges();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GIT_DIRTY') {
          setDirtyPrompt(error.message + (error.details ? `\n\n${error.details}` : ''));
          return;
        }
        throw error;
      } finally {
        await refreshDetail(task.id);
      }
    });
  };

  return (
    <div className="content--split" style={{ display: 'grid' }}>
      {/* ------------------------------- left ------------------------------- */}
      <div className="stack">
        <Card title="Task">
          <div className="stack">
            <div className="row row--wrap">
              <StatusBadge status={task.status} />
              <Rounds used={task.currentRound} max={task.maxRounds} />
              <span className="faint">
                round {task.currentRound} of {task.maxRounds}
              </span>
            </div>

            <div style={{ fontSize: 15, fontWeight: 600 }}>{task.title}</div>

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
          <SpecificationPanel
            specification={specification}
            approvedAt={task.specificationApprovedAt}
          />
        ) : null}

        <PlanReviewPanel
          key={task.id}
          task={task}
          integrationEnabled={settings?.externalPlanReviewEnabled ?? false}
          onChanged={() => refreshDetail(task.id)}
        />

        {lastReview ? <ReviewPanel review={lastReview} /> : null}

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

      {/* ------------------------------ right ------------------------------- */}
      <div className="stack">
        <Card title="Actions">
          <div className="actions">
            <div className="actions__legend">Read-only</div>
            <button
              type="button"
              className="btn btn--primary btn--wide"
              disabled={anyBusy || running || !canGenerateSpec(task.status)}
              onClick={() =>
                void perform('spec', 'Specification failed', async () => {
                  await expect('workflow:generateSpecification', { taskId: task.id });
                  notify({ tone: 'success', title: 'Codex produced a specification' });
                  await refreshDetail(task.id);
                })
              }
            >
              {busy['spec'] ? <Spinner /> : <Scope kind="read" />}
              {specification ? 'Regenerate specification' : 'Generate specification'}
            </button>

            <button
              type="button"
              className="btn btn--wide"
              disabled={
                anyBusy ||
                running ||
                task.status !== 'READY_FOR_IMPLEMENTATION' ||
                !specification ||
                Boolean(task.specificationApprovedAt)
              }
              onClick={() =>
                void perform('approve-spec', 'Could not approve', async () => {
                  await expect('workflow:approveSpecification', { taskId: task.id });
                  notify({ tone: 'success', title: 'Specification approved' });
                  await refreshDetail(task.id);
                })
              }
            >
              <Scope kind="read" />
              {task.specificationApprovedAt ? 'Specification approved ✓' : 'Approve specification'}
            </button>

            <button
              type="button"
              className="btn btn--wide"
              disabled={anyBusy || running || task.status !== 'READY_FOR_REVIEW'}
              onClick={() =>
                void perform('review', 'Review failed', async () => {
                  await expect('workflow:reviewWithCodex', { taskId: task.id });
                  notify({ tone: 'success', title: 'Codex review complete' });
                  await Promise.all([refreshDetail(task.id), loadChanges()]);
                })
              }
            >
              {busy['review'] ? <Spinner /> : <Scope kind="read" />} Review with Codex
            </button>

            <div className="actions__legend">Writes local files</div>
            <button
              type="button"
              className="btn btn--claude btn--wide"
              disabled={
                anyBusy ||
                running ||
                task.status !== 'READY_FOR_IMPLEMENTATION' ||
                !task.specificationApprovedAt
              }
              onClick={() => sendToClaude(false)}
            >
              {busy['send-claude'] ? <Spinner /> : <Scope kind="local" />} Send to Claude
            </button>

            <button
              type="button"
              className="btn btn--claude btn--wide"
              disabled={anyBusy || running || !correction.enabled}
              title={correction.disabledReason ?? undefined}
              onClick={() =>
                void perform('corrections', 'Correction round failed', async () => {
                  await expect('workflow:sendCorrections', { taskId: task.id });
                  notify({ tone: 'success', title: 'Claude finished the round' });
                  await Promise.all([refreshDetail(task.id), loadChanges()]);
                })
              }
            >
              {busy['corrections'] ? <Spinner /> : <Scope kind="local" />} {correction.label}
            </button>

            <div className="actions__legend">Control</div>
            <button
              type="button"
              className="btn btn--danger btn--wide"
              disabled={!running && isTerminal(task.status)}
              onClick={() =>
                void perform('stop', 'Could not stop the task', async () => {
                  await expect('workflow:stop', { taskId: task.id });
                  notify({ tone: 'info', title: 'Task stopped' });
                  await refreshDetail(task.id);
                })
              }
            >
              Stop task
            </button>

            <button
              type="button"
              className="btn btn--wide"
              disabled={anyBusy || task.status !== 'APPROVED'}
              onClick={() =>
                void perform('approve-publish', 'Could not approve for publishing', async () => {
                  await expect('workflow:approveForPublishing', { taskId: task.id });
                  notify({ tone: 'success', title: 'Approved for publishing' });
                  await refreshDetail(task.id);
                })
              }
            >
              <Scope kind="read" /> Approve for publishing
            </button>
          </div>
        </Card>

        {task.status === 'READY_TO_PUBLISH' || task.status === 'PUBLISHING' ? (
          <PublishPanel taskId={task.id} onDone={() => void refreshDetail(task.id)} />
        ) : null}

        {detail.approvals.length > 0 ? (
          <Card title="Approval trail" flush>
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

        <ChangesPanel changes={changes} loading={loadingChanges} onRefresh={() => void loadChanges()} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type DecisionDraft = { action: '' | 'accept' | 'reject'; reason: string };

export function PlanReviewPanel({
  task,
  integrationEnabled,
  onChanged
}: {
  task: Task;
  integrationEnabled: boolean;
  onChanged: () => Promise<void>;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<PlanReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // A ref as well as the state: two clicks in one tick see the same rendered
  // `disabled`, and only a synchronous claim keeps one external call to one
  // press. It matters most for Reconcile, which talks to the provider.
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtyPrompt, setDirtyPrompt] = useState(false);
  const [decisions, setDecisions] = useState<Record<number, DecisionDraft>>({});

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

  const act = async (
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
      }
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  const corrupt = detail?.ruleEvidenceProblem ?? null;
  if (!integrationEnabled && !detail?.ruleEvidence && corrupt === null) return null;

  const gate = detail?.gate ?? null;
  const findings = detail?.findings ?? [];
  const allDecided = findings.every((_, index) => {
    const decision = decisions[index];
    return decision?.action === 'accept' ||
      (decision?.action === 'reject' && decision.reason.trim().length > 0);
  });
  // `failed` is included: rows written before the phase was preserved used it
  // for a lost answer too, and those are exactly the ones needing a read-back.
  const unknownOutcome =
    gate !== null && ['opening', 'reviewing', 'resolving', 'failed'].includes(gate.status);

  return (
    <Card
      title="External plan review"
      actions={gate ? <span className={`tag ${gate.status === 'proceeded' ? 'tag--ok' : gate.status === 'failed' ? 'tag--danger' : 'tag--warn'}`}>{gate.status.replace(/_/g, ' ')}</span> : undefined}
    >
      <div className="stack">
        {loading ? <div className="muted">Loading rule and review evidence…</div> : null}
        {!integrationEnabled ? (
          <Notice tone="warn">This task is bound to external review evidence. Re-enable the integration in Settings to continue it.</Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

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
            <button
              type="button"
              className="btn btn--wide"
              disabled={!integrationEnabled || busy !== null || task.status !== 'DRAFT'}
              onClick={() => void act('bind', () => expect('planReview:bindRules', { taskId: task.id }))}
            >
              {busy === 'bind' ? <Spinner /> : <Scope kind="read" />} Capture and bind rules
            </button>
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

        {detail?.ruleEvidence && task.status === 'READY_FOR_IMPLEMENTATION' && gate === null ? (
          <button
            type="button"
            className="btn btn--wide"
            disabled={!integrationEnabled || busy !== null}
            onClick={() => void act('prepare', () => expect('planReview:prepare', { taskId: task.id }))}
          >
            {busy === 'prepare' ? <Spinner /> : <Scope kind="local" />} Prepare isolated review branch
          </button>
        ) : null}

        {dirtyPrompt ? (
          <Notice tone="warn">
            The project checkout is dirty. The isolated task branch can still be based on its
            current HEAD, but uncommitted project changes are not copied.
            <button
              type="button"
              className="btn btn--sm"
              style={{ marginTop: 8 }}
              disabled={busy !== null}
              onClick={() => void act('prepare', () => expect('planReview:prepare', {
                taskId: task.id,
                acceptDirtyWorkingTree: true
              }))}
            >
              Continue with current HEAD
            </button>
          </Notice>
        ) : null}

        {gate?.status === 'interrupted' ? (
          <Notice tone="warn">
            A previous round was started in the provider and never finished. It produced no
            findings and nothing is waiting on decisions, so a new round can be started by
            hand — nothing will be repeated.
          </Notice>
        ) : null}

        {gate && ['prepared', 'changes_requested', 'interrupted'].includes(gate.status) ? (
          <button
            type="button"
            className="btn btn--wide"
            disabled={!integrationEnabled || busy !== null}
            onClick={() => void act('review', () => expect('planReview:review', { taskId: task.id }))}
          >
            {busy === 'review' ? <Spinner /> : <Scope kind="read" />}
            {gate.status === 'prepared' ? 'Run external plan review' : 'Run next plan-review round'}
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
            <button
              type="button"
              className="btn btn--wide"
              disabled={!integrationEnabled || busy !== null}
              onClick={() => void act('reconcile', () => expect('planReview:reconcile', { taskId: task.id }))}
            >
              {busy === 'reconcile' ? <Spinner /> : <Scope kind="read" />} Reconcile external state
            </button>
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
            <button
              type="button"
              className="btn btn--primary btn--wide"
              disabled={!integrationEnabled || busy !== null || !allDecided}
              onClick={() => {
                const payload: PlanReviewDecision[] = findings.map((_, index) => ({
                  finding: index,
                  action: decisions[index]!.action as 'accept' | 'reject',
                  reason: decisions[index]!.reason.trim()
                }));
                void act('resolve', () => expect('planReview:resolve', {
                  taskId: task.id,
                  decisions: payload
                }));
              }}
            >
              {busy === 'resolve' ? <Spinner /> : <Scope kind="read" />} Resolve all findings
            </button>
          </div>
        ) : null}

        {gate?.status === 'proceeded' ? (
          <Notice tone="info">The exact specification and rule snapshot passed resolution. You may now approve the specification.</Notice>
        ) : null}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function canGenerateSpec(status: string): boolean {
  return status === 'DRAFT' || status === 'READY_FOR_IMPLEMENTATION';
}

function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function SpecificationPanel({
  specification,
  approvedAt
}: {
  specification: TaskSpecification;
  approvedAt: string | null;
}): React.JSX.Element {
  return (
    <Card
      title="Specification"
      actions={
        approvedAt ? (
          <span className="tag tag--ok">approved {formatDateTime(approvedAt)}</span>
        ) : (
          <span className="tag tag--warn">awaiting approval</span>
        )
      }
    >
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
            Implementation prompt sent to Claude
          </summary>
          <pre className="pre selectable" style={{ marginTop: 8 }}>
            {specification.implementationPrompt}
          </pre>
        </details>
      </div>
    </Card>
  );
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

function ReviewPanel({ review }: { review: CodexReviewResult }): React.JSX.Element {
  const counts = SEVERITY_ORDER.map(
    (severity) => [severity, review.findings.filter((f) => f.severity === severity).length] as const
  ).filter(([, count]) => count > 0);

  return (
    <Card
      title="Codex review"
      flush
      actions={
        <span
          className={`tag ${
            review.verdict === 'approved'
              ? 'tag--ok'
              : review.verdict === 'blocked'
                ? 'tag--danger'
                : 'tag--warn'
          }`}
        >
          {review.verdict.replace(/_/g, ' ')}
        </span>
      }
    >
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
    </Card>
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
    <Card title="Publish">
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
    </Card>
  );
}
