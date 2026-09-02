/**
 * The publish gate's evidence check.
 *
 * Codex approving a diff means a reviewer read the change. It does not mean the
 * change was ever run. These tests cover the second question: the most recent
 * Claude round has to have shown that it verified its work before anything can
 * be committed, pushed or opened as a pull request.
 *
 * Every case here has a granted approval and a passing review — the gate under
 * test is the one *after* those.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_ASSESSMENT_VERSION } from '../../src/shared/domain/claude-assessment';
import { InvalidTransitionError } from '../../src/shared/domain/errors';
import { createHarness, type Harness } from '../helpers/harness';
import {
  READY_TO_PUBLISH_CASES,
  storedAssessment
} from '../helpers/ready-to-publish-cases';
import { makeReview, passingToolExecution, passingVerificationEvidence } from '../helpers/fakes';

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ confirmAnswer: true });
});

afterEach(() => {
  harness.dispose();
});

/** Drive a task all the way to "the user pressed Approve for publishing". */
async function readyToPublish(): Promise<string> {
  const project = harness.createProject();
  const created = harness.createTask(project.id);

  await harness.orchestrator.generateSpecification(created.id);
  harness.orchestrator.approveSpecification(created.id);
  await harness.orchestrator.sendToClaude(created.id);

  harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
  await harness.orchestrator.reviewWithCodex(created.id);
  harness.orchestrator.approveForPublishing(created.id);

  return created.id;
}

/**
 * Overwrite what the latest implementation round recorded about itself.
 *
 * Written with SQL rather than through the repository because `finish()`
 * coalesces a null structured result to the existing one — sensible for a real
 * finish, useless for modelling a run that never recorded a verdict.
 */
function rewriteAssessment(taskId: string, structuredResult: string | null): void {
  const run = harness.runs.findLatestByType(taskId, 'implementation');
  if (!run) throw new Error('no implementation run');

  harness.db
    .prepare('UPDATE runs SET structured_result = ? WHERE id = ?')
    .run(structuredResult, run.id);
}

const commit = (taskId: string) =>
  harness.publishService.execute({
    taskId,
    action: 'commit',
    commitMessage: 'Add a health endpoint'
  });

/* -------------------------------------------------------------------------- */

describe('publishing a verified round', () => {
  it('is permitted when the round passed, the review approved, and the user agreed', async () => {
    const taskId = await readyToPublish();

    const outcome = await commit(taskId);

    expect(outcome.performed).toBe(true);
    expect(harness.git.commits).toHaveLength(1);
  });

  it('still requires the confirmation dialog', async () => {
    harness.confirmation.setAnswer(false);
    const taskId = await readyToPublish();

    const outcome = await commit(taskId);

    expect(outcome.performed).toBe(false);
    expect(harness.git.commits).toHaveLength(0);
  });
});

describe('publishing a round that proved nothing', () => {
  it('is refused when verification failed', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ isError: true })]
    });
    const taskId = await readyToPublish();

    await expect(commit(taskId)).rejects.toThrow(/did not pass verification/i);
    expect(harness.git.commits).toHaveLength(0);
  });

  it('is refused when a security-critical command was blocked', async () => {
    // The round still has to reach review, so it must not be a hard failure —
    // rewrite the stored verdict to the one a security denial produces.
    const taskId = await readyToPublish();
    rewriteAssessment(
      taskId,
      JSON.stringify({
        assessment: {
          version: CLAUDE_ASSESSMENT_VERSION,
          disposition: 'fail',
          verificationStatus: 'passed',
          publishBlock: 'security',
          reasonCodes: ['security_denial'],
          verification: null,
          denials: []
        }
      })
    );

    await expect(commit(taskId)).rejects.toThrow(/security-critical command/i);
  });

  it('is refused when the telemetry was ambiguous', async () => {
    const taskId = await readyToPublish();
    rewriteAssessment(
      taskId,
      JSON.stringify({
        assessment: {
          version: CLAUDE_ASSESSMENT_VERSION,
          disposition: 'fail',
          verificationStatus: 'unknown',
          publishBlock: 'telemetry',
          reasonCodes: ['verification_unknown'],
          verification: null,
          denials: []
        }
      })
    );

    await expect(commit(taskId)).rejects.toThrow(/ambiguous evidence/i);
  });

  it('is refused when the configuration could not be used', async () => {
    const taskId = await readyToPublish();
    rewriteAssessment(
      taskId,
      JSON.stringify({
        assessment: {
          version: CLAUDE_ASSESSMENT_VERSION,
          disposition: 'fail',
          verificationStatus: 'unknown',
          publishBlock: 'configuration',
          reasonCodes: ['configuration_invalid'],
          verification: null,
          denials: []
        }
      })
    );

    await expect(commit(taskId)).rejects.toThrow(/verification settings were unusable/i);
  });
});

