import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessResult } from '../../src/main/adapters/process/process-runner';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import { ContinuationService, reconcileContinuationClaims } from '../../src/main/services/continuation-service';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';
import { createHarness, runToFailedRoundExhaustion, type Harness } from '../helpers/harness';
import { makeReview } from '../helpers/fakes';
import { runGuidance } from '../../src/shared/domain/run-guidance';

let harness: Harness;
let identity: string;
let verificationCalls: number;
let flipAfterNextIdentity: boolean;
let verificationExecutor: VerificationExecutor;

const passed: ProcessResult = {
  command: 'npm run verify', exitCode: 0, stdout: 'ok', stderr: '', failed: false,
  timedOut: false, cancelled: false, durationMs: 4
};

beforeEach(() => {
  identity = 'a'.repeat(64);
  verificationCalls = 0;
  flipAfterNextIdentity = false;
  verificationExecutor = {
    identity: async () => {
      const observed = identity;
      if (flipAfterNextIdentity) {
        flipAfterNextIdentity = false;
        identity = 'b'.repeat(64);
      }
      return observed;
    },
    execute: async () => { verificationCalls += 1; return passed; }
  };
  harness = createHarness({ verification: verificationExecutor, settings: { maxReviewRounds: 3 } });
});

afterEach(() => harness.dispose());

function anotherContinuationService(verification: VerificationExecutor = verificationExecutor) {
  return new ContinuationService({
    tasks: harness.tasks,
    projects: harness.projects,
    runs: harness.runs,
    settings: harness.settings,
    ruleEvidence: harness.taskRuleEvidence,
    planReviews: harness.planReviewGates,
    continuations: harness.taskContinuations,
    transactions: new SqliteTransactionRunner(harness.db),
    verification,
    clock: harness.clock,
    ids: harness.ids,
    events: harness.events,
    isSourceBusy: () => false
  });
}

function setInheritedPublishBlock(taskId: string, publishBlock: 'verification' | 'security'): void {
  const run = harness.runs.findLatestByType(taskId, 'implementation');
  if (!run?.structuredResult) throw new Error('implementation assessment missing');
  const stored = JSON.parse(run.structuredResult) as Record<string, unknown>;
  const assessment = ('assessment' in stored ? stored['assessment'] : stored) as Record<string, unknown>;
  const changed = {
    ...assessment,
    disposition: publishBlock === 'security' ? 'fail' : 'warn',
    verificationStatus: publishBlock === 'verification' ? 'failed' : assessment['verificationStatus'],
    publishBlock
  };
  harness.runs.finish(run.id, {
    status: run.status,
    finishedAt: run.finishedAt ?? harness.clock.nowIso(),
    structuredResult: JSON.stringify('assessment' in stored ? { ...stored, assessment: changed } : changed)
  });
}

