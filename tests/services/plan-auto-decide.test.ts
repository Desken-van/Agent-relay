import { afterEach, describe, expect, it } from 'vitest';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import {
  PlanReviewGateService,
  planFindingsSha256
} from '../../src/main/services/plan-review-gate';
import { parsePlanReviewAutoDecisions, parsePlanReviewTriage } from '../../src/shared/domain/plan-review';
import type { PlanReviewGate } from '../../src/shared/domain/plan-review';
import { deferred, FakePlanReviewer, finding, snapshot } from '../helpers/fake-plan-reviewer';
import { createHarness, type Harness } from '../helpers/harness';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  const reviewer = new FakePlanReviewer();
  const claims = new PlanReviewClaims();
  const build = (): PlanReviewGateService =>
    new PlanReviewGateService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      reviewer,
      codex: harness.codex,
      settings: harness.settings,
      clock: harness.clock,
      ids: harness.ids,
      claims
    });
  return { harness, reviewer, claims, service: build(), build };
}

/** A task with a gate awaiting decisions on three findings. */
async function awaitingThree(value: ReturnType<typeof setup>) {
  const project = value.harness.createProject();
  const created = value.harness.createTask(project.id);
  value.service.bindRules(created.id, snapshot());
  await value.harness.orchestrator.generateSpecification(created.id);
  const task = await value.harness.orchestrator.preparePlanReviewWorktree(created.id);
  value.reviewer.round = {
    ...value.reviewer.round,
    verdict: 'revise',
    gatingCount: 3,
    threshold: 1,
    findings: [finding('First'), finding('Second'), finding('Third')]
  };
  const gate = await value.service.review(task.id);
  return { task, gate };
}

const request = (gate: PlanReviewGate, findingIndex: number) => ({
  gateId: gate.id,
  findingsSha256: planFindingsSha256(gate.findingsJson as string),
  findingIndex
});

const recommend = (
  findingRef: number,
  recommendation: 'accept' | 'reject' | 'needs_user',
  reason = `Reason for ${findingRef}.`
) => ({ findingRef, recommendation, reason, evidenceRef: `evidence ${findingRef}`, confidence: 'high' as const });