describe('publishing a round with no usable record', () => {
  it('is refused for a task from before verification tracking', async () => {
    const taskId = await readyToPublish();
    // What an older build wrote: turn count and session id, nothing else.
    rewriteAssessment(taskId, JSON.stringify({ numTurns: 3, sessionId: 'claude-session-1' }));

    await expect(commit(taskId)).rejects.toThrow(/predates verification tracking/i);
    expect(harness.git.commits).toHaveLength(0);
  });

  it('does not reconstruct a verdict from the final message', async () => {
    const taskId = await readyToPublish();
    const run = harness.runs.findLatestByType(taskId, 'implementation');

    // The prose could not be more encouraging, and it counts for nothing: a
    // final message is what the model said about itself, not evidence.
    harness.runs.finish(run?.id ?? '', {
      status: 'succeeded',
      finishedAt: harness.clock.nowIso(),
      finalMessage: 'All tests passed. 2 passing, 0 failing. Verification complete.',
      structuredResult: JSON.stringify({ numTurns: 3, sessionId: 'claude-session-1' }),
      errorMessage: null
    });

    await expect(commit(taskId)).rejects.toThrow(/predates verification tracking/i);
  });

  it('is refused when the record cannot be parsed', async () => {
    const taskId = await readyToPublish();
    rewriteAssessment(taskId, '{ not json at all');

    await expect(commit(taskId)).rejects.toThrow(/could not be read/i);
  });

  it('is refused when the record has an unknown shape', async () => {
    const taskId = await readyToPublish();
    rewriteAssessment(taskId, JSON.stringify({ assessment: { version: 1, disposition: 'yes' } }));

    await expect(commit(taskId)).rejects.toThrow(/could not be read/i);
  });

  it('is refused when the record came from a newer version', async () => {
    const taskId = await readyToPublish();
    rewriteAssessment(
      taskId,
      JSON.stringify({ assessment: { version: 2, disposition: 'pass', publishBlock: 'none' } })
    );

    await expect(commit(taskId)).rejects.toThrow(/newer version of Agent Relay/i);
  });
});

