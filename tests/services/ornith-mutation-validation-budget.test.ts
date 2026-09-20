/**
 * Ornith edit validation must not depend on what is left of the model's DISCOVERY budget.
 *
 * Every test here drives the production `OrnithImplementationService` and the production
 * worktree tools over a real temporary Git worktree; only the model's answers are scripted
 * (see tests/helpers/ornith-budget-replay.ts). The headline test replays the run observed in
 * production (task a5de435b…, run bb779441…) byte for byte; the others pin the boundaries
 * around it. Against the parent commit the headline test fails at `replace_text` with
 * `limit_read_bytes_exceeded` and writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';
import {
  createReplayFixture,
  fillerPath,
  marker,
  OBSERVED_READ_CHARGE,
  OBSERVED_REMAINING,
  OBSERVED_SEARCH_CHARGE,
  DISCOVERY_BUDGET,
  ORIGINAL_SENTENCE,
  REPLACEMENT_SENTENCE,
  replay,
  sha256Of,
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
/** Discovery left after one whole-target read and four filler reads that spend it all. */
const DRAIN_TO_ZERO = [MIB, MIB, MIB, DISCOVERY_BUDGET - 3 * MIB - SMALL_TARGET];
/** The target is never read; four filler reads leave exactly the observed 93 bytes. */
const DRAIN_TO_93_TARGET_UNREAD = [MIB, MIB, MIB, MIB - OBSERVED_REMAINING];

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

