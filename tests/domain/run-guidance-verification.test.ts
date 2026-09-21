import { describe, expect, it } from 'vitest';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import type { OrnithVerificationAttempt } from '../../src/shared/domain/ornith-verification';
import { runGuidance, type RunGuidance } from '../../src/shared/domain/run-guidance';

const APPROVED = '2026-09-11T00:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    id: 'task-1', projectId: 'project-1', title: 'Add configured provider smoke-test checklist', originalRequest: 'Add it',
    status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: null, claudeSessionId: null,
    worktreePath: null, branchName: null, baseBranch: 'main', specificationJson: null,
    specificationApprovedAt: APPROVED, lastReviewJson: null, lastError: null, codexModel: null,
    claudeModel: null, createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
    implementationProvider: 'ornith', ...overrides
  });
}

function run(overrides: Partial<Run> = {}): Run {
  return runSchema.parse({
    id: 'run-1', taskId: 'task-1', agent: 'ornith', runType: 'implementation', status: 'failed',
    round: 1, startedAt: '2026-09-11T00:00:00.000Z', finishedAt: '2026-09-11T00:01:00.000Z',
    finalMessage: null, structuredResult: null, errorMessage: null, ...overrides
  });
}

function attempt(overrides: Partial<OrnithVerificationAttempt> = {}): OrnithVerificationAttempt {
  return {
    sequence: 3, command: 'npm run verify', outcome: 'failed', exitCode: 1, durationMs: 511_795,
    reason: 'npm run verify exited with code 1 after 8m32s.',
    summary: ' FAIL  tests/adapters/native.test.ts > guard\n Test Files  1 failed | 118 passed (119)',
    code: null, fingerprint: 'abc123', ...overrides
  };
}

function ornithRun(input: {
  changedFiles?: number;
  worktreeChangedFiles?: number | null;
  attempts?: readonly OrnithVerificationAttempt[];
  reasonCodes?: readonly string[];
  id?: string;
}): Run {
  return run({
    id: input.id ?? 'run-ornith',
    structuredResult: JSON.stringify({
      provider: 'ornith',
      counters: {
        changedFiles: input.changedFiles ?? 1,
        ...(input.worktreeChangedFiles === undefined ? {} : { worktreeChangedFiles: input.worktreeChangedFiles }),
        verificationAttempts: input.attempts ?? []
      },
      assessment: { reasonCodes: input.reasonCodes ?? [] }
    })
  });
}

const relayRecord = (overrides: Record<string, unknown>): Run =>
  run({
    id: 'run-verification', runType: 'verification', agent: 'system', status: 'failed',
    structuredResult: JSON.stringify({
      version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false,
      exitCode: 1, durationMs: 511_795, reason: 'npm run verify failed (exit 1). See command output.', ...overrides
    })
  });

const guidance = (t: Task, runs: readonly Run[]): RunGuidance =>
  runGuidance(t, runs, true, false, 'not_required', { ornithLocalInferenceState: 'healthy' });

function expectConsistent(value: RunGuidance): void {
  if (value.action) expect(value.next).toBe(value.action.label);
}

