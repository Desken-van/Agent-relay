import { describe, expect, it } from 'vitest';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import { runGuidance, type RunActionKey, type RunGuidanceExtra } from '../../src/shared/domain/run-guidance';

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

/** Asserts the descriptor's invariant: whenever an action exists, `next` is exactly its label. */
function expectConsistent(value: ReturnType<typeof runGuidance>): void {
  if (value.action) {
    expect(value.next).toBe(value.action.label);
  }
}

describe('run guidance — exactly one action per state', () => {
  it.each([
    ['DRAFT', false, false, 'generate_specification', 'Generate specification'],
    ['READY_FOR_IMPLEMENTATION', true, false, 'approve_specification', 'Approve specification'],
    ['READY_FOR_IMPLEMENTATION', true, true, 'run_implementation', 'Run implementation · Claude'],
    ['READY_FOR_REVIEW', true, true, 'run_review', 'Run review · Codex'],
    ['APPROVED', true, true, 'approve_publishing', 'Approve for publishing'],
    ['CHANGES_REQUESTED', true, true, 'send_corrections', 'Send corrections'],
    ['SPECIFYING', true, true, null, null],
    ['IMPLEMENTING', true, true, null, null],
    ['VERIFYING', true, true, null, null],
    ['REVIEWING', true, true, null, null],
    ['READY_TO_PUBLISH', true, true, null, null],
    ['PUBLISHING', true, true, null, null],
    ['COMPLETED', true, true, null, null],
    ['CANCELLED', true, true, null, null]
  ] as const)('%s → %s', (status, hasSpecification, approved, actionKey, label) => {
    const value = runGuidance(task({
      status,
      currentRound: status === 'CHANGES_REQUESTED' ? 0 : baseTask.currentRound,
      specificationApprovedAt: approved ? '2026-09-11T00:00:00.000Z' : null
    }), [], hasSpecification);

    expect(value.action?.key ?? null).toBe(actionKey);
    if (label) expect(value.action?.label).toBe(label);
    expectConsistent(value);

    // The four required headings are always present as non-empty text.
    expect(value.happened.length).toBeGreaterThan(0);
    expect(value.stage.length).toBeGreaterThan(0);
    expect(value.result.length).toBeGreaterThan(0);
    expect(value.next.length).toBeGreaterThan(0);
  });

  it('offers verification, not implementation, after an incomplete implementation attempt', () => {
    const value = runGuidance(task({
      status: 'READY_FOR_IMPLEMENTATION', currentRound: 1,
      specificationApprovedAt: '2026-09-11T00:00:00.000Z'
    }), [run({})], true);
    expect(value.action?.key).toBe('run_verification');
    expect(value.action?.label).toBe('Run verification');
    expectConsistent(value);
  });

  it('offers an implementation repair after Relay verification failed', () => {
    const value = runGuidance(task({
      status: 'READY_FOR_IMPLEMENTATION', currentRound: 2,
      specificationApprovedAt: '2026-09-11T00:00:00.000Z',
      implementationProvider: 'codex',
      lastError: 'npm run verify failed (exit 1). See command output.'
    }), [
      run({ id: 'implementation', runType: 'implementation', status: 'succeeded' }),
      run({
        id: 'verification', runType: 'verification', agent: 'system', status: 'failed',
        structuredResult: JSON.stringify({
          version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false,
          exitCode: 1, durationMs: 10, reason: 'npm run verify failed (exit 1). See command output.'
        }),
        errorMessage: 'npm run verify failed (exit 1). See command output.'
      })
    ], true);

    expect(value.action).toMatchObject({
      key: 'run_implementation', label: 'Fix verification failures · Codex', enabled: true
    });
    expect(value.stage).toBe('Step 2 of 5 · Fix verification failures');
    expectConsistent(value);
  });

  it('offers another verification after an infrastructure timeout, not an AI repair', () => {
    const value = runGuidance(task({
      status: 'READY_FOR_IMPLEMENTATION', currentRound: 2,
      specificationApprovedAt: '2026-09-11T00:00:00.000Z'
    }), [
      run({ id: 'implementation', runType: 'implementation', status: 'succeeded' }),
      run({
        id: 'verification', runType: 'verification', agent: 'system', status: 'failed',
        structuredResult: JSON.stringify({
          version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false,
          exitCode: null, durationMs: 10, reason: 'Verification timed out; success was not established.'
        })
      })
    ], true);

    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expectConsistent(value);
  });

  it('names the selected review provider in the review label', () => {
    const value = runGuidance(task({ status: 'READY_FOR_REVIEW', reviewProvider: 'claude' }), [], true);
    expect(value.action?.label).toBe('Run review · Claude');
    expectConsistent(value);
  });

  it('names the selected implementation provider in the implementation label', () => {
    const value = runGuidance(task({
      status: 'READY_FOR_IMPLEMENTATION',
      specificationApprovedAt: '2026-09-11T00:00:00.000Z',
      implementationProvider: 'codex'
    }), [], true);
    expect(value.action?.label).toBe('Run implementation · Codex');
    expectConsistent(value);
  });
});

