/**
 * The corrected specification is reviewed on its own review identity.
 *
 * Coai keys a session by (repository, branch), and `open` is idempotent: the same
 * pair returns the same session however far it has advanced. Every gate of a task
 * used the task's branch, so once the first review was resolved — the session then
 * stands at CodeReview — the plan-correction loop's review of the revised
 * specification got that same, finished session back and `review_plan` was refused;
 * and reconciling that gate read the finished session and called the corrected plan
 * "proceeded". These tests drive the whole loop over a reviewer that keeps Coai's
 * sessions, so both failures are reproduced by the behaviour of the loop and not by
 * a script.
 */

import { describe, expect, it } from 'vitest';
import type { ExternalPlanReviewRound, ExternalPlanReviewStatus } from '../../src/main/ports';
import { AgentRelayError, PlanReviewNotDispatchedError } from '../../src/shared/domain/errors';
import { planReviewRecovery, type PlanReviewGate } from '../../src/shared/domain/plan-review';
import { specificationIdentity } from '../../src/main/services/specification-identity';
import { deferred, finding, FINGERPRINT } from '../helpers/fake-plan-reviewer';
import {
  coaiScenario,
  currentGate,
  disposeScenariosAfterEach,
  ready,
  specOf,
  statusOf,
  until,
  type CoaiScenario
} from '../helpers/plan-correction-scenario';

disposeScenariosAfterEach();

const rec = (findingRef: number, recommendation: 'accept' | 'reject' | 'needs_user') => ({
  findingRef,
  recommendation,
  reason: `Reason ${findingRef}.`,
  evidenceRef: `evidence ${findingRef}`,
  confidence: 'high' as const
});

const roundOf = (
  value: CoaiScenario,
  titles: readonly string[],
  verdict: ExternalPlanReviewRound['verdict'] = 'revise'
): ExternalPlanReviewRound => ({
  verdict,
  gatingCount: titles.length,
  threshold: 1,
  reviewers: 'all 2 reviewers answered',
  findings: titles.map(finding),
  instruction: 'resolve every finding',
  serverName: 'coai-mcp',
  serverVersion: '1.2.3',
  contractFingerprint: value.reviewer.contractFingerprint
});

/** Turns a rejection into a value, so a still-running operation never becomes an unhandled rejection. */
const outcomeOf = <T>(promise: Promise<T>): Promise<T | Error> =>
  promise.then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );

/** The task, its project path and its branch: what the first gate is reviewed under. */
function taskSubject(value: CoaiScenario, taskId: string) {
  const task = value.harness.tasks.findById(taskId)!;
  const project = value.harness.projects.findById(task.projectId)!;
  return { repositoryPath: project.localPath, branch: task.branchName as string };
}

/** Every gate of the task, oldest first. */
const gatesOf = (value: CoaiScenario, taskId: string): PlanReviewGate[] =>
  value.harness.planReviewGates.listByTask(taskId).reverse();

/** Round 1 has a finding Codex accepts; nothing has been resolved yet. The first gate is awaiting decisions. */
async function afterFirstReview(value: CoaiScenario) {
  const task = await ready(value);
  value.reviewer.roundQueue = [roundOf(value, ['Needs a change'])];
  value.harness.codex.triageQueue.push([rec(0, 'accept')]);
  await value.gateService.review(task.id);
  return task;
}

/**
 * The first gate is resolved with its finding accepted and Codex has revised the plan; the
 * review of the revision is the next step. `review` is what the loop's own review does to gate 2.
 */
async function untilCorrectedReview(value: CoaiScenario, hooks: { onOpen?: () => void; onReview?: () => void } = {}) {
  const task = await afterFirstReview(value);
  value.reviewer.onOpen = hooks.onOpen ?? null;
  value.reviewer.onReview = hooks.onReview ?? null;
  return task;
}

const drive = (value: CoaiScenario, taskId: string) => value.loop.continueCorrection(taskId, { autoContinue: true });

/** What a defective build left in the database: the corrected gate holds the first gate's session and says its review was sent. */
function seedLegacyStuckGate(value: CoaiScenario, taskId: string, status: 'reviewing' | 'proceeded' = 'reviewing') {
  const [first, corrected] = gatesOf(value, taskId) as [PlanReviewGate, PlanReviewGate];
  return value.harness.planReviewGates.update(corrected.id, {
    status,
    sessionId: first.sessionId,
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    reviewSubject: null,
    ...(status === 'proceeded'
      ? { decisionsJson: '[]', reconciledAt: '2026-09-20T00:00:00.000Z', lastError: null }
      : {
          lastError:
            'Coai refused the request: the plan stage is over for this session (stage: CodeReview); open a new session for a new plan'
        })
  });
}

