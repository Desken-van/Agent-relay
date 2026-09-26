/**
 * What the Orchestrator does with an Ornith round that changed files and could not prove them verified —
 * the live failure — and how the operator gets out of it: through the real task state machine, the real
 * run and task repositories, and the real Run-screen guidance, with only the model loop and the command
 * runner faked. The loop's own behaviour is covered in `ornith-verification-recovery.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_ASSESSMENT_VERSION } from '../../src/shared/domain/claude-assessment';
import type { OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import type {
  OrnithImplementationRequest,
  OrnithImplementationResult,
  OrnithImplementationService
} from '../../src/main/services/ornith-implementation';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import type { Task } from '../../src/shared/domain/models';
import { readOrnithRunEvidence, type OrnithVerificationAttempt } from '../../src/shared/domain/ornith-verification';
import { readVerification } from '../../src/shared/domain/verification';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import { createHarness, type Harness } from '../helpers/harness';

const unusedProcessRunner: ProcessRunner = {
  run: async () => {
    throw new Error('The process runner is not exercised by these tests.');
  }
};

const lease = (): OrnithHealthyLease => ({
  runtimeInstanceId: 'runtime-1',
  providerId: 'local-llama-cpp',
  modelId: 'test-model',
  modelProfileId: 'default',
  modelProfileDisplayName: 'Local model',
  contextLimitTokens: 32_768,
  maxOutputTokens: 1_024,
  release: () => undefined,
  onIndependentStop: () => undefined
});

const leaseService: OrnithInferenceLeaseService = {
  acquireOrnithLease: async () => lease(),
  recheckOrnithLease: async () => true,
  inferForOrnith: async () => {
    throw new Error('inferForOrnith is not exercised by these tests.');
  }
};

const failedAttempt = (overrides: Partial<OrnithVerificationAttempt> = {}): OrnithVerificationAttempt => ({
  sequence: 3,
  command: 'npm run verify',
  outcome: 'failed',
  exitCode: 1,
  durationMs: 511_795,
  reason: 'npm run verify exited with code 1 after 8m32s.',
  summary: ' FAIL  tests/adapters/native.test.ts > guard\n Test Files  1 failed | 118 passed (119)',
  code: null,
  fingerprint: 'abc123',
  ...overrides
});

/**
 * The result the loop returns when the deadline ends the run after files were changed: the live shape
 * (two failed verifications recorded, a third stopped for time), with the counts the loop now reports.
 */
function deadlineAfterEditsResult(): OrnithImplementationResult {
  return {
    sessionId: null,
    finalMessage: 'The Ornith implementation loop exceeded its overall time budget.',
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: 'fail',
      verificationStatus: 'failed',
      publishBlock: 'configuration',
      reasonCodes: ['limit_deadline_exceeded'],
      verification: { tool: 'run_verification', command: 'npm run verify', matchedRule: 'ornith:run_verification', toolUseSequence: 6 },
      denials: []
    },
    ornithAudit: {
      turns: 9, actions: 8, readBytes: 3_911_247, validationReadBytes: 82_664, writeBytes: 42_525,
      changedFiles: 1, worktreeChangedFiles: 1, verifications: 2,
      verificationAttempts: [
        failedAttempt(),
        failedAttempt({ sequence: 6, durationMs: 359_814, reason: 'npm run verify exited with code 1 after 6m00s.' })
      ],
      outcomes: []
    }
  };
}

/** The loop finished normally after its own verification failed: Relay's verification decides. */
function finishedAfterFailedVerificationResult(): OrnithImplementationResult {
  const result = deadlineAfterEditsResult();
  return {
    ...result,
    finalMessage: 'Added the checklist.',
    assessment: { ...result.assessment, disposition: 'pass', publishBlock: 'verification', reasonCodes: [] }
  };
}

function noChangeFailureResult(): OrnithImplementationResult {
  return {
    sessionId: null,
    finalMessage: 'The runtime rejected the inference request with HTTP 500.',
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: 'fail',
      verificationStatus: 'not_run',
      publishBlock: 'configuration',
      reasonCodes: ['runtime_unavailable'],
      verification: null,
      denials: []
    },
    ornithAudit: {
      turns: 1, actions: 0, readBytes: 0, validationReadBytes: 0, writeBytes: 0, changedFiles: 0,
      worktreeChangedFiles: 0, verifications: 0, verificationAttempts: [], outcomes: []
    }
  };
}

const fakeOrnith = (
  implement: (request: OrnithImplementationRequest) => Promise<OrnithImplementationResult>
): OrnithImplementationService => ({ implement: vi.fn(implement) }) as unknown as OrnithImplementationService;

interface ScriptedVerification extends VerificationExecutor {
  readonly calls: number;
}