describe('after Ornith changed files and could not prove them verified', () => {
  it('says what changed and that verification failed, names the command and the reason, and makes verification the primary action', () => {
    const value = guidance(
      task({ lastError: 'Ornith changed 1 file. npm run verify exited with code 1 after 8m32s. The changes are preserved in the task worktree. Run verification in Agent Relay to check them.' }),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] })]
    );

    expect(value.happened).toBe('Implementation changed 1 file; verification failed.');
    expect(value.stage).toBe('Step 3 of 5 · Verification');
    expect(value.result).toContain('npm run verify exited with code 1 after 8m32s.');
    expect(value.result).toContain('Manual verification is required before review.');
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect(value.verification).toEqual({
      source: 'ornith',
      command: 'npm run verify',
      outcome: 'failed',
      exitCode: 1,
      durationMs: 511_795,
      reason: 'npm run verify exited with code 1 after 8m32s.',
      output: ' FAIL  tests/adapters/native.test.ts > guard\n Test Files  1 failed | 118 passed (119)'
    });
    expect(value.tone).toBe('warning');
    expectConsistent(value);
  });

  it('offers re-running the implementation only as a deliberate secondary action, never the primary one', () => {
    const value = guidance(task(), [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] })]);

    expect(value.action?.key).toBe('run_verification');
    expect(value.secondaryAction).toMatchObject({ key: 'run_implementation', label: 'Retry implementation · Ornith', enabled: true });
    expect(value.secondaryAction?.key).not.toBe(value.action?.key);
  });

  it('keeps the secondary retry consistent with local-inference readiness: disabled with the reason when Ornith is not healthy', () => {
    const value = runGuidance(
      task(),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] })],
      true, false, 'not_required', { ornithLocalInferenceState: 'stopped' }
    );

    expect(value.action).toMatchObject({ key: 'run_verification', enabled: true }); // verification never needs the model
    expect(value.secondaryAction?.enabled).toBe(false);
  });

  it('tells a timed-out verification from a failed one', () => {
    const value = guidance(
      task(),
      [ornithRun({ attempts: [attempt({ outcome: 'timed_out', exitCode: null, durationMs: 808_391, reason: 'npm run verify was stopped after 13m28s: the implementation time budget left no more time for it.' })] })]
    );

    expect(value.happened).toBe('Implementation changed 1 file; verification timed out.');
    expect(value.verification).toMatchObject({ outcome: 'timed_out', exitCode: null, durationMs: 808_391 });
    expect(value.action?.key).toBe('run_verification');
  });

  it('tells a cancelled verification from a failed one', () => {
    const value = guidance(task(), [ornithRun({ attempts: [attempt({ outcome: 'cancelled', exitCode: null, reason: 'npm run verify was cancelled before it finished.' })] })]);

    expect(value.happened).toBe('Implementation changed 1 file; verification was cancelled.');
    expect(value.verification?.outcome).toBe('cancelled');
  });

  it('says a verification was never started when the loop refused it, and does not invent a result', () => {
    const value = guidance(
      task(),
      [ornithRun({ attempts: [attempt({ outcome: 'not_run', exitCode: null, durationMs: 0, reason: 'Only 1m of the implementation time budget remain.', summary: '', code: 'limit_verification_time_insufficient' })] })]
    );

    expect(value.happened).toBe('Implementation changed 1 file; verification was not started.');
    expect(value.verification).toMatchObject({ outcome: 'not_run', exitCode: null, durationMs: null, output: null });
    expect(value.action?.key).toBe('run_verification');
  });

  it('says the time limit expired, and still leads with verification', () => {
    const value = guidance(
      task(),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, reasonCodes: ['limit_deadline_exceeded'], attempts: [attempt(), attempt({ sequence: 5, outcome: 'timed_out', exitCode: null, reason: 'npm run verify was stopped after 6m00s.' })] })]
    );

    expect(value.happened).toBe('The implementation time limit expired. Implementation changed 1 file.');
    expect(value.result).toContain('Manual verification is required before review.');
    expect(value.action?.key).toBe('run_verification');
    expect(value.verification?.outcome).toBe('timed_out'); // the LATEST executed attempt
  });

  it('when the deadline ended a run with no recorded attempt at all, still keeps the files and says so', () => {
    const value = guidance(task(), [ornithRun({ changedFiles: 2, worktreeChangedFiles: 2, reasonCodes: ['limit_deadline_exceeded'] })]);

    expect(value.happened).toBe('The implementation time limit expired. Implementation changed 2 files.');
    expect(value.result).toContain('preserved in the task worktree');
    expect(value.action?.key).toBe('run_verification');
    expect(value.verification).toBeNull();
  });

  it('shows the failure that stands, not a later refusal that came after it', () => {
    const value = guidance(
      task(),
      [ornithRun({ attempts: [attempt(), attempt({ sequence: 5, outcome: 'not_run', exitCode: null, durationMs: 0, summary: '', reason: 'The files are exactly what the last verification already ran on.', code: 'verification_repeat_refused' })] })]
    );

    expect(value.happened).toBe('Implementation changed 1 file; verification failed.');
    expect(value.verification).toMatchObject({ outcome: 'failed', exitCode: 1 });
  });
});

describe('preserved edits outlive a later attempt that changed nothing', () => {
  it('a later round that changed nothing does not make earlier unverified edits look gone', () => {
    const value = guidance(task(), [
      ornithRun({ id: 'first', changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] }),
      ornithRun({ id: 'second', changedFiles: 0, worktreeChangedFiles: 1 })
    ]);

    expect(value.action?.key).toBe('run_verification');
    // The latest round verified nothing; the earlier edits are still counted.
    expect(value.happened).toBe('Implementation changed 1 file; verification has not run.');
  });

  it('holds when only an older attempt recorded changes (no worktree count on the later one)', () => {
    const value = guidance(task(), [
      ornithRun({ id: 'first', changedFiles: 1, attempts: [attempt()] }),
      ornithRun({ id: 'second', changedFiles: 0 })
    ]);

    expect(value.action?.key).toBe('run_verification');
  });

  it('a run whose own count is zero but whose worktree still holds changes is not "no changes"', () => {
    const value = guidance(task(), [ornithRun({ changedFiles: 0, worktreeChangedFiles: 3 })]);

    expect(value.action?.key).toBe('run_verification');
    expect(value.happened).toBe('Implementation changed 3 files; verification has not run.');
  });
});

