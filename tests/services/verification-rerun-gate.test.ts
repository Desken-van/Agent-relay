/**
 * The re-run gate through the production path: the real orchestrator writes the real verification record,
 * `runGuidance` reads it the way the Run screen does, and `runVerification` enforces the policy where the
 * snapshot is known. Only the executor is faked — its identity is a value this test controls, its execution a
 * scripted process result — so "the files changed" and "the settings changed" are each exercised on purpose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { ProcessResult } from '../../src/main/adapters/process/process-runner';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import { readVerification, verificationRerunPolicy } from '../../src/shared/domain/verification';
import { PLANTED_PATH, PLANTED_SECRET, VITEST_ASSERTION_FAILURE_OUTPUT } from '../helpers/verification-output-fixtures';

let h: Harness;
let identity: string;
let executed: number;
let results: ProcessResult[];

beforeEach(() => {
  identity = 'a'.repeat(64);
  executed = 0;
  results = [];
  h = createHarness({
    verification: {
      identity: async () => identity,
      execute: async (_target, _signal, progress) => {
        executed += 1;
        progress({ type: 'log', text: 'npm run verify' });
        const next = results.shift();
        if (next === undefined) throw new Error('A verification was executed that the test did not script.');
        return next;
      }
    }
  });
});
afterEach(() => h.dispose());

async function prepared(): Promise<string> {
  const project = h.createProject();
  const task = h.createTask(project.id);
  await h.orchestrator.generateSpecification(task.id);
  h.orchestrator.approveSpecification(task.id);
  // The saved worktree after an unsuccessful implementation, one round already spent.
  h.tasks.update(task.id, { worktreePath: `${h.worktreesRoot}/task`, branchName: 'agent/task', baseBranch: 'main', currentRound: 1 });
  return task.id;
}

const passing = (): ProcessResult => ({
  command: 'npm run verify', exitCode: 0, stdout: ' Test Files  83 passed (83)', stderr: '', failed: false, timedOut: false, cancelled: false, durationMs: 15
});
/** What the process layer returns when `npm run verify` printed more than the stored log budget: stopped, no exit code, flagged. */
const overflowed = (): ProcessResult => ({
  ...passing(), exitCode: null, failed: true, outputLimitExceeded: true, durationMs: 9_000,
  stdout: `${'noise\n'.repeat(500)}${VITEST_ASSERTION_FAILURE_OUTPUT}\n${PLANTED_SECRET}\n${PLANTED_PATH}\n`
});
/** A failure the classifier cannot name: no assertion, type, lint, build or runner marker. */
const puzzling = (exitCode = 1): ProcessResult => ({
  ...passing(), exitCode, failed: true, durationMs: 12_345,
  stdout: `something ended badly near ${PLANTED_PATH}\nnpm error code ELIFECYCLE\ntoken=${PLANTED_SECRET}`
});

const guidanceOf = (taskId: string) =>
  runGuidance(h.tasks.findById(taskId)!, h.runs.listByTask(taskId), true, false, 'not_required', { ornithLocalInferenceState: 'healthy' });
const verifications = (taskId: string) => h.runs.listByTask(taskId).filter((run) => run.runType === 'verification');
const latestRecord = (taskId: string) => {
  const record = readVerification(verifications(taskId).at(-1)!);
  if (!record.success) throw new Error('The verification record could not be read.');
  return record.data;
};
function expectNothingRaw(taskId: string): void {
  const payloads = [
    ...verifications(taskId).flatMap((run) => h.runEvents.listByRun(run.id).map((event) => event.payload)),
    ...verifications(taskId).map((run) => run.structuredResult ?? ''),
    ...verifications(taskId).map((run) => run.errorMessage ?? ''),
    JSON.stringify(h.events.events),
    h.tasks.findById(taskId)!.lastError ?? ''
  ];
  expect(payloads.length).toBeGreaterThan(0);
  for (const payload of payloads) {
    expect(payload).not.toContain(PLANTED_SECRET);
    expect(payload).not.toContain(PLANTED_PATH);
  }
}

