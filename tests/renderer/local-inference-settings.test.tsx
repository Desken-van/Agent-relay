/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Settings } from '../../src/shared/domain/models';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
import { installBridge, ok, renderApp, type Bridge } from './harness';

let bridge: Bridge;
let settings: Settings;

function baseSettings(): Settings {
  return {
    localInference: defaultLocalInferenceSettings(),
    claudeExecutablePath: null,
    codexExecutablePath: null,
    ghExecutablePath: null,
    externalPlanReviewEnabled: false,
    externalCodeReviewEnabled: false,
    coaiMcpExecutablePath: null,
    coaiMcpArguments: [],
    coaiMcpWorkingDirectory: null,
    coaiLastKnownContractFingerprint: null,
    coaiLastKnownContractCheckedAt: null,
    conventionsRepositoryPath: null,
    conventionsExpectedRevision: null,
    conventionsRulePaths: [],
    githubOwner: 'acme',
    projectsRoot: 'C:\\projects',
    worktreesRoot: 'C:\\worktrees',
    maxReviewRounds: 3,
    processTimeoutMs: 30 * 60_000,
    maxStoredLogBytes: 2_000_000,
    maxDiffBytes: 400_000,
    claudeMaxTurns: 80,
    claudeAllowedTools: ['Bash(npm test *)'],
    claudeVerificationTools: ['Bash(npm test *)'],
    codexModel: null,
    claudeModel: null
  };
}

beforeEach(() => {
  settings = baseSettings();
  bridge = installBridge({
    'settings:get': () => ok<'settings:get'>(settings),
    'settings:update': (input) => ok<'settings:update'>({ ...settings, ...(input as object) })
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

describe('local inference settings', () => {
  it('submits the complete Settings draft, including an unedited localInference, through settings:update', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    fireEvent.change(screen.getByLabelText(/^Claude Code path/), {
      target: { value: 'C:\\tools\\claude.exe' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(bridge.callsTo('settings:update')[0]?.input).toMatchObject({
      localInference: defaultLocalInferenceSettings()
    });
  });

  it('edits enabled state, executable/model source variants, arguments, port, context, timeouts and max tokens', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.click(screen.getByLabelText(/^Enable local inference/));
    fireEvent.change(screen.getByRole('combobox', { name: /^Executable/ }), {
      target: { value: 'explicit_path' }
    });
    fireEvent.change(screen.getByLabelText('Executable path'), {
      target: { value: 'C:\\tools\\llama-server.exe' }
    });
    fireEvent.change(screen.getByRole('combobox', { name: /^Model source/ }), {
      target: { value: 'path' }
    });
    fireEvent.change(screen.getByLabelText('Model path'), { target: { value: 'C:\\models\\model.gguf' } });
    fireEvent.change(screen.getByLabelText(/^Fixed runtime arguments/), {
      target: { value: '--threads\n4' }
    });
    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: '18080' } });
    fireEvent.change(screen.getByLabelText('Context size (tokens)'), { target: { value: '8192' } });
    fireEvent.change(screen.getByLabelText(/^Default max output tokens/), { target: { value: '2048' } });
    fireEvent.change(screen.getByLabelText('Startup timeout (ms)'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('Health timeout (ms)'), { target: { value: '2222' } });
    fireEvent.change(screen.getByLabelText('Inference timeout (ms)'), { target: { value: '33333' } });
    fireEvent.change(screen.getByLabelText('Stop timeout (ms)'), { target: { value: '4444' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));

    expect(bridge.callsTo('settings:update')[0]?.input).toMatchObject({
      localInference: {
        enabled: true,
        executable: { kind: 'explicit_path', path: 'C:\\tools\\llama-server.exe' },
        model: { id: 'local-model', source: { kind: 'path', path: 'C:\\models\\model.gguf' } },
        fixedArguments: ['--threads', '4'],
        port: 18080,
        contextLimitTokens: 8192,
        startupTimeoutMs: 12345,
        healthTimeoutMs: 2222,
        inferenceTimeoutMs: 33333,
        shutdownTimeoutMs: 4444,
        requestDefaults: { maxOutputTokens: 2048, chatTemplateParameters: {} }
      }
    });
  });

  it('accepts an Ornith-style chat-template parameter map including false values', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByLabelText(/^Default chat-template parameters/), {
      target: { value: '{"enable_thinking": false, "preserve_thinking": false}' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(
      (bridge.callsTo('settings:update')[0]?.input as { localInference: { requestDefaults: unknown } })
        .localInference.requestDefaults
    ).toEqual({ maxOutputTokens: 4096, chatTemplateParameters: { enable_thinking: false, preserve_thinking: false } });
  });

  it('normalizes a blank chat-template parameters textarea to an empty object rather than blocking on invalid JSON', async () => {
    settings = {
      ...settings,
      localInference: {
        ...settings.localInference,
        requestDefaults: {
          ...settings.localInference.requestDefaults,
          chatTemplateParameters: { enable_thinking: false }
        }
      }
    };
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    const field = screen.getByLabelText(/^Default chat-template parameters/);
    fireEvent.change(field, { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(
      (bridge.callsTo('settings:update')[0]?.input as { localInference: { requestDefaults: unknown } })
        .localInference.requestDefaults
    ).toEqual({ maxOutputTokens: 4096, chatTemplateParameters: {} });
  });

  it('disables Save and sends no update for invalid raw JSON in chat-template parameters', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByLabelText(/^Default chat-template parameters/), {
      target: { value: '{not valid json' }
    });

    expect(await screen.findByText(/must be valid JSON/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('disables Save for a reserved fixed-argument override', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByLabelText(/^Fixed runtime arguments/), {
      target: { value: '--port\n9999' }
    });

    expect(await screen.findByText(/Local inference settings cannot be saved/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('disables Save when the default output cap exceeds the context size', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByLabelText('Context size (tokens)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/^Default max output tokens/), { target: { value: '200' } });

    expect(await screen.findByText(/output token cap may not exceed the context limit/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('disables Save for an invalid explicit executable path (empty)', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByRole('combobox', { name: /^Executable/ }), {
      target: { value: 'explicit_path' }
    });

    expect(await screen.findByText(/Local inference settings cannot be saved/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('disables Save for an out-of-range port', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: '99999' } });

    expect(await screen.findByText(/Local inference settings cannot be saved/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });
});
