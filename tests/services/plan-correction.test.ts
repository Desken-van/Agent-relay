import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import { PlanCorrectionService } from '../../src/main/services/plan-correction';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService, planFindingsSha256 } from '../../src/main/services/plan-review-gate';
import { specificationIdentity } from '../../src/main/services/specification-identity';
import { parseAcceptedPlanFindings, parsePlanRevisionAddressed } from '../../src/shared/domain/plan-correction';
import type { PlanReviewDecision } from '../../src/shared/domain/plan-review';
import type { Settings } from '../../src/shared/domain/models';
import type { ExternalPlanReviewRound } from '../../src/main/ports';
import { deferred, FakePlanReviewer, finding, snapshot } from '../helpers/fake-plan-reviewer';
import { makeSpecification } from '../helpers/fakes';
import { createHarness, type Harness } from '../helpers/harness';
import { FakePlanReviewSubjects } from '../helpers/fake-plan-review-subjects';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup(settings: Partial<Settings> = {}) {
  const harness = createHarness({ settings });
  harnesses.push(harness);
  const reviewer = new FakePlanReviewer();
  const claims = new PlanReviewClaims();
  const corrections = new SqlitePlanCorrectionRepository(harness.db, harness.clock);
  // Built the way the composition root builds them: the claims and the registry are
  // the process-wide instances, everything else is made afresh per call — so
  // `build()` is "another IPC call", and `harness.orchestrator` is the singleton
  // whose `stop()` must reach an operation started through ANY of them.
  const build = () => {
    const gateService = new PlanReviewGateService({
      subjects: new FakePlanReviewSubjects(),
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      reviewer,
      codex: harness.codex,
      settings: harness.settings,
      clock: harness.clock,
      ids: harness.ids,
      claims,
      operations: harness.operations,
      verifyTarget: async (taskId: string) => { await harness.orchestrator.verifySpecificationGrounding(taskId); }
    });
    const loop = new PlanCorrectionService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      corrections,
      gateService,
      codex: harness.codex,
      settings: harness.settings,
      claims,
      operations: harness.operations,
      clock: harness.clock,
      ids: harness.ids,
      verifyTarget: async (taskId: string) => { await harness.orchestrator.verifySpecificationGrounding(taskId); }
    });
    return { gateService, loop };
  };
  const { gateService, loop } = build();
  return { harness, reviewer, claims, corrections, gateService, loop, build };
}
type Value = ReturnType<typeof setup>;

/** A task with rule evidence, a generated specification and an isolated branch. */
async function ready(value: Value) {
  const project = value.harness.createProject();
  const created = value.harness.createTask(project.id);
  value.gateService.bindRules(created.id, snapshot());
  await value.harness.orchestrator.generateSpecification(created.id);
  return value.harness.orchestrator.preparePlanReviewWorktree(created.id);
}

const roundWith = (
  value: Value,
  titles: readonly string[],
  verdict: ExternalPlanReviewRound['verdict'] = 'revise'
): ExternalPlanReviewRound => ({
  ...value.reviewer.round,
  verdict,
  gatingCount: titles.length,
  threshold: 1,
  findings: titles.map(finding)
});

/** Coai keeps the session in PlanReview after a `revise` resolution: the gate settles as changes_requested. */
const revise = (value: Value) => ({ ...value.reviewer.resolution, stage: 'PlanReview', awaitingResolve: false });
/** Coai moves past the plan gate: the gate settles as proceeded. */
const proceed = (value: Value) => ({ ...value.reviewer.resolution, stage: 'CodeReview', awaitingResolve: false });

const rec = (
  findingRef: number,
  recommendation: 'accept' | 'reject' | 'needs_user',
  reason = `Reason ${findingRef}.`
) => ({ findingRef, recommendation, reason, evidenceRef: `evidence ${findingRef}`, confidence: 'high' as const });

const currentGate = (value: Value, taskId: string) => value.harness.planReviewGates.findByTask(taskId)!;
const specOf = (value: Value, taskId: string) => value.harness.tasks.findById(taskId)!.specificationJson as string;

const decide = (
  ...entries: readonly (readonly [number, 'accept' | 'reject', string])[]
): PlanReviewDecision[] => entries.map(([findingIndex, action, reason]) => ({ finding: findingIndex, action, reason }));

async function resolveAndRevise(
  value: Value,
  taskId: string,
  decisions: readonly PlanReviewDecision[],
  autoContinue = false
) {
  const gate = currentGate(value, taskId);
  return value.loop.resolveAndRevise(taskId, {
    gateId: gate.id,
    expectedRevision: gate.revision,
    decisions,
    autoContinue
  });
}

