import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import type {
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject
} from '../../src/main/ports';
import type { PlanReviewDecision, PlanReviewGate } from '../../src/shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../src/shared/domain/rule-evidence';
import { makeSpecification } from '../helpers/fakes';
import { createHarness, type Harness } from '../helpers/harness';

interface Deferred {
  readonly promise: Promise<unknown>;
  resolve(value: unknown): void;
}

/** A promise a test resolves by hand, so it decides when an answer arrives. */
function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The provider's PlanReview round tally, defaulting to "nothing has run". */
function planRounds(
  counts: Partial<ExternalPlanReviewStatus['planRounds']> = {}
): ExternalPlanReviewStatus['planRounds'] {
  return { total: 0, running: 0, done: 0, interrupted: 0, ...counts };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshot(content = 'Run the repository verification command.\n'): RuleEvidenceSnapshot {
  const contentBytes = Buffer.byteLength(content);
  const sources = [{ id: 'project', kind: 'project' as const, revision: 'a'.repeat(40), clean: true }];
  const files = [{
    sourceId: 'project',
    path: 'AGENTS.md',
    bytes: contentBytes,
    sha256: sha256(content),
    content
  }];
  const omitted: RuleEvidenceSnapshot['omitted'] = [];
  return {
    version: 1,
    sources,
    files,
    omitted,
    totalBytes: contentBytes,
    sha256: sha256(JSON.stringify({
      version: 1,
      sources,
      files: files.map(({ sourceId, path, bytes, sha256: fileHash }) => ({
        sourceId, path, bytes, sha256: fileHash
      })),
      omitted
    })),
    capturedAt: '2026-09-06T00:00:00.000Z'
  };
}

class FakePlanReviewer implements ExternalPlanReviewer {
  readonly openCalls: ExternalPlanReviewSubject[] = [];
  readonly reviewCalls: { subject: ExternalPlanReviewSubject; planText: string }[] = [];
  readonly resolveCalls: { subject: ExternalPlanReviewSubject; decisions: readonly PlanReviewDecision[] }[] = [];
  readonly statusCalls: ExternalPlanReviewSubject[] = [];
  statusError: Error | null = null;
  onReview: (() => void) | null = null;
  onResolve: (() => void) | null = null;
  openError: Error | null = null;
  reviewError: Error | null = null;
  resolveError: Error | null = null;
  session: ExternalPlanReviewSession = {
    sessionId: 'session-1',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    serverName: 'coai-mcp',
    serverVersion: '1.2.3'
  };
  round: ExternalPlanReviewRound = {
    verdict: 'proceed',
    gatingCount: 0,
    threshold: 2,
    reviewers: 'all 2 reviewers answered',
    findings: [],
    instruction: 'resolve every finding',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3'
  };
  resolution: ExternalPlanReviewResolution = {
    stage: 'CodeReview',
    awaitingResolve: false,
    recordedDecisions: 0,
    instruction: 'continue',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3'
  };

  state: ExternalPlanReviewStatus = {
    sessionId: 'session-1',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    planRounds: planRounds(),
    serverName: 'coai-mcp',
    serverVersion: '1.2.3'
  };

  /**
   * Hold a specific `status` call open, by its zero-based index.
   *
   * The point of the delay is not slowness but ordering: it lets a test decide
   * when each answer comes back, and therefore construct the interleaving where
   * a reading is computed from a world that changes before it is written.
   */
  onStatusCall: ((index: number) => Promise<unknown> | void) | null = null;
  /** Held open so a round can still be executing while something else runs. */
  reviewGate: Promise<unknown> | null = null;
  /** The same, for a resolution that has been dispatched and not yet answered. */
  resolveGate: Promise<unknown> | null = null;

  async status(subject: ExternalPlanReviewSubject): Promise<ExternalPlanReviewStatus> {
    const index = this.statusCalls.length;
    this.statusCalls.push(subject);
    // Captured before the wait, so a delayed answer describes the session as it
    // was when it was read — which is exactly what a stale answer is.
    const answer = this.state;
    const wait = this.onStatusCall?.(index);
    if (wait) await wait;
    if (this.statusError) throw this.statusError;
    return answer;
  }

  async open(subject: ExternalPlanReviewSubject): Promise<ExternalPlanReviewSession> {
    this.openCalls.push(subject);
    if (this.openError) throw this.openError;
    return this.session;
  }

  async reviewPlan(subject: ExternalPlanReviewSubject, planText: string): Promise<ExternalPlanReviewRound> {
    this.reviewCalls.push({ subject, planText });
    this.onReview?.();
    if (this.reviewGate) await this.reviewGate;
    if (this.reviewError) throw this.reviewError;
    return this.round;
  }

  async resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[]
  ): Promise<ExternalPlanReviewResolution> {
    this.resolveCalls.push({ subject, decisions });
    this.onResolve?.();
    if (this.resolveGate) await this.resolveGate;
    if (this.resolveError) throw this.resolveError;
    return this.resolution;
  }
}

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
      clock: harness.clock,
      ids: harness.ids,
      claims
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
      clock: harness.clock,
      ids: harness.ids,
      claims: new PlanReviewClaims()
    });
  return { harness, reviewer, service, claims, build, unguarded };
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

    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/every finding/i);
    await expect(
      value.service.resolve(task.id, [{ finding: 0, action: 'reject', reason: '' }])
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
      value.service.resolve(task.id, [{
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

    const gate = await value.service.resolve(task.id, []);
    expect(gate.status).toBe('proceeded');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).not.toThrow();
  });

  it('keeps a revise resolution gated for another plan round', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolution = { ...value.reviewer.resolution, stage: 'PlanReview' };

    await expect(value.service.resolve(task.id, [])).resolves.toMatchObject({
      status: 'changes_requested'
    });
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('invalidates a proceeded gate when the specification identity changes', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    await value.service.resolve(task.id, []);
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
    value.reviewer.reviewError = new Error('connection refused');

    await expect(value.service.review(task.id)).rejects.toThrow(/refused/);
    await expect(value.service.review(task.id)).rejects.toThrow(/Reconcile the external state/i);

    // The provider's own record shows no plan round ran, so dispatching one now
    // repeats nothing — and only that proof reopens the gate.
    value.reviewer.reviewError = null;
    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds(), awaitingResolve: false };
    expect(await value.service.reconcile(task.id)).toMatchObject({ status: 'prepared', lastError: null });

    await value.service.review(task.id);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
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

    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);
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
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);

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
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);

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
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);

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

    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds(), awaitingResolve: false };
    expect(await value.service.reconcile(task.id)).toMatchObject({ status: 'prepared' });
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

  it('applies nothing when the provider answers for another session', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);
    const before = value.harness.planReviewGates.findByTask(task.id);

    value.reviewer.state = {
      ...value.reviewer.state,
      sessionId: 'a-different-session',
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: planRounds({ total: 1, done: 1 })
    };
    const gate = await value.service.reconcile(task.id);

    expect(gate.status).toBe('resolving');
    expect(gate.sessionId).toBe(before?.sessionId);
    expect(gate.lastError).toMatch(/different session/i);
  });

  it('refuses to open approval on a contradictory provider state', async () => {
    const value = setup();
    const { task } = await ready(value);
    await value.service.review(task.id);
    value.reviewer.resolveError = new Error('resolve answer lost');
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);

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
    const resolving = value.service.resolve(task.id, []);
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
    value.reviewer.state = { ...value.reviewer.state, planRounds: planRounds() };
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

    // The late answer would have said `prepared`. It does not get to say it.
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
    await expect(value.service.resolve(task.id, [])).rejects.toThrow(/lost/);

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

    const resolved = await value.service.resolve(task.id, []);

    expect(resolved.status).toBe('proceeded');
    expect(resolved.reconciledAt).toBeNull();
    expect(resolved.decisionsJson).toBe('[]');
    expect(value.harness.planReviewGates.findByTask(task.id)?.reconciledAt).toBeNull();
  });

  it('uses the bound evidence again for implementation and final Codex review', async () => {
    const value = setup();
    const { task, rules } = await ready(value);
    await value.service.review(task.id);
    await value.service.resolve(task.id, []);
    value.harness.orchestrator.approveSpecification(task.id);
    await value.harness.orchestrator.sendToClaude(task.id);
    await value.harness.orchestrator.reviewWithCodex(task.id);

    expect(value.harness.claude.calls[0]?.prompt).toContain(rules.sha256);
    expect(value.harness.codex.reviewCalls[0]?.ruleEvidence).toContain(rules.sha256);
  });
});
