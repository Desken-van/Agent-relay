import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/container';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_PLAN_PROFILE
} from '../../src/main/adapters/mcp/coai-profiles';
import { McpToolProfileMismatchError } from '../../src/main/adapters/mcp/stdio-mcp-client';
import { CoaiCapabilityService } from '../../src/main/services/coai-capability-service';
import { AgentRelayError } from '../../src/shared/domain/errors';
import type { Settings } from '../../src/shared/domain/models';
import { COAI_CONNECTION_PROBE_SETTINGS_KEYS } from '../../src/shared/domain/coai-diagnostics';
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpTool,
  SettingsRepository
} from '../../src/main/ports';

/** A fixed, valid-shaped contract fingerprint for the transport's own discovery — the service computes its own from `discovery.tools`, so this value is never asserted on. */
const DISCOVERY_FINGERPRINT = 'a'.repeat(64);

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...defaultSettings({ dataDir: 'C:/user-data', documentsDir: 'C:/documents' }),
    coaiMcpExecutablePath: 'C:\\tools\\coai-mcp.exe',
    coaiMcpArguments: ['--stdio'],
    ...overrides
  };
}

/** An in-memory stand-in for the durable settings table, so `check()`'s recorded "last known" fingerprint survives across calls exactly as the real repository would. */
class FakeSettingsRepository implements SettingsRepository {
  private current: Settings;
  constructor(initial: Settings) {
    this.current = initial;
  }
  get(): Settings {
    return this.current;
  }
  update(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch };
    return this.current;
  }
}

function settingsRepo(overrides: Partial<Settings> = {}): SettingsRepository {
  return new FakeSettingsRepository(settings(overrides));
}

function tool(name: string): ExternalMcpTool {
  return {
    name,
    title: null,
    description: null,
    inputSchema: { type: 'object' },
    annotations: { readOnly: null, destructive: null, idempotent: null, openWorld: null }
  };
}

const SERVER = { name: 'coai-mcp', version: '0.24.0', protocolVersion: '2024-11-05' };

class FakeClient implements ExternalMcpClient {
  toolNames: readonly string[] = COAI_ADDRESSABLE_PROFILE;
  server = SERVER;
  discoveryError: unknown = null;
  readonly discoverCalls: ExternalMcpServerConfig[] = [];

  async discover(config: ExternalMcpServerConfig): Promise<ExternalMcpDiscovery> {
    this.discoverCalls.push(config);
    if (this.discoveryError) throw this.discoveryError;
    return {
      server: this.server,
      tools: this.toolNames.map(tool),
      contractFingerprint: DISCOVERY_FINGERPRINT
    };
  }

  async call(): Promise<ExternalMcpCallResult> {
    throw new Error('the capability service must never call a tool');
  }
}