describe('run guidance — External Plan Review states', () => {
  it.each([
    ['loading', null],
    ['unavailable', null],
    ['working', null],
    ['capture_rules', 'capture_rules'],
    ['ready', 'generate_specification'],
    ['not_required', 'generate_specification']
  ] as const)('DRAFT with plan-review state %s selects %s', (state, actionKey) => {
    const value = runGuidance(task({ status: 'DRAFT' }), [], false, false, state);
    expect(value.action?.key ?? null).toBe(actionKey);
    expectConsistent(value);
  });

  it.each([
    ['loading', null],
    ['working', null],
    ['unavailable', null],
    ['prepare_review', 'prepare_plan_review'],
    ['run_review', 'run_plan_review'],
    ['run_next_review', 'run_plan_review'],
    ['reconcile', 'reconcile_plan_review'],
    ['resolve', 'resolve_plan_review'],
    ['passed', 'approve_specification'],
    ['not_required', 'approve_specification']
  ] as const)('unapproved READY_FOR_IMPLEMENTATION with plan-review state %s selects %s', (state, actionKey) => {
    const value = runGuidance(task({ status: 'READY_FOR_IMPLEMENTATION' }), [], true, false, state);
    expect(value.action?.key ?? null).toBe(actionKey);
    expectConsistent(value);
  });

  it('uses the same "Run external plan review" label for a first round and a next round', () => {
    const first = runGuidance(task({ status: 'READY_FOR_IMPLEMENTATION' }), [], true, false, 'run_review');
    const next = runGuidance(task({ status: 'READY_FOR_IMPLEMENTATION' }), [], true, false, 'run_next_review');
    expect(first.action?.label).toBe('Run external plan review');
    expect(next.action?.label).toBe('Run external plan review');
  });

  it('labels resolution "Resolve external plan review", not the decision-form submit text', () => {
    const value = runGuidance(task({ status: 'READY_FOR_IMPLEMENTATION' }), [], true, false, 'resolve');
    expect(value.action?.label).toBe('Resolve external plan review');
  });
});