describe('plan correction loop: resolve, revise, review again', () => {
  it('revises the specification from ONLY the accepted findings and reviews the revised text', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [roundWith(value, ['Add a retry budget', 'Rename the helper']), roundWith(value, ['Document the budget'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const firstGate = currentGate(value, task.id);

    const outcome = await resolveAndRevise(
      value,
      task.id,
      decide([0, 'accept', 'A retry budget is required.'], [1, 'reject', 'Naming is out of scope.'])
    );

    expect(outcome).toMatchObject({ stopped: 'awaiting_decisions', correctionsRun: 1, roundsReviewed: 1 });

    // Codex was asked with the accepted finding only, the current specification and the operator's note.
    expect(value.harness.codex.revisionCalls).toHaveLength(1);
    const request = value.harness.codex.revisionCalls[0]!;
    expect(request.acceptedFindings.map((entry) => entry.title)).toEqual(['Add a retry budget']);
    expect(request.acceptedFindings[0]?.operatorNote).toBe('A retry budget is required.');
    expect(request.originalRequest).toBe(task.originalRequest);
    expect(JSON.stringify(request.currentSpecification)).toBe(original);
    expect(request.round).toBe(1);

    // The specification really changed, and the version history records both texts.
    const revised = specOf(value, task.id);
    expect(revised).not.toBe(original);
    const versions = value.corrections.listVersions(task.id);
    expect(versions.map((entry) => [entry.version, entry.origin])).toEqual([
      [1, 'generated'],
      [2, 'plan_correction']
    ]);
    expect(versions[0]?.specificationJson).toBe(original);
    expect(versions[1]?.specificationJson).toBe(revised);
    expect(versions[1]?.specificationSha256).toBe(specificationIdentity(revised).sha256);

    // The fresh external round reviewed the REVISED text, and is bound to its hash.
    expect(value.reviewer.reviewCalls).toHaveLength(2);
    expect(value.reviewer.reviewCalls[1]?.planText).toContain('revised in correction round 1');
    const gates = value.harness.planReviewGates.listByTask(task.id);
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatchObject({
      status: 'awaiting_resolve',
      specificationSha256: specificationIdentity(revised).sha256
    });

    // Historical evidence is untouched.
    expect(gates[1]).toMatchObject({
      id: firstGate.id,
      status: 'changes_requested',
      specificationSha256: specificationIdentity(original).sha256,
      findingsJson: firstGate.findingsJson
    });
    expect(gates[1]?.decisionsJson).toContain('A retry budget is required.');

    // The correction row is the audit record and is completed.
    const [correction] = value.corrections.listByTask(task.id);
    expect(correction).toMatchObject({ round: 1, status: 'completed', attempts: 1, toVersion: 2, sourceGateId: firstGate.id });
    expect(parseAcceptedPlanFindings(correction!.acceptedJson).map((entry) => entry.title)).toEqual(['Add a retry budget']);
  });

  it('does not revise anything when no finding was accepted', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [roundWith(value, ['Refuted finding'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);

    const outcome = await resolveAndRevise(value, task.id, decide([0, 'reject', 'Contradicted by the code.']));

    expect(outcome.stopped).toBe('settled');
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.corrections.listVersions(task.id)).toEqual([]);
    expect(specOf(value, task.id)).toBe(original);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('reports a clean result when the provider proceeds and nothing was accepted', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Refuted finding'], 'proceed')];
    value.reviewer.resolutionQueue = [proceed(value)];
    await value.gateService.review(task.id);

    const outcome = await resolveAndRevise(value, task.id, decide([0, 'reject', 'Refuted.']));

    expect(outcome.stopped).toBe('clean');
    // Nothing accepted, so the ordinary approval path is open.
    value.harness.orchestrator.approveSpecification(task.id);
    expect(value.harness.tasks.findById(task.id)?.specificationApprovedAt).not.toBeNull();
  });

  it('keeps going by itself through several correction rounds until the review is clean', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [
      roundWith(value, ['Round one A', 'Round one B']),
      roundWith(value, ['Round two C']),
      roundWith(value, [], 'proceed')
    ];
    value.reviewer.resolutionQueue = [revise(value), revise(value), proceed(value)];
    // Round 1: A accepted, B rejected. Round 2: C accepted.
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(1, 'reject')], [rec(0, 'accept')]);
    await value.gateService.review(task.id);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome).toMatchObject({ stopped: 'clean', correctionsRun: 2, roundsReviewed: 2 });
    expect(value.harness.codex.revisionCalls.map((call) => call.acceptedFindings.map((entry) => entry.title))).toEqual([
      ['Round one A'],
      ['Round two C']
    ]);
    expect(value.corrections.listByTask(task.id).map((entry) => [entry.round, entry.status])).toEqual([
      [1, 'completed'],
      [2, 'completed']
    ]);
    expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(value.reviewer.resolveCalls).toHaveLength(3);
    // The final specification is the reviewed and approved one, and the operator still has to approve it.
    expect(specOf(value, task.id)).not.toBe(original);
    expect(value.harness.tasks.findById(task.id)?.specificationApprovedAt).toBeNull();
    value.harness.orchestrator.approveSpecification(task.id);
    expect(currentGate(value, task.id).status).toBe('proceeded');
  });

  it('cannot approve while a round with accepted findings is still uncorrected, or after the revision until it passes', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, ['A new finding'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    await resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']));

    // The revised specification has its own round awaiting decisions: not approved.
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });
});

