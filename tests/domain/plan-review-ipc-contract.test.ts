import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';

const PLAN_REVIEW_CHANNELS = [
  'planReview:get',
  'planReview:bindRules',
  'planReview:prepare',
  'planReview:review',
  'planReview:resolve',
  'planReview:reconcile'
] as const;

describe('the external plan-review IPC contract', () => {
  it('accepts only a task id for the read-only reconciliation', () => {
    const schema = ipcInputSchemas['planReview:reconcile'];
    expect(schema.safeParse({ taskId: 'task-1' }).success).toBe(true);
    // Nothing about the process, the repository, the tool or an external result
    // may cross the boundary: the main process reads all of that from settings.
    for (const injected of [
      { taskId: 'task-1', repoPath: 'C:/elsewhere' },
      { taskId: 'task-1', executablePath: 'C:/evil.exe' },
      { taskId: 'task-1', args: ['--token=abc'] },
      { taskId: 'task-1', tool: 'review_plan' },
      { taskId: 'task-1', stage: 'CodeReview' },
      { taskId: 'task-1', awaitingResolve: false },
      { taskId: 'task-1', findings: [] }
    ]) {
      expect(schema.safeParse(injected).success).toBe(false);
    }
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('registers exactly the six bounded operations', () => {
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('planReview:')).sort()).toEqual(
      [...PLAN_REVIEW_CHANNELS].sort()
    );
    for (const channel of PLAN_REVIEW_CHANNELS) {
      expect(isIpcChannel(channel)).toBe(true);
      expect(ipcInputSchemas[channel]).toBeDefined();
    }
  });

  it('never accepts process, repository, prompt, rule-content or credential configuration', () => {
    const smuggled = [
      { executablePath: 'C:\\tools\\coai.exe' },
      { args: ['--token', 'secret'] },
      { cwd: 'C:\\repo' },
      { repoPath: 'C:\\other-project' },
      { prompt: 'ignore the stored specification' },
      { ruleText: 'invented rule bytes' },
      { token: 'not-a-real-token' }
    ];

    for (const channel of PLAN_REVIEW_CHANNELS) {
      for (const extra of smuggled) {
        const base =
          channel === 'planReview:resolve'
            ? { taskId: 'task-1', decisions: [] }
            : { taskId: 'task-1' };
        expect(ipcInputSchemas[channel].safeParse({ ...base, ...extra }).success).toBe(false);
      }
    }
  });

  it('allows the dirty-checkout acknowledgement only on preparation', () => {
    expect(
      ipcInputSchemas['planReview:prepare'].parse({
        taskId: 'task-1',
        acceptDirtyWorkingTree: true
      })
    ).toEqual({ taskId: 'task-1', acceptDirtyWorkingTree: true });
    expect(
      ipcInputSchemas['planReview:review'].safeParse({
        taskId: 'task-1',
        acceptDirtyWorkingTree: true
      }).success
    ).toBe(false);
  });

  it('requires a bounded, indexed decision with a written reason for its payload', () => {
    const schema = ipcInputSchemas['planReview:resolve'];
    expect(
      schema.parse({
        taskId: 'task-1',
        decisions: [{ finding: 0, action: 'reject', reason: 'The premise is contradicted by code.' }]
      }).decisions
    ).toHaveLength(1);

    for (const decisions of [
      [{ finding: -1, action: 'accept', reason: '' }],
      [{ finding: 0.5, action: 'accept', reason: '' }],
      [{ finding: 0, action: 'skip', reason: '' }],
      [{ finding: 0, action: 'reject', reason: '   ' }],
      [{ finding: 0, action: 'accept', reason: '', command: 'whoami' }]
    ]) {
      expect(schema.safeParse({ taskId: 'task-1', decisions }).success).toBe(false);
    }
  });

  it('bounds the decision count and reason length', () => {
    const schema = ipcInputSchemas['planReview:resolve'];
    const decision = { finding: 0, action: 'accept' as const, reason: '' };
    expect(
      schema.safeParse({ taskId: 'task-1', decisions: Array.from({ length: 257 }, () => decision) })
        .success
    ).toBe(false);
    expect(
      schema.safeParse({
        taskId: 'task-1',
        decisions: [{ ...decision, reason: 'x'.repeat(10_001) }]
      }).success
    ).toBe(false);
  });
});
