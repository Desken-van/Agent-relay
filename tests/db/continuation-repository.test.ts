import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

let harness: Harness;
beforeEach(() => { harness = createHarness(); });
afterEach(() => harness.dispose());

describe('continuation persistence constraints', () => {
  it('round-trips one immutable link per source and per continuation', () => {
    const project = harness.createProject();
    const source = harness.createTask(project.id, { status: 'FAILED' });
    const continuation = harness.createTask(project.id);
    const link = harness.taskContinuations.create({
      id: 'link-1', sourceTaskId: source.id, continuationTaskId: continuation.id,
      entryAction: 'verification', inheritedVerificationRunId: null,
      inheritedImplementationRunId: null, inheritedReviewRunId: null
    });
    expect(harness.taskContinuations.findBySource(source.id)).toEqual(link);
    expect(harness.taskContinuations.findByContinuation(continuation.id)).toEqual(link);

    const other = harness.createTask(project.id);
    expect(() => harness.taskContinuations.create({
      ...link, id: 'link-2', continuationTaskId: other.id
    })).toThrow(/already exists/);
    expect(() => harness.taskContinuations.create({
      ...link, id: 'link-3', sourceTaskId: other.id
    })).toThrow(/already exists/);
  });

  it('persists a process-wide creation lease and binds it to the first action', () => {
    const project = harness.createProject();
    const source = harness.createTask(project.id, { status: 'FAILED', worktreePath: 'C:/shared' });
    const continuation = harness.createTask(project.id);
    harness.taskContinuations.acquireClaim({ sourceTaskId: source.id, claimId: 'claim-1', worktreePath: 'C:/shared' });
    expect(() => harness.taskContinuations.acquireClaim({
      sourceTaskId: source.id, claimId: 'claim-2', worktreePath: 'C:/shared'
    })).toThrow(/in progress/);
    expect(harness.taskContinuations.bindClaim({
      sourceTaskId: source.id, claimId: 'claim-1', continuationTaskId: continuation.id,
      validatedIdentity: 'a'.repeat(64), effectiveEntryAction: 'verification'
    })).toMatchObject({ state: 'awaiting_first_action', effectiveEntryAction: 'verification' });
  });
});