describe('plan correction over a reviewer that keeps sessions', () => {
  it('reviews the corrected specification in a session of its own, bound to that specification', async () => {
    const value = coaiScenario();
    const task = await ready(value);
    const firstSpecification = specificationIdentity(specOf(value, task.id));
    // Round 1 finds something; Codex accepts it; the session then moves on to
    // CodeReview. Round 2 (of the corrected plan) is clean.
    value.reviewer.roundQueue = [roundOf(value, ['Needs a change']), roundOf(value, [], 'proceed')];
    value.harness.codex.triageQueue.push([rec(0, 'accept')]);
    await value.gateService.review(task.id);

    const outcome = await drive(value, task.id);

    expect(outcome.stopped).toBe('clean');
    const [first, corrected] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    expect(gatesOf(value, task.id)).toHaveLength(2);
    // The corrected gate speaks for the corrected specification and nothing else.
    const correctedSpecification = specificationIdentity(specOf(value, task.id));
    expect(correctedSpecification.sha256).not.toBe(firstSpecification.sha256);
    expect(first.specificationSha256).toBe(firstSpecification.sha256);
    expect(corrected.specificationSha256).toBe(correctedSpecification.sha256);
    // Two different provider identities: the second review was not run in the first one's session.
    expect(corrected.sessionId).not.toBeNull();
    expect(corrected.sessionId).not.toBe(first.sessionId);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
    // The first gate keeps the task's branch, recorded now; only the second needed a subject of its own.
    const branch = taskSubject(value, task.id);
    expect(first.reviewSubject).toBe(branch.branch);
    expect(corrected.reviewSubject).not.toBeNull();
    expect(corrected.reviewSubject).not.toBe(branch.branch);
    expect(value.subjects.requests).toHaveLength(1);
    expect(value.subjects.requests[0]).toMatchObject({
      gateId: corrected.id,
      specificationSha256: corrected.specificationSha256,
      branch: branch.branch,
      repositoryPath: branch.repositoryPath
    });
    expect(value.reviewer.openCalls.map((call) => call.branch)).toEqual([branch.branch, corrected.reviewSubject]);
    expect(value.reviewer.reviewCalls.map((call) => call.subject.branch)).toEqual([branch.branch, corrected.reviewSubject]);
    // Each dispatch recorded what its session held when it was opened: nothing.
    expect([first.roundsAtOpen, corrected.roundsAtOpen]).toEqual([0, 0]);
    expect(corrected.status).toBe('proceeded');
    // The review the corrected gate holds can approve exactly the corrected specification.
    expect(value.harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });

  it('would have been handed the finished session by the provider — and does not ask it', async () => {
    const value = coaiScenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundOf(value, ['Needs a change']), roundOf(value, [], 'proceed')];
    value.harness.codex.triageQueue.push([rec(0, 'accept')]);
    await value.gateService.review(task.id);
    await drive(value, task.id);
    const [first] = gatesOf(value, task.id) as [PlanReviewGate];

    // Opening the task's branch again is what the loop used to do for the corrected gate.
    const again = await value.reviewer.open(taskSubject(value, task.id));

    expect(again).toMatchObject({ sessionId: first.sessionId, stage: 'CodeReview', planProceeded: true });
    expect(again.planRounds?.total).toBe(1);
    // The corrected gate never named it.
    expect(value.reviewer.reviewCalls.slice(1).every((call) => call.subject.branch !== taskSubject(value, task.id).branch)).toBe(true);
  });

  it('gives every further gate its own session across several corrections', async () => {
    const value = coaiScenario();
    const task = await ready(value);
    value.reviewer.roundQueue = [roundOf(value, ['First']), roundOf(value, ['Second']), roundOf(value, [], 'proceed')];
    value.harness.codex.triageQueue.push([rec(0, 'accept')], [rec(0, 'accept')]);
    await value.gateService.review(task.id);

    const outcome = await drive(value, task.id);

    expect(outcome).toMatchObject({ stopped: 'clean', correctionsRun: 2 });
    const gates = gatesOf(value, task.id);
    expect(gates).toHaveLength(3);
    expect(new Set(gates.map((gate) => gate.sessionId)).size).toBe(3);
    expect(new Set(gates.map((gate) => gate.reviewSubject)).size).toBe(3);
    expect(new Set(gates.map((gate) => gate.specificationSha256)).size).toBe(3);
    expect(value.subjects.requests.map((request) => request.gateId)).toEqual([gates[1]!.id, gates[2]!.id]);
    expect(gates.at(-1)!.status).toBe('proceeded');
  });
});

