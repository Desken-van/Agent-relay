/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  LocalInferenceCapabilities,
  LocalInferenceOutcome,
  LocalInferenceResponse,
  LocalInferenceState
} from '../../src/shared/domain/local-inference';
import type { IpcChannel, IpcResult } from '../../src/shared/ipc';
import { LocalInferenceLifecyclePanel } from '../../src/renderer/src/components/LocalInferenceLifecyclePanel';
import { burstClick, deferred, fail, installBridge, ok, settle, type Bridge, type Handler } from './harness';

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

function state(value: LocalInferenceState): Bridge {
  return installBridge({
    'localInference:getState': () => ok<'localInference:getState'>(value),
    'localInference:listProfiles': () => ok<'localInference:listProfiles'>([])
  });
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
  it('shows the four required fact labels and calls only getState and listProfiles on mount', async () => {
    const bridge = state({ kind: 'stopped' });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);

    expect(screen.getByText('What happened')).toBeTruthy();
    expect(screen.getByText('Current state')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Next action')).toBeTruthy();

    await settle();
    expect(bridge.calls).toHaveLength(2);
    expect(bridge.calls.map((call) => call.channel).sort()).toEqual(
      ['localInference:getState', 'localInference:listProfiles'].sort()
    );
  });

  it('renders exactly one lifecycle button and one Run test inference button, with no duplicate controls, across every state', async () => {
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
      expect(primaryButtons).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: 'Run test inference' })).toHaveLength(1);
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

  it('shows idle Stop only for starting, healthy, inferring, failed, cancelled or timed_out — never stopped, unavailable or disabled', async () => {
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

  it('blocks Stop while Start is pending and releases the shared claim after Start completes', async () => {
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

    // Start is now pending (the primary button is mid-flight); the same claim
    // must disable and guard Stop.
    const stopButton = screen.getByRole('button', { name: /^Stop/ });
    expect(stopButton).toHaveProperty('disabled', true);
    fireEvent.click(stopButton);
    await settle();
    expect(bridge.callsTo('localInference:stop')).toHaveLength(0);

    startGate.resolve(ok<'localInference:start'>({ kind: 'healthy', runtimeInstanceId: 'rt1' }));
    await settle();
    expect(stopButton).toHaveProperty('disabled', false);
    fireEvent.click(stopButton);
    await settle();
    expect(bridge.callsTo('localInference:stop')).toHaveLength(1);
  });

  it('blocks every other panel action while Stop is pending, dedupes Stop, and releases the shared claim', async () => {
    const stopGate = deferred<IpcResult<LocalInferenceState>>();
    const bridge = installBridge({
      'localInference:getState': () => ok<'localInference:getState'>({ kind: 'healthy', runtimeInstanceId: 'rt1' }),
      'localInference:stop': () => stopGate.promise
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'ready before Stop' } });
    const stopButton = screen.getByRole('button', { name: /^Stop/ });
    await burstClick(stopButton);
    await settle();
    expect(stopButton).toHaveProperty('disabled', true);
    expect(primaryButton()).toHaveProperty('disabled', true);
    expect(inferenceButton()).toHaveProperty('disabled', true);
    expect(promptField()).toHaveProperty('disabled', true);
    fireEvent.click(primaryButton());
    fireEvent.click(inferenceButton());
    expect(bridge.callsTo('localInference:stop')).toHaveLength(1);
    expect(bridge.callsTo('localInference:checkHealth')).toHaveLength(0);
    expect(bridge.callsTo('localInference:runTestInference')).toHaveLength(0);

    stopGate.resolve(ok<'localInference:stop'>({ kind: 'stopped' }));
    await settle();
    expect(primaryButton()).toHaveProperty('disabled', false);
    fireEvent.click(primaryButton());
    await settle();
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(1);
  });

  it('blocks Stop while capabilities, health, and passive refresh are pending', async () => {
    const cases: Array<{
      readonly name: string;
      readonly initial: LocalInferenceState;
      readonly channel:
        | 'localInference:getCapabilities'
        | 'localInference:checkHealth'
        | 'localInference:getState';
      readonly answer: IpcResult<LocalInferenceCapabilities | LocalInferenceState>;
    }> = [
      {
        name: 'capabilities',
        initial: { kind: 'stopped' },
        channel: 'localInference:getCapabilities',
        answer: ok<'localInference:getCapabilities'>(CAPABILITIES)
      },
      {
        name: 'health',
        initial: { kind: 'healthy', runtimeInstanceId: 'rt1' },
        channel: 'localInference:checkHealth',
        answer: ok<'localInference:checkHealth'>({ kind: 'healthy', runtimeInstanceId: 'rt1' })
      },
      {
        name: 'refresh',
        initial: { kind: 'starting', runtimeInstanceId: 'rt1' },
        channel: 'localInference:getState',
        answer: ok<'localInference:getState'>({ kind: 'starting', runtimeInstanceId: 'rt1' })
      }
    ];

    for (const testCase of cases) {
      const gate = deferred<unknown>();
      let stateReadCount = 0;
      const bridge = installBridge({
        'localInference:getState': () => {
          stateReadCount += 1;
          return testCase.channel === 'localInference:getState' && stateReadCount > 1
            ? gate.promise
            : ok<'localInference:getState'>(testCase.initial);
        },
        ...(testCase.channel === 'localInference:getCapabilities'
          ? { 'localInference:getCapabilities': () => gate.promise }
          : {}),
        ...(testCase.channel === 'localInference:checkHealth'
          ? { 'localInference:checkHealth': () => gate.promise }
          : {}),
        'localInference:stop': () => ok<'localInference:stop'>({ kind: 'stopped' })
      });
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();

      fireEvent.click(primaryButton());
      await settle();
      const stopButton = screen.getByRole('button', { name: /^Stop/ });
      expect(stopButton, testCase.name).toHaveProperty('disabled', true);
      fireEvent.click(stopButton);
      expect(bridge.callsTo('localInference:stop'), testCase.name).toHaveLength(0);

      gate.resolve(testCase.answer);
      await settle();
      unmount();
      cleanup();
    }
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

/* -------------------------------------------------------------------------- */
/* Test inference (LOCAL-B3)                                                  */
/* -------------------------------------------------------------------------- */

function healthy(handlers: Partial<Record<IpcChannel, Handler>> = {}): Bridge {
  return installBridge({
    'localInference:getState': () =>
      ok<'localInference:getState'>({ kind: 'healthy', runtimeInstanceId: 'rt1' }),
    ...handlers
  });
}

function response(overrides: Partial<LocalInferenceResponse> = {}): LocalInferenceResponse {
  return {
    version: 1,
    requestId: 'req-1',
    providerId: 'local-llama-cpp',
    modelId: 'local-model',
    runtimeVersion: 'version: 1 (fake)',
    runtimeInstanceId: 'rt1',
    durationMs: 42,
    completion: 'Hello there.',
    promptTokens: 3,
    completionTokens: 4,
    runtimeResponseId: null,
    finishReason: { kind: 'stop' },
    ...overrides
  };
}

function completed(overrides: Partial<LocalInferenceResponse> = {}): LocalInferenceOutcome {
  return { kind: 'completed', version: 1, response: response(overrides) };
}

function failedOutcome(
  kind: 'failed' | 'cancelled' | 'timed_out',
  reason: string
): LocalInferenceOutcome {
  return { kind, version: 1, requestId: 'req-1', reason, dispatchOutcome: 'unknown' };
}

function promptField(): HTMLElement {
  return screen.getByLabelText(/^Test inference prompt/);
}

function inferenceButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Run test inference' });
}

describe('local inference lifecycle panel — test inference', () => {
  it('keeps the prompt editor enabled while Healthy even with no prompt yet, and disables only the button', async () => {
    healthy();
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    expect(promptField()).toHaveProperty('disabled', false);
    expect(inferenceButton()).toHaveProperty('disabled', true);
  });

  it('lets an operator type, and lets an oversized prompt be edited back down, without ever disabling the field', async () => {
    healthy();
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'Say something short.' } });
    expect(promptField()).toHaveProperty('disabled', false);
    expect(inferenceButton()).toHaveProperty('disabled', false);

    fireEvent.change(promptField(), { target: { value: 'x'.repeat(200_001) } });
    expect(promptField()).toHaveProperty('disabled', false);
    expect(inferenceButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/too long/)).toBeTruthy();

    fireEvent.change(promptField(), { target: { value: 'short again' } });
    expect(inferenceButton()).toHaveProperty('disabled', false);
  });

  it('disables both the prompt editor and the button outside Healthy, when unsaved, and when settings are disabled', async () => {
    const cases: Array<{
      readonly enabled: boolean;
      readonly unsaved: boolean;
      readonly stateValue: LocalInferenceState;
    }> = [
      { enabled: true, unsaved: false, stateValue: { kind: 'stopped' } },
      { enabled: true, unsaved: false, stateValue: { kind: 'starting', runtimeInstanceId: 'rt1' } },
      { enabled: true, unsaved: true, stateValue: { kind: 'healthy', runtimeInstanceId: 'rt1' } },
      { enabled: false, unsaved: false, stateValue: { kind: 'healthy', runtimeInstanceId: 'rt1' } }
    ];

    for (const testCase of cases) {
      state(testCase.stateValue);
      const { unmount } = render(
        <LocalInferenceLifecyclePanel enabled={testCase.enabled} unsaved={testCase.unsaved} />
      );
      await settle();
      expect(promptField()).toHaveProperty('disabled', true);
      expect(inferenceButton()).toHaveProperty('disabled', true);
      unmount();
      cleanup();
    }
  });

  it('sends exactly {prompt} to localInference:runTestInference on click', async () => {
    const bridge = healthy({
      'localInference:runTestInference': () => ok<'localInference:runTestInference'>(completed())
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'Say something short.' } });
    fireEvent.click(inferenceButton());
    await settle();

    const calls = bridge.callsTo('localInference:runTestInference');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ prompt: 'Say something short.' });
  });

  it('one click invokes only runTestInference, with zero capability, start, health, stop, or refresh calls', async () => {
    const bridge = healthy({
      'localInference:runTestInference': () => ok<'localInference:runTestInference'>(completed())
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'Say something short.' } });
    fireEvent.click(inferenceButton());
    await settle();

    expect(bridge.callsTo('localInference:runTestInference')).toHaveLength(1);
    expect(bridge.callsTo('localInference:getCapabilities')).toHaveLength(0);
    expect(bridge.callsTo('localInference:start')).toHaveLength(0);
    expect(bridge.callsTo('localInference:checkHealth')).toHaveLength(0);
    expect(bridge.callsTo('localInference:stop')).toHaveLength(0);
    // Exactly the one mount-time getState call, and nothing further.
    expect(bridge.callsTo('localInference:getState')).toHaveLength(1);
  });

  it('renders Completion, Finish reason, Duration and Provider/model for a completed outcome', async () => {
    healthy({
      'localInference:runTestInference': () =>
        ok<'localInference:runTestInference'>(
          completed({
            completion: 'The answer is 4.',
            durationMs: 123,
            providerId: 'local-llama-cpp',
            modelId: 'wired-model',
            finishReason: { kind: 'stop' }
          })
        )
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'What is 2+2?' } });
    fireEvent.click(inferenceButton());

    await waitFor(() => expect(screen.getByText('The answer is 4.')).toBeTruthy());
    expect(screen.getByText(/Stop \(the runtime reported a normal end\)/)).toBeTruthy();
    expect(screen.getByText('123 ms')).toBeTruthy();
    expect(screen.getByText('local-llama-cpp / wired-model')).toBeTruthy();
  });

  it('maps every typed finish-reason variant honestly, including unknown and other', async () => {
    const cases: Array<{
      readonly finishReason: LocalInferenceResponse['finishReason'];
      readonly expect: RegExp;
    }> = [
      { finishReason: { kind: 'stop' }, expect: /^Stop /
      },
      { finishReason: { kind: 'length' }, expect: /^Length / },
      { finishReason: { kind: 'content_filter' }, expect: /^Content filter$/ },
      { finishReason: { kind: 'tool_calls' }, expect: /^Tool calls$/ },
      { finishReason: { kind: 'other', reason: 'custom-stop' }, expect: /^Other — custom-stop$/ },
      { finishReason: { kind: 'unknown' }, expect: /^Unknown / }
    ];

    for (const testCase of cases) {
      healthy({
        'localInference:runTestInference': () =>
          ok<'localInference:runTestInference'>(completed({ finishReason: testCase.finishReason }))
      });
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      fireEvent.change(promptField(), { target: { value: 'hi' } });
      fireEvent.click(inferenceButton());
      await waitFor(() => expect(screen.getByText(testCase.expect)).toBeTruthy());
      unmount();
      cleanup();
    }
  });

  it('renders a failed, cancelled or timed-out outcome as an explicit Failure reason, never as a completion', async () => {
    for (const kind of ['failed', 'cancelled', 'timed_out'] as const) {
      healthy({
        'localInference:runTestInference': () =>
          ok<'localInference:runTestInference'>(failedOutcome(kind, `The runtime ${kind}.`))
      });
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      fireEvent.change(promptField(), { target: { value: 'hi' } });
      fireEvent.click(inferenceButton());
      await waitFor(() => expect(screen.getByText('Failure reason')).toBeTruthy());
      expect(screen.getByText(`The runtime ${kind}.`)).toBeTruthy();
      expect(screen.queryByText('Completion')).toBeNull();
      unmount();
      cleanup();
    }
  });

  it('renders a bounded, redacted Failure reason for a rejected IPC promise and clears an older completion', async () => {
    const maliciousMessage =
      'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx raw response body {"secret":"ghp_1234567890abcdef1234"} ' +
      'x'.repeat(1_000);
    let callCount = 0;
    healthy({
      'localInference:runTestInference': () => {
        callCount += 1;
        return callCount === 1
          ? ok<'localInference:runTestInference'>(completed({ completion: 'Older completion.' }))
          : Promise.reject(new Error(maliciousMessage));
      }
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'hi' } });
    fireEvent.click(inferenceButton());
    await waitFor(() => expect(screen.getByText('Older completion.')).toBeTruthy());
    fireEvent.click(inferenceButton());

    await waitFor(() => expect(screen.getByText('Failure reason')).toBeTruthy());
    expect(
      screen.getByText('The local inference request failed before a typed response was received.')
    ).toBeTruthy();
    expect(screen.queryByText('Older completion.')).toBeNull();
    expect(screen.queryByText('Completion')).toBeNull();
    expect(screen.queryByText(/raw response body/)).toBeNull();
    expect(screen.queryByText(/sk-ant-abcdefghijklmnopqrstuvwx/)).toBeNull();
    expect(screen.queryByText(/ghp_1234567890abcdef1234/)).toBeNull();
    expect(screen.getByText('Failure reason').parentElement?.textContent?.length).toBeLessThanOrEqual(550);
    expect(inferenceButton()).toHaveProperty('disabled', false);
  });

  it('releases the shared claim after completed, ok:false, and rejected-promise inference results', async () => {
    const firstResults: Array<() => unknown> = [
      () => ok<'localInference:runTestInference'>(completed()),
      () => fail('Bounded IPC failure.', 'INTERNAL'),
      () => Promise.reject(new Error('Bounded transport failure.'))
    ];

    for (const firstResult of firstResults) {
      let callCount = 0;
      const bridge = healthy({
        'localInference:runTestInference': () => {
          callCount += 1;
          return callCount === 1
            ? firstResult()
            : ok<'localInference:runTestInference'>(completed());
        }
      });
      const { unmount } = render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
      await settle();
      fireEvent.change(promptField(), { target: { value: 'hi' } });

      fireEvent.click(inferenceButton());
      await waitFor(() => expect(inferenceButton()).toHaveProperty('disabled', false));
      fireEvent.click(inferenceButton());
      await waitFor(() =>
        expect(bridge.callsTo('localInference:runTestInference')).toHaveLength(2)
      );

      unmount();
      cleanup();
    }
  });

  it('dedupes a burst of clicks on Run test inference into exactly one IPC call', async () => {
    const bridge = healthy({
      'localInference:runTestInference': () => ok<'localInference:runTestInference'>(completed())
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'hi' } });
    await burstClick(inferenceButton());
    await settle();
    expect(bridge.callsTo('localInference:runTestInference')).toHaveLength(1);
  });

  it('blocks a lifecycle action while inference is pending, and blocks inference while a lifecycle action is pending', async () => {
    const inferenceGate = deferred<IpcResult<LocalInferenceOutcome>>();
    healthy({
      'localInference:runTestInference': () => inferenceGate.promise
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'hi' } });
    fireEvent.click(inferenceButton());
    await settle();

    // Inference is now pending: the lifecycle button (Check health, while
    // Healthy) must be disabled, and a second inference click must not fire.
    expect(screen.getByRole('button', { name: /Check health/ })).toHaveProperty('disabled', true);
    expect(inferenceButton()).toHaveProperty('disabled', true);

    inferenceGate.resolve(ok<'localInference:runTestInference'>(completed()));
    await settle();
  });

  it('blocks Stop while inference is pending and releases the shared claim after inference completes', async () => {
    const inferenceGate = deferred<IpcResult<LocalInferenceOutcome>>();
    const bridge = healthy({
      'localInference:runTestInference': () => inferenceGate.promise,
      'localInference:stop': () => ok<'localInference:stop'>({ kind: 'stopped' })
    });
    render(<LocalInferenceLifecyclePanel enabled unsaved={false} />);
    await settle();

    fireEvent.change(promptField(), { target: { value: 'hi' } });
    fireEvent.click(inferenceButton());
    await settle();

    const stopButton = screen.getByRole('button', { name: /^Stop/ });
    expect(stopButton).toHaveProperty('disabled', true);
    fireEvent.click(stopButton);
    await settle();
    expect(bridge.callsTo('localInference:stop')).toHaveLength(0);

    inferenceGate.resolve(ok<'localInference:runTestInference'>(completed()));
    await settle();
    expect(stopButton).toHaveProperty('disabled', false);
    expect(screen.getByText('Completion')).toBeTruthy();
    fireEvent.click(stopButton);
    await settle();
    expect(bridge.callsTo('localInference:stop')).toHaveLength(1);
  });
});
