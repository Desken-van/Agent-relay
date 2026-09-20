/**
 * Stop task, while a code review, a reconciliation, an analysis or an Auto decide
 * is running.
 *
 * Every test drives the very backend path `workflow:stop` calls
 * (`Orchestrator.stop`) and holds the provider call open with a controlled
 * promise, so the order of events is fixed by the test and never by a timer:
 * the call is dispatched, the task is stopped, and only then does the provider
 * answer (or fail). What must survive is the stop: the task stays CANCELLED, the
 * provider was told to stop, and nothing the late answer carried was recorded.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FindingTriageRecommendation } from '../../src/shared/schemas/codex';
import type { CodeReviewFinding } from '../../src/shared/domain/code-review';
import { FINGERPRINT, Hold, finding } from '../helpers/fake-code-review';
import {
  codeReviewScenario,
  disposeScenariosAfterEach,
  reviewOnce,
  type CodeReviewScenario
} from '../helpers/code-review-scenario';
import { until } from '../helpers/plan-correction-scenario';

disposeScenariosAfterEach();

const recommend = (
  findingRef: string,
  recommendation: 'accept' | 'reject' | 'needs_user' = 'accept'
): FindingTriageRecommendation => ({
  findingRef,
  recommendation,
  reason: `Reason for ${findingRef}.`,
  evidenceRef: 'src/service.ts:42',
  confidence: 'high'
});

/** Turns a rejection into a value, so a still-running operation never becomes an unhandled rejection. */
const outcomeOf = <T>(promise: Promise<T>): Promise<T | Error> =>
  promise.then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );

/** Neither the registration nor the overlap claim may outlive an operation, whatever ended it. */
function expectReleased(value: CodeReviewScenario): void {
  expect(value.harness.operations.isActive(value.task.id)).toBe(false);
  expect(value.claims.isHeld(value.task.id)).toBe(false);
}

const statusOf = (value: CodeReviewScenario): string | undefined =>
  value.harness.tasks.findById(value.task.id)?.status;

/** A task with reviewed findings and a service that can reach Codex. */
async function withFindings(titles: readonly string[] = ['First finding', 'Second finding', 'Third finding']) {
  const value = codeReviewScenario();
  const codex = value.harness.codex;
  const service = value.build({ codex, settings: value.harness.settings });
  value.reviewer.answer = { ...value.reviewer.answer, findings: titles.map((title) => finding({ title })) };
  const outcome = await reviewOnce(value);
  return { value, codex, service, findings: outcome.findings };
}

/** Every finding as it is stored, so "unchanged" is a comparison and not a memory. */
function snapshotOf(value: CodeReviewScenario, findings: readonly CodeReviewFinding[]) {
  return findings.map((entry) => ({
    revision: value.reviews.findFindingById(entry.id)?.revision,
    decision: value.reviews.latestDecision(entry.id)
  }));
}

describe('Stop task during a code-review round', () => {
  it('stops a round whose provider call is in flight: the reviewer is told to stop and the answer that arrives later is not recorded', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const hold = new Hold();
    value.reviewer.reviewHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.calls.length === 1, 'the round to reach the reviewer');
    expect(value.harness.operations.isActive(value.task.id)).toBe(true);

    const stopped = value.harness.orchestrator.stop(value.task.id);
    expect(stopped.status).toBe('CANCELLED');
    expect(value.reviewer.signals.review[0]?.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const round = value.reviews.latestRound(value.task.id);
    // The round keeps the phase it had when the call went out: the outcome is
    // unknown and was not recorded, which is not the same as "completed".
    expect(round?.status).toBe('reviewing');
    expect(round?.verdict).toBeNull();
    expect(round?.completedAt).toBeNull();
    expect(round?.lastError).toMatch(/stopped/i);
    expect(round?.lastError).toMatch(/outcome is unknown/i);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });

  it('reports a stop as a stop when the provider fails after it, and keeps the round honest', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    const hold = new Hold();
    value.reviewer.reviewHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.calls.length === 1, 'the round to reach the reviewer');
    value.harness.orchestrator.stop(value.task.id);
    hold.fail(new Error('the reviewer process was killed'));

    // Not the provider's own sentence: the operation ended because it was stopped.
    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    expect(round?.lastError).toMatch(/stopped/i);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });

  it('stops before the round exists: an availability check that answers after the stop creates nothing', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    const hold = new Hold();
    value.reviewer.availabilityHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.signals.availability.length === 1, 'the preflight to start');
    value.harness.orchestrator.stop(value.task.id);
    expect(value.reviewer.signals.availability[0]?.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.listRounds(value.task.id)).toEqual([]);
    expect(value.reviewer.beginCalls).toHaveLength(0);
    expect(value.reviewer.calls).toHaveLength(0);
    expectReleased(value);
  });

  it('stops while the round is being reserved: no review is dispatched, and the round says it never ran', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    const hold = new Hold();
    value.reviewer.beginHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.beginCalls.length === 1, 'the reservation to start');
    value.harness.orchestrator.stop(value.task.id);
    expect(value.reviewer.signals.begin[0]?.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    // The non-idempotent call was never made, so nothing external ran.
    expect(value.reviewer.calls).toHaveLength(0);
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('failed');
    expect(round?.lastError).toMatch(/stopped/i);
    expect(round?.providerRoundId).toBeNull();
    expectReleased(value);
  });

  it('never records an answer that was validated after the stop, even when the code read-back is what it waited on', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    // The stop lands while the answer is being checked against the working tree.
    let stoppedAt: number | null = null;
    value.snapshots.onCapture = () => {
      if (value.reviewer.calls.length === 1 && stoppedAt === null) {
        stoppedAt = value.snapshots.calls.length;
        value.harness.orchestrator.stop(value.task.id);
      }
    };

    const outcome = await outcomeOf(value.service.review(value.task.id));

    expect(stoppedAt).not.toBeNull();
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expectReleased(value);
  });
});

