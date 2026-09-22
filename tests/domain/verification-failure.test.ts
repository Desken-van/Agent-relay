import { describe, expect, it } from 'vitest';
import { classifyVerificationFailure, type VerificationFailureInput } from '../../src/shared/domain/verification-failure';
import { runSchema } from '../../src/shared/domain/models';
import { verificationFailureKind, verificationNeedsImplementationRepair } from '../../src/shared/domain/verification';
import {
  BUILD_FAILURE_OUTPUT,
  ESLINT_FAILURE_OUTPUT,
  PLANTED_PATH,
  PLANTED_SECRET,
  REACT_PRODUCTION_ACT_OUTPUT,
  TYPECHECK_FAILURE_OUTPUT,
  VITEST_ASSERTION_FAILURE_OUTPUT,
  VITEST_MIXED_FAILURE_OUTPUT,
  VITEST_TEST_OWN_TIMEOUT_OUTPUT,
  VITEST_WORKER_TIMEOUT_OUTPUT
} from '../helpers/verification-output-fixtures';

const failed = (output: string, overrides: Partial<VerificationFailureInput> = {}): VerificationFailureInput => ({
  outcome: 'failed',
  exitCode: 1,
  durationMs: 580_014,
  output,
  ...overrides
});

describe('classifyVerificationFailure', () => {
  it('reads the live failure — a Vitest worker the pool stopped hearing from — as a retryable infrastructure failure', () => {
    const classified = classifyVerificationFailure(failed(VITEST_WORKER_TIMEOUT_OUTPUT));

    expect(classified.kind).toBe('infrastructure');
    expect(classified.reason).toContain('a Vitest worker stopped answering (worker timeout)');
    expect(classified.reason).toContain('not of the current files');
  });

  it('reads a command the process layer stopped at the output retention limit as output_limit — before the exit code, and whatever the retained part says', () => {
    const overflowed = `${VITEST_ASSERTION_FAILURE_OUTPUT}\n${PLANTED_SECRET}\n${PLANTED_PATH}\n${'x'.repeat(10_000)}`;
    const classified = classifyVerificationFailure(failed(overflowed, { exitCode: null, outputLimitExceeded: true, outputLimitBytes: 2_000_000 }));

    expect(classified.kind).toBe('output_limit');
    expect(classified.reason).toBe(
      "Verification output exceeded Agent Relay's configured retention limit (2000k characters per run), so the result could not be " +
        'classified safely: the command was stopped at the limit and only the output up to it was kept. Raise "Stored log budget" in ' +
        'Settings or reduce what npm run verify prints; running it again unchanged would stop at the same limit.'
    );
    expect(classified.reason).not.toContain(PLANTED_SECRET);
    expect(classified.reason).not.toContain(PLANTED_PATH);
    expect(classified.reason).not.toContain('AssertionError');
    // Never the ordinary "ended without an exit code" reading, which would invite a plain re-run.
    expect(classified.reason).not.toContain('not a failure of the current files');
    // The same result without the flag IS that reading: the flag is what tells them apart.
    expect(classifyVerificationFailure(failed(overflowed, { exitCode: null })).kind).toBe('infrastructure');
    // A caller that does not know the limit's value gets the same sentence without it.
    expect(classifyVerificationFailure(failed('', { exitCode: null, outputLimitExceeded: true })).reason).toContain('retention limit, so the result');
    // Only a cancellation outranks it.
    expect(classifyVerificationFailure(failed('', { outcome: 'cancelled', exitCode: null, outputLimitExceeded: true })).kind).toBe('cancelled');
  });

  it.each([
    ['a test assertion', VITEST_ASSERTION_FAILURE_OUTPUT, 'a test assertion failed'],
    ['a TypeScript error', TYPECHECK_FAILURE_OUTPUT, 'the TypeScript check reported errors'],
    ['an ESLint error', ESLINT_FAILURE_OUTPUT, 'ESLint reported errors'],
    ['a build error', BUILD_FAILURE_OUTPUT, 'the build failed']
  ])('reads %s as an actionable failure of the current files', (_label, output, expected) => {
    const classified = classifyVerificationFailure(failed(output));

    expect(classified.kind).toBe('implementation');
    expect(classified.reason).toBe(`npm run verify failed (exit 1): ${expected}. The current files did not pass.`);
  });

  it('lets a real assertion failure stand even when a runner failure happened beside it', () => {
    const classified = classifyVerificationFailure(failed(VITEST_MIXED_FAILURE_OUTPUT));

    expect(classified.kind).toBe('implementation');
    expect(classified.reason).toContain('a test assertion failed');
  });

  it('fails closed on a TypeError thrown inside node_modules with no assertion, lint, type or build error to name (the React production-build failure)', () => {
    const classified = classifyVerificationFailure(failed(REACT_PRODUCTION_ACT_OUTPUT));

    expect(classified.kind).toBe('unknown');
    expect(classified.reason).toBe('npm run verify failed (exit 1), but the output does not show which check failed or why.');
  });

  it('fails closed on a test that exceeded its own budget: the output cannot say whether the test hung or the machine was slow', () => {
    expect(classifyVerificationFailure(failed(VITEST_TEST_OWN_TIMEOUT_OUTPUT)).kind).toBe('unknown');
  });

  it('fails closed on empty output and on a nonzero exit that says nothing', () => {
    expect(classifyVerificationFailure(failed('')).kind).toBe('unknown');
    expect(classifyVerificationFailure(failed('some unrelated chatter\nnothing failed here\n', { exitCode: 2 })).kind).toBe('unknown');
  });

  it('never treats a bare "Error:" or a generic failing-test marker as proof the files are at fault', () => {
    expect(classifyVerificationFailure(failed(' FAIL  tests/a.test.ts > x\nError: something went wrong\n Tests  1 failed | 3 passed (4)')).kind).toBe('unknown');
  });

  it('reads a command that ended without an exit code, and was neither timed out nor cancelled, as a process-start failure', () => {
    const classified = classifyVerificationFailure(failed('', { exitCode: null }));

    expect(classified.kind).toBe('infrastructure');
    expect(classified.reason).toContain('ended without an exit code');
  });

  it("reads Agent Relay's own command timeout as unknown: a hung check and a slow machine look alike", () => {
    const classified = classifyVerificationFailure(failed(VITEST_WORKER_TIMEOUT_OUTPUT, { outcome: 'timed_out', exitCode: null, durationMs: 1_800_000 }));

    expect(classified.kind).toBe('unknown');
    expect(classified.reason).toContain('Verification timed out; success was not established.');
    expect(classified.reason).toContain('30m00s');
  });

  it('reads a cancellation as cancelled, whatever the output holds', () => {
    expect(classifyVerificationFailure(failed(VITEST_ASSERTION_FAILURE_OUTPUT, { outcome: 'cancelled', exitCode: null })))
      .toEqual({ kind: 'cancelled', reason: 'Verification cancelled; success was not established.' });
  });

  it('reads files that changed under a running verification as retryable, even when the command passed', () => {
    const classified = classifyVerificationFailure(failed('', { outcome: 'failed', exitCode: 0, identityChanged: true }));

    expect(classified.kind).toBe('infrastructure');
    expect(classified.reason).toContain('changed while verification was running');
  });

  it('never puts a line of the command output — a path, a token, a test name — into its reason', () => {
    for (const output of [VITEST_WORKER_TIMEOUT_OUTPUT, VITEST_ASSERTION_FAILURE_OUTPUT, REACT_PRODUCTION_ACT_OUTPUT, ESLINT_FAILURE_OUTPUT]) {
      const { reason } = classifyVerificationFailure(failed(output));
      expect(reason).not.toContain(PLANTED_PATH);
      expect(reason).not.toContain(PLANTED_SECRET);
      expect(reason).not.toContain('ornith-worktree-tools');
      expect(reason).not.toContain('React.act');
      expect(reason.length).toBeLessThan(400);
    }
  });

  it('decides from a bounded window: a signature buried in the middle of a huge log is not seen, and the cost is flat', () => {
    const middle = `${'noise\n'.repeat(400_000)}${VITEST_WORKER_TIMEOUT_OUTPUT}${'noise\n'.repeat(400_000)}`;
    const startedAt = performance.now();
    const classified = classifyVerificationFailure(failed(middle));
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(classified.kind).toBe('unknown'); // fail closed, never a guess
  });
});