describe('a session the provider hands back that cannot host the review', () => {
  const cases: readonly {
    readonly name: string;
    readonly makeUnfit: (value: CoaiScenario) => void;
    readonly failureKind: 'foreign_session' | 'not_dispatched';
    readonly words: RegExp;
  }[] = [
    {
      name: "another review's session",
      makeUnfit: (value) => value.reviewer.alias(value.reviewer.openCalls[1]!, value.reviewer.openCalls[0]!),
      failureKind: 'foreign_session',
      words: /already used/
    },
    {
      name: 'a session that already holds a plan round',
      makeUnfit: (value) => value.reviewer.seed(value.reviewer.openCalls[1]!, { rounds: ['done'] }),
      failureKind: 'not_dispatched',
      words: /already holds plan rounds/
    },
    {
      name: 'a session that already awaits a resolution',
      makeUnfit: (value) => value.reviewer.seed(value.reviewer.openCalls[1]!, { awaitingResolve: true }),
      failureKind: 'not_dispatched',
      words: /already holds plan rounds/
    },
    {
      name: 'a session that has moved past the plan stage',
      makeUnfit: (value) =>
        value.reviewer.seed(value.reviewer.openCalls[1]!, { stage: 'CodeReview', planProceeded: true, rounds: ['done'] }),
      failureKind: 'not_dispatched',
      words: /past the plan stage/
    },
    {
      name: 'a session whose rounds the provider does not report',
      makeUnfit: (value) => {
        value.reviewer.openReportsNoRounds = true;
      },
      failureKind: 'not_dispatched',
      words: /could not be proven empty/
    }
  ];

  it.each(cases)('refuses $name before any round is sent, and marks the attempt spent', async (unfit) => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value, {
      onOpen: () => {
        if (value.reviewer.openCalls.length === 2) unfit.makeUnfit(value);
      }
    });

    const error = await outcomeOf(drive(value, task.id));

    expect(error).toBeInstanceOf(PlanReviewNotDispatchedError);
    expect((error as Error).message).toMatch(unfit.words);
    // Nothing was sent for the corrected plan: the only `review_plan` is the first gate's.
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    const [, corrected] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    expect(corrected.status).toBe('prepared');
    expect(corrected.failureKind).toBe(unfit.failureKind);
    // The session it was handed is not recorded as this gate's: it is not this gate's.
    expect(corrected.sessionId).toBeNull();
    expect(corrected.lastError).toMatch(unfit.words);
    expect(planReviewRecovery(corrected, gatesOf(value, task.id).reverse())).not.toBeNull();
    // And the corrected plan is neither reviewed nor approvable.
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');
  });
});

describe('a provider refusal that says nothing ran', () => {
  /** The corrected review is refused: another client moved its session on between `open` and `review_plan`. */
  async function refusedCorrectedReview(value: CoaiScenario) {
    const task = await untilCorrectedReview(value, {
      onReview: () => {
        if (value.reviewer.reviewCalls.length === 2) {
          value.reviewer.seed(value.reviewer.reviewCalls[1]!.subject, { stage: 'CodeReview', planProceeded: true });
        }
      }
    });
    const error = await outcomeOf(drive(value, task.id));
    value.reviewer.onReview = null;
    return { task, error };
  }

  it('is classified as a refusal before a round existed, kept on record, and never repeated by the loop', async () => {
    const value = coaiScenario();

    const { task, error } = await refusedCorrectedReview(value);

    expect(error).toBeInstanceOf(PlanReviewNotDispatchedError);
    expect((error as PlanReviewNotDispatchedError).reason).toBe('plan_stage_over');
    const [, corrected] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    expect(corrected).toMatchObject({ status: 'prepared', failureKind: 'not_dispatched' });
    // The provider's own words are on the gate, bounded and stored.
    expect(corrected.lastError).toMatch(/the plan stage is over for this session/);
    expect(value.reviewer.reviewCalls).toHaveLength(2);

    // The loop stops for a person; it does not ask again — not the same session, not another one.
    const again = await drive(value, task.id);
    expect(again.stopped).toBe('recovery_required');
    expect(value.reviewer.openCalls).toHaveLength(2);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
    expect(value.subjects.requests).toHaveLength(1);
    // Running the attempt again by hand is refused too: its identity is spent.
    await expect(value.gateService.review(task.id)).rejects.toThrow(/cannot be continued/);
    expect(value.reviewer.reviewCalls).toHaveLength(2);
  });

  it('is replaced by a fresh review identity, keeping the failed attempt and the specification exactly as they were', async () => {
    const value = coaiScenario();
    const { task } = await refusedCorrectedReview(value);
    const [, refused] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    const specificationBefore = specOf(value, task.id);
    const runsBefore = value.harness.runs.listByTask(task.id).length;

    const fresh = await value.gateService.retryInFreshSession(task.id);

    // Recovery sends nothing to the provider and starts nothing.
    expect(value.reviewer.reviewCalls).toHaveLength(2);
    expect(value.reviewer.openCalls).toHaveLength(2);
    expect(value.harness.runs.listByTask(task.id)).toHaveLength(runsBefore);
    expect(value.harness.claude.calls).toHaveLength(0);
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');
    // The same specification, byte for byte, and the same hash.
    expect(specOf(value, task.id)).toBe(specificationBefore);
    expect(fresh.specificationSha256).toBe(refused.specificationSha256);
    expect(fresh).toMatchObject({ status: 'prepared', failureKind: null, sessionId: null, supersededBy: null });
    expect(fresh.reviewSubject).not.toBeNull();
    expect(fresh.reviewSubject).not.toBe(refused.reviewSubject);
    expect(currentGate(value, task.id).id).toBe(fresh.id);
    // The failed attempt is evidence: only the pointer to its replacement was added.
    const kept = value.harness.planReviewGates.findById(refused.id)!;
    expect(kept).toMatchObject({
      status: 'prepared',
      failureKind: 'not_dispatched',
      lastError: refused.lastError,
      sessionId: refused.sessionId,
      reviewSubject: refused.reviewSubject,
      supersededBy: fresh.id
    });

    // The review under the fresh identity passes, in a session of its own.
    const reviewed = await value.gateService.review(task.id);
    expect(reviewed.status).toBe('awaiting_resolve');
    expect(reviewed.sessionId).not.toBe(refused.sessionId);
    expect(value.reviewer.reviewCalls).toHaveLength(3);
    expect(value.reviewer.reviewCalls[2]!.subject.branch).toBe(fresh.reviewSubject);
    expect(value.reviewer.reviewCalls[2]!.planText).toBe(value.reviewer.reviewCalls[1]!.planText);
  });
});

