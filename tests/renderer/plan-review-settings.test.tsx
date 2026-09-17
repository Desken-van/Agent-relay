/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { CoaiConnectionDiagnostic } from '../../src/shared/domain/coai-diagnostics';
import type { Settings } from '../../src/shared/domain/models';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
import { fail, installBridge, ok, renderApp, type Bridge } from './harness';

function makeCoaiDiagnostic(overrides: Partial<CoaiConnectionDiagnostic> = {}): CoaiConnectionDiagnostic {
  return {
    serverReached: true,
    serverName: 'coai-mcp',
    serverVersion: '0.24.0',
    planReview: 'available',
    humanEscalation: 'available',
    codeReview: 'unavailable',
    reconciliation: 'available',
    missingForCodeReview: ['reserve_round', 'run_round', 'round_status'],
    unknownToolCount: 0,
    capabilityFingerprint: 'a'.repeat(64),
    contractChangedSinceLastKnown: false,
    detail: 'Plan review is available. Durable code review is unavailable: missing reserve_round, run_round, round_status.',
    checkedAt: '2026-09-15T00:00:00.000Z',
    ...overrides
  };
}

let bridge: Bridge;
let settings: Settings;

beforeEach(() => {
  settings = {
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
  bridge = installBridge({
    'settings:get': () => ok<'settings:get'>(settings),
    'settings:update': (input) => ok<'settings:update'>({ ...settings, ...(input as object) })
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

describe('external plan-review settings', () => {
  it('keeps an unfinished newline so fixed arguments can be typed one per line', async () => {
    renderApp(<SettingsView />);
    const argumentsField = (await screen.findByLabelText(/^MCP arguments/)) as HTMLTextAreaElement;

    fireEvent.change(argumentsField, { target: { value: '--stdio' } });
    fireEvent.change(argumentsField, { target: { value: '--stdio\n' } });
    expect(argumentsField.value).toBe('--stdio\n');

    fireEvent.change(argumentsField, { target: { value: '--stdio\n--verbose' } });
    fireEvent.change(screen.getByLabelText(/^MCP executable/), {
      target: { value: 'C:\\tools\\coai-mcp.cmd' }
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable task-level/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(bridge.callsTo('settings:update')[0]?.input).toMatchObject({
      externalPlanReviewEnabled: true,
      coaiMcpArguments: ['--stdio', '--verbose'],
      localInference: settings.localInference
    });
  });

  it('blocks credential arguments before they reach the main process', async () => {
    renderApp(<SettingsView />);
    fireEvent.change(await screen.findByLabelText(/^MCP arguments/), {
      target: { value: '--token\nnot-a-real-secret' }
    });

    expect(await screen.findByText(/cannot contain control characters or credential material/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save settings$/ })).toHaveProperty('disabled', true);
    expect(bridge.callsTo('settings:update')).toHaveLength(0);
  });
});

describe('the Coai connection diagnostic', () => {
  it('shows nothing before the first check, then displays independent capabilities on demand', async () => {
    bridge.set('coai:checkConnection', () => ok<'coai:checkConnection'>(makeCoaiDiagnostic()));
    renderApp(<SettingsView />);

    expect(await screen.findByText(/Not checked yet this session/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Recheck connection/i }));

    await screen.findByText('coai-mcp');
    expect(bridge.callsTo('coai:checkConnection')).toHaveLength(1);
    expect(screen.getByText(/Plan review: available/i)).toBeTruthy();
    expect(screen.getByText(/Human escalation: available/i)).toBeTruthy();
    expect(screen.getByText(/Durable code review: unavailable/i)).toBeTruthy();
    expect(screen.getByText(/Reconciliation: available/i)).toBeTruthy();
  });

  it('flags a contract change the backend reports against the durable last-known fingerprint', async () => {
    // The renderer no longer decides "changed" by comparing two in-session
    // reads itself — that comparison is the backend's, against Settings'
    // durable `coaiLastKnownContractFingerprint`, so it survives a restart.
    // This test only proves the renderer surfaces whatever the backend says.
    let call = 0;
    bridge.set('coai:checkConnection', () =>
      ok<'coai:checkConnection'>(makeCoaiDiagnostic({ contractChangedSinceLastKnown: (call += 1) === 2 }))
    );
    renderApp(<SettingsView />);
    const button = await screen.findByRole('button', { name: /Recheck connection/i });

    fireEvent.click(button);
    await screen.findByText('coai-mcp');
    expect(screen.queryByText(/contract changed/i)).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(bridge.callsTo('coai:checkConnection')).toHaveLength(2));
    expect(
      await screen.findByText(/contract changed since the last time this build durably confirmed it/i)
    ).toBeTruthy();
  });

  it('does not claim the contract changed when the backend reports no change', async () => {
    bridge.set('coai:checkConnection', () => ok<'coai:checkConnection'>(makeCoaiDiagnostic()));
    renderApp(<SettingsView />);
    const button = await screen.findByRole('button', { name: /Recheck connection/i });

    fireEvent.click(button);
    await screen.findByText('coai-mcp');
    fireEvent.click(button);
    await waitFor(() => expect(bridge.callsTo('coai:checkConnection')).toHaveLength(2));

    expect(screen.queryByText(/contract changed/i)).toBeNull();
  });

  it('shows a safe, transport-level failure without hiding the button', async () => {
    bridge.set('coai:checkConnection', () =>
      fail('The Coai server could not be reached (TIMEOUT).', 'TOOL_FAILED')
    );
    renderApp(<SettingsView />);

    fireEvent.click(await screen.findByRole('button', { name: /Recheck connection/i }));

    expect(await screen.findByText(/could not be reached \(TIMEOUT\)/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', false);
  });

  it('disables Recheck connection while unsaved Coai edits are present, so it cannot misleadingly test the old configuration', async () => {
    bridge.set('coai:checkConnection', () => ok<'coai:checkConnection'>(makeCoaiDiagnostic()));
    renderApp(<SettingsView />);

    const recheckButton = await screen.findByRole('button', { name: /Recheck connection/i });
    expect(recheckButton).toHaveProperty('disabled', false);

    fireEvent.change(screen.getByLabelText(/^MCP executable/), {
      target: { value: 'C:\\tools\\coai-mcp-new.exe' }
    });

    expect(await screen.findByText(/unsaved Coai changes/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', true);

    // Disabled means disabled: clicking it must not reach the main process.
    fireEvent.click(screen.getByRole('button', { name: /Recheck connection/i }));
    expect(bridge.callsTo('coai:checkConnection')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));

    expect(screen.queryByText(/unsaved Coai changes/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', false);
  });

  it('disables Recheck connection while an unsaved processTimeoutMs edit is present, and sends no IPC while clicked', async () => {
    // processTimeoutMs is not a Coai-specific field — it lives in the Limits
    // card — but CoaiCapabilityService's probe clamps its own timeout to it
    // (see COAI_CONNECTION_PROBE_SETTINGS_KEYS), so an unsaved edit here is
    // exactly as able to make a check misleadingly test stale configuration
    // as an unsaved MCP executable path.
    bridge.set('coai:checkConnection', () => ok<'coai:checkConnection'>(makeCoaiDiagnostic()));
    renderApp(<SettingsView />);

    const recheckButton = await screen.findByRole('button', { name: /Recheck connection/i });
    expect(recheckButton).toHaveProperty('disabled', false);

    fireEvent.change(screen.getByLabelText(/^Process timeout/), { target: { value: '45' } });

    expect(await screen.findByText(/unsaved Coai changes/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: /Recheck connection/i }));
    expect(bridge.callsTo('coai:checkConnection')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^Save settings$/ }));
    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));

    expect(screen.queryByText(/unsaved Coai changes/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', false);
  });

  it('does not disable Recheck connection for an unsaved edit outside the probe-relevant fields', async () => {
    // The negative control: a field genuinely unrelated to the connection
    // probe (a review-provider switch) must not trip the dirty-guard, or the
    // button would be unusable far more often than the risk it exists for.
    bridge.set('coai:checkConnection', () => ok<'coai:checkConnection'>(makeCoaiDiagnostic()));
    renderApp(<SettingsView />);
    await screen.findByRole('button', { name: /Recheck connection/i });

    fireEvent.click(screen.getByRole('checkbox', { name: /Enable task-level/i }));

    expect(screen.queryByText(/unsaved Coai changes/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Recheck connection/i })).toHaveProperty('disabled', false);
  });
});