describe('a round the task is closed under without the operation being signalled', () => {
  it('is not completed either: the task’s own status is checked, not only the signal', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const hold = new Hold();
    value.reviewer.reviewHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.calls.length === 1, 'the round to reach the reviewer');
    // Closed by something that never went through the register, so nothing aborted the call.
    value.harness.tasks.update(value.task.id, { status: 'CANCELLED' });
    expect(value.reviewer.signals.review[0]?.aborted).toBe(false);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expectReleased(value);
  });

  it('stores no analysis either', async () => {
    const { value, codex, service, findings } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));

    const running = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    value.harness.tasks.update(value.task.id, { status: 'CANCELLED' });
    expect(codex.triageContexts[0]!.signal.aborted).toBe(false);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expectReleased(value);
  });

  it('does not let a forged answer that arrives after the stop overwrite what the round says about it', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    // On a live task this answer is refused and the refusal is written on the round.
    value.reviewer.attest = 'f'.repeat(64);
    const hold = new Hold();
    value.reviewer.reviewHold = hold;

    const running = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.calls.length === 1, 'the round to reach the reviewer');
    value.harness.orchestrator.stop(value.task.id);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.lastError).toMatch(/stopped/i);
    expect(round?.lastError).not.toMatch(/did not attest/i);
    expectReleased(value);
  });
});

describe('Stop task during a reconciliation', () => {
  async function unresolvedRound() {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;
    const subject = value.reviews.latestSubject(value.task.id)!;
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        findings: [finding()],
        reviewedSubjectSha256: subject.subjectSha256
      }
    };
    return value;
  }

  it('stops a read-back that is in flight: the provider is told to stop and the round it later reports is not applied', async () => {
    const value = await unresolvedRound();
    const before = value.reviews.latestRound(value.task.id);
    const hold = new Hold();
    value.reviewer.statusHold = hold;

    const running = outcomeOf(value.service.reconcile(value.task.id));
    await until(() => value.reviewer.roundStatusCalls.length === 1, 'the read-back to reach the reviewer');
    expect(value.harness.operations.isActive(value.task.id)).toBe(true);

    value.harness.orchestrator.stop(value.task.id);
    expect(value.reviewer.signals.status[0]?.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    expect(round?.verdict).toBeNull();
    expect(round?.lastError).toBe(before?.lastError);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });

  it('does not close a round on a "never started" answer that arrives after the stop', async () => {
    const value = await unresolvedRound();
    // On a live task this is the one answer that releases the round.
    value.reviewer.roundStatusAnswer = { kind: 'not_started', contractFingerprint: FINGERPRINT };
    const before = value.reviews.latestRound(value.task.id);
    const hold = new Hold();
    value.reviewer.statusHold = hold;

    const running = outcomeOf(value.service.reconcile(value.task.id));
    await until(() => value.reviewer.roundStatusCalls.length === 1, 'the read-back to reach the reviewer');
    value.harness.orchestrator.stop(value.task.id);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    expect(round?.lastError).toBe(before?.lastError);
    expectReleased(value);
  });

  it('stops while the working tree is being read back after a completed answer: the round is not completed', async () => {
    const value = await unresolvedRound();
    let stopped = false;
    value.snapshots.onCapture = () => {
      if (!stopped) {
        stopped = true;
        value.harness.orchestrator.stop(value.task.id);
      }
    };

    const outcome = await outcomeOf(value.service.reconcile(value.task.id));

    expect(stopped).toBe(true);
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expectReleased(value);
  });

  it('reports a stop as a stop when the read-back fails after it', async () => {
    const value = await unresolvedRound();
    const hold = new Hold();
    value.reviewer.statusHold = hold;

    const running = outcomeOf(value.service.reconcile(value.task.id));
    await until(() => value.reviewer.roundStatusCalls.length === 1, 'the read-back to reach the reviewer');
    value.harness.orchestrator.stop(value.task.id);
    hold.fail(new Error('transport closed'));

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    expectReleased(value);
  });
});

