import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../helpers/fake-plan-reviewer';
import {
  acceptedAndResolved,
  currentGate,
  decide,
  disposeScenariosAfterEach,
  planFindingsSha256,
  proceed,
  ready,
  resolveRequest,
  revise,
  roundWith,
  scenario,
  specOf,
  specificationIdentity,
  statusOf,
  until,
  type Scenario
} from '../helpers/plan-correction-scenario';

disposeScenariosAfterEach();

const rec = (findingRef: number, recommendation: 'accept' | 'reject' | 'needs_user') => ({
  findingRef,
  recommendation,
  reason: `Reason ${findingRef}.`,
  evidenceRef: `evidence ${findingRef}`,
  confidence: 'high' as const
});

/** Turns a rejection into a value, so a still-running operation never becomes an unhandled rejection. */
const outcomeOf = <T>(promise: Promise<T>): Promise<T | Error> =>
  promise.then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );

/** Neither the claim nor the registration may outlive an operation, whatever ended it. */
function expectReleased(value: Scenario, taskId: string): void {
  expect(value.harness.operations.isActive(taskId)).toBe(false);
  expect(value.claims.heldBy(taskId)).toBeNull();
}

/** The specification history holds only what existed before Stop: the reviewed text, recorded once. */
function expectNothingWritten(value: Scenario, taskId: string, original: string): void {
  expect(specOf(value, taskId)).toBe(original);
  expect(value.corrections.listVersions(taskId).map((entry) => entry.origin)).toEqual(['generated']);
  expect(value.corrections.listByTask(taskId).every((entry) => entry.status !== 'completed')).toBe(true);
  expect(value.harness.planReviewGates.listByTask(taskId)).toHaveLength(1);
  expect(value.reviewer.reviewCalls).toHaveLength(1);
}