describe('a first review whose task-branch session is already used', () => {
  it('is refused before anything is sent and recovered under a fresh identity, exactly like a later gate', async () => {
    const value = coaiScenario();
    const task = await ready(value);
    // The task's branch already has a finished plan round in the provider (a reused branch, another client).
    value.reviewer.seed(taskSubject(value, task.id), { rounds: ['done'] });

    const refused = await outcomeOf(value.gateService.review(task.id));

    expect(refused).toBeInstanceOf(PlanReviewNotDispatchedError);
    expect(value.reviewer.reviewCalls).toHaveLength(0);
    const spent = currentGate(value, task.id);
    expect(spent).toMatchObject({ status: 'prepared', failureKind: 'not_dispatched', sessionId: null });
    expect(planReviewRecovery(spent, gatesOf(value, task.id).reverse())).toBe('refused_before_dispatch');

    // The retry is allowed — the marker, not a recorded session, is what makes the identity spent.
    const fresh = await value.gateService.retryInFreshSession(task.id);
    expect(fresh.reviewSubject).not.toBe(taskSubject(value, task.id).branch);
    expect(fresh.specificationSha256).toBe(spent.specificationSha256);
    value.reviewer.roundQueue = [roundOf(value, ['A finding'])];

    const reviewed = await value.gateService.review(task.id);

    expect(reviewed.status).toBe('awaiting_resolve');
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    expect(value.reviewer.reviewCalls[0]!.subject.branch).toBe(fresh.reviewSubject);
  });
});

describe('a review subject the provider can no longer resolve', () => {
  it('is a known non-dispatch: the gate is marked spent and offered the fresh-session retry, not looped through reconcile', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    // The corrected gate is prepared, and Git has pruned its subject before its first dispatch.
    const before = taskSubject(value, task.id);
    value.reviewer.knownRefs = new Set([before.branch]);

    const error = await outcomeOf(drive(value, task.id));

    expect(error).toBeInstanceOf(PlanReviewNotDispatchedError);
    expect((error as PlanReviewNotDispatchedError).reason).toBe('unresolvable_subject');
    const [, refused] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    expect(refused).toMatchObject({ status: 'prepared', failureKind: 'not_dispatched', sessionId: null });
    expect(value.reviewer.reviewCalls).toHaveLength(1);
    // The loop stops for a person instead of retrying, and reconcile is not offered for it.
    expect((await drive(value, task.id)).stopped).toBe('recovery_required');
    expect(value.reviewer.openCalls).toHaveLength(2);

    // The retry makes a new subject the provider can resolve, and the review then passes under it.
    const fresh = await value.gateService.retryInFreshSession(task.id);
    value.reviewer.knownRefs.add(fresh.reviewSubject as string);
    value.reviewer.roundQueue = [roundOf(value, [], 'proceed')];
    const reviewed = await value.gateService.review(task.id);
    expect(reviewed.status).toBe('awaiting_resolve');
    expect(reviewed.reviewSubject).toBe(fresh.reviewSubject);
    expect(reviewed.specificationSha256).toBe(refused.specificationSha256);
  });
});

