/**
 * Read-only Coai connection diagnostic for Settings.
 *
 * One `discover()` probe, declaring NO required tools at all (an empty
 * `allowedTools`) — the transport's required-subset check trivially passes
 * with nothing required, so this call succeeds against any well-formed
 * server, however small or large its tool list, and only fails if the
 * server's own `tools/list` contradicts itself (a duplicate name). The raw
 * discovered names are then classified locally, all four capabilities at
 * once, by `detectCoaiCapabilities` (adapters/mcp/coai-profiles.ts) — the
 * SAME pure function the rest of this integration is built on, so this
 * diagnostic cannot drift from what the real adapters would decide from the
 * same server. It is advisory display, never a second source of truth for a
 * review's own evidence (plan-review and code-review each bind their OWN
 * fingerprint from the discovery their actual operation made, never this
 * one) — and it never calls a mutating tool.
 *
 * It does write one thing: on every successful probe, the freshly proved
 * contract fingerprint (`computeCoaiContractFingerprint`, scoped to every
 * tool this build knows the server advertises) is recorded to Settings as
 * `coaiLastKnownContractFingerprint`. That is what lets a check compare
 * against the last one this build ever durably confirmed — across a restart,
 * not merely within one Settings mount's in-memory state.
 *
 * Bounded by its own short probe timeout rather than
 * `settings.processTimeoutMs` (sized for a real review round, up to thirty
 * minutes) — a "Test connection" button must not hang for that long against a
 * server that never answers.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type { CoaiConnectionDiagnostic } from '../../shared/domain/coai-diagnostics';
import { unconfiguredCoaiDiagnostic } from '../../shared/domain/coai-diagnostics';
import { redactAndTruncate } from '../../shared/util/redact';
import { unsafeProviderIdentity } from '../../shared/util/provider-text';
import {
  COAI_CODE_REVIEW_TOOLS,
  COAI_KNOWN_TOOLS,
  computeCoaiContractFingerprint,
  detectCoaiCapabilities
} from '../adapters/mcp/coai-profiles';
import { McpToolProfileMismatchError } from '../adapters/mcp/stdio-mcp-client';
import type { ExternalMcpClient, SettingsRepository } from '../ports';
import { coaiServerConfig } from './plan-review-configuration';

/** A quick connectivity check, not a review round — bounded far below the operational timeout. */
const PROBE_TIMEOUT_MS = 20_000;
const DETAIL_LIMIT = 800;
const availableOf = (ok: boolean): 'available' | 'unavailable' => (ok ? 'available' : 'unavailable');

export interface CoaiCapabilityDeps {
  /**
   * The full repository, not a `() => Settings` read closure: a successful
   * probe durably records the fresh fingerprint as the new "last known" one
   * (see `check()`), so a later probe — in this session or a future one, after
   * a full restart — has something on disk to compare against. An in-memory
   * value scoped to one Settings mount cannot answer "did the server's
   * contract change while the app was closed".
   */
  readonly settings: SettingsRepository;
  readonly client: ExternalMcpClient;
}

export class CoaiCapabilityService {
  constructor(private readonly deps: CoaiCapabilityDeps) {}