describe('recovering from a refused publish', () => {
  /**
   * The real path, end to end.
   *
   * A reviewer reads a change and approves it; the publish gate then refuses it
   * because the tests failed. Without a way out this is a dead end — the code is
   * probably fine and needs one more round, but "Send corrections" was only
   * reachable from CHANGES_REQUESTED, and a task in READY_TO_PUBLISH could only
   * be cancelled.
   *
   * Deliberately not simulated with a `changes_requested` verdict: the whole
   * difficulty is that the reviewer was *happy*.
   */
  it('lets a blocked task run another round, and requires a fresh approval after it', async () => {
    const project = harness.createProject();
    const created = harness.createTask(project.id);

    // Round one: the checks ran and failed. It still reaches the reviewer — a
    // failing test run is something worth reading — and the reviewer approves.
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ isError: true })]
    });
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    const blocked = harness.runs.findLatestByType(created.id, 'implementation');
    expect(blocked?.structuredResult).toContain('"publishBlock":"verification"');

    harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
    await harness.orchestrator.reviewWithCodex(created.id);
    harness.orchestrator.approveForPublishing(created.id);
    expect(harness.tasks.findById(created.id)?.status).toBe('READY_TO_PUBLISH');

    // The gate refuses, even with the approval in hand.
    await expect(commit(created.id)).rejects.toThrow(/did not pass verification/i);
    expect(harness.git.commits).toHaveLength(0);

    // Recovery: another round, from the blocked state, on the same session.
    harness.claude.evidence = passingVerificationEvidence();
    const afterRetry = await harness.orchestrator.sendCorrections(created.id);

    expect(afterRetry.status).toBe('READY_FOR_REVIEW');
    expect(harness.claude.calls[1]?.sessionId).toBe('claude-session-1');
    expect(harness.claude.calls[1]?.model).toBe(harness.claude.calls[0]?.model);
    // The prompt says why, without inventing review findings to act on.
    expect(harness.claude.calls[1]?.prompt).toContain('reviewed and approved');
    expect(harness.claude.calls[1]?.prompt).toContain('verification');

    // The old approval is not enough: publishing needs a new review first.
    await expect(commit(created.id)).rejects.toThrow();

    harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
    await harness.orchestrator.reviewWithCodex(created.id);
    expect(harness.tasks.findById(created.id)?.status).toBe('APPROVED');

    // …and a new explicit publish approval.
    harness.orchestrator.approveForPublishing(created.id);
    const outcome = await commit(created.id);

    expect(outcome.performed).toBe(true);
    expect(harness.git.commits).toHaveLength(1);

    // The blocked round is still in the history; nothing was rewritten.
    const stillThere = harness.runs.findById(blocked?.id ?? '');
    expect(stillThere?.structuredResult).toContain('"publishBlock":"verification"');
    expect(stillThere?.status).toBe('succeeded');
  });

  it('still refuses when the recovery round is no better', async () => {
    const project = harness.createProject();
    const created = harness.createTask(project.id);

    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ isError: true })]
    });
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
    await harness.orchestrator.reviewWithCodex(created.id);
    harness.orchestrator.approveForPublishing(created.id);
    await expect(commit(created.id)).rejects.toThrow(/did not pass verification/i);

    // Same failure again.
    await harness.orchestrator.sendCorrections(created.id);
    harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
    await harness.orchestrator.reviewWithCodex(created.id);
    harness.orchestrator.approveForPublishing(created.id);

    await expect(commit(created.id)).rejects.toThrow(/did not pass verification/i);
    expect(harness.git.commits).toHaveLength(0);
  });

  it('refuses to publish a round whose record has a gap in it', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [
        passingToolExecution(),
        passingToolExecution({
          toolUseId: 'open',
          toolUseSequence: 2,
          tool: 'Read',
          command: null,
          resultReceived: false,
          isError: null
        })
      ],
      incompleteToolUseCount: 1
    });

    const project = harness.createProject();
    const created = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);

    // The round fails outright, so it never reaches a publishable state at all.
    await harness.orchestrator.sendToClaude(created.id);

    const run = harness.runs.findLatestByType(created.id, 'implementation');
    expect(run?.status).toBe('failed');
    expect(run?.structuredResult).toContain('"publishBlock":"telemetry"');
    expect(harness.tasks.findById(created.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
  });
});

/* -------------------------------------------------------------------------- */
/* The recovery gate, in the main process                                      */
/* -------------------------------------------------------------------------- */

/**
 * The button and the API must agree about when another round is allowed.
 *
 * The renderer disabling a button is a courtesy; `sendCorrections` is callable
 * without it. Before this gate, calling it on a task that was clear to publish
 * started a pointless Claude round, spent a slice of the round budget and moved
 * the task out of READY_TO_PUBLISH — undoing an approval the user had given.
 *
 * These walk the same rows the unit tests do, so the two sides cannot drift.
 */