describe('Stop task during the plan-correction loop', () => {
  it('stops a revision Codex is still computing: the signal is aborted, the task is CANCELLED, nothing is written and nothing is reviewed', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const original = specOf(value, task.id);
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = outcomeOf(value.loop.resolveAndRevise(task.id, resolveRequest(value, task.id, decide([0, 'accept', 'Yes.']))));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    expect(value.harness.operations.isActive(task.id)).toBe(true);

    // The very backend path `workflow:stop` calls.
    const stopped = value.harness.orchestrator.stop(task.id);
    expect(stopped.status).toBe('CANCELLED');
    expect(value.harness.codex.revisionContexts[0]!.signal.aborted).toBe(true);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expectNothingWritten(value, task.id, original);
    // Honest audit: the row says it was stopped and that Codex's read-only revision was discarded.
    expect(value.corrections.listByTask(task.id)[0]).toMatchObject({ status: 'failed' });
    expect(value.corrections.listByTask(task.id)[0]?.lastError).toMatch(/Stopped while Codex was revising/);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('does the same through "Continue correction"', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const original = specOf(value, task.id);
    expect(value.loop.detail(task.id).nextStep).toBe('revise');
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    value.harness.orchestrator.stop(task.id);
    expect(value.harness.codex.revisionContexts[0]!.signal.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expectNothingWritten(value, task.id, original);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('stops automatic triage: findings not yet dispatched are never sent, and results arriving after the stop are not applied', async () => {
    const value = scenario();
    const task = await ready(value);
    // More findings than the loop analyzes at once (three), so some are still waiting.
    value.reviewer.roundQueue = [roundWith(value, ['A', 'B', 'C', 'D', 'E'])];
    await value.gateService.review(task.id);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(1, 'accept')], [rec(2, 'accept')]);

    const running = outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));
    await until(() => value.harness.codex.triageCalls.length === 3, 'three analyses to be in flight');
    value.harness.orchestrator.stop(task.id);
    expect(value.harness.codex.triageContexts.every((context) => context.signal.aborted)).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    // The two findings that were still waiting were never dispatched.
    expect(value.harness.codex.triageCalls).toHaveLength(3);
    // The three answers that arrived after the stop were dropped: no decision, no stop, no triage stored.
    const gate = currentGate(value, task.id);
    expect(gate.autoDecisionsJson).toBeNull();
    expect(gate.triageJson).toBeNull();
    // And nothing further went to Coai.
    expect(value.reviewer.resolveCalls).toHaveLength(0);
    expect(gate.status).toBe('awaiting_resolve');
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('stops a Coai resolve: the signal reaches the provider, the outcome stays unknown and reconcile-required, and no later step starts', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const release = deferred();
    value.reviewer.resolveGate = release.promise;

    const running = outcomeOf(value.loop.resolveAndRevise(task.id, resolveRequest(value, task.id, decide([0, 'accept', 'Yes.']))));
    await until(() => value.reviewer.resolveCalls.length === 1, 'the resolve to reach Coai');
    value.harness.orchestrator.stop(task.id);
    expect(value.reviewer.signals.resolve[0]!.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    // The call may well have been applied: it is neither recorded as settled nor called a failure.
    const gate = currentGate(value, task.id);
    expect(gate.status).toBe('resolving');
    expect(gate.lastError).toMatch(/outcome is unknown/);
    expect(value.loop.detail(task.id).nextStep).toBe('reconcile');
    // No later step: no Codex revision, no second review, no correction row.
    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.corrections.listByTask(task.id)).toHaveLength(0);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('stops a Coai review of the revised text: what committed before the stop stays, the round is unknown and reconcile-required, and nothing else starts', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value), proceed(value)];
    await value.gateService.review(task.id);
    const original = specOf(value, task.id);
    const release = deferred();
    value.reviewer.reviewGate = release.promise;

    const running = outcomeOf(value.loop.resolveAndRevise(task.id, resolveRequest(value, task.id, decide([0, 'accept', 'Yes.']))));
    await until(() => value.reviewer.reviewCalls.length === 2, 'the fresh review to reach Coai');
    value.harness.orchestrator.stop(task.id);
    expect(value.reviewer.signals.review[1]!.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    // The revision committed atomically BEFORE the stop and is preserved as the fact it is.
    expect(specOf(value, task.id)).not.toBe(original);
    expect(value.corrections.listByTask(task.id)[0]).toMatchObject({ status: 'completed', toVersion: 2 });
    expect(value.corrections.listVersions(task.id).map((entry) => entry.origin)).toEqual(['generated', 'plan_correction']);
    // The round that was in flight stays as unknown as it is; its findings were not applied.
    const newest = value.harness.planReviewGates.findByTask(task.id)!;
    expect(newest.specificationSha256).toBe(specificationIdentity(specOf(value, task.id)).sha256);
    expect(newest.status).toBe('reviewing');
    expect(newest.findingsJson).toBeNull();
    expect(newest.lastError).toMatch(/outcome is unknown/);
    expect(value.loop.detail(task.id).nextStep).toBe('reconcile');
    expect(value.reviewer.reviewCalls).toHaveLength(2);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('refuses the specification swap when the task is stopped after Codex returned and before the transaction: nothing is written', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const original = specOf(value, task.id);
    // Stop lands in the sliver between the last check and the transaction. Only the
    // status check inside the write itself can refuse this: the specification text still matches.
    const complete = value.corrections.complete.bind(value.corrections);
    vi.spyOn(value.corrections, 'complete').mockImplementation((input) => {
      value.harness.tasks.update(task.id, { status: 'CANCELLED' });
      return complete(input);
    });

    const error = await outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));

    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(value.harness.codex.revisionCalls).toHaveLength(1);
    expectNothingWritten(value, task.id, original);
    // Atomic and honest: one failed row that says why, no half-committed version or swap.
    const [correction] = value.corrections.listByTask(task.id);
    expect(correction).toMatchObject({ status: 'failed', toVersion: null, toSpecificationSha256: null, addressedJson: null });
    expect(correction?.lastError).toMatch(/task was stopped/);
    expectReleased(value, task.id);
  });

  it('keeps a revision that committed just before Stop consistent, cancels the task, and starts no further review', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const original = specOf(value, task.id);
    // Stop wins the very next instruction after the atomic commit.
    const complete = value.corrections.complete.bind(value.corrections);
    vi.spyOn(value.corrections, 'complete').mockImplementation((input) => {
      const done = complete(input);
      value.harness.orchestrator.stop(task.id);
      return done;
    });

    const error = await outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));

    expect(error).toMatchObject({ code: 'CANCELLED' });
    // The completed atomic pair is intact and consistent: text, version and closed correction agree.
    const revised = specOf(value, task.id);
    expect(revised).not.toBe(original);
    const versions = value.corrections.listVersions(task.id);
    expect(versions.map((entry) => [entry.version, entry.origin])).toEqual([
      [1, 'generated'],
      [2, 'plan_correction']
    ]);
    expect(versions[1]?.specificationJson).toBe(revised);
    expect(value.corrections.listByTask(task.id)[0]).toMatchObject({
      status: 'completed',
      toVersion: 2,
      toSpecificationSha256: specificationIdentity(revised).sha256
    });
    // But nothing follows it: no gate for the revised text, no Coai round.
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expect(value.harness.planReviewGates.listByTask(task.id)).toHaveLength(1);
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.reviewer.openCalls).toHaveLength(1);
    expectReleased(value, task.id);
  });

  it("links the caller's own signal to the operation, so aborting it stops the revision too", async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const original = specOf(value, task.id);
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;
    const caller = new AbortController();

    const running = outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }, caller.signal));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    caller.abort();
    // Codex got the OPERATION's signal (never a fresh one), and the caller's abort reached it.
    expect(value.harness.codex.revisionContexts[0]!.signal.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(specOf(value, task.id)).toBe(original);
    expect(value.corrections.listVersions(task.id).map((entry) => entry.origin)).toEqual(['generated']);
    expectReleased(value, task.id);
  });

  it('gives Codex, Coai resolve and Coai review the SAME effective signal as the operation', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change']), roundWith(value, [], 'proceed')];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);

    await value.loop.resolveAndRevise(task.id, resolveRequest(value, task.id, decide([0, 'accept', 'Yes.'])));

    const resolveSignal = value.reviewer.signals.resolve[0];
    const codexSignal = value.harness.codex.revisionContexts[0]!.signal;
    const reviewSignal = value.reviewer.signals.review[1];
    expect(resolveSignal).toBeDefined();
    expect(resolveSignal).toBe(codexSignal);
    expect(reviewSignal).toBe(codexSignal);
    // The loop's signal is its own, not one that could never be aborted.
    expect(codexSignal.aborted).toBe(false);
  });
});