/** A command runner whose successive results the test scripts; identity is stable unless told otherwise. */
function scriptedVerification(
  results: readonly Partial<Awaited<ReturnType<VerificationExecutor['execute']>>>[]
): ScriptedVerification {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    identity: async () => 'a'.repeat(64),
    execute: async () => {
      const scripted = results[Math.min(calls, results.length - 1)] ?? {};
      calls += 1;
      return {
        command: 'npm run verify',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        failed: false,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
        ...scripted
      };
    }
  };
}

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

async function taskAfterOrnithRound(input: {
  ornith: OrnithImplementationService;
  verification: VerificationExecutor;
}): Promise<{ readonly harness: Harness; readonly task: Task }> {
  harness = createHarness({
    ornith: input.ornith,
    ornithLease: leaseService,
    processRunner: unusedProcessRunner,
    verification: input.verification
  });
  const project = harness.createProject();
  const created = harness.createTask(project.id, { implementationProvider: 'ornith' });
  await harness.orchestrator.generateSpecification(created.id);
  harness.orchestrator.approveSpecification(created.id);
  const task = await harness.orchestrator.sendToClaude(created.id);
  return { harness, task };
}

const guidanceFor = (h: Harness, task: Task) =>
  runGuidance(h.tasks.findById(task.id)!, h.runs.listByTask(task.id), true, false, 'not_required', {
    ornithLocalInferenceState: 'healthy'
  });

