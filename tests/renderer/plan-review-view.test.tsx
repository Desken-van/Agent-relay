/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { PlanReviewDetail } from '../../src/shared/ipc';
import { PlanReviewPanel } from '../../src/renderer/src/components/RunView';
import { installBridge, ok, type Bridge } from './harness';

const task = (status: Task['status'] = 'DRAFT'): Task => ({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Add a health route',
  originalRequest: 'Add a health route.',
  status,
  currentRound: 0,
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
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z'
});

const emptyDetail: PlanReviewDetail = { ruleEvidence: null, gate: null, findings: [] };

const evidenceDetail: PlanReviewDetail = {
  ruleEvidence: {
    snapshotSha256: 'a'.repeat(64),
    boundAt: '2026-09-06T00:00:00.000Z',
    sources: [
      {
        id: 'project',
        kind: 'project',
        revision: 'b'.repeat(40),
        clean: true
      }
    ],
    files: [
      {
        sourceId: 'project',
        path: 'AGENTS.md',
        bytes: 120,
        sha256: 'c'.repeat(64)
      }
    ],
    omitted: [],
    totalBytes: 120
  },
  gate: null,
  findings: []
};

let bridge: Bridge;

beforeEach(() => {
  bridge = installBridge({ 'planReview:get': () => ok<'planReview:get'>(emptyDetail) });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

describe('the external plan-review panel', () => {
  it('captures rule bytes by task id without accepting renderer-supplied source configuration', async () => {
    bridge.set('planReview:bindRules', () => ok<'planReview:bindRules'>(evidenceDetail));
    const onChanged = vi.fn(async () => undefined);
    render(<PlanReviewPanel task={task()} integrationEnabled onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: /Capture and bind rules/i }));

    await screen.findByText(/Captured files and omissions/i);
    expect(bridge.callsTo('planReview:bindRules')).toEqual([
      { channel: 'planReview:bindRules', input: { taskId: 'task-1' } }
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('does not retrofit the gate onto an existing task that never opted in', async () => {
    render(
      <PlanReviewPanel
        task={task('READY_FOR_IMPLEMENTATION')}
        integrationEnabled
        onChanged={async () => undefined}
      />
    );

    expect(await screen.findByText(/did not opt in/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Capture and bind rules/i })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('requires a reason before it submits a rejected finding', async () => {
    const awaiting: PlanReviewDetail = {
      ...evidenceDetail,
      gate: {
        id: 'gate-1',
        taskId: 'task-1',
        specificationSha256: 'd'.repeat(64),
        ruleEvidenceSha256: 'a'.repeat(64),
        sessionId: 'session-1',
        serverName: 'coai',
        serverVersion: '1.0.0',
        status: 'awaiting_resolve',
        verdict: 'revise',
        findingsJson: null,
        decisionsJson: null,
        reviewers: 'codex:architecture',
        gatingCount: 1,
        threshold: 1,
        lastError: null,
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z'
      },
      findings: [
        {
          severity: 'major',
          category: 'reliability',
          file: 'src/service.ts',
          line: 42,
          title: 'The retry is ambiguous',
          why: 'A lost response may repeat work.',
          fix: 'Persist the intent before calling out.',
          providers: ['codex'],
          role: 'SecurityReliability'
        }
      ]
    };
    bridge.set('planReview:get', () => ok<'planReview:get'>(awaiting));
    bridge.set('planReview:resolve', () => ok<'planReview:resolve'>({
      ...awaiting,
      gate: awaiting.gate ? { ...awaiting.gate, status: 'changes_requested' } : null
    }));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    fireEvent.change(await screen.findByLabelText('Decision'), { target: { value: 'reject' } });
    const resolveButton = screen.getByRole('button', { name: /Resolve all findings/i });
    expect(resolveButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'The current state machine already persists that intent.' }
    });
    expect(resolveButton).toHaveProperty('disabled', false);
    fireEvent.click(resolveButton);

    await waitFor(() => expect(bridge.callsTo('planReview:resolve')).toHaveLength(1));
    expect(bridge.callsTo('planReview:resolve')[0]?.input).toEqual({
      taskId: 'task-1',
      decisions: [
        {
          finding: 0,
          action: 'reject',
          reason: 'The current state machine already persists that intent.'
        }
      ]
    });
  });

  it('shows an unknown in-flight outcome without offering an automatic repeat', async () => {
    bridge.set('planReview:get', () =>
      ok<'planReview:get'>({
        ...evidenceDetail,
        gate: {
          id: 'gate-1',
          taskId: 'task-1',
          specificationSha256: 'd'.repeat(64),
          ruleEvidenceSha256: 'a'.repeat(64),
          sessionId: null,
          serverName: null,
          serverVersion: null,
          status: 'reviewing',
          verdict: null,
          findingsJson: null,
          decisionsJson: null,
          reviewers: null,
          gatingCount: null,
          threshold: null,
          lastError: null,
          createdAt: '2026-09-06T00:00:00.000Z',
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      })
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/will not repeat it/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
  });
});
