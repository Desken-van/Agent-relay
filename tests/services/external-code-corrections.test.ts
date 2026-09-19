import { afterEach, describe, expect, it } from 'vitest';
import { correctionAction } from '../../src/shared/domain/claude-assessment';
import { mergeExternalRequirements, type ExternalCodeRequirement } from '../../src/main/services/orchestrator';
import { AgentRelayError, InvalidTransitionError } from '../../src/shared/domain/errors';
import { createHarness, runToReview, type Harness } from '../helpers/harness';
import { makeReview } from '../helpers/fakes';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const requirement = (overrides: Partial<ExternalCodeRequirement> = {}): ExternalCodeRequirement => ({
  title: 'The retry is ambiguous',
  body: 'A lost response may repeat work.',
  fix: 'Persist the intent before calling out.',
  severity: 'major',
  file: 'src/service.ts',
  line: 42,
  ...overrides
});

/** A harness whose external-requirement source a test controls. */
function withRequirements(initial: readonly ExternalCodeRequirement[] = [], settings = {}) {
  let current = initial;
  const harness = createHarness({ settings, externalCodeRequirements: () => current });
  harnesses.push(harness);
  return {
    harness,
    setRequirements: (next: readonly ExternalCodeRequirement[]) => {
      current = next;
    }
  };
}