describe('a stop is reported as a stop whatever the provider threw for it', () => {
  it('turns a generic Codex failure raised because the process was killed into CANCELLED, with an honest audit row', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const original = specOf(value, task.id);
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;
    // What an adapter might throw when the stop kills its process: not a typed CANCELLED.
    value.harness.codex.revisionError = new Error('Codex exited with code 1.');

    const running = outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    value.harness.orchestrator.stop(task.id);
    release.resolve(undefined);

    const error = await running;
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expectNothingWritten(value, task.id, original);
    const [correction] = value.corrections.listByTask(task.id);
    expect(correction?.status).toBe('failed');
    // Not the provider's opaque exit message: the row says it was stopped and discarded.
    expect(correction?.lastError).toMatch(/Stopped while Codex was revising/);
    expect(correction?.lastError).not.toMatch(/exited with code/);
    expectReleased(value, task.id);
  });

  it('turns a generic Coai failure raised because the call was killed into CANCELLED, and keeps the outcome-unknown note with the provider’s words', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['Needs a change'])];
    value.reviewer.resolutionQueue = [revise(value)];
    await value.gateService.review(task.id);
    const release = deferred();
    value.reviewer.resolveGate = release.promise;
    value.reviewer.resolveError = new Error('socket hang up');

    const running = outcomeOf(value.loop.resolveAndRevise(task.id, resolveRequest(value, task.id, decide([0, 'accept', 'Yes.']))));
    await until(() => value.reviewer.resolveCalls.length === 1, 'the resolve to reach Coai');
    value.harness.orchestrator.stop(task.id);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const gate = currentGate(value, task.id);
    // Still an unknown outcome to reconcile — never called a failure — and it says so first.
    expect(gate.status).toBe('resolving');
    expect(gate.lastError).toMatch(/^The task was stopped while an external call was in flight, so its outcome is unknown/);
    expect(gate.lastError).toContain('socket hang up');
    expect(value.loop.detail(task.id).nextStep).toBe('reconcile');
    expectReleased(value, task.id);
  });

  it('does the same for a review started directly, and for a single finding’s Auto decide', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['A'])];
    const release = deferred();
    value.reviewer.reviewGate = release.promise;
    value.reviewer.reviewError = new Error('connection reset');

    const review = outcomeOf(value.gateService.review(task.id));
    await until(() => value.reviewer.reviewCalls.length === 1, 'the review to reach Coai');
    value.harness.orchestrator.stop(task.id);
    release.resolve(undefined);

    expect(await review).toMatchObject({ code: 'CANCELLED' });
    expect(currentGate(value, task.id).lastError).toMatch(/outcome is unknown/);
    expectReleased(value, task.id);
  });

  it('turns a generic triage failure raised because the analysis was killed into CANCELLED', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['A', 'B'])];
    await value.gateService.review(task.id);
    const gate = currentGate(value, task.id);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageError = new Error('Codex exited with code 1.');

    const running = outcomeOf(
      value.gateService.autoDecide(task.id, { gateId: gate.id, findingsSha256: planFindingsSha256(gate.findingsJson as string), findingIndex: 0 })
    );
    await until(() => value.harness.codex.triageCalls.length === 1, 'the analysis to reach Codex');
    value.harness.orchestrator.stop(task.id);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(currentGate(value, task.id).autoDecisionsJson).toBeNull();
    expectReleased(value, task.id);
  });

  it('still reports an ordinary failure, with no stop, as the failure it is', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    value.harness.codex.revisionError = new Error('Codex exited with code 1.');

    await expect(value.loop.continueCorrection(task.id, { autoContinue: false })).rejects.toThrow(/exited with code 1/);

    expect(value.corrections.listByTask(task.id)[0]?.lastError).toMatch(/exited with code 1/);
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');
    expectReleased(value, task.id);
  });
});

