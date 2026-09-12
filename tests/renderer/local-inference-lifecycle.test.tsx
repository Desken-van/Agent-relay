/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LocalInferenceCapabilities, LocalInferenceState } from '../../src/shared/domain/local-inference';
import type { IpcResult } from '../../src/shared/ipc';
import { LocalInferenceLifecyclePanel } from '../../src/renderer/src/components/LocalInferenceLifecyclePanel';
import { burstClick, deferred, fail, installBridge, ok, settle, type Bridge } from './harness';

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

function state(value: LocalInferenceState): Bridge {
  return installBridge({ 'localInference:getState': () => ok<'localInference:getState'>(value) });
}

const CAPABILITIES: LocalInferenceCapabilities = {
  protocol: 'agent-relay.local-inference',
  contractVersion: 1,
  providerId: 'local-llama-cpp',
  modelId: 'local-model',
  available: true,
  unavailableReason: null,
  executableSource: 'path',
  runtimeVersion: 'version: 1 (fake)',
  supportsChatCompletions: true,
  supportsStreaming: false,
  supportsUsageWhenReported: true,
  supportsChatTemplateParameters: true,
  inferenceVerified: false
};

function primaryButton(): HTMLElement {
  return screen.getByRole('button', { name: /Check capabilities|Start runtime|Re-check capabilities|Check health|Refresh state|Start unavailable/ });
}

