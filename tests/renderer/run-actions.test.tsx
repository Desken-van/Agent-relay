/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrimaryActionButton, publishRecoveryFor, RunFlowOverview } from '../../src/renderer/src/components/RunView';
import { runGuidance, type RunActionKey, type RunGuidance } from '../../src/shared/domain/run-guidance';
import { taskSchema } from '../../src/shared/domain/models';
import { burstClick } from './harness';

afterEach(cleanup);

const ACTIONS: readonly [RunActionKey, string][] = [
  ['generate_specification', 'Generate specification'],
  ['capture_rules', 'Capture and bind rules'],
  ['prepare_plan_review', 'Prepare isolated review branch'],
  ['run_plan_review', 'Run external plan review'],
  ['reconcile_plan_review', 'Reconcile external state'],
  ['resolve_plan_review', 'Resolve external plan review'],
  ['approve_specification', 'Approve specification'],
  ['run_implementation', 'Run implementation · Claude'],
  ['run_implementation', 'Run implementation · Codex'],
  ['run_verification', 'Run verification'],
  ['run_review', 'Run review · Codex'],
  ['run_review', 'Run review · Claude'],
  ['send_corrections', 'Send corrections'],
  ['approve_publishing', 'Approve for publishing'],
  ['continue_in_new_run', 'Continue in a new run']
];

function guidance(key: RunActionKey, label: string): RunGuidance {
  const action = { key, label, enabled: true, disabledReason: null } as const;
  return {
    happened: 'Something completed.', stage: 'Current stage', result: 'Durable result',
    next: action.label, action, activeStep: 1, tone: 'active'
  };
}

describe('the single workflow primary control', () => {
  it.each(ACTIONS)('renders only %s with matching guidance and suppresses burst clicks', async (key, label) => {
    const onClick = vi.fn();
    const projected = guidance(key, label);
    const { container } = render(<>
      <RunFlowOverview guidance={projected} />
      <PrimaryActionButton action={projected.action!} pending={false} blocked={false} onClick={onClick} />
    </>);

    const primary = screen.getByRole('button', { name: label });
    expect(container.querySelectorAll('button.btn--recommended')).toHaveLength(1);
    expect(screen.getAllByText(label)).toHaveLength(2); // guidance plus button
    for (const [, contradictory] of ACTIONS) {
      if (contradictory !== label) expect(screen.queryByRole('button', { name: contradictory })).toBeNull();
    }
    await burstClick(primary);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps a projected but unsafe action present and disabled with its reason', () => {
    const action = {
      key: 'resolve_plan_review' as const,
      label: 'Resolve external plan review',
      enabled: false,
      disabledReason: 'Decide every finding.'
    };
    render(<PrimaryActionButton action={action} pending={false} blocked={false} onClick={() => undefined} />);
    expect(screen.getByRole('button', { name: action.label })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: action.label }).getAttribute('title')).toBe(action.disabledReason);
  });

  it('leaves publishing to the Publishing panel when effective inherited evidence permits it', () => {
    const task = taskSchema.parse({
      id: 'continued', projectId: 'p', title: 'Continued task', originalRequest: 'Do it',
      status: 'READY_TO_PUBLISH', currentRound: 1, maxRounds: 3,
      codexThreadId: null, claudeSessionId: null, codexModel: null, claudeModel: null,
      worktreePath: 'C:/worktree', branchName: 'agent/task', baseBranch: 'main',
      specificationJson: '{}', specificationApprovedAt: '2026-09-10T00:00:00.000Z',
      lastReviewJson: null, lastError: null, createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z'
    });
    const recovery = publishRecoveryFor({ task, effectivePublishRefusal: null });
    const projected = runGuidance(task, [], true, recovery, 'not_required', { isContinuation: true });
    const { container } = render(<RunFlowOverview guidance={projected} />);

    expect(recovery).toBe(false);
    expect(projected.action).toBeNull();
    expect(screen.getByText(/Use the Publishing panel/)).toBeTruthy();
    expect(container.querySelector('button.btn--recommended')).toBeNull();
  });
});
