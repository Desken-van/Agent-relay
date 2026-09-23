/**
 * One target, end to end, on a REAL temporary Git repository with the real Git adapter.
 *
 * The project's source checkout is on another branch, at an older commit, with an
 * uncommitted edit to the very file the task is about. The base branch is at a newer
 * commit where that file has a different size and a different number of CRLF line
 * endings. The fake Codex measures the file in whatever directory it is handed, so what
 * the specification says is exactly what that directory contained.
 *
 * Nothing here touches a user's repository, task, database or model: the repository,
 * the worktrees and the SQLite database are all created for the test and discarded.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliGitAdapter } from '../../src/main/adapters/git/git-adapter';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import type { CodexSpecificationRequest } from '../../src/main/ports';
import { PlanCorrectionService } from '../../src/main/services/plan-correction';
import { PlanReviewClaims } from '../../src/main/services/plan-review-claims';
import { PlanReviewGateService } from '../../src/main/services/plan-review-gate';
import { runGuidance } from '../../src/shared/domain/run-guidance';
import { parseSpecificationGrounding } from '../../src/shared/domain/specification-grounding';
import { FakePlanReviewer, finding, snapshot } from '../helpers/fake-plan-reviewer';
import { FakePlanReviewSubjects } from '../helpers/fake-plan-review-subjects';
import { makeSpecification } from '../helpers/fakes';
import { createHarness, type Harness } from '../helpers/harness';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** `lines` CRLF-terminated lines: the size and the CRLF count both follow from `lines` and `label`. */
const crlfText = (lines: number, label: string): string =>
  Array.from({ length: lines }, (_, index) => `${label} manual test step ${index + 1}`).join('\r\n') + '\r\n';

interface Measure {
  readonly bytes: number;
  readonly crlf: number;
}
const measure = (text: string | Buffer): Measure => {
  const buffer = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return { bytes: buffer.length, crlf: buffer.toString('latin1').split('\r\n').length - 1 };
};

const FILE = join('docs', 'manual-test.md');
const OLD = crlfText(5, 'old');
const TARGET = crlfText(9, 'target');
const DIRTY = crlfText(7, 'uncommitted source edit');

interface Scenario {
  readonly harness: Harness;
  readonly repo: string;
  readonly base: string;
  /** What the fake Codex found in the directory it was given, per call. */
  readonly seen: { path: string; found: Measure; target: CodexSpecificationRequest['target'] | undefined; threadId: string | null }[];
}

/**
 * The source checkout: `main` at the target commit, the checkout itself on `feature` at an
 * older commit, with an uncommitted edit. Line endings are stored exactly as written.
 */
function scenario(options: { sourceOnMain?: boolean } = {}): Scenario {
  const harness = createHarness({ orchestratorGit: new CliGitAdapter(new ExecaProcessRunner()) });
  harnesses.push(harness);
  const repo = join(dirname(harness.worktreesRoot), 'source');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, 'init', '--initial-branch', 'main');
  git(repo, 'config', 'user.name', 'Agent Relay Test');
  git(repo, 'config', 'user.email', 'test@agent-relay.local');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.eol', 'lf');
  writeFileSync(join(repo, FILE), OLD);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'old manual test');
  git(repo, 'branch', 'feature');
  writeFileSync(join(repo, FILE), TARGET);
  git(repo, 'commit', '-am', 'target manual test');
  const base = git(repo, 'rev-parse', 'HEAD');
  if (!options.sourceOnMain) {
    git(repo, 'checkout', 'feature');
    writeFileSync(join(repo, FILE), DIRTY);
  }

  const seen: Scenario['seen'] = [];
  harness.codex.createSpecification = async (request, context) => {
    harness.codex.specificationCalls.push(request);
    context.onProgress({ type: 'progress', text: 'fake codex: measuring' });
    const found = measure(readFileSync(join(request.projectPath, FILE)));
    seen.push({ path: request.projectPath, found, target: request.target, threadId: request.threadId });
    const commit = request.target?.commit.slice(0, 12) ?? '(no target)';
    return {
      threadId: `thread-${seen.length}`,
      specification: makeSpecification({
        title: 'Add the manual test section',
        implementationPrompt: `At ${commit}, docs/manual-test.md is ${found.bytes} bytes with ${found.crlf} CRLF line endings; append the section.`
      }),
      rawResponse: '{}'
    };
  };
  return { harness, repo, base, seen };
}

