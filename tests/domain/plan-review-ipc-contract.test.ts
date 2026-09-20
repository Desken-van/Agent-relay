import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';

const PLAN_REVIEW_CHANNELS = [
  'planReview:get',
  'planReview:bindRules',
  'planReview:prepare',
  'planReview:review',
  'planReview:resolve',
  'planReview:reconcile',
  'planReview:retryFreshSession',
  'planReview:triage',
  'planReview:autoDecide',
  'planReview:resolveAndRevise',
  'planReview:continueCorrection'
] as const;

const SHA = 'a'.repeat(64);

describe('the external plan-review IPC contract', () => {
  it('will not resolve without naming the round the decisions answer', () => {
    const schema = ipcInputSchemas['planReview:resolve'];
    const decisions = [{ finding: 0, action: 'accept' as const, reason: '' }];

    // Decisions are indexed answers, so two rounds of the same length accept
    // each other's silently. The round identity is the only thing that does not
    // line up, which is why it is required rather than optional.
    expect(schema.safeParse({ taskId: 'task-1', decisions }).success).toBe(false);
    expect(schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', decisions }).success).toBe(false);
    expect(schema.safeParse({ taskId: 'task-1', expectedRevision: 1, decisions }).success).toBe(false);
    expect(
      schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', expectedRevision: -1, decisions }).success
    ).toBe(false);
    expect(
      schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', expectedRevision: 1.5, decisions }).success
    ).toBe(false);
    expect(
      schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, decisions }).success
    ).toBe(true);
  });

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

  it('registers exactly the eleven bounded operations', () => {
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
            ? { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, decisions: [] }
            : channel === 'planReview:resolveAndRevise'
              ? { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, decisions: [], autoContinue: false }
              : channel === 'planReview:triage'
                ? { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0 }
                : channel === 'planReview:autoDecide'
                  ? { taskId: 'task-1', gateId: 'gate-1', findingsSha256: SHA, findingIndex: 0 }
                  : channel === 'planReview:continueCorrection'
                    ? { taskId: 'task-1', autoContinue: true }
                    : { taskId: 'task-1' };
        expect(ipcInputSchemas[channel].safeParse({ ...base, ...extra }).success).toBe(false);
      }
    }
  });

  it('accepts only durable identifiers for triage, optionally narrowed to specific finding indexes', () => {
    const schema = ipcInputSchemas['planReview:triage'];
    expect(schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0 }).success).toBe(true);
    expect(
      schema.safeParse({ taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, findingIndexes: [0, 2] }).success
    ).toBe(true);
    // Not a prompt, not raw finding text, not a repository path — only indexes.
    for (const invalid of [
      { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, findingIndexes: [-1] },
      { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, findingIndexes: ['0'] },
      { taskId: 'task-1', gateId: 'gate-1', expectedRevision: 0, findingIndexes: [{ title: 'x' }] },
      { taskId: 'task-1', gateId: 'gate-1', expectedRevision: -1 },
      { taskId: 'task-1', expectedRevision: 0 },
      { taskId: 'task-1', gateId: 'gate-1' }
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('auto-decides exactly one finding of exactly one round, and accepts no answer of its own', () => {
    const schema = ipcInputSchemas['planReview:autoDecide'];
    const valid = { taskId: 'task-1', gateId: 'gate-1', findingsSha256: SHA, findingIndex: 2 };
    expect(schema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, findingsSha256: 'not-a-hash' },
      { ...valid, findingsSha256: SHA.toUpperCase() },
      { ...valid, findingIndex: -1 },
      { ...valid, findingIndex: 1.5 },
      { ...valid, findingIndex: 256 },
      { taskId: 'task-1', gateId: 'gate-1', findingIndex: 0 },
      { taskId: 'task-1', findingsSha256: SHA, findingIndex: 0 },
      // The renderer may not supply the decision, the recommendation or its reason.
      { ...valid, action: 'accept' },
      { ...valid, recommendation: 'accept', reason: 'trust me' },
      { ...valid, findingIndexes: [0, 1] }
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('resolves and revises only against a named round, and can never smuggle in the internal accepted-findings permission', () => {
    const schema = ipcInputSchemas['planReview:resolveAndRevise'];
    const valid = {
      taskId: 'task-1',
      gateId: 'gate-1',
      expectedRevision: 3,
      decisions: [{ finding: 0, action: 'accept' as const, reason: '' }],
      autoContinue: true
    };
    expect(schema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, gateId: undefined },
      { ...valid, expectedRevision: undefined },
      { ...valid, expectedRevision: -1 },
      { ...valid, autoContinue: undefined },
      { ...valid, autoContinue: 'yes' },
      { ...valid, decisions: [{ finding: 0, action: 'reject', reason: '' }] },
      // The service-internal flag that lets an accepted round be resolved by the loop.
      { ...valid, allowAccepted: true },
      // Nor a specification, findings text or a prompt to revise with.
      { ...valid, specification: '{}' },
      { ...valid, acceptedFindings: [] }
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('continues a correction from durable state alone', () => {
    const schema = ipcInputSchemas['planReview:continueCorrection'];
    expect(schema.safeParse({ taskId: 'task-1', autoContinue: false }).success).toBe(true);
    expect(schema.safeParse({ taskId: 'task-1' }).success).toBe(false);
    expect(schema.safeParse({ taskId: 'task-1', autoContinue: true, gateId: 'gate-1' }).success).toBe(false);
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
        gateId: 'gate-1',
        expectedRevision: 3,
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
      schema.safeParse({
        taskId: 'task-1',
        gateId: 'gate-1',
        expectedRevision: 0,
        decisions: Array.from({ length: 257 }, () => decision)
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        taskId: 'task-1',
        decisions: [{ ...decision, reason: 'x'.repeat(10_001) }]
      }).success
    ).toBe(false);
  });
});
