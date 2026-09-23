import { describe, expect, it } from 'vitest';
import { findTaskOrphanedByProfileRemoval } from '../../src/main/services/local-inference-profile-deletion-guard';
import { taskSchema } from '../../src/shared/domain/models';
import type { Task } from '../../src/shared/domain/models';

function task(overrides: Partial<Parameters<typeof taskSchema.parse>[0]> = {}): Task {
  return taskSchema.parse({
    id: 't1',
    projectId: 'p1',
    title: 'A task',
    originalRequest: 'Do it',
    status: 'IMPLEMENTING',
    currentRound: 1,
    maxRounds: 3,
    codexThreadId: null,
    claudeSessionId: null,
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    specificationJson: null,
    specificationApprovedAt: null,
    lastReviewJson: null,
    lastError: null,
    codexModel: null,
    claudeModel: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides
  });
}

describe('findTaskOrphanedByProfileRemoval', () => {
  it('returns null and never calls the task lister when no profile id was actually removed', () => {
    let calls = 0;
    const result = findTaskOrphanedByProfileRemoval(
      new Set(['default']),
      new Set(['default', 'second']),
      () => {
        calls += 1;
        return [];
      }
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns null when a removed profile id has no non-terminal task bound to it', () => {
    const bound = task({ implementationProvider: 'ornith', ornithModelProfileId: 'kept', ornithModelProfileFingerprint: 'a'.repeat(16) });
    const result = findTaskOrphanedByProfileRemoval(
      new Set(['default', 'kept']),
      new Set(['kept']),
      () => [bound]
    );
    expect(result).toBeNull();
  });

  it('returns the task bound to a profile id that disappeared', () => {
    const orphaned = task({
      id: 'orphaned-task',
      implementationProvider: 'ornith',
      ornithModelProfileId: 'removed',
      ornithModelProfileFingerprint: 'a'.repeat(16)
    });
    const result = findTaskOrphanedByProfileRemoval(
      new Set(['default', 'removed']),
      new Set(['default']),
      () => [orphaned]
    );
    expect(result).toBe(orphaned);
  });

  it('ignores a non-terminal task with no Ornith profile binding at all', () => {
    const claudeTask = task({ implementationProvider: 'claude', ornithModelProfileId: null, ornithModelProfileFingerprint: null });
    const result = findTaskOrphanedByProfileRemoval(
      new Set(['default', 'removed']),
      new Set(['default']),
      () => [claudeTask]
    );
    expect(result).toBeNull();
  });
});