describe('when nothing was changed the existing behaviour stands', () => {
  it('keeps "Run implementation · Ornith" as the only action after a run that proved no changes, with no secondary', () => {
    const value = guidance(
      task({ lastError: 'Ornith stopped before changing any files.' }),
      [ornithRun({ changedFiles: 0, worktreeChangedFiles: 0 })]
    );

    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Run implementation · Ornith', enabled: true });
    expect(value.secondaryAction ?? null).toBeNull();
    expect(value.happened).toBe('Ornith stopped before changing any files.');
    expect(value.verification ?? null).toBeNull();
  });

  it('a refused, never-run verification with nothing changed still offers implementation, not verification', () => {
    const value = guidance(
      task(),
      [ornithRun({ changedFiles: 0, worktreeChangedFiles: 0, attempts: [attempt({ outcome: 'not_run', exitCode: null, durationMs: 0, summary: '', reason: 'Only 1m remain.', code: 'limit_verification_time_insufficient' })] })]
    );

    expect(value.action?.key).toBe('run_implementation');
  });

  it('an older run recorded before worktree counts existed is judged as it always was', () => {
    const value = guidance(task(), [ornithRun({ changedFiles: 0 })]);
    expect(value.action?.key).toBe('run_implementation');
  });

  it('stays fail-closed for a run that left no readable evidence at all (a crash): verification, never a blind retry', () => {
    const value = guidance(task(), [run({ agent: 'ornith', structuredResult: null })]);
    expect(value.action?.key).toBe('run_verification');
  });
});

describe('after Agent Relay’s own verification of the worktree', () => {
  it('a real failing exit keeps the repair as the primary action and makes checking again one click away, with the command output', () => {
    const value = guidance(
      task({ lastError: 'npm run verify failed (exit 1). See command output.' }),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
        relayRecord({ outcome: 'failed', outputSummary: ' FAIL  tests/a.test.ts\n Test Files  1 failed' })
      ]
    );

    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Fix verification failures · Ornith' });
    expect(value.secondaryAction).toMatchObject({ key: 'run_verification', label: 'Run verification again' });
    expect(value.verification).toEqual({
      source: 'relay',
      command: 'npm run verify',
      outcome: 'failed',
      exitCode: 1,
      durationMs: 511_795,
      reason: 'npm run verify failed (exit 1). See command output.',
      output: ' FAIL  tests/a.test.ts\n Test Files  1 failed'
    });
  });

  it('a timed-out Relay verification is recovered by running verification, and says it timed out', () => {
    const value = guidance(
      task(),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
        relayRecord({ exitCode: null, reason: 'Verification timed out; success was not established.', outcome: 'timed_out' })
      ]
    );

    expect(value.action?.key).toBe('run_verification');
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'timed_out', exitCode: null });
    expect(value.happened).toBe('Implementation changed 1 file; verification timed out.');
  });

  it('reads a record written before outcomes existed, without calling a timeout a cancellation', () => {
    const timedOut = guidance(task(), [
      ornithRun({ changedFiles: 1 }),
      relayRecord({ exitCode: null, reason: 'Verification timed out; success was not established.' })
    ]);
    const cancelled = guidance(task(), [
      ornithRun({ changedFiles: 1 }),
      relayRecord({ exitCode: null, reason: 'Verification cancelled; success was not established.' })
    ]);
    const failed = guidance(task(), [ornithRun({ changedFiles: 1 }), relayRecord({})]);

    expect(timedOut.verification?.outcome).toBe('timed_out');
    expect(cancelled.verification?.outcome).toBe('cancelled');
    expect(failed.verification?.outcome).toBe('failed');
    expect(failed.verification?.output).toBeNull();
  });
});

describe('the same recovery for other providers', () => {
  it('offers verification first for a Claude attempt too, with the provider named on the secondary retry', () => {
    const value = runGuidance(
      task({ implementationProvider: 'claude' }),
      [run({ agent: 'claude', status: 'failed' })],
      true
    );

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expect(value.secondaryAction).toMatchObject({ key: 'run_implementation', label: 'Retry implementation · Claude' });
  });
});

describe('every secondary action is from a fixed, documented set', () => {
  const SECONDARY_LABELS = new Set([
    'Run verification again',
    'Retry implementation · Ornith',
    'Retry implementation · Claude',
    'Retry implementation · Codex'
  ]);

  it('never returns a secondary action that is outside the set, or that repeats the primary', () => {
    const attemptSets: (readonly OrnithVerificationAttempt[])[] = [
      [],
      [attempt()],
      [attempt({ outcome: 'timed_out', exitCode: null })],
      [attempt({ outcome: 'not_run', exitCode: null, durationMs: 0, summary: '', code: 'verification_repeat_refused' })]
    ];
    for (const provider of ['ornith', 'claude', 'codex'] as const) {
      for (const attempts of attemptSets) {
        for (const changedFiles of [0, 1]) {
          for (const reasonCodes of [[], ['limit_deadline_exceeded']]) {
            for (const withRelay of [false, true]) {
              const runs = [
                ornithRun({ changedFiles, worktreeChangedFiles: changedFiles, attempts, reasonCodes }),
                ...(withRelay ? [relayRecord({})] : [])
              ];
              const value = runGuidance(
                task({ implementationProvider: provider }),
                runs, true, false, 'not_required', { ornithLocalInferenceState: 'healthy' }
              );
              expectConsistent(value);
              if (value.secondaryAction) {
                expect(SECONDARY_LABELS.has(value.secondaryAction.label), value.secondaryAction.label).toBe(true);
                expect(value.secondaryAction.key).not.toBe(value.action?.key);
              }
            }
          }
        }
      }
    }
  });
});