describe('the cancellation register is process-wide', () => {
  it('lets the singleton orchestrator stop a loop that another IPC call started through its own service instances', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const otherCall = value.build();
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = outcomeOf(otherCall.loop.continueCorrection(task.id, { autoContinue: true }));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    // A different IPC call: a different service graph, the same singleton orchestrator.
    value.harness.orchestrator.stop(task.id);

    expect(value.harness.codex.revisionContexts[0]!.signal.aborted).toBe(true);
    release.resolve(undefined);
    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expectReleased(value, task.id);
  });

  it('refuses a second conflicting operation on the same task, from any service instance, while one is active', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const second = value.build();
    const release = deferred();
    value.harness.codex.revisionGate = release.promise;

    const running = outcomeOf(value.loop.continueCorrection(task.id, { autoContinue: true }));
    await until(() => value.harness.codex.revisionCalls.length === 1, 'the revision to reach Codex');
    const gate = currentGate(value, task.id);

    await expect(second.loop.continueCorrection(task.id, { autoContinue: true })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(
      second.loop.resolveAndRevise(task.id, { gateId: gate.id, expectedRevision: gate.revision, decisions: [], autoContinue: false })
    ).rejects.toMatchObject({ code: 'BUSY' });
    await expect(second.gateService.review(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(second.gateService.reconcile(task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(
      second.gateService.autoDecide(task.id, { gateId: gate.id, findingsSha256: 'a'.repeat(64), findingIndex: 0 })
    ).rejects.toMatchObject({ code: 'BUSY' });
    // An agent run is refused too, by the orchestrator, for the same reason.
    await expect(value.harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(/already has a review operation running/i);
    expect(value.harness.codex.revisionCalls).toHaveLength(1);

    release.resolve(undefined);
    await running;
    expectReleased(value, task.id);
    // Once it has ended the task is free again.
    await expect(second.loop.continueCorrection(task.id, { autoContinue: false })).resolves.toBeDefined();
  });
});

describe('the operation is always released', () => {
  it('after success', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);

    const outcome = await value.loop.continueCorrection(task.id, { autoContinue: false });

    expect(outcome.correctionsRun).toBe(1);
    expectReleased(value, task.id);
  });

  it('after an ordinary error', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    value.harness.codex.revisionError = new Error('Codex crashed.');

    await expect(value.loop.continueCorrection(task.id, { autoContinue: false })).rejects.toThrow(/crashed/);

    expectReleased(value, task.id);
  });

  it('after a validation failure, and after a refused stale request', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    // An unchanged specification is refused as "the accepted findings were not addressed".
    value.harness.codex.revisionQueue.push(specificationIdentity(specOf(value, task.id)).specification);
    await expect(value.loop.continueCorrection(task.id, { autoContinue: false })).rejects.toThrow(/unchanged/i);
    expectReleased(value, task.id);

    const gate = currentGate(value, task.id);
    await expect(
      value.loop.resolveAndRevise(task.id, { gateId: gate.id, expectedRevision: gate.revision + 5, decisions: [], autoContinue: false })
    ).rejects.toBeDefined();
    expectReleased(value, task.id);
  });

  it('after a cancellation raised before anything started', async () => {
    const value = scenario();
    const task = await acceptedAndResolved(value);
    const caller = new AbortController();
    caller.abort();

    await expect(value.loop.continueCorrection(task.id, { autoContinue: false }, caller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    });

    expect(value.harness.codex.revisionCalls).toHaveLength(0);
    expect(value.corrections.listByTask(task.id)).toHaveLength(0);
    expectReleased(value, task.id);
  });
});

