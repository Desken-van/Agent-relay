/** @vitest-environment jsdom */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { taskSchema } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import type { GitChangeSet } from '../../src/shared/domain/git';
import type { CodexReviewResult, TaskSpecification } from '../../src/shared/schemas/codex';
import { burstClick, deferred, deliver, installBridge, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SeededRun({ detail }: { detail: TaskDetail }): React.JSX.Element {
  const { openTaskDetail } = useStore();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    openTaskDetail(detail);
  }, [detail, openTaskDetail]);
  return <RunView />;
}

const project: TaskDetail['project'] = {
  id: 'p',
  name: 'Agent Relay',
  localPath: 'C:\\repo',
  projectType: 'existing',
  defaultBranch: 'main',
  githubOwner: null,
  githubRepo: null,
  githubVisibility: 'private',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
};

const specification: TaskSpecification = {
  title: 'Ship the null check',
  summary: 'Do it safely.',
  assumptions: [],
  acceptanceCriteria: ['It works.'],
  constraints: [],
  suggestedTests: ['Run the tests.'],
  implementationPrompt: 'Do it.',
  scopedFilePaths: []
};

const review: CodexReviewResult = {
  verdict: 'changes_requested',
  summary: 'Fix the edge case.',
  findings: [{ severity: 'high', title: 'Missing null check', description: 'Boom.', file: null, line: null }],
  followUpPrompt: 'Fix it.',
  suggestedTests: []
};

const changes: GitChangeSet = {
  statusShort: ' M src/a.ts',
  changedFiles: [{ path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1, binary: false }],
  diffStat: '1 file changed',
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  diffTruncated: false,
  diffBytes: 42,
  recentCommits: ['abc123 fix'],
  isEmpty: false,
  collectedAt: '2026-09-10T00:00:00.000Z'
};

function buildDetail(overrides: Partial<TaskDetail['task']> = {}): TaskDetail {
  const task = taskSchema.parse({
    id: 't',
    projectId: 'p',
    title: 'Fix the thing',
    originalRequest: 'Please fix it.',
    status: 'CHANGES_REQUESTED',
    currentRound: 1,
    maxRounds: 3,
    codexThreadId: 'spec',
    claudeSessionId: 'sess',
    worktreePath: 'C:\\worktree',
    branchName: 'agent/task',
    baseBranch: 'main',
    specificationJson: JSON.stringify(specification),
    specificationApprovedAt: '2026-09-10T00:01:00.000Z',
    lastReviewJson: JSON.stringify(review),
    lastError: null,
    codexModel: null,
    claudeModel: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides
  });
  return {
    task,
    project,
    runs: [],
    approvals: [
      {
        id: 'appr-1',
        taskId: 't',
        action: 'commit',
        status: 'granted',
        details: '{}',
        requestedAt: '2026-09-10T00:02:00.000Z',
        resolvedAt: '2026-09-10T00:02:05.000Z'
      }
    ],
    specification,
    lastReview: review,
    worktree: null,
    continuationOf: null,
    continuationEntryAction: null,
    continuedAs: null,
    continuationCreationStatus: null,
    effectivePublishRefusal: null
  };
}

describe('Run screen — Publish lives inside Actions', () => {
  it('renders the Publish content inside the Actions card, not as a separate sibling card', async () => {
    installBridge({ 'publish:prepare': () => ok<'publish:prepare'>({
      action: 'commit', headline: 'Commit changes', account: 'me', repository: 'repo',
      visibility: 'private', branch: 'agent/task', details: [], affectsRemote: false
    }) });
    const detail = buildDetail({ status: 'READY_TO_PUBLISH', currentRound: 3 });
    renderApp(<SeededRun detail={detail} />);

    const confirmButton = await screen.findByRole('button', { name: 'Create local commit' });
    const actionsCard = screen.getByText('Actions').closest('.card');
    expect(actionsCard).toBeTruthy();
    expect(actionsCard?.contains(confirmButton)).toBe(true);

    // No separate top-level Card titled "Publish": only the in-card section heading
    // (the run-step labelled "Publish" above it, from RunFlowOverview, is a
    // different element — this checks the section-title specifically).
    const cardTitles = Array.from(document.querySelectorAll('.card__title')).map((el) => el.textContent);
    expect(cardTitles).not.toContain('Publish');
    const sectionTitles = Array.from(actionsCard?.querySelectorAll('.section-title') ?? []).map(
      (el) => el.textContent
    );
    expect(sectionTitles).toContain('Publish');
  });
});

