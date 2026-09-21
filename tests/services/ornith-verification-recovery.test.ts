import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrnithImplementationService, type OrnithImplementationResult } from '../../src/main/services/ornith-implementation';
import type { AgentProgressEvent, OrnithInferenceLeaseService } from '../../src/main/ports';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';
import {
  isOrnithVerificationEventData,
  type OrnithVerificationExecution
} from '../../src/shared/domain/ornith-verification';
import {
  completed,
  createReplayFixture,
  gitPath,
  lease,
  marker,
  MISSING_NEEDLE,
  ORIGINAL_SENTENCE,
  REPLACEMENT_SENTENCE,
  runner,
  TARGET,
  targetContent,
  type ReplayFixture
} from '../helpers/ornith-budget-replay';
import { cancelledExecution, failedExecution, passedExecution, timedOutExecution } from '../helpers/ornith-verification';

/**
 * The loop end to end — real Git worktrees, the real tool executor, the real prompt — with a fake clock
 * and a fake verification command whose duration and result each test scripts. Nothing sleeps: time only
 * moves when the driver advances it, and only as far as the command under test would have taken.
 */

const MIN = 60_000;
/**
 * Every scenario drives real Git worktrees (dozens of spawned processes per run). That takes seconds alone
 * but a minute or more when the whole suite runs in parallel on a busy machine; the fake clock decides the
 * outcome, not this, so the timeout only has to be far from what load can reach.
 */
const REAL_GIT_TEST_TIMEOUT_MS = 300_000;
const SHOWN_HASH = /"sha256":"([0-9a-f]{64})"/g;

type Step = Record<string, unknown> | ((context: { sha: string }) => Record<string, unknown>);

const read: Step = { version: 1, action: 'read_file', path: TARGET, offset: 0, limit: 4096 };
const verify: Step = { version: 1, action: 'run_verification' };
const done: Step = { version: 1, action: 'finish', summary: 'Added the checklist.' };
const replace = (oldText: string, newText: string): Step => ({ sha }) => ({
  version: 1,
  action: 'replace_text',
  path: TARGET,
  sha256: sha,
  replacements: [{ oldText, newText }]
});
/** The edit the live run made, then the one-digit edits a model makes to "fix" something between verifications. */
const editSentence = replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE);
const editMarker = (from: number, to: number): Step => replace(marker(from), marker(to));
const searchAll = (query = MISSING_NEEDLE): Step => ({ version: 1, action: 'search_text', query, caseSensitive: false, limit: 20 });
const searchScoped = (query: string, files: readonly string[] = [TARGET]): Step => ({
  version: 1,
  action: 'search_text',
  query,
  caseSensitive: false,
  limit: 20,
  files: [...files]
});

/** What the fake `npm run verify` does. `durationMs` is fake-clock time. */
type VerificationScript =
  | { readonly kind: 'exit'; readonly durationMs: number; readonly exitCode: number; readonly output?: string }
  /** The command's own timeout fires. */
  | { readonly kind: 'own-timeout'; readonly durationMs: number }
  /** Runs until the loop aborts it, as a real process the loop's budget kills. */
  | { readonly kind: 'hangs' }
  /** Ignores the abort and keeps going for `durationMs` — a process that does not die when told to. */
  | { readonly kind: 'ignores-abort'; readonly durationMs: number; readonly exitCode: number };

const exits = (exitCode: number, durationMs: number, output?: string): VerificationScript => ({ kind: 'exit', durationMs, exitCode, output });

interface Scenario {
  readonly steps: readonly Step[];
  readonly verifications?: readonly VerificationScript[];
  readonly loopDeadlineMs?: number;
  readonly scope?: readonly string[];
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Overrides the specification's implementation prompt (default: a harmless one). */
  readonly implementationPrompt?: string;
  /** Runs against the worktree before the loop starts — how an earlier attempt's preserved edits are set up. */
  readonly prepare?: (worktree: string) => void;
}

interface Outcome {
  readonly result: OrnithImplementationResult;
  readonly events: readonly AgentProgressEvent[];
  readonly starts: readonly { readonly atMs: number; readonly budgetMs: number }[];
  readonly prompts: readonly string[];
  readonly worktree: string;
  /** Fake-clock milliseconds the whole run took. */
  readonly elapsedMs: number;
}

