import { describe, expect, it } from 'vitest';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';
import {
  classifyVerificationExecution,
  describeUnverifiedOrnithOutcome,
  describeVerificationAttempt,
  formatVerificationDuration,
  isOrnithVerificationEventData,
  latestExecutedAttempt,
  ornithVerificationAttemptSchema,
  ornithVerificationStatus,
  readOrnithRunEvidence,
  summarizeVerificationOutput,
  type OrnithVerificationAttempt
} from '../../src/shared/domain/ornith-verification';
import { cancelledExecution, failedExecution, passedExecution, timedOutExecution } from '../helpers/ornith-verification';

function attempt(overrides: Partial<OrnithVerificationAttempt> = {}): OrnithVerificationAttempt {
  return {
    sequence: 2,
    command: 'npm run verify',
    outcome: 'failed',
    exitCode: 1,
    durationMs: 511_795,
    reason: 'npm run verify exited with code 1 after 8m32s.',
    summary: 'Test Files  1 failed | 118 passed (119)',
    code: null,
    fingerprint: 'abc123',
    ...overrides
  };
}

const notRun = (overrides: Partial<OrnithVerificationAttempt> = {}): OrnithVerificationAttempt =>
  attempt({
    outcome: 'not_run',
    exitCode: null,
    durationMs: 0,
    reason: 'Only 1m of the implementation time budget remain.',
    summary: '',
    code: 'limit_verification_time_insufficient',
    ...overrides
  });

describe('classifyVerificationExecution', () => {
  const roomy = { budgetExpired: false, budgetMs: 600_000 };

  it('passes only a clean exit 0', () => {
    expect(classifyVerificationExecution(passedExecution(), roomy)).toEqual({ outcome: 'passed', reason: null });
  });

  it('reports a nonzero exit as failed, with the code and the duration in the reason', () => {
    const classified = classifyVerificationExecution(failedExecution(1, 511_795), roomy);
    expect(classified.outcome).toBe('failed');
    expect(classified.reason).toBe('npm run verify exited with code 1 after 8m32s.');
  });

  it('reports a failure that has no exit code as failed rather than passing or timing out', () => {
    const classified = classifyVerificationExecution(
      { exitCode: null, failed: true, timedOut: false, cancelled: false, durationMs: 40, output: '' },
      roomy
    );
    expect(classified.outcome).toBe('failed');
    expect(classified.reason).toContain('without an exit code');
  });

  it('reports the command’s own timeout as timed_out, distinct from the loop budget running out', () => {
    const own = classifyVerificationExecution(timedOutExecution(600_000), roomy);
    expect(own.outcome).toBe('timed_out');
    expect(own.reason).toContain('exceeded its own timeout after 10m00s');

    const budget = classifyVerificationExecution(cancelledExecution(300_000), { budgetExpired: true, budgetMs: 300_000 });
    expect(budget.outcome).toBe('timed_out');
    expect(budget.reason).toContain('implementation time budget');
  });

  it('reports an abort that is not the budget as cancelled', () => {
    expect(classifyVerificationExecution(cancelledExecution(), roomy).outcome).toBe('cancelled');
  });

  it('never passes a zero exit that the loop’s budget cut short', () => {
    const classified = classifyVerificationExecution(passedExecution(300_000), { budgetExpired: true, budgetMs: 300_000 });
    expect(classified.outcome).toBe('timed_out');
  });

  it('never passes a zero exit that the process layer flagged as failed', () => {
    const flagged = { ...passedExecution(), failed: true };
    expect(classifyVerificationExecution(flagged, roomy).outcome).toBe('failed');
  });
});

