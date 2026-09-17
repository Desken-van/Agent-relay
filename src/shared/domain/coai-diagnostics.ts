/**
 * Read-only Coai MCP connection diagnostic.
 *
 * Deliberately its own shape rather than a fifth/sixth entry in
 * `ToolDiagnostic`/`DiagnosticsReport` (diagnostics.ts): those model ONE
 * status enum per external tool, but Coai has four independent capabilities —
 * plan review, human escalation, durable code review, and reconciliation —
 * that are negotiated, and therefore reported, independently. Folding them
 * into one status would either lose which one is the problem or force a false
 * coupling back into the display, which is exactly the bug this integration
 * stage removes from the runtime behaviour.
 */

import type { Settings } from './models';

/**
 * Exactly the settings fields `CoaiCapabilityService.check()`'s probe
 * depends on — see `coaiServerConfig` in
 * main/services/plan-review-configuration.ts and `check()` itself in
 * main/services/coai-capability-service.ts: `coaiMcpExecutablePath` gates
 * whether the probe runs at all and supplies the executable, and
 * `coaiMcpArguments`/`coaiMcpWorkingDirectory`/`processTimeoutMs` shape the
 * process it spawns. Nothing else changes what the probe dials or how — in
 * particular, `externalPlanReviewEnabled`/`externalCodeReviewEnabled` gate
 * whether a REVIEW may run, not whether this diagnostic may, and the
 * `conventions*` fields feed plan-review prompt content, never the
 * connection.
 *
 * The renderer's "Recheck connection" dirty-check (SettingsView.tsx) reads
 * this SAME list to decide whether unsaved edits could make a check
 * misleadingly test the saved configuration instead of the draft. One
 * shared list, rather than a second one hand-maintained in the renderer, is
 * what keeps the two from drifting apart the way they already had once —
 * `coai-capability-service.test.ts` mechanically checks every `Settings` key
 * against this list, in both directions.
 */
export const COAI_CONNECTION_PROBE_SETTINGS_KEYS = [
  'coaiMcpExecutablePath',
  'coaiMcpArguments',
  'coaiMcpWorkingDirectory',
  'processTimeoutMs'
] as const satisfies readonly (keyof Settings)[];

export type CoaiCapabilityStatus = 'available' | 'unavailable';

export interface CoaiConnectionDiagnostic {
  /** Whether the configured executable was reached and completed the MCP handshake. */
  readonly serverReached: boolean;
  /**
   * Scanned with the same identity-safety check a completed review round is
   * held to (shared/util/provider-text.ts's `unsafeProviderIdentity`). Null
   * when the server was not reached, or when what it sent is not safe to show.
   */
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly planReview: CoaiCapabilityStatus;
  /** No Agent Relay adapter calls `ask_human` today; tracked for completeness. */
  readonly humanEscalation: CoaiCapabilityStatus;
  readonly codeReview: CoaiCapabilityStatus;
  readonly reconciliation: CoaiCapabilityStatus;
  /**
   * Which addressable (round-lifecycle) tools are absent, when code review is
   * unavailable. Always drawn from this build's own known tool names — never
   * a name the server sent.
   */
  readonly missingForCodeReview: readonly string[];
  /** How many tools beyond every name this build knows the server also advertises. Never callable, whatever this number is. */
  readonly unknownToolCount: number;
  /**
   * A deterministic, canonical fingerprint of the exact contract this check
   * discovered — server identity plus the input schema of every tool this
   * build knows about that the server advertises (`computeCoaiContractFingerprint`
   * in adapters/mcp/coai-profiles.ts). Never a secret, a path or
   * server-supplied prose. Two checks against an unchanged server always
   * produce the same value, independent of object-key or tool-listing order;
   * a changed value means the server's name, version, or a known tool's
   * schema is different from what this check just read — not necessarily
   * from what a PRIOR check read, which is what {@link contractChangedSinceLastKnown}
   * answers instead.
   */
  readonly capabilityFingerprint: string | null;
  /**
   * Does this fingerprint differ from the last one this build durably
   * recorded (Settings' `coaiLastKnownContractFingerprint`), from any prior
   * session? False when this check found no durable prior value to compare
   * against, or when the probe itself did not succeed — neither is evidence
   * that nothing changed, only that there is nothing to report changing.
   */
  readonly contractChangedSinceLastKnown: boolean;
  /** Short, bounded, redacted summary. Never a path, an argv, or a secret. */
  readonly detail: string;
  readonly checkedAt: string;
}

export function unconfiguredCoaiDiagnostic(detail: string): CoaiConnectionDiagnostic {
  return {
    serverReached: false,
    serverName: null,
    serverVersion: null,
    planReview: 'unavailable',
    humanEscalation: 'unavailable',
    codeReview: 'unavailable',
    reconciliation: 'unavailable',
    missingForCodeReview: [],
    unknownToolCount: 0,
    capabilityFingerprint: null,
    contractChangedSinceLastKnown: false,
    detail,
    checkedAt: new Date().toISOString()
  };
}