describe('safe linked continuations', () => {
  it('atomically creates one linked corrections run without changing source history or starting work', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const sourceBefore = harness.tasks.findById(source.id);
    const runsBefore = harness.runs.listByTask(source.id);
    const implementationCalls = harness.claude.calls.length;
    const reviewCalls = harness.codex.reviewCalls.length;

    const [first, second] = await Promise.all([
      harness.continuationService.create(source.id),
      harness.continuationService.create(source.id)
    ]);

    expect(second.task.id).toBe(first.task.id);
    expect(first.task).toMatchObject({
      status: 'CHANGES_REQUESTED', currentRound: 0, maxRounds: 3,
      worktreePath: source.worktreePath, branchName: source.branchName,
      baseBranch: source.baseBranch, specificationJson: source.specificationJson,
      specificationApprovedAt: source.specificationApprovedAt,
      implementationProvider: source.implementationProvider,
      reviewProvider: source.reviewProvider,
      providerRevision: source.providerRevision,
      claudeSessionId: source.claudeSessionId,
      implementationThreadId: source.implementationThreadId
    });
    expect(first.continuation.entryAction).toBe('corrections');
    expect(harness.runs.listByTask(first.task.id)).toEqual([]);
    expect(harness.tasks.findById(source.id)).toEqual(sourceBefore);
    expect(harness.runs.listByTask(source.id)).toEqual(runsBefore);
    expect(harness.claude.calls).toHaveLength(implementationCalls);
    expect(harness.codex.reviewCalls).toHaveLength(reviewCalls);
    expect(harness.taskContinuations.findClaimByContinuation(first.task.id)).toMatchObject({
      state: 'awaiting_first_action', effectiveEntryAction: 'corrections'
    });

    const sourceDetail = harness.taskService.detail(source.id);
    const continuationDetail = harness.taskService.detail(first.task.id);
    expect(sourceDetail.continuedAs?.taskId).toBe(first.task.id);
    expect(sourceDetail.continuationCreationStatus).toBe('ready');
    expect(continuationDetail.continuationOf?.taskId).toBe(source.id);
    expect(continuationDetail.continuationEntryAction).toBe('corrections');
  });

  it('selects verification when inherited evidence is stale and starts nothing automatically', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    identity = 'b'.repeat(64);
    const created = await harness.continuationService.create(source.id);
    expect(created.task.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(created.continuation).toMatchObject({
      entryAction: 'verification', inheritedVerificationRunId: null
    });
    expect(verificationCalls).toBe(1);
    expect(harness.runs.listByTask(created.task.id)).toEqual([]);
  });

  it('does not let specification regeneration bypass a required verification first action', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    identity = 'b'.repeat(64);
    const created = await harness.continuationService.create(source.id);
    const beforeTask = harness.tasks.findById(created.task.id);
    const beforeRuns = harness.runs.listByTask(created.task.id);
    const specificationCalls = harness.codex.specificationCalls.length;

    await expect(harness.orchestrator.generateSpecification(created.task.id)).rejects.toThrow(/verification/i);

    expect(harness.tasks.findById(created.task.id)).toEqual(beforeTask);
    expect(harness.runs.listByTask(created.task.id)).toEqual(beforeRuns);
    expect(harness.codex.specificationCalls).toHaveLength(specificationCalls);
    expect(harness.taskContinuations.findClaimByContinuation(created.task.id)).toMatchObject({
      effectiveEntryAction: 'verification'
    });
  });

  it('lets independent service instances follow a durable owner beyond the former two-second timeout', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    let entered!: () => void;
    let release!: () => void;
    const identityStarted = new Promise<void>((resolve) => { entered = resolve; });
    const identityGate = new Promise<void>((resolve) => { release = resolve; });
    let identityCalls = 0;
    const delayedVerification: VerificationExecutor = {
      identity: async () => {
        identityCalls += 1;
        if (identityCalls === 1) {
          entered();
          await identityGate;
        }
        return identity;
      },
      execute: verificationExecutor.execute
    };
    const firstService = anotherContinuationService(delayedVerification);
    const secondService = anotherContinuationService(delayedVerification);

    vi.useFakeTimers();
    try {
      const first = firstService.create(source.id);
      await identityStarted;
      let secondSettled = false;
      const second = secondService.create(source.id).then((result) => {
        secondSettled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(2_100);
      expect(secondSettled).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(100);

      const [created, followed] = await Promise.all([first, second]);
      expect(followed.task.id).toBe(created.task.id);
      expect(harness.taskContinuations.findBySource(source.id)?.continuationTaskId).toBe(created.task.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries durable acquisition when the first owner releases its failed claim', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    let entered!: () => void;
    let release!: () => void;
    const identityStarted = new Promise<void>((resolve) => { entered = resolve; });
    const identityGate = new Promise<void>((resolve) => { release = resolve; });
    let identityCalls = 0;
    const flakyVerification: VerificationExecutor = {
      identity: async () => {
        identityCalls += 1;
        if (identityCalls === 1) {
          entered();
          await identityGate;
          throw new Error('synthetic identity read failed');
        }
        return identity;
      },
      execute: verificationExecutor.execute
    };
    const firstService = anotherContinuationService(flakyVerification);
    const secondService = anotherContinuationService(flakyVerification);

    const first = firstService.create(source.id);
    await identityStarted;
    const second = secondService.create(source.id);
    release();

    await expect(first).rejects.toThrow(/synthetic identity read failed/);
    const recovered = await second;
    expect(harness.taskContinuations.findBySource(source.id)?.continuationTaskId).toBe(recovered.task.id);
    expect(identityCalls).toBeGreaterThanOrEqual(3);
  });

  it('revalidates identity at the creation boundary before returning an entry action', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    flipAfterNextIdentity = true;

    const created = await harness.continuationService.create(source.id);

    expect(created.task.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(created.continuation).toMatchObject({
      entryAction: 'verification', inheritedVerificationRunId: null,
      inheritedReviewRunId: null
    });
    expect(harness.taskService.detail(created.task.id).continuationEntryAction).toBe('verification');
    expect(harness.codex.reviewCalls).toHaveLength(1); // source review only
  });

  it('selects review when a newer reusable verification supersedes the changes-requested review', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    harness.clock.advance(1);
    const verification = harness.runs.create({
      id: 'post-review-verification', taskId: source.id, agent: 'system',
      runType: 'verification', status: 'running', round: source.currentRound,
      startedAt: harness.clock.nowIso()
    });
    harness.runs.finish(verification.id, {
      status: 'succeeded', finishedAt: harness.clock.nowIso(),
      structuredResult: JSON.stringify({
        version: 1, command: 'npm run verify', identity, passed: true,
        exitCode: 0, durationMs: 1, reason: null
      })
    });

    const created = await harness.continuationService.create(source.id);
    expect(created.task.status).toBe('READY_FOR_REVIEW');
    expect(created.continuation).toMatchObject({
      entryAction: 'review', inheritedVerificationRunId: verification.id,
      inheritedReviewRunId: null
    });
  });

  it('retargets to verification if files change while the durable first-action lease is held', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const created = await harness.continuationService.create(source.id);
    identity = 'c'.repeat(64);

    await expect(harness.orchestrator.sendCorrections(created.task.id)).rejects.toThrow(/Run verification/);
    expect(harness.claude.calls).toHaveLength(1); // source implementation only
    expect(harness.tasks.findById(created.task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(harness.taskService.detail(created.task.id).continuationEntryAction).toBe('verification');

    const verified = await harness.orchestrator.runVerification(created.task.id);
    expect(verified.status).toBe('READY_FOR_REVIEW');
    expect(harness.taskContinuations.findClaimByContinuation(created.task.id)).toBeNull();
  });

  it('atomically retargets a stale review entry and permits verification without reviewer dispatch', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    harness.clock.advance(1);
    const verification = harness.runs.create({
      id: 'review-entry-verification', taskId: source.id, agent: 'system',
      runType: 'verification', status: 'running', round: source.currentRound,
      startedAt: harness.clock.nowIso()
    });
    harness.runs.finish(verification.id, {
      status: 'succeeded', finishedAt: harness.clock.nowIso(),
      structuredResult: JSON.stringify({
        version: 1, command: 'npm run verify', identity, passed: true,
        exitCode: 0, durationMs: 1, reason: null
      })
    });
    const created = await harness.continuationService.create(source.id);
    expect(created.task.status).toBe('READY_FOR_REVIEW');
    const reviewCalls = harness.codex.reviewCalls.length;
    identity = 'c'.repeat(64);

    await expect(harness.orchestrator.reviewWithCodex(created.task.id)).rejects.toThrow(/Run verification/);

    expect(harness.codex.reviewCalls).toHaveLength(reviewCalls);
    expect(harness.tasks.findById(created.task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(harness.taskContinuations.findClaimByContinuation(created.task.id)).toMatchObject({
      effectiveEntryAction: 'verification', validatedIdentity: identity
    });
    expect(harness.taskService.detail(created.task.id).continuationEntryAction).toBe('verification');
    await expect(harness.orchestrator.runVerification(created.task.id)).resolves.toMatchObject({
      status: 'READY_FOR_REVIEW'
    });
    expect(harness.taskContinuations.findClaimByContinuation(created.task.id)).toBeNull();
  });

  it('allows an exhausted continuation to form the next immutable link in a chain', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const first = await harness.continuationService.create(source.id);
    for (let round = 1; round <= 3; round += 1) {
      await harness.orchestrator.sendCorrections(first.task.id);
      await harness.orchestrator.runVerification(first.task.id);
      harness.codex.reviewQueue.push(makeReview({ verdict: 'changes_requested' }));
      await harness.orchestrator.reviewWithCodex(first.task.id);
    }
    expect(harness.tasks.findById(first.task.id)?.status).toBe('FAILED');

    const second = await harness.continuationService.create(first.task.id);
    expect(second.task.id).not.toBe(first.task.id);
    expect(harness.taskContinuations.findBySource(first.task.id)?.continuationTaskId).toBe(second.task.id);
    expect(harness.taskContinuations.findByContinuation(second.task.id)?.sourceTaskId).toBe(first.task.id);
    expect(harness.taskContinuations.findBySource(source.id)?.continuationTaskId).toBe(first.task.id);
  });

  it.each(['DRAFT', 'COMPLETED', 'CANCELLED'] as const)('rejects an ineligible %s source', async (status) => {
    const project = harness.createProject();
    const task = harness.createTask(project.id, { status });
    await expect(harness.continuationService.create(task.id)).rejects.toThrow(/failed task/);
    expect(harness.taskContinuations.findBySource(task.id)).toBeNull();
  });

  it('enforces one active owner for a shared worktree and releases the database claim at terminal state', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const created = await harness.continuationService.create(source.id);
    const competing = harness.createTask(source.projectId, { status: 'DRAFT' });
    expect(() => harness.tasks.update(competing.id, {
      status: 'READY_FOR_IMPLEMENTATION', worktreePath: source.worktreePath,
      branchName: source.branchName, baseBranch: source.baseBranch
    })).toThrow(/already owns this worktree/);

    harness.tasks.update(created.task.id, { status: 'FAILED' });
    expect(() => harness.tasks.update(competing.id, {
      status: 'READY_FOR_IMPLEMENTATION', worktreePath: source.worktreePath,
      branchName: source.branchName, baseBranch: source.baseBranch
    })).not.toThrow();
  });

  it('keeps every mutating workflow and publication entry closed on the terminal source', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    const created = await harness.continuationService.create(source.id);
    const snapshot = () => {
      const runs = harness.runs.listByTask(source.id);
      return {
        task: harness.tasks.findById(source.id),
        runs,
        events: runs.map((run) => [run.id, harness.runEvents.listByRun(run.id)] as const),
        approvals: harness.approvals.listByTask(source.id),
        ruleEvidence: harness.taskRuleEvidence.findByTask(source.id),
        planReview: harness.planReviewGates.findByTask(source.id)
      };
    };
    const before = snapshot();
    const specificationCalls = harness.codex.specificationCalls.length;

    await expect(harness.orchestrator.generateSpecification(source.id)).rejects.toThrow();
    expect(() => harness.orchestrator.approveSpecification(source.id)).toThrow();
    await expect(harness.orchestrator.preparePlanReviewWorktree(source.id)).rejects.toThrow();
    await expect(harness.orchestrator.sendToClaude(source.id)).rejects.toThrow();
    await expect(harness.orchestrator.runVerification(source.id)).rejects.toThrow();
    await expect(harness.orchestrator.reviewWithCodex(source.id)).rejects.toThrow();
    await expect(harness.orchestrator.sendCorrections(source.id)).rejects.toThrow();
    expect(() => harness.orchestrator.configureProviders({
      taskId: source.id, expectedRevision: source.providerRevision,
      implementationProvider: source.implementationProvider === 'claude' ? 'codex' : 'claude',
      reviewProvider: source.reviewProvider
    })).toThrow();
    expect(() => harness.orchestrator.approveForPublishing(source.id)).toThrow();
    expect(() => harness.orchestrator.stop(source.id)).toThrow();
    await expect(harness.publishService.execute({ taskId: source.id, action: 'commit' })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(harness.codex.specificationCalls).toHaveLength(specificationCalls);
    expect(harness.tasks.findById(created.task.id)?.status).toBe('CHANGES_REQUESTED');
  });

  it('uses inherited implementation evidence in READY_TO_PUBLISH guidance', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    harness.clock.advance(1);
    const verification = harness.runs.create({
      id: 'publish-entry-verification', taskId: source.id, agent: 'system',
      runType: 'verification', status: 'running', round: source.currentRound,
      startedAt: harness.clock.nowIso()
    });
    harness.runs.finish(verification.id, {
      status: 'succeeded', finishedAt: harness.clock.nowIso(),
      structuredResult: JSON.stringify({
        version: 1, command: 'npm run verify', identity, passed: true,
        exitCode: 0, durationMs: 1, reason: null
      })
    });
    const created = await harness.continuationService.create(source.id);
    harness.codex.reviewQueue.push(makeReview({ verdict: 'approved' }));
    const approved = await harness.orchestrator.reviewWithCodex(created.task.id);
    expect(approved.status).toBe('APPROVED');
    harness.orchestrator.approveForPublishing(created.task.id);

    const detail = harness.taskService.detail(created.task.id);
    expect(detail.task.status).toBe('READY_TO_PUBLISH');
    expect(detail.runs.some((run) => run.runType === 'implementation' || run.runType === 'correction')).toBe(false);
    expect(detail.effectivePublishRefusal).toBeNull();
    expect(runGuidance(
      detail.task, detail.runs, detail.specification !== null, false, 'not_required',
      { isContinuation: true, continuationEntryAction: detail.continuationEntryAction }
    ).action).toBeNull();
  });

  it('lets a current own verification supersede an inherited non-security refusal', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    setInheritedPublishBlock(source.id, 'verification');
    identity = 'b'.repeat(64);
    const created = await harness.continuationService.create(source.id);

    await harness.orchestrator.runVerification(created.task.id);
    harness.codex.reviewQueue.push(makeReview({ verdict: 'approved' }));
    await harness.orchestrator.reviewWithCodex(created.task.id);
    harness.orchestrator.approveForPublishing(created.task.id);

    expect(harness.taskService.detail(created.task.id).effectivePublishRefusal).toBeNull();
    await expect(harness.publishService.execute({
      taskId: created.task.id,
      action: 'commit',
      commitMessage: 'Complete linked continuation'
    })).resolves.toMatchObject({ performed: true });
  });

  it('does not let a later verification erase an inherited security refusal', async () => {
    const { task: source } = await runToFailedRoundExhaustion(harness);
    setInheritedPublishBlock(source.id, 'security');
    identity = 'b'.repeat(64);
    const created = await harness.continuationService.create(source.id);

    await harness.orchestrator.runVerification(created.task.id);
    harness.codex.reviewQueue.push(makeReview({ verdict: 'approved' }));
    await harness.orchestrator.reviewWithCodex(created.task.id);
    harness.orchestrator.approveForPublishing(created.task.id);

    expect(harness.taskService.detail(created.task.id).effectivePublishRefusal).toBe('security');
    await expect(harness.publishService.execute({
      taskId: created.task.id,
      action: 'commit',
      commitMessage: 'Must remain blocked'
    })).rejects.toThrow(/security/i);
    expect(harness.git.commits).toHaveLength(0);
  });

  it('reconciles an interrupted pre-commit claim without inventing a continuation', () => {
    const project = harness.createProject();
    const source = harness.createTask(project.id, { status: 'FAILED', worktreePath: 'C:/orphan' });
    harness.taskContinuations.acquireClaim({
      sourceTaskId: source.id, claimId: 'orphan-claim', worktreePath: 'C:/orphan'
    });
    expect(reconcileContinuationClaims({
      tasks: harness.tasks,
      continuations: harness.taskContinuations,
      transactions: new SqliteTransactionRunner(harness.db)
    })).toBe(1);
    expect(harness.taskContinuations.findClaimBySource(source.id)).toBeNull();
    expect(harness.taskContinuations.findBySource(source.id)).toBeNull();
  });
});
