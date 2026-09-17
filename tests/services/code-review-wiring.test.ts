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
  COAI_CODE_REVIEW_TOOLS,
  COAI_PLAN_PROFILE,
  COAI_PLAN_REVIEW_TOOLS,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import {
  externalCodeReviewConfig,
  externalCodeReviewConfigured
} from '../../src/main/services/code-review-configuration';
import { CoaiPlanReviewer } from '../../src/main/adapters/mcp/coai-plan-reviewer';
import {
  COAI_MCP_CAPACITY,
  COAI_MCP_TIMEOUT_MAX_MS,
  externalPlanReviewConfig
} from '../../src/main/services/plan-review-configuration';
import { defaultSettings } from '../../src/main/container';
import { SettingsBoundCodeReviewer } from '../../src/main/services/code-review-provider';
import type { Settings } from '../../src/shared/domain/models';
import type {
  ExternalCodeReviewSubject,
  ExternalCodeRoundIdentity,
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

const locator: ExternalCodeRoundIdentity = {
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
      })),
      contractFingerprint: 'a'.repeat(64)
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
  it('pins the audited Coai 0.22 plan profile by name', () => {
    expect(COAI_PLAN_PROFILE).toEqual([
      'providers',
      'open',
      'review_plan',
      'review_code',
      'review_document',
      'consult',
      'resolve',
      'status',
      'ask_human'
    ]);
  });

  it('pins the exact three addressable tools from the main process, and nothing about the plan profile', () => {
    const config = externalCodeReviewConfig(settings());

    expect(config.allowedTools).toEqual(COAI_CODE_REVIEW_TOOLS);
    expect(config.allowedTools).toHaveLength(3);
    // Code review needs only the round lifecycle — none of the nine plan
    // tools are required for it to be considered available.
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

  it('reports the installed plan-only server as unsupported, without calling a tool', async () => {
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

describe('the two gates negotiate their own tool requirements, independently', () => {
  it('the plan gate always declares its own four tools, whatever code review is set to', () => {
    for (const codeReviewEnabled of [false, true]) {
      const value = settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: codeReviewEnabled });
      expect(externalPlanReviewConfig(value).allowedTools, String(codeReviewEnabled)).toEqual(
        COAI_PLAN_REVIEW_TOOLS
      );
    }
  });

  it('the code gate always declares its own three tools, whatever plan review is set to', () => {
    for (const planReviewEnabled of [false, true]) {
      const value = settings({
        externalPlanReviewEnabled: planReviewEnabled,
        externalCodeReviewEnabled: true
      });
      expect(externalCodeReviewConfig(value).allowedTools, String(planReviewEnabled)).toEqual(
        COAI_CODE_REVIEW_TOOLS
      );
    }
  });

  it('this is the actual defect fix: enabling code review no longer changes what the plan gate declares', () => {
    // Before this change, `coaiToolProfile` picked ONE tool list for the whole
    // MCP connection from `externalCodeReviewEnabled` alone, so turning code
    // review on silently widened the PLAN gate's own declared requirement too
    // — breaking plan review against the real, published, plan-only server the
    // moment code review was also switched on. The two configs below must now
    // be identical in every field except `id` and `allowedTools`, and
    // `allowedTools` must be unaffected by the other gate's checkbox.
    const off = externalPlanReviewConfig(
      settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: false })
    );
    const on = externalPlanReviewConfig(
      settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: true })
    );

    expect(off.allowedTools).toEqual(on.allowedTools);
    expect(off.allowedTools).toEqual(COAI_PLAN_REVIEW_TOOLS);
  });

  it('produces a plan configuration the real plan adapter accepts', () => {
    // Through the PRODUCTION path, not a hand-built config: the adapter's own
    // sanity check is what would reject a configuration built wrongly here.
    const client = new CountingClient();
    for (const enabled of [false, true]) {
      const config = externalPlanReviewConfig(
        settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled: enabled })
      );

      expect(() => new CoaiPlanReviewer(client, config), String(enabled)).not.toThrow();
    }
  });

  it('still fails closed on a local declaration that is not exactly its four tools', () => {
    // The fix must not have become "accept whatever is configured locally".
    // This is a LOCAL sanity check on CoaiPlanReviewer's own construction, not
    // a statement about what the real server may additionally advertise.
    const client = new CountingClient();
    const config = externalPlanReviewConfig(settings({ externalPlanReviewEnabled: true }));

    expect(
      () => new CoaiPlanReviewer(client, { ...config, allowedTools: [...COAI_PLAN_REVIEW_TOOLS, 'extra'] })
    ).toThrow(/exactly its four tools/i);
    expect(
      () => new CoaiPlanReviewer(client, { ...config, allowedTools: COAI_PLAN_REVIEW_TOOLS.slice(0, 2) })
    ).toThrow(/exactly its four tools/i);
  });
});