describe('CoaiCapabilityService.check', () => {
  it('reports unconfigured when no executable is set, without touching the client', async () => {
    const client = new FakeClient();
    const service = new CoaiCapabilityService({ settings: settingsRepo({ coaiMcpExecutablePath: null }), client });

    const diagnostic = await service.check();

    expect(diagnostic.serverReached).toBe(false);
    expect(diagnostic.planReview).toBe('unavailable');
    expect(diagnostic.codeReview).toBe('unavailable');
    expect(diagnostic.detail).toMatch(/no coai mcp executable/i);
  });

  it('the published nine-tool server: plan and human escalation and reconciliation available, code review not', async () => {
    const client = new FakeClient();
    client.toolNames = COAI_PLAN_PROFILE;
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.serverReached).toBe(true);
    expect(diagnostic.serverName).toBe('coai-mcp');
    expect(diagnostic.serverVersion).toBe('0.24.0');
    expect(diagnostic.planReview).toBe('available');
    expect(diagnostic.humanEscalation).toBe('available');
    expect(diagnostic.reconciliation).toBe('available');
    expect(diagnostic.codeReview).toBe('unavailable');
    expect(diagnostic.missingForCodeReview).toEqual(['reserve_round', 'run_round', 'round_status']);
  });

  it('the addressable twelve-tool server: everything available', async () => {
    const client = new FakeClient();
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.planReview).toBe('available');
    expect(diagnostic.codeReview).toBe('available');
    expect(diagnostic.missingForCodeReview).toEqual([]);
  });

  it('missing review_plan: plan review unavailable even though everything else is present', async () => {
    const client = new FakeClient();
    client.toolNames = COAI_ADDRESSABLE_PROFILE.filter((name) => name !== 'review_plan');
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.planReview).toBe('unavailable');
    expect(diagnostic.codeReview).toBe('available');
  });

  it('missing exactly one addressable tool: plan still works, code review names what is missing', async () => {
    const client = new FakeClient();
    client.toolNames = COAI_ADDRESSABLE_PROFILE.filter((name) => name !== 'round_status');
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.planReview).toBe('available');
    expect(diagnostic.codeReview).toBe('unavailable');
    expect(diagnostic.missingForCodeReview).toEqual(['round_status']);
  });

  it('an unknown extra tool never disables a compatible operation, and is counted, not named', async () => {
    const client = new FakeClient();
    client.toolNames = [...COAI_ADDRESSABLE_PROFILE, 'C:\\evil\\path'];
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.planReview).toBe('available');
    expect(diagnostic.codeReview).toBe('available');
    expect(diagnostic.unknownToolCount).toBe(1);
    expect(diagnostic.detail).not.toContain('C:\\evil\\path');
  });

  it('a duplicated tool name disables every capability and says so, without repeating server text', async () => {
    const client = new FakeClient();
    client.discoveryError = new McpToolProfileMismatchError(
      'PARSE_FAILED',
      'The MCP server advertised a duplicate tool name.',
      { missing: [], unexpectedCount: 0, duplicated: true, server: SERVER }
    );
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.serverReached).toBe(true);
    expect(diagnostic.serverName).toBe('coai-mcp');
    expect(diagnostic.planReview).toBe('unavailable');
    expect(diagnostic.codeReview).toBe('unavailable');
    expect(diagnostic.humanEscalation).toBe('unavailable');
    expect(diagnostic.reconciliation).toBe('unavailable');
    expect(diagnostic.detail).toMatch(/duplicate tool name/i);
  });

  it('a spawn/transport failure is reported without a path, argv or secret', async () => {
    const client = new FakeClient();
    client.discoveryError = new AgentRelayError(
      'TOOL_FAILED',
      'The MCP server process ended before the request completed.',
      { details: 'C:\\Program Files\\coai\\coai-mcp.exe --stdio --token=ghp_A1b2C3d4E5f6G7h8I9j0' }
    );
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    expect(diagnostic.serverReached).toBe(false);
    expect(diagnostic.detail).toContain('TOOL_FAILED');
    for (const leak of ['C:\\Program Files', 'coai-mcp.exe', '--stdio', 'ghp_A1b2C3d4E5f6G7h8I9j0']) {
      expect(diagnostic.detail, leak).not.toContain(leak);
    }
  });

  it('scans server identity for safety before displaying it, independent of capability detection', async () => {
    const client = new FakeClient();
    client.server = { name: 'coai-mcp ghp_A1b2C3d4E5f6G7h8I9j0', version: '0.24.0', protocolVersion: '2024-11-05' };
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    const diagnostic = await service.check();

    // The identity is unsafe to show, but the tool-name-based capability
    // detection is unaffected by anything in the server's self-reported name.
    expect(diagnostic.serverName).toBeNull();
    expect(diagnostic.planReview).toBe('available');
    expect(diagnostic.codeReview).toBe('available');
    expect(JSON.stringify(diagnostic)).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0');
  });

  it('produces a stable fingerprint for an unchanged server, and a different one when capabilities change', async () => {
    const stable = new FakeClient();
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client: stable });
    const first = await service.check();
    const second = await service.check();
    expect(first.capabilityFingerprint).not.toBeNull();
    expect(first.capabilityFingerprint).toBe(second.capabilityFingerprint);

    const shrunk = new FakeClient();
    shrunk.toolNames = COAI_PLAN_PROFILE;
    const afterUpgradeLoss = await new CoaiCapabilityService({ settings: settingsRepo(), client: shrunk }).check();
    expect(afterUpgradeLoss.capabilityFingerprint).not.toBe(first.capabilityFingerprint);
  });

  it('detects a contract change across a fresh service instance sharing the same durable settings, not merely within one session', async () => {
    // One durable settings store, as a fresh application session would find
    // it on disk — reused across two independently constructed services, so
    // nothing in-memory can be carrying the comparison between them.
    const repo = settingsRepo();
    const first = await new CoaiCapabilityService({ settings: repo, client: new FakeClient() }).check();
    // Nothing durable existed before this check, so there is nothing to
    // report as changed yet — but the reading is now recorded.
    expect(first.contractChangedSinceLastKnown).toBe(false);
    expect(repo.get().coaiLastKnownContractFingerprint).toBe(first.capabilityFingerprint);

    const shrunkClient = new FakeClient();
    shrunkClient.toolNames = COAI_PLAN_PROFILE;
    const second = await new CoaiCapabilityService({ settings: repo, client: shrunkClient }).check();

    expect(second.contractChangedSinceLastKnown).toBe(true);
    expect(second.capabilityFingerprint).not.toBe(first.capabilityFingerprint);
    // The durable value moves on to the freshly proven contract.
    expect(repo.get().coaiLastKnownContractFingerprint).toBe(second.capabilityFingerprint);
  });

  it('does not claim a contract change when a fresh instance reads an unchanged server', async () => {
    const repo = settingsRepo();
    await new CoaiCapabilityService({ settings: repo, client: new FakeClient() }).check();

    const second = await new CoaiCapabilityService({ settings: repo, client: new FakeClient() }).check();

    expect(second.contractChangedSinceLastKnown).toBe(false);
  });

  it('does not touch the durable last-known fingerprint when a probe fails', async () => {
    const repo = settingsRepo();
    await new CoaiCapabilityService({ settings: repo, client: new FakeClient() }).check();
    const known = repo.get().coaiLastKnownContractFingerprint;
    expect(known).not.toBeNull();

    const failing = new FakeClient();
    failing.discoveryError = new AgentRelayError('TOOL_FAILED', 'The MCP server process ended.');
    const failed = await new CoaiCapabilityService({ settings: repo, client: failing }).check();

    expect(failed.serverReached).toBe(false);
    expect(failed.contractChangedSinceLastKnown).toBe(false);
    // A failed probe proved nothing about the contract, so it must not
    // overwrite the last reading that WAS proven.
    expect(repo.get().coaiLastKnownContractFingerprint).toBe(known);
  });

  it('never calls a tool — discovery only', async () => {
    const client = new FakeClient();
    const service = new CoaiCapabilityService({ settings: settingsRepo(), client });

    await service.check();
    // FakeClient.call() throws unconditionally; check() completing without
    // throwing proves call() was never invoked.
  });

  /**
   * A minimal, type-preserving mutation of a settings value, used only to
   * prove whether varying ONE field moves the probe's actual process config.
   * Never asserted to be a "realistic" value — only that it differs from
   * whatever was there, so a field this test forgot to vary can never pass by
   * accident.
   */
  function differentValue(key: keyof Settings, value: unknown): unknown {
    // `check()` clamps `processTimeoutMs` to its own short probe ceiling
    // (`PROBE_TIMEOUT_MS`, 20s) — the default settings value sits far above
    // that ceiling, so a generic `+1` would be clamped away on both sides and
    // this key would wrongly look irrelevant. A value BELOW the ceiling
    // proves the field is read without needing to know the ceiling's exact
    // number.
    if (key === 'processTimeoutMs') return 5_000;
    if (typeof value === 'string') return `${value}-changed`;
    if (value === null) return 'changed-from-null';
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (Array.isArray(value)) return [...value, 'changed-extra'];
    return value;
  }

  it('changes the constructed probe process exactly for the keys COAI_CONNECTION_PROBE_SETTINGS_KEYS names, and for no others', async () => {
    // This is the enforcement for the shared list itself: every key here
    // that is NOT in COAI_CONNECTION_PROBE_SETTINGS_KEYS must leave the
    // spawned process identical, and every key that IS in it must change
    // something about it — checked mechanically against every real `Settings`
    // key, not by re-describing the list a second time.
    const baseline = settings();
    const baselineClient = new FakeClient();
    await new CoaiCapabilityService({ settings: settingsRepo(baseline), client: baselineClient }).check();
    const baselineConfig = baselineClient.discoverCalls[0];
    expect(baselineConfig).toBeDefined();

    for (const key of Object.keys(baseline) as (keyof Settings)[]) {
      const mutated: Settings = { ...baseline, [key]: differentValue(key, baseline[key]) };
      const client = new FakeClient();
      await new CoaiCapabilityService({ settings: settingsRepo(mutated), client }).check();
      const config = client.discoverCalls[0];
      expect(config, key).toBeDefined();

      const isProbeRelevant = (COAI_CONNECTION_PROBE_SETTINGS_KEYS as readonly string[]).includes(key);
      if (isProbeRelevant) {
        expect(JSON.stringify(config), key).not.toBe(JSON.stringify(baselineConfig));
      } else {
        expect(JSON.stringify(config), key).toBe(JSON.stringify(baselineConfig));
      }
    }
  });
});