describe('plan review: per-finding Auto decide', () => {
  it('sends only the named finding to Codex, as a fresh numeric-index analysis', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(1, 'accept')]);

    await value.service.autoDecide(task.id, request(gate, 1));

    expect(value.harness.codex.triageCalls).toHaveLength(1);
    const call = value.harness.codex.triageCalls[0]!;
    expect(call.refKind).toBe('index');
    expect(call.findings.map((entry) => entry.ref)).toEqual([1]);
    expect(call.findings[0]?.title).toBe('Second');
    expect(call.priorDecisions).toEqual([]);
  });

  it('puts an accept into the durable draft at once, with an audit reason, and resolves nothing', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'accept', 'Matches criterion 2.')]);

    const result = await value.service.autoDecide(task.id, request(gate, 0));

    expect(result.outcome.kind).toBe('decided');
    const decisions = parsePlanReviewAutoDecisions(
      result.gate.autoDecisionsJson,
      planFindingsSha256(gate.findingsJson as string)
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ finding: 0, action: 'accept', evidenceRef: 'evidence 0', confidence: 'high' });
    expect(decisions[0]?.reason).toContain('Matches criterion 2.');
    expect(decisions[0]?.reason).toContain('evidence 0');
    // Nothing reached the provider and the round is still open.
    expect(value.reviewer.resolveCalls).toHaveLength(0);
    expect(result.gate.status).toBe('awaiting_resolve');
    expect(result.gate.decisionsJson).toBeNull();
  });

  it('puts a reject into the draft WITH its reason, which is what makes a reject valid', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(2, 'reject', 'The premise is contradicted by src/x.ts.')]);

    const result = await value.service.autoDecide(task.id, request(gate, 2));

    const [decision] = parsePlanReviewAutoDecisions(
      result.gate.autoDecisionsJson,
      planFindingsSha256(gate.findingsJson as string)
    );
    expect(decision).toMatchObject({ finding: 2, action: 'reject' });
    expect(decision?.reason.trim().length).toBeGreaterThan(0);
    expect(decision?.reason).toContain('contradicted by src/x.ts');
  });

  it('records needs_user as a recommendation only: no decision, and an explanation is kept', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(1, 'needs_user', 'An architecture choice.')]);

    const result = await value.service.autoDecide(task.id, request(gate, 1));

    expect(result.outcome).toMatchObject({ kind: 'needs_user', reason: 'An architecture choice.' });
    expect(
      parsePlanReviewAutoDecisions(result.gate.autoDecisionsJson, planFindingsSha256(gate.findingsJson as string))
    ).toEqual([]);
    expect(parsePlanReviewTriage(result.gate.triageJson)?.recommendations).toEqual([
      expect.objectContaining({ finding: 1, recommendation: 'needs_user', reason: 'An architecture choice.' })
    ]);
  });

  it('a repeated request returns the saved decision without a second analysis, so it can never contradict it', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    // The second answer would reject: it must never be asked for.
    value.harness.codex.triageQueue.push([recommend(0, 'accept', 'First and only.')], [recommend(0, 'reject', 'Contradiction.')]);

    const first = await value.service.autoDecide(task.id, request(gate, 0));
    const before = value.harness.planReviewGates.findByTask(task.id) as PlanReviewGate;
    const second = await value.service.autoDecide(task.id, request(gate, 0));
    const after = value.harness.planReviewGates.findByTask(task.id) as PlanReviewGate;

    expect(value.harness.codex.triageCalls).toHaveLength(1);
    expect(second.outcome).toEqual(first.outcome);
    expect(second.outcome).toMatchObject({ kind: 'decided', decision: { finding: 0, action: 'accept' } });
    // Nothing was written: the row, its revision and the decisions are untouched.
    expect(after.revision).toBe(before.revision);
    expect(after.autoDecisionsJson).toBe(before.autoDecisionsJson);
    expect(value.harness.codex.triageQueue).toHaveLength(1);
  });

  it('keeps the first saved answer when another writer saved one while this analysis ran', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    // The provider will answer "reject", but only after another process has saved "accept".
    value.harness.codex.triageQueue.push([recommend(0, 'reject', 'Slow window.')]);
    const sha = planFindingsSha256(gate.findingsJson as string);

    const pending = value.service.autoDecide(task.id, request(gate, 0));
    await Promise.resolve();
    const current = value.harness.planReviewGates.findByTask(task.id) as PlanReviewGate;
    value.harness.planReviewGates.updateIfUnchanged(
      current.id,
      {
        autoDecisionsJson: JSON.stringify({
          forFindingsSha256: sha,
          decisions: [
            { finding: 0, action: 'accept', reason: 'Fast window.', evidenceRef: 'e', confidence: 'high', decidedAt: '2026-09-06T00:00:00.000Z' }
          ]
        })
      },
      current.revision
    );
    release.resolve(undefined);
    const late = await pending;

    // The slow window is told the saved answer; the contradicting one is never stored.
    expect(late.outcome).toMatchObject({ kind: 'decided', decision: { finding: 0, action: 'accept', reason: 'Fast window.' } });
    const saved = parsePlanReviewAutoDecisions(
      (value.harness.planReviewGates.findByTask(task.id) as PlanReviewGate).autoDecisionsJson,
      sha
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ finding: 0, action: 'accept' });
  });

  it('still lets a finding with only a stop recommendation be analyzed again', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'needs_user', 'Unsure.')], [recommend(0, 'accept', 'Clear now.')]);

    await value.service.autoDecide(task.id, request(gate, 0));
    const second = await value.service.autoDecide(task.id, request(gate, 0));

    expect(second.outcome).toMatchObject({ kind: 'decided', decision: { finding: 0, action: 'accept' } });
    expect(value.harness.codex.triageCalls).toHaveLength(2);
  });

  it('merges results per finding instead of replacing what siblings already learned', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'accept')], [recommend(2, 'needs_user')], [recommend(1, 'reject')]);

    await value.service.autoDecide(task.id, request(gate, 0));
    await value.service.autoDecide(task.id, request(gate, 2));
    const last = await value.service.autoDecide(task.id, request(gate, 1));

    const sha = planFindingsSha256(gate.findingsJson as string);
    expect(parsePlanReviewAutoDecisions(last.gate.autoDecisionsJson, sha).map((entry) => [entry.finding, entry.action])).toEqual([
      [0, 'accept'],
      [1, 'reject']
    ]);
    expect(
      parsePlanReviewTriage(last.gate.triageJson)?.recommendations.map((entry) => [entry.finding, entry.recommendation])
    ).toEqual([
      [0, 'accept'],
      [1, 'reject'],
      [2, 'needs_user']
    ]);
  });

  it('analyzes different findings at once, and every result survives', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageQueue.push([recommend(0, 'accept')], [recommend(1, 'reject')], [recommend(2, 'accept')]);

    const running = [0, 1, 2].map((index) => value.service.autoDecide(task.id, request(gate, index)));
    await Promise.resolve();
    // All three are in flight together: claims are per finding.
    expect(value.claims.heldBy(task.id)).toBe('triage');
    release.resolve(undefined);
    const results = await Promise.all(running);

    expect(results.every((entry) => entry.outcome.kind === 'decided')).toBe(true);
    const stored = value.harness.planReviewGates.findByTask(task.id)!;
    expect(
      parsePlanReviewAutoDecisions(stored.autoDecisionsJson, planFindingsSha256(gate.findingsJson as string)).map(
        (entry) => entry.finding
      )
    ).toEqual([0, 1, 2]);
  });

  it('refuses the same finding twice at once, and dispatching operations while any analysis runs', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageQueue.push([recommend(0, 'accept')]);

    const first = value.service.autoDecide(task.id, request(gate, 0));
    await Promise.resolve();

    await expect(value.service.autoDecide(task.id, request(gate, 0))).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.service.review(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(
      value.service.resolve(task.id, { gateId: gate.id, expectedRevision: gate.revision, decisions: [] })
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.reviewer.resolveCalls).toHaveLength(0);

    release.resolve(undefined);
    await first;
  });

  it('fails safe against another round: a stale round identity persists nothing', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'accept')]);

    await expect(
      value.service.autoDecide(task.id, { ...request(gate, 0), findingsSha256: 'a'.repeat(64) })
    ).rejects.toThrow(/no longer the current one/i);
    await expect(
      value.service.autoDecide(task.id, { ...request(gate, 0), gateId: 'some-other-gate' })
    ).rejects.toThrow(/no longer the current one/i);

    expect(value.harness.codex.triageCalls).toHaveLength(0);
    expect(value.harness.planReviewGates.findByTask(task.id)?.autoDecisionsJson).toBeNull();
  });

  it('discards an answer whose round was replaced while Codex was thinking', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageQueue.push([recommend(0, 'accept')]);

    const running = value.service.autoDecide(task.id, request(gate, 0));
    await Promise.resolve();
    // Another window resolves the round while Codex is still thinking.
    value.harness.planReviewGates.update(gate.id, { status: 'proceeded', decisionsJson: '[]' });
    release.resolve(undefined);

    await expect(running).rejects.toThrow(/no longer the current one/i);
    expect(value.harness.planReviewGates.findByTask(task.id)?.autoDecisionsJson).toBeNull();
  });

  it('persists nothing when Codex fails, and lets an explicit retry succeed', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageError = new Error('Codex timed out.');

    await expect(value.service.autoDecide(task.id, request(gate, 1))).rejects.toThrow(/timed out/i);
    const after = value.harness.planReviewGates.findByTask(task.id)!;
    expect(after.autoDecisionsJson).toBeNull();
    expect(after.triageJson).toBeNull();
    expect(after.revision).toBe(gate.revision);

    value.harness.codex.triageError = null;
    value.harness.codex.triageQueue.push([recommend(1, 'accept')]);
    const retried = await value.service.autoDecide(task.id, request(gate, 1));
    expect(retried.outcome.kind).toBe('decided');
  });

  it('keeps the draft across a refresh or restart: a fresh service reads the same decisions', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'accept')]);
    await value.service.autoDecide(task.id, request(gate, 0));

    // A new claims object and service over the same database stand for a restart.
    const restarted = value.harness.planReviewGates.findByTask(task.id)!;
    expect(
      parsePlanReviewAutoDecisions(restarted.autoDecisionsJson, planFindingsSha256(restarted.findingsJson as string))
    ).toHaveLength(1);
  });

  it('a new review round starts with no inherited automatic decisions', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.codex.triageQueue.push([recommend(0, 'accept')]);
    await value.service.autoDecide(task.id, request(gate, 0));
    // The provider keeps the session in PlanReview, so a rejected-only
    // resolution leaves the gate startable again.
    value.reviewer.resolution = { ...value.reviewer.resolution, stage: 'PlanReview' };
    await value.service.resolve(task.id, {
      gateId: gate.id,
      expectedRevision: value.harness.planReviewGates.findByTask(task.id)!.revision,
      decisions: [0, 1, 2].map((finding) => ({ finding, action: 'reject' as const, reason: 'Refuted.' }))
    });
    const next = await value.service.review(task.id);

    expect(next.autoDecisionsJson).toBeNull();
  });

  it('refuses a finding index that does not exist in the round', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);

    await expect(value.service.autoDecide(task.id, request(gate, 3))).rejects.toThrow(/does not exist/i);
    await expect(value.service.autoDecide(task.id, request(gate, -1))).rejects.toThrow(/does not exist/i);
    expect(value.harness.codex.triageCalls).toHaveLength(0);
  });

  it('refuses when the round no longer awaits decisions', async () => {
    const value = setup();
    const { task, gate } = await awaitingThree(value);
    value.harness.planReviewGates.update(gate.id, { status: 'proceeded', decisionsJson: '[]' });

    await expect(value.service.autoDecide(task.id, request(gate, 0))).rejects.toThrow(/awaits decisions/i);
  });
});