const fixtures: ReplayFixture[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function executionFor(script: VerificationScript, durationMs: number): OrnithVerificationExecution {
  switch (script.kind) {
    case 'exit':
      return script.exitCode === 0
        ? passedExecution(durationMs, script.output)
        : failedExecution(script.exitCode, durationMs, script.output);
    case 'own-timeout':
      return timedOutExecution(durationMs);
    case 'ignores-abort':
      return failedExecution(script.exitCode, durationMs);
    case 'hangs':
      return cancelledExecution(durationMs);
  }
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const fixture = await createReplayFixture({ targetBytes: 2_000, companions: false, extraFiles: scenario.extraFiles });
  fixtures.push(fixture);
  scenario.prepare?.(fixture.worktree);
  // Installed only now: the fixture's own Git calls run on the real clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  const startedAt = Date.now();
  const scripts = scenario.verifications ?? [];
  const events: AgentProgressEvent[] = [];
  const prompts: string[] = [];
  const starts: { atMs: number; budgetMs: number }[] = [];
  const pending: { advanceMs: number }[] = [];
  let wake: () => void = () => undefined;
  let sha = '';
  let turn = 0;

  const leaseService: OrnithInferenceLeaseService = {
    acquireOrnithLease: async () => lease(),
    recheckOrnithLease: async () => true,
    inferForOrnith: async (_lease, request) => {
      turn += 1;
      const prompt = request.messages.map((message) => message.content).join('\n');
      prompts.push(prompt);
      const shown = [...prompt.matchAll(SHOWN_HASH)].at(-1)?.[1];
      if (shown !== undefined) sha = shown;
      const step = scenario.steps[turn - 1];
      const action = step === undefined ? done : typeof step === 'function' ? step({ sha }) : step;
      return completed(request, JSON.stringify(action));
    }
  };

  const run = new OrnithImplementationService().implement({
    worktreePath: fixture.worktree,
    worktreesRoot: fixture.worktreesRoot,
    repositoryPath: fixture.repository,
    branchName: 'task',
    specification: {
      title: 'Manual test wording',
      summary: 'Add the smoke-test checklist to the manual test.',
      acceptanceCriteria: ['docs/manual-test.md holds the checklist.'],
      constraints: [],
      assumptions: [],
      suggestedTests: [],
      implementationPrompt: scenario.implementationPrompt ?? 'Use only the structured tool protocol.',
      scopedFilePaths: [...(scenario.scope ?? [TARGET])]
    },
    ruleEvidence: null,
    acceptedPlanReviewAddenda: null,
    correctionFindings: null,
    runType: 'implementation',
    round: 1,
    maxRounds: 3,
    loopDeadlineMs: scenario.loopDeadlineMs ?? 30 * MIN,
    signal: new AbortController().signal,
    onProgress: (event) => events.push(event),
    runVerification: (signal) => {
      const script = scripts[starts.length];
      if (script === undefined) throw new Error('The run started a verification the scenario did not script.');
      // The budget the loop granted is what it just recorded in its "Verification started" event — the
      // command itself is only ever told about it through `signal`.
      const grant = [...events].reverse().find((event) => event.data?.['phase'] === 'started');
      const timeoutMs = Number(grant?.data?.['budgetMs']);
      if (!Number.isFinite(timeoutMs)) throw new Error('A verification started without recording its budget.');
      starts.push({ atMs: Date.now() - startedAt, budgetMs: timeoutMs });
      const begun = Date.now();
      return new Promise<OrnithVerificationExecution>((resolve) => {
        const durationMs = script.kind === 'hangs' ? Number.POSITIVE_INFINITY : script.durationMs;
        const timer = Number.isFinite(durationMs)
          ? setTimeout(() => resolve(executionFor(script, Date.now() - begun)), durationMs)
          : null;
        if (script.kind === 'hangs' || script.kind === 'exit' || script.kind === 'own-timeout') {
          signal.addEventListener('abort', () => {
            if (timer !== null) clearTimeout(timer);
            resolve(cancelledExecution(Date.now() - begun));
          }, { once: true });
        }
        // How far the clock must move for this command to end: to its own end, or to the abort that
        // the loop's budget delivers, whichever comes first — never further.
        pending.push({ advanceMs: script.kind === 'ignores-abort' ? script.durationMs : Math.min(durationMs, timeoutMs) });
        wake();
      });
    },
    lease: lease(),
    leaseService,
    gitExecutablePath: gitPath,
    runner
  });

  // Event-driven, never polling: wait for the run to ask for a verification or to end, and move the
  // clock only for the former.
  const finished = run.then(() => 'finished' as const, () => 'finished' as const);
  for (;;) {
    if (pending.length === 0) {
      const arrival = new Promise<'verification'>((resolve) => {
        wake = () => resolve('verification');
      });
      if ((await Promise.race([arrival, finished])) === 'finished') break;
    }
    const next = pending.shift();
    if (next !== undefined) await vi.advanceTimersByTimeAsync(next.advanceMs);
  }
  const result = await run;
  return { result, events, starts, prompts, worktree: fixture.worktree, elapsedMs: Date.now() - startedAt };
}

/** The results of actions that were DISPATCHED. A refusal is also a `tool_use` event, but it carries a `code`. */
const toolEvents = (outcome: Outcome, action: string): Record<string, unknown>[] =>
  outcome.events
    .filter((event) => event.type === 'tool_use' && event.data?.['action'] === action && event.data['code'] === undefined)
    .map((event) => event.data as Record<string, unknown>);

const attempts = (outcome: Outcome) => outcome.result.ornithAudit.verificationAttempts;

describe('the live sequence: replace_text succeeds, verification fails, a second is attempted, the deadline nears', () => {
  // The run that failed live: 1,800,000 ms loop budget; one docs file changed; the first verification ran
  // 511,795 ms and exited 1; a second ran 359,814 ms; a third started with the budget nearly gone.
  it('records every attempt truthfully, never starts a verification the budget cannot hold, and ends before the deadline', async () => {
    const outcome = await runScenario({
      steps: [read, editSentence, verify, verify, editMarker(0, 1), verify, editMarker(1, 2), verify],
      verifications: [exits(1, 511_795), exits(1, 359_814), { kind: 'hangs' }]
    });
    const { result } = outcome;

    // Three commands ran; each was bounded by what was left minus the reserve for finishing.
    expect(outcome.starts).toEqual([
      { atMs: 0, budgetMs: 30 * MIN - ORNITH_LIMITS.verificationFinishReserveMs },
      { atMs: 511_795, budgetMs: 30 * MIN - 511_795 - ORNITH_LIMITS.verificationFinishReserveMs },
      { atMs: 511_795 + 359_814, budgetMs: 30 * MIN - 511_795 - 359_814 - ORNITH_LIMITS.verificationFinishReserveMs }
    ]);

    // What was recorded, in order: the failure, the refused identical repeat, the second failure, the timeout.
    expect(attempts(outcome).map(({ outcome: kind, exitCode, durationMs, code }) => ({ kind, exitCode, durationMs, code }))).toEqual([
      { kind: 'failed', exitCode: 1, durationMs: 511_795, code: null },
      { kind: 'not_run', exitCode: null, durationMs: 0, code: 'verification_repeat_refused' },
      { kind: 'failed', exitCode: 1, durationMs: 359_814, code: null },
      { kind: 'timed_out', exitCode: null, durationMs: 30 * MIN - 511_795 - 359_814 - ORNITH_LIMITS.verificationFinishReserveMs, code: null }
    ]);
    expect(attempts(outcome)[0]).toMatchObject({
      command: 'npm run verify',
      reason: 'npm run verify exited with code 1 after 8m32s.'
    });
    expect(attempts(outcome)[3]!.reason).toContain('implementation time budget');
    expect(result.ornithAudit.verifications).toBe(3);

    // The run ended by finishing — with its time reserve intact — not by running out of time.
    expect(result.assessment.reasonCodes).toEqual([]);
    expect(outcome.elapsedMs).toBeLessThan(30 * MIN);
    expect(outcome.elapsedMs).toBe(30 * MIN - ORNITH_LIMITS.verificationFinishReserveMs);

    // The verdict is the last thing that ACTUALLY ran; the refusal in the middle does not stand in for it.
    expect(result.assessment.verificationStatus).toBe('failed');
    expect(result.assessment.publishBlock).toBe('verification');
    expect(result.assessment.verification).toMatchObject({ command: 'npm run verify', toolUseSequence: 8 });

    // The dispatch-succeeded/command-failed distinction: no event calls a failed command ok.
    const verificationEvents = toolEvents(outcome, 'run_verification').filter(isOrnithVerificationEventData);
    expect(verificationEvents.map((data) => [data.ok, data.dispatched, data.verification.outcome])).toEqual([
      [false, true, 'failed'],
      [false, true, 'failed'],
      [false, true, 'timed_out']
    ]);

    // The edits are preserved and counted as such.
    expect(readFileSync(join(outcome.worktree, TARGET), 'utf8')).toContain(REPLACEMENT_SENTENCE);
    expect(readFileSync(join(outcome.worktree, TARGET), 'utf8')).toContain(marker(2));
    expect(result.ornithAudit.changedFiles).toBe(1);
    expect(result.ornithAudit.worktreeChangedFiles).toBe(1);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('what a verification that ran says about itself', () => {
  it('a nonzero exit is failed — command, exit code, duration, reason — with a bounded, sanitized summary, and is not ok', async () => {
    const secret = `ghp_${'A1b2C3d4E5f6G7h8'}`;
    const output = [
      'noise line\n'.repeat(50_000),
      ' FAIL  tests/adapters/native.test.ts > guard',
      'AssertionError: expected timeout to be stale_hash',
      `GITHUB_TOKEN=${secret}`,
      'at C:\\Users\\someone\\repo\\file.ts:1',
      ' Test Files  1 failed | 118 passed (119)'
    ].join('\n');
    const outcome = await runScenario({
      steps: [read, editSentence, verify],
      verifications: [exits(1, 511_795, output)]
    });

    const [event] = toolEvents(outcome, 'run_verification');
    expect(isOrnithVerificationEventData(event ?? null)).toBe(true);
    expect(event).toMatchObject({
      ok: false,
      dispatched: true,
      verification: { command: 'npm run verify', outcome: 'failed', exitCode: 1, durationMs: 511_795 }
    });
    const verification = (event as { verification: { reason: string; summary: string } }).verification;
    expect(verification.reason).toBe('npm run verify exited with code 1 after 8m32s.');
    expect(verification.summary).toContain('AssertionError: expected timeout to be stale_hash');
    expect(outcome.result.ornithAudit.outcomes.find((item) => item.action === 'run_verification')).toMatchObject({
      ok: false,
      verification: 'failed'
    });
    expect(outcome.result.assessment.verificationStatus).toBe('failed');

    // Bounded and sanitized everywhere it goes: the event, the stored audit, and what the model is shown.
    expect(verification.summary.length).toBeLessThanOrEqual(ORNITH_LIMITS.maxVerificationSummaryChars);
    expect(verification.summary).not.toContain(secret);
    expect(verification.summary).not.toContain('someone');
    const promptAfter = outcome.prompts.at(-1) ?? '';
    expect(promptAfter).toContain('AssertionError: expected timeout to be stale_hash'); // the model does learn why
    expect(promptAfter).not.toContain(secret);
    expect(promptAfter).not.toContain('noise line\nnoise line\nnoise line\nnoise line\nnoise line\nnoise line\nnoise line\nnoise line\nnoise line');
    expect(JSON.stringify(outcome.result.ornithAudit)).not.toContain(secret);
    expect(JSON.stringify(outcome.result.ornithAudit)).not.toContain('someone');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('the command’s own timeout is timed_out, distinct from a failure and from the loop budget', async () => {
    const outcome = await runScenario({
      steps: [read, editSentence, verify],
      verifications: [{ kind: 'own-timeout', durationMs: 10 * MIN }]
    });

    expect(attempts(outcome)).toHaveLength(1);
    expect(attempts(outcome)[0]).toMatchObject({ outcome: 'timed_out', exitCode: null, durationMs: 10 * MIN });
    expect(attempts(outcome)[0]!.reason).toContain('exceeded its own timeout after 10m00s');
    expect(toolEvents(outcome, 'run_verification')[0]).toMatchObject({ ok: false, dispatched: true, verification: { outcome: 'timed_out' } });
    expect(outcome.result.assessment.reasonCodes).toEqual([]); // not the loop's deadline
    expect(outcome.result.assessment.verificationStatus).toBe('failed');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('a passing verification is ok, but a diagnostic pass still cannot make the run "verified"', async () => {
    const outcome = await runScenario({ steps: [read, editSentence, verify], verifications: [exits(0, 90_000)] });

    expect(toolEvents(outcome, 'run_verification')[0]).toMatchObject({
      ok: true,
      dispatched: true,
      verification: { outcome: 'passed', exitCode: 0, durationMs: 90_000, reason: null }
    });
    // Only Relay's own identity-bound verification decides publishability.
    expect(outcome.result.assessment.verificationStatus).toBe('not_run');
    expect(outcome.result.assessment.publishBlock).toBe('verification');
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('the loop deadline and verification', () => {
  it('a verification that ignores its abort and outlives the deadline is still recorded, and the run says why it ended', async () => {
    const outcome = await runScenario({
      steps: [read, editSentence, verify],
      loopDeadlineMs: 12 * MIN,
      verifications: [{ kind: 'ignores-abort', durationMs: 60 * MIN, exitCode: 1 }]
    });

    expect(outcome.starts).toEqual([{ atMs: 0, budgetMs: 12 * MIN - ORNITH_LIMITS.verificationFinishReserveMs }]);
    expect(outcome.result.assessment.reasonCodes).toEqual(['limit_deadline_exceeded']);
    expect(outcome.result.assessment.publishBlock).toBe('configuration');
    // The deadline does not erase what verification did, nor that files changed.
    expect(attempts(outcome)).toHaveLength(1);
    expect(attempts(outcome)[0]).toMatchObject({ outcome: 'timed_out', command: 'npm run verify' });
    expect(outcome.result.assessment.verificationStatus).toBe('failed');
    expect(outcome.result.ornithAudit.changedFiles).toBe(1);
    expect(outcome.result.ornithAudit.worktreeChangedFiles).toBe(1);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('does not start a verification that cannot fit the remaining time plus the reserve, and refuses only a bounded number of times', async () => {
    // 4 min left: 2 min of reserve leaves 2 min, under the 3-minute floor. The model asks again and again.
    const asks = ORNITH_LIMITS.maxVerificationRefusals; // the last permitted refusal ends the run
    const outcome = await runScenario({
      steps: [read, editSentence, ...Array.from({ length: asks + 2 }, () => verify)],
      loopDeadlineMs: 4 * MIN,
      verifications: []
    });

    // The command is never spawned, however often it is asked for.
    expect(outcome.starts).toEqual([]);
    expect(outcome.result.ornithAudit.verifications).toBe(0);
    expect(toolEvents(outcome, 'run_verification')).toEqual([]); // refused, never run
    expect(attempts(outcome)).toHaveLength(asks);
    for (const item of attempts(outcome)) {
      expect(item).toMatchObject({ outcome: 'not_run', exitCode: null, durationMs: 0, code: 'limit_verification_time_insufficient' });
      expect(item.reason).toContain('implementation time budget');
    }
    // Recoverable feedback while the bound lasts, then the run ends.
    const denials = outcome.events.filter((event) => event.data?.['code'] === 'limit_verification_time_insufficient');
    expect(denials.map((event) => event.data?.['recoverable'])).toEqual([true, false]);
    expect(denials[0]?.data).toMatchObject({ action: 'run_verification', ok: false });
    // The feedback counts exactly the refusals still to come: "1 more … will end the run".
    expect(outcome.prompts.some((prompt) => prompt.includes('1 more refused verification will end the run'))).toBe(true);
    expect(outcome.result.assessment.reasonCodes).toEqual(['limit_verification_time_insufficient']);
    expect(outcome.result.assessment.disposition).toBe('fail');
    expect(outcome.result.assessment.publishBlock).toBe('verification');
    // Nothing ran, so there is no verdict — and the files are still there.
    expect(outcome.result.assessment.verificationStatus).toBe('not_run');
    expect(outcome.result.ornithAudit.changedFiles).toBe(1);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('needs at least as long as the last attempt took, so a slow command is not retried into a certain timeout', async () => {
    // The first run takes 9 min of 14; 5 min remain, 3 min after the reserve — under the 9 minutes it needs.
    const outcome = await runScenario({
      steps: [read, editSentence, verify, editMarker(0, 1), verify],
      loopDeadlineMs: 14 * MIN,
      verifications: [exits(1, 9 * MIN)]
    });

    expect(outcome.starts).toHaveLength(1);
    expect(attempts(outcome).map((item) => item.outcome)).toEqual(['failed', 'not_run']);
    expect(attempts(outcome)[1]).toMatchObject({ code: 'limit_verification_time_insufficient' });
    expect(attempts(outcome)[1]!.reason).toContain('needs at least 9m00s');
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('repeating a verification', () => {
  // (That a CHANGED diff is allowed another verification is covered by the live-sequence scenario above.)
  it('refuses an identical verification — also after an edit and its exact reversal — without spawning it, and only a bounded number of times', async () => {
    const outcome = await runScenario({
      steps: [
        read,
        editSentence,
        verify, // runs: exit 1
        verify, // refused (1st): the files are exactly what it just ran on
        editMarker(0, 1),
        editMarker(1, 0), // the exact reversal: byte-identical files again
        verify // refused (2nd, the last permitted): same files despite two writes in between — the run ends
      ],
      verifications: [exits(1, 200_000)]
    });

    expect(outcome.starts).toHaveLength(1);
    expect(attempts(outcome).map((item) => [item.outcome, item.code])).toEqual([
      ['failed', null],
      ['not_run', 'verification_repeat_refused'],
      ['not_run', 'verification_repeat_refused']
    ]);
    const denials = outcome.events.filter((event) => event.data?.['code'] === 'verification_repeat_refused');
    expect(denials.map((event) => event.data?.['recoverable'])).toEqual([true, false]);
    expect(denials[0]?.data).toMatchObject({ action: 'run_verification', ok: false });
    // The feedback tells the model that nothing was started and what to do instead.
    expect(outcome.prompts.some((prompt) => prompt.includes('Verification was NOT started'))).toBe(true);
    expect(outcome.result.assessment.reasonCodes).toEqual(['verification_repeat_refused']);
    expect(outcome.result.assessment.disposition).toBe('fail');
    // The refusals never hide the failure that started it, and the edits are kept.
    expect(outcome.result.assessment.verificationStatus).toBe('failed');
    expect(outcome.result.ornithAudit.changedFiles).toBe(1);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('what the worktree holds when the run ends', () => {
  it('counts edits that an earlier attempt left, even though this round changed nothing', async () => {
    const outcome = await runScenario({
      steps: [done],
      prepare: (worktree) => {
        writeFileSync(join(worktree, TARGET), targetContent(2_000).replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE), 'utf8');
      }
    });

    expect(outcome.result.ornithAudit.changedFiles).toBe(0);
    expect(outcome.result.ornithAudit.worktreeChangedFiles).toBe(1);
  }, REAL_GIT_TEST_TIMEOUT_MS);

});

describe('a run that ends on a security refusal', () => {
  it('runs no further Git command in the worktree: the changed-file count stays unknown', async () => {
    // An absolute machine path in the approved inputs is refused before the first inference.
    const outcome = await runScenario({
      steps: [done],
      implementationPrompt: 'Also read C:\\Users\\someone\\private\\notes.txt before editing.',
      prepare: (worktree) => {
        writeFileSync(join(worktree, TARGET), targetContent(2_000).replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE), 'utf8');
      }
    });

    expect(outcome.result.assessment.publishBlock).toBe('security');
    // A clean run over this same dirty worktree reports 1 (see above); after a security stop it is not asked.
    expect(outcome.result.ornithAudit.worktreeChangedFiles).toBeNull();
    expect(outcome.starts).toEqual([]);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('exploring beyond an explicitly named file', () => {
  const searchEvents = (outcome: Outcome) => toolEvents(outcome, 'search_text');
  const denied = (outcome: Outcome) => outcome.result.ornithAudit.outcomes.filter((item) => item.code === 'scope_expansion_refused');

  it('refuses a repository-wide search while the named file has not come up empty — a search that FOUND something is no evidence to widen — and reads nothing for it', async () => {
    const outcome = await runScenario({
      steps: [
        read,
        searchAll('dashboard'), // no scoped search yet: refused
        searchScoped('dashboard'), // finds the sentence in the named file
        searchAll('dashboard loads') // the named file was NOT empty, so still no evidence: refused (2nd, the last permitted)
      ]
    });

    expect(denied(outcome).map((item) => item.sequence)).toEqual([2, 4]);
    expect(denied(outcome)[0]).toEqual({ sequence: 2, action: 'search_text', ok: false, code: 'scope_expansion_refused' });
    expect(outcome.result.assessment.reasonCodes).toEqual(['scope_expansion_refused']); // the 2nd refusal ended the run
    expect(searchEvents(outcome)).toHaveLength(1); // only the scoped one was ever dispatched
    // Only the read of the named file and the scoped search were charged; the refused ones cost nothing.
    const charged = outcome.events
      .filter((event) => event.type === 'tool_use' && event.data?.['ok'] === true)
      .reduce((sum, event) => sum + (typeof event.data?.['readBytes'] === 'number' ? event.data['readBytes'] : 0), 0);
    expect(outcome.result.ornithAudit.readBytes).toBe(charged);
    // The feedback names the file and says how to earn a wider search.
    const feedback = outcome.prompts.find((prompt) => prompt.includes('scope_expansion_refused')) ?? '';
    expect(feedback).toContain(TARGET);
    expect(feedback).toContain('"files"');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('still lets the model widen the search once the named file has come up empty — one search per empty result', async () => {
    const outcome = await runScenario({
      extraFiles: { 'docs/other.md': 'The provider smoke-test checklist is described here.\n' },
      steps: [
        read,
        searchScoped('provider smoke-test'),
        searchAll('provider smoke-test'),
        searchAll('smoke-test checklist'),
        done
      ]
    });

    const searches = searchEvents(outcome);
    expect(searches).toHaveLength(2); // the scoped one, and the ONE wider one the empty result earned
    expect(searches.every((data) => data['ok'] === true)).toBe(true);
    expect(outcome.prompts.some((prompt) => prompt.includes('docs/other.md'))).toBe(true);
    // The credit was spent: a second wide search is refused again.
    expect(denied(outcome)).toEqual([{ sequence: 4, action: 'search_text', ok: false, code: 'scope_expansion_refused' }]);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('ends the run on the last permitted refusal of a wide search, feeding back only the ones before it', async () => {
    const asks = ORNITH_LIMITS.maxScopeExpansionRefusals;
    const outcome = await runScenario({
      steps: [read, ...Array.from({ length: asks + 1 }, (_, index) => searchAll(`needle-${index}`))]
    });

    expect(denied(outcome)).toHaveLength(asks); // the extra request was never made: the run had ended
    expect(outcome.result.assessment.reasonCodes).toEqual(['scope_expansion_refused']);
    expect(outcome.result.assessment.disposition).toBe('fail');
    expect(searchEvents(outcome)).toEqual([]);
    const denials = outcome.events.filter((event) => event.data?.['code'] === 'scope_expansion_refused');
    expect(denials.map((event) => event.data?.['recoverable'])).toEqual([true, false]);
    expect(outcome.prompts.some((prompt) => prompt.includes('1 more refused search will end the run'))).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('grants a wider search only for a search of the WHOLE declared scope: empty in one of two named files proves nothing about the other', async () => {
    const outcome = await runScenario({
      scope: [TARGET, 'docs/other.md'],
      extraFiles: { 'docs/other.md': 'The provider smoke-test checklist is described here.\n' },
      steps: [
        read,
        searchScoped('provider smoke-test', [TARGET]), // empty in ONE of the two named files: earns nothing
        searchAll('provider smoke-test'), // refused
        searchScoped('provider smoke-test', [TARGET, 'docs/other.md']), // finds it in the other file: not empty either
        searchScoped('zz-not-anywhere', [TARGET, 'docs/other.md']), // empty across the whole scope: earns one
        searchAll('zz-not-anywhere'), // the earned wider search: dispatched
        done
      ]
    });

    expect(denied(outcome).map((item) => item.sequence)).toEqual([3]);
    // Dispatched: the partial scoped search, the full one that found something, the empty full one, and the wide one.
    expect(searchEvents(outcome)).toHaveLength(4);
    expect(searchEvents(outcome).every((data) => data['ok'] === true)).toBe(true);
    expect(outcome.result.assessment.reasonCodes).toEqual([]); // finished normally
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('leaves a task with no declared scope exactly as it was: repository-wide search is dispatched, and a clean worktree reports nothing', async () => {
    const outcome = await runScenario({ scope: [], steps: [searchAll('dashboard'), done] });

    expect(searchEvents(outcome)).toHaveLength(1);
    expect(denied(outcome)).toEqual([]);
    expect(outcome.result.ornithAudit.changedFiles).toBe(0);
    expect(outcome.result.ornithAudit.worktreeChangedFiles).toBe(0);
    expect(attempts(outcome)).toEqual([]);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
