import { describe, expect, it } from 'vitest';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import type { OrnithVerificationAttempt } from '../../src/shared/domain/ornith-verification';
import { runGuidance, type RunGuidance, type RunGuidanceExtra } from '../../src/shared/domain/run-guidance';

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

const OUTPUT_LIMIT_REASON = "Verification output exceeded Agent Relay's configured retention limit (2000k characters per run), so the result could not be classified safely: the command was stopped at the limit and only the output up to it was kept. Raise \"Stored log budget\" in Settings or reduce what npm run verify prints; running it again unchanged would stop at the same limit.";

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

  it('offers exactly one action — Run verification — and never a retry of the implementation beside it', () => {
    const value = guidance(task(), [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] })]);

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect('secondaryAction' in value).toBe(false);
    expect(JSON.stringify(value)).not.toContain('Retry implementation');
  });

  it('does not need the local runtime for that one action: verification is offered enabled even when Ornith is stopped', () => {
    const value = runGuidance(
      task(),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [attempt()] })],
      true, false, 'not_required', { ornithLocalInferenceState: 'stopped' }
    );

    expect(value.action).toMatchObject({ key: 'run_verification', enabled: true });
    expect(JSON.stringify(value)).not.toContain('run_implementation');
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

  it('does not say verification "has not run" when Ornith’s own check PASSED — it says the other half: Relay has not verified yet', () => {
    // The round ended for another reason after a passing diagnostic run. The attempt panel beneath the headline
    // shows that pass, so the headline must not contradict it — nor treat a diagnostic pass as publishable.
    const value = guidance(
      task(),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, reasonCodes: ['blocked'], attempts: [attempt({ outcome: 'passed', exitCode: 0, reason: null, summary: '' })] })]
    );

    expect(value.happened).toBe("Implementation changed 1 file; Ornith's own verification passed, but Agent Relay has not verified the files yet.");
    expect(value.happened).not.toContain('has not run');
    expect(value.verification).toMatchObject({ source: 'ornith', outcome: 'passed', exitCode: 0 });
    expect(value.action?.key).toBe('run_verification'); // only Relay's own verification makes the files reviewable
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

  it('follows the latest recorded worktree count, not the most any earlier round ever left', () => {
    // A first round left five files; a later one (say, after the operator or a correction removed four) left one.
    const value = guidance(task(), [
      ornithRun({ id: 'first', changedFiles: 5, worktreeChangedFiles: 5, attempts: [attempt()] }),
      ornithRun({ id: 'second', changedFiles: 0, worktreeChangedFiles: 1 })
    ]);

    expect(value.action?.key).toBe('run_verification');
    expect(value.happened).toBe('Implementation changed 1 file; verification has not run.');
  });

  it('falls back to an earlier round’s count only when the latest round could not establish one', () => {
    const value = guidance(task(), [
      ornithRun({ id: 'first', changedFiles: 2, worktreeChangedFiles: 2, attempts: [attempt()] }),
      ornithRun({ id: 'second', changedFiles: 0, worktreeChangedFiles: null })
    ]);

    expect(value.happened).toBe('Implementation changed 2 files; verification has not run.');
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
  it('offers "Retry implementation · Ornith" as the only action after a run that proved no changes: it is a retry, and there is nothing to verify', () => {
    const value = guidance(
      task({ lastError: 'Ornith stopped before changing any files.' }),
      [ornithRun({ changedFiles: 0, worktreeChangedFiles: 0 })]
    );

    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Retry implementation · Ornith', enabled: true });
    expect('secondaryAction' in value).toBe(false);
    expect(value.happened).toBe('Ornith stopped before changing any files.');
    expect(value.result).toContain('Ornith stopped before changing any files.');
    expect(value.result).toContain('nothing to verify');
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
  it('a failure OF THE FILES makes the repair the one action, says why a re-run would not help, and carries the command output', () => {
    const value = guidance(
      task({ lastError: 'npm run verify failed (exit 1): a test assertion failed. The current files did not pass.' }),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
        relayRecord({ outcome: 'failed', failureKind: 'implementation', reason: 'npm run verify failed (exit 1): a test assertion failed. The current files did not pass.', outputSummary: ' FAIL  tests/a.test.ts\nAssertionError: expected 1 to be 2\n Test Files  1 failed' })
      ]
    );

    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Fix verification failures · Ornith' });
    expect('secondaryAction' in value).toBe(false);
    expect(JSON.stringify(value)).not.toContain('Run verification again');
    expect(value.stage).toBe('Step 2 of 5 · Fix verification failures');
    expect(value.result).toContain('a test assertion failed');
    expect(value.result).toContain('handed to Ornith as correction evidence');
    expect(value.result).toContain('would fail the same way');
    expect(value.verification).toEqual({
      source: 'relay',
      command: 'npm run verify',
      outcome: 'failed',
      exitCode: 1,
      durationMs: 511_795,
      reason: 'npm run verify failed (exit 1): a test assertion failed. The current files did not pass.',
      output: ' FAIL  tests/a.test.ts\nAssertionError: expected 1 to be 2\n Test Files  1 failed'
    });
  });

  it('a failure OF THE TEST RUNNER (the live Vitest worker timeout) makes "Run verification again" the one action, and never a repair', () => {
    const reason = 'Verification could not complete: a Vitest worker stopped answering (worker timeout). That is a failure of the test infrastructure, not of the current files.';
    const value = guidance(
      task({ lastError: reason }),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
        relayRecord({ outcome: 'failed', failureKind: 'infrastructure', reason, outputSummary: 'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond' })
      ]
    );

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification again', enabled: true });
    expect('secondaryAction' in value).toBe(false);
    expect(JSON.stringify(value)).not.toContain('Fix verification failures');
    expect(JSON.stringify(value)).not.toContain('run_implementation');
    expect(value.happened).toContain('verification tooling failed');
    expect(value.result).toContain('worker timeout');
    expect(value.result).toContain('no implementation round is spent');
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'failed', exitCode: 1 });
  });

  it('an UNCLASSIFIED failure fails closed: the one action is "Run verification to diagnose", never a repair and never a retry', () => {
    const reason = 'npm run verify failed (exit 1), but the output does not show which check failed or why.';
    const value = guidance(
      task({ lastError: reason }),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }), relayRecord({ outcome: 'failed', failureKind: 'unknown', reason })]
    );

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification to diagnose', enabled: true });
    expect('secondaryAction' in value).toBe(false);
    expect(JSON.stringify(value)).not.toContain('run_implementation');
    expect(value.result).toContain('Nothing is retried automatically');
    expect(value.result).toContain('no implementation round is spent');
  });

  it('an OUTPUT-LIMIT failure is a WAITING state until the main process says the files or settings changed — never an enabled button the gate would refuse', () => {
    const reason = OUTPUT_LIMIT_REASON;
    const runs = [
      ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
      relayRecord({ outcome: 'failed', exitCode: null, failureKind: 'output_limit', reason, configurationFingerprint: 'c'.repeat(16), evidenceFingerprint: 'e'.repeat(16) })
    ];
    const withReadiness = (readiness: RunGuidanceExtra['verificationReadiness']): RunGuidance =>
      runGuidance(task({ lastError: reason }), runs, true, false, 'not_required', { ornithLocalInferenceState: 'healthy', verificationReadiness: readiness });

    // Not read yet: waiting, no control.
    const pending = withReadiness(null);
    expect(pending.action).toBeNull();
    expect(pending.next).toContain('Checking whether the files or the verification settings changed');
    expect(pending.result).toContain('no verification step is offered and no implementation round is spent');

    // Blocked: waiting, "User action required", the setting named; no repair, no retry, no verification control.
    const blocked = withReadiness({ state: 'blocked', cause: 'output_limit' });
    expect(blocked.action).toBeNull();
    expect(blocked.next).toContain('User action required');
    expect(blocked.next).toContain('Stored log budget');
    expect(blocked.happened).toContain('stored log budget');
    expect(blocked.result).toContain('retention limit');
    expect(JSON.stringify(blocked)).not.toContain('Fix verification failures');
    expect(JSON.stringify(blocked)).not.toContain('Retry implementation');
    expect(blocked.verification).toMatchObject({ source: 'relay', outcome: 'failed', exitCode: null });

    // The check itself unavailable: still waiting, still no control, the fixed detail shown.
    const unavailable = withReadiness({ state: 'unavailable', cause: 'output_limit', detail: 'The task worktree cannot be checked for changes right now.' });
    expect(unavailable.action).toBeNull();
    expect(unavailable.next).toContain('User action required');
    expect(unavailable.next).toContain('cannot be checked for changes right now');

    // An answer about another state is no answer for this one.
    expect(withReadiness({ state: 'not_blocked' }).action).toBeNull();
    expect(withReadiness({ state: 'blocked', cause: 'unknown_exhausted' }).action).toBeNull();
    expect(withReadiness({ state: 'ready', cause: 'unknown_exhausted', filesChanged: true, settingsChanged: false }).action).toBeNull();

    // Ready: exactly one enabled Run verification, saying what changed.
    const files = withReadiness({ state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false });
    expect(files.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect(files.result).toContain('The files changed since that run');
    expect(files.result).toContain('No implementation round is spent');
    const settings = withReadiness({ state: 'ready', cause: 'output_limit', filesChanged: false, settingsChanged: true });
    expect(settings.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect(settings.result).toContain('The verification settings changed since that run');
    const both = withReadiness({ state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: true });
    expect(both.result).toContain('The files and the verification settings changed');
  });

  it('a SECOND materially identical unknown result on the same snapshot exhausts the one diagnostic re-run: a WAITING state, never "to diagnose" again, never a repair', () => {
    const reason = 'npm run verify failed (exit 1), but the output does not show which check failed or why.';
    const same = { outcome: 'failed', failureKind: 'unknown', reason, configurationFingerprint: 'c'.repeat(16), evidenceFingerprint: 'e'.repeat(16) };
    const first = guidance(task({ lastError: reason }), [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }), relayRecord(same)]);
    expect(first.action).toMatchObject({ label: 'Run verification to diagnose' });
    expect(first.result).toContain('one diagnostic re-run');

    const exhausted = [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }), relayRecord(same), relayRecord(same)];
    const withReadiness = (readiness: RunGuidanceExtra['verificationReadiness']): RunGuidance =>
      runGuidance(task({ lastError: reason }), exhausted, true, false, 'not_required', { ornithLocalInferenceState: 'healthy', verificationReadiness: readiness });

    const pending = withReadiness(null);
    expect(pending.action).toBeNull();
    expect(pending.next).toContain('Checking whether');

    const blocked = withReadiness({ state: 'blocked', cause: 'unknown_exhausted' });
    expect(blocked.action).toBeNull();
    expect('secondaryAction' in blocked).toBe(false);
    expect(blocked.next).toContain('User action required');
    expect(blocked.next).toContain('change the files or the verification settings');
    expect(blocked.happened).toContain('twice');
    expect(blocked.result).toContain('one diagnostic re-run for this snapshot was already used');
    expect(blocked.result).toContain('not classified as a defect of the files');
    expect(blocked.result).toContain('no implementation round is spent');
    for (const forbidden of ['to diagnose', 'Run verification again', 'Fix verification failures', 'Retry implementation', 'Ornith']) {
      expect(JSON.stringify(blocked)).not.toContain(forbidden);
    }

    const ready = withReadiness({ state: 'ready', cause: 'unknown_exhausted', filesChanged: false, settingsChanged: true });
    expect(ready.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect(ready.result).toContain('The verification settings changed since that run');

    // A changed snapshot, changed settings or a materially different result starts a fresh allowance.
    for (const fresh of [{ identity: 'b'.repeat(64) }, { configurationFingerprint: 'd'.repeat(16) }, { evidenceFingerprint: 'f'.repeat(16), exitCode: 2 }]) {
      const value = guidance(task({ lastError: reason }), [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }), relayRecord(same), relayRecord({ ...same, ...fresh })]);
      expect(value.action, JSON.stringify(fresh)).toMatchObject({ label: 'Run verification to diagnose' });
    }
  });

  it('a record written before classification existed also fails closed, to "Run verification to diagnose"', () => {
    const value = guidance(
      task({ lastError: 'npm run verify failed (exit 1). See command output.' }),
      [ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }), relayRecord({ outcome: 'failed', outputSummary: ' FAIL  tests/a.test.ts\n Test Files  1 failed' })]
    );

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification to diagnose' });
    expect(JSON.stringify(value)).not.toContain('run_implementation');
  });

  it('a timed-out Relay verification is recovered by running verification, and says it timed out', () => {
    const value = guidance(
      task(),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1 }),
        relayRecord({ exitCode: null, reason: 'Verification timed out; success was not established.', outcome: 'timed_out' })
      ]
    );

    // A record with no classification fails closed: the timeout is named, and the one action is diagnostic.
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification to diagnose' });
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'timed_out', exitCode: null });
    expect(value.happened).toBe('Agent Relay ran verification and it did not finish within its time limit.');
    expect('secondaryAction' in value).toBe(false);
  });

  it('a later Relay verification is the latest event: it is not masked by the earlier round having hit its time limit', () => {
    // The live sequence: the implementation round ended on limit_deadline_exceeded; the operator then pressed
    // Run verification and Relay's own verification timed out (no exit code). The screen must say THAT.
    const value = guidance(
      task({ lastError: 'Verification timed out; success was not established.' }),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, reasonCodes: ['limit_deadline_exceeded'], attempts: [attempt()] }),
        relayRecord({ exitCode: null, reason: 'Verification timed out; success was not established.', outcome: 'timed_out' })
      ]
    );

    expect(value.happened).toBe('Agent Relay ran verification and it did not finish within its time limit.');
    expect(value.happened).not.toContain('time limit expired'); // the implementation round's deadline is history
    expect(value.result).toContain('Verification timed out; success was not established.');
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'timed_out', exitCode: null });
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification to diagnose' });
  });

  it('explains a Relay verification from Relay’s own record, not from an earlier Ornith round’s attempt, when the task has no error text', () => {
    const value = guidance(
      task({ lastError: null }),
      [
        ornithRun({ changedFiles: 1, worktreeChangedFiles: 1, reasonCodes: ['limit_deadline_exceeded'], attempts: [attempt()] }),
        relayRecord({ exitCode: null, reason: 'Verification cancelled; success was not established.', outcome: 'cancelled' })
      ]
    );

    expect(value.result).toContain('Verification cancelled; success was not established.');
    expect(value.result).not.toContain('exited with code 1'); // the old Ornith attempt's words
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
  it('offers verification, and only verification, for a Claude attempt too', () => {
    const value = runGuidance(
      task({ implementationProvider: 'claude' }),
      [run({ agent: 'claude', status: 'failed' })],
      true
    );

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expect('secondaryAction' in value).toBe(false);
    expect(JSON.stringify(value)).not.toContain('Retry implementation');
  });
});

