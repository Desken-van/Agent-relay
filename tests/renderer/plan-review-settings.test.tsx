/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Settings } from '../../src/shared/domain/models';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
import { installBridge, ok, renderApp, type Bridge } from './harness';

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
