/**
 * The re-run policy over stored verification records: one diagnostic re-run per materially identical unknown
 * result on a snapshot, never a plain re-run after an output overflow, and the main-process refusal that
 * enforces it while the files and the settings are exactly those of the recorded run.
 */
import { describe, expect, it } from 'vitest';
import { runSchema, type Run } from '../../src/shared/domain/models';
import { verificationConfigurationFields, verificationRerunPolicy, verificationRerunRefusal } from '../../src/shared/domain/verification';
import { verificationConfigurationFingerprint } from '../../src/main/services/verification-fingerprints';

const IDENTITY_A = 'a'.repeat(64);
const IDENTITY_B = 'b'.repeat(64);
const CONFIG_1 = '1'.repeat(16);
const CONFIG_2 = '2'.repeat(16);
const EVIDENCE_X = 'e'.repeat(16);
const EVIDENCE_Y = 'f'.repeat(16);

let sequence = 0;
function run(overrides: Partial<Run>): Run {
  sequence += 1;
  return runSchema.parse({
    id: `run-${sequence}`, taskId: 't', agent: 'system', runType: 'verification', status: 'failed', round: 1,
    startedAt: '2026-09-22T11:00:00.000Z', finishedAt: '2026-09-22T11:09:55.000Z',
    finalMessage: null, structuredResult: null, errorMessage: null, ...overrides
  });
}
function verification(record: Record<string, unknown>, status: Run['status'] = 'failed'): Run {
  return run({
    status,
    structuredResult: JSON.stringify({
      version: 1, command: 'npm run verify', identity: IDENTITY_A, passed: false, exitCode: 1, durationMs: 1_000,
      reason: 'npm run verify failed (exit 1), but the output does not show which check failed or why.', outcome: 'failed', ...record
    })
  });
}
const unknown = (extra: Record<string, unknown> = {}): Run =>
  verification({ failureKind: 'unknown', configurationFingerprint: CONFIG_1, evidenceFingerprint: EVIDENCE_X, ...extra });
const implementation = (): Run => run({ agent: 'ornith', runType: 'implementation', status: 'failed' });
const current = { identity: IDENTITY_A, configurationFingerprint: CONFIG_1 };

describe('verificationRerunPolicy', () => {
  it('is open when there is nothing to gate: no verification, a pass, a runner failure, a cancellation', () => {
    expect(verificationRerunPolicy([])).toEqual({ state: 'open' });
    expect(verificationRerunPolicy([verification({ passed: true, exitCode: 0, reason: null, outcome: 'passed' }, 'succeeded')])).toEqual({ state: 'open' });
    expect(verificationRerunPolicy([verification({ failureKind: 'infrastructure' })])).toEqual({ state: 'open' });
    expect(verificationRerunPolicy([verification({ failureKind: 'implementation' })])).toEqual({ state: 'open' });
    expect(verificationRerunPolicy([verification({ failureKind: 'cancelled', exitCode: null, outcome: 'cancelled' })])).toEqual({ state: 'open' });
  });

  it('grants one diagnostic re-run to a first unknown result — also to a legacy record with no kind', () => {
    expect(verificationRerunPolicy([unknown()])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([verification({})])).toEqual({ state: 'diagnostic' });
  });

  it('requires a change after a second unknown result that is materially the same on the same snapshot', () => {
    expect(verificationRerunPolicy([unknown(), unknown()])).toEqual({ state: 'changes_required', cause: 'unknown_exhausted' });
  });

  it('looks past a cancelled run in between: the previous VERDICT is what counts', () => {
    const cancelled = verification({ failureKind: 'cancelled', exitCode: null, outcome: 'cancelled' }, 'cancelled');
    expect(verificationRerunPolicy([unknown(), cancelled, unknown()])).toEqual({ state: 'changes_required', cause: 'unknown_exhausted' });
    expect(verificationRerunPolicy([unknown(), cancelled])).toEqual({ state: 'open' });
  });

  it('starts a fresh allowance for a changed snapshot, changed settings or a materially different failure', () => {
    expect(verificationRerunPolicy([unknown(), unknown({ identity: IDENTITY_B })])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([unknown(), unknown({ configurationFingerprint: CONFIG_2 })])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([unknown(), unknown({ evidenceFingerprint: EVIDENCE_Y, exitCode: 2 })])).toEqual({ state: 'diagnostic' });
    // A third result that again matches the second is exhausted again — the allowance is per identical pair.
    expect(verificationRerunPolicy([unknown(), unknown({ identity: IDENTITY_B }), unknown({ identity: IDENTITY_B })]))
      .toEqual({ state: 'changes_required', cause: 'unknown_exhausted' });
  });

  it('never treats a record without fingerprints as materially the same: a legacy pair stays diagnostic', () => {
    expect(verificationRerunPolicy([verification({}), verification({})])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([verification({}), unknown()])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([unknown({ evidenceFingerprint: undefined }), unknown({ evidenceFingerprint: undefined })])).toEqual({ state: 'diagnostic' });
  });

  it('requires a change after an output overflow, at once, with no diagnostic re-run', () => {
    expect(verificationRerunPolicy([verification({ failureKind: 'output_limit', exitCode: null, configurationFingerprint: CONFIG_1, evidenceFingerprint: EVIDENCE_X })]))
      .toEqual({ state: 'changes_required', cause: 'output_limit' });
  });

  it('only counts the verifications since the last implementation round, and ignores a run still marked running', () => {
    expect(verificationRerunPolicy([unknown(), unknown(), implementation()])).toEqual({ state: 'open' });
    expect(verificationRerunPolicy([unknown(), implementation(), unknown()])).toEqual({ state: 'diagnostic' });
    expect(verificationRerunPolicy([unknown(), unknown(), run({ status: 'running' })])).toEqual({ state: 'changes_required', cause: 'unknown_exhausted' });
  });
});

