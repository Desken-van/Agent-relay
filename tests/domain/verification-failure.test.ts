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
import {
  NODE_TEST_ASSERTION_SPEC,
  NODE_TEST_DEPENDENCY_MISSING_EXPORT_SPEC,
  NODE_TEST_DEPENDENCY_SYNTAX_ERROR_SPEC,
  NODE_TEST_DUPLICATE_DECLARATION_DOT,
  NODE_TEST_DUPLICATE_DECLARATION_SPEC,
  NODE_TEST_DUPLICATE_DECLARATION_TAP,
  NODE_TEST_MISSING_EXPORT_SPEC,
  NODE_TEST_MISSING_EXPORT_TAP,
  NODE_TEST_MISSING_PACKAGE_SPEC,
  NODE_TEST_OTHER_SYNTAX_ERROR_SPEC
} from '../helpers/node-test-output-fixtures';
import { summarizeVerificationOutput } from '../../src/shared/domain/ornith-verification';

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

  it('preserves a mixed failure as unconfirmed and offers bounded diagnosis before repair', () => {
    const classified = classifyVerificationFailure(failed(VITEST_MIXED_FAILURE_OUTPUT));

    expect(classified.kind).toBe('unknown');
    expect(classified.reason).toContain('checks failed and the test runner also failed');
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

  it('routes old implementation records containing worker failures to diagnosis without modifying stored evidence', () => {
    for (const summary of [VITEST_WORKER_TIMEOUT_OUTPUT.slice(-1_500), 'AssertionError: mismatch\nError: [vitest-pool]: Failed to start forks worker']) {
      const run = verificationRun(record({ failureKind: 'implementation', outputSummary: summary }));
      const original = run.structuredResult;
      expect(verificationFailureKind(run)).toBe('unknown');
      expect(verificationNeedsImplementationRepair(run)).toBe(false);
      expect(run.structuredResult).toBe(original);
    }
  });

  it('fails closed on a record written before classification existed: unknown, never a repair' , () => {
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

it('recognizes the live Electron installation failure without sending it to an implementation agent', () => {
  const output = "Error: Electron failed to install correctly. Please delete node_modules/electron";
  expect(classifyVerificationFailure(failed(output)).kind).toBe('infrastructure');
  const run = runSchema.parse({ id: 'legacy-electron', taskId: 't', agent: 'system', runType: 'verification', status: 'failed', round: 1,
    startedAt: '2026-10-05T14:43:54.281Z', finishedAt: '2026-10-05T15:07:36.803Z', finalMessage: null, errorMessage: null,
    structuredResult: JSON.stringify({version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false,
      exitCode: 1, durationMs: 1000, reason: 'unknown', outcome: 'failed', failureKind: 'unknown', outputSummary: output}) });
  expect(verificationFailureKind(run)).toBe('infrastructure');
});
it('keeps an Electron installation error mixed with a real assertion as unknown', () => {
  expect(classifyVerificationFailure(failed('Error: Electron failed to install correctly.\nAssertionError: wrong result')).kind).toBe('unknown');
});

it('names an Electron preflight refusal before the command starts without leaking paths', () => {
  const result = classifyVerificationFailure(failed('Electron is missing or incomplete. Repair dependencies.', { exitCode: null, durationMs: 0 }));
  expect(result.kind).toBe('infrastructure');
  expect(result.reason).toContain('installed Electron runtime');
  expect(result.reason).toContain('Repair');
});

describe('node:test failures (Node v26 output captured from real runs)', () => {
  const root = '/work/agent-relay/worktrees/t1-add-whisper';
  const inWorktree = (output: string, overrides: Partial<VerificationFailureInput> = {}) =>
    classifyVerificationFailure(failed(output, { worktreeRoots: [root], ...overrides }));

  it.each([
    ['a duplicate declaration (spec)', NODE_TEST_DUPLICATE_DECLARATION_SPEC, 'a project file declares the same name twice'],
    ['a duplicate declaration (tap)', NODE_TEST_DUPLICATE_DECLARATION_TAP, 'a project file declares the same name twice'],
    ['a missing export (spec)', NODE_TEST_MISSING_EXPORT_SPEC, 'a project module does not export a name that is imported from it'],
    ['a missing export (tap)', NODE_TEST_MISSING_EXPORT_TAP, 'a project module does not export a name that is imported from it']
  ])('reads %s located in the worktree as a failure of the current files', (_label, fixture, expected) => {
    const classified = inWorktree(fixture(root));
    expect(classified.kind).toBe('implementation');
    expect(classified.reason).toBe(`npm run verify failed (exit 1): node:test could not load a test because ${expected}. The current files did not pass.`);
    expect(classified.reason).not.toContain(root);
    expect(classified.reason).not.toContain('whisper');
  });

  it('reads a node:test assertion as a failure of the current files', () => {
    expect(inWorktree(NODE_TEST_ASSERTION_SPEC(root))).toMatchObject({ kind: 'implementation', reason: expect.stringContaining('a test assertion failed') });
  });

  it('accepts the resolved spelling of the worktree and a Windows file URL', () => {
    expect(classifyVerificationFailure(failed(NODE_TEST_DUPLICATE_DECLARATION_SPEC('/real/wt'), { worktreeRoots: ['/link/wt', '/real/wt'] })).kind)
      .toBe('implementation');
    const windows = NODE_TEST_DUPLICATE_DECLARATION_SPEC('C:\\Users\\someone\\wt');
    expect(windows).toContain('file:///C:/Users/someone/wt/src/strings.js:3');
    expect(classifyVerificationFailure(failed(windows, { worktreeRoots: ['C:\\Users\\someone\\wt'] })).kind).toBe('implementation');
  });

  it.each([
    ['the module error is located outside the worktree', NODE_TEST_DUPLICATE_DECLARATION_SPEC('/elsewhere/checkout')],
    ['the dot reporter kept only "test failed"', NODE_TEST_DUPLICATE_DECLARATION_DOT(root)],
    ['a package is not installed (the environment)', NODE_TEST_MISSING_PACKAGE_SPEC(root)],
    ['the duplicate declaration is inside node_modules', NODE_TEST_DEPENDENCY_SYNTAX_ERROR_SPEC(root)],
    ['the missing export is requested from a package', NODE_TEST_DEPENDENCY_MISSING_EXPORT_SPEC(root)],
    ['another kind of SyntaxError (which might be this Node rejecting new syntax)', NODE_TEST_OTHER_SYNTAX_ERROR_SPEC(root)]
  ])('stays unknown when %s', (_label, output) => {
    expect(inWorktree(output)).toEqual({ kind: 'unknown', reason: 'npm run verify failed (exit 1), but the output does not show which check failed or why.' });
  });

  it('never reads a node:test module error as the files\' own without knowing the worktree', () => {
    expect(classifyVerificationFailure(failed(NODE_TEST_DUPLICATE_DECLARATION_SPEC(root))).kind).toBe('unknown');
    expect(classifyVerificationFailure(failed(NODE_TEST_DUPLICATE_DECLARATION_SPEC(root), { worktreeRoots: [] })).kind).toBe('unknown');
    expect(classifyVerificationFailure(failed(NODE_TEST_DUPLICATE_DECLARATION_SPEC(root), { worktreeRoots: ['/'] })).kind).toBe('unknown');
  });

  it('stays unknown on insufficient output: the message without its location, or without node:test reporting a failure', () => {
    const lines = NODE_TEST_DUPLICATE_DECLARATION_SPEC(root).split('\n');
    expect(inWorktree(lines.filter((line) => !line.startsWith('file://')).join('\n')).kind).toBe('unknown');
    expect(inWorktree(lines.filter((line) => !/^ℹ fail /.test(line)).join('\n')).kind).toBe('unknown');
    expect(inWorktree("SyntaxError: Identifier 'whisper' has already been declared").kind).toBe('unknown');
  });

  it('stays unknown when a confirmed module error is mixed with an unconfirmed one or with an environment error', () => {
    expect(inWorktree(`${NODE_TEST_DUPLICATE_DECLARATION_SPEC(root)}\n${NODE_TEST_DEPENDENCY_SYNTAX_ERROR_SPEC(root)}`).kind).toBe('unknown');
    expect(inWorktree(`${NODE_TEST_MISSING_EXPORT_SPEC(root)}\n${NODE_TEST_MISSING_PACKAGE_SPEC(root)}`).kind).toBe('unknown');
    expect(inWorktree(`${NODE_TEST_MISSING_EXPORT_SPEC(root)}\n${NODE_TEST_OTHER_SYNTAX_ERROR_SPEC(root)}`).kind).toBe('unknown');
  });

  it('keeps a test-runner failure beside it as a mixed, unconfirmed result', () => {
    const classified = inWorktree(`${NODE_TEST_DUPLICATE_DECLARATION_SPEC(root)}\nError: [vitest-pool]: Failed to start forks worker for test files a.test.ts.`);
    expect(classified.kind).toBe('unknown');
    expect(classified.reason).toContain('checks failed and the test runner also failed');
  });

  it('keeps the safety order: cancellation, the output limit, changed files and a timeout outrank the evidence', () => {
    const output = NODE_TEST_DUPLICATE_DECLARATION_SPEC(root);
    expect(inWorktree(output, { outcome: 'cancelled', exitCode: null }).kind).toBe('cancelled');
    expect(inWorktree(output, { outputLimitExceeded: true }).kind).toBe('output_limit');
    expect(inWorktree(output, { identityChanged: true }).kind).toBe('infrastructure');
    expect(inWorktree(output, { outcome: 'timed_out', exitCode: null }).kind).toBe('unknown');
    expect(inWorktree(output, { exitCode: null }).kind).toBe('infrastructure');
  });

  it('summarizes the module error with its project-relative location and no machine path', () => {
    for (const [fixture, location, message] of [
      [NODE_TEST_DUPLICATE_DECLARATION_SPEC, 'src/strings.js:3', "SyntaxError: Identifier 'whisper' has already been declared"],
      [NODE_TEST_MISSING_EXPORT_TAP, '# test/strings.test.js:3', "# SyntaxError: The requested module '../src/strings.js' does not provide an export named 'whisper'"]
    ] as const) {
      const summary = summarizeVerificationOutput(fixture(root), undefined, { worktreeRoots: [root] });
      const lines = summary.split('\n');
      expect(lines.indexOf(location)).toBeGreaterThanOrEqual(0);
      expect(lines.indexOf(message)).toBe(lines.indexOf(location) + 1);
      expect(summary).not.toContain(root);
      expect(summary).not.toContain('file://');
      // Re-bounding the stored summary (as the repair prompt does) keeps both lines.
      expect(summarizeVerificationOutput(summary)).toContain(`${location}\n${message}`);
    }
    // The same on a Windows worktree and under a directory whose name Node percent-encodes in the URL.
    for (const otherRoot of ['C:\\repo\\worktrees\\task', 'C:\\Users\\some one\\wt', '/work/some one/wt']) {
      const summary = summarizeVerificationOutput(NODE_TEST_DUPLICATE_DECLARATION_SPEC(otherRoot), undefined, { worktreeRoots: [otherRoot] });
      expect(summary, otherRoot).toContain("src/strings.js:3\nSyntaxError: Identifier 'whisper' has already been declared");
      expect(summary).not.toContain('file://');
      expect(summary).not.toMatch(/some one|some%20one|repo|Users/);
    }
    // Node percent-encodes "#", "?" and "%" in a module URL, which encodeURI does not reproduce: the URL is
    // decoded and compared as the path it names (real `node --test` output under such a directory checked too).
    for (const specialRoot of ['/work/hash#dir/wt', '/work/q?dir/wt', '/work/pct%41dir/wt', 'C:\\Users\\a#b c\\wt']) {
      const output = NODE_TEST_DUPLICATE_DECLARATION_SPEC(specialRoot);
      expect(output).toMatch(/%23|%3F|%25/);
      expect(classifyVerificationFailure(failed(output, { worktreeRoots: [specialRoot] })).kind, specialRoot).toBe('implementation');
      const summary = summarizeVerificationOutput(output, undefined, { worktreeRoots: [specialRoot] });
      expect(summary, specialRoot).toContain("src/strings.js:3\nSyntaxError: Identifier 'whisper' has already been declared");
      expect(summary).not.toMatch(/file:|hash|q\?dir|pct|Users|%2[35]|%3F/);
    }
    // A URL outside the worktree, however it is encoded, is still omitted, never shortened.
    const outside = summarizeVerificationOutput(NODE_TEST_DUPLICATE_DECLARATION_SPEC('/work/hash#dir/other'), undefined, { worktreeRoots: ['/work/hash#dir/wt'] });
    expect(outside).not.toContain('src/strings.js:3');
    expect(outside).not.toMatch(/file:|hash/);
    // Without the worktree, the location is a machine path and is omitted like any other.
    const unrooted = summarizeVerificationOutput(NODE_TEST_DUPLICATE_DECLARATION_SPEC(root));
    expect(unrooted).not.toContain(root);
    expect(unrooted).not.toContain('file://');
    expect(unrooted).toContain("SyntaxError: Identifier 'whisper' has already been declared");
  });
});
