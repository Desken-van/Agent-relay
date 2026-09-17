/** @vitest-environment jsdom */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { taskSchema } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import type { WorktreeDependencyStatus } from '../../src/shared/domain/worktree-dependencies';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { installBridge, ok, renderApp } from './harness';

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
  implementationPrompt: 'Do it.'
};

function buildDetail(): TaskDetail {
  const task = taskSchema.parse({
    id: 't',
    projectId: 'p',
    title: 'Fix the thing',
    originalRequest: 'Please fix it.',
    status: 'READY_FOR_IMPLEMENTATION',
    currentRound: 0,
    maxRounds: 3,
    codexThreadId: 'spec',
    claudeSessionId: null,
    worktreePath: 'C:\\worktree',
    branchName: 'agent/task',
    baseBranch: 'main',
    specificationJson: JSON.stringify(specification),
    specificationApprovedAt: '2026-09-10T00:01:00.000Z',
    lastReviewJson: null,
    lastError: null,
    codexModel: null,
    claudeModel: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z'
  });
  return {
    task,
    project,
    runs: [],
    approvals: [],
    specification,
    lastReview: null,
    worktree: null,
    continuationOf: null,
    continuationEntryAction: null,
    continuedAs: null,
    continuationCreationStatus: null,
    effectivePublishRefusal: null
  };
}

describe('Run screen — dependency blocker', () => {
  it('shows the blocker and install action before any implementation attempt, and dispatches exactly once per burst of clicks', async () => {
    let installCalls = 0;
    const bridge = installBridge({
      'dependencies:status': () =>
        ok<'dependencies:status'>({ state: 'manifest_mismatch', detail: 'The worktree dependency manifest differs from the registered checkout.' }),
      'workflow:installDependencies': () => {
        installCalls += 1;
        return ok<'workflow:installDependencies'>({ ...buildDetail().task, lastError: null });
      }
    });
    renderApp(<SeededRun detail={buildDetail()} />);

    const notice = await screen.findByText(/manifest differs from the registered checkout/);
    expect(notice).toBeTruthy();
    const button = await screen.findByRole('button', { name: /Install dependencies in task worktree/ });

    // A burst of clicks in one tick must dispatch exactly once — the same
    // synchronous ref-claim guard every other critical button in this screen
    // already uses.
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(bridge.callsTo('workflow:installDependencies')).toHaveLength(1));
    expect(installCalls).toBe(1);
    expect(bridge.callsTo('workflow:installDependencies')[0]?.input).toEqual({ taskId: 't' });
  });

  it('shows an informational notice with no install action for an unsupported package manager', async () => {
    const bridge = installBridge({
      'dependencies:status': () =>
        ok<'dependencies:status'>({ state: 'unsupported_package_manager', detail: 'This worktree uses "yarn.lock", which this build does not install automatically.' })
    });
    renderApp(<SeededRun detail={buildDetail()} />);

    expect(await screen.findByText(/does not install automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install dependencies in task worktree/ })).toBeNull();
    expect(bridge.callsTo('workflow:installDependencies')).toHaveLength(0);
  });

  it('shows no dependency notice at all once dependencies are ready', async () => {
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'ready_linked', detail: 'Dependencies are linked from the registered checkout.' } satisfies WorktreeDependencyStatus)
    });
    renderApp(<SeededRun detail={buildDetail()} />);

    await screen.findByText('Actions');
    expect(screen.queryByRole('button', { name: /Install dependencies in task worktree/ })).toBeNull();
    expect(screen.queryByText(/dependency manifest differs/)).toBeNull();
  });
});