describe('Stop task during automatic finding triage', () => {
  it('stops an analysis Codex is still computing: the signal is aborted, nothing is stored and no finding changes', async () => {
    const { value, codex, service, findings } = await withFindings();
    const before = snapshotOf(value, findings);
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));

    const running = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    expect(value.harness.operations.isActive(value.task.id)).toBe(true);

    const stopped = value.harness.orchestrator.stop(value.task.id);
    expect(stopped.status).toBe('CANCELLED');
    expect(codex.triageContexts[0]!.signal.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expect(snapshotOf(value, findings)).toEqual(before);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });

  it('reports a stop as a stop when Codex fails after it', async () => {
    const { value, codex, service } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;

    const running = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    value.harness.orchestrator.stop(value.task.id);
    hold.fail(new Error('Codex exited with code 1'));

    const outcome = await running;
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expectReleased(value);
  });

  it('never starts Codex for a task that was stopped while the analysis was being prepared', async () => {
    const { value, codex, service, findings } = await withFindings();
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));
    // The stop lands while the analysis reads the working tree, before anything is sent.
    value.snapshots.onCapture = () => {
      if (statusOf(value) !== 'CANCELLED') value.harness.orchestrator.stop(value.task.id);
    };

    const outcome = await outcomeOf(service.triage(value.task.id));

    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(codex.triageCalls).toHaveLength(0);
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expectReleased(value);
  });

  it('reports a stopped task as stopped even when the answer that came back is unusable', async () => {
    const { value, codex, service } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;
    // Covers none of the requested findings: on a live task this is refused as malformed.
    codex.triageQueue.push([]);

    const running = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    // Closed without going through the register, so no signal says so — only the status does.
    value.harness.tasks.update(value.task.id, { status: 'CANCELLED' });
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expectReleased(value);
  });

  it('stops between the answer and its write: a recommendation is never stored for a task that was stopped', async () => {
    const { value, codex, service, findings } = await withFindings();
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));
    // The stop lands while the answer is being checked against the working tree.
    value.snapshots.onCapture = () => {
      if (codex.triageCalls.length === 1 && statusOf(value) !== 'CANCELLED') {
        value.harness.orchestrator.stop(value.task.id);
      }
    };

    const outcome = await outcomeOf(service.triage(value.task.id));

    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expectReleased(value);
  });
});