describe('an output that overflowed the stored log budget', () => {
  it('is recorded as output_limit with a fixed reason, offers only the gated step, spends no round, and is refused unchanged', async () => {
    const taskId = await prepared();
    results.push(overflowed());

    const after = await h.orchestrator.runVerification(taskId);

    expect(after).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    const budget = Math.round(h.settings.get().maxStoredLogBytes / 1000);
    expect(after.lastError).toBe(
      `Verification output exceeded Agent Relay's configured retention limit (${budget}k characters per run), so the result could not be ` +
        'classified safely: the command was stopped at the limit and only the output up to it was kept. Raise "Stored log budget" in ' +
        'Settings or reduce what npm run verify prints; running it again unchanged would stop at the same limit.'
    );
    const record = latestRecord(taskId);
    expect(record).toMatchObject({ passed: false, exitCode: null, outcome: 'failed', failureKind: 'output_limit' });
    expect(record.configurationFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(record.evidenceFingerprint).toMatch(/^[a-f0-9]{16}$/);
    // The assertion in the retained part is NOT taken as evidence about the files: the output was incomplete.
    expect(record.failureKind).not.toBe('implementation');
    expectNothingRaw(taskId);

    const guidance = guidanceOf(taskId);
    expect(guidance.action).toMatchObject({ key: 'run_verification', label: 'Run verification after changes', enabled: true });
    expect(JSON.stringify(guidance)).not.toContain('Run verification again');
    expect(JSON.stringify(guidance)).not.toContain('Fix verification failures');
    expect(JSON.stringify(guidance)).not.toContain('Retry implementation');
    expect(guidance.result).toContain('no implementation round is spent');

    // Same files, same settings: refused before any row is written — nothing executed, nothing recorded, nothing spent.
    await expect(h.orchestrator.runVerification(taskId)).rejects.toThrow(/output exceeded the stored log budget, and neither the files nor the verification settings have changed/);
    expect(executed).toBe(1);
    expect(verifications(taskId)).toHaveLength(1);
    expect(h.tasks.findById(taskId)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    expect(h.runs.listByTask(taskId).some((run) => run.status === 'running')).toBe(false);

    // The setting the reason names is raised: the conditions changed, so the run proceeds — and still costs no round.
    h.settings.update({ maxStoredLogBytes: h.settings.get().maxStoredLogBytes * 2 });
    results.push(passing());
    const passed = await h.orchestrator.runVerification(taskId);
    expect(executed).toBe(2);
    expect(passed).toMatchObject({ status: 'READY_FOR_REVIEW', currentRound: 1, lastError: null });
  });

  it('lets the run proceed once the files changed, even under the same settings', async () => {
    const taskId = await prepared();
    results.push(overflowed());
    await h.orchestrator.runVerification(taskId);
    await expect(h.orchestrator.runVerification(taskId)).rejects.toThrow(/stored log budget/);

    identity = 'b'.repeat(64);
    results.push(passing());
    expect((await h.orchestrator.runVerification(taskId)).status).toBe('READY_FOR_REVIEW');
    expect(executed).toBe(2);
  });

  it('never becomes correction evidence for the implementation provider', async () => {
    const taskId = await prepared();
    h.tasks.update(taskId, { currentRound: 2 });
    results.push(overflowed());
    const after = await h.orchestrator.runVerification(taskId);
    expect(after.lastError).toContain('retention limit');

    await h.orchestrator.sendToClaude(taskId);
    expect(h.claude.calls).toHaveLength(1);
    expect(h.claude.calls[0]?.prompt).not.toContain('Agent Relay independently verified');
    expect(h.claude.calls[0]?.prompt).not.toContain('retention limit');
    expect(h.claude.calls[0]?.prompt).not.toContain(PLANTED_SECRET);
  });
});

describe('an unclassifiable failure and its one diagnostic re-run', () => {
  it('offers the diagnostic re-run once; a second materially identical result on the same snapshot is refused until something changes', async () => {
    const taskId = await prepared();
    results.push(puzzling());
    const first = await h.orchestrator.runVerification(taskId);
    expect(first).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    expect(latestRecord(taskId).failureKind).toBe('unknown');
    expect(verificationRerunPolicy(h.runs.listByTask(taskId))).toEqual({ state: 'diagnostic' });
    expect(guidanceOf(taskId).action).toMatchObject({ label: 'Run verification to diagnose', enabled: true });
    expect(guidanceOf(taskId).result).toContain('one diagnostic re-run');

    // The diagnostic re-run is taken and ends the same way.
    results.push(puzzling());
    const second = await h.orchestrator.runVerification(taskId);
    expect(second).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    expect(executed).toBe(2);
    const [a, b] = verifications(taskId).map((run) => readVerification(run)).map((record) => (record.success ? record.data : null));
    expect(a?.evidenceFingerprint).toBe(b?.evidenceFingerprint);
    expect(a?.configurationFingerprint).toBe(b?.configurationFingerprint);
    expect(verificationRerunPolicy(h.runs.listByTask(taskId))).toEqual({ state: 'changes_required', cause: 'unknown_exhausted' });
    const exhausted = guidanceOf(taskId);
    expect(exhausted.action).toMatchObject({ key: 'run_verification', label: 'Run verification after changes', enabled: true });
    expect(JSON.stringify(exhausted)).not.toContain('to diagnose');
    expect(JSON.stringify(exhausted)).not.toContain('Run verification again');
    expect(JSON.stringify(exhausted)).not.toContain('Fix verification failures');
    expect(exhausted.result).toContain('not offered again');
    expectNothingRaw(taskId);

    // A third identical attempt is refused: nothing executed, recorded or spent.
    await expect(h.orchestrator.runVerification(taskId)).rejects.toThrow(/last two runs on these exact files ended without a classifiable result/);
    expect(executed).toBe(2);
    expect(verifications(taskId)).toHaveLength(2);
    expect(h.tasks.findById(taskId)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });

    // The files change: a fresh allowance — the run proceeds, and an unknown result again is a first one.
    identity = 'c'.repeat(64);
    results.push(puzzling());
    await h.orchestrator.runVerification(taskId);
    expect(executed).toBe(3);
    expect(verificationRerunPolicy(h.runs.listByTask(taskId))).toEqual({ state: 'diagnostic' });
    expect(guidanceOf(taskId).action).toMatchObject({ label: 'Run verification to diagnose' });

    // A materially different failure on the same snapshot is also a first one.
    results.push(puzzling(2));
    await h.orchestrator.runVerification(taskId);
    expect(verificationRerunPolicy(h.runs.listByTask(taskId))).toEqual({ state: 'diagnostic' });
    expect(guidanceOf(taskId).action).toMatchObject({ label: 'Run verification to diagnose' });
    expect(h.tasks.findById(taskId)!.currentRound).toBe(1);
  });

  it('is unlocked by a change of the verification settings alone', async () => {
    const taskId = await prepared();
    results.push(puzzling(), puzzling());
    await h.orchestrator.runVerification(taskId);
    await h.orchestrator.runVerification(taskId);
    await expect(h.orchestrator.runVerification(taskId)).rejects.toThrow(/without a classifiable result/);

    h.settings.update({ processTimeoutMs: h.settings.get().processTimeoutMs + 60_000 });
    results.push(passing());
    expect((await h.orchestrator.runVerification(taskId)).status).toBe('READY_FOR_REVIEW');
    expect(executed).toBe(3);
  });

  it('hands the implementation provider no evidence from unknown results, exhausted or not', async () => {
    const taskId = await prepared();
    h.tasks.update(taskId, { currentRound: 2 });
    results.push(puzzling(), puzzling());
    await h.orchestrator.runVerification(taskId);
    await h.orchestrator.runVerification(taskId);
    expect(guidanceOf(taskId).action).toMatchObject({ label: 'Run verification after changes' });

    await h.orchestrator.sendToClaude(taskId);
    expect(h.claude.calls).toHaveLength(1);
    expect(h.claude.calls[0]?.prompt).not.toContain('Agent Relay independently verified');
    expect(h.claude.calls[0]?.prompt).not.toContain('ELIFECYCLE');
    expect(h.claude.calls[0]?.prompt).not.toContain(PLANTED_SECRET);
  });
});
