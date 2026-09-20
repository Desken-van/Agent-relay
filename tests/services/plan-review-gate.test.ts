import { afterEach, describe, expect, it } from 'vitest';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { TaskOperationRegistry } from '../../src/main/services/task-operations';
import { planReviewGateIdentity } from '../../src/main/services/plan-review-gate';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import type { ExternalPlanReviewStatus, TaskRuleEvidenceRepository } from '../../src/main/ports';
import type { PlanReviewDecision, PlanReviewGate } from '../../src/shared/domain/plan-review';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { FakeCodexAdapter, makeSpecification } from '../helpers/fakes';
import {
  FINGERPRINT,
  FakePlanReviewer,
  deferred,
  finding,
  planRounds,
  snapshot
} from '../helpers/fake-plan-reviewer';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Resolve the round the gate is actually showing.
 *
 * The service now demands the identity of the round a caller decided against,
 * so a test that means "answer the current round" has to say which one that is.
 * Tests about staleness build the request by hand instead.
 */
function resolveCurrent(
  value: ReturnType<typeof setup>,
  taskId: string,
  decisions: readonly PlanReviewDecision[] = []
): Promise<PlanReviewGate> {
  const gate = value.harness.planReviewGates.findByTask(taskId);
  if (gate === null) throw new Error('no gate to resolve');
  return value.service.resolve(taskId, {
    gateId: gate.id,
    expectedRevision: gate.revision,
    decisions,
    // These tests are about what `resolve` does with the provider. That an
    // accepted finding may only be resolved by the correction loop is the
    // subject of its own tests below.
    allowAccepted: true
  });
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  const reviewer = new FakePlanReviewer();
  const codex = new FakeCodexAdapter();
  const claims = new PlanReviewClaims();
  const build = (): PlanReviewGateService =>
    new PlanReviewGateService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      reviewer,
      codex,
      settings: harness.settings,
      clock: harness.clock,
      ids: harness.ids,
      claims,
      operations: harness.operations
    });
  const service = build();
  /**
   * A second service over the same database whose claims are its own.
   *
   * Not how the application is wired — the container shares one
   * {@link PlanReviewClaims} across every service it builds — and that is the
   * point: this is the seam where the single-flight arbitration is absent, so a
   * test using it is exercising the durable revision guard alone.
   */
  const unguarded = (): PlanReviewGateService =>
    new PlanReviewGateService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      reviewer,
      codex,
      settings: harness.settings,
      clock: harness.clock,
      ids: harness.ids,
      claims: new PlanReviewClaims(),
      // Its own registry too: this seam exists to have NO arbitration, so a test using it
      // exercises the durable revision guard alone, not the registry's refusal.
      operations: new TaskOperationRegistry()
    });
  return { harness, reviewer, codex, service, claims, build, unguarded };
}

async function ready(setupResult: ReturnType<typeof setup>, rules = snapshot()) {
  const project = setupResult.harness.createProject();
  const task = setupResult.harness.createTask(project.id);
  setupResult.service.bindRules(task.id, rules);
  await setupResult.harness.orchestrator.generateSpecification(task.id);
  const preparedTask = await setupResult.harness.orchestrator.preparePlanReviewWorktree(task.id);
  return { project, task: preparedTask, rules };
}

