/**
 * The audit finding this proves closed: `WorktreeVerification.execute` used to stream every
 * stdout/stderr line of `npm run verify` straight through the `progress` callback
 * (`onLine`/`onStderrLine` → `progress({ type: 'log', text })`), and `Orchestrator.runVerification`
 * passed `event => handle.append(event)` as that callback — which BOTH persists the event to
 * `run_events` and pushes it live to the renderer, before the command has even finished, let alone
 * been classified or reduced to a sanitized `outputSummary`. `docs/security.md`'s "Verification
 * output is summarized, never stored or forwarded raw" was true for Ornith's own in-loop
 * `run_verification` (whose loop already ran everything through `summarizeVerificationOutput`) and
 * for the FINAL record's `outputSummary`, but not for the live/persisted progress stream a manual
 * "Run verification" produced while the command was running.
 *
 * This drives the REAL `Orchestrator.runVerification` → the REAL `WorktreeVerification` → the REAL
 * `RunRecorder`/SQLite persistence and live event publishing, exactly as production wires them
 * (`src/main/container.ts`). Only the ONE process spawn for `npm run verify` itself is replaced by a
 * scripted result — via a thin proxy around a real `ExecaProcessRunner` that still runs every git
 * command `identity()`/`manifest()` issues for real — so the outcome (nonzero exit, timeout,
 * cancellation) and its content are deterministic and controllable, while every line of Relay's own
 * orchestration code between the process boundary and the database/renderer runs unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHarness, type Harness } from '../helpers/harness';
import { WorktreeVerification } from '../../src/main/services/worktree-verification';
import { ExecaProcessRunner, type ProcessResult, type ProcessRunner, type ProcessRunOptions } from '../../src/main/adapters/process/process-runner';
import { readVerification } from '../../src/shared/domain/verification';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';

const MARKER = 'ZZ_UNIQUE_RAW_VERIFY_MARKER_8f2a1c9d';
const SECRET = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2'}`;
const WIN_PATH = 'C:\\Users\\someone\\secret\\file.ts';
const POSIX_PATH = '/home/someone/secret/file.ts';
const UNC_PATH = '\\\\buildserver\\share\\secret\\file.ts';
const ANSI = '\u001b[31mRED\u001b[0m';
const CONTROL = '\u0007\u000bcontrol-chars-here';
const LONG_LINE = 'x'.repeat(5_000);

/** Every one of the required marker shapes, on both streams, plus enough content to exceed the summary cap. */
const RAW_STDOUT = [
  `${MARKER}-start`,
  ' FAIL  tests/example.test.ts > something broke',
  'AssertionError: expected 1 to be 2',
  `token leak check: ${SECRET}`,
  `at ${WIN_PATH}:10`,
  `at ${POSIX_PATH}:10`,
  `at ${UNC_PATH}:10`,
  ANSI,
  CONTROL,
  LONG_LINE,
  ' Test Files  1 failed | 3 passed (4)',
  `${MARKER}-end`
].join('\n');
const RAW_STDERR = `stderr leak check: ${SECRET}\n${CONTROL}\n${MARKER}-stderr`;

/** What the sanitizer specifically targets — must never survive into the record, wherever in the output it sits. */
const SENSITIVE = [SECRET, WIN_PATH, POSIX_PATH, UNC_PATH, ANSI, CONTROL] as const;
/**
 * Everything a run_events row or a live event must never contain, sensitive or not — including the plain
 * marker, since NOTHING from the command's own output belongs there at all, not only its sensitive parts.
 * (`outputSummary` is allowed to keep the marker if it happens to fall in the kept tail, exactly as it
 * would keep any other benign trailing line — only `SENSITIVE` content is redacted from it by design.)
 */
const BANNED = [MARKER, ...SENSITIVE] as const;

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: 'npm run verify',
    exitCode: 1,
    stdout: RAW_STDOUT,
    stderr: RAW_STDERR,
    timedOut: false,
    cancelled: false,
    durationMs: 4_200,
    failed: true,
    ...overrides
  };
}