describe('a gate that cannot count for an EARLIER specification', () => {
  async function stuckThenRegenerated(value: CoaiScenario) {
    const task = await untilCorrectedReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    seedLegacyStuckGate(value, task.id);
    // The specification moves on (regenerated): the stuck gate now describes an earlier one.
    value.harness.tasks.update(task.id, {
      specificationJson: JSON.stringify({ ...JSON.parse(specOf(value, task.id)), summary: 'Regenerated.' }),
      specificationApprovedAt: null
    });
    return task;
  }

  it('is not offered as recovery — the retry would be refused — and is not reconciled: the current specification is prepared instead', async () => {
    const value = coaiScenario();
    const task = await stuckThenRegenerated(value);
    const stuck = currentGate(value, task.id);
    expect(planReviewRecovery(stuck, gatesOf(value, task.id).reverse())).not.toBeNull();

    // What the loop and the screen derive from: identity is obsolete, so it is the ordinary path.
    expect(value.loop.detail(task.id).nextStep).toBe('none');
    expect((await drive(value, task.id)).stopped).toBe('none');
    await expect(value.gateService.retryInFreshSession(task.id)).rejects.toThrow(/specification changed/);

    // Preparing the current specification works over it, and its review runs in a session of its own.
    const prepared = value.gateService.prepare(task.id);
    expect(prepared.status).toBe('prepared');
    value.reviewer.roundQueue = [roundOf(value, [], 'proceed')];
    const reviewed = await value.gateService.review(task.id);
    expect(reviewed.status).toBe('awaiting_resolve');
    expect(reviewed.sessionId).not.toBe(stuck.sessionId);
  });
});

describe('a transport failure while the corrected plan is being reviewed', () => {
  async function timedOut(value: CoaiScenario) {
    const task = await afterFirstReview(value);
    // The request reaches the provider and is recorded there; only the answer is lost.
    value.reviewer.failAfterRecording = true;
    const error = await outcomeOf(drive(value, task.id));
    value.reviewer.failAfterRecording = false;
    return { task, error };
  }

  it('is an unknown outcome: not classified as a refusal, not repeated, and not replaced', async () => {
    const value = coaiScenario();

    const { task, error } = await timedOut(value);

    expect(error).toBeInstanceOf(AgentRelayError);
    expect((error as AgentRelayError).code).toBe('TIMEOUT');
    expect(error).not.toBeInstanceOf(PlanReviewNotDispatchedError);
    const gates = gatesOf(value, task.id);
    const corrected = gates[1]!;
    expect(corrected.status).toBe('reviewing');
    expect(corrected.failureKind).toBeNull();
    expect(planReviewRecovery(corrected, gates.slice().reverse())).toBeNull();
    // The loop hands it to reconciliation and asks nothing further.
    const before = { opens: value.reviewer.openCalls.length, reviews: value.reviewer.reviewCalls.length };
    const again = await drive(value, task.id);
    expect(again.stopped).toBe('reconcile_required');
    expect({ opens: value.reviewer.openCalls.length, reviews: value.reviewer.reviewCalls.length }).toEqual(before);
    // A fresh session may not replace it: the round may already have run.
    await expect(value.gateService.retryInFreshSession(task.id)).rejects.toThrow(/Reconcile the external state first|nothing about it proves/);
    expect(gatesOf(value, task.id)).toHaveLength(2);
    expect(value.subjects.requests).toHaveLength(1);
  });

  it('is read back from the gate’s own session, and a round the read-back cannot deliver settles nothing', async () => {
    const value = coaiScenario();
    const { task } = await timedOut(value);

    const after = await value.gateService.reconcile(task.id);

    // The provider records a finished round awaiting decisions, but status carries no findings:
    // nothing to decide against, nothing invented, nothing repeated.
    expect(after.status).toBe('reviewing');
    expect(after.lastError).toMatch(/does not return that round/);
    expect(after.failureKind).toBeNull();
    expect(value.reviewer.reviewCalls).toHaveLength(2);
  });
});