describe('summarizeVerificationOutput', () => {
  it('is empty for empty or whitespace-only output', () => {
    expect(summarizeVerificationOutput('')).toBe('');
    expect(summarizeVerificationOutput('  \n\t\n')).toBe('');
  });

  it('keeps the failing lines and the tail, in that order, and elides what lies between', () => {
    const noise = Array.from({ length: 400 }, (_, index) => `ok line ${index}`);
    const raw = [
      ...noise.slice(0, 200),
      ' FAIL  tests/adapters/ornith-worktree-tools.test.ts > native guard',
      'AssertionError: expected timeout to be stale_hash',
      ...noise.slice(200),
      ' Test Files  1 failed | 118 passed (119)'
    ].join('\n');
    const summary = summarizeVerificationOutput(raw);
    const lines = summary.split('\n');
    expect(lines[0]).toContain('FAIL  tests/adapters/ornith-worktree-tools.test.ts');
    expect(summary).toContain('AssertionError: expected timeout to be stale_hash');
    expect(lines).toContain('…');
    expect(lines.at(-1)).toContain('Test Files  1 failed | 118 passed (119)');
    expect(summary).not.toContain('ok line 5');
  });

  it('is bounded by the default limit for arbitrarily large output', () => {
    const summary = summarizeVerificationOutput('x'.repeat(5_000_000));
    expect(summary.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxVerificationSummaryChars);
  });

  it('examines only a bounded head and tail of a huge log: failures at either end survive, one lost in the middle does not', () => {
    const noise = 'noise line\n'.repeat(300_000); // ~3.3 MB
    const raw = [
      'FAIL  head.test.ts > announced first\n',
      noise,
      'FAIL  middle-lost.test.ts > buried\n',
      noise,
      'FAIL  tail.test.ts > reported last\n',
      ' Test Files  2 failed | 1 passed (3)'
    ].join('');
    const summary = summarizeVerificationOutput(raw);

    expect(summary).toContain('head.test.ts');
    expect(summary).toContain('tail.test.ts');
    expect(summary).toContain('Test Files  2 failed');
    expect(summary).not.toContain('middle-lost.test.ts');
    expect(summary.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxVerificationSummaryChars);
  });

  it('honours a smaller explicit limit, keeping the end of the output', () => {
    // Two 100-character lines (under the per-line clip) cannot both fit in 120 characters.
    const summary = summarizeVerificationOutput(`${'a'.repeat(100)}\n${'b'.repeat(100)}`, 120);
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith('b'.repeat(100))).toBe(true);
  });

  it('bounds every line, however long a single line is', () => {
    const summary = summarizeVerificationOutput(`FAIL ${'y'.repeat(50_000)}`);
    for (const line of summary.split('\n')) expect(line.length).toBeLessThanOrEqual(200);
  });

  it('removes ANSI escapes and control characters but keeps line structure', () => {
    const esc = String.fromCharCode(27);
    const raw = `${esc}[31mFAIL${esc}[39m  tests/a.test.ts\r\nbell${String.fromCharCode(7)}here\r\n${esc}[2K${esc}[1Gdone`;
    const summary = summarizeVerificationOutput(raw);
    expect(summary).toBe('FAIL  tests/a.test.ts\nbellhere\ndone');
    expect(summary).not.toContain(esc);
  });

  it('redacts credentials before anything is kept', () => {
    const token = `ghp_${'A1b2C3d4E5f6G7h8'}`;
    const raw = [
      `fetch failed for https://user:hunter2secret@example.invalid/repo.git`,
      `GITHUB_TOKEN=${token}`,
      `Authorization: Bearer abcdefghijklmnop1234`,
      `sk-${'q'.repeat(30)}`
    ].join('\n');
    const summary = summarizeVerificationOutput(raw);
    expect(summary).not.toContain(token);
    expect(summary).not.toContain('hunter2secret');
    expect(summary).not.toContain('abcdefghijklmnop1234');
    expect(summary).not.toContain('q'.repeat(30));
    expect(summary).toContain('[redacted]');
  });

  it('omits absolute machine paths of every shape', () => {
    const raw = [
      'at C:\\Users\\someone\\project\\src\\file.ts:10',
      'at /home/someone/project/src/file.ts:10',
      'at \\\\server\\share\\project\\file.ts:10',
      ' FAIL  tests/relative/file.test.ts'
    ].join('\n');
    const summary = summarizeVerificationOutput(raw);
    expect(summary).not.toMatch(/someone/);
    expect(summary).not.toMatch(/server\\share/);
    expect(summary).toContain('[absolute-path-omitted]');
    expect(summary).toContain('tests/relative/file.test.ts'); // a repository-relative path is evidence, not a leak
  });
});

describe('verification attempts as recorded', () => {
  it('describes each outcome in one sentence with the command and the time', () => {
    expect(describeVerificationAttempt(attempt({ outcome: 'passed', reason: null, exitCode: 0, durationMs: 90_000 })))
      .toBe('Verification passed (npm run verify, 1m30s).');
    expect(describeVerificationAttempt(attempt())).toBe('npm run verify exited with code 1 after 8m32s.');
    expect(describeVerificationAttempt(attempt({ outcome: 'timed_out', reason: null, exitCode: null, durationMs: 300_000 })))
      .toBe('Verification timed out: npm run verify was stopped after 5m00s.');
    expect(describeVerificationAttempt(attempt({ outcome: 'cancelled', reason: null, exitCode: null })))
      .toContain('Verification was cancelled');
    expect(describeVerificationAttempt(notRun())).toBe(
      'Verification was not started: Only 1m of the implementation time budget remain.'
    );
  });

  it('formats durations in the same words everywhere', () => {
    expect(formatVerificationDuration(320)).toBe('320ms');
    expect(formatVerificationDuration(45_000)).toBe('45s');
    expect(formatVerificationDuration(511_795)).toBe('8m32s');
    expect(formatVerificationDuration(Number.NaN)).toBe('unknown time');
    expect(formatVerificationDuration(-1)).toBe('unknown time');
  });

  it('accepts the stored shape and rejects an unbounded reason or summary', () => {
    expect(ornithVerificationAttemptSchema.safeParse(attempt()).success).toBe(true);
    expect(ornithVerificationAttemptSchema.safeParse(attempt({ reason: 'r'.repeat(401) })).success).toBe(false);
    expect(
      ornithVerificationAttemptSchema.safeParse(attempt({ summary: 's'.repeat(ORNITH_LIMITS.maxVerificationSummaryChars + 1) })).success
    ).toBe(false);
  });
});

