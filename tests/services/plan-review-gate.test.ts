import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import type {
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewSubject
} from '../../src/main/ports';
import type { PlanReviewDecision } from '../../src/shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../src/shared/domain/rule-evidence';
import { makeSpecification } from '../helpers/fakes';
import { createHarness, type Harness } from '../helpers/harness';

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

  async open(subject: ExternalPlanReviewSubject): Promise<ExternalPlanReviewSession> {
    this.openCalls.push(subject);
    if (this.openError) throw this.openError;
    return this.session;
  }

  async reviewPlan(subject: ExternalPlanReviewSubject, planText: string): Promise<ExternalPlanReviewRound> {
    this.reviewCalls.push({ subject, planText });
    this.onReview?.();
    if (this.reviewError) throw this.reviewError;
    return this.round;
  }

  async resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[]
  ): Promise<ExternalPlanReviewResolution> {
    this.resolveCalls.push({ subject, decisions });
    this.onResolve?.();
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
  const service = new PlanReviewGateService({
    tasks: harness.tasks,
    projects: harness.projects,
    ruleEvidence: harness.taskRuleEvidence,
    gates: harness.planReviewGates,
    reviewer,
    clock: harness.clock,
    ids: harness.ids
  });
  return { harness, reviewer, service };
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
    expect(value.harness.planReviewGates.findByTask(task.id)).toMatchObject({
      status: 'failed',
      lastError: 'review connection vanished'
    });
    await expect(value.service.review(task.id)).rejects.toThrow(/durable status is "failed"/i);
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