describe('accepted external code-review findings ride the ordinary correction round', () => {
  it('sends them as corrections from a ready round, through the same provider, budget and prompt', async () => {
    const { harness } = withRequirements([requirement()]);
    const { task } = await runToReview(harness);
    expect(task.status).toBe('READY_FOR_REVIEW');

    const corrected = await harness.orchestrator.sendCorrections(task.id);

    // The existing lifecycle: a correction round was spent and verified, and the task is back in review.
    expect(corrected.currentRound).toBe(2);
    expect(corrected.status).toBe('READY_FOR_REVIEW');
    expect(harness.claude.calls).toHaveLength(2);
    const prompt = harness.claude.calls[1]?.prompt ?? '';
    expect(prompt).toContain('External code review: The retry is ambiguous');
    expect(prompt).toContain('A lost response may repeat work.');
    expect(prompt).toContain('Accepted correction: Persist the intent before calling out.');
    expect(prompt).toContain('src/service.ts');
    // It is a correction round in the run history, not a parallel kind of run.
    expect(harness.runs.listByTask(task.id).some((run) => run.runType === 'correction')).toBe(true);
  });

  it('is available from an approved round too, and from nowhere that has no way into implementation', async () => {
    const { harness } = withRequirements([requirement()]);
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue.push(makeReview({ verdict: 'approved', findings: [] }));
    const approved = await harness.orchestrator.reviewWithCodex(task.id);
    expect(approved.status).toBe('APPROVED');

    const corrected = await harness.orchestrator.sendCorrections(task.id);
    expect(corrected.currentRound).toBe(2);

    for (const status of ['VERIFYING', 'PUBLISHING', 'COMPLETED', 'DRAFT'] as const) {
      expect(
        correctionAction({ status, currentRound: 1, maxRounds: 3, latestClaudeStructuredResult: null, externalRequirementsOpen: true }).kind
      ).toBe('unavailable');
    }
  });

  it('merges them with an internal review that asked for changes', async () => {
    const { harness } = withRequirements([requirement({ title: 'External finding', fix: '' })]);
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'Handle the null case.' })
    ];
    await harness.orchestrator.reviewWithCodex(task.id);

    await harness.orchestrator.sendCorrections(task.id);

    const prompt = harness.claude.calls[1]?.prompt ?? '';
    expect(prompt).toContain('Handle the null case.');
    expect(prompt).toContain('External code review: External finding');
  });

  it('refuses when nothing is owed: no internal review asked for changes and nothing external was accepted', async () => {
    const { harness } = withRequirements([]);
    const { task } = await runToReview(harness);

    await expect(harness.orchestrator.sendCorrections(task.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(harness.claude.calls).toHaveLength(1);
  });

  it('stops at the round budget like any other correction', async () => {
    const { harness } = withRequirements([requirement()]);
    const { task } = await runToReview(harness);
    harness.tasks.update(task.id, { maxRounds: 1 });

    await expect(harness.orchestrator.sendCorrections(task.id)).rejects.toThrow(/already used its 1 review round/i);
    expect(harness.claude.calls).toHaveLength(1);
  });

  it('after a recoverable failure the task is back at CHANGES_REQUESTED and the same requirement is retried', async () => {
    const { harness } = withRequirements([requirement()]);
    const { task } = await runToReview(harness);
    harness.claude.error = new AgentRelayError('TOOL_FAILED', 'Claude crashed.');

    await expect(harness.orchestrator.sendCorrections(task.id)).rejects.toThrow(/crashed/);
    expect(harness.tasks.findById(task.id)?.status).toBe('CHANGES_REQUESTED');

    harness.claude.error = null;
    const retried = await harness.orchestrator.sendCorrections(task.id);
    expect(retried.status).toBe('READY_FOR_REVIEW');
    expect(harness.claude.calls.at(-1)?.prompt).toContain('External code review: The retry is ambiguous');
  });

  it('stops offering it once the requirement is gone', async () => {
    const { harness, setRequirements } = withRequirements([requirement()]);
    const { task } = await runToReview(harness);
    setRequirements([]);

    await expect(harness.orchestrator.sendCorrections(task.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('merging accepted external findings into a review', () => {
  it('leaves the internal review untouched when nothing external is owed', () => {
    const review = makeReview();
    expect(mergeExternalRequirements(review, [])).toBe(review);
    expect(mergeExternalRequirements(null, [])).toBeNull();
  });

  it('turns external findings into a changes_requested review when there is no internal one, mapping severities', () => {
    const merged = mergeExternalRequirements(null, [
      requirement({ severity: 'blocking', title: 'A' }),
      requirement({ severity: 'major', title: 'B' }),
      requirement({ severity: 'minor', title: 'C', file: '', line: 0 }),
      requirement({ severity: 'nit', title: 'D', fix: '' })
    ])!;

    expect(merged.verdict).toBe('changes_requested');
    expect(merged.findings.map((entry) => [entry.severity, entry.title])).toEqual([
      ['critical', 'External code review: A'],
      ['high', 'External code review: B'],
      ['medium', 'External code review: C'],
      ['low', 'External code review: D']
    ]);
    expect(merged.findings[2]).toMatchObject({ file: null, line: null });
    expect(merged.findings[3]?.description).not.toContain('Accepted correction');
    expect(merged.summary).toMatch(/accepted 4 finding\(s\)/);
  });

  it('keeps every internal finding and its follow-up beside the external ones', () => {
    const review = makeReview({ verdict: 'changes_requested', followUpPrompt: 'Handle the null case.' });
    const merged = mergeExternalRequirements(review, [requirement()])!;

    expect(merged.followUpPrompt).toBe('Handle the null case.');
    expect(merged.findings).toHaveLength(review.findings.length + 1);
    expect(merged.summary.startsWith(review.summary)).toBe(true);
  });
});

describe('correctionAction with external requirements', () => {
  const base = { currentRound: 1, maxRounds: 3, latestClaudeStructuredResult: null };

  it('offers the external kind from a quiet round, and keeps the existing kinds for the states that already had one', () => {
    expect(correctionAction({ ...base, status: 'READY_FOR_REVIEW', externalRequirementsOpen: true })).toMatchObject({
      kind: 'external_corrections',
      enabled: true,
      label: 'Send accepted findings as corrections'
    });
    expect(correctionAction({ ...base, status: 'CHANGES_REQUESTED', externalRequirementsOpen: true }).kind).toBe('corrections');
    expect(correctionAction({ ...base, status: 'READY_FOR_REVIEW' }).kind).toBe('unavailable');
    // A round that is blocked from publishing keeps its own, more specific, retry.
    expect(correctionAction({ ...base, status: 'READY_TO_PUBLISH', externalRequirementsOpen: true }).kind).toBe('retry_verification');
  });

  it('disables it, with the reason, once the budget is spent', () => {
    expect(
      correctionAction({ ...base, currentRound: 3, status: 'APPROVED', externalRequirementsOpen: true })
    ).toMatchObject({ kind: 'external_corrections', enabled: false, disabledReason: expect.stringMatching(/exhausted/i) });
  });
});
