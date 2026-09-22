/** @vitest-environment jsdom */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { runSchema, taskSchema, type Task } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { deferred, deliver, installBridge, ok, renderApp } from './harness';

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

const specification: TaskSpecification = {
  title: 'Add the checklist',
  summary: 'Add it.',
  assumptions: [],
  acceptanceCriteria: ['It exists.'],
  constraints: [],
  suggestedTests: [],
  implementationPrompt: 'Do it.',
  scopedFilePaths: []
};

/** A task an implementation attempt left files in and could not verify: Run verification + Retry implementation. */
function detailAfterUnverifiedAttempt(): TaskDetail {
  const task = taskSchema.parse({
    id: 't', projectId: 'p', title: 'Add the checklist', originalRequest: 'Add it.',
    status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: 'spec', claudeSessionId: null,
    worktreePath: 'C:\\worktree', branchName: 'agent/task', baseBranch: 'main',
    specificationJson: JSON.stringify(specification), specificationApprovedAt: '2026-09-10T00:01:00.000Z',
    lastReviewJson: null, lastError: null, codexModel: null, claudeModel: null,
    createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
  });
  return {
    task,
    project: {
      id: 'p', name: 'Agent Relay', localPath: 'C:\\repo', projectType: 'existing', defaultBranch: 'main',
      githubOwner: null, githubRepo: null, githubVisibility: 'private',
      createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
    },
    runs: [runSchema.parse({
      id: 'r1', taskId: 't', agent: 'claude', runType: 'implementation', status: 'failed', round: 1,
      startedAt: '2026-09-10T00:02:00.000Z', finishedAt: '2026-09-10T00:03:00.000Z',
      finalMessage: null, structuredResult: null, errorMessage: null
    })],
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

describe('Run screen — the secondary action shares the single-flight guard with the primary one', () => {
  it('disables the primary control the moment the secondary one is dispatched, and sends nothing for it', async () => {
    const detail = detailAfterUnverifiedAttempt();
    const implementGate = deferred<Task>();
    let verifyCalls = 0;
    const bridge = installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:implement': () => implementGate.promise.then((updated) => ok<'workflow:implement'>(updated)),
      'workflow:verify': () => {
        verifyCalls += 1;
        return ok<'workflow:verify'>(detail.task);
      }
    });
    renderApp(<SeededRun detail={detail} />);

    const secondary = await screen.findByRole('button', { name: 'Retry implementation · Claude' });
    const primary = screen.getByRole('button', { name: 'Run verification' });
    expect(primary).toHaveProperty('disabled', false);

    fireEvent.click(secondary);

    // Both are blocked while the deliberate alternative is in flight — not "until the backend answers".
    await waitFor(() => expect(primary).toHaveProperty('disabled', true));
    expect(secondary).toHaveProperty('disabled', true);
    // The in-flight action shows its busy indicator, exactly as the primary control does; the other one does not.
    expect(secondary.querySelector('.spinner')).not.toBeNull();
    expect(primary.querySelector('.spinner')).toBeNull();
    fireEvent.click(primary);
    fireEvent.click(secondary);

    expect(verifyCalls).toBe(0);
    expect(bridge.callsTo('workflow:verify')).toHaveLength(0);
    expect(bridge.callsTo('workflow:implement')).toHaveLength(1); // exactly the one that was asked for

    await deliver(implementGate, detail.task);
  });

  it('the other way round: dispatching the primary control blocks the secondary one', async () => {
    const detail = detailAfterUnverifiedAttempt();
    const verifyGate = deferred<Task>();
    const bridge = installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:verify': () => verifyGate.promise.then((updated) => ok<'workflow:verify'>(updated))
    });
    renderApp(<SeededRun detail={detail} />);

    const primary = await screen.findByRole('button', { name: 'Run verification' });
    const secondary = screen.getByRole('button', { name: 'Retry implementation · Claude' });

    fireEvent.click(primary);
    await waitFor(() => expect(secondary).toHaveProperty('disabled', true));
    fireEvent.click(secondary);

    expect(bridge.callsTo('workflow:implement')).toHaveLength(0);
    expect(bridge.callsTo('workflow:verify')).toHaveLength(1);

    await deliver(verifyGate, detail.task);
  });
});