describe('run guidance — review round exhaustion and continuation', () => {
  it('does not recommend corrections after the round budget is spent', () => {
    const value = runGuidance(task({ status: 'CHANGES_REQUESTED', currentRound: 2, maxRounds: 2 }), [], true);
    expect(value.action).toBeNull();
    expect(value.result).toContain('All 2');
  });

  it('offers "Continue in a new run" once a FAILED task exhausted its budget on changes requested', () => {
    const value = runGuidance(
      task({ status: 'FAILED', currentRound: 2, maxRounds: 2, lastError: 'Review round limit reached (2/2).' }),
      [run({ runType: 'review', status: 'succeeded' })],
      true,
      false,
      'not_required',
      { lastReviewVerdict: 'changes_requested' }
    );
    expect(value.action?.key).toBe('continue_in_new_run');
    expect(value.action?.label).toBe('Continue in a new run');
    expectConsistent(value);
  });

  it('does not offer a continuation for a FAILED task that did not exhaust the round budget', () => {
    const value = runGuidance(
      task({ status: 'FAILED', currentRound: 0, maxRounds: 2 }),
      [],
      true,
      false,
      'not_required',
      { lastReviewVerdict: null }
    );
    expect(value.action).toBeNull();
  });

  it('does not offer a continuation for a FAILED task whose last review approved or blocked', () => {
    for (const verdict of ['approved', 'blocked'] as const) {
      const value = runGuidance(
        task({ status: 'FAILED', currentRound: 2, maxRounds: 2 }),
        [],
        true,
        false,
        'not_required',
        { lastReviewVerdict: verdict }
      );
      expect(value.action).toBeNull();
    }
  });

  it('does not offer a continuation without a durable successful final review run', () => {
    for (const runs of [[], [run({ runType: 'review', status: 'failed' })]]) {
      const value = runGuidance(
        task({ status: 'FAILED', currentRound: 2, maxRounds: 2 }),
        runs,
        true,
        false,
        'not_required',
        { lastReviewVerdict: 'changes_requested' }
      );
      expect(value.action).toBeNull();
    }
  });

  it('stops offering the continuation button once one already exists, pointing at it instead', () => {
    const value = runGuidance(
      task({ status: 'FAILED', currentRound: 2, maxRounds: 2 }),
      [],
      true,
      false,
      'not_required',
      { lastReviewVerdict: 'changes_requested', continuationTaskId: 'task-2' }
    );
    expect(value.action).toBeNull();
    expect(value.next).toContain('continuation');
  });

  it('explains that an ordinary failed run is closed instead of suggesting a dead button', () => {
    const value = runGuidance(task({
      status: 'FAILED', currentRound: 2, lastError: 'Review round limit reached (2/2).'
    }), [run({ runType: 'review', status: 'succeeded' })], true);
    expect(value.action).toBeNull();
    expect(value.happened).toContain('final review');
    expect(value.result).toBe('Review round limit reached (2/2).');
    expect(value.next).toContain('run is closed');
  });
});

describe('run guidance — continuation entry state', () => {
  it('shows "Run verification" for a continuation whose inherited verification needs recomputing', () => {
    const value = runGuidance(
      task({ status: 'READY_FOR_IMPLEMENTATION', specificationApprovedAt: '2026-09-11T00:00:00.000Z' }),
      [],
      true,
      false,
      'not_required',
      { continuationEntryAction: 'verification' }
    );
    expect(value.action?.key).toBe('run_verification');
    expectConsistent(value);
  });

  it('shows "Run implementation" for a plain (non-continuation) approved specification', () => {
    const value = runGuidance(
      task({ status: 'READY_FOR_IMPLEMENTATION', specificationApprovedAt: '2026-09-11T00:00:00.000Z' }),
      [],
      true,
      false,
      'not_required',
      { continuationEntryAction: null }
    );
    expect(value.action?.key).toBe('run_implementation');
  });

  it('keeps a continuation on verification after its entry lease is consumed', () => {
    const value = runGuidance(
      task({ status: 'READY_FOR_IMPLEMENTATION', specificationApprovedAt: '2026-09-11T00:00:00.000Z' }),
      [],
      true,
      false,
      'not_required',
      { isContinuation: true }
    );
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification' });
    expectConsistent(value);
  });
});

