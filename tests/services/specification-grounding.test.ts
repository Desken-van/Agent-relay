/**
 * The grounding rules that do not need a real repository: a specification with no record
 * (every one generated before this existed), one written for an implementer that can run
 * commands on a task that now uses Ornith, and a revision of either. Real Git is exercised
 * in `specification-grounding-e2e.test.ts`.
 */

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import { PlanCorrectionService } from '../../src/main/services/plan-correction';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import {
  parseSpecificationGrounding,
  specificationGroundingProblem,
  specificationGroundingState
} from '../../src/shared/domain/specification-grounding';
import { FakePlanReviewer, finding, snapshot } from '../helpers/fake-plan-reviewer';
import { FakePlanReviewSubjects } from '../helpers/fake-plan-review-subjects';
import { makeGrounding, makeSpecification } from '../helpers/fakes';
import { createHarness, type Harness } from '../helpers/harness';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
}

/** A task whose specification was generated before Agent Relay recorded which checkout it read. */
function legacyTask(harness: Harness, overrides: { specificationApprovedAt?: string | null } = {}) {
  const project = harness.createProject();
  return harness.createTask(project.id, {
    status: 'READY_FOR_IMPLEMENTATION',
    specificationJson: JSON.stringify(makeSpecification()),
    specificationApprovedAt: overrides.specificationApprovedAt ?? null,
    codexThreadId: 'thread-that-read-the-source-checkout'
  });
}

describe('the grounding record', () => {
  it('reads a stored record, and anything absent or unreadable as "not grounded"', () => {
    const record = makeGrounding();
    expect(parseSpecificationGrounding(JSON.stringify(record))).toEqual(record);
    for (const bad of [null, undefined, 'not json', '{}', JSON.stringify({ ...record, commit: 'main' }), JSON.stringify({ ...record, extra: 1 })]) {
      expect(parseSpecificationGrounding(bad)).toBeNull();
    }
  });

  it('classifies a task: none, ungrounded, stale, unverifiable, provider_changed or recorded', () => {
    const base = { specificationJson: '{}', implementationProvider: 'claude' as const };
    expect(specificationGroundingState({ ...base, specificationJson: null }).kind).toBe('none');
    expect(specificationGroundingState({ ...base, specificationGroundingJson: null }).kind).toBe('ungrounded');
    expect(specificationGroundingState({ ...base, specificationGroundingJson: 'damaged' }).kind).toBe('ungrounded');
    expect(
      specificationGroundingState({
        ...base,
        specificationGroundingJson: JSON.stringify(makeGrounding({ stale: { detectedAt: '2026-01-02T00:00:00.000Z', reason: 'it moved.' } }))
      })
    ).toMatchObject({ kind: 'stale', reason: 'it moved.' });
    // Read from a worktree with uncommitted changes: never trusted, whichever implementer it names.
    const dirty = makeGrounding({ checkout: 'task_worktree', branch: 'agent-relay/task', clean: false, implementationProvider: 'codex' });
    const unverifiable = specificationGroundingState({ ...base, specificationGroundingJson: JSON.stringify(dirty), implementationProvider: 'ornith' });
    expect(unverifiable.kind).toBe('unverifiable');
    expect(specificationGroundingProblem(unverifiable)).toMatch(/uncommitted changes, which no commit can name/);
    expect(specificationGroundingState({ ...base, specificationGroundingJson: JSON.stringify(makeGrounding()) }).kind).toBe('recorded');
  });

  it('treats only a move TO Ornith as a change of implementer: the others can carry out anything it can', () => {
    const state = (writtenFor: 'claude' | 'codex' | 'ornith', now: 'claude' | 'codex' | 'ornith') =>
      specificationGroundingState({
        specificationJson: '{}',
        specificationGroundingJson: JSON.stringify(makeGrounding({ implementationProvider: writtenFor })),
        implementationProvider: now
      }).kind;
    expect(state('claude', 'ornith')).toBe('provider_changed');
    expect(state('codex', 'ornith')).toBe('provider_changed');
    expect(state('ornith', 'claude')).toBe('recorded');
    expect(state('claude', 'codex')).toBe('recorded');
    expect(state('ornith', 'ornith')).toBe('recorded');
    expect(
      specificationGroundingProblem(
        specificationGroundingState({
          specificationJson: '{}',
          specificationGroundingJson: JSON.stringify(makeGrounding({ implementationProvider: 'claude' })),
          implementationProvider: 'ornith'
        })
      )
    ).toMatch(/written for Claude, but the task now uses Ornith, which cannot run commands/);
  });
});