describe('what a stored verification run is read back as', () => {
  const verificationRun = (structuredResult: unknown, status: 'failed' | 'cancelled' | 'succeeded' = 'failed') =>
    runSchema.parse({
      id: 'v', taskId: 't', agent: 'system', runType: 'verification', status, round: 1,
      startedAt: '2026-09-22T11:00:09.294Z', finishedAt: '2026-09-22T11:09:55.581Z',
      finalMessage: null, errorMessage: null,
      structuredResult: structuredResult === null ? null : JSON.stringify(structuredResult)
    });
  const record = (overrides: Record<string, unknown>) => ({
    version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false,
    exitCode: 1, durationMs: 580_014, reason: 'npm run verify failed (exit 1).', outcome: 'failed', ...overrides
  });

  it('follows the recorded kind, and only an implementation failure supplies repair evidence', () => {
    for (const kind of ['implementation', 'infrastructure', 'output_limit', 'cancelled', 'unknown'] as const) {
      const run = verificationRun(record({ failureKind: kind }));
      expect(verificationFailureKind(run)).toBe(kind);
      expect(verificationNeedsImplementationRepair(run)).toBe(kind === 'implementation');
    }
  });

  it('fails closed on a record written before classification existed: unknown, never a repair', () => {
    const legacy = verificationRun(record({}));
    expect(verificationFailureKind(legacy)).toBe('unknown');
    expect(verificationNeedsImplementationRepair(legacy)).toBe(false);
  });

  it('keeps a legacy cancellation as cancelled', () => {
    expect(verificationFailureKind(verificationRun(record({ exitCode: null, outcome: 'cancelled' })))).toBe('cancelled');
    expect(verificationFailureKind(verificationRun(record({ exitCode: null }), 'cancelled'))).toBe('cancelled');
  });

  it('is null for a pass and for a non-verification run, and unknown for an unreadable record', () => {
    expect(verificationFailureKind(verificationRun(record({ passed: true, exitCode: 0, reason: null, outcome: 'passed' }), 'succeeded'))).toBeNull();
    expect(verificationFailureKind(null)).toBeNull();
    expect(verificationFailureKind(verificationRun(null))).toBe('unknown');
    expect(verificationFailureKind(verificationRun({ version: 2 }))).toBe('unknown');
  });
});
