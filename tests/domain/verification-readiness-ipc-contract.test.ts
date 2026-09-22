/**
 * The read-only readiness channel: registered, strict on input, and the shared readiness computation that
 * answers it — the same comparison the main-process gate makes, reduced to a value with nothing in it.
 */
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas } from '../../src/shared/ipc';
import { runSchema, type Run } from '../../src/shared/domain/models';
import { verificationReadinessFor } from '../../src/shared/domain/verification';

describe('workflow:verificationReadiness contract', () => {
  it('is registered and accepts exactly a task id', () => {
    expect(IPC_CHANNELS).toContain('workflow:verificationReadiness');
    expect(ipcInputSchemas['workflow:verificationReadiness'].safeParse({ taskId: 't1' }).success).toBe(true);
    expect(ipcInputSchemas['workflow:verificationReadiness'].safeParse({}).success).toBe(false);
    expect(ipcInputSchemas['workflow:verificationReadiness'].safeParse({ taskId: '' }).success).toBe(false);
    // Strict: the worktree path, the identity and the settings are resolved in the main process, never accepted.
    expect(ipcInputSchemas['workflow:verificationReadiness'].safeParse({ taskId: 't1', worktreePath: 'C:\\x' }).success).toBe(false);
    expect(ipcInputSchemas['workflow:verificationReadiness'].safeParse({ taskId: 't1', identity: 'a'.repeat(64) }).success).toBe(false);
  });
});

describe('verificationReadinessFor', () => {
  const IDENTITY_A = 'a'.repeat(64);
  const IDENTITY_B = 'b'.repeat(64);
  const CONFIG_1 = '1'.repeat(16);
  const CONFIG_2 = '2'.repeat(16);
  let sequence = 0;
  const verification = (record: Record<string, unknown>): Run => {
    sequence += 1;
    return runSchema.parse({
      id: `run-${sequence}`, taskId: 't', agent: 'system', runType: 'verification', status: 'failed', round: 1,
      startedAt: '2026-09-22T11:00:00.000Z', finishedAt: '2026-09-22T11:09:55.000Z', finalMessage: null, errorMessage: null,
      structuredResult: JSON.stringify({
        version: 1, command: 'npm run verify', identity: IDENTITY_A, passed: false, exitCode: 1, durationMs: 1_000,
        reason: 'npm run verify failed (exit 1), but the output does not show which check failed or why.', outcome: 'failed',
        configurationFingerprint: CONFIG_1, evidenceFingerprint: 'e'.repeat(16), ...record
      })
    });
  };
  const unknown = (): Run => verification({ failureKind: 'unknown' });
  const overflow = (): Run => verification({ failureKind: 'output_limit', exitCode: null });

  it('is not_blocked while the policy is open or diagnostic', () => {
    expect(verificationReadinessFor([], { identity: IDENTITY_A, configurationFingerprint: CONFIG_1 })).toEqual({ state: 'not_blocked' });
    expect(verificationReadinessFor([unknown()], { identity: IDENTITY_A, configurationFingerprint: CONFIG_1 })).toEqual({ state: 'not_blocked' });
    expect(verificationReadinessFor([verification({ failureKind: 'infrastructure' })], { identity: IDENTITY_B, configurationFingerprint: CONFIG_2 })).toEqual({ state: 'not_blocked' });
  });

  it('is blocked exactly when the refusal would fire, and ready — saying what changed — otherwise', () => {
    expect(verificationReadinessFor([overflow()], { identity: IDENTITY_A, configurationFingerprint: CONFIG_1 })).toEqual({ state: 'blocked', cause: 'output_limit' });
    expect(verificationReadinessFor([unknown(), unknown()], { identity: IDENTITY_A, configurationFingerprint: CONFIG_1 })).toEqual({ state: 'blocked', cause: 'unknown_exhausted' });
    expect(verificationReadinessFor([overflow()], { identity: IDENTITY_B, configurationFingerprint: CONFIG_1 }))
      .toEqual({ state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false });
    expect(verificationReadinessFor([overflow()], { identity: IDENTITY_A, configurationFingerprint: CONFIG_2 }))
      .toEqual({ state: 'ready', cause: 'output_limit', filesChanged: false, settingsChanged: true });
    expect(verificationReadinessFor([unknown(), unknown()], { identity: IDENTITY_B, configurationFingerprint: CONFIG_2 }))
      .toEqual({ state: 'ready', cause: 'unknown_exhausted', filesChanged: true, settingsChanged: true });
  });

  it('carries nothing but the readiness: no identity, fingerprint, path or output', () => {
    for (const current of [{ identity: IDENTITY_A, configurationFingerprint: CONFIG_1 }, { identity: IDENTITY_B, configurationFingerprint: CONFIG_2 }]) {
      const text = JSON.stringify(verificationReadinessFor([overflow()], current));
      expect(text).not.toMatch(/[a-f0-9]{16}/);
      expect(text).not.toContain('npm run verify');
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(expect.arrayContaining(['cause', 'state']));
    }
  });
});
