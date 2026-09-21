/**
 * `git_diff` after the discovery budget is nearly spent.
 *
 * With the edit-validation budget separate, Ornith can edit a file at 93 discovery bytes left.
 * The natural next step is `git_diff` of that edit, which cannot fit in 93 bytes. That must be
 * an honest, recoverable discovery-budget refusal — never `internal_error` — so the model can
 * skip the diff and go on to verification and finish with its edit intact.
 *
 * Every test drives the production `OrnithImplementationService` and production worktree tools
 * over a real temporary Git worktree; only the model's answers are scripted. Against the parent
 * commit the headline replay fails: `git_diff` returns `internal_error` and the run ends there.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';
import {
  createReplayFixture,
  DISCOVERY_BUDGET,
  fillerPath,
  git,
  ORIGINAL_SENTENCE,
  OBSERVED_READ_CHARGE,
  OBSERVED_REMAINING,
  OBSERVED_SEARCH_CHARGE,
  REPLACEMENT_SENTENCE,
  replay,
  TARGET,
  TARGET_BYTES,
  targetContent,
  type ReplayFixture,
  type ReplayResult,
  type ReplayStep
} from '../helpers/ornith-budget-replay';

const MIB = 1_048_576;
const SMALL_TARGET = 2_000;
const VALIDATION_BUDGET = ORNITH_LIMITS.maxCumulativeMutationValidationBytes;
const UNIQUE_MARKER = 'ZZ-UNIQUE-DIFF-MARKER';

/** Fillers that, after one whole-target read, leave exactly `remaining` discovery bytes. */
const fillersLeaving = (remaining: number): number[] => [
  MIB,
  MIB,
  MIB,
  DISCOVERY_BUDGET - 3 * MIB - SMALL_TARGET - remaining
];

const fixtures: ReplayFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

async function fixtureFor(options: Parameters<typeof createReplayFixture>[0]): Promise<ReplayFixture> {
  const fixture = await createReplayFixture(options);
  fixtures.push(fixture);
  return fixture;
}

const drain = (count: number): ReplayStep[] =>
  Array.from({ length: count }, (_unused, index) => ({ kind: 'read' as const, path: fillerPath(index) }));

const toolEvents = (run: ReplayResult) =>
  run.events.flatMap((event) => (event.type === 'tool_use' && event.data ? [event.data as Record<string, unknown>] : []));
const eventFor = (run: ReplayResult, action: string, ok: boolean) =>
  toolEvents(run).find((data) => data['action'] === action && data['ok'] === ok);
const outcomeFor = (run: ReplayResult, action: string) =>
  run.result.ornithAudit.outcomes.filter((outcome) => outcome.action === action);

/** The bytes the production `git diff HEAD -- <target>` yields for the standard edit, taken from Git itself. */
async function diffBytesOfTheEdit(): Promise<number> {
  const scratch = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false });
  const path = join(scratch.worktree, TARGET);
  writeFileSync(path, readFileSync(path, 'utf8').replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE), 'utf8');
  return Buffer.byteLength(await git(scratch.worktree, ['diff', 'HEAD', '--', TARGET]), 'utf8');
}

/** One small-fixture run: read the target once, spend discovery down to `remaining`, then follow `steps`. */
async function runWithDiscoveryLeft(remaining: number, steps: readonly ReplayStep[], newText?: string) {
  const fixture = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false, fillerSizes: fillersLeaving(remaining) });
  const edit: ReplayStep[] = steps.map((step) =>
    step.kind === 'replace' && newText !== undefined ? { ...step, newText } : step
  );
  return replay(fixture, { windows: 1, windowLimit: 4_096, afterRead: [...drain(4), ...edit] });
}