/**
 * Delegates every real git command `identity()`/`manifest()` issues to a real `ExecaProcessRunner`, and
 * intercepts only the one call `WorktreeVerification.execute` makes to run `npm run verify` — recognised
 * by its last two argv entries, which no git subcommand this codebase issues ever matches.
 *
 * The scripted result's `stdout`/`stderr` are still fed line-by-line to `onLine`/`onStderrLine` when the
 * caller supplies them — exactly what a real streaming process runner does — so this test genuinely
 * exercises the leak mechanism itself: it only stays silent because `execute()` no longer asks to stream
 * at all, not because this fake was never capable of streaming.
 */
function fakeVerifyCommand(real: ProcessRunner, script: (options: ProcessRunOptions) => ProcessResult | Promise<ProcessResult>): ProcessRunner {
  return {
    run: async (file, args, options) => {
      const tail = args.slice(-2);
      if (tail[0] !== 'run' || tail[1] !== 'verify') return real.run(file, args, options);
      const result = await script(options ?? {});
      for (const line of result.stdout.split('\n')) options?.onLine?.(line);
      for (const line of result.stderr.split('\n')) options?.onStderrLine?.(line);
      return result;
    }
  };
}

let h: Harness;
let repo: string;
let root: string;
let script: (options: ProcessRunOptions) => ProcessResult | Promise<ProcessResult>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeEach(() => {
  script = () => processResult();
  h = createHarness({
    verification: new WorktreeVerification(fakeVerifyCommand(new ExecaProcessRunner(), (options) => script(options)))
  });
  repo = join(dirname(h.worktreesRoot), 'repo');
  root = join(h.worktreesRoot, 'task');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  // The command text is never actually run — fakeVerifyCommand intercepts it — but scripts.verify must
  // exist, since `execute()` fails closed when it does not.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, 'input.txt'), 'alpha');
  git(repo, 'add', '--', 'package.json', 'input.txt');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'agent/task', root);
});
afterEach(() => h.dispose());