describe('plan correction loop: stop conditions', () => {
  it('stops for a person when Auto decide says a finding needs one, keeping the decisions it did make', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Clear', 'Ambiguous'])];
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(1, 'needs_user', 'A product choice.')]);
    await value.gateService.review(task.id);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('needs_user');
    expect(outcome.message).toMatch(/need your decision/i);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    const gate = currentGate(value, task.id);
    expect(gate.status).toBe('awaiting_resolve');
    expect(JSON.parse(gate.autoDecisionsJson as string).decisions).toHaveLength(1);
  });

  it('isolates a failed analysis: the other findings keep their decisions and the loop stops', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['One', 'Two', 'Three'])];
    await value.gateService.review(task.id);
    const original = value.harness.codex.triageFindings.bind(value.harness.codex);
    value.harness.codex.triageFindings = async (request, context) => {
      if (request.findings[0]?.ref === 1) throw new Error('Codex crashed on finding two.');
      return original(request, context);
    };
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(2, 'reject')]);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('needs_user');
    expect(outcome.message).toMatch(/1 of 3 finding\(s\) could not be analyzed/);
    expect(JSON.parse(currentGate(value, task.id).autoDecisionsJson as string).decisions.map((entry: { finding: number }) => entry.finding)).toEqual([0, 2]);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('does not decide anything automatically when the provider itself asks for a person', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Serious'], 'call_human')];
    await value.gateService.review(task.id);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('verdict_needs_human');
    expect(value.harness.codex.triageCalls).toHaveLength(0);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('stops when the Coai tool contract changed between rounds', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    // From now on the server reports a different contract, consistently within one call.
    const drifted = 'e'.repeat(64);
    value.reviewer.session = { ...value.reviewer.session, contractFingerprint: drifted };
    value.reviewer.roundQueue[0] = { ...value.reviewer.roundQueue[0]!, contractFingerprint: drifted };

    const outcome = await resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']), true);

    expect(outcome.stopped).toBe('contract_drift');
    expect(currentGate(value, task.id).contractMismatchAt).not.toBeNull();
    // The drifted round is left for a person: it was neither decided nor resolved.
    expect(currentGate(value, task.id).status).toBe('awaiting_resolve');
    expect(value.reviewer.resolveCalls).toHaveLength(1);

    // And it stays that way on a later resume: a flagged gate is never decided automatically.
    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });
    expect(resumed.stopped).toBe('contract_drift');
    expect(value.harness.codex.triageCalls).toHaveLength(0);
  });

  it('carries the previous fingerprint onto a gate for the revised specification that was prepared earlier, so drift is still caught', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const awaitingGate = currentGate(value, task.id);
    await value.gateService.resolve(task.id, {
      gateId: awaitingGate.id,
      expectedRevision: awaitingGate.revision,
      decisions: decide([0, 'reject', 'Not valid.'])
    });
    const first = currentGate(value, task.id);
    expect(first.contractFingerprint).not.toBeNull();
    // The specification is revised and another screen prepares its gate BEFORE the loop reaches the review.
    value.harness.tasks.update(task.id, {
      specificationJson: JSON.stringify(makeSpecification({ summary: 'Revised elsewhere' }))
    });
    const preparedElsewhere = value.gateService.prepare(task.id);
    expect(preparedElsewhere.contractFingerprint).toBeNull();

    const prepared = value.gateService.prepare(task.id, { inheritContractFrom: first });

    // The very same row, now bound to the fingerprint the previous round was reviewed under.
    expect(prepared.id).toBe(preparedElsewhere.id);
    expect(prepared.contractFingerprint).toBe(first.contractFingerprint);
    const drifted = 'e'.repeat(64);
    value.reviewer.session = { ...value.reviewer.session, contractFingerprint: drifted };
    value.reviewer.roundQueue[0] = { ...value.reviewer.roundQueue[0]!, contractFingerprint: drifted };
    const reviewed = await value.gateService.review(task.id);
    expect(reviewed.contractMismatchAt).not.toBeNull();
  });

  it('never rewrites the fingerprint of a gate that has already started', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    await value.gateService.review(task.id);
    const settled = currentGate(value, task.id);

    const again = value.gateService.prepare(task.id, {
      inheritContractFrom: { ...settled, contractFingerprint: 'c'.repeat(64) }
    });

    expect(again.id).toBe(settled.id);
    expect(again.contractFingerprint).toBe(settled.contractFingerprint);
  });

  it('stops at the configured maximum with accepted findings left uncorrected, and cannot be approved', async () => {
    const value = setup({ maxReviewRounds: 1 });
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['First']), roundWith(value, ['Second'])];
    value.reviewer.resolutionQueue = [revise(value), revise(value)];
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(0, 'accept')]);
    await value.gateService.review(task.id);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('round_limit');
    expect(outcome.message).toMatch(/Nothing was sent to the external reviewer/);
    expect(outcome.correctionsRun).toBe(1);
    expect(value.harness.codex.revisionCalls).toHaveLength(1);
    // The second round's accepted finding was NOT recorded with the reviewer: it stays open, decisions saved.
    expect(value.reviewer.resolveCalls).toHaveLength(1);
    expect(currentGate(value, task.id).status).toBe('awaiting_resolve');
    expect(value.loop.detail(task.id)).toMatchObject({ used: 1, max: 1, nextStep: 'decide', acceptedPending: 0 });
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/external plan review/i);
    expect(value.harness.tasks.findById(task.id)?.specificationApprovedAt).toBeNull();
  });

  it('refuses an explicit "resolve and revise" with an accepted finding once the budget is spent, sending nothing', async () => {
    const value = setup({ maxReviewRounds: 1 });
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['First']), roundWith(value, ['Second'])];
    value.reviewer.resolutionQueue = [revise(value), revise(value)];
    await value.gateService.review(task.id);
    await resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']));
    const gate = currentGate(value, task.id);
    expect(gate.status).toBe('awaiting_resolve');
    const resolvesBefore = value.reviewer.resolveCalls.length;

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes again.']))).rejects.toThrow(
      /correction budget of 1 round\(s\) is spent/i
    );

    // Nothing reached the provider and the round is exactly as it was.
    expect(value.reviewer.resolveCalls).toHaveLength(resolvesBefore);
    expect(currentGate(value, task.id)).toMatchObject({ id: gate.id, status: 'awaiting_resolve', revision: gate.revision });
    expect(value.harness.codex.revisionCalls).toHaveLength(1);

    // Rejecting is still possible: a round with nothing accepted needs no revision.
    const outcome = await resolveAndRevise(value, task.id, decide([0, 'reject', 'Not valid.']));
    expect(outcome.stopped).toBe('settled');
    expect(currentGate(value, task.id).status).toBe('changes_requested');
  });

  it('refuses a stale round before anything is sent anywhere', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    await value.gateService.review(task.id);
    const gate = currentGate(value, task.id);

    await expect(
      value.loop.resolveAndRevise(task.id, {
        gateId: gate.id,
        expectedRevision: gate.revision + 1,
        decisions: decide([0, 'accept', 'Yes.']),
        autoContinue: false
      })
    ).rejects.toThrow(/no longer the current one/i);

    expect(value.reviewer.resolveCalls).toHaveLength(0);
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.corrections.listByTask(task.id)).toEqual([]);
  });

  it('asks nothing of a provider that was never told: an unknown external outcome stops the loop, and is never repeated', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    await value.gateService.review(task.id);
    value.reviewer.resolveError = new Error('The connection dropped after the request left.');

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(/connection dropped/);
    expect(currentGate(value, task.id).status).toBe('resolving');

    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(resumed.stopped).toBe('reconcile_required');
    // The non-idempotent Coai call was made exactly once, and no correction started on a guess.
    expect(value.reviewer.resolveCalls).toHaveLength(1);
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.loop.detail(task.id).nextStep).toBe('reconcile');
  });

  it('after a lost review, resumes only by reconciliation: the correction is not repeated and no second round is dispatched', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    value.reviewer.reviewError = new Error('The review answer was lost.');

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(/answer was lost/);
    // The correction committed; the new gate is in the unknown `reviewing` phase.
    expect(value.corrections.listByTask(task.id)[0]?.status).toBe('completed');
    expect(currentGate(value, task.id).status).toBe('reviewing');
    const reviewsBefore = value.reviewer.reviewCalls.length;

    value.reviewer.reviewError = null;
    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(resumed.stopped).toBe('reconcile_required');
    expect(value.reviewer.reviewCalls).toHaveLength(reviewsBefore);
    expect(value.harness.codex.revisionCalls).toHaveLength(1);
    expect(value.corrections.listVersions(task.id)).toHaveLength(2);
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(2);
  });
});

