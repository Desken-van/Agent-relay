import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { latestImplementationRoundResult } from '../../src/shared/domain/claude-assessment';
import { makeReview } from '../helpers/fakes';

let h: Harness;
beforeEach(() => { h = createHarness(); });
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
  it('rejects provider changes after approval', async () => {
    const t = await prepared(); await h.orchestrator.sendToClaude(t.id); await h.orchestrator.reviewWithCodex(t.id);
    expect(() => select(t.id, 'codex')).toThrow();
  });
});