describe('local inference lifecycle panel', () => {
  it('shows the four required fact labels and calls only getState on mount', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);

    expect(screen.getByText('What happened')).toBeTruthy();
    expect(screen.getByText('Current state')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Next action')).toBeTruthy();

    await settle();
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]?.channel).toBe('localInference:getState');
  });

  it('renders exactly one primary lifecycle button, with no duplicate controls, across every state', async () => {
    const cases: LocalInferenceState[] = [
      { kind: 'unavailable', reason: 'not found' },
      { kind: 'stopped' },
      { kind: 'starting', runtimeInstanceId: 'rt1' },
      { kind: 'healthy', runtimeInstanceId: 'rt1' },
      { kind: 'inferring', runtimeInstanceId: 'rt1', requestId: 'req-1' },
      { kind: 'stopping', runtimeInstanceId: 'rt1' },
      { kind: 'failed', reason: 'boom' },
      { kind: 'cancelled', reason: 'boom' },
      { kind: 'timed_out', reason: 'boom' }
    ];

    for (const value of cases) {
      state(value);
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();

      const primaryButtons = screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('btn--primary'));
      expect(primaryButtons).toHaveLength(1);
      unmount();
      cleanup();
    }
  });

  it('projects Check capabilities when stopped with no evidence, then Start runtime once available', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    expect(primaryButton().textContent).toContain('Check capabilities');
    bridge.set('localInference:getCapabilities', () => ok<'localInference:getCapabilities'>(CAPABILITIES));
    fireEvent.click(primaryButton());
    await waitFor(() => expect(screen.getByRole('button', { name: /Start runtime/ })).toBeTruthy());
  });

  it('replaces a stale unavailable state after enabled settings pass a manual capability check', async () => {
    const bridge = installBridge({
      'localInference:getState': () =>
        ok<'localInference:getState'>({ kind: 'unavailable', reason: 'Settings were disabled.' }),
      'localInference:getCapabilities': () =>
        ok<'localInference:getCapabilities'>(CAPABILITIES)
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.click(primaryButton());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start runtime/ })).toBeTruthy()
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(1);
  });

  it('projects Re-check capabilities when capability evidence says unavailable', async () => {
    const bridge = installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'stopped' }),
      'localInference:getCapabilities': () =>
        ok<'localInference:getCapabilities'>({ ...CAPABILITIES, available: false, unavailableReason: 'missing' })
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.click(primaryButton());
    await waitFor(() => expect(screen.getByRole('button', { name: /Re-check capabilities/ })).toBeTruthy());
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(1);
  });

  it('projects Refresh state for transitional states using passive getState only', async () => {
    for (const kind of ['starting', 'inferring', 'stopping'] as const) {
      const value: LocalInferenceState =
        kind === 'inferring'
          ? { kind, runtimeInstanceId: 'rt1', requestId: 'req-1' }
          : { kind, runtimeInstanceId: 'rt1' };
      const bridge = state(value);
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      expect(primaryButton().textContent).toContain('Refresh state');
      fireEvent.click(primaryButton());
      await settle();
      expect(bridge.callsTo('localInference:getState')).toHaveLength(2);
      expect(bridge.callsTo('localInference:start')).toHaveLength(0);
      expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(0);
      unmount();
      cleanup();
    }
  });

  it('projects Check health while healthy', async () => {
    const bridge = state({ kind: 'healthy', runtimeInstanceId: 'rt1' });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();
    expect(primaryButton().textContent).toContain('Check health');
    fireEvent.click(primaryButton());
    await waitFor(() => expect(bridge.callsTo('localInference:checkHealth')).toHaveLength(1));
  });

  it('disables the primary button for terminal failure states and requires the separate cleanup path', async () => {
    for (const kind of ['failed', 'cancelled', 'timed_out'] as const) {
      state({ kind, reason: 'boom' });
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      const button = primaryButton();
      expect(button.textContent).toContain('Start unavailable');
      expect(button).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: /^Stop/ })).toBeTruthy();
      unmount();
      cleanup();
    }
  });

  it('shows Stop only for starting, healthy, inferring, failed, cancelled or timed_out — never stopped, unavailable or disabled', async () => {
    const withStop: LocalInferenceState[] = [
      { kind: 'starting', runtimeInstanceId: 'rt1' },
      { kind: 'healthy', runtimeInstanceId: 'rt1' },
      { kind: 'inferring', runtimeInstanceId: 'rt1', requestId: 'req-1' },
      { kind: 'failed', reason: 'boom' },
      { kind: 'cancelled', reason: 'boom' },
      { kind: 'timed_out', reason: 'boom' }
    ];
    const withoutStop: LocalInferenceState[] = [
      { kind: 'stopped' },
      { kind: 'unavailable', reason: 'not found' },
      { kind: 'stopping', runtimeInstanceId: 'rt1' }
    ];

    for (const value of withStop) {
      state(value);
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      expect(screen.queryByRole('button', { name: /^Stop/ })).toBeTruthy();
      unmount();
      cleanup();
    }
    for (const value of withoutStop) {
      state(value);
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
      unmount();
      cleanup();
    }

    // Disabled settings: no Stop even if a (stale) active state were reported.
    state({ kind: 'healthy', runtimeInstanceId: 'rt1' });
    render(<LocalInferenceLifecyclePanel enabled={false} unsaved={false} />);
    await settle();
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeTruthy();
  });

  it('exempts Stop from a pending Start claim, letting Stop interrupt it immediately', async () => {
    const startGate = deferred<IpcResult<LocalInferenceState>>();
    const bridge = installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'stopped' }),
      'localInference:getCapabilities': () => ok<'localInference:getCapabilities'>(CAPABILITIES),
      'localInference:start': () => startGate.promise,
      'localInference:stop': () => ok<'localInference:stop'>({ kind: 'stopped' })
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.click(primaryButton());
    await waitFor(() => expect(screen.getByRole('button', { name: /Start runtime/ })).toBeTruthy());
    fireEvent.click(primaryButton());
    await settle();

    // Start is now pending (the primary button is mid-flight); Stop must not
    // be disabled by that claim, and clicking it must dispatch immediately.
    const stopButton = screen.getByRole('button', { name: /^Stop/ });
    expect(stopButton).toHaveProperty('disabled', false);
    fireEvent.click(stopButton);
    await settle();
    expect(bridge.callsTo('localInference:stop')).toHaveLength(1);

    // Even a stale successful Start answer must not overwrite the later Stop.
    startGate.resolve(ok<'localInference:start'>({ kind: 'healthy', runtimeInstanceId: 'stale' }));
    await settle();
    expect(screen.getAllByText('Stopped')).toHaveLength(2);
    expect(screen.queryByText(/Healthy \(runtime stale\)/)).toBeNull();
  });

  it('disables Stop only while another stop is itself in flight', async () => {
    const stopGate = deferred<IpcResult<LocalInferenceState>>();
    installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'healthy', runtimeInstanceId: 'rt1' }),
      'localInference:stop': () => stopGate.promise
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    const stopButton = screen.getByRole('button', { name: /^Stop/ });
    fireEvent.click(stopButton);
    await settle();
    expect(stopButton).toHaveProperty('disabled', true);

    stopGate.resolve(ok<'localInference:stop'>({ kind: 'stopped' }));
    await settle();
  });

  it('dedupes a burst of clicks on the primary button into exactly one IPC call', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    await burstClick(primaryButton());
    await settle();
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(1);
  });

  it('disables the primary button and dispatches nothing when settings are disabled', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled={false} unsaved={false} />);
    await settle();

    const button = primaryButton();
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByText(/Enable local inference in Settings and save/)).toBeTruthy();
    fireEvent.click(button);
    await settle();
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(0);
    expect(bridge.callsTo('localInference:start')).toHaveLength(0);
  });

  it('keeps the one contextual primary button visible but disabled while local-inference edits are unsaved', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled unsaved />);
    await settle();

    const button = primaryButton();
    expect(button.textContent).toContain('Check capabilities');
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByText(/Save local inference settings before using lifecycle controls/)).toBeTruthy();
    fireEvent.click(button);
    await settle();
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(0);
  });

  it('distinguishes executable availability from health and inference verification in capability evidence', async () => {
    installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'stopped' }),
      'localInference:getCapabilities': () =>
        ok<'localInference:getCapabilities'>({ ...CAPABILITIES, available: true, inferenceVerified: false })
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.click(primaryButton());
    await waitFor(() => expect(screen.getByText(/inference verified: no/i)).toBeTruthy());
    expect(screen.getByText(/Executable available: yes/i)).toBeTruthy();
  });

  it('never invents success from a rejected or unknown IPC call', async () => {
    installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'stopped' }),
      'localInference:getCapabilities': () => fail('boom, could not check', 'INTERNAL')
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.click(primaryButton());
    await waitFor(() => expect(screen.getByText(/boom, could not check/)).toBeTruthy());
    // Still projecting from the stopped/unknown-evidence state, not success.
    expect(primaryButton().textContent).toContain('Check capabilities');
  });
});