describe('exactly one action, from a fixed set, in every recovery combination', () => {
  const VERIFICATION_STAGE_LABELS = new Set(['Run verification', 'Run verification again', 'Run verification to diagnose']);
  const IMPLEMENTATION_STAGE_LABELS = new Set(
    ['Ornith', 'Claude', 'Codex'].flatMap((provider) => [`Fix verification failures · ${provider}`, `Retry implementation · ${provider}`, `Run implementation · ${provider}`])
  );

  it('never returns a second action, never a label outside the set, and never a retry of the implementation while verification is the stage', () => {
    const attemptSets: (readonly OrnithVerificationAttempt[])[] = [
      [],
      [attempt()],
      [attempt({ outcome: 'timed_out', exitCode: null })],
      [attempt({ outcome: 'not_run', exitCode: null, durationMs: 0, summary: '', code: 'verification_repeat_refused' })]
    ];
    const relayRecords: (Record<string, unknown> | null)[] = [
      null,
      {},
      { failureKind: 'implementation' },
      { failureKind: 'infrastructure' },
      { failureKind: 'unknown' },
      { failureKind: 'output_limit', exitCode: null },
      { failureKind: 'cancelled', exitCode: null, outcome: 'cancelled' }
    ];
    for (const provider of ['ornith', 'claude', 'codex'] as const) {
      for (const attempts of attemptSets) {
        for (const changedFiles of [0, 1]) {
          for (const reasonCodes of [[], ['limit_deadline_exceeded']]) {
            for (const relay of relayRecords) {
              const runs = [
                ornithRun({ changedFiles, worktreeChangedFiles: changedFiles, attempts, reasonCodes }),
                ...(relay === null ? [] : [relayRecord(relay)])
              ];
              const value = runGuidance(
                task({ implementationProvider: provider }),
                runs, true, false, 'not_required', { ornithLocalInferenceState: 'healthy' }
              );
              expectConsistent(value);
              if (relay?.['failureKind'] === 'output_limit') {
                // A gated state with no readiness read yet is a WAITING state: no control at all, never a guess.
                expect(value.action, JSON.stringify({ provider, changedFiles, reasonCodes, relay })).toBeNull();
                expect(value.next).toContain('Checking whether the files or the verification settings changed');
                continue;
              }
              expect(value.action, JSON.stringify({ provider, changedFiles, reasonCodes, relay })).not.toBeNull();
              expect('secondaryAction' in value).toBe(false);
              const label = value.action!.label;
              expect(VERIFICATION_STAGE_LABELS.has(label) || IMPLEMENTATION_STAGE_LABELS.has(label), label).toBe(true);
              // Verification is the stage whenever the action is a verification: no implementation retry may
              // appear anywhere in the guidance then, in any field.
              if (VERIFICATION_STAGE_LABELS.has(label)) expect(JSON.stringify(value)).not.toContain('Retry implementation');
              // A generic retry of the implementation is offered only when there is provably nothing to verify.
              if (label.startsWith('Retry implementation')) expect(changedFiles).toBe(0);
              // A repair is offered only on a classified failure of the files.
              if (label.startsWith('Fix verification failures')) expect(relay?.['failureKind']).toBe('implementation');
            }
          }
        }
      }
    }
  });
});
