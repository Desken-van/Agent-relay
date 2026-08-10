import { useCallback, useEffect, useState } from 'react';
import type { GitChangeSet } from '@shared/domain/git';
import type { ApprovalAction } from '@shared/domain/models';
import { isBusy } from '@shared/domain/workflow';
import type { PublishConfirmation } from '@shared/ipc';
import type { CodexReviewResult, FindingSeverity, TaskSpecification } from '@shared/schemas/codex';
import { ApiError, call, expect } from '../lib/api';
import { formatDateTime, pluralize } from '../lib/format';
import { useStore } from '../state/store';
import { ChangesPanel } from './ChangesPanel';
import { Card, Empty, Field, Notice, Rounds, Scope, Spinner, StatusBadge } from './primitives';
import { RelayTimeline } from './RelayTimeline';

export function RunView(): React.JSX.Element {
  const store = useStore();
  const { selectedTaskId, detail, refreshDetail, perform, notify, busy } = store;

  const [changes, setChanges] = useState<GitChangeSet | null>(null);
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
              disabled={
                anyBusy ||
                running ||
                task.status !== 'CHANGES_REQUESTED' ||
                task.currentRound >= task.maxRounds
              }
              title={
                task.currentRound >= task.maxRounds
                  ? 'The review round budget for this task is exhausted.'
                  : undefined
              }
              onClick={() =>
                void perform('corrections', 'Correction round failed', async () => {
                  await expect('workflow:sendCorrections', { taskId: task.id });
                  notify({ tone: 'success', title: 'Claude finished the correction round' });
                  await Promise.all([refreshDetail(task.id), loadChanges()]);
                })
              }
            >
              {busy['corrections'] ? <Spinner /> : <Scope kind="local" />} Send corrections
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