describe('reconciliation reads only evidence that belongs to the gate', () => {
  it('does not let a finished session settle a corrected gate that recorded it (the defective build’s state)', async () => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value);
    // Codex revises; the review of the revision is prevented from being dispatched, so what is
    // left is a corrected gate that has not been reviewed. Then the database is put in the state
    // the defect left: the corrected gate holds the FIRST gate's session and says its review was sent.
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    seedLegacyStuckGate(value, task.id);
    const before = value.reviewer.statusCalls.length;

    const after = await value.gateService.reconcile(task.id);

    // The old review says nothing about the corrected plan: not proceeded, not changes-requested,
    // and the provider was not even asked — whatever it says is about the other review.
    expect(after.status).toBe('reviewing');
    expect(after.failureKind).toBe('foreign_session');
    expect(after.lastError).toMatch(/belongs to a different plan review/);
    expect(value.reviewer.statusCalls).toHaveLength(before);
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('does not let a provider that answers for the OLD session settle a corrected gate that has a session of its own', async () => {
    const value = coaiScenario();
    const { task } = await (async () => {
      const t = await afterFirstReview(value);
      value.reviewer.failAfterRecording = true;
      await outcomeOf(drive(value, t.id));
      value.reviewer.failAfterRecording = false;
      return { task: t };
    })();
    const [first, corrected] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    // The read-back names the first session, finished and proceeded — the tempting answer.
    const old: ExternalPlanReviewStatus = {
      sessionId: first.sessionId as string,
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: { total: 1, running: 0, done: 1, interrupted: 0 },
      serverName: 'coai-mcp',
      serverVersion: '1.2.3',
      contractFingerprint: FINGERPRINT
    };
    value.reviewer.statusOverride = old;

    const after = await value.gateService.reconcile(task.id);

    expect(after.status).toBe('reviewing');
    expect(after.lastError).toMatch(/different session/);
    // Its own session's outcome is still unknown: not replaced, not marked spent.
    expect(after.failureKind).toBeNull();
    expect(after.sessionId).toBe(corrected.sessionId);
  });

  it('does not let rounds found in the session of a gate that never sent one settle it', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    const corrected = currentGate(value, task.id);
    expect(corrected.status).toBe('opening');
    // Something else worked in that session meanwhile: a finished, resolved round.
    value.reviewer.seed(
      { ...taskSubject(value, task.id), branch: corrected.reviewSubject as string },
      { stage: 'CodeReview', planProceeded: true, rounds: ['done'] }
    );

    const after = await value.gateService.reconcile(task.id);

    // `review_plan` is sent only after `open` returned, so a gate still at `opening` sent none.
    expect(after.status).toBe('opening');
    expect(after.failureKind).toBe('foreign_session');
    expect(after.lastError).toMatch(/never sent one/);
  });

  it('does not adopt another review’s session for a legacy gate that recorded none', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    const [first, corrected] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    // A row an earlier version wrote: `failed`, with no session recorded (its original phase was not kept).
    value.harness.planReviewGates.update(corrected.id, { status: 'failed', sessionId: null, lastError: 'Coai call failed.' });
    // The provider answers for the first, finished review — the tempting evidence.
    value.reviewer.statusOverride = {
      sessionId: first.sessionId as string,
      stage: 'CodeReview',
      awaitingResolve: false,
      planProceeded: true,
      planRounds: { total: 1, running: 0, done: 1, interrupted: 0 },
      serverName: 'coai-mcp',
      serverVersion: '1.2.3',
      contractFingerprint: FINGERPRINT
    };

    const after = await value.gateService.reconcile(task.id);

    expect(after.status).toBe('failed');
    expect(after.sessionId).toBeNull();
    expect(after.failureKind).toBe('foreign_session');
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('still returns an opening gate to prepared when the provider knows nothing of its session', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;

    const after = await value.gateService.reconcile(task.id);

    // `open` never took effect, and `review_plan` was never reached: safe to start again.
    expect(after.status).toBe('prepared');
    expect(after.failureKind).toBeNull();
    expect(value.reviewer.reviewCalls).toHaveLength(1);
  });

  it('does not count a round the session already held before this dispatch opened it', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    const gate = currentGate(value, task.id);
    const subject = { ...taskSubject(value, task.id), branch: gate.reviewSubject as string };
    // A re-run of a gate whose session already held one settled round; the new round's answer was lost.
    value.reviewer.seed(subject, { awaitingResolve: false, stage: 'PlanReview', planProceeded: false, rounds: ['done'] });
    const replay = (roundsAtOpen: number) =>
      value.harness.planReviewGates.update(gate.id, { status: 'reviewing', roundsAtOpen, decisionsJson: null });

    replay(1);
    const withBaseline = await value.gateService.reconcile(task.id);
    // Without the baseline the same read-back reads as a settled round; with it, nothing new happened.
    replay(0);
    const withoutBaseline = await value.gateService.reconcile(task.id);

    expect(withBaseline.status).toBe('reviewing');
    expect(withBaseline.lastError).toMatch(/beyond the ones the session already held/);
    expect(withoutBaseline.status).toBe('changes_requested');
  });
});

