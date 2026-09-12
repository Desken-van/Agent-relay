/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProviderControls } from '../../src/renderer/src/components/RunView';
import { taskSchema } from '../../src/shared/domain/models';
import { burstClick, deferred, deliver, installBridge, ok } from './harness';
const task = taskSchema.parse({ id: 't', projectId: 'p', title: 'Task', originalRequest: 'Do it', status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: 'spec', claudeSessionId: 'old', worktreePath: null, branchName: null, baseBranch: null, specificationJson: null, specificationApprovedAt: null, lastReviewJson: null, lastError: null, codexModel: null, claudeModel: null, createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' });
afterEach(cleanup);
describe('provider selection controls', () => {
  it('is absent while the selection matches the persisted providers', () => {
    installBridge();
    render(<ProviderControls task={task} busy={false} onChanged={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'Apply providers' })).toBeNull();
  });

  it('appears the moment a selection differs, submits once with the expected revision, and disappears once applied', async () => {
    const pending = deferred<ReturnType<typeof ok<'workflow:configureProviders'>>>();
    const bridge = installBridge({ 'workflow:configureProviders': () => pending.promise });
    const changed = vi.fn(async () => {});
    render(<ProviderControls task={task} busy={false} onChanged={changed} />);

    expect(screen.queryByRole('button', { name: 'Apply providers' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Implementation provider'), { target: { value: 'codex' } });
    expect(bridge.calls).toHaveLength(0);

    await burstClick(screen.getByRole('button', { name: 'Apply providers' }));
    expect(bridge.callsTo('workflow:configureProviders')).toEqual([{ channel: 'workflow:configureProviders', input: { taskId: 't', expectedRevision: 0, implementationProvider: 'codex', reviewProvider: 'codex' } }]);
    expect(bridge.callsTo('workflow:implement')).toHaveLength(0);

    await deliver(pending, ok<'workflow:configureProviders'>({ ...task, implementationProvider: 'codex', providerRevision: 1 }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ implementationProvider: 'codex', providerRevision: 1 })));
  });

  it('disables selection during a running task', () => {
    installBridge();
    render(<ProviderControls task={{ ...task, status: 'IMPLEMENTING' }} busy={false} onChanged={async () => {}} />);
    expect((screen.getByLabelText('Implementation provider') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Review provider') as HTMLSelectElement).disabled).toBe(true);
  });
});