describe('Ornith edit validation after the discovery budget is spent', () => {
  it('the observed run leaves exactly 93 discovery bytes', () => {
    expect(OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE).toBe(4_194_211);
    expect(OBSERVED_REMAINING).toBe(93);
    expect(DISCOVERY_BUDGET).toBe(ORNITH_LIMITS.maxCumulativeReadBytes);
  });

  it(
    'replays the production run: 25 windows, one repository-wide search, then replace_text on the fully read target',
    async () => {
      const fixture = await fixtureFor({});
      const run = await replay(fixture, {
        afterRead: [{ kind: 'search_all' }, { kind: 'replace' }, { kind: 'verify' }, { kind: 'finish' }]
      });

      // The edit is accepted — this is what failed with limit_read_bytes_exceeded before the fix.
      expect(outcomeFor(run, 'replace_text'), run.result.finalMessage).toEqual([
        { sequence: 27, action: 'replace_text', ok: true }
      ]);
      expect(run.result.assessment.reasonCodes).toEqual([]);
      expect(run.result.assessment.disposition).toBe('pass');

      // It is the observed run: 25 windows of the target, a repository-wide search, then the edit.
      const kinds = run.actions.map((action) => action.action);
      expect(kinds.slice(0, 25).every((kind) => kind === 'read_file')).toBe(true);
      expect(kinds.slice(25)).toEqual(['search_text', 'replace_text', 'run_verification', 'finish']);
      expect(eventFor(run, 'read_file', true)?.['cumulativeReadBytes']).toBe(TARGET_BYTES);
      expect(eventFor(run, 'search_text', true)).toMatchObject({
        readBytes: OBSERVED_SEARCH_CHARGE,
        cumulativeReadBytes: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE
      });

      // Exactly the intended text was written, into exactly one file.
      expect(run.targetAfter).toBe(targetContent().replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE));
      expect(run.status.split(/\r?\n/).filter((line) => line.length > 0)).toEqual([' M docs/manual-test.md']);
      expect(run.result.ornithAudit.changedFiles).toBe(1);
      expect(run.verifications).toBe(1);

      // Two budgets, honestly separate: discovery is exactly what the model spent — the edit did not
      // add to it, and the budget itself was not raised — and validation is what Relay re-read.
      const written = TARGET_BYTES + REPLACEMENT_SENTENCE.length - ORIGINAL_SENTENCE.length;
      expect(run.result.ornithAudit).toMatchObject({
        readBytes: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE,
        validationReadBytes: 2 * TARGET_BYTES,
        writeBytes: written,
        changedFiles: 1
      });
      expect(ORNITH_LIMITS.maxCumulativeReadBytes).toBe(4 * 1024 * 1024);
      expect(eventFor(run, 'replace_text', true)).toMatchObject({
        readBytes: 0,
        validationReadBytes: 2 * TARGET_BYTES,
        writeBytes: written,
        cumulativeReadBytes: OBSERVED_READ_CHARGE + OBSERVED_SEARCH_CHARGE,
        cumulativeValidationReadBytes: 2 * TARGET_BYTES,
        changedPath: TARGET
      });

      // What the model is told: the deterministic notice once the search spent the budget, and both
      // budgets on every later turn, unchanged discovery beside the smaller validation remainder.
      const beforeEdit = run.prompts[26]!;
      expect(beforeEdit).toContain(`Repository read bytes remaining: ${OBSERVED_REMAINING}`);
      expect(beforeEdit).toContain(`relayNotice`);
      expect(beforeEdit).toContain(`${OBSERVED_REMAINING} of ${DISCOVERY_BUDGET} bytes remain`);
      expect(run.prompts.filter((prompt) => prompt.includes('relayNotice')).length).toBeGreaterThan(0);
      const afterEdit = run.prompts[27]!;
      expect(afterEdit).toContain(`Repository read bytes remaining: ${OBSERVED_REMAINING}`);
      expect(afterEdit).toContain(
        `Edit validation bytes remaining (internal; reads and searches never spend it): ${VALIDATION_BUDGET - 2 * TARGET_BYTES}`
      );
    },
    180_000
  );

  it('still edits a fully read target when discovery is at exactly 0 bytes, and discovery stays refused', async () => {
    const fixture = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false, fillerSizes: DRAIN_TO_ZERO });
    const run = await replay(fixture, {
      windows: 1,
      windowLimit: 4_096,
      afterRead: [
        ...drain(4),
        { kind: 'replace' },
        // Discovery must not have been widened by the edit: the same read is still refused.
        { kind: 'read', path: TARGET },
        { kind: 'finish' }
      ]
    });

    expect(run.result.ornithAudit.outcomes.map((outcome) => [outcome.action, outcome.ok, outcome.code])).toEqual([
      ['read_file', true, undefined],
      ['read_file', true, undefined],
      ['read_file', true, undefined],
      ['read_file', true, undefined],
      ['read_file', true, undefined],
      ['replace_text', true, undefined],
      ['read_file', false, 'limit_read_bytes_exceeded']
    ]);
    expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: DISCOVERY_BUDGET,
      validationReadBytes: 2 * SMALL_TARGET,
      changedFiles: 1
    });
    expect(run.targetAfter).toBe(targetContent(SMALL_TARGET).replace(ORIGINAL_SENTENCE, REPLACEMENT_SENTENCE));
    expect(eventFor(run, 'read_file', false)).toMatchObject({
      code: 'limit_read_bytes_exceeded',
      readBytesUsed: DISCOVERY_BUDGET,
      readBytesConfigured: DISCOVERY_BUDGET,
      validationBytesUsed: 2 * SMALL_TARGET,
      validationBytesConfigured: VALIDATION_BUDGET,
      changedFiles: 1
    });
  }, 180_000);

  it('a repository-wide search still respects the 4 MiB discovery limit, and the edit still works after its recovery', async () => {
    const fixture = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false, fillerSizes: DRAIN_TO_ZERO });
    const run = await replay(fixture, {
      windows: 1,
      windowLimit: 4_096,
      afterRead: [...drain(4), { kind: 'search_all' }, { kind: 'replace' }, { kind: 'verify' }, { kind: 'finish' }]
    });

    expect(outcomeFor(run, 'search_text')).toEqual([
      { sequence: 6, action: 'search_text', ok: false, code: 'limit_read_bytes_exceeded' }
    ]);
    expect(outcomeFor(run, 'replace_text')).toEqual([{ sequence: 7, action: 'replace_text', ok: true }]);
    expect(run.result.assessment.disposition, run.result.finalMessage).toBe('pass');
    expect(run.result.ornithAudit).toMatchObject({ readBytes: DISCOVERY_BUDGET, validationReadBytes: 2 * SMALL_TARGET });
    expect(run.targetAfter).toContain(REPLACEMENT_SENTENCE);
  }, 180_000);

  it('denies an edit of a file whose hash was never shown, on the discovery budget, with 93 bytes left', async () => {
    const fixture = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false, fillerSizes: DRAIN_TO_93_TARGET_UNREAD });
    // The hash is right — the model could only have got it by reading the file, which it never did.
    const neverShown = sha256Of(targetContent(SMALL_TARGET));
    const run = await replay(fixture, {
      windows: 0,
      afterRead: [...drain(4), { kind: 'replace', sha256: neverShown }, { kind: 'finish' }]
    });

    expect(run.result.assessment.disposition).toBe('fail');
    expect(run.result.assessment.reasonCodes).toEqual(['limit_read_bytes_exceeded']);
    expect(run.result.assessment.publishBlock).toBe('configuration');
    expect(run.targetAfter).toBe(targetContent(SMALL_TARGET));
    expect(run.status.trim()).toBe('');
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: DISCOVERY_BUDGET - OBSERVED_REMAINING,
      validationReadBytes: 0,
      changedFiles: 0
    });
    expect(run.result.finalMessage).toContain('Budget exhausted: repository DISCOVERY');
    expect(run.result.finalMessage).toContain(
      `${DISCOVERY_BUDGET - OBSERVED_REMAINING} of ${DISCOVERY_BUDGET} repository discovery bytes used`
    );
    expect(run.result.finalMessage).toContain(`0 of ${VALIDATION_BUDGET} internal edit-validation bytes used`);
    expect(run.result.finalMessage).toContain('No files were changed.');
    expect(eventFor(run, 'replace_text', false)).toMatchObject({
      code: 'limit_read_bytes_exceeded',
      recoverable: false,
      readBytesUsed: DISCOVERY_BUDGET - OBSERVED_REMAINING,
      validationBytesUsed: 0,
      changedFiles: 0
    });
  }, 180_000);

  it('fails closed when the target changed after its last read, and reports it as stale, not as a budget', async () => {
    const fixture = await fixtureFor({ targetBytes: SMALL_TARGET, companions: false, fillerSizes: DRAIN_TO_ZERO });
    const outside = targetContent(SMALL_TARGET).replace('# Manual test', '# Manuel test');
    const run = await replay(fixture, {
      windows: 1,
      windowLimit: 4_096,
      afterRead: [...drain(4), { kind: 'replace' }, { kind: 'finish' }],
      // The turn that asks for the edit (1 read + 4 fillers precede it): someone else edits the file first.
      beforeTurn: (turn) => {
        if (turn === 6) writeFileSync(join(fixture.worktree, TARGET), outside, 'utf8');
      }
    });

    expect(run.result.assessment.reasonCodes).toEqual(['stale_hash']);
    expect(run.result.finalMessage).not.toContain('Budget exhausted');
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: DISCOVERY_BUDGET,
      // Relay read the file once to find the hash no longer matched, and stopped there.
      validationReadBytes: SMALL_TARGET,
      changedFiles: 0
    });
    // Relay wrote nothing; the file is exactly what the outside change left.
    expect(readFileSync(join(fixture.worktree, TARGET), 'utf8')).toBe(outside);
  }, 180_000);

  it('refuses a target above the per-change size bound before reading it, and does not call that an exhausted budget', async () => {
    const fixture = await fixtureFor({ targetBytes: ORNITH_LIMITS.maxFileBytes + 1, companions: false });
    const run = await replay(fixture, {
      windows: 1,
      windowLimit: 4_096,
      afterRead: [{ kind: 'replace' }, { kind: 'finish' }]
    });

    expect(run.result.assessment.reasonCodes).toEqual(['limit_mutation_target_bytes_exceeded']);
    expect(run.result.assessment.publishBlock).toBe('configuration');
    expect(run.targetAfter).toBe(targetContent(ORNITH_LIMITS.maxFileBytes + 1));
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: ORNITH_LIMITS.maxFileBytes + 1,
      validationReadBytes: 0,
      changedFiles: 0
    });
    // Neither budget ran out, and the message says so instead of blaming one of them.
    expect(run.result.finalMessage).toContain('No byte budget was exhausted');
    expect(run.result.finalMessage).toContain(`${ORNITH_LIMITS.maxFileBytes}-byte limit for one change`);
    expect(run.result.finalMessage).toContain('No files were changed.');
    expect(run.result.finalMessage).not.toContain('Budget exhausted');
    expect(eventFor(run, 'replace_text', false)).toMatchObject({
      code: 'limit_mutation_target_bytes_exceeded',
      recoverable: false,
      readBytesUsed: ORNITH_LIMITS.maxFileBytes + 1,
      validationBytesUsed: 0,
      validationBytesConfigured: VALIDATION_BUDGET
    });
  }, 180_000);

  it('bounds cumulative validation on its own: four edits fit exactly, the fifth is refused as validation', async () => {
    const fixture = await fixtureFor({ targetBytes: ORNITH_LIMITS.maxFileBytes, companions: false });
    const edit = (revision: number): ReplayStep => ({
      kind: 'replace',
      sha256: 'shown',
      oldText: marker(revision),
      newText: marker(revision + 1)
    });
    const run = await replay(fixture, {
      windows: 1,
      windowLimit: 4_096,
      afterRead: [{ kind: 'replace', sha256: 'observed', oldText: marker(0), newText: marker(1) }, edit(1), edit(2), edit(3), edit(4), { kind: 'finish' }]
    });

    expect(outcomeFor(run, 'replace_text').map((outcome) => outcome.ok)).toEqual([true, true, true, true, false]);
    expect(run.result.assessment.reasonCodes).toEqual(['limit_mutation_validation_bytes_exceeded']);
    // Each edit re-reads its 1 MiB target twice: 4 × 2 MiB is exactly the internal budget.
    expect(run.result.ornithAudit).toMatchObject({
      readBytes: ORNITH_LIMITS.maxFileBytes,
      validationReadBytes: VALIDATION_BUDGET,
      changedFiles: 1
    });
    expect(run.targetAfter).toContain(marker(4));
    expect(run.result.finalMessage).toContain('Budget exhausted: internal EDIT VALIDATION');
    expect(run.result.finalMessage).toContain(`${VALIDATION_BUDGET} of ${VALIDATION_BUDGET} internal edit-validation bytes used`);
    expect(run.result.finalMessage).toContain('1 file was changed and remains in the task worktree.');
    expect(eventFor(run, 'replace_text', false)).toMatchObject({
      code: 'limit_mutation_validation_bytes_exceeded',
      validationBytesUsed: VALIDATION_BUDGET,
      validationBytesConfigured: VALIDATION_BUDGET,
      readBytesUsed: ORNITH_LIMITS.maxFileBytes
    });
  }, 240_000);
});