/** Polls until this task's verification run row exists and is `running` — never a fixed sleep. */
async function waitForRunningVerification(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const running = h.runs.listByTask(taskId).find((run) => run.runType === 'verification' && run.status === 'running');
    if (running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The verification run never reached "running".');
}

async function prepared(): Promise<string> {
  const project = h.createProject({ localPath: repo });
  const task = h.createTask(project.id);
  await h.orchestrator.generateSpecification(task.id);
  h.orchestrator.approveSpecification(task.id);
  const updated = h.tasks.update(task.id, { worktreePath: root, branchName: 'agent/task', baseBranch: 'main', currentRound: 1 });
  return updated.id;
}

/** Every persisted `run_events` row for this run, and every live-published `run-event`, as raw text. */
function allEventPayloads(taskId: string, runId: string): readonly string[] {
  const persisted = h.runEvents.listByRun(runId).map((event) => event.payload);
  const live = h.events.events
    .filter((event): event is Extract<typeof event, { kind: 'run-event' }> => event.kind === 'run-event' && event.taskId === taskId)
    .map((event) => event.event.payload);
  return [...persisted, ...live];
}

function expectNoLeak(payloads: readonly string[]): void {
  expect(payloads.length).toBeGreaterThan(0); // there is something to check, not a vacuous pass
  for (const payload of payloads) {
    for (const banned of BANNED) expect(payload).not.toContain(banned);
  }
}

describe('manual verification never streams, persists or broadcasts raw command output', () => {
  it('a nonzero exit: only a bounded, sanitized summary reaches the verification record, run_events and live events', async () => {
    const taskId = await prepared();

    const after = await h.orchestrator.runVerification(taskId);

    expect(after.status).toBe('READY_FOR_IMPLEMENTATION');
    const run = h.runs.listByTask(taskId).find((candidate) => candidate.runType === 'verification')!;
    const record = readVerification(run);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data).toMatchObject({ passed: false, exitCode: 1, outcome: 'failed' });
    expect(record.data.outputSummary).toBeDefined();
    expect(record.data.outputSummary!.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxVerificationSummaryChars);
    // Useful failure evidence survives sanitization.
    expect(record.data.outputSummary).toContain('AssertionError');
    expect(record.data.outputSummary).toContain('FAIL');
    for (const banned of SENSITIVE) expect(record.data.outputSummary).not.toContain(banned);

    const payloads = allEventPayloads(taskId, run.id);
    expectNoLeak(payloads);
    // The rest of the run_events row (type, timestamp) is untouched — only the payload content matters here.
    expect(h.runEvents.listByRun(run.id).length).toBeGreaterThan(0);

    // Generic, Relay-authored progress remains visible, with no child-process output in it.
    const texts = h.runEvents.listByRun(run.id).map((event) => (JSON.parse(event.payload) as { text: string }).text);
    expect(texts.some((text) => text.includes('Command: npm run verify'))).toBe(true);
    expect(texts.some((text) => text.startsWith('Verification finished:'))).toBe(true);
    for (const text of texts) for (const banned of BANNED) expect(text).not.toContain(banned);
  });

  it('a pass: the command\u2019s own output is still never streamed, persisted or broadcast, even though it happened to contain marker-shaped text', async () => {
    script = () => processResult({ exitCode: 0, failed: false, timedOut: false, cancelled: false });
    const taskId = await prepared();

    const after = await h.orchestrator.runVerification(taskId);

    expect(after.status).toBe('READY_FOR_REVIEW');
    const run = h.runs.listByTask(taskId).find((candidate) => candidate.runType === 'verification')!;
    const record = readVerification(run);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data).toMatchObject({ passed: true, exitCode: 0, reason: null });
    // A pass has nothing to explain, so no summary is recorded at all — not merely a sanitized one.
    expect(record.data.outputSummary).toBeUndefined();

    expectNoLeak(allEventPayloads(taskId, run.id));
  });

  it('a timed-out command: classified timed_out, and its output is never streamed, persisted or broadcast', async () => {
    script = () => processResult({ exitCode: null, timedOut: true, cancelled: false, failed: true, durationMs: 900_000 });
    const taskId = await prepared();

    const after = await h.orchestrator.runVerification(taskId);

    expect(after.status).toBe('READY_FOR_IMPLEMENTATION');
    const run = h.runs.listByTask(taskId).find((candidate) => candidate.runType === 'verification')!;
    const record = readVerification(run);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data).toMatchObject({ passed: false, exitCode: null, outcome: 'timed_out' });
    expect(record.data.outputSummary!.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxVerificationSummaryChars);
    for (const banned of SENSITIVE) expect(record.data.outputSummary).not.toContain(banned);

    expectNoLeak(allEventPayloads(taskId, run.id));
  });

  it('a cancelled command (operator Stop mid-run): classified cancelled, and whatever it had printed is never streamed, persisted or broadcast', async () => {
    script = (options) =>
      new Promise<ProcessResult>((resolve) => {
        const finish = (): void => resolve(processResult({ exitCode: null, cancelled: true, failed: true, timedOut: false }));
        // The signal may already be aborted by the time this runs (an already-fired 'abort' event never
        // replays to a listener added afterwards) — cover both orderings, not just the common one.
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener('abort', finish, { once: true });
      });
    const taskId = await prepared();

    const pending = h.orchestrator.runVerification(taskId);
    // Wait for the run to actually be recorded as running — real git subprocesses run inside `identity()`
    // first, so a fixed tick is not enough to land inside `execute()` rather than the earlier abort check.
    await waitForRunningVerification(taskId);
    h.orchestrator.stop(taskId);
    const after = await pending;

    expect(after.status).toBe('READY_FOR_IMPLEMENTATION');
    const run = h.runs.listByTask(taskId).find((candidate) => candidate.runType === 'verification')!;
    const record = readVerification(run);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data).toMatchObject({ passed: false, exitCode: null, outcome: 'cancelled' });

    expectNoLeak(allEventPayloads(taskId, run.id));
  });
});
