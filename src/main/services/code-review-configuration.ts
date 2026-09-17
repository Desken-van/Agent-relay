/** Validate and translate persisted, non-secret external code-review settings. */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Settings } from '../../shared/domain/models';
import type { ExternalMcpServerConfig } from '../ports';
import { COAI_CODE_REVIEW_TOOLS } from '../adapters/mcp/coai-profiles';
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
  // argv, one transport capacity. The tool requirement is NOT shared with the
  // plan gate's own setting, on purpose — code review always declares only the
  // three addressable round tools it needs, independent of whether plan
  // review happens to be enabled too, and independent of anything else the
  // server also advertises. A server that does not have all three cannot be
  // used for code review at all (required, not exact — see
  // coai-profiles.ts): that is the honest outcome rather than a degraded one.
  return coaiServerConfig(
    settings,
    'coai-code-review',
    settings.coaiMcpExecutablePath,
    COAI_CODE_REVIEW_TOOLS
  );
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
