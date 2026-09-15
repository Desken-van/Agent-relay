/** Validate and translate persisted, non-secret external code-review settings. */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Settings } from '../../shared/domain/models';
import type { ExternalMcpServerConfig } from '../ports';
import { assertExternalPlanReviewSettings, coaiServerConfig } from './plan-review-configuration';

/**
 * The code reviewer's server configuration, built in the MAIN process only.
 *
 * Every field comes from persisted settings the settings screen validated, or
 * from a constant here. The renderer supplies none of it — not the executable,
 * not the argv, not the working directory, and above all not the tool list,
 * which is the whole capability boundary.
 *
 * The transport and argument checks are the plan gate's: the same executable,
 * the same argv rules, the same refusal of credential-shaped arguments. Only the
 * allowlist differs, and it differs on purpose — this profile is the one that
 * carries an addressable round.
 */
export function externalCodeReviewConfig(settings: Settings): ExternalMcpServerConfig {
  // The shared argument, path and credential-shape rules. Reused rather than
  // restated so the two integrations cannot drift into different ideas of what
  // a safe MCP argument is.
  assertExternalPlanReviewSettings(settings);
  if (!settings.externalCodeReviewEnabled) {
    throw new AgentRelayError('VALIDATION_FAILED', 'External code review is disabled.');
  }
  if (settings.coaiMcpExecutablePath === null) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'Enabled external code review requires an absolute MCP executable path.'
    );
  }

  // The same server as the plan gate, so the same builder: one executable, one
  // argv, one transport capacity, and the exact audited profile chosen by what
  // is enabled — so neither gate can be configured into refusing the server the
  // other is talking to. The transport compares that profile exactly, which is
  // why a plan-only nine-tool server cannot be talked to at all. That is the
  // honest outcome rather than a degraded one.
  return coaiServerConfig(settings, 'coai-code-review', settings.coaiMcpExecutablePath);
}

/** Is external code review switched on and configured well enough to try? */
export function externalCodeReviewConfigured(settings: Settings): boolean {
  try {
    externalCodeReviewConfig(settings);

    return true;
  } catch {
    return false;
  }
}
