/**
 * What the running app's code reviewer is, and what the renderer cannot make it.
 *
 * The adapter's own contract is tested elsewhere. This is about the wiring: an
 * integration nobody switched on must refuse, the tool profile must come from
 * the main process, and a capability that is absent must be discovered before
 * `CodeReviewService` writes anything durable.
 */

import { describe, expect, it } from 'vitest';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_PLAN_PROFILE,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import {
  externalCodeReviewConfig,
  externalCodeReviewConfigured
} from '../../src/main/services/code-review-configuration';
import { CoaiPlanReviewer } from '../../src/main/adapters/mcp/coai-plan-reviewer';
import { externalPlanReviewConfig } from '../../src/main/services/plan-review-configuration';
import { defaultSettings } from '../../src/main/container';
import { SettingsBoundCodeReviewer } from '../../src/main/services/code-review-provider';
import type { Settings } from '../../src/shared/domain/models';
import type {
  ExternalCodeReviewSubject,
  ExternalCodeRoundLocator,
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig
} from '../../src/main/ports';

const subject: ExternalCodeReviewSubject = {
  worktreePath: 'C:\\work\\task-1',
  branch: 'agent/task-1',
  baseRef: 'main',
  headCommit: 'a'.repeat(40),
  subjectSha256: 'b'.repeat(64)
};

const locator: ExternalCodeRoundLocator = {
  providerId: COAI_PROVIDER_ID,
  sessionId: 'session-1',
  roundId: 'round-1'
};

/**
 * A real settings object, from the application's own defaults.
 *
 * Spelling the shape out by hand would drift the first time a field is added,
 * and a cast would hide that drift rather than surface it.
 */
function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...defaultSettings({ dataDir: 'C:/user-data', documentsDir: 'C:/documents' }),
    externalCodeReviewEnabled: true,
    coaiMcpExecutablePath: 'C:\\tools\\coai-mcp.exe',
    coaiMcpArguments: ['--stdio'],
    ...overrides
  };
}

class CountingClient implements ExternalMcpClient {
  discoveries = 0;
  calls: string[] = [];
  tools: readonly string[] = COAI_ADDRESSABLE_PROFILE;

  async discover(): Promise<ExternalMcpDiscovery> {
    this.discoveries++;

    return {
      server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' },
      tools: this.tools.map((name) => ({
        name,
        title: null,
        description: null,
        inputSchema: { type: 'object' },
        annotations: { readOnly: null, destructive: null, idempotent: null, openWorld: null }
      }))
    };
  }

  async call(
    _config: ExternalMcpServerConfig,
    tool: string
  ): Promise<ExternalMcpCallResult> {
    this.calls.push(tool);
    throw new Error('this client answers no tool call');
  }
}

describe('the trusted code-review configuration', () => {
  it('pins the exact ten-tool profile from the main process', () => {
    const config = externalCodeReviewConfig(settings());

    expect(config.allowedTools).toEqual(COAI_ADDRESSABLE_PROFILE);
    expect(config.allowedTools).toHaveLength(10);
    // The seven plan tools are a prefix, not the profile: code review needs the
    // three that make a round addressable.
    expect(config.allowedTools).not.toEqual(COAI_PLAN_PROFILE);
    expect(config.executablePath).toBe('C:\\tools\\coai-mcp.exe');
    expect(config.args).toEqual(['--stdio']);
  });

  it('refuses when the integration is off or its executable is missing', () => {
    expect(() => externalCodeReviewConfig(settings({ externalCodeReviewEnabled: false }))).toThrow(
      /disabled/i
    );
    expect(() => externalCodeReviewConfig(settings({ coaiMcpExecutablePath: null }))).toThrow(
      /absolute MCP executable path/i
    );
    expect(externalCodeReviewConfigured(settings({ externalCodeReviewEnabled: false }))).toBe(false);
    expect(externalCodeReviewConfigured(settings())).toBe(true);
  });

  it('keeps the plan gate\u2019s argument and path rules rather than restating them', () => {
    // A credential passed as an MCP argument, and a relative executable. Both
    // are the plan gate's existing refusals, reused so the two integrations
    // cannot drift into different ideas of a safe process configuration.
    expect(() =>
      externalCodeReviewConfig(settings({ coaiMcpArguments: ['--token=abcd1234'] }))
    ).toThrow();
    expect(() =>
      externalCodeReviewConfig(settings({ coaiMcpExecutablePath: 'coai-mcp.exe' }))
    ).toThrow(/absolute path/i);
  });
});