describe('implementation cannot start on a plan that has no successful review', () => {
  async function refused(value: CoaiScenario) {
    const task = await untilCorrectedReview(value, {
      onReview: () => {
        if (value.reviewer.reviewCalls.length === 2) {
          value.reviewer.seed(value.reviewer.reviewCalls[1]!.subject, { stage: 'CodeReview', planProceeded: true });
        }
      }
    });
    await outcomeOf(drive(value, task.id));
    return task;
  }

  it('refuses approval, implementation and verification while the corrected plan is unreviewed — with no renderer involved', async () => {
    const value = coaiScenario();
    const task = await refused(value);

    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(value.harness.orchestrator.runVerification(task.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(value.harness.claude.calls).toHaveLength(0);
    expect(value.harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();
  });

  it('refuses even a specification whose approval is on record, because the evidence behind it is not the corrected plan’s', async () => {
    const value = coaiScenario();
    const task = await refused(value);
    // An approval that was somehow granted (an older build, a restored row): the backend still asks for the review.
    value.harness.tasks.update(task.id, { specificationApprovedAt: '2026-09-20T00:00:00.000Z' });

    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(value.harness.claude.calls).toHaveLength(0);
  });

  it('refuses a gate that was settled by reading another review’s session — the state the defect could leave behind', async () => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    seedLegacyStuckGate(value, task.id, 'proceeded');
    value.harness.tasks.update(task.id, { specificationApprovedAt: '2026-09-20T00:00:00.000Z' });

    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/different review/i);
    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(value.harness.claude.calls).toHaveLength(0);
  });
});

describe('recovering a gate an earlier build left stuck', () => {
  /** The defect's durable state, reached by driving the loop and then writing what the old code wrote. */
  async function stuck(value: CoaiScenario, status: 'reviewing' | 'proceeded' = 'reviewing') {
    const task = await untilCorrectedReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    seedLegacyStuckGate(value, task.id, status);
    return task;
  }

  it('replaces it under a fresh identity without editing the database, and reviews the same specification', async () => {
    const value = coaiScenario();
    const task = await stuck(value);
    const [first, legacy] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];
    const specificationBefore = specOf(value, task.id);
    const shaBefore = specificationIdentity(specificationBefore).sha256;
    // The loop sees the state for what it is and asks a person, rather than reconciling another review.
    expect((await drive(value, task.id)).stopped).toBe('recovery_required');
    const detailBefore = value.harness.planReviewGates.findById(legacy.id)!;

    const fresh = await value.gateService.retryInFreshSession(task.id);

    // The failed attempt and its error text are kept exactly; only the pointer to its replacement is new.
    expect(value.harness.planReviewGates.findById(legacy.id)).toMatchObject({
      status: 'reviewing',
      sessionId: first.sessionId,
      lastError: detailBefore.lastError,
      supersededBy: fresh.id
    });
    // Same specification, same hash, nothing approved, nothing started.
    expect(specOf(value, task.id)).toBe(specificationBefore);
    expect(fresh.specificationSha256).toBe(shaBefore);
    expect(value.harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();
    expect(value.harness.claude.calls).toHaveLength(0);
    expect(statusOf(value, task.id)).toBe('READY_FOR_IMPLEMENTATION');

    // The review passes in a session of its own, and only then can the specification be approved.
    value.reviewer.roundQueue = [roundOf(value, [], 'proceed')];
    const reviewed = await value.gateService.review(task.id);
    expect(reviewed.status).toBe('awaiting_resolve');
    expect(reviewed.sessionId).not.toBe(first.sessionId);
    expect(reviewed.sessionId).not.toBeNull();
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
    await value.gateService.resolve(task.id, { gateId: reviewed.id, expectedRevision: reviewed.revision, decisions: [] });
    expect(currentGate(value, task.id).status).toBe('proceeded');
    expect(value.harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });

  it('withdraws an approval that rested on the evidence it discards, and still starts nothing', async () => {
    const value = coaiScenario();
    const task = await stuck(value, 'proceeded');
    value.harness.tasks.update(task.id, { specificationApprovedAt: '2026-09-20T00:00:00.000Z' });

    await value.gateService.retryInFreshSession(task.id);

    expect(value.harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();
    expect(value.harness.claude.calls).toHaveLength(0);
    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('refuses when nothing proves the attempt is spent, or the specification moved', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    // A healthy gate awaiting decisions is the provider's own round: never replaced.
    await expect(value.gateService.retryInFreshSession(task.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(gatesOf(value, task.id)).toHaveLength(1);

    const stuckValue = coaiScenario();
    const stuckTask = await stuck(stuckValue);
    // The specification changed after the review: a fresh session for it is prepared the ordinary way.
    stuckValue.harness.tasks.update(stuckTask.id, {
      specificationJson: JSON.stringify({ ...JSON.parse(specOf(stuckValue, stuckTask.id)), summary: 'A different plan.' })
    });
    await expect(stuckValue.gateService.retryInFreshSession(stuckTask.id)).rejects.toThrow(/specification changed/);
    expect(gatesOf(stuckValue, stuckTask.id)).toHaveLength(2);
  });

  it('lets a regenerated specification be prepared over a gate that cannot count, instead of trapping the task', async () => {
    const value = coaiScenario();
    const task = await stuck(value);
    value.harness.tasks.update(task.id, {
      specificationJson: JSON.stringify({ ...JSON.parse(specOf(value, task.id)), summary: 'Regenerated.' }),
      specificationApprovedAt: null
    });

    const prepared = value.gateService.prepare(task.id);

    expect(prepared.status).toBe('prepared');
    expect(gatesOf(value, task.id)).toHaveLength(3);
  });

  it('is single-use: an attempt already replaced cannot be replaced again', async () => {
    const value = coaiScenario();
    const task = await stuck(value);
    await value.gateService.retryInFreshSession(task.id);
    const [, legacy] = gatesOf(value, task.id) as [PlanReviewGate, PlanReviewGate];

    expect(() =>
      value.harness.planReviewGates.supersede(legacy.id, { ...value.harness.planReviewGates.findById(legacy.id)!, id: 'again' })
    ).toThrow(/already replaced/);
    expect(gatesOf(value, task.id).some((gate) => gate.id === 'again')).toBe(false);
  });
});

describe('Stop task during the corrected review', () => {
  it('aborts the creation of the review identity, and writes nothing for the gate', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    const hold = deferred();
    value.subjects.gate = hold.promise;

    const running = outcomeOf(drive(value, task.id));
    await until(() => value.subjects.requests.length === 1, 'the subject to be requested');
    value.harness.orchestrator.stop(task.id);
    expect(value.subjects.signals[0]?.aborted).toBe(true);
    hold.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    const corrected = gatesOf(value, task.id)[1]!;
    expect(corrected.reviewSubject).toBeNull();
    expect(corrected.status).toBe('prepared');
    expect(value.reviewer.openCalls).toHaveLength(1);
    expect(statusOf(value, task.id)).toBe('CANCELLED');
    expect(value.harness.operations.isActive(task.id)).toBe(false);
  });

  it('aborts the review in flight, and a result that arrives afterwards is not applied', async () => {
    const value = coaiScenario();
    const task = await afterFirstReview(value);
    const round = deferred();
    value.reviewer.reviewGate = round.promise;

    const running = outcomeOf(drive(value, task.id));
    await until(() => value.reviewer.reviewCalls.length === 2, 'the corrected review to reach the provider');
    value.harness.orchestrator.stop(task.id);
    expect(value.reviewer.signals.review[1]?.aborted).toBe(true);
    round.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    // The round may have run: it is an unknown outcome, never a result — no findings, no verdict.
    const corrected = gatesOf(value, task.id)[1]!;
    expect(corrected.status).toBe('reviewing');
    expect(corrected.findingsJson).toBeNull();
    expect(corrected.verdict).toBeNull();
    expect(statusOf(value, task.id)).toBe('CANCELLED');
  });

  it('aborts a fresh-session retry while its identity is being made, and replaces nothing', async () => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value);
    value.reviewer.openError = new Error('the network went away');
    await expect(drive(value, task.id)).rejects.toThrow();
    value.reviewer.openError = null;
    seedLegacyStuckGate(value, task.id);
    const hold = deferred();
    value.subjects.gate = hold.promise;
    const before = value.subjects.requests.length;

    const running = outcomeOf(value.gateService.retryInFreshSession(task.id));
    await until(() => value.subjects.requests.length === before + 1, 'the subject to be requested');
    value.harness.orchestrator.stop(task.id);
    hold.resolve(undefined);

    expect(await running).toMatchObject({ code: 'CANCELLED' });
    expect(gatesOf(value, task.id)).toHaveLength(2);
    expect(gatesOf(value, task.id).every((gate) => gate.supersededBy === null)).toBe(true);
  });
});

describe('the Coai contract during the corrected review', () => {
  it('flags a contract that changed between the first review and the corrected one, and stops the loop for a person', async () => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value, {
      onOpen: () => {
        if (value.reviewer.openCalls.length === 2) value.reviewer.contractFingerprint = 'e'.repeat(64);
      }
    });

    const outcome = await drive(value, task.id);

    expect(outcome.stopped).toBe('contract_drift');
    const corrected = gatesOf(value, task.id)[1]!;
    expect(corrected.contractMismatchAt).not.toBeNull();
    // Nothing was decided or approved on the strength of a contract nobody agreed to.
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/plan review/i);
  });

  it('refuses a round produced under a contract that changed while it ran, and keeps the gate unresolved', async () => {
    const value = coaiScenario();
    const task = await untilCorrectedReview(value, {
      onReview: () => {
        if (value.reviewer.reviewCalls.length === 2) value.reviewer.contractFingerprint = 'd'.repeat(64);
      }
    });

    await expect(drive(value, task.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const corrected = gatesOf(value, task.id)[1]!;
    expect(corrected.status).toBe('reviewing');
    expect(corrected.contractMismatchAt).not.toBeNull();
    expect(corrected.lastError).toMatch(/contract changed partway/);
    expect(corrected.findingsJson).toBeNull();
  });
});
