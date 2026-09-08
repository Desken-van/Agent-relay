/** Validate and translate persisted, non-secret external code-review settings. */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Settings } from '../../shared/domain/models';
import type { ExternalMcpServerConfig } from '../ports';
import { assertExternalPlanReviewSettings, coaiToolProfile } from './plan-review-configuration';

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

  return {
    id: 'coai-code-review',
    enabled: true,
    executablePath: settings.coaiMcpExecutablePath,
    args: settings.coaiMcpArguments,
    ...(settings.coaiMcpWorkingDirectory === null
      ? {}
      : { cwd: settings.coaiMcpWorkingDirectory }),
    // The exact audited profile, and the SAME one the plan gate uses whenever
    // code review is enabled — one server, one tool list, so neither gate can
    // be configured into refusing the server the other is talking to. The
    // transport compares it exactly, so a legacy seven-tool server cannot be
    // talked to at all, which is the honest outcome rather than a degraded one.
    allowedTools: coaiToolProfile(settings),
    timeoutMs: settings.processTimeoutMs,
    maxMessageBytes: 2 * 1024 * 1024,
    maxContentBytes: 2 * 1024 * 1024,
    maxContentBlocks: 128
  };
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