describe('Stop task during Auto decide', () => {
  it('stops an analysis Codex is still computing: no decision, no stored recommendation, no revision change', async () => {
    const { value, codex, service, findings } = await withFindings();
    const before = snapshotOf(value, findings);
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push([recommend(findings[0]!.id, 'accept')]);

    const running = outcomeOf(service.autoDecide(value.task.id, { findingId: findings[0]!.id }));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    expect(value.harness.operations.isActive(value.task.id)).toBe(true);

    value.harness.orchestrator.stop(value.task.id);
    expect(codex.triageContexts[0]!.signal.aborted).toBe(true);
    hold.release();

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expect(snapshotOf(value, findings)).toEqual(before);
    expectReleased(value);
  });

  it('stopped between the analysis and the decision: the recommendation is kept as evidence but no decision is written', async () => {
    const { value, codex, service, findings } = await withFindings();
    const before = snapshotOf(value, findings);
    codex.triageQueue.push([recommend(findings[0]!.id, 'accept')]);
    // The stop lands the instant the analysis is stored — after the answer, before it is applied.
    const original = value.reviews.upsertTriage.bind(value.reviews);
    vi.spyOn(value.reviews, 'upsertTriage').mockImplementation((input) => {
      const stored = original(input);
      value.harness.orchestrator.stop(value.task.id);
      return stored;
    });

    const outcome = await outcomeOf(service.autoDecide(value.task.id, { findingId: findings[0]!.id }));

    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(snapshotOf(value, findings)).toEqual(before);
    expect(value.reviews.listDecisions(findings[0]!.id)).toEqual([]);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });

  it('stopped after part of a batch was applied: what was written stays recorded, the rest is not applied, and no call reports full success', async () => {
    const { value, codex, service, findings } = await withFindings();
    // Three analyses in flight at once, as the panel's bulk action runs them.
    codex.triageQueue.push(
      [recommend(findings[0]!.id, 'accept')],
      [recommend(findings[1]!.id, 'reject')],
      [recommend(findings[2]!.id, 'accept')]
    );
    // Stop lands the instant the FIRST decision has been written, wherever the other two are.
    const original = value.reviews.appendDecisionIfUnchanged.bind(value.reviews);
    let written = 0;
    vi.spyOn(value.reviews, 'appendDecisionIfUnchanged').mockImplementation((decision, expectedRevision) => {
      const applied = original(decision, expectedRevision);
      written += 1;
      if (written === 1) value.harness.orchestrator.stop(value.task.id);
      return applied;
    });

    const outcomes = await Promise.all(
      findings.map((entry) => outcomeOf(service.autoDecide(value.task.id, { findingId: entry.id })))
    );

    const decided = findings.filter((entry) => value.reviews.latestDecision(entry.id) !== null);
    expect(decided).toHaveLength(1);
    // The one that was written says so honestly...
    expect(outcomes.filter((outcome) => !(outcome instanceof Error))).toEqual([
      expect.objectContaining({ kind: 'decided' })
    ]);
    // ...and every other call reports the stop instead of a success.
    expect(outcomes.filter((outcome) => outcome instanceof Error)).toHaveLength(2);
    for (const outcome of outcomes.filter((entry) => entry instanceof Error)) {
      expect(outcome).toMatchObject({ code: 'CANCELLED' });
    }
    expect(value.reviews.listDecisions(decided[0]!.id)).toHaveLength(1);
    expect(statusOf(value)).toBe('CANCELLED');
    expectReleased(value);
  });
});

