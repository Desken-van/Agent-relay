import { z } from 'zod';
import type { Run } from './models';

export const verificationRecordSchema = z.object({
  version: z.literal(1), command: z.literal('npm run verify'),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  passed: z.boolean(), exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(), reason: z.string().nullable()
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

/** Only a completed command with a non-zero exit supplies actionable repair output. */
export function verificationNeedsImplementationRepair(run: Run | null): run is Run {
  if (!run || run.runType !== 'verification' || run.status !== 'failed') return false;
  const record = readVerification(run);
  return record.success && record.data.exitCode !== null && record.data.exitCode !== 0;
}
