/**
 * Resolving which local-model profile an `ornith` task binds to, once, at the moment it is bound — never
 * re-resolved later against a `defaultProfileId` that may since have changed. Shared by `TaskService.create`
 * (a brand-new task) and `Orchestrator.configureProviders` (an existing task switching its implementation
 * provider to `ornith`), so the two can never apply different rules for what a missing/disabled/unconfigured
 * choice means.
 */
import { AgentRelayError } from '../../shared/domain/errors';
import type { LocalInferenceProfilesSettings } from '../../shared/domain/local-inference';
import { localInferenceProfileFingerprint } from './local-inference-profile-fingerprint';

export interface OrnithModelProfileBinding {
  readonly profileId: string;
  readonly profileFingerprint: string;
}

/**
 * `requestedProfileId` omitted means "use the current default"; the resolved profile is validated to
 * exist and to be enabled, and its fingerprint is captured in this same call — the value that is then
 * persisted onto the task and never recomputed against a moving target. Refuses clearly
 * (`VALIDATION_FAILED`) rather than silently falling back when nothing suitable is configured.
 */
export function resolveOrnithModelProfileBinding(
  settings: LocalInferenceProfilesSettings,
  requestedProfileId: string | undefined
): OrnithModelProfileBinding {
  const targetId = requestedProfileId ?? settings.defaultProfileId;
  if (targetId === null) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'No default local-model profile is configured.',
      { remediation: 'Choose a profile explicitly, or set a default in Settings → Local inference.' }
    );
  }
  const profile = settings.profiles.find((candidate) => candidate.id === targetId);
  if (!profile) {
    throw new AgentRelayError('VALIDATION_FAILED', `No local-model profile with id "${targetId}" is configured.`);
  }
  if (!profile.enabled) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      `The local-model profile "${profile.displayName}" is disabled.`,
      { remediation: 'Enable it in Settings → Local inference, or choose a different profile.' }
    );
  }
  return { profileId: profile.id, profileFingerprint: localInferenceProfileFingerprint(profile) };
}
