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
  failureKind: z.enum(VERIFICATION_FAILURE_KINDS).optional(),
  /**
   * Bounded fingerprints (16 hex characters each) kept for the re-run policy below, never raw output:
   * `configurationFingerprint` covers the settings the command ran under (its time limit and stored log
   * budget); `evidenceFingerprint` covers the kind, outcome, exit code and the already sanitized summary with
   * volatile numbers blanked. Two failures are "materially the same" when identity and both match.
   */
  configurationFingerprint: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{16}$/).optional()
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

/**
 * Whether the newest failed verification may simply be run again as it is, judged from the records alone.
 *
 * - `open`: a plain re-run is right (a runner failure, a cancellation, a pass, or nothing to judge).
 * - `diagnostic`: the result was `unknown` and this snapshot still has its one diagnostic re-run.
 * - `changes_required`: re-running under the same files and settings cannot end differently — the output hit
 *   the retention limit, or the diagnostic re-run already ended in a materially identical `unknown` result —
 *   so the next run is offered only once the files or the verification settings change, and
 *   {@link verificationRerunRefusal} enforces that where the snapshot is known.
 */
export type VerificationRerunPolicy =
  | { readonly state: 'open' }
  | { readonly state: 'diagnostic' }
  | { readonly state: 'changes_required'; readonly cause: 'output_limit' | 'unknown_exhausted' };

/** The finished verification runs since the last implementation round, oldest first: the runs on this snapshot sequence. */
function verificationsSinceImplementation(runs: readonly Run[]): Run[] {
  const block: Run[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.runType === 'implementation' || run.runType === 'correction') break;
    if (run.runType === 'verification' && run.status !== 'running') block.unshift(run);
  }
  return block;
}

function materiallySame(a: VerificationRecord, b: VerificationRecord): boolean {
  return a.identity === b.identity &&
    a.evidenceFingerprint !== undefined && a.evidenceFingerprint === b.evidenceFingerprint &&
    a.configurationFingerprint !== undefined && a.configurationFingerprint === b.configurationFingerprint;
}

export function verificationRerunPolicy(runs: readonly Run[]): VerificationRerunPolicy {
  const block = verificationsSinceImplementation(runs);
  const latest = block.at(-1) ?? null;
  const kind = verificationFailureKind(latest);
  if (latest === null || kind === null) return { state: 'open' };
  if (kind === 'output_limit') return { state: 'changes_required', cause: 'output_limit' };
  if (kind !== 'unknown') return { state: 'open' };
  // A cancelled run in between is the operator's doing, not a verdict: the previous VERDICT is what counts.
  const previous = block.slice(0, -1).reverse().find((run) => verificationFailureKind(run) !== 'cancelled') ?? null;
  if (previous === null || verificationFailureKind(previous) !== 'unknown') return { state: 'diagnostic' };
  const record = readVerification(latest);
  const before = readVerification(previous);
  if (!record.success || !before.success || !materiallySame(record.data, before.data)) return { state: 'diagnostic' };
  return { state: 'changes_required', cause: 'unknown_exhausted' };
}

/**
 * The main-process gate for a verification the operator asks for. When the policy requires a change and the
 * snapshot and the settings are exactly those of the recorded run, the run is refused — before any row is
 * written or any state moves — with the sentence that says what must change. A record whose settings are not
 * known (written before the fingerprint existed) never refuses.
 */
export function verificationRerunRefusal(
  runs: readonly Run[],
  current: { readonly identity: string; readonly configurationFingerprint: string }
): string | null {
  const policy = verificationRerunPolicy(runs);
  if (policy.state !== 'changes_required') return null;
  const latest = verificationsSinceImplementation(runs).at(-1);
  const record = latest === undefined ? null : readVerification(latest);
  if (record === null || !record.success) return null;
  if (record.data.identity !== current.identity) return null;
  if (record.data.configurationFingerprint === undefined || record.data.configurationFingerprint !== current.configurationFingerprint) return null;
  return policy.cause === 'output_limit'
    ? "Verification was not started: the last run's output exceeded the stored log budget, and neither the files nor the " +
      'verification settings have changed since, so it would stop at the same limit. Raise "Stored log budget" in Settings ' +
      'or reduce what npm run verify prints first.'
    : 'Verification was not started: the last two runs on these exact files ended without a classifiable result, and ' +
      'neither the files nor the verification settings have changed since. Change the files or the verification settings ' +
      '(time limit, stored log budget) first, or stop the task.';
}