describe('plan correction loop: the Codex revision', () => {
  it('leaves everything unchanged when Codex fails, then retries the SAME correction without duplicating anything', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    value.harness.codex.revisionError = new Error('Codex timed out.');

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(/timed out/);

    expect(specOf(value, task.id)).toBe(original);
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(1);
    const [failed] = value.corrections.listByTask(task.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('timed out') });
    // The reviewed text was recorded before anything could change it.
    expect(value.corrections.listVersions(task.id).map((entry) => entry.origin)).toEqual(['generated']);
    expect(value.loop.detail(task.id)).toMatchObject({ nextStep: 'revise', acceptedPending: 1 });

    value.harness.codex.revisionError = null;
    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(resumed.stopped).toBe('clean');
    const rows = value.corrections.listByTask(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed!.id, status: 'completed', attempts: 2 });
    expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1, 2]);
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(2);
  });

  it('does not count a retry of the last permitted round against the budget', async () => {
    const value = setup({ maxReviewRounds: 1 });
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    value.harness.codex.revisionError = new Error('Codex timed out.');
    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow();
    value.harness.codex.revisionError = null;

    expect(value.loop.detail(task.id).nextStep).toBe('revise');
    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });
    expect(resumed.stopped).toBe('clean');
  });

  it('refuses a "revision" that is identical, because that would leave the accepted findings unaddressed', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    value.harness.codex.revisionQueue.push(specificationIdentity(original).specification);

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(/unchanged/i);

    expect(specOf(value, task.id)).toBe(original);
    expect(value.corrections.listByTask(task.id)[0]?.status).toBe('failed');
    expect(value.corrections.listVersions(task.id)).toHaveLength(1);
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(1);
  });

  describe('what Codex says it addressed', () => {
    /** A round with two accepted findings, ready to be revised. */
    async function twoAccepted() {
      const value = setup();
      const task = await ready(value);
      value.reviewer.roundQueue = [roundWith(value, ['First problem', 'Second problem'])];
      value.reviewer.resolutionQueue = [revise(value)];
      await value.gateService.review(task.id);
      return { value, task, original: specOf(value, task.id) };
    }
    const nothingStored = (value: Value, taskId: string, original: string) => {
      expect(specOf(value, taskId)).toBe(original);
      expect(value.corrections.listVersions(taskId)).toHaveLength(1);
      expect(value.corrections.listByTask(taskId)[0]).toMatchObject({ status: 'failed', addressedJson: null });
      expect(value.harness.planReviewGates.listByTask(taskId)).toHaveLength(1);
    };
    const both = decide([0, 'accept', 'Yes.'], [1, 'accept', 'Yes too.']);

    it('records, per accepted finding, the field it was addressed in, and reports it', async () => {
      const { value, task } = await twoAccepted();

      await resolveAndRevise(value, task.id, both);

      const [correction] = value.corrections.listByTask(task.id);
      expect(correction?.status).toBe('completed');
      expect([...new Set(parsePlanRevisionAddressed(correction?.addressedJson ?? null).map((entry) => entry.finding))]).toEqual([0, 1]);
      const detail = value.loop.detail(task.id);
      expect([...new Set(detail.latest?.addressed.map((entry) => entry.finding))]).toEqual([0, 1]);
    });

    it('refuses a revision that says nothing about one of the accepted findings, and stores nothing', async () => {
      const { value, task, original } = await twoAccepted();
      value.harness.codex.revisionAddressed = [{ finding: 0, field: 'summary', change: 'Only the first.' }];

      await expect(resolveAndRevise(value, task.id, both)).rejects.toThrow(/did not say where it addressed accepted finding 1\b/i);

      nothingStored(value, task.id, original);
    });

    it('refuses a claim about a field that did not change', async () => {
      const { value, task, original } = await twoAccepted();
      // The revision only touches the summary and the acceptance criteria; it claims "constraints".
      value.harness.codex.revisionAddressed = [
        { finding: 0, field: 'summary', change: 'Real.' },
        { finding: 1, field: 'constraints', change: 'A lie: nothing changed there.' }
      ];

      await expect(resolveAndRevise(value, task.id, both)).rejects.toThrow(/"constraints", but that field is unchanged/i);

      nothingStored(value, task.id, original);
    });

    it('refuses a revision that rewrote a field it never tied to an accepted finding', async () => {
      const { value, task, original } = await twoAccepted();
      // The default revision changes both the summary and the acceptance criteria; only the summary is claimed.
      value.harness.codex.revisionAddressed = [
        { finding: 0, field: 'summary', change: 'Real.' },
        { finding: 1, field: 'summary', change: 'Real.' }
      ];

      await expect(resolveAndRevise(value, task.id, both)).rejects.toThrow(
        /changed "acceptanceCriteria" without tying the change to an accepted finding/i
      );

      nothingStored(value, task.id, original);
    });

    it('refuses a claim about a finding nobody accepted', async () => {
      const { value, task, original } = await twoAccepted();
      value.harness.codex.revisionAddressed = [
        { finding: 0, field: 'summary', change: 'Real.' },
        { finding: 1, field: 'summary', change: 'Real.' },
        { finding: 7, field: 'summary', change: 'A finding that does not exist.' }
      ];

      await expect(resolveAndRevise(value, task.id, both)).rejects.toThrow(/finding 7, which was not one of the accepted/i);

      nothingStored(value, task.id, original);
    });

    describe('a finding that needs changes to more than one field', () => {
      /**
       * The reported failure: one accepted finding, a revision that changes both
       * "constraints" and "implementationPrompt", and a claim naming only one of them.
       */
      async function refusedOnce() {
        const value = setup();
        const task = await ready(value);
        value.reviewer.roundQueue = [roundWith(value, ['Needs a constraint and an instruction'])];
        value.reviewer.resolutionQueue = [revise(value)];
        await value.gateService.review(task.id);
        const original = specOf(value, task.id);
        const current = specificationIdentity(original).specification;
        const revised = makeSpecification({
          ...current,
          constraints: [...current.constraints, 'Use only synthetic fixtures.'],
          implementationPrompt: `${current.implementationPrompt} Use only synthetic fixtures.`
        });
        value.harness.codex.revisionQueue.push(revised, revised);
        value.harness.codex.revisionAddressed = [{ finding: 0, field: 'implementationPrompt', change: 'Named the fixtures.' }];

        await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(
          'Codex changed "constraints" without tying the change to an accepted finding.'
        );

        // Exactly what the live task showed: a failed first attempt, nothing stored, only version 1.
        expect(value.corrections.listByTask(task.id)).toEqual([
          expect.objectContaining({ status: 'failed', attempts: 1, addressedJson: null, toVersion: null })
        ]);
        expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1]);
        expect(specOf(value, task.id)).toBe(original);
        expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(1);
        expect(value.loop.detail(task.id)).toMatchObject({
          nextStep: 'revise',
          latest: { status: 'failed', attempts: 1, lastError: expect.stringContaining('changed "constraints"') }
        });
        expect(value.harness.codex.revisionCalls).toHaveLength(1);
        return { value, task, revised };
      }

      it('"Continue correction" asks Codex again, and a claim repeating the finding per field is stored', async () => {
        const { value, task, revised } = await refusedOnce();
        value.harness.codex.revisionAddressed = [
          { finding: 0, field: 'constraints', change: 'Added the fixture constraint.' },
          { finding: 0, field: 'implementationPrompt', change: 'Named the fixtures.' }
        ];

        const resumed = await value.loop.continueCorrection(task.id, { autoContinue: false });

        expect(resumed.correctionsRun).toBe(1);
        expect(value.harness.codex.revisionCalls).toHaveLength(2);
        const rows = value.corrections.listByTask(task.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'completed', attempts: 2, toVersion: 2, lastError: null });
        expect(parsePlanRevisionAddressed(rows[0]!.addressedJson ?? null)).toEqual([
          { finding: 0, field: 'constraints', change: 'Added the fixture constraint.' },
          { finding: 0, field: 'implementationPrompt', change: 'Named the fixtures.' }
        ]);
        expect(JSON.parse(specOf(value, task.id))).toEqual(revised);
        expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1, 2]);
        expect(value.loop.detail(task.id).latest?.addressed.map((entry) => [entry.finding, entry.field])).toEqual([
          [0, 'constraints'],
          [0, 'implementationPrompt']
        ]);
      });

      it('a retry whose answer is refused again records the second attempt and its new failure', async () => {
        const { value, task } = await refusedOnce();
        value.harness.codex.revisionAddressed = [{ finding: 0, field: 'constraints', change: 'Only the constraint.' }];

        await expect(value.loop.continueCorrection(task.id, { autoContinue: false })).rejects.toThrow(
          'Codex changed "implementationPrompt" without tying the change to an accepted finding.'
        );

        expect(value.harness.codex.revisionCalls).toHaveLength(2);
        expect(value.corrections.listByTask(task.id)).toEqual([
          expect.objectContaining({ status: 'failed', attempts: 2, addressedJson: null })
        ]);
        expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1]);
        expect(value.loop.detail(task.id)).toMatchObject({
          nextStep: 'revise',
          latest: { status: 'failed', attempts: 2, lastError: expect.stringContaining('changed "implementationPrompt"') }
        });
      });
    });

    it('lets the operator retry the same correction after such a refusal, and then completes it', async () => {
      const { value, task } = await twoAccepted();
      value.harness.codex.revisionAddressed = [{ finding: 0, field: 'summary', change: 'Only the first.' }];
      await expect(resolveAndRevise(value, task.id, both)).rejects.toThrow(/did not say where/i);

      await value.loop.continueCorrection(task.id, { autoContinue: false });

      expect(value.corrections.listByTask(task.id)).toHaveLength(1);
      expect(value.corrections.listByTask(task.id)[0]).toMatchObject({ status: 'completed', attempts: 2 });
    });
  });

  it('refuses a credential-shaped revision and stores nothing of it', async () => {
    const value = setup();
    const task = await ready(value);
    const original = specOf(value, task.id);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    value.harness.codex.revisionQueue.push(
      makeSpecification({ summary: 'Use the key sk-abcdefghijklmnopqrstuvwxyz123456 for the service.' })
    );

    await expect(resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']))).rejects.toThrow(/credential-shaped/i);

    expect(specOf(value, task.id)).toBe(original);
    expect(value.corrections.listVersions(task.id)).toHaveLength(1);
  });

  it('applies nothing when the specification changed while Codex was revising it', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']));
    await tick();
    // Someone regenerates the specification while the revision is in flight.
    const elsewhere = JSON.stringify(makeSpecification({ title: 'Regenerated elsewhere' }));
    value.harness.tasks.update(task.id, { specificationJson: elsewhere });
    release.resolve(undefined);

    await expect(running).rejects.toThrow(/specification changed while the correction was running/i);
    expect(specOf(value, task.id)).toBe(elsewhere);
    expect(value.corrections.listByTask(task.id)[0]?.status).toBe('failed');
    expect(value.corrections.listVersions(task.id).map((entry) => entry.origin)).toEqual(['generated']);
  });

  it('reads a correction left `running` by a crash as interrupted, and resumes THE SAME row', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    // Resolve as the loop would, then "crash" right after the correction row was opened.
    const gate = currentGate(value, task.id);
    await value.gateService.runResolve(task.id, {
      gateId: gate.id,
      expectedRevision: gate.revision,
      decisions: decide([0, 'accept', 'Yes.']),
      allowAccepted: true
    });
    const settled = currentGate(value, task.id);
    const opened = value.corrections.begin({
      id: 'crashed-correction',
      versionId: 'crashed-version',
      taskId: task.id,
      sourceGateId: settled.id,
      fromSpecificationSha256: specificationIdentity(specOf(value, task.id)).sha256,
      currentSpecificationJson: specOf(value, task.id),
      acceptedJson: JSON.stringify([
        { finding: 0, severity: 'major', category: 'reliability', file: '', line: 0, title: 'Needs a change', why: 'w', fix: 'f', operatorNote: 'Yes.' }
      ])
    });
    expect(opened.status).toBe('running');

    // No loop is alive in this process: what is left behind is an interrupted attempt.
    expect(value.loop.detail(task.id).latest).toMatchObject({ status: 'interrupted', attempts: 1 });

    const resumed = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(resumed.stopped).toBe('clean');
    const rows = value.corrections.listByTask(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'crashed-correction', status: 'completed', attempts: 2 });
    expect(value.corrections.listVersions(task.id).map((entry) => entry.version)).toEqual([1, 2]);
  });

  it('revises a round resolved before the loop existed, from its recorded decisions', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Legacy accepted finding'], 'proceed'), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [proceed(value), proceed(value)];
    await value.gateService.review(task.id);
    const gate = currentGate(value, task.id);
    await value.gateService.runResolve(task.id, {
      gateId: gate.id,
      expectedRevision: gate.revision,
      decisions: decide([0, 'accept', 'Legacy note.']),
      allowAccepted: true
    });
    expect(currentGate(value, task.id).status).toBe('proceeded');
    expect(value.loop.detail(task.id).nextStep).toBe('revise');

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('clean');
    expect(value.harness.codex.revisionCalls[0]?.acceptedFindings[0]?.operatorNote).toBe('Legacy note.');
  });
});