describe('verificationRerunRefusal', () => {
  it('refuses an unchanged re-run after an overflow or an exhausted allowance, naming what must change', () => {
    const overflow = verificationRerunRefusal(
      [verification({ failureKind: 'output_limit', exitCode: null, configurationFingerprint: CONFIG_1, evidenceFingerprint: EVIDENCE_X })],
      current
    );
    expect(overflow).toContain('exceeded the stored log budget');
    expect(overflow).toContain('neither the files nor the verification settings have changed');
    expect(overflow).toContain('Raise "Stored log budget" in Settings');

    const exhausted = verificationRerunRefusal([unknown(), unknown()], current);
    expect(exhausted).toContain('last two runs on these exact files ended without a classifiable result');
    expect(exhausted).toContain('Change the files or the verification settings');
  });

  it('lets the run proceed once the snapshot or the settings differ from the recorded run', () => {
    expect(verificationRerunRefusal([unknown(), unknown()], { identity: IDENTITY_B, configurationFingerprint: CONFIG_1 })).toBeNull();
    expect(verificationRerunRefusal([unknown(), unknown()], { identity: IDENTITY_A, configurationFingerprint: CONFIG_2 })).toBeNull();
  });

  it('never refuses while the policy is open or diagnostic, nor on a record whose settings are unknown', () => {
    expect(verificationRerunRefusal([], current)).toBeNull();
    expect(verificationRerunRefusal([unknown()], current)).toBeNull();
    expect(verificationRerunRefusal([verification({ failureKind: 'infrastructure' })], current)).toBeNull();
    expect(verificationRerunRefusal([verification({ failureKind: 'output_limit', exitCode: null })], current)).toBeNull();
  });
});

describe('verificationConfigurationFields', () => {
  const settings = { processTimeoutMs: 1_800_000, maxStoredLogBytes: 2_000_000 };

  it('is the one list both the main-process fingerprint and the renderer read: changing a value it names changes both', () => {
    expect(verificationConfigurationFields(settings)).toEqual([1_800_000, 2_000_000]);

    const baseline = verificationConfigurationFingerprint(settings);
    const baselineRevision = verificationConfigurationFields(settings).join(':');

    // A field this list DOES name: both consumers move.
    const timeoutChanged = { ...settings, processTimeoutMs: settings.processTimeoutMs + 1 };
    expect(verificationConfigurationFingerprint(timeoutChanged)).not.toBe(baseline);
    expect(verificationConfigurationFields(timeoutChanged).join(':')).not.toBe(baselineRevision);

    const budgetChanged = { ...settings, maxStoredLogBytes: settings.maxStoredLogBytes + 1 };
    expect(verificationConfigurationFingerprint(budgetChanged)).not.toBe(baseline);
    expect(verificationConfigurationFields(budgetChanged).join(':')).not.toBe(baselineRevision);
  });

  it('is deterministic and order-stable, so the fingerprint and the revision string agree on what "unchanged" means', () => {
    expect(verificationConfigurationFields(settings)).toEqual(verificationConfigurationFields({ ...settings }));
    expect(verificationConfigurationFingerprint(settings)).toBe(verificationConfigurationFingerprint({ ...settings }));
  });
});