describe('the status of a run’s verification', () => {
  it('is not_run when nothing ran, and when only a refusal was recorded', () => {
    expect(ornithVerificationStatus([])).toBe('not_run');
    expect(ornithVerificationStatus([notRun()])).toBe('not_run');
  });

  it('is failed after a failed or timed-out attempt, unknown after a cancelled one', () => {
    expect(ornithVerificationStatus([attempt()])).toBe('failed');
    expect(ornithVerificationStatus([attempt({ outcome: 'timed_out', exitCode: null })])).toBe('failed');
    expect(ornithVerificationStatus([attempt({ outcome: 'cancelled', exitCode: null })])).toBe('unknown');
  });

  it('lets the latest EXECUTED attempt decide, so a later refusal cannot hide a failure', () => {
    const attempts = [attempt({ sequence: 3 }), notRun({ sequence: 4 }), notRun({ sequence: 5 })];
    expect(latestExecutedAttempt(attempts)?.sequence).toBe(3);
    expect(ornithVerificationStatus(attempts)).toBe('failed');
  });

  it('never claims passed on its own: only Relay’s identity-bound verification can', () => {
    expect(ornithVerificationStatus([attempt({ outcome: 'passed', exitCode: 0, reason: null })])).toBe('not_run');
  });

  it('follows a later executed result over an earlier one', () => {
    const attempts = [attempt({ sequence: 2 }), attempt({ sequence: 5, outcome: 'passed', exitCode: 0, reason: null })];
    expect(ornithVerificationStatus(attempts)).toBe('not_run');
  });
});

describe('isOrnithVerificationEventData', () => {
  const valid = {
    sequence: 2,
    action: 'run_verification',
    ok: false,
    dispatched: true,
    verification: {
      command: 'npm run verify',
      outcome: 'failed',
      exitCode: 1,
      durationMs: 511_795,
      reason: 'npm run verify exited with code 1 after 8m32s.',
      summary: 'Test Files  1 failed'
    }
  };

  it('accepts what the loop emits, for a failed command as well as a passing one', () => {
    expect(isOrnithVerificationEventData(valid)).toBe(true);
    expect(
      isOrnithVerificationEventData({ ...valid, ok: true, verification: { ...valid.verification, outcome: 'passed', exitCode: 0, reason: null } })
    ).toBe(true);
  });

  it('rejects the legacy event shape, where "ok" only said the action ran', () => {
    expect(isOrnithVerificationEventData({ sequence: 2, action: 'run_verification', ok: true })).toBe(false);
    expect(isOrnithVerificationEventData(null)).toBe(false);
  });

  it('rejects anything the renderer would have to dereference unsafely', () => {
    expect(isOrnithVerificationEventData({ ...valid, dispatched: false })).toBe(false);
    expect(isOrnithVerificationEventData({ ...valid, verification: { ...valid.verification, outcome: 'not_run' } })).toBe(false);
    expect(isOrnithVerificationEventData({ ...valid, verification: { ...valid.verification, outcome: 'exploded' } })).toBe(false);
    expect(isOrnithVerificationEventData({ ...valid, verification: { ...valid.verification, summary: undefined } })).toBe(false);
    expect(isOrnithVerificationEventData({ ...valid, verification: { ...valid.verification, durationMs: '9' } })).toBe(false);
    expect(isOrnithVerificationEventData({ ...valid, verification: null })).toBe(false);
  });
});