describe('the two gates describe one server', () => {
  /**
   * The transport limits used to be written out twice, once per configuration
   * builder. Both describe the SAME server process reached over the same stdio
   * transport, so a limit raised in one and not the other is not a policy — it
   * is drift, and it would show up as one gate refusing a message the other
   * accepts from the one server they share.
   */
  it('shares executable, argv, working directory and capacity — but NOT the tool requirement', () => {
    const value = settings({
      externalPlanReviewEnabled: true,
      externalCodeReviewEnabled: true,
      coaiMcpWorkingDirectory: 'C:/work',
      processTimeoutMs: 90 * 60_000
    });

    const plan = externalPlanReviewConfig(value);
    const code = externalCodeReviewConfig(value);

    // They differ in exactly two fields, and both are ones they are entitled
    // to differ in: the id their transport is filed under, and the tools each
    // one requires — independent capability negotiation is the whole point.
    expect(plan.id).toBe('coai-plan-review');
    expect(code.id).toBe('coai-code-review');
    expect({ ...code, id: plan.id, allowedTools: plan.allowedTools }).toEqual(plan);
    expect(plan.allowedTools).toEqual(COAI_PLAN_REVIEW_TOOLS);
    expect(code.allowedTools).toEqual(COAI_CODE_REVIEW_TOOLS);

    // The capacity is the shared constant rather than a repeated literal, so a
    // change to it cannot reach one gate and miss the other.
    for (const config of [plan, code]) {
      expect(config.maxMessageBytes).toBe(COAI_MCP_CAPACITY.maxMessageBytes);
      expect(config.maxContentBytes).toBe(COAI_MCP_CAPACITY.maxContentBytes);
      expect(config.maxContentBlocks).toBe(COAI_MCP_CAPACITY.maxContentBlocks);
      expect(config.timeoutMs).toBe(COAI_MCP_TIMEOUT_MAX_MS);
      expect(config.executablePath).toBe(value.coaiMcpExecutablePath);
      expect(config.args).toEqual(value.coaiMcpArguments);
      expect(config.cwd).toBe('C:/work');
    }
  });

  it('the plan gate declares the same four tools whether code review is off or on', () => {
    for (const externalCodeReviewEnabled of [false, true]) {
      const plan = externalPlanReviewConfig(
        settings({ externalPlanReviewEnabled: true, externalCodeReviewEnabled })
      );

      expect(plan.allowedTools, String(externalCodeReviewEnabled)).toEqual(COAI_PLAN_REVIEW_TOOLS);
      expect(plan.maxContentBlocks).toBe(COAI_MCP_CAPACITY.maxContentBlocks);
    }
  });

  it('omits the working directory when none is configured', () => {
    const value = settings({
      externalPlanReviewEnabled: true,
      coaiMcpWorkingDirectory: null
    });

    expect(externalPlanReviewConfig(value).cwd).toBeUndefined();
    expect(externalCodeReviewConfig(value).cwd).toBeUndefined();
  });
});
