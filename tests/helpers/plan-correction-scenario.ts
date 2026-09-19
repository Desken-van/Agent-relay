/**
 * A scenario for the plan-correction loop and its cancellation.
 *
 * Built the way the composition root builds it: the claims and the operation
 * registry are the process-wide instances, and every service is made afresh per
 * call. `build()` is therefore "another IPC call", and `harness.orchestrator` is
 * the singleton whose `stop()` (the backend of `workflow:stop`) must reach an
 * operation started through ANY of them.
 */

import { afterEach } from 'vitest';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import { PlanCorrectionService } from '../../src/main/services/plan-correction';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService, planFindingsSha256 } from '../../src/main/services/plan-review-gate';
import { specificationIdentity } from '../../src/main/services/specification-identity';
import type { Settings } from '../../src/shared/domain/models';
import type { PlanReviewDecision } from '../../src/shared/domain/plan-review';
import type { ExternalPlanReviewRound } from '../../src/main/ports';
import { FakePlanReviewer, finding, snapshot } from './fake-plan-reviewer';
import { createHarness, type Harness } from './harness';

const harnesses: Harness[] = [];

/** Register once per test file: closes every database this file's scenarios opened. */
export function disposeScenariosAfterEach(): void {
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.dispose();
  });
}

export function scenario(settings: Partial<Settings> = {}) {
  const harness = createHarness({ settings });
  harnesses.push(harness);
  const reviewer = new FakePlanReviewer();
  const claims = new PlanReviewClaims();
  const corrections = new SqlitePlanCorrectionRepository(harness.db, harness.clock);
  const build = () => {
    const gateService = new PlanReviewGateService({
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
      operations: harness.operations
    });
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
      ids: harness.ids
    });
    return { gateService, loop };
  };
  const { gateService, loop } = build();
  return { harness, reviewer, claims, corrections, gateService, loop, build };
}
export type Scenario = ReturnType<typeof scenario>;

/** A task with rule evidence, a generated specification and an isolated branch. */
export async function ready(value: Scenario) {
  const project = value.harness.createProject();
  const created = value.harness.createTask(project.id);
  value.gateService.bindRules(created.id, snapshot());
  await value.harness.orchestrator.generateSpecification(created.id);
  return value.harness.orchestrator.preparePlanReviewWorktree(created.id);
}

export const roundWith = (
  value: Scenario,
  titles: readonly string[],
  verdict: ExternalPlanReviewRound['verdict'] = 'revise'
): ExternalPlanReviewRound => ({
  ...value.reviewer.round,
  verdict,
  gatingCount: titles.length,
  threshold: 1,
  findings: titles.map(finding)
});

/** Coai keeps the session in PlanReview after a `revise` resolution: the gate settles as changes_requested. */
export const revise = (value: Scenario) => ({ ...value.reviewer.resolution, stage: 'PlanReview', awaitingResolve: false });
/** Coai moves past the plan gate: the gate settles as proceeded. */
export const proceed = (value: Scenario) => ({ ...value.reviewer.resolution, stage: 'CodeReview', awaitingResolve: false });

export const currentGate = (value: Scenario, taskId: string) => value.harness.planReviewGates.findByTask(taskId)!;
export const specOf = (value: Scenario, taskId: string) => value.harness.tasks.findById(taskId)!.specificationJson as string;
export const statusOf = (value: Scenario, taskId: string) => value.harness.tasks.findById(taskId)!.status;

export const decide = (
  ...entries: readonly (readonly [number, 'accept' | 'reject', string])[]
): PlanReviewDecision[] => entries.map(([findingIndex, action, reason]) => ({ finding: findingIndex, action, reason }));

export function resolveRequest(value: Scenario, taskId: string, decisions: readonly PlanReviewDecision[], autoContinue = false) {
  const gate = currentGate(value, taskId);
  return { gateId: gate.id, expectedRevision: gate.revision, decisions, autoContinue };
}

/** A round with one accepted finding already resolved: the next step is `revise`. */
export async function acceptedAndResolved(value: Scenario, titles: readonly string[] = ['Needs a change']) {
  const task = await ready(value);
  value.reviewer.roundQueue = [roundWith(value, titles), roundWith(value, [], 'proceed')];
  value.reviewer.resolutionQueue = [revise(value), proceed(value)];
  await value.gateService.review(task.id);
  const gate = currentGate(value, task.id);
  await value.gateService.runResolve(task.id, {
    gateId: gate.id,
    expectedRevision: gate.revision,
    decisions: decide(...titles.map((_, index) => [index, 'accept', 'Yes.'] as const)),
    allowAccepted: true
  });
  return task;
}

/** Yield until `condition` holds — never a fixed delay, so a race is decided by the promises, not by time. */
export async function until(condition: () => boolean, what = 'the condition'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

export { planFindingsSha256, specificationIdentity };
