/**
 * Where Agent Relay holds a specification to the Ornith instruction contract: a generated one
 * before it is stored, a revised one before it replaces the current one, and a stored one before
 * approval and before every implementation round. The contract's own rules are tested in
 * `tests/domain/ornith-instruction-contract.test.ts`; here, only that each gate uses it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import { PlanCorrectionService } from '../../src/main/services/plan-correction';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import { runGuidance } from '../../src/shared/domain/run-guidance';
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

/** What reached Ornith in the observed failure: the operator's UI action, and its persisted record. */
const IMPOSSIBLE = makeSpecification({
  implementationPrompt:
    'Add the /health route and its test. Then invoke Agent Relay\'s UI "Run verification" action and read the UI action\'s persisted result.'
});
const REFUSED = /^The specification tells Ornith to do something its protocol cannot\. Implementation prompt: "Then invoke Agent Relay/;

describe('a specification Codex writes for Ornith', () => {
  it('is not stored when it breaks the contract; the run shows every violation, and a compliant one is stored', async () => {
    const harness = setup();
    const task = harness.createTask(harness.createProject().id, { implementationProvider: 'ornith' });
    harness.codex.specification = IMPOSSIBLE;

    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(REFUSED);
    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(/The specification was not saved\.$/);
    expect(harness.tasks.findById(task.id)).toMatchObject({
      status: 'DRAFT',
      specificationJson: null,
      specificationGroundingJson: null
    });
    const run = harness.runs.listByTask(task.id).filter((entry) => entry.runType === 'specification').at(-1)!;
    expect(run.status).toBe('failed');
    expect(harness.runEvents.listByRun(run.id).some((event) => event.payload.includes('read the UI action'))).toBe(true);

    harness.codex.specification = makeSpecification();
    await harness.orchestrator.generateSpecification(task.id);
    expect(JSON.parse(harness.tasks.findById(task.id)!.specificationJson!)).toEqual(makeSpecification());
  });

  it('logs every violation, one bounded line each — not only the first few', async () => {
    const harness = setup();
    const task = harness.createTask(harness.createProject().id, { implementationProvider: 'ornith' });
    const lines = Array.from({ length: 25 }, (_, index) => `${index + 1}. Capture the run ID of step ${index + 1}.`);
    harness.codex.specification = makeSpecification({ implementationPrompt: lines.join('\n') });

    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(/\(and 22 more\) The specification was not saved\.$/);
    const run = harness.runs.listByTask(task.id).filter((entry) => entry.runType === 'specification').at(-1)!;
    const logged = harness.runEvents
      .listByRun(run.id)
      .map((event) => (JSON.parse(event.payload) as { text: string }).text)
      .filter((text) => text.startsWith('Implementation prompt: "Capture the run ID'));
    expect(logged).toHaveLength(25);
    expect(logged.at(-1)).toContain('Capture the run ID of step 25.');
    expect(Math.max(...logged.map((text) => text.length))).toBeLessThan(500);
  });

  it('is held to the contract only when Ornith implements it', async () => {
    const harness = setup();
    const task = harness.createTask(harness.createProject().id, { implementationProvider: 'claude' });
    harness.codex.specification = IMPOSSIBLE;

    await harness.orchestrator.generateSpecification(task.id);
    expect(harness.tasks.findById(task.id)!.specificationJson).not.toBeNull();
  });
});