describe('Run screen — context sections are collapsible and live in the sidebar', () => {
  it('gives Task/Specification/Review/Approval trail/Changes each a disclosure control with a stage-appropriate default', async () => {
    installBridge({ 'git:changes': () => ok<'git:changes'>(changes) });
    const detail = buildDetail();
    renderApp(<SeededRun detail={detail} />);

    await waitFor(() => expect(screen.getByText('Changed files (1)')).toBeTruthy());

    const side = document.querySelector('.run-layout__side');
    expect(side).toBeTruthy();
    const scoped = within(side as HTMLElement);

    const taskToggle = scoped.getByRole('button', { name: /Task/ });
    const specToggle = scoped.getByRole('button', { name: /Specification/ });
    const reviewToggle = scoped.getByRole('button', { name: /Review/ });
    const approvalsToggle = scoped.getByRole('button', { name: /Approval trail/ });
    const changesToggle = scoped.getByRole('button', { name: /Changes and diff/ });

    // Task always opens by default.
    expect(taskToggle.getAttribute('aria-expanded')).toBe('true');
    // Specification is already approved, so it starts collapsed.
    expect(specToggle.getAttribute('aria-expanded')).toBe('false');
    // CHANGES_REQUESTED is exactly the actionable moment for Review.
    expect(reviewToggle.getAttribute('aria-expanded')).toBe('true');
    // Approval trail is only opened by default near publishing/completion.
    expect(approvalsToggle.getAttribute('aria-expanded')).toBe('false');
    // There is something to look at while changes are requested.
    expect(changesToggle.getAttribute('aria-expanded')).toBe('true');
    // Flush, like every other filerow-based section — not padded like Task/Specification.
    const changesCard = changesToggle.closest('.card');
    expect(changesCard?.querySelector('.card__body')?.className).toContain('card__body--flush');

    // Collapsed content is hidden until toggled open, and keyboard-operable
    // (a native <button> already handles Enter/Space; this checks the state flips).
    expect(scoped.queryByText(specification.title)).toBeNull();
    fireEvent.click(specToggle);
    expect(specToggle.getAttribute('aria-expanded')).toBe('true');
    expect(scoped.getByText(specification.title)).toBeTruthy();
  });
});

describe('Run screen — reflowed Actions still dispatch the original IPC channels', () => {
  it('still calls workflow:approveForPublishing from the primary action after the layout change', async () => {
    const refreshed = buildDetail({ status: 'READY_TO_PUBLISH' });
    const bridge = installBridge({
      'workflow:approveForPublishing': () => ok<'workflow:approveForPublishing'>(
        taskSchema.parse({
          id: 't', projectId: 'p', title: 'Fix the thing', originalRequest: 'Please fix it.',
          status: 'READY_TO_PUBLISH', currentRound: 1, maxRounds: 3, codexThreadId: null,
          claudeSessionId: null, worktreePath: null, branchName: null, baseBranch: null,
          specificationJson: null, specificationApprovedAt: null, lastReviewJson: null,
          lastError: null, codexModel: null, claudeModel: null,
          createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
        })
      ),
      'tasks:get': () => ok<'tasks:get'>(refreshed),
      'publish:prepare': () => ok<'publish:prepare'>({
        action: 'commit', headline: 'Commit changes', account: 'me', repository: 'repo',
        visibility: 'private', branch: 'agent/task', details: [], affectsRemote: false
      })
    });
    const detail = buildDetail({ status: 'APPROVED', lastReviewJson: JSON.stringify({ ...review, verdict: 'approved', findings: [] }) });
    renderApp(<SeededRun detail={detail} />);

    const button = await screen.findByRole('button', { name: 'Approve for publishing' });
    fireEvent.click(button);

    await waitFor(() => expect(bridge.callsTo('workflow:approveForPublishing')).toHaveLength(1));
    expect(bridge.callsTo('workflow:approveForPublishing')[0]?.input).toEqual({ taskId: 't' });
    await waitFor(() => expect(bridge.callsTo('tasks:get')).toHaveLength(1));
  });

  it('still calls workflow:stop from the Stop button', async () => {
    const bridge = installBridge({
      'workflow:stop': () => ok<'workflow:stop'>(
        taskSchema.parse({
          id: 't', projectId: 'p', title: 'Fix the thing', originalRequest: 'Please fix it.',
          status: 'CANCELLED', currentRound: 1, maxRounds: 3, codexThreadId: null,
          claudeSessionId: null, worktreePath: null, branchName: null, baseBranch: null,
          specificationJson: null, specificationApprovedAt: null, lastReviewJson: null,
          lastError: null, codexModel: null, claudeModel: null,
          createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
        })
      )
    });
    const detail = buildDetail({ status: 'IMPLEMENTING' });
    renderApp(<SeededRun detail={detail} />);

    const button = await screen.findByRole('button', { name: 'Stop task' });
    fireEvent.click(button);

    await waitFor(() => expect(bridge.callsTo('workflow:stop')).toHaveLength(1));
    expect(bridge.callsTo('workflow:stop')[0]?.input).toEqual({ taskId: 't' });
  });
});

