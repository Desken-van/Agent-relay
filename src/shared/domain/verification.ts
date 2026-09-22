import { z } from 'zod';
import type { Run } from './models';
import { VERIFICATION_FAILURE_KINDS, type VerificationFailureKind } from './verification-failure';

export const verificationRecordSchema = z.object({
  version: z.literal(1), command: z.literal('npm run verify'),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  passed: z.boolean(), exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(), reason: z.string().nullable(),
  /**
   * Added after the first records were written, so all three are optional: an older record has none and
   * still reads. `outcome` says which kind of stop it was (the reason string alone made a timeout and a
   * nonzero exit look alike); `outputSummary` is the sanitized, bounded tail of the command's output;
   * `failureKind` is what the failure was classified as from the bounded output before it was stored — see
   * `verification-failure.ts` — and decides the one next step the Run screen offers.
   */
  outcome: z.enum(['passed', 'failed', 'timed_out', 'cancelled']).optional(),
  outputSummary: z.string().max(1_500).optional(),
  failureKind: z.enum(VERIFICATION_FAILURE_KINDS).optional()
}).refine(value => !value.passed || (value.exitCode === 0 && value.reason === null), 'A pass requires exit zero and no failure reason');
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;
export function latestVerification(runs: readonly Run[]): Run | null {
  // A later implementation invalidates the verification, even if files happen
  // to match; its failures must not be hidden by an older successful check.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.runType === 'verification') return run;
    if (run.runType === 'implementation' || run.runType === 'correction') return null;
  }
  return null;
}
export function readVerification(run: Run) {
  try { return verificationRecordSchema.safeParse(JSON.parse(run.structuredResult ?? 'null')); }
  catch { return verificationRecordSchema.safeParse(null); }
}

/**
 * What kind of failure a verification run that did not pass records. Null for a pass or a non-verification
 * run. A record written before `failureKind` existed, or one that cannot be read, fails CLOSED as `unknown`
 * (a cancelled one stays `cancelled`): re-running verification is cheap and produces a classified record,
 * whereas guessing "the files are at fault" from an exit code alone would spend an implementation round on
 * a failure nobody has looked at.
 */
export function verificationFailureKind(run: Run | null): VerificationFailureKind | null {
  if (!run || run.runType !== 'verification' || run.status === 'succeeded' || run.status === 'running') return null;
  const record = readVerification(run);
  if (!record.success) return run.status === 'cancelled' ? 'cancelled' : 'unknown';
  if (record.data.passed) return null;
  if (record.data.failureKind !== undefined) return record.data.failureKind;
  return record.data.outcome === 'cancelled' || run.status === 'cancelled' ? 'cancelled' : 'unknown';
}

/**
 * Only a verification classified as a failure OF THE FILES supplies actionable repair evidence. A runner
 * failure, a cancellation or an unclassified failure never does: they are retried, not handed to a model.
 */
export function verificationNeedsImplementationRepair(run: Run | null): run is Run {
  return verificationFailureKind(run) === 'implementation';
}