describe('durable external plan review gate', () => {
  it('binds one immutable snapshot idempotently and refuses replacement', () => {
    const { harness, service } = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    const first = service.bindRules(task.id, snapshot('first'));

    expect(service.bindRules(task.id, snapshot('first'))).toEqual(first);
    expect(() => service.bindRules(task.id, snapshot('second'))).toThrow(/immutable/i);
  });

  it('refuses to bind rules after specification generation has started', async () => {
    const { harness, service } = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);

    expect(() => service.bindRules(task.id, snapshot())).toThrow(/before specification/i);
  });

  it('passes the same hash-bound evidence into specification generation', async () => {
    const value = setup();
    const { rules } = await ready(value);

    expect(value.harness.codex.specificationCalls[0]?.ruleEvidence).toContain(rules.sha256);
    expect(value.harness.codex.specificationCalls[0]?.ruleEvidence).toContain('AGENTS.md');
  });

  it('persists reviewing before the non-idempotent external round starts', async () => {
    const value = setup();
    const { task, rules } = await ready(value);
    value.reviewer.onReview = () => {
      expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
        status: 'reviewing',
        sessionId: 'session-1',
        ruleEvidenceSha256: rules.sha256
      });
    };

    const gate = await value.service.review(task.id);
    expect(gate).toMatchObject({
      status: 'awaiting_resolve',
      verdict: 'proceed',
      gatingCount: 0,
      threshold: 2
    });
    expect(value.reviewer.reviewCalls[0]?.planText).toContain(rules.sha256);
    expect(value.reviewer.openCalls[0]).toEqual({
      repositoryPath: 'C:\\repo',
      branch: task.branchName
    });
  });

  it('does not treat a proceed verdict as approval before resolve', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);

    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('requires exactly one reasoned decision per finding', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      verdict: 'revise',
      gatingCount: 1,
      findings: [{
        severity: 'major', category: 'architecture', file: '', line: 0,
        title: 'Missing rollback', why: 'The plan omits it.', fix: 'Add it.',
        providers: ['codex'], role: 'PlanCritique'
      }]
    };
    await value.service.review(task.id);

    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/every finding/i);
    await expect(
      resolveCurrent(value, task.id, [{ finding: 0, action: 'reject', reason: '' }])
    ).rejects.toThrow(/reason/i);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('refuses credential-shaped resolution reasons before calling Coai', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      verdict: 'revise',
      findings: [{
        severity: 'major', category: 'security', file: '', line: 0,
        title: 'Finding', why: 'Why', fix: 'Fix', providers: ['codex'], role: 'PlanCritique'
      }]
    };
    await value.service.review(task.id);

    await expect(
      resolveCurrent(value, task.id, [{
        finding: 0,
        action: 'reject',
        reason: 'SERVICE_TOKEN=super-secret-value'
      }])
    ).rejects.toThrow(/credential-shaped/i);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('persists the resolution intent before calling the non-idempotent tool', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.onResolve = () => {
      expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
        status: 'resolving',
        decisionsJson: '[]'
      });
    };

    const gate = await resolveCurrent(value, task.id);
    expect(gate.status).toBe('proceeded');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).not.toThrow();
  });

  it('keeps a revise resolution gated for another plan round', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolution = { ...value.reviewer.resolution, stage: 'PlanReview' };

    await expect(resolveCurrent(value, task.id)).resolves.toMatchObject({
      status: 'changes_requested'
    });
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('invalidates a proceeded gate when the specification identity changes', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    await resolveCurrent(value, task.id);
    value.harness.tasks.update(task.id, {
      specificationJson: JSON.stringify(makeSpecification({ summary: 'A changed plan.' }))
    });

    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('records an unknown external review outcome and never retries it automatically', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('review connection vanished');

    await expect(value.service.review(task.id)).rejects.toThrow(/vanished/);
    // The phase the dispatch reached is kept. Writing "failed" here would claim
    // the round did not run, which a lost answer cannot establish.
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'reviewing',
      lastError: 'review connection vanished'
    });
    await expect(value.service.review(task.id)).rejects.toThrow(/durable status is "reviewing"/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('does not repeat a review whose persisted opening state has an unknown outcome', async () => {
    const value = setup();
    const { task } = await ready(value);
    const gate = value.service.prepare(task.id);
    value.harness.planReviewGates.update(gate.id, { status: 'opening' });

    await expect(value.service.review(task.id)).rejects.toThrow(/durable status is "opening"/i);
    expect(value.reviewer.openCalls).toHaveLength(0);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
  });

  it('refuses credential-shaped rule text before the external review call', async () => {
    const value = setup();
    const { task } = await ready(value, snapshot('SERVICE_TOKEN=super-secret-value'));

    await expect(value.service.review(task.id)).rejects.toThrow(/credential-shaped/i);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
  });

  it('does not leave an unavailable provider as a permanent dead end', async () => {
    const value = setup();
    const { task } = await ready(value);
    // The session could not even be opened, so the gate never left `opening`
    // and `review_plan` was never dispatched. That is the one phase where an
    // empty round list is conclusive, and the only call that did go out —
    // `open` — is idempotent per repository and branch.
    value.reviewer.openError = new Error('connection refused');

    await expect(value.service.review(task.id)).rejects.toThrow(/refused/);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.harness.planReviewGates.findByTask(task.id)?.status).toBe('opening');

    value.reviewer.openError = null;
    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds(), awaitingResolve: false };
    expect(await value.service.reconcile(task.id)).toMatchObject({ status: 'prepared', lastError: null });

    await value.service.review(task.id);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('re-arms only an opening gate when the provider proves no session exists', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.openError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    value.reviewer.statusError = new AgentRelayError(
      'NOT_FOUND',
      'Coai has no session for this repository and branch.'
    );
    const recovered = await value.service.reconcile(task.id);
    expect(recovered).toMatchObject({ status: 'prepared', lastError: null, sessionId: null });
    expect(value.reviewer.openCalls).toHaveLength(1);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
    expect(value.reviewer.statusCalls).toHaveLength(1);

    value.reviewer.statusError = null;
    value.reviewer.openError = null;
    await value.service.review(task.id);
    expect(value.reviewer.openCalls).toHaveLength(2);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('never treats a missing session as permission to repeat a dispatched round', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    value.reviewer.statusError = new AgentRelayError(
      'NOT_FOUND',
      'Coai has no session for this repository and branch.'
    );
    await expect(value.service.reconcile(task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.harness.planReviewGates.findByTask(task.id)?.status).toBe('reviewing');
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('does not re-arm a dispatched round because the provider lists none', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // `review_plan` went out from here. An empty round list is equally
    // consistent with "never accepted" and "accepted, not yet recorded", and
    // only the first of those would make a second dispatch safe.
    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds(), awaitingResolve: false };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('reviewing');
    expect(gate.lastError).toMatch(/not proof/i);
    value.reviewer.reviewError = null;
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('reconciles by reading only, never by repeating the round or the resolution', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    const reviewsBefore = value.reviewer.reviewCalls.length;
    await value.service.reconcile(task.id);

    expect(value.reviewer.statusCalls).toHaveLength(1);
    expect(value.reviewer.reviewCalls).toHaveLength(reviewsBefore);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('keeps an unknown round unknown when the provider cannot return its findings', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // The round did run and awaits decisions, but status carries no findings.
    value.reviewer.state = {
      ...value.reviewer.state,
      planRounds: planRounds({ total: 1, done: 1 }),
      awaitingResolve: true
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('reviewing');
    expect(gate.lastError).toMatch(/does not return that round's findings/i);
    // And nothing may be dispatched against that unknown round.
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
  });

  it('does not record an unknown resolution as a proven failure', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = { ...value.reviewer.round, verdict: 'revise', findings: [] };
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');

    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'resolving',
      lastError: 'resolve answer lost'
    });
  });

  it('restores a pending round when the provider proves the decisions never landed', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = { ...value.reviewer.round, verdict: 'revise' };
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);

    value.reviewer.state = {
      ...value.reviewer.state,
      awaitingResolve: true,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    expect(await value.service.reconcile(task.id)).toMatchObject({
      status: 'awaiting_resolve',
      lastError: null
    });
    expect(value.reviewer.resolveCalls).toHaveLength(1);
  });

  it('settles a resolution the provider did apply', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);

    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    expect(await value.service.reconcile(task.id)).toMatchObject({ status: 'proceeded' });
    expect(value.reviewer.resolveCalls).toHaveLength(1);
  });

  it('invents nothing when the provider state does not close the pending round', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);

    // Internally consistent — a finished session, past the plan gate on every
    // field — and still not evidence about this pending resolution. `Done` is
    // not `CodeReview`, and widening the approval test to accept it is a
    // decision this pass declines to make on the provider's behalf.
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'Done',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('resolving');
    expect(gate.lastError).toMatch(/does not say whether the pending round was closed/i);
  });

  it('keeps an unknown intent across a restart of the service', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // A fresh service with a fresh claim map over the same durable
    // repositories, which is exactly what a restart leaves behind: nothing
    // about the unknown outcome may live in process memory, and the in-flight
    // claim the lost call held is gone with the process that held it.
    const restarted = value.unguarded();
    expect(value.claims.heldBy(task.id)).toBeNull();

    // The refusal that follows therefore comes from the durable phase alone —
    // no lock survived to produce it. A claim that outlived its process would
    // have to be broken by hand; the gate's own status is the thing that has to
    // survive, and it does.
    await expect(restarted.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({ status: 'reviewing' });
  });

  it('recovers a legacy failed row without repeating anything', async () => {
    const value = setup();
    const { task } = await ready(value);
    const gate = value.service.prepare(task.id);
    // What an earlier version wrote for a lost answer.
    value.harness.planReviewGates.update(gate.id, { status: 'failed', lastError: 'old loss' });

    // A legacy row does not record which phase it was written from, so it
    // cannot be narrowed to the one case where an empty round list is
    // conclusive. It stays recoverable — reconciliation still reads it, and a
    // provider that reports a real outcome still settles it — but it is never
    // re-armed on an absence of evidence.
    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds(), awaitingResolve: false };
    const reconciled = await value.service.reconcile(task.id);

    expect(reconciled.status).toBe('failed');
    expect(reconciled.lastError).toMatch(/not proof/i);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('refuses to reconcile a gate that has no unknown outcome', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.service.prepare(task.id);

    await expect(value.service.reconcile(task.id)).rejects.toThrow(/no unknown outcome/i);
    expect(value.reviewer.statusCalls).toHaveLength(0);
  });

  it('never reopens a gate while the provider is still running the round', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // The round this side stopped waiting for is still executing there.
    value.reviewer.state = {
      ...value.reviewer.state,
      planRounds: planRounds({ total: 1, running: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('reviewing');
    expect(gate.lastError).toMatch(/still executing a plan round/i);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('does not let a second reconcile open a repeat while a round runs', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
    value.reviewer.state = {
      ...value.reviewer.state,
      planRounds: planRounds({ total: 1, running: 1 })
    };

    // Straight at the service, with no renderer guard in the way. The first
    // takes the claim; the second is refused before it reaches the provider, so
    // only one read-back happens at all.
    const settled = await Promise.allSettled([
      value.service.reconcile(task.id),
      value.service.reconcile(task.id)
    ]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.statusCalls).toHaveLength(1);

    const answer = (fulfilled[0] as PromiseFulfilledResult<PlanReviewGate>).value;
    expect(answer.status).toBe('reviewing');
    expect(answer.lastError).toMatch(/still executing a plan round/i);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  it('does not count an interrupted round as a completed one', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    value.reviewer.state = {
      ...value.reviewer.state,
      planRounds: planRounds({ total: 1, interrupted: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    // Its own state: a round really was consumed, but produced no result.
    expect(gate.status).toBe('interrupted');
    expect(gate.lastError).toMatch(/started and never finished/i);
    expect(gate.reconciledAt).not.toBeNull();

    // And a new round may be started by hand from there.
    value.reviewer.reviewError = null;
    await value.service.review(task.id);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
  });

  it('applies nothing when the provider answers for another session, but still records a simultaneous contract drift', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);
    const before = value.harness.planReviewGates.findByTask(task.id);
    expect(before?.contractMismatchAt).toBeNull();

    // A session mismatch and a contract drift are independent facts — a
    // fingerprint never encodes session identity — so both must be
    // observable from the same reconciliation read, not one crowding out
    // the other.
    const drifted = 'd'.repeat(64);
    value.reviewer.state = {
      ...value.reviewer.state,
      sessionId: 'a-different-session',
      contractFingerprint: drifted,
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('resolving');
    expect(gate.sessionId).toBe(before?.sessionId);
    expect(gate.lastError).toMatch(/different session/i);
    // The historical fingerprint survives untouched...
    expect(gate.contractFingerprint).toBe(before?.contractFingerprint);
    // ...and the drift is made explicit rather than silently absorbed by the
    // session-mismatch branch.
    expect(gate.contractMismatchAt).not.toBeNull();
  });

  it('refuses to open approval on a contradictory provider state', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);

    // Past the plan stage by one field and not by the other.
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: false,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('resolving');
    expect(gate.reconciledAt).toBeNull();
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('lets a round resolved inside the provider unblock the next one', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // The operator answered the completed round in the provider itself.
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'PlanReview',
      awaitingResolve: false,
      planProceeded: false,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('changes_requested');
    expect(gate.reconciledAt).not.toBeNull();

    value.reviewer.reviewError = null;
    await value.service.review(task.id);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
  });

  /* ------------------------------------------------------------------------ */
  /* Contradictory evidence                                                     */
  /* ------------------------------------------------------------------------ */

  it('does not reopen a gate for a round that awaits decisions it has never had', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);

    // Field by field this looks like "nothing has run": no rounds recorded, the
    // plan stage still open, nothing proceeded. Together with `awaitingResolve`
    // it is impossible, and reading it as an empty session would re-arm a
    // non-idempotent dispatch over a round that may be mid-flight.
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'PlanReview',
      awaitingResolve: true,
      planProceeded: false,
      planRounds: planRounds()
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('reviewing');
    expect(gate.reconciledAt).toBeNull();
    expect(gate.lastError).toMatch(/contradicts itself/i);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('changes nothing at all for any cross-field contradiction', async () => {
    const contradictions: Partial<ExternalPlanReviewStatus>[] = [
      // Past the plan gate on the stage, not on the flag.
      { stage: 'CodeReview', planProceeded: false, planRounds: planRounds({ total: 1, done: 1 }) },
      // Past it on the flag, not on the stage.
      { stage: 'PlanReview', planProceeded: true, planRounds: planRounds({ total: 1, done: 1 }) },
      // Proceeded with no round behind it.
      { stage: 'CodeReview', planProceeded: true, planRounds: planRounds() },
      // A tally that does not add up.
      { stage: 'PlanReview', planProceeded: false, planRounds: { total: 4, running: 0, done: 1, interrupted: 0 } },
      // No rounds, but not at the start of a session either.
      { stage: 'Done', planProceeded: true, planRounds: planRounds() }
    ];

    for (const contradiction of contradictions) {
      const value = setup();
      const { task } = await ready(value);
      value.reviewer.reviewError = new Error('answer lost');
      await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
      const before = value.harness.planReviewGates.findByTask(task.id);

      value.reviewer.state = { ...value.reviewer.state, awaitingResolve: false, ...contradiction };
      const gate = await value.service.reconcile(task.id);

      expect(gate.status).toBe(before?.status);
      expect(gate.reconciledAt).toBeNull();
      expect(gate.lastError).toMatch(/contradicts itself/i);
      // Refused, not retried: reading an impossible answer must never provoke a
      // second non-idempotent call in the hope of a better one.
      expect(value.reviewer.reviewCalls).toHaveLength(1);
      expect(value.reviewer.resolveCalls).toHaveLength(0);
      expect(value.reviewer.statusCalls).toHaveLength(1);
      await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Serialisation and stale answers                                            */
  /* ------------------------------------------------------------------------ */

  it('refuses a reconciliation while a review of the same task is in flight', async () => {
    const value = setup();
    const { task } = await ready(value);
    const round = deferred();
    value.reviewer.reviewGate = round.promise;
    const reviewing = value.service.review(task.id);
    await Promise.resolve();

    await expect(value.service.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    // Refused before the provider was touched: no read-back was even attempted.
    expect(value.reviewer.statusCalls).toHaveLength(0);

    round.resolve(undefined);
    await reviewing;
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('refuses a reconciliation while a resolution of the same task is in flight', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    const answering = deferred();
    value.reviewer.resolveGate = answering.promise;
    const resolving = resolveCurrent(value, task.id);
    await Promise.resolve();

    await expect(value.service.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.statusCalls).toHaveLength(0);

    answering.resolve(undefined);
    await resolving;
    expect(value.reviewer.resolveCalls).toHaveLength(1);
  });

  it('holds the claim across a renderer navigation, which releases nothing', async () => {
    const value = setup();
    const { task } = await ready(value);
    const round = deferred();
    value.reviewer.reviewGate = round.promise;
    const reviewing = value.service.review(task.id);
    await Promise.resolve();

    // A renderer that navigates away and back performs no main-process work at
    // all: it unmounts a component and later mounts a new one. The claim lives
    // where the call does, so nothing about that sequence can release it, and
    // the panel that comes back is talking to the same guard.
    expect(value.claims.heldBy(task.id)).toBe('review');
    const afterRemount = value.build();
    await expect(afterRemount.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(afterRemount.review(task.id)).rejects.toMatchObject({ code: 'BUSY' });

    round.resolve(undefined);
    await reviewing;
    expect(value.claims.heldBy(task.id)).toBeNull();
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.reviewer.statusCalls).toHaveLength(0);
  });

  it('is not bypassed by a second service, which is what every IPC call builds', async () => {
    const value = setup();
    const { task } = await ready(value);
    const round = deferred();
    value.reviewer.reviewGate = round.promise;
    const reviewing = value.service.review(task.id);
    await Promise.resolve();

    // The IPC layer calls a factory per invocation, so "a direct IPC call" is
    // exactly a freshly built service. It contends for the same claim because
    // the container closes over one guard rather than making a new one.
    await expect(value.build().review(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.reviewCalls).toHaveLength(1);

    round.resolve(undefined);
    await reviewing;
  });

  it('discards a read-back whose gate moved while the provider was being read', async () => {
    const value = setup();
    const { task } = await ready(value);
    const round = deferred();
    value.reviewer.reviewGate = round.promise;
    const reviewing = value.service.review(task.id);
    await Promise.resolve();
    expect(value.harness.planReviewGates.findByTask(task.id)?.status).toBe('reviewing');

    // The single-flight claim already forbids this overlap; the point here is
    // what happens if it is ever absent, so the reconciliation runs from a
    // service with its own guard. The snapshot it reads is true at the moment
    // of reading — no round recorded yet — and would settle the gate as
    // `prepared`, re-arming a dispatch over a round that is still executing.
    const readBack = deferred();
    value.reviewer.onStatusCall = () => readBack.promise;
    const reconciling = value.unguarded().reconcile(task.id);
    await Promise.resolve();

    // The round lands first, with its findings.
    round.resolve(undefined);
    await reviewing;
    const settledGate = value.harness.planReviewGates.findByTask(task.id);
    expect(settledGate?.status).toBe('awaiting_resolve');

    // Only now does the older answer come back.
    readBack.resolve(undefined);
    const answer = await reconciling;

    expect(answer.status).toBe('awaiting_resolve');
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'awaiting_resolve',
      revision: settledGate?.revision
    });
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('lets the newer of two out-of-order read-backs win, whichever returns last', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
    const start = value.harness.planReviewGates.findByTask(task.id);

    const older = deferred();
    const newer = deferred();
    value.reviewer.onStatusCall = (index) => (index === 0 ? older.promise : newer.promise);

    // Two readings of the same gate revision, taken from two different worlds.
    // The stale one must be a reading that would MOVE the gate — an empty round
    // list no longer does, because from `reviewing` it settles nothing — so it
    // reports an interrupted round, which is its own durable status.
    value.reviewer.state = {
      ...value.reviewer.state,
      planRounds: planRounds({ total: 1, interrupted: 1 })
    };
    const stale = value.unguarded().reconcile(task.id);
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'PlanReview',
      awaitingResolve: false,
      planProceeded: false,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const fresh = value.unguarded().reconcile(task.id);
    await Promise.resolve();

    // The newer reading is applied first, and the older one returns after it.
    newer.resolve(undefined);
    expect(await fresh).toMatchObject({ status: 'changes_requested' });
    older.resolve(undefined);
    const late = await stale;

    // The late answer would have said `interrupted`. It does not get to say it.
    expect(late.status).toBe('changes_requested');
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'changes_requested'
    });
    expect(start?.revision).toBeLessThan(late.revision);
  });

  /* ------------------------------------------------------------------------ */
  /* Provenance                                                                 */
  /* ------------------------------------------------------------------------ */

  it('starts a manual round with the previous round\'s evidence cleared', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(resolveCurrent(value, task.id)).rejects.toThrow(/lost/);

    // Reach `changes_requested` by reading the provider back, so the row is
    // carrying a reconciled provenance and a finished round's evidence.
    value.reviewer.state = {
      ...value.reviewer.state,
      stage: 'PlanReview',
      awaitingResolve: false,
      planProceeded: false,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const reconciled = await value.service.reconcile(task.id);
    expect(reconciled.status).toBe('changes_requested');
    expect(reconciled.reconciledAt).not.toBeNull();

    // While the next round is in flight, none of the previous round's evidence
    // may still be attached: `reviewing` must not read as a result.
    value.reviewer.resolveError = null;
    value.reviewer.onReview = () => {
      expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
        status: 'reviewing',
        reconciledAt: null,
        verdict: null,
        findingsJson: null,
        decisionsJson: null,
        reviewers: null,
        gatingCount: null,
        threshold: null
      });
    };
    const started = await value.service.review(task.id);

    expect(started.status).toBe('awaiting_resolve');
    expect(started.reconciledAt).toBeNull();
    expect(started.reviewers).toBe('all 2 reviewers answered');
  });

  it('gives a live resolution its own provenance rather than a read-back\'s', async () => {
    const value = setup();
    const { task } = await ready(value);
    const awaiting = await value.service.review(task.id);
    expect(awaiting.status).toBe('awaiting_resolve');

    // Planted straight onto the row rather than reached through a transition.
    // No current path leaves a reconciled provenance attached to a round that
    // is then resolved from here — the manual restart clears it first — so the
    // invariant is pinned against the row it protects instead of against
    // today's route to it. A future transition that did leave one attached
    // would otherwise pass a `proceeded` off as externally established.
    value.harness.planReviewGates.update(awaiting.id, {
      reconciledAt: '2026-09-06T00:00:00.000Z'
    });

    const resolved = await resolveCurrent(value, task.id);

    expect(resolved.status).toBe('proceeded');
    expect(resolved.reconciledAt).toBeNull();
    expect(resolved.decisionsJson).toBe('[]');
    expect(value.harness.planReviewGates.findByTask(task.id)?.reconciledAt).toBeNull();
  });

  /* ------------------------------------------------------------------------ */
  /* Contradictory evidence must not touch identity                             */
  /* ------------------------------------------------------------------------ */

  it('changes no identity, provenance or evidence when the status contradicts itself', async () => {
    const value = setup();
    const { task } = await ready(value);
    // `open` is where the answer was lost, so the gate has no session id at all.
    // That is the dangerous case: there is nothing for a mismatch check to catch,
    // and a contradictory answer that was allowed to write its own session id
    // would then be the identity every later, valid answer is measured against.
    value.reviewer.openError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
    const before = value.harness.planReviewGates.findByTask(task.id);
    expect(before?.status).toBe('opening');
    expect(before?.sessionId).toBeNull();

    value.reviewer.state = {
      ...value.reviewer.state,
      sessionId: 'a-session-this-gate-never-recorded',
      serverName: 'impostor-mcp',
      serverVersion: '9.9.9',
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: false,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const after = await value.service.reconcile(task.id);

    expect(after.lastError).toMatch(/contradicts itself/i);
    // Field by field, not just the interesting ones: the only thing this answer
    // is allowed to have written is the diagnostic, plus the revision bump and
    // timestamp that any write carries.
    expect({ ...after, lastError: null, revision: 0, updatedAt: '' }).toEqual({
      ...before,
      lastError: null,
      revision: 0,
      updatedAt: ''
    });
    expect(after.sessionId).toBeNull();
    expect(after.serverName).toBeNull();
    expect(after.serverVersion).toBeNull();
    expect(after.reconciledAt).toBeNull();
    expect(after.status).toBe('opening');

    // And the gate is still measured against the real session when one arrives.
    value.reviewer.state = {
      ...value.reviewer.state,
      sessionId: 'session-1',
      stage: 'PlanReview',
      planProceeded: false,
      awaitingResolve: false,
      planRounds: planRounds()
    };
    expect(await value.service.reconcile(task.id)).toMatchObject({
      status: 'prepared',
      sessionId: 'session-1'
    });
  });

  /* ------------------------------------------------------------------------ */
  /* A regenerated specification must not hide an unfinished gate               */
  /* ------------------------------------------------------------------------ */

  it('does not let a regenerated specification open a second gate over an unfinished one', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
    const stranded = value.harness.planReviewGates.findByTask(task.id);
    expect(stranded?.status).toBe('reviewing');

    // Regenerating is allowed from READY_FOR_IMPLEMENTATION, and it changes the
    // specification hash — which used to be enough for `prepare` to create a
    // second row and for `findByTask` to start answering with it instead.
    value.harness.codex.specification = makeSpecification({
      title: 'A different plan entirely',
      summary: 'Expose GET /healthz instead.'
    });
    await value.harness.orchestrator.generateSpecification(task.id);

    expect(() => value.service.prepare(task.id)).toThrow(/second gate/i);
    await expect(value.service.review(task.id)).rejects.toThrow(/second gate/i);
    value.reviewer.reviewError = null;
    await expect(value.service.review(task.id)).rejects.toThrow(/second gate/i);

    // The stranded round is still the task's gate, so it can still be recovered.
    const current = value.harness.planReviewGates.findByTask(task.id);
    expect(current?.id).toBe(stranded?.id);
    expect(current?.status).toBe('reviewing');
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('lets a regenerated specification supersede a gate with nothing outstanding', async () => {
    const value = setup();
    const { task } = await ready(value);
    const first = value.service.prepare(task.id);
    expect(first.status).toBe('prepared');

    // Nothing was ever dispatched for the old specification, so there is no
    // outstanding round to hide and superseding repeats nothing.
    value.harness.codex.specification = makeSpecification({ title: 'Second thoughts' });
    await value.harness.orchestrator.generateSpecification(task.id);
    const second = value.service.prepare(task.id);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('prepared');
    expect(value.reviewer.reviewCalls).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------ */
  /* Preparation validates before it mutates the checkout                       */
  /* ------------------------------------------------------------------------ */

  it('refuses an impossible preparation before any Git mutation happens', async () => {
    const value = setup();
    const project = value.harness.createProject();
    const task = value.harness.createTask(project.id);
    await value.harness.orchestrator.generateSpecification(task.id);
    const worktreesBefore = value.harness.git.createdWorktrees.length;

    // The order the IPC handler uses: validate first, mutate second. Creating
    // the branch first would leave a READY task holding review infrastructure
    // it can never use, because rule evidence binds only in DRAFT.
    expect(() => value.service.assertPreparable(task.id)).toThrow(/Bind rule evidence/i);
    expect(value.harness.git.createdWorktrees).toHaveLength(worktreesBefore);
    expect(value.harness.planReviewGates.findByTask(task.id)).toBeNull();
  });

  it('refuses preparation for a blocking gate before any Git mutation happens', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.reviewError = new Error('answer lost');
    await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
    value.harness.codex.specification = makeSpecification({ title: 'Another attempt' });
    await value.harness.orchestrator.generateSpecification(task.id);
    const worktreesBefore = value.harness.git.createdWorktrees.length;

    expect(() => value.service.assertPreparable(task.id)).toThrow(/second gate/i);
    expect(value.harness.git.createdWorktrees).toHaveLength(worktreesBefore);
  });

  /* ------------------------------------------------------------------------ */
  /* Decisions belong to exactly one round                                      */
  /* ------------------------------------------------------------------------ */

  it('refuses decisions taken against a round that is no longer current', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      verdict: 'revise',
      gatingCount: 1,
      threshold: 0,
      findings: [finding('Round A finding')]
    };
    const roundA = await value.service.review(task.id);
    expect(roundA.status).toBe('awaiting_resolve');

    // Round A is answered — by another window, or by this one before a reload —
    // and a second round of exactly the same length replaces it.
    value.reviewer.resolution = {
      ...value.reviewer.resolution,
      stage: 'PlanReview',
      awaitingResolve: false
    };
    await resolveCurrent(value, task.id, [{ finding: 0, action: 'accept', reason: '' }]);
    value.reviewer.round = { ...value.reviewer.round, findings: [finding('Round B finding')] };
    const roundB = await value.service.review(task.id);
    expect(roundB.status).toBe('awaiting_resolve');

    // The stale screen submits round A's answers. The indices line up perfectly
    // — one finding, index 0 — so nothing but the round identity can tell them
    // apart, and the reason is about a finding that is no longer on the table.
    await expect(
      value.service.resolve(task.id, {
        gateId: roundA.id,
        expectedRevision: roundA.revision,
        decisions: [{ finding: 0, action: 'reject', reason: 'Round A reason, wrong round.' }]
      })
    ).rejects.toThrow(/no longer the current one/i);

    // One resolve reached the provider, and it was round A's own.
    expect(value.reviewer.resolveCalls).toHaveLength(1);
    expect(JSON.stringify(value.reviewer.resolveCalls)).not.toContain('wrong round');
    const current = value.harness.planReviewGates.findByTask(task.id);
    expect(current?.status).toBe('awaiting_resolve');
    expect(current?.decisionsJson).toBeNull();
    expect(current?.revision).toBe(roundB.revision);
  });

  it('refuses decisions for a gate id that is not this task\'s current one', async () => {
    const value = setup();
    const { task } = await ready(value);
    const gate = await value.service.review(task.id);

    await expect(
      value.service.resolve(task.id, {
        gateId: 'some-other-gate',
        expectedRevision: gate.revision,
        decisions: []
      })
    ).rejects.toThrow(/no longer the current one/i);
    expect(value.reviewer.resolveCalls).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------ */
  /* A review that cannot run must leave nothing behind                         */
  /* ------------------------------------------------------------------------ */

  it('creates no gate when the task has no branch to review', async () => {
    const value = setup();
    const project = value.harness.createProject();
    const task = value.harness.createTask(project.id);
    value.service.bindRules(task.id, snapshot());
    await value.harness.orchestrator.generateSpecification(task.id);
    // Ready and bound, but `preparePlanReviewWorktree` was never called, so
    // there is no isolated branch — the state a direct or stale IPC call can
    // arrive in.
    expect(value.harness.tasks.findById(task.id)?.branchName).toBeNull();

    await expect(value.service.review(task.id)).rejects.toMatchObject({ code: 'WORKTREE_INVALID' });

    // Nothing durable, and nothing external. A `prepared` row here would be a
    // gate the screen offers to run and the service can never start.
    expect(value.harness.planReviewGates.findByTask(task.id)).toBeNull();
    expect(value.reviewer.openCalls).toHaveLength(0);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
  });

  it('adds no gate for a regenerated specification when the branch has gone', async () => {
    const value = setup();
    const { task } = await ready(value);
    const before = value.service.prepare(task.id);

    // A new specification identity, so `prepare` would create a row rather than
    // return the existing one — and no branch to review it on. This is the
    // ordering that matters: with the branch check after `prepare`, the write
    // has already happened by the time the refusal arrives.
    value.harness.codex.specification = makeSpecification({ title: 'Second thoughts' });
    await value.harness.orchestrator.generateSpecification(task.id);
    value.harness.tasks.update(task.id, { branchName: null });

    await expect(value.service.review(task.id)).rejects.toMatchObject({ code: 'WORKTREE_INVALID' });

    const after = value.harness.planReviewGates.findByTask(task.id);
    expect(after?.id).toBe(before.id);
    expect(after?.specificationSha256).toBe(before.specificationSha256);
    expect(value.reviewer.openCalls).toHaveLength(0);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------ */
  /* Whether the latest gate still speaks for the current specification         */
  /* ------------------------------------------------------------------------ */

  it('reports a settled gate as current until the specification is regenerated', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    const proceeded = await resolveCurrent(value, task.id);
    expect(proceeded.status).toBe('proceeded');

    const current = () =>
      planReviewGateIdentity({
        task: value.harness.tasks.findById(task.id)!,
        gate: value.harness.planReviewGates.findByTask(task.id),
        ruleEvidence: value.harness.taskRuleEvidence
      });

    expect(current()).toBe('current');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).not.toThrow();

    // Regenerating changes the identity the gate was measured against. The row
    // does not move, and it is still the newest — only the question it answers
    // has changed, which is the whole reason this has to be computed here.
    value.harness.codex.specification = makeSpecification({ title: 'Second thoughts' });
    await value.harness.orchestrator.generateSpecification(task.id);

    expect(current()).toBe('obsolete');
    expect(value.harness.planReviewGates.findByTask(task.id)?.id).toBe(proceeded.id);
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('reports an unparseable specification as unknown, never as obsolete', async () => {
    const value = setup();
    const { task } = await ready(value);
    const gate = value.service.prepare(task.id);

    // Nothing was compared, so nothing is known. Calling this `obsolete` would
    // assert the review belongs to an earlier specification on no evidence at
    // all — and send the operator to a preparation that cannot succeed.
    value.harness.tasks.update(task.id, { specificationJson: 'not json' });
    expect(
      planReviewGateIdentity({
        task: value.harness.tasks.findById(task.id)!,
        gate,
        ruleEvidence: value.harness.taskRuleEvidence
      })
    ).toBe('unknown');
  });

  it('reports an unreadable rule binding as unknown even for a settled gate', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    const proceeded = await resolveCurrent(value, task.id);
    expect(proceeded.status).toBe('proceeded');

    // The binding row still exists; its bytes no longer match their recorded
    // hash, which is what `readBoundRuleEvidence` raises on. The stored binding
    // is immutable by design, so the damaged read is supplied here rather than
    // written — the point is what the identity check does when the read throws,
    // not how the bytes came to be wrong.
    const binding = value.harness.taskRuleEvidence.findByTask(task.id);
    const unreadable: TaskRuleEvidenceRepository = {
      findByTask: () => ({
        ...binding!,
        snapshotJson: '{"version":1,"sources":[],"files":[],"omitted":[],"totalBytes":0}'
      }),
      create: () => {
        throw new Error('not used');
      }
    };

    expect(
      planReviewGateIdentity({
        task: value.harness.tasks.findById(task.id)!,
        gate: value.harness.planReviewGates.findByTask(task.id),
        ruleEvidence: unreadable
      })
    ).toBe('unknown');

    // The contrast is the whole point: the same gate, the same specification,
    // read through the intact binding, is `current`. Nothing about the review
    // changed — only whether the question could be answered at all.
    expect(
      planReviewGateIdentity({
        task: value.harness.tasks.findById(task.id)!,
        gate: value.harness.planReviewGates.findByTask(task.id),
        ruleEvidence: value.harness.taskRuleEvidence
      })
    ).toBe('current');
  });

  it('has no gate identity to report when no gate exists', async () => {
    const value = setup();
    const { task } = await ready(value);
    expect(
      planReviewGateIdentity({
        task: value.harness.tasks.findById(task.id)!,
        gate: null,
        ruleEvidence: value.harness.taskRuleEvidence
      })
    ).toBe('no_gate');
  });

  it('refuses to approve a specification whose round accepted findings that were never folded into it', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      findings: [finding('Serialize concurrent lifecycle calls')]
    };
    await value.service.review(task.id);
    await resolveCurrent(value, task.id, [{ finding: 0, action: 'accept', reason: 'Cover the races.' }]);

    // The provider moved on and the gate is `proceeded`, yet the specification is
    // unchanged: approving it would carry the accepted finding forward unaddressed.
    expect(value.harness.planReviewGates.findByTask(task.id)?.status).toBe('proceeded');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/accepted findings/i);
    expect(value.harness.tasks.findById(task.id)?.specificationApprovedAt).toBeNull();
  });

  it('refuses to resolve an accepted finding through the plain resolve, and dispatches nothing', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = { ...value.reviewer.round, findings: [finding('Needs a plan change')] };
    await value.service.review(task.id);
    const gate = value.harness.planReviewGates.findByTask(task.id)!;

    await expect(
      value.service.resolve(task.id, {
        gateId: gate.id,
        expectedRevision: gate.revision,
        decisions: [{ finding: 0, action: 'accept', reason: '' }]
      })
    ).rejects.toThrow(/revision of the plan/i);

    expect(value.reviewer.resolveCalls).toHaveLength(0);
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'awaiting_resolve',
      decisionsJson: null,
      revision: gate.revision
    });
  });

  it('refuses implementation, even for a specification approved earlier, while accepted findings are uncorrected', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      findings: [finding('Serialize concurrent lifecycle calls')]
    };
    await value.service.review(task.id);
    await resolveCurrent(value, task.id, [{
      finding: 0,
      action: 'accept',
      reason: 'Cover start/start and start/stop races.'
    }]);
    // Approved by an earlier version, which checked hashes only.
    value.harness.tasks.update(task.id, { specificationApprovedAt: value.harness.clock.nowIso() });

    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(/accepted findings/i);
    expect(value.harness.claude.calls).toHaveLength(0);
  });

  it('uses bound evidence again for implementation and final Codex review', async () => {
    const value = setup();
    const { task, rules } = await ready(value);
    await value.service.review(task.id);
    await resolveCurrent(value, task.id, []);
    value.harness.orchestrator.approveSpecification(task.id);
    await value.harness.orchestrator.sendToClaude(task.id);
    await value.harness.orchestrator.reviewWithCodex(task.id);

    expect(value.harness.claude.calls[0]?.prompt).toContain(rules.sha256);
    expect(value.harness.codex.reviewCalls[0]?.ruleEvidence).toContain(rules.sha256);
  });

  it('does not turn a rejected external finding into an implementation requirement', async () => {
    const value = setup();
    const { task } = await ready(value);
    value.reviewer.round = {
      ...value.reviewer.round,
      findings: [finding('Do not carry this refuted finding')]
    };
    await value.service.review(task.id);
    await resolveCurrent(value, task.id, [{
      finding: 0,
      action: 'reject',
      reason: 'The premise is contradicted by the existing service.'
    }]);
    value.harness.orchestrator.approveSpecification(task.id);
    await value.harness.orchestrator.sendToClaude(task.id);

    const prompt = value.harness.claude.calls[0]?.prompt ?? '';
    expect(prompt).not.toContain('Do not carry this refuted finding');
    expect(prompt).not.toContain('The premise is contradicted by the existing service.');
    expect(prompt).not.toContain('USER-ACCEPTED EXTERNAL PLAN-REVIEW REQUIREMENTS');
  });

  describe('Coai contract fingerprint evidence', () => {
    it('persists the discovered contract fingerprint through open, review and resolve when the contract is stable', async () => {
      const value = setup();
      const { task } = await ready(value);

      const reviewed = await value.service.review(task.id);
      expect(reviewed.contractFingerprint).toBe(FINGERPRINT);
      expect(reviewed.contractMismatchAt).toBeNull();

      const resolved = await resolveCurrent(value, task.id);
      expect(resolved.contractFingerprint).toBe(FINGERPRINT);
      expect(resolved.contractMismatchAt).toBeNull();

      // Durable, not merely returned: read back from storage independently.
      const stored = value.harness.planReviewGates.findByTask(task.id);
      expect(stored?.contractFingerprint).toBe(FINGERPRINT);
      expect(stored?.contractMismatchAt).toBeNull();
    });

    it('stops safely, without applying the round, when the contract drifts between open and review_plan', async () => {
      const value = setup();
      const { task } = await ready(value);
      const drifted = 'e'.repeat(64);
      value.reviewer.round = { ...value.reviewer.round, contractFingerprint: drifted };

      await expect(value.service.review(task.id)).rejects.toThrow(/contract changed partway/i);

      // Left exactly where the dispatch got to — `reviewing`, not
      // `awaiting_resolve` — and the ORIGINAL fingerprint `open` bound, never
      // silently replaced by review_plan's differing one.
      const gate = value.harness.planReviewGates.findByTask(task.id)!;
      expect(gate.status).toBe('reviewing');
      expect(gate.contractFingerprint).toBe(FINGERPRINT);
      expect(gate.contractMismatchAt).not.toBeNull();
      expect(gate.verdict).toBeNull();
      expect(gate.findingsJson).toBeNull();
    });

    it('stops safely, without applying a resolution, when the contract drifts between review_plan and resolve', async () => {
      const value = setup();
      const { task } = await ready(value);
      value.reviewer.round = { ...value.reviewer.round, findings: [finding('Round finding')] };
      await value.service.review(task.id);

      const drifted = 'e'.repeat(64);
      value.reviewer.resolution = { ...value.reviewer.resolution, contractFingerprint: drifted };

      await expect(
        resolveCurrent(value, task.id, [{ finding: 0, action: 'accept', reason: 'Fine as scoped.' }])
      ).rejects.toThrow(/contract changed partway/i);

      const gate = value.harness.planReviewGates.findByTask(task.id)!;
      // `resolving`, not settled to any terminal stage: the decisions were
      // recorded on the way in, but the outcome they would have produced was
      // never applied, and the fingerprint review_plan bound is untouched.
      expect(gate.status).toBe('resolving');
      expect(gate.contractFingerprint).toBe(FINGERPRINT);
      expect(gate.contractMismatchAt).not.toBeNull();
      expect(gate.decisionsJson).not.toBeNull();
    });

    it('reconciliation preserves the historical fingerprint and reports a mismatch, without adopting the provider’s current reading', async () => {
      const value = setup();
      const { task } = await ready(value);
      value.reviewer.reviewError = new Error('answer lost');
      await expect(value.service.review(task.id)).rejects.toThrow(/lost/);
      value.reviewer.reviewError = null;

      const stranded = value.harness.planReviewGates.findByTask(task.id)!;
      expect(stranded.status).toBe('reviewing');
      expect(stranded.contractFingerprint).toBe(FINGERPRINT);

      // The provider is read again later, and its CURRENT contract has moved
      // on — modelled here as a still-running round, so nothing else about the
      // reading is in question.
      const drifted = 'e'.repeat(64);
      value.reviewer.state = {
        ...value.reviewer.state,
        contractFingerprint: drifted,
        planRounds: planRounds({ total: 1, running: 1 })
      };

      const reconciled = await value.service.reconcile(task.id);

      expect(reconciled.status).toBe('reviewing');
      // The historical evidence survives untouched...
      expect(reconciled.contractFingerprint).toBe(FINGERPRINT);
      // ...and the mismatch is made explicit rather than silently absorbed.
      expect(reconciled.contractMismatchAt).not.toBeNull();
      expect(reconciled.lastError).toMatch(/still executing/i);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Codex-assisted automatic finding triage                                    */
  /* ------------------------------------------------------------------------ */

  describe('automatic finding triage', () => {
    async function awaitingTwoFindings(value: ReturnType<typeof setup>) {
      const { task } = await ready(value);
      value.reviewer.round = {
        ...value.reviewer.round,
        gatingCount: 2,
        threshold: 0,
        findings: [finding('First finding'), finding('Second finding')]
      };
      const gate = await value.service.review(task.id);
      expect(gate.status).toBe('awaiting_resolve');
      return { task, gate };
    }

    it('persists independent recommendations for every requested finding, without ever resolving', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'Matches acceptance criterion 1.', evidenceRef: 'criterion 1', confidence: 'high' },
        { findingRef: 1, recommendation: 'needs_user', reason: 'Architecture choice.', evidenceRef: 'finding 1 body', confidence: 'low' }
      ]);

      const result = await value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });

      expect(value.codex.triageCalls).toHaveLength(1);
      expect(value.codex.triageCalls[0]?.findings).toHaveLength(2);
      expect(value.reviewer.resolveCalls).toHaveLength(0);

      // This write itself bumps the gate's revision, exactly like any other.
      expect(result.revision).toBe(gate.revision + 1);
      // triageForFindings names WHAT was analyzed (the findings themselves),
      // not a revision number, so it stays valid across unrelated writes.
      expect(result.triageForFindings).toBe(result.findingsJson);
      const parsed = JSON.parse(result.triageJson!);
      expect(parsed.recommendations).toEqual([
        { finding: 0, recommendation: 'accept', reason: 'Matches acceptance criterion 1.', evidenceRef: 'criterion 1', confidence: 'high' },
        { finding: 1, recommendation: 'needs_user', reason: 'Architecture choice.', evidenceRef: 'finding 1 body', confidence: 'low' }
      ]);

      // Survives a fresh read — a remount/restart reads the same durable row.
      const reread = value.harness.planReviewGates.findByTask(task.id)!;
      expect(reread.triageJson).toBe(result.triageJson);
      expect(reread.triageForFindings).toBe(result.triageForFindings);
    });

    it('triages a plan gate by numeric finding indexes: declares the index kind and returns the updated gate at once', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'reject', reason: 'r', evidenceRef: 'e', confidence: 'medium' }
      ]);

      const result = await value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });

      const request = value.codex.triageCalls[0]!;
      expect(request.refKind).toBe('index');
      expect(request.findings.map((entry) => entry.ref)).toEqual([0, 1]);
      // The returned gate already carries the persisted result.
      expect(result.triageJson).not.toBeNull();
      expect(JSON.parse(result.triageJson!).recommendations.map((entry: { finding: number }) => entry.finding)).toEqual([0, 1]);
      expect(value.harness.planReviewGates.findByTask(task.id)!.triageJson).toBe(result.triageJson);
    });

    it('rejects the string references a provider once returned for a plan gate, persisting no part of them', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        // A plan gate is named by numbers; strings are the representation that lost a real result.
        { findingRef: '0', recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: '1', recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toMatchObject({ code: 'PARSE_FAILED' });

      const current = value.harness.planReviewGates.findByTask(task.id)!;
      expect(current.triageJson).toBeNull();
      expect(current.triageForFindings).toBeNull();
      expect(current.revision).toBe(gate.revision);
    });

    it('persists nothing when the provider call fails, and releases the claim so an explicit retry can succeed', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageError = new AgentRelayError('TIMEOUT', 'The Codex process timeout expired.');

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      const afterFailure = value.harness.planReviewGates.findByTask(task.id)!;
      expect(afterFailure.triageJson).toBeNull();
      expect(afterFailure.revision).toBe(gate.revision);

      value.codex.triageError = null;
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);
      const retried = await value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });
      expect(retried.triageJson).not.toBeNull();
    });

    it('keeps a stored recommendation current after an unrelated write bumps the gate revision', async () => {
      // A revision-based staleness check would break this: ANY later write to
      // the row (including one wholly unrelated to the findings) bumps
      // `revision`, so a check comparing against `revision` would make even a
      // just-persisted result look stale the moment something else touched
      // the gate. `triageForFindings` — the actual content analyzed — must
      // not be affected by that.
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);
      const afterTriage = await value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });

      // An unrelated field write, bumping revision without touching findings.
      const afterUnrelatedWrite = value.harness.planReviewGates.update(afterTriage.id, {
        lastError: 'unrelated diagnostic note'
      });
      expect(afterUnrelatedWrite.revision).toBe(afterTriage.revision + 1);
      expect(afterUnrelatedWrite.triageJson).toBe(afterTriage.triageJson);
      expect(afterUnrelatedWrite.triageForFindings).toBe(afterUnrelatedWrite.findingsJson);
      expect(afterUnrelatedWrite.findingsJson).toBe(afterTriage.findingsJson);
    });

    it('analyzes only the requested subset when findingIndexes is given', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 1, recommendation: 'reject', reason: 'Already satisfied.', evidenceRef: 'finding 1', confidence: 'medium' }
      ]);

      await value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision, findingIndexes: [1] });

      expect(value.codex.triageCalls[0]?.findings).toHaveLength(1);
      expect(value.codex.triageCalls[0]?.findings[0]?.ref).toBe(1);
    });

    it('refuses a stale gate/revision before ever calling Codex', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision + 1 })
      ).rejects.toThrow(/no longer the current one/i);
      await expect(
        value.service.triage(task.id, { gateId: 'wrong-gate', expectedRevision: gate.revision })
      ).rejects.toThrow(/no longer the current one/i);
      expect(value.codex.triageCalls).toHaveLength(0);
    });

    it('discards the analysis, rather than applying it, when the gate changed while Codex was in flight', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      const inFlight = deferred();
      value.codex.triageGate = inFlight.promise;
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);

      const triaging = value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });
      await Promise.resolve();

      // The round is resolved by another window/process (its own claims, same
      // database) while the analysis is still running — the in-flight triage
      // already holds this service's own claim, so the change must come
      // through an independent one.
      await value.unguarded().resolve(task.id, {
        gateId: gate.id,
        expectedRevision: gate.revision,
        decisions: [
          { finding: 0, action: 'accept', reason: '' },
          { finding: 1, action: 'accept', reason: '' }
        ],
        allowAccepted: true
      });

      inFlight.resolve(undefined);
      await expect(triaging).rejects.toThrow(/changed while the analysis was running|no longer the current one/i);

      const current = value.harness.planReviewGates.findByTask(task.id)!;
      expect(current.triageJson).toBeNull();
    });

    it('fails closed on a partial response missing a requested finding', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
        // finding 1 is missing.
      ]);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toThrow(/every requested finding/i);
      expect(value.harness.planReviewGates.findByTask(task.id)!.triageJson).toBeNull();
    });

    it('fails closed on a recommendation for a finding that was not requested', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 5, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision, findingIndexes: [0] })
      ).rejects.toThrow(/not requested/i);
    });

    it('fails closed on a duplicated recommendation for the same finding', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 0, recommendation: 'reject', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toThrow(/more than one recommendation/i);
    });

    it('fails closed on a malformed recommendation shape', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      value.codex.triageQueue.push([
        // @ts-expect-error deliberately malformed for this test
        { findingRef: 0, recommendation: 'maybe', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);

      await expect(
        value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toThrow(/do not match the expected shape/i);
    });

    it('refuses while a review of the same task is in flight, and vice versa', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      const inFlight = deferred();
      value.codex.triageGate = inFlight.promise;
      value.codex.triageQueue.push([
        { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
        { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      ]);
      const triaging = value.service.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });
      await Promise.resolve();

      await expect(value.service.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
      expect(value.reviewer.statusCalls).toHaveLength(0);

      inFlight.resolve(undefined);
      await triaging;
    });

    it('refuses when Codex is not configured for this build', async () => {
      const value = setup();
      const { task, gate } = await awaitingTwoFindings(value);
      const unconfigured = new PlanReviewGateService({
        tasks: value.harness.tasks,
        projects: value.harness.projects,
        ruleEvidence: value.harness.taskRuleEvidence,
        gates: value.harness.planReviewGates,
        reviewer: value.reviewer,
        clock: value.harness.clock,
        ids: value.harness.ids,
        claims: new PlanReviewClaims(),
        operations: value.harness.operations
      });

      await expect(
        unconfigured.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision })
      ).rejects.toMatchObject({ code: 'TOOL_MISSING' });
    });
  });
});