describe('an Ornith round that changed files and hit its time limit during verification', () => {
  it('leaves the task recoverable at READY_FOR_IMPLEMENTATION, keeps the round, and explains what happened', async () => {
    const verification = scriptedVerification([{}]);
    const { harness: h, task } = await taskAfterOrnithRound({ ornith: fakeOrnith(async () => deadlineAfterEditsResult()), verification });

    // The transition: IMPLEMENTING → READY_FOR_IMPLEMENTATION (by `implementation_unverified`, not an abort).
    expect(task.status).toBe('READY_FOR_IMPLEMENTATION');
    // Files were changed, so the round counts and is not handed back.
    expect(task.currentRound).toBe(1);
    // No automatic verification: a deadline-interrupted run needs the operator's decision.
    expect(verification.calls).toBe(0);
    expect(task.lastError).toContain('The Ornith implementation time limit expired.');
    expect(task.lastError).toContain('Ornith changed 1 file.');
    expect(task.lastError).toContain('npm run verify exited with code 1 after 6m00s.');
    expect(task.lastError).toContain('preserved in the task worktree');
    expect(task.lastError!.length).toBeLessThan(900);

    const run = h.runs.listByTask(task.id).find((candidate) => candidate.agent === 'ornith')!;
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toBe(task.lastError);
    // The attempts are persisted where the Run screen reads them back.
    const evidence = readOrnithRunEvidence(run);
    expect(evidence).toMatchObject({ changedFiles: 1, worktreeChangedFiles: 1, deadlineExpired: true });
    expect(evidence?.attempts.map((attempt) => [attempt.outcome, attempt.exitCode, attempt.durationMs])).toEqual([
      ['failed', 1, 511_795],
      ['failed', 1, 359_814]
    ]);
  });

  it('makes Run verification the primary action, with the retry a deliberate secondary one', async () => {
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => deadlineAfterEditsResult()),
      verification: scriptedVerification([{}])
    });

    const value = guidanceFor(h, task);
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect('secondaryAction' in value).toBe(false); // verification is the stage: no retry of the implementation beside it
    expect(value.happened).toBe('The implementation time limit expired. Implementation changed 1 file.');
    expect(value.verification).toMatchObject({ source: 'ornith', outcome: 'failed', exitCode: 1, command: 'npm run verify' });
  });

  it('preserves the diff: recovery reaches verification without another Ornith call, worktree or round', async () => {
    const ornith = fakeOrnith(async () => deadlineAfterEditsResult());
    const verification = scriptedVerification([{}]);
    const { harness: h, task } = await taskAfterOrnithRound({ ornith, verification });
    const worktreesBefore = h.git.createdWorktrees.length;

    const verified = await h.orchestrator.runVerification(task.id);

    expect(ornith.implement).toHaveBeenCalledTimes(1); // never re-run
    expect(h.git.createdWorktrees).toHaveLength(worktreesBefore); // no new attempt/worktree
    expect(verified.worktreePath).toBe(task.worktreePath);
    expect(verified.branchName).toBe(task.branchName);
    expect(verified.currentRound).toBe(task.currentRound);
    expect(h.git.commits).toEqual([]); // nothing was committed or discarded on the way
    expect(verification.calls).toBe(1);
  });

  it('a passing manual verification advances to the normal review stage', async () => {
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => deadlineAfterEditsResult()),
      verification: scriptedVerification([{ exitCode: 0 }])
    });

    const verified = await h.orchestrator.runVerification(task.id);

    expect(verified.status).toBe('READY_FOR_REVIEW');
    expect(verified.lastError).toBeNull();
    expect(guidanceFor(h, verified).action).toMatchObject({ key: 'run_review' });
    const record = readVerification(h.runs.listByTask(task.id).at(-1)!);
    expect(record.success && record.data).toMatchObject({ passed: true, exitCode: 0, outcome: 'passed' });
  });

  it('a failing manual verification stays recoverable, records the real exit code and bounded output, and can be re-run', async () => {
    const secret = `ghp_${'A1b2C3d4E5f6G7h8'}`;
    const verification = scriptedVerification([
      {
        exitCode: 1, failed: true, durationMs: 42_000,
        stdout: `${'noise line\n'.repeat(80_000)} FAIL  tests/a.test.ts\nAssertionError: expected 1 to be 2\n`,
        stderr: `GITHUB_TOKEN=${secret}\nat C:\\Users\\someone\\repo\\a.ts:1`
      },
      { exitCode: 0 }
    ]);
    const { harness: h, task } = await taskAfterOrnithRound({ ornith: fakeOrnith(async () => deadlineAfterEditsResult()), verification });

    const failed = await h.orchestrator.runVerification(task.id);

    expect(failed.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(failed.lastError).toContain('npm run verify failed (exit 1)');
    const failedRun = h.runs.listByTask(task.id).at(-1)!;
    const record = readVerification(failedRun);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data).toMatchObject({ passed: false, exitCode: 1, durationMs: 42_000, outcome: 'failed' });
    expect(record.data.outputSummary).toContain('AssertionError: expected 1 to be 2');
    expect(record.data.outputSummary!.length).toBeLessThanOrEqual(1_500);
    expect(record.data.outputSummary).not.toContain(secret);
    expect(record.data.outputSummary).not.toContain('someone');
    expect(failedRun.structuredResult!.length).toBeLessThan(4_000); // bounded as stored

    // An assertion failed: classified as the files' own failure, so the ONE action is the repair.
    expect(record.data.failureKind).toBe('implementation');
    const value = guidanceFor(h, failed);
    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Fix verification failures · Ornith' });
    expect('secondaryAction' in value).toBe(false);
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'failed', exitCode: 1, durationMs: 42_000 });

    // And it is genuinely still recoverable: a second manual verification runs and passes.
    const recovered = await h.orchestrator.runVerification(task.id);
    expect(recovered.status).toBe('READY_FOR_REVIEW');
    expect(verification.calls).toBe(2);
  });

  it('classifies a manual verification exactly as the Ornith loop would: a command that timed out AND was killed is timed out, not cancelled', async () => {
    // The process layer reports both flags when its own timeout terminates the tree. One shared classifier
    // decides, so the persisted outcome cannot depend on who started the command.
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => deadlineAfterEditsResult()),
      verification: scriptedVerification([{ exitCode: null, failed: true, timedOut: true, cancelled: true, durationMs: 1_800_000 }])
    });

    const after = await h.orchestrator.runVerification(task.id);

    const record = readVerification(h.runs.listByTask(task.id).at(-1)!);
    expect(record.success && record.data).toMatchObject({ passed: false, exitCode: null, outcome: 'timed_out', failureKind: 'unknown' });
    expect(after.lastError).toContain('Verification timed out; success was not established.');
  });

  it('a timed-out manual verification is recorded as timed out (no exit code) and leaves Run verification as the action', async () => {
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => deadlineAfterEditsResult()),
      verification: scriptedVerification([{ exitCode: null, failed: true, timedOut: true, durationMs: 1_800_000, stdout: 'still running' }])
    });

    const after = await h.orchestrator.runVerification(task.id);

    expect(after.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(after.lastError).toContain('Verification timed out; success was not established.');
    const record = readVerification(h.runs.listByTask(task.id).at(-1)!);
    expect(record.success && record.data).toMatchObject({ passed: false, exitCode: null, outcome: 'timed_out' });
    const value = guidanceFor(h, after);
    expect(value.action).toMatchObject({ key: 'run_verification' });
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'timed_out', exitCode: null });
  });
});

