/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Settings } from '../../src/shared/domain/models';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
import { Toasts } from '../../src/renderer/src/components/Toasts';
import { useStore } from '../../src/renderer/src/state/store';
import { deferred, installBridge, ok, renderApp, type Bridge } from './harness';

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
    localInferenceReleaseBeforeVerification: true,
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

  it('shows the runtime-release-before-verification switch on, and saves it off when unticked', async () => {
    renderApp(<SettingsView />);
    const release = await screen.findByLabelText(/^Release the local runtime while Agent Relay verifies/);
    expect((release as HTMLInputElement).checked).toBe(true);

    fireEvent.click(release);
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(bridge.callsTo('settings:update')[0]?.input).toMatchObject({
      localInferenceReleaseBeforeVerification: false
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

describe('a Strata runtime in the profile editor', () => {
  it('switches a profile to Strata: shows its own fields, hides llama.cpp\'s, and saves the Strata profile', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();

    fireEvent.change(screen.getByRole('combobox', { name: 'Runtime' }), { target: { value: 'strata' } });
    expect(screen.queryByRole('combobox', { name: /^Executable/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Model source/ })).toBeNull();
    expect(screen.queryByLabelText(/^Fixed runtime arguments/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Strata Python interpreter/), { target: { value: 'C:\\strata\\.venv\\Scripts\\python.exe' } });
    fireEvent.change(screen.getByLabelText(/^Strata server script/), { target: { value: 'C:\\strata\\serve\\server.py' } });
    fireEvent.change(screen.getByLabelText(/^Strata model config/), { target: { value: 'C:\\strata\\strata-coder-iq1_m.json' } });
    fireEvent.change(screen.getByLabelText(/^Strata model name/), { target: { value: 'qwen3.8-flash-next-coder-iq1_m' } });
    // The list names it a Strata profile.
    expect(screen.getAllByText(/· Strata/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    const saved = (bridge.callsTo('settings:update')[0]?.input as Settings).localInference.profiles[0]!;
    expect(saved).toMatchObject({
      adapterKind: 'strata',
      executable: { kind: 'explicit_path', path: 'C:\\strata\\.venv\\Scripts\\python.exe' },
      strata: { serverScript: 'C:\\strata\\serve\\server.py', engineConfig: 'C:\\strata\\strata-coder-iq1_m.json' },
      model: { source: { kind: 'runtime_id', runtimeModelId: 'qwen3.8-flash-next-coder-iq1_m' } },
      fixedArguments: []
    });
  });

  it('keeps Save disabled while the Strata paths are missing, and switching back to llama.cpp drops them', async () => {
    renderApp(<SettingsView />);
    await screen.findByLabelText(/^Enable local inference/);
    await openDefaultProfileEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'Runtime' }), { target: { value: 'strata' } });
    expect((screen.getByRole('button', { name: /^Save settings$/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Runtime' }), { target: { value: 'llama_cpp' } });
    expect(screen.getByRole('combobox', { name: /^Executable/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /^Executable/ }), { target: { value: 'discovered' } });
    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: '18081' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    const saved = (bridge.callsTo('settings:update')[0]?.input as Settings).localInference.profiles[0]!;
    expect(saved.adapterKind).toBe('llama_cpp');
    expect(saved).not.toHaveProperty('strata');
  });
});

/**
 * The Windows CI failure behind this: Save wrote the settings at once, but "Settings saved" waited for the forced
 * tool diagnostics that follow it (codex, claude, git and gh are each probed, with timeouts of up to 30 s), so on a
 * cold first launch the confirmation came after the e2e's 15 s wait although the profile had long been stored.
 * A completed write is confirmed when it completes; the refreshes that follow it are not part of it.
 */
describe('saving settings', () => {
  it('confirms a completed write without waiting for the tool diagnostics that follow it', async () => {
    const diagnostics = deferred<unknown>();
    bridge.set('diagnostics:run', () => diagnostics.promise);
    renderApp(<><SettingsView /><Toasts /></>);
    fireEvent.click(await screen.findByLabelText(/^Release the local runtime while Agent Relay verifies/));
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    expect(await screen.findByText('Settings saved')).toBeTruthy();
    expect(bridge.callsTo('settings:update')).toHaveLength(1);
    // The diagnostics are still refreshed for the saved paths — after the confirmation, not before it.
    expect(bridge.callsTo('diagnostics:run').some((call) => (call.input as { force?: boolean }).force === true)).toBe(true);
    diagnostics.resolve({ ok: false, error: { code: 'INTERNAL', message: 'not used' } });
  });

  it('leaves no operation busy once the write is confirmed, while the diagnostics are still running', async () => {
    // A busy operation blocks every workflow action on the Run screen (its primary action included): a save that
    // stayed busy for its follow-up probes kept "Run implementation" disabled, with no reason given, until they ended.
    const diagnostics = deferred<unknown>();
    bridge.set('diagnostics:run', () => diagnostics.promise);
    function BusyProbe(): React.JSX.Element {
      const { busy } = useStore();
      return <output aria-label="busy operations">{Object.keys(busy).filter((key) => busy[key]).join(',') || 'none'}</output>;
    }
    renderApp(<><SettingsView /><Toasts /><BusyProbe /></>);
    fireEvent.click(await screen.findByLabelText(/^Release the local runtime while Agent Relay verifies/));
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await screen.findByText('Settings saved');
    await waitFor(() => expect(screen.getByLabelText('busy operations').textContent).toBe('none'));
    expect(bridge.callsTo('diagnostics:run').some((call) => (call.input as { force?: boolean }).force === true)).toBe(true);
    diagnostics.resolve({ ok: false, error: { code: 'INTERNAL', message: 'not used' } });
  });

  it('confirms a write that changed the Codex path without waiting for the Codex catalogue', async () => {
    const catalogue = deferred<unknown>();
    bridge.set('diagnostics:run', () => ({ ok: false, error: { code: 'INTERNAL', message: 'not used' } }));
    bridge.set('codex:listModels', () => catalogue.promise);
    renderApp(<><SettingsView /><Toasts /></>);
    await screen.findByLabelText(/^Enable local inference/);
    fireEvent.change(screen.getByLabelText(/^Codex path/), { target: { value: 'C:\\tools\\codex.exe' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    expect(await screen.findByText('Settings saved')).toBeTruthy();
    await waitFor(() => expect(bridge.callsTo('codex:listModels').length).toBeGreaterThan(0));
    catalogue.resolve(ok<'codex:listModels'>({ available: false, models: [], detail: 'not used' }));
  });

  it('still reports a refused write as a failure and never as saved', async () => {
    bridge.set('settings:update', () => ({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Port is in use.' } }));
    renderApp(<><SettingsView /><Toasts /></>);
    fireEvent.click(await screen.findByLabelText(/^Release the local runtime while Agent Relay verifies/));
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    expect(await screen.findByText('Could not save settings')).toBeTruthy();
    expect(screen.queryByText('Settings saved')).toBeNull();
  });
});