describe('plan correction loop: the crash window between the commit and the next review', () => {
  it('resumes a committed correction by creating exactly one gate for the revised text, without asking Codex again', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    const source = currentGate(value, task.id);
    await value.gateService.runResolve(task.id, {
      gateId: source.id,
      expectedRevision: source.revision,
      decisions: decide([0, 'accept', 'Yes.']),
      allowAccepted: true
    });
    // The process dies right after the atomic commit: the revised version and the completed
    // correction are durable, but no gate exists for the revised specification yet.
    const original = specOf(value, task.id);
    const revised = JSON.stringify(makeSpecification({ summary: 'Revised before the crash' }));
    const opened = value.corrections.begin({
      id: 'correction-crashed',
      versionId: 'version-generated',
      taskId: task.id,
      sourceGateId: source.id,
      fromSpecificationSha256: specificationIdentity(original).sha256,
      currentSpecificationJson: original,
      acceptedJson: JSON.stringify([
        { finding: 0, severity: 'major', category: 'reliability', file: 'src/a.ts', line: 1, title: 'Needs a change', why: 'w', fix: 'f', operatorNote: 'Yes.' }
      ])
    });
    value.corrections.complete({
      correctionId: opened.id,
      versionId: 'version-revised',
      expectedSpecificationJson: original,
      newSpecificationJson: revised,
      newSpecificationSha256: specificationIdentity(revised).sha256,
      expectedTaskStatus: 'READY_FOR_IMPLEMENTATION',
      addressedJson: JSON.stringify([{ finding: 0, field: 'summary', change: 'Revised.' }])
    });
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(1);
    expect(value.loop.detail(task.id).nextStep).toBe('run_review');

    // After the restart: a fresh service, exactly as a restarted process would build it.
    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: true });

    expect(outcome.stopped).toBe('clean');
    expect(outcome).toMatchObject({ correctionsRun: 0, roundsReviewed: 1 });
    // One new gate, bound to the revised text; the old one is untouched history.
    const gates = value.harness.planReviewGates.listByTask(task.id);
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatchObject({ specificationSha256: specificationIdentity(revised).sha256, status: 'proceeded' });
    expect(gates[1]).toMatchObject({ id: source.id, specificationSha256: specificationIdentity(original).sha256 });
    // Nothing was repeated: no second revision, no second correction, no second version.
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.corrections.listByTask(task.id)).toHaveLength(1);
    expect(value.corrections.listVersions(task.id)).toHaveLength(2);
    // Resuming AGAIN is inert: it does not review the same text twice.
    const again = await value.loop.continueCorrection(task.id, { autoContinue: true });
    expect(again.stopped).toBe('clean');
    expect(value.reviewer.reviewCalls).toHaveLength(2);
  });
});

