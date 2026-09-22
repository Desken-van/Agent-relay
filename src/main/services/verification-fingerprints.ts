/**
 * The two bounded fingerprints a verification record keeps for the re-run policy (`verification.ts`,
 * `verificationRerunPolicy`). Both are 16 hex characters of a SHA-256; neither is derived from raw output.
 */
import { createHash } from 'node:crypto';
import type { Settings } from '../../shared/domain/models';
import type { ExecutedVerificationOutcome } from '../../shared/domain/ornith-verification';
import type { VerificationFailureKind } from '../../shared/domain/verification-failure-kind';
import { verificationConfigurationFields } from '../../shared/domain/verification';

const FINGERPRINT_HEX_CHARS = 16;

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
}

/**
 * The settings `npm run verify` runs under; a change to any of them changes the conditions of the run.
 * `verificationConfigurationFields` (shared) is the one place that names which Settings fields those are.
 */
export function verificationConfigurationFingerprint(settings: Pick<Settings, 'processTimeoutMs' | 'maxStoredLogBytes'>): string {
  return digest(['npm run verify', ...verificationConfigurationFields(settings).map(String)]);
}

/**
 * What a failure looked like — from the ALREADY sanitized and bounded summary, never the raw output — with
 * volatile numbers (durations, counts, timestamps) blanked, so two runs that failed the same way on the same
 * files fingerprint the same and a materially different failure does not.
 */
export function verificationEvidenceFingerprint(input: {
  readonly failureKind: VerificationFailureKind;
  readonly outcome: ExecutedVerificationOutcome;
  readonly exitCode: number | null;
  readonly outputSummary: string;
}): string {
  const shape = input.outputSummary.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return digest([input.failureKind, input.outcome, String(input.exitCode), shape]);
}
