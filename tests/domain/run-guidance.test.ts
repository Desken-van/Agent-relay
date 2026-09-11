import { describe, expect, it } from 'vitest';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import { runGuidance } from '../../src/shared/domain/run-guidance';

const baseTask = taskSchema.parse({
  id: 'task-1', projectId: 'project-1', title: 'Improve flow', originalRequest: 'Make it clear',
  status: 'DRAFT', currentRound: 0, maxRounds: 2, codexThreadId: null, claudeSessionId: null,
  worktreePath: null, branchName: null, baseBranch: 'main', specificationJson: null,
  specificationApprovedAt: null, lastReviewJson: null, lastError: null, codexModel: null,
  claudeModel: null, createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z'
});

function task(overrides: Partial<Task>): Task {
  return taskSchema.parse({ ...baseTask, ...overrides });
}

function run(overrides: Partial<Run>): Run {
  return runSchema.parse({
    id: 'run-1', taskId: 'task-1', agent: 'codex', runType: 'implementation', status: 'failed',
    round: 1, startedAt: '2026-09-11T00:00:00.000Z', finishedAt: '2026-09-11T00:01:00.000Z',
    finalMessage: null, structuredResult: null, errorMessage: null, ...overrides
  });
}

describe('run guidance', () => {
  it.each([
    ['DRAFT', false, false, 'generate_specification', 'Step 1 of 5'],
    ['READY_FOR_IMPLEMENTATION', true, false, 'approve_specification', 'Step 1 of 5'],
    ['READY_FOR_IMPLEMENTATION', true, true, 'run_implementation', 'Step 2 of 5'],
    ['READY_FOR_REVIEW', true, true, 'run_review', 'Step 4 of 5'],
    ['APPROVED', true, true, 'approve_publishing', 'Step 5 of 5'],
    ['READY_TO_PUBLISH', true, true, 'publish', 'Step 5 of 5'],
    ['COMPLETED', true, true, 'none', 'Complete']
  ] as const)('names one next action for %s', (status, hasSpecification, approved, action, stage) => {
    const value = runGuidance(task({
      status,
      specificationApprovedAt: approved ? '2026-09-11T00:00:00.000Z' : null
    }), [], hasSpecification);
    expect(value.recommendedAction).toBe(action);
    expect(value.stage).toContain(stage);
  });

  it('sends preserved files to verification after an incomplete implementation', () => {
    const value = runGuidance(task({
      status: 'READY_FOR_IMPLEMENTATION', currentRound: 1,
      specificationApprovedAt: '2026-09-11T00:00:00.000Z'
    }), [run({})], true);
    expect(value.recommendedAction).toBe('run_verification');
    expect(value.next).toContain('without asking an AI to rewrite');
  });

  it('explains that a failed run is closed instead of suggesting a dead button', () => {
    const value = runGuidance(task({
      status: 'FAILED', currentRound: 2, lastError: 'Review round limit reached (2/2).'
    }), [run({ runType: 'review', status: 'succeeded' })], true);
    expect(value.recommendedAction).toBe('none');
    expect(value.happened).toContain('final review');
    expect(value.result).toBe('Review round limit reached (2/2).');
    expect(value.next).toContain('run is closed');
  });

  it('does not recommend corrections after the round budget is spent', () => {
    const value = runGuidance(task({ status: 'CHANGES_REQUESTED', currentRound: 2, maxRounds: 2 }), [], true);
    expect(value.recommendedAction).toBe('none');
    expect(value.result).toContain('All 2');
  });

  it('recommends the recovery action when publishing evidence was refused', () => {
    const value = runGuidance(task({ status: 'READY_TO_PUBLISH', currentRound: 1, maxRounds: 2 }), [], true, true);
    expect(value.recommendedAction).toBe('send_corrections');
    expect(value.next).toBe('Click “Retry verification”.');
    expect(value.tone).toBe('warning');
  });
});