describe('plan correction loop: exclusion and reporting', () => {
  it('holds the task for its whole run: nothing else touches the plan review, and the phase is visible', async () => {
    const value = setup();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    const gate = currentGate(value, task.id);
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = value.loop.resolveAndRevise(task.id, {
      gateId: gate.id,
      expectedRevision: gate.revision,
      decisions: decide([0, 'accept', 'Yes.']),
      autoContinue: false
    });
    await tick();

    expect(value.loop.detail(task.id).loop).toEqual({ phase: 'revising', round: 1 });
    await expect(value.gateService.review(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.gateService.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(
      value.gateService.autoDecide(task.id, { gateId: gate.id, findingsSha256: planFindingsSha256(gate.findingsJson as string), findingIndex: 0 })
    ).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.loop.continueCorrection(task.id, { autoContinue: true })).rejects.toMatchObject({ code: 'BUSY' });

    release.resolve(undefined);
    await running;
    expect(value.loop.detail(task.id).loop).toBeNull();
  });

  it('reports versions, the budget and the next step', async () => {
    const value = setup({ maxReviewRounds: 3 });
    const task = await ready(value);
    expect(value.loop.detail(task.id)).toMatchObject({ used: 0, max: 3, nextStep: 'none', versions: [], latest: null });

    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, ['Another'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    expect(value.loop.detail(task.id).nextStep).toBe('decide');

    await resolveAndRevise(value, task.id, decide([0, 'accept', 'Yes.']));
    const detail = value.loop.detail(task.id);
    expect(detail).toMatchObject({ used: 1, max: 3, nextStep: 'decide', acceptedPending: 0 });
    expect(detail.latest).toMatchObject({ round: 1, status: 'completed', acceptedCount: 1 });
    expect(detail.versions.map((entry) => entry.origin)).toEqual(['generated', 'plan_correction']);
  });
});

/** Let work that is already scheduled run, so a held call is really in flight. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