  async check(signal?: AbortSignal): Promise<CoaiConnectionDiagnostic> {
    const settings = this.deps.settings.get();
    if (settings.coaiMcpExecutablePath === null) {
      return unconfiguredCoaiDiagnostic('No Coai MCP executable is configured.');
    }

    // Reads exactly `coaiMcpExecutablePath` (the null-check above), plus
    // `coaiMcpArguments`/`coaiMcpWorkingDirectory`/`processTimeoutMs` through
    // `coaiServerConfig` below — see `COAI_CONNECTION_PROBE_SETTINGS_KEYS` in
    // shared/domain/coai-diagnostics.ts, the single list this function and
    // the renderer's "Recheck connection" dirty-check both answer to.
    const probeConfig = {
      // No required tools: this call exists to learn what the server has, not
      // to gate on any one operation. coaiServerConfig assembles the shared
      // executable/argv/cwd/capacity fields; allowedTools: [] overrides its
      // placeholder value.
      ...coaiServerConfig(settings, 'coai-capability-check', settings.coaiMcpExecutablePath, []),
      timeoutMs: Math.min(settings.processTimeoutMs, PROBE_TIMEOUT_MS)
    };

    try {
      const discovery = await this.deps.client.discover(probeConfig, signal);
      const toolNames = discovery.tools.map((tool) => tool.name);
      const detected = detectCoaiCapabilities(toolNames);
      const missingForCodeReview = COAI_CODE_REVIEW_TOOLS.filter((name) => !toolNames.includes(name));
      const serverName = safeIdentity(discovery.server.name);
      const serverVersion = safeIdentity(discovery.server.version);
      const fresh =
        serverName !== null && serverVersion !== null
          ? computeCoaiContractFingerprint({
              protocolVersion: discovery.server.protocolVersion,
              serverName,
              serverVersion,
              tools: discovery.tools,
              // Every known tool this server actually advertises, not merely
              // the ones some ONE operation requires: this is a connection
              // diagnostic covering all four capabilities at once, and a
              // schema change to any tool this build knows about is exactly
              // what it exists to surface.
              requiredToolNames: COAI_KNOWN_TOOLS.filter((name) => toolNames.includes(name))
            })
          : null;
      const previous = settings.coaiLastKnownContractFingerprint;
      const contractChangedSinceLastKnown = fresh !== null && previous !== null && previous !== fresh;

      if (fresh !== null) {
        // Recorded unconditionally on every successful probe, including one
        // that found no change: "last known" means the last contract this
        // build actually proved, not the last one that happened to differ.
        this.deps.settings.update({
          coaiLastKnownContractFingerprint: fresh,
          coaiLastKnownContractCheckedAt: new Date().toISOString()
        });
      }

      return {
        serverReached: true,
        serverName,
        serverVersion,
        planReview: availableOf(detected.planReview),
        humanEscalation: availableOf(detected.humanEscalation),
        codeReview: availableOf(detected.codeReview),
        reconciliation: availableOf(detected.reconciliation),
        missingForCodeReview,
        unknownToolCount: detected.unknownToolCount,
        capabilityFingerprint: fresh,
        contractChangedSinceLastKnown,
        detail: describeDetected(detected, missingForCodeReview, contractChangedSinceLastKnown),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return this.unavailable(error);
    }
  }

  private unavailable(error: unknown): CoaiConnectionDiagnostic {
    if (error instanceof McpToolProfileMismatchError) {
      // Only reachable for `duplicated` now: an empty required set can never
      // be reported missing. A self-contradictory tools/list is not evidence
      // about any specific capability, so every one is reported unavailable.
      const serverName = safeIdentity(error.server.name);
      const serverVersion = safeIdentity(error.server.version);

      return {
        serverReached: true,
        serverName,
        serverVersion,
        planReview: 'unavailable',
        humanEscalation: 'unavailable',
        codeReview: 'unavailable',
        reconciliation: 'unavailable',
        missingForCodeReview: [...COAI_CODE_REVIEW_TOOLS],
        unknownToolCount: 0,
        capabilityFingerprint: null,
        // No fresh contract was proved, so there is nothing to compare
        // against the durable last-known value — this is not evidence either
        // way, not a report that nothing changed.
        contractChangedSinceLastKnown: false,
        detail: redactAndTruncate(
          'The server advertised a duplicate tool name, so nothing in its tool list can be trusted.',
          DETAIL_LIMIT
        ),
        checkedAt: new Date().toISOString()
      };
    }

    const code = error instanceof AgentRelayError ? error.code : 'UNKNOWN';

    return unconfiguredCoaiDiagnostic(
      redactAndTruncate(
        `The Coai server could not be reached (${code}). See the application log for detail, which is not repeated here because it can carry a path or a command line.`,
        DETAIL_LIMIT
      )
    );
  }
}

function describeDetected(
  detected: ReturnType<typeof detectCoaiCapabilities>,
  missingForCodeReview: readonly string[],
  contractChangedSinceLastKnown: boolean
): string {
  const parts: string[] = [];
  parts.push(detected.planReview ? 'Plan review is available.' : 'Plan review is unavailable.');
  parts.push(
    detected.codeReview
      ? 'Durable code review is available.'
      : missingForCodeReview.length > 0
        ? `Durable code review is unavailable: missing ${missingForCodeReview.join(', ')}.`
        : 'Durable code review is unavailable.'
  );
  parts.push(detected.humanEscalation ? 'Human escalation is available.' : 'Human escalation is unavailable.');
  if (detected.unknownToolCount > 0) {
    parts.push(
      `The server also advertises ${detected.unknownToolCount} tool(s) outside every name this build knows; none of them are ever called.`
    );
  }
  if (contractChangedSinceLastKnown) {
    parts.push(
      'This server’s contract differs from the last one this build recorded — a name, a version, or a tool’s input schema has changed since the last successful check.'
    );
  }
  return parts.join(' ');
}

function safeIdentity(value: string): string | null {
  return unsafeProviderIdentity(value) === null ? value : null;
}
