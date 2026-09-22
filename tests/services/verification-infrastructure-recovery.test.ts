/**
 * The production sequence, through production services:
 *
 *   an Ornith round changes one file → the task-owned resource (the Ornith execution lease) is released
 *   before Agent Relay's own verification starts → that verification fails the way the live task's did
 *   (vitest's pool lost a worker) → the Run screen offers exactly one step, "Run verification again" →
 *   the operator takes it → it passes → the task advances to code review.
 *
 * Real: the Orchestrator, its state machine and repositories, `WorktreeVerification` (identity via real
 * git on a real worktree at the exact path the orchestrator computes) and the run recorder. Faked: the
 * model loop (a fake Ornith service that really edits the file), the lease service (a spy that records
 * order) and the one `npm run verify` spawn (a scripted result). Nothing here writes database state
 * directly; every transition is the orchestrator's own.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_ASSESSMENT_VERSION } from '../../src/shared/domain/claude-assessment';
import type { OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import type {
  OrnithImplementationRequest,
  OrnithImplementationResult,
  OrnithImplementationService
} from '../../src/main/services/ornith-implementation';
import { ExecaProcessRunner, type ProcessResult, type ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { WorktreeVerification } from '../../src/main/services/worktree-verification';
import { readVerification, type VerificationReadiness } from '../../src/shared/domain/verification';
import type { OrnithVerificationExecution } from '../../src/shared/domain/ornith-verification';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import { buildBranchName, buildWorktreeDirName } from '../../src/shared/util/slug';
import { createHarness, type Harness } from '../helpers/harness';
import {
  PLANTED_PATH,
  PLANTED_SECRET,
  VITEST_ASSERTION_FAILURE_OUTPUT,
  VITEST_WORKER_TIMEOUT_OUTPUT
} from '../helpers/verification-output-fixtures';

const unusedProcessRunner: ProcessRunner = {
  run: async () => {
    throw new Error('The Ornith process runner is not exercised by these tests.');
  }
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

const CHECKLIST = `\n## Configured provider smoke-test checklist\n${Array.from({ length: 22 }, (_, index) => `- [ ] step ${index + 1}`).join('\n')}\n`;

function passingRun(): ProcessResult {
  return {
    command: 'npm run verify', exitCode: 0, stdout: ' Test Files  83 passed (83)\n      Tests  2285 passed (2285)', stderr: '',
    failed: false, timedOut: false, cancelled: false, durationMs: 512_000
  };
}
const workerTimeoutRun = (): ProcessResult => ({ ...passingRun(), exitCode: 1, failed: true, stdout: VITEST_WORKER_TIMEOUT_OUTPUT, durationMs: 580_014 });
const assertionFailureRun = (): ProcessResult => ({
  ...passingRun(), exitCode: 1, failed: true, stdout: `${VITEST_ASSERTION_FAILURE_OUTPUT}\nnpm error token=${PLANTED_SECRET}`, durationMs: 590_556
});
/** The process layer stopped `npm run verify` at the stored log budget: no exit code, flagged, retained part cut mid-way. */
const outputLimitRun = (): ProcessResult => ({
  ...passingRun(), exitCode: null, failed: true, outputLimitExceeded: true, durationMs: 42_000,
  stdout: `${'noise\n'.repeat(2_000)}${VITEST_ASSERTION_FAILURE_OUTPUT}\n${PLANTED_SECRET}\n${PLANTED_PATH}`
});

interface Scenario {
  readonly h: Harness;
  readonly taskId: string;
  readonly target: string;
  readonly worktree: string;
  /** Everything that happened, in order: lease events, the edit, and each `npm run verify` spawn. */
  readonly events: string[];
  readonly requests: OrnithImplementationRequest[];
  /** Results the next `npm run verify` spawns return, in order. */
  readonly scripts: ProcessResult[];
  readonly stop: ReturnType<typeof vi.fn>;
  /** Runs inside the fake Ornith round, with the real request the orchestrator built — to exercise the boundary. */
  readonly probe: { run: ((request: OrnithImplementationRequest) => Promise<void>) | null };
}

let scenario: Scenario | null = null;
afterEach(() => {
  scenario?.h.dispose();
  scenario = null;
});