describe('the code reviewer the app actually runs', () => {
  it('refuses everything while the integration is switched off', async () => {
    const client = new CountingClient();
    const reviewer = new SettingsBoundCodeReviewer({
      settings: () => settings({ externalCodeReviewEnabled: false }),
      client
    });

    const availability = await reviewer.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/not enabled/i);

    await expect(reviewer.beginRound(subject, 'local-round-1')).rejects.toMatchObject({
      code: 'TOOL_MISSING'
    });
    await expect(reviewer.reviewCode(locator, subject, 'scope')).rejects.toMatchObject({
      code: 'TOOL_MISSING'
    });

    // Nothing was spawned, discovered or called to learn any of that.
    expect(client.discoveries).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('reads a lost round back as unknown rather than throwing at recovery', async () => {
    const reviewer = new SettingsBoundCodeReviewer({
      settings: () => settings({ externalCodeReviewEnabled: false }),
      client: new CountingClient()
    });

    // Recovery runs against a round dispatched by a build that may since have
    // been reconfigured. `unknown` is the honest answer; an exception here would
    // make an unresolved round unresolvable.
    const status = await reviewer.roundStatus(locator, subject);
    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.reason).toMatch(/not configured/i);
  });

  it('reports the installed legacy server as unsupported, without calling a tool', async () => {
    const client = new CountingClient();
    client.tools = COAI_PLAN_PROFILE;
    const reviewer = new SettingsBoundCodeReviewer({ settings: () => settings(), client });

    const availability = await reviewer.availability();

    // The refusal that `CodeReviewService` asks for BEFORE it writes durable
    // intent: a local incompatibility is known without anything external
    // happening, so no round row is left behind to reconcile.
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/addressable code review is not supported/i);
    expect(client.calls).toEqual([]);
  });

  it('never claims to read a dirty worktree, whatever is configured', () => {
    for (const value of [true, false]) {
      const reviewer = new SettingsBoundCodeReviewer({
        settings: () => settings({ externalCodeReviewEnabled: value }),
        client: new CountingClient()
      });

      // The service asks this to decide whether a subject holding uncommitted or
      // untracked work may be dispatched at all. It must not depend on whether a
      // provider happens to be reachable this second.
      expect(reviewer.readsUncommittedWorktreeState).toBe(false);
      // And the identity a round is filed under survives being switched off, or
      // every outstanding round would be stranded by a settings change.
      expect(reviewer.providerId).toBe(COAI_PROVIDER_ID);
    }
  });

  it('picks up a settings change on the next call rather than the next restart', async () => {
    let enabled = false;
    const client = new CountingClient();
    const reviewer = new SettingsBoundCodeReviewer({
      settings: () => settings({ externalCodeReviewEnabled: enabled }),
      client
    });

    expect((await reviewer.availability()).available).toBe(false);
    enabled = true;
    expect((await reviewer.availability()).available).toBe(true);
    enabled = false;
    expect((await reviewer.availability()).available).toBe(false);
  });
});

describe('the profile both gates are configured with', () => {
  it('is the seven-tool one while code review is off', () => {
    const off = settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: false });

    expect(externalPlanReviewConfig(off).allowedTools).toEqual(COAI_PLAN_PROFILE);
    expect(externalPlanReviewConfig(off).allowedTools).toHaveLength(7);
    // And code review is simply not configurable then.
    expect(() => externalCodeReviewConfig(off)).toThrow(/disabled/i);
  });

  it('is the ten-tool one for BOTH gates once code review is on', () => {
    // The defect this pins: the plan gate used to hardcode seven, so enabling
    // code review pointed the two gates at one server with two different exact
    // tool lists — and the transport, which compares exactly, would refuse the
    // plan gate against the very server that supports both.
    const on = settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: true });

    const plan = externalPlanReviewConfig(on);
    const code = externalCodeReviewConfig(on);

    expect(plan.allowedTools).toEqual(COAI_ADDRESSABLE_PROFILE);
    expect(code.allowedTools).toEqual(COAI_ADDRESSABLE_PROFILE);
    expect(plan.allowedTools).toEqual(code.allowedTools);
    // One server: same executable, same argv, same working directory.
    expect(plan.executablePath).toBe(code.executablePath);
    expect(plan.args).toEqual(code.args);
  });

  it('produces a plan configuration the real plan adapter accepts', () => {
    // Through the PRODUCTION path, not a hand-built config: the adapter's own
    // profile check is what would reject a configuration built wrongly here.
    const client = new CountingClient();
    for (const enabled of [false, true]) {
      const config = externalPlanReviewConfig(
        settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: enabled })
      );

      expect(() => new CoaiPlanReviewer(client, config), String(enabled)).not.toThrow();
    }
  });

  it('still fails closed on a profile nobody audited', () => {
    // The fix must not have become "accept whatever is configured". A list that
    // is neither audited profile is refused exactly as before.
    const client = new CountingClient();
    const config = externalPlanReviewConfig(settings({ externalPlanReviewEnabled: true }));

    expect(
      () => new CoaiPlanReviewer(client, { ...config, allowedTools: [...COAI_PLAN_PROFILE, 'extra'] })
    ).toThrow(/audited profiles/i);
    expect(
      () => new CoaiPlanReviewer(client, { ...config, allowedTools: COAI_PLAN_PROFILE.slice(0, 6) })
    ).toThrow(/audited profiles/i);
  });
});