describe('readOrnithRunEvidence', () => {
  const run = (structuredResult: string | null, agent = 'ornith') =>
    ({ agent, structuredResult }) as Parameters<typeof readOrnithRunEvidence>[0];

  it('reads counters, attempts and the deadline flag from a stored Ornith run', () => {
    const evidence = readOrnithRunEvidence(
      run(
        JSON.stringify({
          counters: { changedFiles: 1, worktreeChangedFiles: 1, verificationAttempts: [attempt(), notRun({ sequence: 3 })] },
          assessment: { reasonCodes: ['limit_deadline_exceeded'] }
        })
      )
    );
    expect(evidence).toMatchObject({ changedFiles: 1, worktreeChangedFiles: 1, deadlineExpired: true });
    expect(evidence?.attempts.map((item) => item.outcome)).toEqual(['failed', 'not_run']);
  });

  it('treats a run recorded before these fields existed as having none, not as an error', () => {
    const evidence = readOrnithRunEvidence(run(JSON.stringify({ counters: { changedFiles: 1 }, assessment: { reasonCodes: [] } })));
    expect(evidence).toEqual({ changedFiles: 1, worktreeChangedFiles: null, attempts: [], reasonCodes: [], deadlineExpired: false });
  });

  it('skips a damaged attempt instead of failing the read', () => {
    const evidence = readOrnithRunEvidence(
      run(JSON.stringify({ counters: { verificationAttempts: [{ outcome: 'failed' }, attempt()] } }))
    );
    expect(evidence?.attempts).toHaveLength(1);
  });

  it('never reads more attempts than a run may record', () => {
    const many = Array.from({ length: 50 }, (_, index) => attempt({ sequence: index }));
    const evidence = readOrnithRunEvidence(run(JSON.stringify({ counters: { verificationAttempts: many } })));
    expect(evidence?.attempts).toHaveLength(ORNITH_LIMITS.maxVerificationAttemptsRecorded);
  });

  it('returns null for a non-Ornith run, a missing result, and malformed JSON', () => {
    expect(readOrnithRunEvidence(run(JSON.stringify({ counters: {} }), 'codex'))).toBeNull();
    expect(readOrnithRunEvidence(run(null))).toBeNull();
    expect(readOrnithRunEvidence(run('{not json'))).toBeNull();
    expect(readOrnithRunEvidence(run('42'))).toBeNull();
  });
});

describe('describeUnverifiedOrnithOutcome', () => {
  it('says what changed, which attempt failed and why, and that nothing was discarded', () => {
    const text = describeUnverifiedOrnithOutcome({
      changedFiles: 1,
      worktreeChangedFiles: 1,
      attempts: [attempt(), attempt({ sequence: 4, outcome: 'timed_out', exitCode: null, reason: 'npm run verify was stopped after 6m00s.' })],
      deadlineExpired: true
    });
    expect(text).toContain('The Ornith implementation time limit expired.');
    expect(text).toContain('Ornith changed 1 file.');
    expect(text).toContain('npm run verify was stopped after 6m00s.'); // the LATEST executed attempt
    expect(text).toContain('preserved in the task worktree');
    expect(text).toContain('Run verification in Agent Relay');
  });

  it('names a refusal that came after the last executed attempt', () => {
    const text = describeUnverifiedOrnithOutcome({
      changedFiles: 2,
      worktreeChangedFiles: 2,
      attempts: [attempt(), notRun({ sequence: 6 })],
      deadlineExpired: false
    });
    expect(text).toContain('Ornith changed 2 files.');
    expect(text).toContain('exited with code 1');
    expect(text).toContain('Verification was not started');
  });

  it('says verification did not run when no attempt exists', () => {
    const text = describeUnverifiedOrnithOutcome({ changedFiles: 1, worktreeChangedFiles: 1, attempts: [], deadlineExpired: false });
    expect(text).toContain('Verification did not run in this round.');
  });

  it('keeps an earlier attempt’s preserved edits visible when this round changed nothing', () => {
    const text = describeUnverifiedOrnithOutcome({ changedFiles: 0, worktreeChangedFiles: 3, attempts: [], deadlineExpired: false });
    expect(text).toContain('made no new changes this round');
    expect(text).toContain('3 changed files from an earlier attempt');
    expect(text).toContain('preserved in the task worktree');
  });

  it('says no files were changed only when nothing is preserved', () => {
    const text = describeUnverifiedOrnithOutcome({ changedFiles: 0, worktreeChangedFiles: 0, attempts: [], deadlineExpired: false });
    expect(text).toContain('No files were changed.');
    expect(text).not.toContain('preserved');
  });

  it('is bounded and carries no command output or path', () => {
    const text = describeUnverifiedOrnithOutcome({
      changedFiles: 1,
      worktreeChangedFiles: 1,
      attempts: [attempt({ summary: 'SECRET-OUTPUT C:\\Users\\someone\\x' })],
      deadlineExpired: true
    });
    expect(text.length).toBeLessThan(900);
    expect(text).not.toContain('SECRET-OUTPUT');
    expect(text).not.toContain('someone');
  });
});