describe('starting another round from a task waiting to publish', () => {
  const readyWithAssessment = async (structuredResult: string | null): Promise<string> => {
    const taskId = await readyToPublish();
    rewriteAssessment(taskId, structuredResult);
    return taskId;
  };

  it.each(READY_TO_PUBLISH_CASES.filter((row) => row.kind === 'retry_verification'))(
    'allows a recovery round when the record shows $name',
    async (row) => {
      const taskId = await readyWithAssessment(row.structuredResult);
      const before = harness.tasks.findById(taskId);

      const after = await harness.orchestrator.sendCorrections(taskId);

      expect(after.status).toBe('READY_FOR_REVIEW');
      expect(after.currentRound).toBe((before?.currentRound ?? 0) + 1);
      expect(harness.runs.findLatestByType(taskId, 'correction')).not.toBeNull();
    }
  );

  it.each(READY_TO_PUBLISH_CASES.filter((row) => row.kind === 'unavailable'))(
    'refuses a recovery round when the record shows $name',
    async (row) => {
      const taskId = await readyWithAssessment(row.structuredResult);
      const before = harness.tasks.findById(taskId);
      const runsBefore = harness.runs.listByTask(taskId).length;
      const callsBefore = harness.claude.calls.length;

      await expect(harness.orchestrator.sendCorrections(taskId)).rejects.toThrow(
        InvalidTransitionError
      );

      // Refused before anything moved: no transition, no spent round, no run
      // row, no Claude process, and the approval the user gave still stands.
      const after = harness.tasks.findById(taskId);
      expect(after?.status).toBe(before?.status);
      expect(after?.currentRound).toBe(before?.currentRound);
      expect(harness.runs.listByTask(taskId)).toHaveLength(runsBefore);
      expect(harness.claude.calls).toHaveLength(callsBefore);
      expect(harness.approvals.findGranted(taskId, 'commit')).toBeNull();
    }
  );

  it('still refuses once the round budget is spent', async () => {
    const taskId = await readyWithAssessment(storedAssessment('verification'));
    const task = harness.tasks.findById(taskId);
    harness.tasks.update(taskId, { currentRound: task?.maxRounds ?? 3 });

    await expect(harness.orchestrator.sendCorrections(taskId)).rejects.toThrow(
      /already used its .* review round/i
    );
    expect(harness.claude.calls).toHaveLength(1);
  });

  it('leaves a clean task publishable after the refusal', async () => {
    // The refusal must not be destructive: the user can still just publish.
    const taskId = await readyWithAssessment(storedAssessment('none'));

    await expect(harness.orchestrator.sendCorrections(taskId)).rejects.toThrow();

    const outcome = await commit(taskId);
    expect(outcome.performed).toBe(true);
  });
});

describe('starting another round after a review asked for changes', () => {
  it('does not consult the assessment at all', async () => {
    // Corrections are driven by the review. A clean assessment must not block
    // them, or a round whose tests passed could never be corrected.
    const project = harness.createProject();
    const created = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'Fix it.' })
    ];
    await harness.orchestrator.reviewWithCodex(created.id);

    const implementation = harness.runs.findLatestByType(created.id, 'implementation');
    expect(implementation?.structuredResult).toContain('"publishBlock":"none"');

    const after = await harness.orchestrator.sendCorrections(created.id);
    expect(after.status).toBe('READY_FOR_REVIEW');
  });

  it('still refuses once the round budget is spent', async () => {
    const project = harness.createProject();
    const created = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'Fix it.' })
    ];
    await harness.orchestrator.reviewWithCodex(created.id);

    const task = harness.tasks.findById(created.id);
    harness.tasks.update(created.id, { currentRound: task?.maxRounds ?? 3 });

    await expect(harness.orchestrator.sendCorrections(created.id)).rejects.toThrow(
      /already used its .* review round/i
    );
  });
});
