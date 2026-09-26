/**
 * The bounded fingerprint a task's `ornithModelProfileId` binding is checked against on every round —
 * whether the profile it was bound to still describes the same runtime, never a path or any other
 * machine-local detail (see `local-inference.ts`'s own "identity is never a machine path" rule).
 */
import { createHash } from 'node:crypto';
import type { LocalInferenceProfile } from '../../shared/domain/local-inference';

const FINGERPRINT_HEX_CHARS = 16;

/**
 * Only the fields that determine what a round actually runs against: executable, model, fixed
 * arguments, port, context/output budgets, timeouts. Deliberately excludes `id`, `displayName`,
 * `enabled` and `adapterKind` — renaming a profile, disabling it, or a future adapter-kind tag are not
 * changes to what it runs, and must not invalidate a task already bound to it.
 */
export function localInferenceProfileFingerprint(profile: LocalInferenceProfile): string {
  const { executable, model, fixedArguments, port, contextLimitTokens, startupTimeoutMs, healthTimeoutMs, inferenceTimeoutMs, shutdownTimeoutMs, requestDefaults } = profile;
  const shape = { executable, model, fixedArguments, port, contextLimitTokens, startupTimeoutMs, healthTimeoutMs, inferenceTimeoutMs, shutdownTimeoutMs, requestDefaults };
  return createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
}
