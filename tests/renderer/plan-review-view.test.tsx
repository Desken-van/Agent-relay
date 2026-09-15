/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { IpcResult, PlanReviewDetail } from '../../src/shared/ipc';
import { PlanReviewPanel } from '../../src/renderer/src/components/RunView';
import { burstClick, deferred, deliver, fail, installBridge, ok, type Bridge } from './harness';

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
  implementationProvider: 'claude',
  reviewProvider: 'codex',
  providerRevision: 0,
  implementationThreadId: null,
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

const emptyDetail: PlanReviewDetail = {
  ruleEvidence: null,
  ruleEvidenceProblem: null,
  gate: null,
  gateIdentity: 'no_gate',
  findings: []
};

const evidenceDetail: PlanReviewDetail = {
  ruleEvidenceProblem: null,
  gateIdentity: 'no_gate',
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
  it('reports rule binding as the next action and highlights that button', async () => {
    const onGuidanceStateChanged = vi.fn();
    render(
      <PlanReviewPanel
        task={task()}
        integrationEnabled
        onChanged={async () => undefined}
        onGuidanceStateChanged={onGuidanceStateChanged}
      />
    );

    const button = await screen.findByRole('button', { name: /Capture and bind rules/i });
    await waitFor(() => expect(onGuidanceStateChanged).toHaveBeenLastCalledWith('capture_rules'));
    expect(button.className).toContain('btn--recommended');
  });

  it('captures rule bytes by task id without accepting renderer-supplied source configuration', async () => {
    bridge.set('planReview:bindRules', () => ok<'planReview:bindRules'>(evidenceDetail));
    const onChanged = vi.fn(async () => undefined);
    const onGuidanceStateChanged = vi.fn();
    render(
      <PlanReviewPanel
        task={task()}
        integrationEnabled
        onChanged={onChanged}
        onGuidanceStateChanged={onGuidanceStateChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Capture and bind rules/i }));

    await screen.findByText(/Captured files and omissions/i);
    expect(bridge.callsTo('planReview:bindRules')).toEqual([
      { channel: 'planReview:bindRules', input: { taskId: 'task-1' } }
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
    await waitFor(() => expect(onGuidanceStateChanged).toHaveBeenLastCalledWith('ready'));
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

  it('makes review preparation the next action after a bound specification is generated', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(evidenceDetail));
    const onGuidanceStateChanged = vi.fn();
    render(
      <PlanReviewPanel
        task={task('READY_FOR_IMPLEMENTATION')}
        integrationEnabled
        onChanged={async () => undefined}
        onGuidanceStateChanged={onGuidanceStateChanged}
      />
    );

    const button = await screen.findByRole('button', { name: /Prepare isolated review branch/i });
    await waitFor(() => expect(onGuidanceStateChanged).toHaveBeenLastCalledWith('prepare_review'));
    expect(button.className).toContain('btn--recommended');
  });

  it('turns a dirty checkout into an explicit choice and retries only after acceptance', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(evidenceDetail));
    bridge.set('planReview:prepare', () => ({
      ok: false,
      error: {
        code: 'GIT_DIRTY',
        message: 'The project has uncommitted changes.',
        details: 'M src/service.ts\n?? notes.txt'
      }
    }));
    render(
      <PlanReviewPanel
        task={task('READY_FOR_IMPLEMENTATION')}
        integrationEnabled
        onChanged={async () => undefined}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare isolated review branch/i }));
    expect(await screen.findByText(/Uncommitted files remain outside this task/i)).toBeTruthy();
    expect(screen.getByText(/M src\/service\.ts/)).toBeTruthy();

    bridge.set('planReview:prepare', () => ok<'planReview:prepare'>(gateWith('prepared')));
    fireEvent.click(screen.getByRole('button', { name: /Continue with current HEAD/i }));

    await waitFor(() => expect(bridge.callsTo('planReview:prepare')).toHaveLength(2));
    expect(bridge.callsTo('planReview:prepare')[0]?.input).toEqual({ taskId: 'task-1' });
    expect(bridge.callsTo('planReview:prepare')[1]?.input).toEqual({
      taskId: 'task-1',
      acceptDirtyWorkingTree: true
    });
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
        reconciledAt: null,
        revision: 0,
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
    const resolveButton = screen.getByRole('button', { name: /Resolve external plan review/i });
    expect(resolveButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'The current state machine already persists that intent.' }
    });
    expect(resolveButton).toHaveProperty('disabled', false);
    fireEvent.click(resolveButton);

    await waitFor(() => expect(bridge.callsTo('planReview:resolve')).toHaveLength(1));
    expect(bridge.callsTo('planReview:resolve')[0]?.input).toEqual({
      taskId: 'task-1',
      // The round the operator was actually looking at, so the main process can
      // refuse these answers if it has since been replaced.
      gateId: 'gate-1',
      expectedRevision: 0,
      decisions: [
        {
          finding: 0,
          action: 'reject',
          reason: 'The current state machine already persists that intent.'
        }
      ]
    });
  });

  const gateWith = (
    status: string,
    extra: Record<string, unknown> = {},
    gateIdentity: PlanReviewDetail['gateIdentity'] = 'current'
  ): PlanReviewDetail => ({
    ...evidenceDetail,
    gateIdentity,
    gate: {
      id: 'gate-1',
      taskId: 'task-1',
      specificationSha256: 'd'.repeat(64),
      ruleEvidenceSha256: 'a'.repeat(64),
      sessionId: null,
      serverName: null,
      serverVersion: null,
      status,
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null,
      revision: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
      ...extra
    } as PlanReviewDetail['gate']
  });

  it('fills every undecided finding with the safe accept recommendation without overwriting a rejection', async () => {
    const awaiting: PlanReviewDetail = {
      ...gateWith('awaiting_resolve', {
        verdict: 'revise',
        reviewers: 'codex:architecture, codex:reliability',
        gatingCount: 2,
        threshold: 1
      }),
      findings: [
        {
          severity: 'major', category: 'reliability', file: 'src/service.ts', line: 42,
          title: 'Persist the intent', why: 'A lost response may repeat work.',
          fix: 'Persist before dispatch.', providers: ['codex'], role: 'SecurityReliability'
        },
        {
          severity: 'minor', category: 'ux', file: 'src/view.tsx', line: 12,
          title: 'Explain the state', why: 'The next action is unclear.',
          fix: 'Add precise copy.', providers: ['codex'], role: 'UX'
        }
      ]
    };
    bridge.set('planReview:get', () => ok<'planReview:get'>(awaiting));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    const decisions = await screen.findAllByLabelText('Decision');
    fireEvent.change(decisions[0]!, { target: { value: 'reject' } });
    fireEvent.change(screen.getAllByLabelText(/^Reason/)[0]!, {
      target: { value: 'The existing invariant already covers it.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Accept all undecided findings/i }));

    expect((decisions[0] as HTMLSelectElement).value).toBe('reject');
    expect((decisions[1] as HTMLSelectElement).value).toBe('accept');
    expect(screen.getByRole('button', { name: /Resolve external plan review/i })).toHaveProperty(
      'disabled',
      false
    );
  });

  it('offers a read-only reconciliation for an unknown outcome, and never a repeat', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('reviewing')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByRole('button', { name: /Reconcile external state/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
  });

  it('offers the same recovery for a row an earlier version closed as failed', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('failed', { lastError: 'answer lost' })));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByRole('button', { name: /Reconcile external state/i })).toBeTruthy();
  });

  it('sends one reconciliation for two clicks in the same tick', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('resolving')));
    const answer = deferred<IpcResult<PlanReviewDetail>>();
    bridge.set('planReview:reconcile', () => answer.promise);
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    const button = await screen.findByRole('button', { name: /Reconcile external state/i });
    // Nested in one act, so nothing re-renders between the two presses and the
    // disabled attribute cannot arbitrate. Only a synchronous claim can.
    await burstClick(button, 2);
    expect(bridge.callsTo('planReview:reconcile')).toHaveLength(1);

    // The answer is delivered inside `act` and the panel is watched until it has
    // finished reacting. A deferred left hanging past the end of the test would
    // settle with nothing owning the state update it causes, which is the whole
    // content of a React act warning; the request count is then re-read to show
    // that finishing the first reconciliation did not release a second.
    await deliver(answer, ok<'planReview:reconcile'>(gateWith('awaiting_resolve')));
    expect(await screen.findByText(/Decide every finding/i)).toBeTruthy();
    expect(bridge.callsTo('planReview:reconcile')).toHaveLength(1);
  });

  it('offers no way to start a round while the provider is still running one', async () => {
    bridge.set('planReview:get', () =>
      ok<'planReview:get'>(
        gateWith('reviewing', {
          lastError: 'The provider is still executing a plan round for this session, so nothing here may start another.'
        })
      )
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/still executing a plan round/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
  });

  it('says plainly when the provider answered for another session', async () => {
    bridge.set('planReview:get', () =>
      ok<'planReview:get'>(
        gateWith('resolving', {
          lastError:
            'The provider answered for a different session than this gate recorded, so none of it was applied.'
        })
      )
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/different session/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
  });

  it('lets an interrupted round be restarted by hand and says why', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('interrupted')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/started in the provider and never finished/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run external plan review/i })).toBeTruthy();
    // Not a repeat of a finished round: there is no reconciliation to offer here,
    // because the outcome of the previous one is already known to be nothing.
    expect(screen.queryByRole('button', { name: /Reconcile external state/i })).toBeNull();
  });

  it('shows the durable in-flight state after a lost review, without a remount', async () => {
    // What the panel was showing when the operator pressed the button.
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('prepared')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );
    const start = await screen.findByRole('button', { name: /Run external plan review/i });

    // The dispatch happened and the answer did not come back. The main process
    // has already written `reviewing`; this screen still believes `prepared`.
    bridge.set('planReview:review', () => fail('The external reviewer did not answer.', 'TIMEOUT'));
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('reviewing')));
    fireEvent.click(start);

    // The failure is reported AND the display catches up, so the way out is on
    // screen instead of behind a reload.
    expect(await screen.findByText(/did not answer/i)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Reconcile external state/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
    // Exactly one read-back, and never a second dispatch.
    expect(bridge.callsTo('planReview:review')).toHaveLength(1);
    expect(bridge.callsTo('planReview:get')).toHaveLength(2);
  });

  it('shows the durable in-flight state after a lost resolution, without a remount', async () => {
    const awaiting = gateWith('awaiting_resolve', {
      verdict: 'revise',
      reviewers: 'codex:architecture',
      gatingCount: 1,
      threshold: 1
    });
    bridge.set('planReview:get', () => ok<'planReview:get'>(awaiting));
    bridge.set('planReview:resolve', () => fail('The resolution did not answer.', 'TIMEOUT'));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    const resolveButton = await screen.findByRole('button', { name: /Resolve external plan review/i });
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('resolving')));
    fireEvent.click(resolveButton);

    expect(await screen.findByText(/did not answer/i)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Reconcile external state/i })).toBeTruthy();
    expect(bridge.callsTo('planReview:resolve')).toHaveLength(1);
  });

  it('keeps the original failure when the read-back fails too', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('prepared')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );
    const start = await screen.findByRole('button', { name: /Run external plan review/i });

    bridge.set('planReview:review', () => fail('The external reviewer did not answer.', 'TIMEOUT'));
    bridge.set('planReview:get', () => fail('The database is unavailable.', 'INTERNAL'));
    fireEvent.click(start);

    // No invented outcome, and the failure that matters is still the one shown.
    expect(await screen.findByText(/did not answer/i)).toBeTruthy();
    expect(screen.queryByText(/database is unavailable/i)).toBeNull();
    expect(bridge.callsTo('planReview:review')).toHaveLength(1);
  });

  it('drops decision drafts when the round changes but not while one is edited', async () => {
    const round = (revision: number, title: string): PlanReviewDetail => ({
      ...evidenceDetail,
      gate: {
        ...(gateWith('awaiting_resolve', {
          verdict: 'revise',
          reviewers: 'codex:architecture',
          gatingCount: 1,
          threshold: 1,
          revision
        }).gate as NonNullable<PlanReviewDetail['gate']>)
      },
      findings: [
        {
          severity: 'major',
          category: 'reliability',
          file: 'src/service.ts',
          line: 42,
          title,
          why: 'It matters for this round only.',
          fix: 'Address it.',
          providers: ['codex'],
          role: 'SecurityReliability'
        }
      ]
    });

    bridge.set('planReview:get', () => ok<'planReview:get'>(round(0, 'Round A finding')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    // Editing within one round keeps what was typed.
    fireEvent.change(await screen.findByLabelText('Decision'), { target: { value: 'reject' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'Round A reason, wrong round.' }
    });
    expect(screen.getByRole('button', { name: /Resolve external plan review/i })).toHaveProperty(
      'disabled',
      false
    );
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toContain('Round A');

    // Round A is resolved and a different round of the same length replaces it.
    // The answers were about findings that are no longer on the table, so they
    // do not carry over — and with them gone the new round cannot be resolved
    // by an idle click on a button that still looked ready.
    bridge.set('planReview:resolve', () => ok<'planReview:resolve'>(round(1, 'Round B finding')));
    await burstClick(screen.getByRole('button', { name: /Resolve external plan review/i }), 1);

    expect(await screen.findByText(/Round B finding/)).toBeTruthy();
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: /Resolve external plan review/i })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('offers approval for a proceeded gate that speaks for the current specification', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('proceeded')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/You may now approve the specification/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
    expect(screen.queryByText(/settled against an earlier specification/i)).toBeNull();
  });

  it('withdraws the approval message once the specification is regenerated', async () => {
    // Gate A really did pass — for specification A. It is still the newest row,
    // so nothing about the gate itself has changed; only the question it answers
    // has, and the main process is the one that says so.
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('proceeded', {}, 'obsolete')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/settled against an earlier specification/i)).toBeTruthy();
    expect(screen.queryByText(/You may now approve the specification/i)).toBeNull();
  });

  it('offers exactly one preparation for the regenerated specification', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('proceeded', {}, 'obsolete')));
    bridge.set('planReview:prepare', () =>
      ok<'planReview:prepare'>(gateWith('prepared', { id: 'gate-2', revision: 0 }))
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    const prepare = await screen.findByRole('button', {
      name: /Prepare isolated review branch/i
    });
    // Two presses in one tick: the synchronous claim, not the disabled attribute,
    // is what keeps a local Git mutation to one request.
    await burstClick(prepare, 2);

    expect(bridge.callsTo('planReview:prepare')).toEqual([
      { channel: 'planReview:prepare', input: { taskId: 'task-1' } }
    ]);
    // And the panel now shows the gate that was just prepared.
    expect(await screen.findByRole('button', { name: /Run external plan review/i })).toBeTruthy();
    expect(screen.queryByText(/settled against an earlier specification/i)).toBeNull();
  });

  it('gives an obsolete gate with an outstanding round no way around it', async () => {
    for (const status of ['opening', 'reviewing', 'awaiting_resolve', 'resolving', 'failed']) {
      bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith(status, {}, 'obsolete')));
      const view = render(
        <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
      );

      expect(await screen.findByText(/its previous round is still outstanding/i)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
      expect(screen.queryByText(/You may now approve the specification/i)).toBeNull();
      expect(bridge.callsTo('planReview:prepare')).toHaveLength(0);
      view.unmount();
    }
  });

  it('does not call an unverifiable identity obsolete, nor offer a preparation for it', async () => {
    // The gate exists and really did pass; what could not be read is the
    // evidence needed to judge whether it still speaks for this specification.
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('proceeded', {}, 'unknown')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/could not be established/i)).toBeTruthy();
    // Not staleness, not approval, and not an action that needs the very
    // evidence that could not be read.
    expect(screen.queryByText(/settled against an earlier specification/i)).toBeNull();
    expect(screen.queryByText(/You may now approve the specification/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
    expect(bridge.callsTo('planReview:prepare')).toHaveLength(0);
  });

  it('keeps the corrupt-binding message when the identity cannot be verified', async () => {
    bridge.set('planReview:get', () =>
      ok<'planReview:get'>({
        ruleEvidence: null,
        ruleEvidenceProblem: 'The stored rule-evidence binding does not match its snapshot.',
        gate: gateWith('proceeded').gate,
        gateIdentity: 'unknown',
        findings: []
      })
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    // Both facts are the operator's business, and neither replaces the other.
    expect(await screen.findByText(/bound rule evidence cannot be read/i)).toBeTruthy();
    expect(screen.getByText(/could not be established/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Capture and bind rules/i })).toBeNull();
  });

  it('replaces the round-start button with a preparation for every obsolete settled state', async () => {
    for (const status of ['prepared', 'changes_requested', 'interrupted']) {
      bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith(status, {}, 'obsolete')));
      const view = render(
        <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
      );

      expect(
        await screen.findAllByRole('button', { name: /Prepare isolated review branch/i })
      ).toHaveLength(1);
      // Starting a round here would review the specification the gate already
      // belongs to, not the one on screen.
      expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
      view.unmount();
    }
  });

  it('offers no round to start while the gate identity cannot be verified', async () => {
    for (const status of ['prepared', 'changes_requested', 'interrupted']) {
      bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith(status, {}, 'unknown')));
      const view = render(
        <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
      );

      // A round is not idempotent, and this gate cannot say which specification
      // it would be reviewing. The honest warning is the only thing on offer.
      expect(await screen.findByText(/could not be established/i)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Run external plan review/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Prepare isolated review branch/i })).toBeNull();
      expect(screen.queryByText(/You may now approve the specification/i)).toBeNull();
      expect(bridge.callsTo('planReview:review')).toHaveLength(0);
      expect(bridge.callsTo('planReview:prepare')).toHaveLength(0);
      view.unmount();
    }
  });

  it('does not promise a fresh round for an interrupted gate it cannot verify', async () => {
    bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith('interrupted', {}, 'unknown')));
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/could not be established/i)).toBeTruthy();
    // The interrupted notice ends with "a new round can be started by hand",
    // which is a promise this state cannot keep.
    expect(screen.queryByText(/started in the provider and never finished/i)).toBeNull();
  });

  it('keeps the round-start action and its explanation for a verified gate', async () => {
    for (const [status, label] of [
      ['prepared', /Run external plan review/i],
      ['changes_requested', /Run external plan review/i],
      ['interrupted', /Run external plan review/i]
    ] as const) {
      bridge.set('planReview:get', () => ok<'planReview:get'>(gateWith(status, {}, 'current')));
      const onGuidanceStateChanged = vi.fn();
      const view = render(
        <PlanReviewPanel
          task={task('READY_FOR_IMPLEMENTATION')}
          integrationEnabled
          onChanged={async () => undefined}
          onGuidanceStateChanged={onGuidanceStateChanged}
        />
      );

      const button = await screen.findByRole('button', { name: label });
      await waitFor(() => expect(onGuidanceStateChanged).toHaveBeenLastCalledWith(
        status === 'prepared' ? 'run_review' : 'run_next_review'
      ));
      expect(button.className).toContain('btn--recommended');
      expect(screen.queryByText(/could not be established/i)).toBeNull();
      if (status === 'interrupted') {
        expect(screen.getByText(/started in the provider and never finished/i)).toBeTruthy();
      }
      view.unmount();
    }
  });

  it('reports a corrupt binding as corrupt and refuses to offer a rebind', async () => {
    bridge.set('planReview:get', () =>
      ok<'planReview:get'>({
        ruleEvidence: null,
        ruleEvidenceProblem: 'The stored rule-evidence binding does not match its snapshot.',
        gate: null,
        gateIdentity: 'no_gate',
        findings: []
      })
    );
    render(
      <PlanReviewPanel task={task('READY_FOR_IMPLEMENTATION')} integrationEnabled onChanged={async () => undefined} />
    );

    expect(await screen.findByText(/bound rule evidence cannot be read/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Capture and bind rules/i })).toBeNull();
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
          reconciledAt: null,
          revision: 0,
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