describe('Run screen — publishing operation feedback', () => {
  const preview = {
    action: 'commit' as const,
    headline: 'Create a Git commit in the task worktree',
    account: 'me',
    repository: 'repo',
    visibility: 'private' as const,
    branch: 'agent/task',
    details: [],
    affectsRemote: false
  };

  it('keeps a successful commit result visible and advances to the push action', async () => {
    const detail = buildDetail({ status: 'READY_TO_PUBLISH', currentRound: 3 });
    const bridge = installBridge({
      'publish:prepare': () => ok<'publish:prepare'>(preview),
      'publish:execute': () => ok<'publish:execute'>({
        action: 'commit', approvalId: 'approval-1', performed: true,
        message: 'Created commit 5c34f6d36c.', url: null
      }),
      'tasks:get': () => ok<'tasks:get'>(detail)
    });
    renderApp(<SeededRun detail={detail} />);

    const commit = await screen.findByRole('button', { name: 'Create local commit' });
    await waitFor(() => expect(commit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(commit);

    expect(await screen.findByText('Create local commit succeeded')).toBeTruthy();
    expect(screen.getByText('Created commit 5c34f6d36c.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Push branch to origin' })).toBeTruthy();
    expect(bridge.callsTo('publish:execute')).toHaveLength(1);
    expect(bridge.callsTo('tasks:get')).toHaveLength(1);
  });

  it('shows progress, disables the action, and synchronously rejects duplicate clicks', async () => {
    const detail = buildDetail({ status: 'READY_TO_PUBLISH', currentRound: 3 });
    const gate = deferred<ReturnType<typeof ok<'publish:execute'>>>();
    const bridge = installBridge({
      'publish:prepare': () => ok<'publish:prepare'>(preview),
      'publish:execute': () => gate.promise,
      'tasks:get': () => ok<'tasks:get'>(detail)
    });
    renderApp(<SeededRun detail={detail} />);

    const button = await screen.findByRole('button', { name: 'Create local commit' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await burstClick(button);

    expect(bridge.callsTo('publish:execute')).toHaveLength(1);
    const pending = screen.getByRole('button', { name: 'Creating local commit…' });
    expect(pending.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Waiting for the operation to finish. Keep this task open.')).toBeTruthy();
    await deliver(gate, ok<'publish:execute'>({
      action: 'commit', approvalId: 'approval-1', performed: true,
      message: 'Created commit 5c34f6d36c.', url: null
    }));
  });

  it('keeps an operation failure inline with its remediation', async () => {
    const detail = buildDetail({ status: 'READY_TO_PUBLISH', currentRound: 3 });
    const bridge = installBridge({
      'publish:prepare': () => ok<'publish:prepare'>(preview),
      'publish:execute': () => ({
        ok: false,
        error: {
          code: 'GIT_FAILED',
          message: 'There is nothing to commit.',
          remediation: 'Choose Push branch to origin if the commit already exists.'
        }
      }),
      'tasks:get': () => ok<'tasks:get'>(detail)
    });
    renderApp(<SeededRun detail={detail} />);

    const commit = await screen.findByRole('button', { name: 'Create local commit' });
    await waitFor(() => expect(commit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(commit);

    await waitFor(() => expect(bridge.callsTo('publish:execute')).toHaveLength(1));
    expect(await screen.findByText('Create local commit failed')).toBeTruthy();
    expect(screen.getByText(/There is nothing to commit.*Choose Push branch/)).toBeTruthy();
  });

  it('shows durable publishing history after the task is completed', async () => {
    const detail: TaskDetail = {
      ...buildDetail({ status: 'COMPLETED', currentRound: 3 }),
      runs: [{
        id: 'publish-run', taskId: 't', agent: 'system', runType: 'github', status: 'succeeded',
        round: 3, startedAt: '2026-09-15T08:16:41.668Z', finishedAt: '2026-09-15T08:16:45.266Z',
        finalMessage: 'Opened pull request.',
        structuredResult: JSON.stringify({ action: 'create_pull_request', url: 'https://example.test/pr/42' }),
        errorMessage: null
      }]
    };
    installBridge();
    renderApp(<SeededRun detail={detail} />);

    expect(await screen.findByRole('region', { name: 'Publishing activity' })).toBeTruthy();
    expect(screen.getAllByText('Opened pull request.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Create local commit' })).toBeNull();
  });

  it('does not mistake worktree setup for publishing activity', async () => {
    const detail: TaskDetail = {
      ...buildDetail({ status: 'READY_FOR_IMPLEMENTATION' }),
      runs: [{
        id: 'worktree-run', taskId: 't', agent: 'system', runType: 'git', status: 'succeeded',
        round: 0, startedAt: '2026-09-15T08:00:00.000Z', finishedAt: '2026-09-15T08:00:01.000Z',
        finalMessage: 'Created an isolated worktree.',
        structuredResult: JSON.stringify({ branchName: 'agent/task', worktreePath: 'C:/worktree' }),
        errorMessage: null
      }]
    };
    installBridge();
    renderApp(<SeededRun detail={detail} />);

    await screen.findByRole('button', { name: /Run implementation/ });
    expect(screen.queryByRole('region', { name: 'Publishing activity' })).toBeNull();
  });
});
