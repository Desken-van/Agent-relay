import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { latestImplementationRoundResult } from '../../src/shared/domain/claude-assessment';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import { makeReview, passingVerificationEvidence } from '../helpers/fakes';

let h: Harness;
beforeEach(() => {
  h = createHarness({
    verification: {
      identity: async () => 'a'.repeat(64),
      execute: async () => ({
        command: 'npm run verify', exitCode: 0, stdout: 'passed', stderr: '', failed: false,
        timedOut: false, cancelled: false, durationMs: 10
      })
    }
  });
});
afterEach(() => h.dispose());
async function prepared() {
  const p = h.createProject(); const t = h.createTask(p.id);
  await h.orchestrator.generateSpecification(t.id); h.orchestrator.approveSpecification(t.id);
  return h.tasks.findById(t.id)!;
}
function select(id: string, implementationProvider: 'claude' | 'codex', reviewProvider: 'claude' | 'codex' = 'codex') {
  return h.orchestrator.configureProviders({ taskId: id, expectedRevision: h.tasks.findById(id)!.providerRevision, implementationProvider, reviewProvider });
}
describe('explicit provider routing', () => {
  it('migrates old tasks to Claude implementation and Codex review', async () => {
    expect(await prepared()).toMatchObject({ implementationProvider: 'claude', reviewProvider: 'codex', providerRevision: 0, implementationThreadId: null });
  });
  it('implements with Codex and reviews in a fresh Codex session without calling Claude', async () => {
    const t = await prepared(); select(t.id, 'codex');
    const implemented = await h.orchestrator.sendToClaude(t.id);
    expect(implemented.status).toBe('READY_FOR_REVIEW');
    expect(h.codex.implementationCalls[0]?.sessionId).toBeNull();
    const reviewed = await h.orchestrator.reviewWithCodex(t.id);
    expect(reviewed.status).toBe('APPROVED');
    expect(h.codex.reviewCalls[0]?.threadId).toBeNull();
    expect(reviewed.codexThreadId).toBe(t.codexThreadId);
    expect(reviewed.implementationThreadId).toBe('codex-implementation-1');
    expect(h.claude.calls).toHaveLength(0);
    expect(h.runs.listByTask(t.id).find(r => r.runType === 'implementation')?.agent).toBe('codex');
  });
  it('does not open review when automatic Relay verification confirms a real failure', async () => {
    h.dispose();
    h = createHarness({
      verification: {
        identity: async () => 'b'.repeat(64),
        execute: async () => ({
          command: 'npm run verify', exitCode: 1, stdout: 'one test failed', stderr: '',
          failed: true, timedOut: false, cancelled: false, durationMs: 10
        })
      }
    });
    const t = await prepared(); select(t.id, 'codex');
    h.codex.implementationResult = {
      sessionId: 'codex-implementation-1',
      finalMessage: 'Files saved; provider-side verification was unavailable.',
      assessment: {
        version: 1, disposition: 'fail', verificationStatus: 'failed', publishBlock: 'verification',
        reasonCodes: ['CODEX_VERIFICATION'], denials: [],
        verification: { tool: 'Codex', command: 'npm run verify', matchedRule: 'Bash(npm run verify *)', toolUseSequence: 1 }
      }
    };

    const implemented = await h.orchestrator.sendToClaude(t.id);

    expect(implemented).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 1 });
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'implementation')).toMatchObject({ status: 'succeeded' });
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'verification')).toMatchObject({ status: 'failed' });
    await expect(h.orchestrator.reviewWithCodex(t.id)).rejects.toThrow();
  });
  it('routes a review to Claude without resuming the implementation session', async () => {
    const t = await prepared(); select(t.id, 'claude', 'claude');
    await h.orchestrator.sendToClaude(t.id); await h.orchestrator.reviewWithCodex(t.id);
    expect(h.claude.reviewCalls[0]?.threadId).toBeNull();
    expect(h.codex.reviewCalls).toHaveLength(0);
  });
  it('preserves worktree, specification and round budget during explicit handoff', async () => {
    const t = await prepared(); await h.orchestrator.sendToClaude(t.id);
    const before = h.tasks.findById(t.id)!;
    const after = select(t.id, 'codex');
    expect(after).toMatchObject({ worktreePath: before.worktreePath, specificationJson: before.specificationJson, currentRound: before.currentRound, maxRounds: before.maxRounds, claudeSessionId: null, implementationThreadId: null });
    expect(h.db.prepare('SELECT * FROM task_provider_changes WHERE task_id = ?').all(t.id)).toHaveLength(1);
    expect(h.claude.calls).toHaveLength(1); expect(h.codex.implementationCalls).toHaveLength(0);
  });
  it('rejects stale selections and selections while a run is active', async () => {
    const t = await prepared(); select(t.id, 'codex');
    expect(() => h.orchestrator.configureProviders({ taskId: t.id, expectedRevision: 0, implementationProvider: 'claude', reviewProvider: 'codex' })).toThrow();
    h.tasks.update(t.id, { status: 'IMPLEMENTING' });
    expect(() => select(t.id, 'claude')).toThrow();
  });
  it('does not fall back to Claude after Codex fails and preserves the new thread', async () => {
    const t = await prepared(); select(t.id, 'codex');
    h.codex.implementationError = new AgentRelayError('TIMEOUT', 'timeout');
    await expect(h.orchestrator.sendToClaude(t.id)).rejects.toThrow('timeout');
    expect(h.tasks.findById(t.id)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', implementationThreadId: 'codex-implementation-1' });
    expect(h.claude.calls).toHaveLength(0);
    h.codex.implementationError = null; await h.orchestrator.sendToClaude(t.id);
    expect(h.codex.implementationCalls[1]?.sessionId).toBe('codex-implementation-1');
  });
  it('does not use an older Claude assessment after a newer Codex failure', () => {
    expect(latestImplementationRoundResult([
      { agent: 'claude', runType: 'implementation', structuredResult: 'old pass' },
      { agent: 'codex', runType: 'implementation', structuredResult: null }
    ])).toBeNull();
  });
  it('hands corrections to a new executor with the full specification and the same budget', async () => {
    const t = await prepared();
    await h.orchestrator.sendToClaude(t.id);
    h.codex.reviewQueue = [makeReview({ verdict: 'changes_requested', followUpPrompt: 'Add the missing test.' })];
    await h.orchestrator.reviewWithCodex(t.id);
    const before = h.tasks.findById(t.id)!;
    select(t.id, 'codex');
    const corrected = await h.orchestrator.sendCorrections(t.id);
    expect(corrected.status).toBe('READY_FOR_REVIEW');
    expect(corrected.currentRound).toBe(before.currentRound + 1);
    expect(corrected.maxRounds).toBe(before.maxRounds);
    expect(corrected.worktreePath).toBe(before.worktreePath);
    expect(h.codex.implementationCalls[0]?.sessionId).toBeNull();
    expect(h.codex.implementationCalls[0]?.prompt).toContain('Add a /health route');
    expect(h.codex.implementationCalls[0]?.prompt).toContain('Add the missing test.');
    expect(h.claude.calls).toHaveLength(1);
  });
  it('automatically verifies a saved but unverified Codex correction without spending another round', async () => {
    const t = await prepared(); select(t.id, 'codex');
    await h.orchestrator.sendToClaude(t.id);
    h.codex.reviewQueue = [makeReview({ verdict: 'changes_requested', followUpPrompt: 'Fix the race.' })];
    await h.orchestrator.reviewWithCodex(t.id);
    h.codex.implementationResult = {
      sessionId: 'codex-implementation-1',
      finalMessage: 'The correction was saved, but verification could not run in the sandbox.',
      assessment: {
        version: 1,
        disposition: 'fail',
        verificationStatus: 'failed',
        publishBlock: 'verification',
        reasonCodes: ['verification_failed'],
        denials: [],
        verification: {
          tool: 'Codex', command: 'npm run verify', matchedRule: 'Bash(npm run verify:*)', toolUseSequence: 1
        }
      }
    };

    const corrected = await h.orchestrator.sendCorrections(t.id);

    expect(corrected).toMatchObject({ status: 'READY_FOR_REVIEW', currentRound: 2, lastError: null });
    expect(h.codex.implementationCalls).toHaveLength(2);
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'correction')).toMatchObject({ status: 'succeeded' });
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'verification')).toMatchObject({ status: 'succeeded' });

    h.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
    await h.orchestrator.reviewWithCodex(t.id);
    h.orchestrator.approveForPublishing(t.id);

    expect(h.taskService.detail(t.id)).toMatchObject({
      task: { status: 'READY_TO_PUBLISH' },
      effectivePublishRefusal: null
    });
  });
  it('keeps an interrupted Codex correction retryable from the same review', async () => {
    const t = await prepared(); select(t.id, 'codex');
    await h.orchestrator.sendToClaude(t.id);
    h.codex.reviewQueue = [makeReview({ verdict: 'changes_requested', followUpPrompt: 'Fix the race.' })];
    await h.orchestrator.reviewWithCodex(t.id);
    h.codex.implementationError = new AgentRelayError('TIMEOUT', 'The correction process stopped early.');

    await expect(h.orchestrator.sendCorrections(t.id)).rejects.toThrow(/stopped early/);

    expect(h.tasks.findById(t.id)).toMatchObject({ status: 'CHANGES_REQUESTED', currentRound: 2 });
    expect(h.codex.implementationCalls).toHaveLength(2);
  });
  it('also automatically verifies a normally completed but unverified Claude correction', async () => {
    const t = await prepared();
    await h.orchestrator.sendToClaude(t.id);
    h.codex.reviewQueue = [makeReview({ verdict: 'changes_requested', followUpPrompt: 'Fix the race.' })];
    await h.orchestrator.reviewWithCodex(t.id);
    h.claude.evidence = { ...passingVerificationEvidence(), toolExecutions: [] };

    const corrected = await h.orchestrator.sendCorrections(t.id);

    expect(corrected).toMatchObject({ status: 'READY_FOR_REVIEW', currentRound: 2, lastError: null });
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'correction')).toMatchObject({ status: 'succeeded' });
    expect(h.runs.listByTask(t.id).findLast(run => run.runType === 'verification')).toMatchObject({ status: 'succeeded' });
    expect(h.claude.calls).toHaveLength(2);
  });
  it('does not let Relay verification hide a Codex security refusal', async () => {
    const t = await prepared(); select(t.id, 'codex');
    await h.orchestrator.sendToClaude(t.id);
    h.codex.reviewQueue = [makeReview({ verdict: 'changes_requested', followUpPrompt: 'Remove the unsafe command.' })];
    await h.orchestrator.reviewWithCodex(t.id);
    h.codex.implementationResult = {
      sessionId: 'codex-implementation-1',
      finalMessage: 'Stopped after observing an unsafe command.',
      assessment: {
        version: 1, disposition: 'fail', verificationStatus: 'unknown', publishBlock: 'security',
        reasonCodes: ['CODEX_SECURITY'], denials: [], verification: null
      }
    };

    const corrected = await h.orchestrator.sendCorrections(t.id);

    expect(corrected).toMatchObject({ status: 'CHANGES_REQUESTED', currentRound: 2 });
    expect(runGuidance(corrected, h.runs.listByTask(t.id), true).action?.key).toBe('send_corrections');
  });
  it('rejects provider changes after approval', async () => {
    const t = await prepared(); await h.orchestrator.sendToClaude(t.id); await h.orchestrator.reviewWithCodex(t.id);
    expect(() => select(t.id, 'codex')).toThrow();
  });
});