describe('an existing task whose specification has no record', () => {
  it('is never approved, and the Run screen offers regeneration instead', () => {
    const harness = setup();
    const task = legacyTask(harness);

    expect(() => harness.orchestrator.approveSpecification(task.id)).toThrow(/no record of which checkout/);
    expect(harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();
    expect(runGuidance(harness.tasks.findById(task.id)!, [], true).action).toMatchObject({
      key: 'generate_specification',
      label: 'Regenerate specification'
    });
  });

  it('is never implemented, even if it was approved before, and nothing is created for the attempt', async () => {
    const harness = setup();
    const task = legacyTask(harness, { specificationApprovedAt: '2026-01-01T00:00:00.000Z' });

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(/no record of which checkout/);
    expect(harness.claude.calls).toHaveLength(0);
    expect(harness.git.createdWorktrees).toEqual([]);
    expect(harness.tasks.findById(task.id)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 0, worktreePath: null });
  });

  it('is regenerated explicitly: from a clean checkout of the base commit, in a fresh Codex thread, and then approvable', async () => {
    const harness = setup();
    const task = legacyTask(harness);

    await harness.orchestrator.generateSpecification(task.id);

    const request = harness.codex.specificationCalls[0]!;
    expect(request.threadId).toBeNull();
    expect(request.projectPath).not.toBe(harness.projects.findById(task.projectId)!.localPath);
    expect(harness.git.detachedCheckouts).toEqual([
      { repositoryPath: harness.projects.findById(task.projectId)!.localPath, commit: 'a'.repeat(40), checkoutPath: request.projectPath }
    ]);
    expect(harness.git.removedWorktrees).toEqual([request.projectPath]);
    expect(parseSpecificationGrounding(harness.tasks.findById(task.id)!.specificationGroundingJson)).toMatchObject({
      checkout: 'base_commit', commit: 'a'.repeat(40), clean: true, stale: null
    });
    await harness.orchestrator.verifySpecificationGrounding(task.id);
    expect(harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });

  it('resumes the Codex thread only when regenerating against the same target it already read', async () => {
    const harness = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.generateSpecification(task.id);

    expect(harness.codex.specificationCalls.map((call) => call.threadId)).toEqual([null, harness.codex.threadId]);
  });

  it('is not revised by the plan-correction loop: it stops before opening a correction and says to regenerate', async () => {
    const harness = setup();
    const reviewer = new FakePlanReviewer();
    const claims = new PlanReviewClaims();
    const gateService = new PlanReviewGateService({
      subjects: new FakePlanReviewSubjects(),
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      reviewer,
      codex: harness.codex,
      settings: harness.settings,
      clock: harness.clock,
      ids: harness.ids,
      claims,
      operations: harness.operations,
      verifyTarget: async (taskId: string) => { await harness.orchestrator.verifySpecificationGrounding(taskId); }
    });
    const corrections = new SqlitePlanCorrectionRepository(harness.db, harness.clock);
    const loop = new PlanCorrectionService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      corrections,
      gateService,
      codex: harness.codex,
      settings: harness.settings,
      claims,
      operations: harness.operations,
      clock: harness.clock,
      ids: harness.ids,
      verifyTarget: async (taskId: string) => { await harness.orchestrator.verifySpecificationGrounding(taskId); }
    });
    const project = harness.createProject();
    const created = harness.createTask(project.id);
    gateService.bindRules(created.id, snapshot());
    await harness.orchestrator.generateSpecification(created.id);
    await harness.orchestrator.preparePlanReviewWorktree(created.id);
    reviewer.roundQueue = [{ ...reviewer.round, verdict: 'revise', gatingCount: 1, threshold: 1, findings: [finding('Fix it')] }];
    reviewer.resolutionQueue = [{ ...reviewer.resolution, stage: 'PlanReview', awaitingResolve: false }];
    await gateService.review(created.id);
    // What an existing task looks like after the upgrade: the same rows, with no record.
    harness.tasks.update(created.id, { specificationGroundingJson: null });
    const gate = harness.planReviewGates.findByTask(created.id)!;

    await expect(
      loop.resolveAndRevise(created.id, {
        gateId: gate.id,
        expectedRevision: gate.revision,
        decisions: [{ finding: 0, action: 'accept', reason: 'Yes.' }],
        autoContinue: false
      })
    ).rejects.toThrow(/no record of which checkout/);
    expect(harness.codex.revisionCalls).toHaveLength(0);
    expect(corrections.listByTask(created.id)).toEqual([]);
  });
});