describe('run guidance — publish-evidence recovery', () => {
  it('recommends Run verification when the publish gate refused non-security evidence', () => {
    const value = runGuidance(task({ status: 'READY_TO_PUBLISH', currentRound: 1, maxRounds: 2 }), [], true, 'verification');
    expect(value.action).toMatchObject({ key: 'run_verification', label: 'Run verification', enabled: true });
    expect(value.next).toBe('Run verification');
  });

  it('recommends Send corrections for a security denial while budget remains', () => {
    const value = runGuidance(task({ status: 'READY_TO_PUBLISH', currentRound: 1, maxRounds: 2 }), [], true, 'correction');
    expect(value.action?.key).toBe('send_corrections');
    expect(value.action?.enabled).toBe(true);
    expectConsistent(value);
  });

  it('disables the recovery action once the round budget is exhausted', () => {
    const value = runGuidance(task({ status: 'READY_TO_PUBLISH', currentRound: 2, maxRounds: 2 }), [], true, 'correction');
    expect(value.action?.key).toBe('send_corrections');
    expect(value.action?.enabled).toBe(false);
    expect(value.action?.disabledReason).toBeTruthy();
  });

  it('offers no primary action once publishing is unlocked cleanly', () => {
    const value = runGuidance(task({ status: 'READY_TO_PUBLISH' }), [], true, false);
    expect(value.action).toBeNull();
    expect(value.next).toContain('Publishing panel');
  });
});

describe('run guidance — every action label is one of the fixed set', () => {
  const FIXED_LABELS = new Set([
    'Generate specification',
    'Capture and bind rules',
    'Prepare isolated review branch',
    'Run external plan review',
    'Reconcile external state',
    'Resolve external plan review',
    'Approve specification',
    'Run implementation · Claude',
    'Run implementation · Codex',
    'Run verification',
    'Run review · Claude',
    'Run review · Codex',
    'Send corrections',
    'Approve for publishing',
    'Continue in a new run'
  ]);

  const STATUSES = [
    'DRAFT', 'SPECIFYING', 'READY_FOR_IMPLEMENTATION', 'IMPLEMENTING', 'VERIFYING',
    'READY_FOR_REVIEW', 'REVIEWING', 'CHANGES_REQUESTED', 'APPROVED', 'READY_TO_PUBLISH',
    'PUBLISHING', 'COMPLETED', 'FAILED', 'CANCELLED'
  ] as const;
  const PLAN_STATES = [
    'not_required', 'loading', 'capture_rules', 'ready', 'prepare_review', 'run_review',
    'run_next_review', 'reconcile', 'resolve', 'passed', 'working', 'unavailable'
  ] as const;

  it('every combination either has no action or one of the fixed labels', () => {
    const extras: RunGuidanceExtra[] = [
      {},
      { lastReviewVerdict: 'changes_requested' },
      { continuationEntryAction: 'verification' },
      { continuationTaskId: 'task-2' }
    ];
    for (const status of STATUSES) {
      for (const planState of PLAN_STATES) {
        for (const hasSpec of [true, false]) {
          for (const approved of [true, false]) {
            for (const extra of extras) {
              const value = runGuidance(
                task({ status, currentRound: 2, maxRounds: 2, specificationApprovedAt: approved ? '2026-09-11T00:00:00.000Z' : null }),
                [],
                hasSpec,
                false,
                planState,
                extra
              );
              if (value.action) {
                expect(FIXED_LABELS.has(value.action.label)).toBe(true);
                expect(value.next).toBe(value.action.label);
              }
            }
          }
        }
      }
    }
  });
});

describe('run guidance — action keys are a closed set', () => {
  it('never returns an action key outside the documented union', () => {
    const known: readonly RunActionKey[] = [
      'capture_rules', 'generate_specification', 'prepare_plan_review', 'run_plan_review',
      'reconcile_plan_review', 'resolve_plan_review', 'approve_specification', 'run_implementation',
      'run_verification', 'run_review', 'send_corrections', 'approve_publishing', 'continue_in_new_run'
    ];
    expect(known).toHaveLength(13);
  });
});