describe('Stop task during a single plan-review operation', () => {
  it('stops one finding’s Auto decide: the result is dropped and no decision or stop is recorded', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['A', 'B'])];
    await value.gateService.review(task.id);
    const gate = currentGate(value, task.id);
    const release = deferred();
    value.harness.codex.triageGate = release.promise;
    value.harness.codex.triageQueue.push([rec(0, 'accept')]);

    const running = outcomeOf(
      value.gateService.autoDecide(task.id, { gateId: gate.id, findingsSha256: planFindingsSha256(gate.findingsJson as string), findingIndex: 0 })
    );
    await until(() => value.harness.codex.triageCalls.length === 1, 'the analysis to reach Codex');
    value.harness.orchestrator.stop(task.id);
    expect(value.harness.codex.triageContexts[0]!.signal.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const after = currentGate(value, task.id);
    expect(after.autoDecisionsJson).toBeNull();
    expect(after.triageJson).toBeNull();
    expect(value.claims.analyzingFindings(task.id)).toEqual([]);
    expectReleased(value, task.id);
  });

  it('stops a Coai review started directly: the round stays `reviewing` (unknown) and its findings are not applied', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['A'])];
    const release = deferred();
    value.reviewer.reviewGate = release.promise;

    const running = outcomeOf(value.gateService.review(task.id));
    await until(() => value.reviewer.reviewCalls.length === 1, 'the review to reach Coai');
    value.harness.orchestrator.stop(task.id);
    expect(value.reviewer.signals.review[0]!.aborted).toBe(true);
    release.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const gate = currentGate(value, task.id);
    expect(gate.status).toBe('reviewing');
    expect(gate.findingsJson).toBeNull();
    expect(gate.lastError).toMatch(/outcome is unknown/);
    expectReleased(value, task.id);
  });

  it('sends nothing to Coai for a task that was already stopped', async () => {
    const value = scenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundWith(value, ['A'])];
    const caller = new AbortController();
    caller.abort();

    await expect(value.gateService.review(task.id, caller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(value.reviewer.openCalls).toHaveLength(0);
    // No `opening` phase was written for a call that never went out.
    expect(value.harness.planReviewGates.findByTask(task.id)?.status ?? 'prepared').toBe('prepared');
    expectReleased(value, task.id);
  });
});