describe('an Ornith round that finished normally after its own verification failed', () => {
  it('lets Relay’s own verification decide: pass advances to review, and the round is not recorded as failed', async () => {
    const verification = scriptedVerification([{ exitCode: 0 }]);
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => finishedAfterFailedVerificationResult()),
      verification
    });

    expect(verification.calls).toBe(1);
    expect(task.status).toBe('READY_FOR_REVIEW');
    const ornithRun = h.runs.listByTask(task.id).find((candidate) => candidate.agent === 'ornith')!;
    expect(ornithRun.status).toBe('succeeded');
    // The model's own failed attempt is still on the record, not rewritten by Relay's later pass.
    expect(readOrnithRunEvidence(ornithRun)?.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'failed']);
  });

  it('and when Relay’s verification also fails, the task is recoverable with that failure explained', async () => {
    const { harness: h, task } = await taskAfterOrnithRound({
      ornith: fakeOrnith(async () => finishedAfterFailedVerificationResult()),
      verification: scriptedVerification([{ exitCode: 1, failed: true, stdout: ' FAIL  tests/a.test.ts', durationMs: 9_000 }])
    });

    expect(task.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(task.lastError).toContain('npm run verify failed (exit 1)');
    const value = guidanceFor(h, task);
    expect(value.verification).toMatchObject({ source: 'relay', outcome: 'failed', exitCode: 1 });
    // A bare FAIL line names no assertion, type, lint or build error: unclassified, so it fails closed to a
    // diagnostic re-run — never a repair round on evidence nobody has read.
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification to diagnose' });
    expect('secondaryAction' in value).toBe(false);
  });
});

describe('an Ornith round that made no new edits over files an earlier attempt left', () => {
  it('is not "nothing changed": the preserved edits are named, the round is handed back, and Run verification leads', async () => {
    const stoppedEarly = (): OrnithImplementationResult => {
      const base = noChangeFailureResult();
      return { ...base, ornithAudit: { ...base.ornithAudit, worktreeChangedFiles: 1 } };
    };
    const verification = scriptedVerification([{}]);
    const { harness: h, task } = await taskAfterOrnithRound({ ornith: fakeOrnith(async () => stoppedEarly()), verification });

    expect(task.status).toBe('READY_FOR_IMPLEMENTATION');
    // This round changed nothing of its own, so it does not count against the review-round budget...
    expect(task.currentRound).toBe(0);
    // ...but the task does not claim nothing is there.
    expect(task.lastError).toContain('made no new changes this round');
    expect(task.lastError).toContain('still holds 1 changed file');
    expect(task.lastError).toContain('preserved in the task worktree');
    expect(task.lastError).not.toContain('stopped before changing any files');
    expect(verification.calls).toBe(0);

    const value = guidanceFor(h, task);
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expect('secondaryAction' in value).toBe(false);
    expect(value.happened).toBe('Implementation changed 1 file; verification has not run.');
  });
});

describe('an Ornith round whose end-of-run worktree count could not be established', () => {
  it('reads "unknown" as unknown, not as zero: an earlier round\'s unverified edits are still named and verification still leads', async () => {
    let round = 0;
    const ornith = fakeOrnith(async () => {
      round += 1;
      if (round === 1) return deadlineAfterEditsResult(); // leaves one changed file, verification failed twice
      // The second round edits nothing, and its final `git status` failed (null), so it cannot say what remains.
      const base = noChangeFailureResult();
      return { ...base, ornithAudit: { ...base.ornithAudit, worktreeChangedFiles: null } };
    });
    const verification = scriptedVerification([{}]);
    const { harness: h, task: afterFirst } = await taskAfterOrnithRound({ ornith, verification });
    expect(afterFirst.currentRound).toBe(1);

    const afterSecond = await h.orchestrator.sendToClaude(afterFirst.id);

    expect(afterSecond.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(afterSecond.currentRound).toBe(1); // this round changed nothing of its own: handed back, not consumed
    expect(afterSecond.lastError).toContain('still holds 1 changed file');
    expect(afterSecond.lastError).not.toContain('stopped before changing any files');
    const value = guidanceFor(h, afterSecond);
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expect(value.happened).toBe('Implementation changed 1 file; verification has not run.');
    expect(verification.calls).toBe(0);
  });
});

describe('an Ornith round that changed nothing', () => {
  it('keeps the existing behaviour: the round is handed back and Run implementation is still the action', async () => {
    const verification = scriptedVerification([{}]);
    const { harness: h, task } = await taskAfterOrnithRound({ ornith: fakeOrnith(async () => noChangeFailureResult()), verification });

    expect(task).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 0 });
    expect(task.lastError).toContain('stopped before changing any files');
    expect(verification.calls).toBe(0);
    const value = guidanceFor(h, task);
    expect(value.action).toMatchObject({ key: 'run_implementation', label: 'Retry implementation · Ornith' });
    expect('secondaryAction' in value).toBe(false);
    expect(value.verification ?? null).toBeNull();
  });
});
