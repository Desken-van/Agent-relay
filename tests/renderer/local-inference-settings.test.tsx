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

/** Opens the editor for the one shipped-default profile, exactly as an operator clicking it would. */
async function openDefaultProfileEditor(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Local model/ }));
  await screen.findByText('Editing: Local model');
}

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

  it('edits enabled state, the profile list, and one profile\'s executable/model/arguments/port/context/timeouts/max tokens', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.click(screen.getByLabelText(/^Enable local inference/));
    await openDefaultProfileEditor();

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
        profiles: [
          {
            id: 'default',
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
        ]
      }
    });
  });

  it('accepts an Ornith-style chat-template parameter map including false values', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();

    fireEvent.change(screen.getByLabelText(/^Default chat-template parameters/), {
      target: { value: '{"enable_thinking": false, "preserve_thinking": false}' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    const input = bridge.callsTo('settings:update')[0]?.input as {
      localInference: { profiles: Array<{ requestDefaults: unknown }> };
    };
    expect(input.localInference.profiles[0]?.requestDefaults).toEqual({
      maxOutputTokens: 4096,
      chatTemplateParameters: { enable_thinking: false, preserve_thinking: false }
    });
  });

  it('normalizes a blank chat-template parameters textarea to an empty object rather than blocking on invalid JSON', async () => {
    settings = {
      ...settings,
      localInference: {
        ...settings.localInference,
        profiles: settings.localInference.profiles.map((profile) => ({
          ...profile,
          requestDefaults: {
            ...profile.requestDefaults,
            chatTemplateParameters: { enable_thinking: false }
          }
        }))
      }
    };
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();

    const field = screen.getByLabelText(/^Default chat-template parameters/);
    fireEvent.change(field, { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    const input = bridge.callsTo('settings:update')[0]?.input as {
      localInference: { profiles: Array<{ requestDefaults: unknown }> };
    };
    expect(input.localInference.profiles[0]?.requestDefaults).toEqual({
      maxOutputTokens: 4096,
      chatTemplateParameters: {}
    });
  });

  it('disables Save and sends no update for invalid raw JSON in chat-template parameters', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();

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
    await openDefaultProfileEditor();

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
    await openDefaultProfileEditor();

    fireEvent.change(screen.getByLabelText('Context size (tokens)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/^Default max output tokens/), { target: { value: '200' } });

    expect(await screen.findByText(/output token cap may not exceed the context limit/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('disables Save for an invalid explicit executable path (empty)', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();

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
    await openDefaultProfileEditor();

    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: '99999' } });

    expect(await screen.findByText(/Local inference settings cannot be saved/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });

  it('adds a second profile, enables it and sets it as default — both persist through Save, the first left untouched', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    fireEvent.click(screen.getByRole('button', { name: /^Add profile$/ }));
    await screen.findByText(/^Editing: Local model 2/);

    const enabledCheckboxes = screen.getAllByLabelText(/^Enable ".*" for new task selection$/);
    // The newly added profile is the second row; it starts disabled, like the shipped default.
    fireEvent.click(enabledCheckboxes[1] as HTMLElement);
    const defaultRadios = screen.getAllByLabelText(/^Set ".*" as the default profile$/);
    fireEvent.click(defaultRadios[1] as HTMLElement);

    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));

    const input = bridge.callsTo('settings:update')[0]?.input as {
      localInference: {
        defaultProfileId: string | null;
        profiles: Array<{ id: string; enabled: boolean }>;
      };
    };
    expect(input.localInference.profiles).toHaveLength(2);
    const [first, second] = input.localInference.profiles;
    // Unedited: the shipped default ships disabled.
    expect(first?.enabled).toBe(false);
    expect(second?.enabled).toBe(true);
    expect(input.localInference.defaultProfileId).toBe(second?.id);
  });

  it('deletes a profile and clears the default when the deleted profile was it', async () => {
    settings = {
      ...settings,
      localInference: {
        ...settings.localInference,
        profiles: [
          ...settings.localInference.profiles,
          { ...settings.localInference.profiles[0]!, id: 'second', displayName: 'Second profile' }
        ]
      }
    };
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);

    const deleteButtons = await screen.findAllByRole('button', { name: /^Delete$/ });
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[0] as HTMLElement);

    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));

    const input = bridge.callsTo('settings:update')[0]?.input as {
      localInference: { defaultProfileId: string | null; profiles: Array<{ id: string }> };
    };
    expect(input.localInference.profiles.map((profile) => profile.id)).toEqual(['second']);
    expect(input.localInference.defaultProfileId).toBeNull();
  });
});