function createTask(value: Scenario) {
  const project =
    value.harness.projects.list().find((entry) => entry.localPath === value.repo) ??
    value.harness.createProject({ localPath: value.repo, defaultBranch: 'main' });
  return value.harness.createTask(project.id);
}

const groundingOf = (value: Scenario, taskId: string) =>
  parseSpecificationGrounding(value.harness.tasks.findById(taskId)!.specificationGroundingJson);

describe('a specification is written against the task’s target, never the source checkout', () => {
  it('reads a clean checkout of the base commit, records it, and the task branch starts there', async () => {
    const value = scenario();
    const task = createTask(value);

    await value.harness.orchestrator.generateSpecification(task.id);

    // What Codex read is the base commit's file, not the dirty edit or the older commit on the source branch.
    expect(value.seen).toHaveLength(1);
    expect(value.seen[0]!.found).toEqual(measure(TARGET));
    expect(value.seen[0]!.found).not.toEqual(measure(DIRTY));
    expect(value.seen[0]!.found).not.toEqual(measure(OLD));
    expect(value.seen[0]!.path).not.toBe(value.repo);
    expect(value.seen[0]!.target).toMatchObject({ checkout: 'base_commit', commit: value.base, clean: true });
    const specification = JSON.parse(value.harness.tasks.findById(task.id)!.specificationJson!) as { implementationPrompt: string };
    expect(specification.implementationPrompt).toContain(`At ${value.base.slice(0, 12)}, docs/manual-test.md is ${measure(TARGET).bytes} bytes with 9 CRLF`);
    expect(groundingOf(value, task.id)).toMatchObject({
      checkout: 'base_commit', baseBranch: 'main', commit: value.base, clean: true, implementationProvider: 'claude', stale: null
    });

    // The temporary checkout is gone, and the source checkout is exactly as it was.
    expect(existsSync(value.seen[0]!.path)).toBe(false);
    expect(git(value.repo, 'worktree', 'list', '--porcelain')).not.toContain('.agent-relay-specification');
    expect(git(value.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(readFileSync(join(value.repo, FILE), 'utf8')).toBe(DIRTY);

    // The branch is cut from that commit; plan review and implementation read that same tree.
    await value.harness.orchestrator.preparePlanReviewWorktree(task.id, { acceptDirtyWorkingTree: true });
    const prepared = value.harness.tasks.findById(task.id)!;
    expect(git(prepared.worktreePath!, 'rev-parse', 'HEAD')).toBe(value.base);
    expect(measure(readFileSync(join(prepared.worktreePath!, FILE)))).toEqual(measure(TARGET));

    await value.harness.orchestrator.verifySpecificationGrounding(task.id);
    value.harness.orchestrator.approveSpecification(task.id);
    await value.harness.orchestrator.sendToClaude(task.id);
    expect(value.harness.claude.calls).toHaveLength(1);
    expect(value.harness.claude.calls[0]!.worktreePath).toBe(prepared.worktreePath);
  });

  it('keeps the recorded commit when the base branch moves on, and refuses one the base branch no longer contains', async () => {
    const value = scenario({ sourceOnMain: true });
    const task = createTask(value);
    await value.harness.orchestrator.generateSpecification(task.id);
    writeFileSync(join(value.repo, 'later.txt'), 'later\n');
    git(value.repo, 'add', 'later.txt');
    git(value.repo, 'commit', '-m', 'base moved on');

    await value.harness.orchestrator.preparePlanReviewWorktree(task.id);
    const prepared = value.harness.tasks.findById(task.id)!;
    expect(git(prepared.worktreePath!, 'rev-parse', 'HEAD')).toBe(value.base);
    expect(existsSync(join(prepared.worktreePath!, 'later.txt'))).toBe(false);

    // A second task, specified at the new tip; then the base branch is rewritten under it.
    const second = createTask(value);
    await value.harness.orchestrator.generateSpecification(second.id);
    const moved = groundingOf(value, second.id)!.commit;
    git(value.repo, 'reset', '--hard', value.base);

    await expect(value.harness.orchestrator.preparePlanReviewWorktree(second.id)).rejects.toThrow(
      new RegExp(`no longer contains ${moved.slice(0, 12)}`)
    );
    expect(value.harness.tasks.findById(second.id)!.worktreePath).toBeNull();
    expect(groundingOf(value, second.id)!.stale?.reason).toMatch(/no longer contains/);
  });
});

describe('a target that changed after the specification is detected, surfaced and re-grounded', () => {
  async function approvedOnItsBranch() {
    const value = scenario();
    const task = createTask(value);
    await value.harness.orchestrator.generateSpecification(task.id);
    await value.harness.orchestrator.preparePlanReviewWorktree(task.id, { acceptDirtyWorkingTree: true });
    await value.harness.orchestrator.verifySpecificationGrounding(task.id);
    value.harness.orchestrator.approveSpecification(task.id);
    return { value, task, worktree: value.harness.tasks.findById(task.id)!.worktreePath! };
  }

  it('refuses to implement after a commit on the task branch, offers regeneration, and regenerates from the new commit', async () => {
    const { value, task, worktree } = await approvedOnItsBranch();
    const committed = crlfText(11, 'committed in the worktree');
    writeFileSync(join(worktree, FILE), committed);
    git(worktree, 'commit', '-am', 'someone edited the task branch');
    const moved = git(worktree, 'rev-parse', 'HEAD');

    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(
      new RegExp(`moved from ${value.base.slice(0, 12)} to ${moved.slice(0, 12)}`)
    );
    expect(value.harness.claude.calls).toHaveLength(0);
    expect(value.harness.tasks.findById(task.id)!.currentRound).toBe(0);

    // Recorded, so the Run screen offers the one step that fixes it; nothing else is offered.
    const stale = value.harness.tasks.findById(task.id)!;
    expect(parseSpecificationGrounding(stale.specificationGroundingJson)!.stale?.reason).toMatch(/moved from/);
    expect(() => value.harness.orchestrator.approveSpecification(task.id)).toThrow(/changed after the specification/);
    const guidance = runGuidance(stale, value.harness.runs.listByTask(task.id), true);
    expect(guidance.action).toMatchObject({ key: 'generate_specification', label: 'Regenerate specification' });

    // Regenerating reads the task worktree as it now is, in a fresh Codex thread.
    await value.harness.orchestrator.generateSpecification(task.id);
    expect(value.seen[1]).toMatchObject({ path: worktree, found: measure(committed), threadId: null });
    expect(groundingOf(value, task.id)).toMatchObject({ checkout: 'task_worktree', commit: moved, clean: true, stale: null });
    expect(value.harness.tasks.findById(task.id)!.specificationApprovedAt).toBeNull();

    await value.harness.orchestrator.verifySpecificationGrounding(task.id);
    value.harness.orchestrator.approveSpecification(task.id);
    await value.harness.orchestrator.sendToClaude(task.id);
    expect(value.harness.claude.calls).toHaveLength(1);
  });

  it('refuses an uncommitted edit in the task worktree, and never grounds a specification in one', async () => {
    const { value, task, worktree } = await approvedOnItsBranch();
    writeFileSync(join(worktree, FILE), crlfText(3, 'uncommitted in the worktree'));

    await expect(value.harness.orchestrator.verifySpecificationGrounding(task.id)).rejects.toThrow(/uncommitted changes/);
    await expect(value.harness.orchestrator.sendToClaude(task.id)).rejects.toThrow();
    expect(value.harness.claude.calls).toHaveLength(0);

    // Before any round, nobody's edit can be named by a commit: Agent Relay does not guess and does not discard it.
    await expect(value.harness.orchestrator.generateSpecification(task.id)).rejects.toMatchObject({ code: 'GIT_DIRTY' });
    expect(value.seen).toHaveLength(1);
    expect(readFileSync(join(worktree, FILE), 'utf8')).toBe(crlfText(3, 'uncommitted in the worktree'));

    git(worktree, 'checkout', '--', FILE);
    await value.harness.orchestrator.generateSpecification(task.id);
    expect(groundingOf(value, task.id)).toMatchObject({ checkout: 'task_worktree', commit: value.base, stale: null });
  });
});

describe('plan review, triage and revision read the same target', () => {
  it('names the target in the plan text, and triage and the revision read the task worktree', async () => {
    const value = scenario();
    const reviewer = new FakePlanReviewer();
    const claims = new PlanReviewClaims();
    const { harness } = value;
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
      operations: harness.operations
    });
    const loop = new PlanCorrectionService({
      tasks: harness.tasks,
      projects: harness.projects,
      ruleEvidence: harness.taskRuleEvidence,
      gates: harness.planReviewGates,
      corrections: new SqlitePlanCorrectionRepository(harness.db, harness.clock),
      gateService,
      codex: harness.codex,
      settings: harness.settings,
      claims,
      operations: harness.operations,
      clock: harness.clock,
      ids: harness.ids
    });
    const task = createTask(value);
    gateService.bindRules(task.id, snapshot());
    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.preparePlanReviewWorktree(task.id, { acceptDirtyWorkingTree: true });
    const worktree = harness.tasks.findById(task.id)!.worktreePath!;

    reviewer.roundQueue = [{ ...reviewer.round, verdict: 'revise', gatingCount: 1, threshold: 1, findings: [finding('Name the tools')] }];
    reviewer.resolutionQueue = [{ ...reviewer.resolution, stage: 'PlanReview', awaitingResolve: false }];
    await gateService.review(task.id);

    // Hard-wrapped prose: compared as running text.
    const planText = reviewer.reviewCalls[0]!.planText.replace(/\s+/g, ' ');
    expect(planText).toContain(`The specification was written by reading a clean, detached checkout of base branch main at commit ${value.base}`);
    expect(planText).toContain('The task branch under review starts from exactly this commit.');
    expect(planText).toContain('The implementer is Claude Code');
    expect(planText).toContain('one this implementer cannot carry out is a defect of the plan');
    // The rule evidence's revision and clean flag are said to describe where the rules were read — not this tree.
    expect(planText).toContain("Each source's revision and clean flag describe the checkout its rule files were read from");

    const gate = harness.planReviewGates.findByTask(task.id)!;
    await gateService.triage(task.id, { gateId: gate.id, expectedRevision: gate.revision });
    expect(harness.codex.triageCalls[0]!.worktreePath).toBe(worktree);
    expect(harness.codex.triageCalls[0]!.worktreePath).not.toBe(value.repo);

    const settled = harness.planReviewGates.findByTask(task.id)!;
    await loop.resolveAndRevise(task.id, {
      gateId: settled.id,
      expectedRevision: settled.revision,
      decisions: [{ finding: 0, action: 'accept', reason: 'Yes.' }],
      autoContinue: false
    });
    expect(harness.codex.revisionCalls[0]).toMatchObject({
      projectPath: worktree,
      target: { checkout: 'base_commit', commit: value.base },
      implementationProvider: 'claude'
    });
    // The revision keeps the target it was generated against.
    expect(groundingOf(value, task.id)).toMatchObject({ commit: value.base, stale: null });
  });
});