describe('a stored specification that breaks the contract (written before it existed)', () => {
  function stored(harness: Harness, overrides: { currentRound?: number; specificationApprovedAt?: string | null } = {}) {
    return harness.createTask(harness.createProject().id, {
      implementationProvider: 'ornith',
      status: 'READY_FOR_IMPLEMENTATION',
      specificationJson: JSON.stringify(IMPOSSIBLE),
      specificationGroundingJson: JSON.stringify(makeGrounding({ implementationProvider: 'ornith' })),
      specificationApprovedAt: overrides.specificationApprovedAt ?? null,
      currentRound: overrides.currentRound ?? 0
    });
  }

  it('is never approved, and the Run screen offers regeneration with the reason', () => {
    const harness = setup();
    const task = stored(harness);

    expect(() => harness.orchestrator.approveSpecification(task.id)).toThrow(REFUSED);
    expect(harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();
    const guidance = runGuidance(harness.tasks.findById(task.id)!, [], true);
    expect(guidance.action).toMatchObject({ key: 'generate_specification', label: 'Regenerate specification' });
    expect(guidance.happened).toMatch(REFUSED);
  });

  it.each([0, 2])('is never handed to Ornith, even approved, in round %i — refused before a lease, worktree or run exists', async (round) => {
    const harness = setup();
    const task = stored(harness, { currentRound: round, specificationApprovedAt: '2026-01-01T00:00:00.000Z' });

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(REFUSED);
    expect(harness.git.createdWorktrees).toEqual([]);
    expect(harness.runs.listByTask(task.id)).toEqual([]);
    expect(harness.tasks.findById(task.id)).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: round });
  });

  it('is approved once the implementer is one that can run commands', () => {
    const harness = setup();
    const task = stored(harness);
    harness.tasks.update(task.id, {
      implementationProvider: 'claude',
      specificationGroundingJson: JSON.stringify(makeGrounding({ implementationProvider: 'claude' }))
    });

    expect(harness.orchestrator.approveSpecification(task.id).specificationApprovedAt).not.toBeNull();
  });
});

describe('a revision of an Ornith specification', () => {
  async function reviewed() {
    const harness = setup();
    const reviewer = new FakePlanReviewer();
    const claims = new PlanReviewClaims();
    const verifyTarget = async (taskId: string) => {
      await harness.orchestrator.verifySpecificationGrounding(taskId);
    };
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
      verifyTarget
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
      verifyTarget
    });
    const task = harness.createTask(harness.createProject().id, { implementationProvider: 'ornith' });
    gateService.bindRules(task.id, snapshot());
    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.preparePlanReviewWorktree(task.id);
    reviewer.roundQueue = [{ ...reviewer.round, verdict: 'revise', gatingCount: 1, threshold: 1, findings: [finding('Name the test file')] }];
    reviewer.resolutionQueue = [{ ...reviewer.resolution, stage: 'PlanReview', awaitingResolve: false }];
    await gateService.review(task.id);
    const gate = harness.planReviewGates.findByTask(task.id)!;
    const revise = () =>
      loop.resolveAndRevise(task.id, {
        gateId: gate.id,
        expectedRevision: gate.revision,
        decisions: [{ finding: 0, action: 'accept', reason: 'Yes.' }],
        autoContinue: false
      });
    return { harness, corrections, task, revise };
  }

  it('is not stored when it breaks the contract: the correction fails and the specification is unchanged', async () => {
    const { harness, corrections, task, revise } = await reviewed();
    const before = harness.tasks.findById(task.id)!.specificationJson;
    harness.codex.revisionQueue = [
      makeSpecification({ implementationPrompt: 'Add the /health route and tests/health.test.ts, then run `npx vitest run tests/health.test.ts`.' })
    ];

    await expect(revise()).rejects.toThrow(/^The specification tells Ornith to do something its protocol cannot\..*The revision was not stored\.$/s);
    expect(corrections.listByTask(task.id)).toMatchObject([{ status: 'failed', toVersion: null, lastError: expect.stringMatching(/Ornith cannot run commands/) }]);
    expect(corrections.listVersions(task.id).map((version) => version.version)).toEqual([1]);
    expect(harness.tasks.findById(task.id)!.specificationJson).toBe(before);
  });

  it('is stored when it keeps to the contract', async () => {
    const { harness, corrections, task, revise } = await reviewed();
    const revised = makeSpecification({ implementationPrompt: 'Add the /health route and tests/health.test.ts; use run_verification when done.' });
    harness.codex.revisionQueue = [revised];

    await revise();
    expect(corrections.listByTask(task.id)).toMatchObject([{ status: 'completed', toVersion: 2 }]);
    expect(JSON.parse(harness.tasks.findById(task.id)!.specificationJson!)).toMatchObject({ implementationPrompt: revised.implementationPrompt });
  });
});
