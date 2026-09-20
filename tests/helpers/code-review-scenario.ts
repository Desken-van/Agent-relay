/**
 * A scenario for the code-review service and its cancellation.
 *
 * Built the way the composition root builds it: the claims and the operation
 * registry are the process-wide instances (`harness.operations` is the one the
 * orchestrator's `stop()` reads), and `build()` is "another IPC call" — a service
 * made afresh over the same shared state.
 */

import { afterEach } from 'vitest';
import { SqliteCodeReviewRepository } from '../../src/main/db/repositories/code-review-repository';
import {
  CodeReviewClaims,
  CodeReviewService,
  type CodeReviewDeps,
  type CodeReviewRoundOutcome
} from '../../src/main/services/code-review';
import { FakeCodeReviewer, FakeSnapshotSource } from './fake-code-review';
import { makeSpecification } from './fakes';
import { createHarness, type Harness } from './harness';

const harnesses: Harness[] = [];

/** Register once per test file: closes every database this file's scenarios opened. */
export function disposeScenariosAfterEach(): void {
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.dispose();
  });
}

export function codeReviewScenario() {
  const harness = createHarness();
  harnesses.push(harness);
  const reviews = new SqliteCodeReviewRepository(harness.db, harness.clock);
  const snapshots = new FakeSnapshotSource();
  const reviewer = new FakeCodeReviewer();
  const claims = new CodeReviewClaims();
  const build = (extra: Partial<CodeReviewDeps> = {}): CodeReviewService =>
    new CodeReviewService({
      tasks: harness.tasks,
      projects: harness.projects,
      reviews,
      snapshots,
      reviewer,
      claims,
      operations: harness.operations,
      clock: harness.clock,
      ids: harness.ids,
      ...extra
    });

  const project = harness.createProject();
  const task = harness.createTask(project.id, {
    status: 'READY_FOR_IMPLEMENTATION',
    worktreePath: harness.worktreesRoot,
    branchName: 'agent/task-1',
    baseBranch: 'main',
    specificationJson: JSON.stringify(makeSpecification())
  });
  // The worktree and the project share one repository by default, and the
  // worktree sits on the branch the task records. Tests that care make them
  // disagree.
  snapshots.checkouts.set(project.localPath, {
    commonDir: 'C:/repo/.git',
    branch: 'main',
    detached: false
  });

  return { harness, reviews, snapshots, reviewer, claims, service: build(), build, task };
}

export type CodeReviewScenario = ReturnType<typeof codeReviewScenario>;

export async function reviewOnce(value: CodeReviewScenario): Promise<CodeReviewRoundOutcome> {
  await value.service.captureSubject(value.task.id);
  return value.service.review(value.task.id);
}