async function approvedOrnithTask(): Promise<Scenario> {
  const events: string[] = [];
  const requests: OrnithImplementationRequest[] = [];
  const scripts: ProcessResult[] = [];
  const stop = vi.fn();
  const probe: Scenario['probe'] = { run: null };
  const lease = (): OrnithHealthyLease => ({
    runtimeInstanceId: 'runtime-1', providerId: 'local-llama-cpp', modelId: 'test-model',
    contextLimitTokens: 32_768, maxOutputTokens: 1_024,
    release: () => { events.push('lease released'); },
    onIndependentStop: () => undefined
  });
  // The application-wide lease is the only task-owned resource; the runtime itself is user-retained
  // (Settings → Local inference) and no path from a task reaches `stop` — the spy exists to prove that.
  const leaseService: OrnithInferenceLeaseService & { stop: typeof stop } = {
    acquireOrnithLease: async () => { events.push('lease acquired'); return lease(); },
    recheckOrnithLease: async () => { events.push('lease rechecked'); return true; },
    inferForOrnith: async () => { throw new Error('inferForOrnith is not exercised by these tests.'); },
    stop
  };
  const ornith = {
    implement: vi.fn(async (request: OrnithImplementationRequest): Promise<OrnithImplementationResult> => {
      requests.push(request);
      const target = join(request.worktreePath, 'docs', 'manual-test.md');
      writeFileSync(target, `${readFileSync(target, 'utf8')}${CHECKLIST}`, 'utf8');
      events.push('ornith changed docs/manual-test.md');
      await probe.run?.(request);
      return {
        sessionId: null,
        finalMessage: 'Added the checklist.',
        assessment: {
          version: CLAUDE_ASSESSMENT_VERSION, disposition: 'pass', verificationStatus: 'not_run',
          publishBlock: 'verification', reasonCodes: [], verification: null, denials: []
        },
        ornithAudit: {
          turns: 3, actions: 2, readBytes: 41_332, validationReadBytes: 82_664, writeBytes: 42_525,
          changedFiles: 1, worktreeChangedFiles: 1, verifications: 0, verificationAttempts: [], outcomes: []
        }
      };
    })
  } as unknown as OrnithImplementationService;
  // Real git for every command `identity()` issues; only the `npm run verify` spawn itself is scripted.
  const runner: ProcessRunner = {
    run: async (file, args, options) => {
      const tail = args.slice(-2);
      if (tail[0] !== 'run' || tail[1] !== 'verify') return new ExecaProcessRunner().run(file, args, options);
      events.push('npm run verify');
      const next = scripts.shift();
      if (next === undefined) throw new Error('A verification was spawned that the scenario did not script.');
      return next;
    }
  };

  const h = createHarness({ ornith, ornithLease: leaseService, processRunner: unusedProcessRunner, verification: new WorktreeVerification(runner) });
  const repo = join(dirname(h.worktreesRoot), 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, 'docs', 'manual-test.md'), '# Manual test\n\nExisting sections.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'fixture');

  const project = h.createProject({ localPath: repo, defaultBranch: 'main' });
  const created = h.createTask(project.id, {
    title: 'Add configured provider smoke-test checklist',
    implementationProvider: 'ornith',
    reviewProvider: 'codex'
  });
  await h.orchestrator.generateSpecification(created.id);
  h.orchestrator.approveSpecification(created.id);
  // The orchestrator computes the worktree path and branch deterministically from the task as it is AFTER
  // specification (the specification's title wins), and the harness's git adapter only records the request;
  // so the real worktree is prepared at exactly that path, from the real repository.
  const task = h.tasks.findById(created.id)!;
  const worktree = join(h.worktreesRoot, buildWorktreeDirName(task.id, task.title));
  mkdirSync(h.worktreesRoot, { recursive: true });
  git(repo, 'worktree', 'add', '-b', buildBranchName(task.id, task.title), worktree);
  return { h, taskId: created.id, target: join(worktree, 'docs', 'manual-test.md'), worktree, events, requests, scripts, stop, probe };
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const guidanceOf = (s: Scenario, verificationReadiness: VerificationReadiness | null = null) =>
  runGuidance(s.h.tasks.findById(s.taskId)!, s.h.runs.listByTask(s.taskId), true, false, 'not_required', { ornithLocalInferenceState: 'healthy', verificationReadiness });

describe('the production sequence: implementation → lease released → verification fails on the runner → one step → retry passes → review', () => {
  it('runs exactly as the live task should have', async () => {
    scenario = await approvedOrnithTask();
    const s = scenario;
    s.scripts.push(workerTimeoutRun());

    // 1. Implementation finishes, having changed one file; Relay's own verification runs automatically.
    const afterImplementation = await s.h.orchestrator.sendToClaude(s.taskId);

    // The task-owned resource was released BEFORE the verification command was spawned, and nothing ever
    // stopped the (user-retained) runtime.
    expect(s.events).toEqual(['lease acquired', 'lease rechecked', 'ornith changed docs/manual-test.md', 'lease released', 'npm run verify']);
    expect(s.stop).not.toHaveBeenCalled();

    // 2. The verification got the worker-timeout fixture: recorded truthfully, classified as the runner's failure.
    expect(afterImplementation.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(afterImplementation.currentRound).toBe(1);
    expect(afterImplementation.lastError).toContain('a Vitest worker stopped answering (worker timeout)');
    const failedRun = s.h.runs.listByTask(s.taskId).find((run) => run.runType === 'verification')!;
    const failedRecord = readVerification(failedRun);
    expect(failedRecord.success && failedRecord.data).toMatchObject({ passed: false, exitCode: 1, outcome: 'failed', failureKind: 'infrastructure' });
    if (!failedRecord.success) return;
    expect(failedRecord.data.outputSummary!.length).toBeLessThanOrEqual(1_500);
    expect(failedRecord.data.outputSummary).not.toContain(PLANTED_SECRET);
    expect(failedRecord.data.outputSummary).not.toContain(PLANTED_PATH);
    const changedFileBefore = sha256(s.target);
    const statusBefore = git(s.worktree, 'status', '--porcelain');
    expect(statusBefore.trim()).toBe('M docs/manual-test.md');

    // 3. The UI offers only "Run verification again" — no repair, no retry of the implementation.
    const guidance = guidanceOf(s);
    expect(guidance.action).toMatchObject({ key: 'run_verification', label: 'Run verification again', enabled: true });
    expect('secondaryAction' in guidance).toBe(false);
    expect(JSON.stringify(guidance)).not.toContain('Fix verification failures');
    expect(JSON.stringify(guidance)).not.toContain('Retry implementation');
    expect(guidance.result).toContain('no implementation round is spent');

    // 4. The operator takes it; the retry passes.
    s.scripts.push(passingRun());
    const reviewed = await s.h.orchestrator.runVerification(s.taskId);

    // 5. The task advanced to code review — and nothing else moved.
    expect(reviewed.status).toBe('READY_FOR_REVIEW');
    expect(reviewed.currentRound).toBe(1); // a verification retry consumes no implementation round
    expect(reviewed.lastError).toBeNull();
    expect(s.requests).toHaveLength(1); // Ornith was never run again
    expect(s.events.slice(5)).toEqual(['npm run verify']); // no new lease, no new edit, one more spawn
    expect(sha256(s.target)).toBe(changedFileBefore); // the worktree change is exactly what it was
    expect(git(s.worktree, 'status', '--porcelain')).toBe(statusBefore);
    expect(readFileSync(s.target, 'utf8')).toContain('Configured provider smoke-test checklist');
    const passedRun = s.h.runs.listByTask(s.taskId).filter((run) => run.runType === 'verification').at(-1)!;
    expect(passedRun.id).not.toBe(failedRun.id);
    expect(readVerification(passedRun).success && (readVerification(passedRun) as { data: { passed: boolean } }).data.passed).toBe(true);
    expect(guidanceOf(s).action).toMatchObject({ key: 'run_review', label: 'Run review · Codex' });
    expect(s.stop).not.toHaveBeenCalled();
  }, 60_000);

  it('never turns a runner failure into a correction prompt: a round started afterwards carries no verification evidence', async () => {
    scenario = await approvedOrnithTask();
    const s = scenario;
    s.scripts.push(workerTimeoutRun());
    await s.h.orchestrator.sendToClaude(s.taskId);
    expect(guidanceOf(s).action?.label).toBe('Run verification again');

    // The operator can always start a round anyway (nothing forbids the IPC); what they cannot get is a
    // "fix these failures" prompt built on a failure that was never the files' own.
    s.scripts.push(passingRun());
    await s.h.orchestrator.sendToClaude(s.taskId);

    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.correctionFindings).toBeNull();
  }, 60_000);

  it('does turn a genuine assertion failure into a bounded correction prompt — from the sanitized summary only', async () => {
    scenario = await approvedOrnithTask();
    const s = scenario;
    s.scripts.push(assertionFailureRun());
    const failed = await s.h.orchestrator.sendToClaude(s.taskId);

    expect(failed.status).toBe('READY_FOR_IMPLEMENTATION');
    const record = readVerification(s.h.runs.listByTask(s.taskId).find((run) => run.runType === 'verification')!);
    expect(record.success && record.data).toMatchObject({ failureKind: 'implementation' });
    const guidance = guidanceOf(s);
    expect(guidance.action).toMatchObject({ key: 'run_implementation', label: 'Fix verification failures · Ornith' });
    expect(JSON.stringify(guidance)).not.toContain('Run verification again');

    s.scripts.push(passingRun());
    await s.h.orchestrator.sendToClaude(s.taskId);

    // Ornith's correction evidence is Relay-authored status plus the classifier's fixed reason — which check
    // failed — never a line of the command's output (the stored summary may still hold machine paths).
    const prompt = s.requests[1]!.correctionFindings;
    expect(prompt).toBe(
      'Relay verification status: failed; exitCode=1; durationMs=590556. npm run verify failed (exit 1): a test assertion failed. The current files did not pass.'
    );
    expect(prompt).not.toContain('AssertionError');
    expect(prompt).not.toContain(PLANTED_SECRET);
    expect(prompt).not.toContain(PLANTED_PATH);
  }, 60_000);

  it("carries the output-limit flag across the Ornith boundary, records Relay's own run as output_limit, offers only the gated step, and hands Ornith nothing", async () => {
    scenario = await approvedOrnithTask();
    const s = scenario;
    const executions: OrnithVerificationExecution[] = [];
    s.probe.run = async (request) => { executions.push(await request.runVerification(new AbortController().signal)); };
    s.scripts.push(outputLimitRun(), outputLimitRun()); // one for the in-loop probe, one for Relay's own verification

    const after = await s.h.orchestrator.sendToClaude(s.taskId);

    // The boundary: what the loop receives says the output overflowed — not merely "failed without an exit code".
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ exitCode: null, failed: true, outputLimitExceeded: true });

    expect(after).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    const record = readVerification(s.h.runs.listByTask(s.taskId).find((run) => run.runType === 'verification')!);
    expect(record.success && record.data).toMatchObject({ failureKind: 'output_limit', exitCode: null, outcome: 'failed' });
    if (!record.success) return;
    expect(record.data.outputSummary).not.toContain(PLANTED_SECRET);
    expect(record.data.outputSummary).not.toContain(PLANTED_PATH);
    // Unchanged files (the real worktree identity) and settings: the main process says blocked, the screen is a
    // waiting state with no workflow control, and the same request is refused before any row is written.
    const blocked = await s.h.orchestrator.verificationReadiness(s.taskId);
    expect(blocked).toEqual({ state: 'blocked', cause: 'output_limit' });
    const waiting = guidanceOf(s, blocked);
    expect(waiting.action).toBeNull();
    expect(waiting.next).toContain('User action required');
    expect(JSON.stringify(waiting)).not.toContain('Run verification again');
    expect(JSON.stringify(waiting)).not.toContain('Fix verification failures');
    expect(JSON.stringify(waiting)).not.toContain('Retry implementation');
    await expect(s.h.orchestrator.runVerification(s.taskId)).rejects.toThrow(/exceeded the stored log budget/);
    expect(s.h.runs.listByTask(s.taskId).filter((run) => run.runType === 'verification')).toHaveLength(1);
    expect(s.h.tasks.findById(s.taskId)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });

    // The operator edits a file in the worktree: the real identity differs, readiness is ready, one Run verification.
    writeFileSync(s.target, `${readFileSync(s.target, 'utf8')}\nTrimmed the verify output.\n`, 'utf8');
    const ready = await s.h.orchestrator.verificationReadiness(s.taskId);
    expect(ready).toEqual({ state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false });
    expect(JSON.stringify(ready)).not.toMatch(/[a-f0-9]{16}/);
    expect(guidanceOf(s, ready).action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });

    // A round started anyway carries no correction evidence from it.
    s.probe.run = null;
    s.scripts.push(passingRun());
    await s.h.orchestrator.sendToClaude(s.taskId);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.correctionFindings).toBeNull();
  }, 60_000);
});
