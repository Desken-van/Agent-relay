/** Validate and translate persisted, non-secret external plan-review settings. */

import { isAbsolute, posix } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Settings } from '../../shared/domain/models';
import { containsSecretShape } from '../../shared/util/redact';
import type {
  ExternalMcpServerConfig,
  RuleEvidenceLimits,
  RuleEvidenceSourceRequest
} from '../ports';
import { COAI_ADDRESSABLE_PROFILE, COAI_PLAN_PROFILE } from '../adapters/mcp/coai-profiles';

export const TASK_RULE_EVIDENCE_LIMITS: RuleEvidenceLimits = {
  maxSources: 2,
  maxFiles: 128,
  maxDiscoveryEntries: 1_024,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1_500_000
};

function invalid(message: string): never {
  throw new AgentRelayError('VALIDATION_FAILED', message);
}

function assertCleanArgument(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    invalid('An MCP argument contains a control character.');
  }
  if (
    /^--?(?:[^=]*[-_])?(?:token|password|passwd|secret|api[-_]?key|credential)(?:=|$)/i.test(
      value
    )
  ) {
    invalid(
      'MCP arguments must not carry credential options. Authentication must stay with the MCP server.'
    );
  }
}

function assertAbsoluteCleanPath(value: string, label: string): void {
  // Paths are passed directly to filesystem/process APIs, never a shell. Still
  // reject control bytes up front so a dormant setting cannot become an unsafe
  // process configuration merely by enabling the integration later.
  // eslint-disable-next-line no-control-regex
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`${label} must be an absolute path without control characters.`);
  }
}

function assertRulePath(value: string): void {
  // The filesystem adapter repeats this check at use time. Validating here
  // keeps a malformed saved configuration from looking usable in Settings.
  if (
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../')
  ) {
    invalid('Convention rule paths must be clean repository-relative POSIX paths.');
  }
}

export function assertExternalPlanReviewSettings(settings: Settings): void {
  for (const argument of settings.coaiMcpArguments) assertCleanArgument(argument);
  for (const path of settings.conventionsRulePaths) assertRulePath(path);
  if (settings.coaiMcpExecutablePath !== null) {
    assertAbsoluteCleanPath(settings.coaiMcpExecutablePath, 'The MCP executable path');
  }
  if (settings.coaiMcpWorkingDirectory !== null) {
    assertAbsoluteCleanPath(settings.coaiMcpWorkingDirectory, 'The MCP working directory');
  }
  if (settings.conventionsRepositoryPath !== null) {
    assertAbsoluteCleanPath(settings.conventionsRepositoryPath, 'The conventions repository path');
  }
  if (containsSecretShape(JSON.stringify(settings.coaiMcpArguments))) {
    invalid(
      'MCP arguments contain credential-shaped text. Authentication must stay with the MCP server.'
    );
  }

  const conventionParts = [
    settings.conventionsRepositoryPath !== null,
    settings.conventionsExpectedRevision !== null,
    settings.conventionsRulePaths.length > 0
  ];
  if (conventionParts.some(Boolean) && !conventionParts.every(Boolean)) {
    invalid(
      'Conventions require a repository path, exact revision, and at least one selected rule file.'
    );
  }

  // Either integration needs the same server, so either one enabled makes the
  // executable required. Checking only the plan flag let a configuration be
  // saved with code review on and nothing to run it — a setting that reads as
  // enabled and refuses at the first call, with the reason buried in a provider
  // error rather than shown where it was set.
  if (!settings.externalPlanReviewEnabled && !settings.externalCodeReviewEnabled) return;
  if (settings.coaiMcpExecutablePath === null) {
    invalid(
      settings.externalPlanReviewEnabled
        ? 'Enabled external plan review requires an absolute MCP executable path.'
        : 'Enabled external code review requires an absolute MCP executable path.'
    );
  }
}

/**
 * Which exact tool profile this configuration talks to.
 *
 * One server serves both gates, so the profile is decided by what is switched
 * on rather than by which gate is asking. With code review off, that is the
 * seven plan tools; with it on, the ten. It is never a subset, a minimum or a
 * superset: the transport compares the server's list to this one exactly, and a
 * profile nobody audited fails closed either way.
 *
 * The alternative — pinning the plan gate to seven for ever — would refuse the
 * addressable server outright, so enabling code review would silently break
 * plan review against the very server that supports both.
 */
export function coaiToolProfile(settings: Settings): readonly string[] {
  return settings.externalCodeReviewEnabled ? COAI_ADDRESSABLE_PROFILE : COAI_PLAN_PROFILE;
}

/**
 * The transport capacity both gates run under, stated once.
 *
 * The two configurations describe the SAME server process reached over the same
 * stdio transport, so a limit that differs between them is not a policy choice
 * but drift. Written out twice, raising `maxContentBytes` for the plan gate
 * would leave the code gate refusing a message the plan gate accepts from the
 * one server both are talking to, and nothing in either file would say why.
 */
export const COAI_MCP_CAPACITY = {
  maxMessageBytes: 2 * 1024 * 1024,
  maxContentBytes: 2 * 1024 * 1024,
  maxContentBlocks: 128
} as const;

/**
 * Everything the two gates share, built once from trusted settings.
 *
 * They differ in exactly two things: the `id` their transport is filed under,
 * and the checks each runs before it asks for a configuration at all. All the
 * rest — executable, argv, working directory, tool profile, timeout, capacity —
 * belongs to one server, so it is described in one place.
 *
 * `executablePath` is a parameter rather than read from `settings` here
 * because each gate has already narrowed it away from null with its OWN
 * message, and a shared builder must not replace that message with a vaguer one.
 */
export function coaiServerConfig(
  settings: Settings,
  id: string,
  executablePath: string
): ExternalMcpServerConfig {
  return {
    id,
    enabled: true,
    executablePath,
    args: settings.coaiMcpArguments,
    ...(settings.coaiMcpWorkingDirectory === null
      ? {}
      : { cwd: settings.coaiMcpWorkingDirectory }),
    allowedTools: coaiToolProfile(settings),
    timeoutMs: settings.processTimeoutMs,
    ...COAI_MCP_CAPACITY
  };
}

export function externalPlanReviewConfig(settings: Settings): ExternalMcpServerConfig {
  assertExternalPlanReviewSettings(settings);
  if (!settings.externalPlanReviewEnabled || settings.coaiMcpExecutablePath === null) {
    invalid('External plan review is disabled.');
  }

  return coaiServerConfig(settings, 'coai-plan-review', settings.coaiMcpExecutablePath);
}

export function configuredRuleSources(
  settings: Settings,
  projectPath: string
): RuleEvidenceSourceRequest[] {
  assertExternalPlanReviewSettings(settings);
  const sources: RuleEvidenceSourceRequest[] = [
    {
      id: 'project',
      kind: 'project',
      rootPath: projectPath,
      requireClean: false
    }
  ];
  if (
    settings.conventionsRepositoryPath !== null &&
    settings.conventionsExpectedRevision !== null &&
    settings.conventionsRulePaths.length > 0
  ) {
    sources.push({
      id: 'conventions',
      kind: 'conventions',
      rootPath: settings.conventionsRepositoryPath,
      expectedRevision: settings.conventionsExpectedRevision,
      requireClean: true,
      paths: settings.conventionsRulePaths
    });
  }
  return sources;
}