describe('a new operation after Stop', () => {
  it('does not store a subject that was captured while the task was being stopped', async () => {
    const value = codeReviewScenario();
    value.snapshots.onCapture = () => {
      if (statusOf(value) !== 'CANCELLED') value.harness.orchestrator.stop(value.task.id);
    };

    await expect(value.service.captureSubject(value.task.id)).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(value.reviews.latestSubject(value.task.id)).toBeNull();
  });

  it('is refused before it reaches any provider, for every operation', async () => {
    const { value, codex, service, findings } = await withFindings();
    const before = snapshotOf(value, findings);
    const calls = {
      snapshots: value.snapshots.calls.length,
      begins: value.reviewer.beginCalls.length,
      reviews: value.reviewer.calls.length,
      availability: value.reviewer.availabilityCalls.length
    };
    value.harness.orchestrator.stop(value.task.id);

    await expect(service.captureSubject(value.task.id)).rejects.toThrow(/closed/i);
    await expect(service.review(value.task.id)).rejects.toThrow(/closed/i);
    await expect(service.reconcile(value.task.id)).rejects.toThrow(/closed/i);
    await expect(service.triage(value.task.id)).rejects.toThrow(/closed/i);
    await expect(service.autoDecide(value.task.id, { findingId: findings[0]!.id })).rejects.toThrow(/closed/i);
    await expect(
      service.decide(value.task.id, {
        findingId: findings[0]!.id,
        action: 'accept',
        reason: 'Too late.',
        expectedRevision: findings[0]!.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/closed/i);

    expect(codex.triageCalls).toHaveLength(0);
    expect(value.snapshots.calls).toHaveLength(calls.snapshots);
    expect(value.reviewer.beginCalls).toHaveLength(calls.begins);
    expect(value.reviewer.calls).toHaveLength(calls.reviews);
    expect(value.reviewer.availabilityCalls).toHaveLength(calls.availability);
    expect(snapshotOf(value, findings)).toEqual(before);
    expectReleased(value);
  });

  it('cannot change a decision after Stop even when the decision was already past its checks', async () => {
    const { value, findings } = await withFindings();
    const before = snapshotOf(value, findings);
    // The stop lands while the decision is reading the working tree, after its own admission check.
    value.snapshots.onCapture = () => {
      if (statusOf(value) !== 'CANCELLED') value.harness.orchestrator.stop(value.task.id);
    };

    await expect(
      value.service.decide(value.task.id, {
        findingId: findings[0]!.id,
        action: 'accept',
        reason: 'The operator got there just too late.',
        expectedRevision: findings[0]!.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(snapshotOf(value, findings)).toEqual(before);
  });
});

describe('overlapping operations', () => {
  it('does not dispatch a second round for an identical repeated click on Review', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    const hold = new Hold();
    value.reviewer.reviewHold = hold;

    const first = outcomeOf(value.service.review(value.task.id));
    await until(() => value.reviewer.calls.length === 1, 'the round to reach the reviewer');

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.build().review(value.task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.beginCalls).toHaveLength(1);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(1);

    hold.release();
    expect(await first).toMatchObject({ round: { status: 'completed' } });
    expectReleased(value);
  });

  it('does not start a second call for an identical repeated click', async () => {
    const { value, codex, service, findings } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push([recommend(findings[0]!.id, 'accept')]);

    const first = outcomeOf(service.autoDecide(value.task.id, { findingId: findings[0]!.id }));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');

    await expect(service.autoDecide(value.task.id, { findingId: findings[0]!.id })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.build({ codex, settings: value.harness.settings }).autoDecide(value.task.id, { findingId: findings[0]!.id })).rejects.toMatchObject({ code: 'BUSY' });
    expect(codex.triageCalls).toHaveLength(1);

    hold.release();
    expect(await first).toMatchObject({ kind: 'decided' });
    expect(value.reviews.listDecisions(findings[0]!.id)).toHaveLength(1);
    expectReleased(value);
  });

  it('keeps a review and an analysis from running at once, from any service instance', async () => {
    const { value, codex, service, findings } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));
    const analysing = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    const dispatched = value.reviewer.beginCalls.length;

    await expect(value.build().review(value.task.id)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(value.build().reconcile(value.task.id)).rejects.toMatchObject({ code: 'BUSY' });
    expect(value.reviewer.beginCalls).toHaveLength(dispatched);

    hold.release();
    expect(await analysing).toHaveLength(findings.length);
    expectReleased(value);
  });

  it('lets different findings be analyzed at once, and counts each as a stoppable operation', async () => {
    const { value, codex, service, findings } = await withFindings();
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push([recommend(findings[0]!.id)], [recommend(findings[1]!.id)]);

    const first = outcomeOf(service.autoDecide(value.task.id, { findingId: findings[0]!.id }));
    const second = outcomeOf(service.autoDecide(value.task.id, { findingId: findings[1]!.id }));
    await until(() => codex.triageCalls.length === 2, 'both analyses to reach Codex');

    // One stop reaches both.
    value.harness.orchestrator.stop(value.task.id);
    expect(codex.triageContexts.every((context) => context.signal.aborted)).toBe(true);
    hold.release();

    expect(await first).toMatchObject({ code: 'CANCELLED' });
    expect(await second).toMatchObject({ code: 'CANCELLED' });
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
    expectReleased(value);
  });

  it('stops only the task it names', async () => {
    const { value, codex, service, findings } = await withFindings();
    const other = value.harness.createTask(value.task.projectId, { status: 'READY_FOR_IMPLEMENTATION' });
    const hold = new Hold();
    codex.triageGate = hold.promise;
    codex.triageQueue.push(findings.map((entry) => recommend(entry.id)));

    const running = outcomeOf(service.triage(value.task.id));
    await until(() => codex.triageCalls.length === 1, 'the analysis to reach Codex');
    value.harness.orchestrator.stop(other.id);

    expect(codex.triageContexts[0]!.signal.aborted).toBe(false);
    hold.release();
    expect(await running).toHaveLength(findings.length);
    expect(statusOf(value)).toBe('READY_FOR_IMPLEMENTATION');
    expectReleased(value);
  });
});

describe('a provider failure that is not a stop', () => {
  it('leaves nothing held, and the same operation can be repeated', async () => {
    const { value, codex, service, findings } = await withFindings();
    codex.triageError = new Error('Codex timed out.');

    await expect(service.triage(value.task.id)).rejects.toThrow(/timed out/i);
    expectReleased(value);
    await expect(service.autoDecide(value.task.id, { findingId: findings[0]!.id })).rejects.toThrow(/timed out/i);
    expectReleased(value);

    codex.triageError = null;
    codex.triageQueue.push([recommend(findings[0]!.id, 'accept')]);
    expect(await service.autoDecide(value.task.id, { findingId: findings[0]!.id })).toMatchObject({ kind: 'decided' });
    expectReleased(value);
    expect(statusOf(value)).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('leaves nothing held after a lost review answer, and a reconciliation can follow', async () => {
    const value = codeReviewScenario();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');

    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    expectReleased(value);

    value.reviewer.error = null;
    await expect(value.service.reconcile(value.task.id)).resolves.toBeDefined();
    expectReleased(value);
  });
});
