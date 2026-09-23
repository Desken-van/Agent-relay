/** @vitest-environment jsdom */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProviderControls, RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { taskSchema } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import { burstClick, deferred, deliver, installBridge, ok, renderApp } from './harness';
const task = taskSchema.parse({ id: 't', projectId: 'p', title: 'Task', originalRequest: 'Do it', status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: 'spec', claudeSessionId: 'old', worktreePath: null, branchName: null, baseBranch: null, specificationJson: null, specificationApprovedAt: null, lastReviewJson: null, lastError: null, codexModel: null, claudeModel: null, createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe('provider selection controls', () => {
  it('renders exactly one provider section in the complete Run Actions view', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installBridge();
    const specification = {
      title: 'Task', summary: 'Do it safely.', assumptions: [], acceptanceCriteria: ['It works.'],
      constraints: [], suggestedTests: ['Run the tests.'], implementationPrompt: 'Do it.', scopedFilePaths: []
    };
    const detail: TaskDetail = {
      task: {
        ...task,
        specificationJson: JSON.stringify(specification),
        specificationApprovedAt: '2026-09-10T00:01:00.000Z'
      },
      project: {
        id: 'p', name: 'Agent Relay', localPath: 'C:\\repo', projectType: 'existing',
        defaultBranch: 'main', githubOwner: null, githubRepo: null, githubVisibility: 'private',
        createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
      },
      runs: [], approvals: [], specification, lastReview: null, worktree: null,
      continuationOf: null, continuationEntryAction: null, continuedAs: null,
      continuationCreationStatus: null, effectivePublishRefusal: null
    };

    renderApp(<SeededRun detail={detail} />);

    expect(await screen.findAllByLabelText('AI provider settings')).toHaveLength(1);
    expect(screen.getAllByText('AI providers')).toHaveLength(1);
    expect(screen.getAllByText('Claude implements · Codex reviews')).toHaveLength(1);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
  });

  it('is absent while the selection matches the persisted providers', () => {
    installBridge();
    render(<ProviderControls task={task} busy={false} onChanged={async () => {}} />);
    expect(screen.getAllByText('AI providers')).toHaveLength(1);
    expect(screen.getByText('Claude implements · Codex reviews')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply providers' })).toBeNull();
    fireEvent.click(screen.getByText('AI providers'));
    expect(Array.from((screen.getByLabelText('Implementation provider') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['claude', 'codex', 'ornith']);
    expect(Array.from((screen.getByLabelText('Review provider') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['codex', 'claude']);
  });

  it('passively refreshes Ornith readiness without lifecycle mutations or health checks', async () => {
    vi.useFakeTimers();
    let state: 'stopped' | 'healthy' = 'stopped';
    const bridge = installBridge({
      'localInference:getState': () => ok<'localInference:getState'>(
        state === 'healthy' ? { kind: 'healthy', runtimeInstanceId: 'runtime-fixture' } : { kind: 'stopped' }
      )
    });
    const specification = {
      title: 'Task', summary: 'Do it safely.', assumptions: [], acceptanceCriteria: ['It works.'],
      constraints: [], suggestedTests: [], implementationPrompt: 'Do it.', scopedFilePaths: []
    };
    const detail: TaskDetail = {
      task: {
        ...task,
        implementationProvider: 'ornith',
        specificationJson: JSON.stringify(specification),
        specificationApprovedAt: '2026-09-10T00:01:00.000Z'
      },
      project: {
        id: 'p', name: 'Agent Relay', localPath: 'C:\\repo', projectType: 'existing',
        defaultBranch: 'main', githubOwner: null, githubRepo: null, githubVisibility: 'private',
        createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
      },
      runs: [], approvals: [], specification, lastReview: null, worktree: null,
      continuationOf: null, continuationEntryAction: null, continuedAs: null,
      continuationCreationStatus: null, effectivePublishRefusal: null
    };

    renderApp(<SeededRun detail={detail} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Run implementation · Ornith' })).toHaveProperty('disabled', true);

    state = 'healthy';
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Run implementation · Ornith' })).toHaveProperty('disabled', false);

    state = 'stopped';
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Run implementation · Ornith' })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('localInference:getState').length).toBeGreaterThanOrEqual(3);
    expect(bridge.callsTo('localInference:start')).toHaveLength(0);
    expect(bridge.callsTo('localInference:checkHealth')).toHaveLength(0);
    expect(bridge.callsTo('localInference:runTestInference')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('appears the moment a selection differs, submits once with the expected revision, and disappears once applied', async () => {
    const pending = deferred<ReturnType<typeof ok<'workflow:configureProviders'>>>();
    const bridge = installBridge({ 'workflow:configureProviders': () => pending.promise });
    const changed = vi.fn(async () => {});
    render(<ProviderControls task={task} busy={false} onChanged={changed} />);

    expect(screen.queryByRole('button', { name: 'Apply providers' })).toBeNull();
    fireEvent.click(screen.getByText('AI providers'));
    fireEvent.change(screen.getByLabelText('Implementation provider'), { target: { value: 'codex' } });
    // The mount-time profile list (read-only, never a mutation) is the only call so far.
    expect(bridge.calls.map((call) => call.channel)).toEqual(['localInference:listProfiles']);

    await burstClick(screen.getByRole('button', { name: 'Apply providers' }));
    expect(bridge.callsTo('workflow:configureProviders')).toEqual([{ channel: 'workflow:configureProviders', input: { taskId: 't', expectedRevision: 0, implementationProvider: 'codex', reviewProvider: 'codex' } }]);
    expect(bridge.callsTo('workflow:implement')).toHaveLength(0);

    await deliver(pending, ok<'workflow:configureProviders'>({ ...task, implementationProvider: 'codex', providerRevision: 1 }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ implementationProvider: 'codex', providerRevision: 1 })));
  });

  it('disables selection during a running task', () => {
    installBridge();
    render(<ProviderControls task={{ ...task, status: 'IMPLEMENTING' }} busy={false} onChanged={async () => {}} />);
    fireEvent.click(screen.getByText('AI providers'));
    expect((screen.getByLabelText('Implementation provider') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Review provider') as HTMLSelectElement).disabled).toBe(true);
  });
});