describe('a specification recorded from a task worktree with uncommitted changes', () => {
  /** What an earlier build stored when it regenerated after the first round from a dirty worktree. */
  function dirtyTask(harness: Harness) {
    const project = harness.createProject();
    const grounding = makeGrounding({ checkout: 'task_worktree', branch: 'agent-relay/task', clean: false });
    return harness.createTask(project.id, {
      status: 'READY_FOR_IMPLEMENTATION',
      specificationJson: JSON.stringify(makeSpecification()),
      specificationGroundingJson: JSON.stringify(grounding),
      specificationApprovedAt: '2026-01-01T00:00:00.000Z'
    });
  }

  it('is never approved, verified or implemented, and nothing is written for the attempt', async () => {
    const harness = setup();
    const task = dirtyTask(harness);
    const recorded = task.specificationGroundingJson;

    expect(() => harness.orchestrator.approveSpecification(task.id)).toThrow(/uncommitted changes, which no commit can name/);
    await expect(harness.orchestrator.verifySpecificationGrounding(task.id)).rejects.toThrow(/uncommitted changes, which no commit can name/);
    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(/uncommitted changes, which no commit can name/);
    expect(harness.claude.calls).toHaveLength(0);
    expect(harness.git.createdWorktrees).toEqual([]);
    // Refused on the record alone: no stale mark is added to it.
    expect(harness.tasks.findById(task.id)).toMatchObject({ specificationGroundingJson: recorded, currentRound: 0 });
  });

  it('is offered for regeneration on the Run screen', () => {
    const harness = setup();
    const task = dirtyTask(harness);
    expect(runGuidance(harness.tasks.findById(task.id)!, [], true).action).toMatchObject({
      key: 'generate_specification',
      label: 'Regenerate specification'
    });
  });
});

describe('a specification written for an implementer that can run commands, on a task that now uses Ornith', () => {
  it('is not approved or implemented until it is regenerated for Ornith (or the implementer is changed back)', async () => {
    const harness = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    const revision = harness.tasks.findById(task.id)!.providerRevision;
    harness.orchestrator.configureProviders({ taskId: task.id, expectedRevision: revision, implementationProvider: 'ornith', reviewProvider: 'codex' });

    expect(() => harness.orchestrator.approveSpecification(task.id)).toThrow(/written for Claude, but the task now uses Ornith/);
    expect(runGuidance(harness.tasks.findById(task.id)!, [], true).action?.label).toBe('Regenerate specification');

    harness.orchestrator.configureProviders({
      taskId: task.id,
      expectedRevision: harness.tasks.findById(task.id)!.providerRevision,
      implementationProvider: 'claude',
      reviewProvider: 'codex'
    });
    expect(harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });

  it('tells the specifier which implementer it is writing for', async () => {
    const harness = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);

    expect(harness.codex.specificationCalls[0]).toMatchObject({ implementationProvider: 'ornith', target: { implementationProvider: 'ornith' } });
    expect(parseSpecificationGrounding(harness.tasks.findById(task.id)!.specificationGroundingJson)!.implementationProvider).toBe('ornith');
  });
});

describe('the checkout a specification is generated from', () => {
  it('refuses a base branch written as a revision expression before Git resolves it to another commit', async () => {
    const harness = setup();
    for (const name of ['main~1', 'main^', 'main@{1}', 'HEAD:main', '-main', 'main..x']) {
      const project = harness.createProject({ localPath: `C:\repo-${harness.ids.next()}`, defaultBranch: name });
      const task = harness.createTask(project.id);
      await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(/is not a plain branch name/);
    }
    expect(harness.codex.specificationCalls).toHaveLength(0);
    expect(harness.git.detachedCheckouts).toEqual([]);
  });

  it('accepts a branch name Git itself accepts, even outside Agent Relay’s own branch-name style', async () => {
    const harness = setup();
    harness.git.existingBranches.add('release/2026@q3+hotfix');
    const project = harness.createProject({ defaultBranch: 'release/2026@q3+hotfix' });
    const task = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(task.id);
    expect(parseSpecificationGrounding(harness.tasks.findById(task.id)!.specificationGroundingJson)!.baseBranch).toBe('release/2026@q3+hotfix');
  });

  it('removes the temporary checkout when inspecting it fails, and asks Codex nothing', async () => {
    const harness = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    const checkout = join(harness.worktreesRoot, '.agent-relay-specification', task.id);
    harness.git.inspectErrors.set(checkout, new Error('git status failed'));

    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(/git status failed/);
    expect(harness.git.detachedCheckouts.map((entry) => entry.checkoutPath)).toEqual([checkout]);
    expect(harness.git.removedWorktrees).toEqual([checkout]);
    expect(harness.codex.specificationCalls).toHaveLength(0);
  });
});

describe('only a definite answer marks a specification stale', () => {
  it('refuses, but records nothing, when Git cannot answer', async () => {
    const harness = setup();
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    const recorded = harness.tasks.findById(task.id)!.specificationGroundingJson;
    harness.git.resolveCommitError = Object.assign(new Error('git rev-parse failed.'), { code: 'GIT_FAILED' });

    await expect(harness.orchestrator.verifySpecificationGrounding(task.id)).rejects.toThrow(/rev-parse failed/);
    expect(harness.tasks.findById(task.id)!.specificationGroundingJson).toBe(recorded);

    harness.git.resolveCommitError = null;
    await harness.orchestrator.verifySpecificationGrounding(task.id);
    expect(harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });
});