describe('git_diff with only a few discovery bytes left', () => {
  it(
    'replays the 93-byte run: replace succeeds on the validation budget, git_diff is honestly refused, the model skips it and finishes',
    async () => {
      const fixture = await fixtureFor({});
      const run = await replay(fixture, {
        afterRead: [{ kind: 'search_all' }, { kind: 'replace' }, { kind: 'diff' }, { kind: 'verify' }, { kind: 'finish' }]
      });

      // The state the diff is asked in: exactly 93 discovery bytes left, the edit already made.
      expect(eventFor(run, 'search_text', true)).toMatchObject({
        cumulativeReadBytes: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE
      });
      expect(DISCOVERY_BUDGET - (OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE)).toBe(OBSERVED_REMAINING);
      expect(outcomeFor(run, 'replace_text')).toEqual([{ sequence: 27, action: 'replace_text', ok: true }]);

      // The diff cannot fit; that is a discovery-budget refusal, not an internal error.
      expect(outcomeFor(run, 'git_diff')).toEqual([
        { sequence: 28, action: 'git_diff', ok: false, code: 'limit_read_bytes_exceeded' }
      ]);
      expect(eventFor(run, 'git_diff', false)).toMatchObject({
        code: 'limit_read_bytes_exceeded',
        recoverable: true,
        readBytesUsed: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE,
        readBytesConfigured: DISCOVERY_BUDGET,
        validationBytesUsed: 2 * TARGET_BYTES,
        validationBytesConfigured: VALIDATION_BUDGET,
        changedFiles: 1
      });

      // The model is told, in bounded fixed words, to skip the diff and carry on — and does.
      const afterRefusal = run.prompts[28]!;
      expect(afterRefusal).toContain('Skip the diff');
      expect(afterRefusal).toContain('is intact and unaffected');
      expect(afterRefusal).not.toContain('internal_error');
      const kinds = run.actions.map((action) => action.action);
      expect(kinds.slice(25)).toEqual(['search_text', 'replace_text', 'git_diff', 'run_verification', 'finish']);
      expect(run.verifications).toBe(1);
      expect(run.result.assessment.reasonCodes).toEqual([]);
      expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');

      // The mutation is intact, and the counters stayed honest.
      expect(run.targetAfter).toBe(targetContent().replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE));
      expect(run.status.split(/\r?\n/).filter((line) => line.length > 0)).toEqual([` M ${TARGET}`]);
      expect(run.result.ornithAudit).toMatchObject({
        readBytes: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE,
        validationReadBytes: 2 * TARGET_BYTES,
        changedFiles: 1,
        verifications: 1
      });
    },
    180_000
  );

  it('refuses the diff at exactly 0 discovery bytes, recoverably, and the run still finishes with the edit intact', async () => {
    const run = await runWithDiscoveryLeft(0, [{ kind: 'replace' }, { kind: 'diff' }, { kind: 'verify' }, { kind: 'finish' }]);

    expect(outcomeFor(run, 'git_diff')).toEqual([
      { sequence: 7, action: 'git_diff', ok: false, code: 'limit_read_bytes_exceeded' }
    ]);
    expect(eventFor(run, 'git_diff', false)).toMatchObject({
      code: 'limit_read_bytes_exceeded',
      recoverable: true,
      readBytesUsed: DISCOVERY_BUDGET,
      readBytesConfigured: DISCOVERY_BUDGET,
      validationBytesUsed: 2 * SMALL_TARGET,
      changedFiles: 1
    });
    expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
    expect(run.verifications).toBe(1);
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: DISCOVERY_BUDGET,
      validationReadBytes: 2 * SMALL_TARGET,
      changedFiles: 1
    });
    expect(run.targetAfter).toBe(targetContent(SMALL_TARGET).replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE));
  }, 180_000);

  it('returns a diff that fits the remaining discovery budget exactly, and charges exactly that to discovery', async () => {
    const bytes = await diffBytesOfTheEdit();
    expect(bytes).toBeGreaterThan(100);
    const run = await runWithDiscoveryLeft(bytes, [{ kind: 'replace' }, { kind: 'diff' }, { kind: 'verify' }, { kind: 'finish' }]);

    expect(outcomeFor(run, 'git_diff')).toEqual([{ sequence: 7, action: 'git_diff', ok: true }]);
    expect(eventFor(run, 'git_diff', true)).toMatchObject({ readBytes: bytes, cumulativeReadBytes: DISCOVERY_BUDGET });
    // The model really is shown the diff, and only that.
    expect(run.prompts[7]!).toContain(REPLACEMENT_SENTENCE);
    expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
    expect(run.result.ornithAudit).toMatchObject({ readBytes: DISCOVERY_BUDGET, validationReadBytes: 2 * SMALL_TARGET });
  }, 180_000);

  it('refuses a diff that exceeds the remaining discovery budget by one byte, and by two', async () => {
    const bytes = await diffBytesOfTheEdit();
    for (const short of [1, 2]) {
      const run = await runWithDiscoveryLeft(bytes - short, [{ kind: 'replace' }, { kind: 'diff' }, { kind: 'verify' }, { kind: 'finish' }]);

      expect(outcomeFor(run, 'git_diff'), `short by ${short}`).toEqual([
        { sequence: 7, action: 'git_diff', ok: false, code: 'limit_read_bytes_exceeded' }
      ]);
      // Nothing of the diff reached the model.
      expect(run.prompts.some((prompt) => prompt.includes('diff --git'))).toBe(false);
      expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
      // The refused diff charged nothing: discovery is exactly what the target and fillers spent.
      expect(run.result.ornithAudit).toMatchObject({ readBytes: DISCOVERY_BUDGET - (bytes - short) });
    }
  }, 240_000);

  it('refuses a diff far larger than the remaining budget without returning any of it', async () => {
    // Well past what the runner is allowed to buffer for the remaining bytes, so the process layer
    // itself stops Git at its output cap: still a discovery-budget refusal, and nothing is shown.
    const large = `${UNIQUE_MARKER} ${'lorem ipsum dolor sit amet '.repeat(2_200)}`;
    const run = await runWithDiscoveryLeft(0, [{ kind: 'replace' }, { kind: 'diff' }, { kind: 'verify' }, { kind: 'finish' }], large);

    expect(outcomeFor(run, 'replace_text')).toEqual([{ sequence: 6, action: 'replace_text', ok: true }]);
    expect(outcomeFor(run, 'git_diff')).toEqual([
      { sequence: 7, action: 'git_diff', ok: false, code: 'limit_read_bytes_exceeded' }
    ]);
    expect(run.prompts.some((prompt) => prompt.includes(UNIQUE_MARKER))).toBe(false);
    expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
    expect(run.targetAfter).toContain(UNIQUE_MARKER);
  }, 180_000);

  it('does not let an identical repeat of the refused diff become a retry loop: it is skipped once, then stops the run', async () => {
    const run = await runWithDiscoveryLeft(0, [
      { kind: 'replace' },
      { kind: 'diff' },
      { kind: 'diff' },
      { kind: 'diff' },
      { kind: 'finish' }
    ]);

    // The tool was asked once. The second identical request was skipped with feedback, the third stopped the run.
    const asked = toolEvents(run).filter((data) => data['action'] === 'git_diff' && data['code'] === 'limit_read_bytes_exceeded');
    expect(asked).toHaveLength(1);
    expect(toolEvents(run).filter((data) => data['code'] === 'duplicate_no_progress')).toHaveLength(1);
    expect(run.prompts.some((prompt) => prompt.includes('skip the diff and continue with'))).toBe(true);
    expect(run.result.assessment.disposition).toBe('fail');
    expect(run.result.assessment.reasonCodes).toEqual(['no_progress_loop']);
    // Neither budget moved, and the edit is still there.
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: DISCOVERY_BUDGET,
      validationReadBytes: 2 * SMALL_TARGET,
      changedFiles: 1,
      verifications: 0
    });
    expect(run.targetAfter).toContain(REPLACEMENT_SENTENCE);
  }, 180_000);

  it('ends the run, honestly, when a DIFFERENT diff is refused too: the one recovery is spent, the edit stays', async () => {
    const run = await runWithDiscoveryLeft(0, [
      { kind: 'replace' },
      { kind: 'diff' },
      { kind: 'diff_all' },
      { kind: 'verify' },
      { kind: 'finish' }
    ]);

    const denials = toolEvents(run).filter((data) => data['action'] === 'git_diff' && data['ok'] === false);
    expect(denials.map((data) => [data['code'], data['recoverable']])).toEqual([
      ['limit_read_bytes_exceeded', true],
      ['limit_read_bytes_exceeded', false]
    ]);
    // Both events, the recovering one and the terminal one, carry both budgets' used/configured bytes.
    for (const denial of denials) {
      expect(denial).toMatchObject({
        readBytesUsed: DISCOVERY_BUDGET,
        readBytesConfigured: DISCOVERY_BUDGET,
        validationBytesUsed: 2 * SMALL_TARGET,
        validationBytesConfigured: VALIDATION_BUDGET,
        changedFiles: 1
      });
    }
    expect(run.result.assessment.disposition).toBe('fail');
    expect(run.result.assessment.reasonCodes).toEqual(['limit_read_bytes_exceeded']);
    expect(run.result.assessment.publishBlock).toBe('configuration');
    expect(run.result.finalMessage).toContain('Budget exhausted: repository DISCOVERY');
    expect(run.result.finalMessage).toContain(`${DISCOVERY_BUDGET} of ${DISCOVERY_BUDGET} repository discovery bytes used`);
    expect(run.result.finalMessage).toContain(`${2 * SMALL_TARGET} of ${VALIDATION_BUDGET} internal edit-validation bytes used`);
    expect(run.result.finalMessage).toContain('1 file was changed and remains in the task worktree.');
    expect(run.result.finalMessage).toContain('the changes already made are intact');
    expect(run.result.finalMessage).not.toContain('internal_error');
    expect(run.verifications).toBe(0);
    expect(run.targetAfter).toContain(REPLACEMENT_SENTENCE);
  }, 180_000);
});
