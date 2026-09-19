/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { CodeReviewDetail, IpcResult } from '../../src/shared/ipc';
import type { CodeReviewFinding, CodeReviewSubject, CodeReviewTriage } from '../../src/shared/domain/code-review';
import { CodeReviewPanel } from '../../src/renderer/src/components/RunView';
import { burstClick, deferred, deliver, fail, installBridge, ok, type Bridge } from './harness';

const SUBJECT_SHA = 'a'.repeat(64);
const OTHER_SUBJECT_SHA = 'b'.repeat(64);

const task = (): Task => ({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Add a health route',
  originalRequest: 'Add a health route.',
  status: 'READY_FOR_REVIEW',
  currentRound: 1,
  maxRounds: 3,
  codexThreadId: null,
  claudeSessionId: null,
  implementationProvider: 'claude',
  reviewProvider: 'codex',
  providerRevision: 0,
  implementationThreadId: null,
  worktreePath: 'C:\\worktree',
  branchName: 'agent/task-1',
  baseBranch: 'main',
  specificationJson: null,
  specificationApprovedAt: null,
  lastReviewJson: null,
  lastError: null,
  codexModel: null,
  claudeModel: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z'
});

function subject(overrides: Partial<CodeReviewSubject> = {}): CodeReviewSubject {
  return {
    id: 'subject-1',
    taskId: 'task-1',
    baseCommit: '1'.repeat(40),
    headCommit: '2'.repeat(40),
    branch: 'agent/task-1',
    snapshotJson: '{}',
    subjectSha256: SUBJECT_SHA,
    fileCount: 2,
    totalBytes: 100,
    truncated: false,
    complete: true,
    hasUncommittedState: false,
    capturedAt: '2026-09-06T00:00:00.000Z',
    createdAt: '2026-09-06T00:00:00.000Z',
    ...overrides
  };
}

function finding(overrides: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
  return {
    id: 'finding-1',
    taskId: 'task-1',
    subjectSha256: SUBJECT_SHA,
    fingerprint: 'f'.repeat(64),
    severity: 'major',
    category: 'reliability',
    gating: true,
    title: 'The retry is ambiguous',
    body: 'A lost response may repeat work.',
    fix: 'Persist the intent before calling out.',
    file: 'src/service.ts',
    line: 42,
    provider: 'codex',
    role: 'SecurityReliability',
    firstRoundId: 'round-1',
    lastRoundId: 'round-1',
    timesReported: 1,
    revision: 0,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    ...overrides
  };
}

function triageRecord(
  findingsSnapshot: readonly (readonly [string, number])[],
  recommendations: readonly {
    findingId: string;
    recommendation: 'accept' | 'reject' | 'needs_user';
    reason: string;
    evidenceRef: string;
    confidence: 'high' | 'medium' | 'low' | 'uncertain';
  }[],
  overrides: Partial<CodeReviewTriage> = {}
): CodeReviewTriage {
  return {
    id: 'triage-1',
    taskId: 'task-1',
    subjectId: 'subject-1',
    subjectSha256: SUBJECT_SHA,
    findingsSnapshotJson: JSON.stringify(findingsSnapshot.map(([id, revision]) => [id, revision])),
    triageJson: JSON.stringify({ recommendations }),
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    ...overrides
  };
}

function detail(overrides: Partial<CodeReviewDetail> = {}): CodeReviewDetail {
  return {
    subject: null,
    subjectIdentity: 'no_subject',
    rounds: [],
    findings: [],
    historicalFindings: [],
    latestDecisions: {},
    totalFindingsEverRecorded: 0,
    identityProblem: null,
    triage: null,
    ...overrides
  };
}

let bridge: Bridge;

beforeEach(() => {
  bridge = installBridge({ 'codeReview:get': () => ok<'codeReview:get'>(detail()) });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

describe('the external code-review panel — automatic finding triage', () => {
  it('dispatches "Analyze undecided findings" exactly once per burst of clicks, sending only durable identifiers', async () => {
    const f1 = finding({ id: 'f-1' });
    const f2 = finding({ id: 'f-2', title: 'Second finding' });
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] })
    ));
    bridge.set('codeReview:triage', () => ok<'codeReview:triage'>({
      recommendations: [],
      detail: detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] })
    }));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const button = await screen.findByRole('button', { name: /Analyze undecided findings/i });
    await burstClick(button, 3);

    await waitFor(() => expect(bridge.callsTo('codeReview:triage')).toHaveLength(1));
    expect(bridge.callsTo('codeReview:triage')[0]?.input).toEqual({
      taskId: 'task-1',
      findingIds: ['f-1', 'f-2']
    });
  });

  it('shows one recommendation per undecided finding with its reason, evidence and confidence, and never decides anything on its own', async () => {
    const f1 = finding({ id: 'f-1' });
    const f2 = finding({ id: 'f-2', title: 'Second finding' });
    const triage = triageRecord(
      [['f-1', 0], ['f-2', 0]],
      [
        { findingId: 'f-1', recommendation: 'accept', reason: 'Matches criterion 1.', evidenceRef: 'src/service.ts:42', confidence: 'high' },
        { findingId: 'f-2', recommendation: 'needs_user', reason: 'Genuine uncertainty.', evidenceRef: 'src/service.ts:50', confidence: 'low' }
      ]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2], triage })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    expect(await screen.findByText(/Recommended: accept/)).toBeTruthy();
    expect(screen.getByText(/Matches criterion 1\./)).toBeTruthy();
    expect(screen.getByText(/Evidence: src\/service\.ts:42/)).toBeTruthy();
    expect(screen.getByText(/Needs a human decision/)).toBeTruthy();

    // `needs_user` gets no apply affordance — it must remain undecided.
    expect(screen.getAllByRole('button', { name: /^Apply recommendation$/ })).toHaveLength(1);
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('applies one recommendation by submitting exactly that decision, using the recommendation\'s own reason', async () => {
    const f1 = finding({ id: 'f-1', revision: 3 });
    const triage = triageRecord(
      [['f-1', 3]],
      [{ findingId: 'f-1', recommendation: 'reject', reason: 'False premise.', evidenceRef: 'src/service.ts:42', confidence: 'medium' }]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1], triage })
    ));
    bridge.set('codeReview:decide', () => ok<'codeReview:decide'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1] })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const apply = await screen.findByRole('button', { name: /^Apply recommendation$/ });
    await burstClick(apply, 3);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    expect(bridge.callsTo('codeReview:decide')[0]?.input).toEqual({
      taskId: 'task-1',
      findingId: 'f-1',
      expectedRevision: 3,
      action: 'reject',
      reason: 'False premise.'
    });
  });

  it('applies all applicable recommendations, one decision per accept/reject finding, and skips needs_user', async () => {
    const f1 = finding({ id: 'f-1', revision: 0 });
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second' });
    const f3 = finding({ id: 'f-3', revision: 0, title: 'Third' });
    const triage = triageRecord(
      [['f-1', 0], ['f-2', 0], ['f-3', 0]],
      [
        { findingId: 'f-1', recommendation: 'accept', reason: 'r1', evidenceRef: 'e', confidence: 'high' },
        { findingId: 'f-2', recommendation: 'reject', reason: 'r2', evidenceRef: 'e', confidence: 'high' },
        { findingId: 'f-3', recommendation: 'needs_user', reason: 'r3', evidenceRef: 'e', confidence: 'low' }
      ]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2, f3], triage })
    ));
    bridge.set('codeReview:decide', () => ok<'codeReview:decide'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2, f3] })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const applyAll = await screen.findByRole('button', { name: /Apply all recommendations to undecided findings/i });
    await burstClick(applyAll, 3);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(2));
    const inputs = bridge.callsTo('codeReview:decide').map((call) => call.input);
    expect(inputs).toContainEqual({ taskId: 'task-1', findingId: 'f-1', expectedRevision: 0, action: 'accept', reason: 'r1' });
    expect(inputs).toContainEqual({ taskId: 'task-1', findingId: 'f-2', expectedRevision: 0, action: 'reject', reason: 'r2' });
  });

  it('continues applying the rest of an apply-all batch after one item fails, and reports the failure', async () => {
    const f1 = finding({ id: 'f-1', revision: 0 });
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second' });
    const triage = triageRecord(
      [['f-1', 0], ['f-2', 0]],
      [
        { findingId: 'f-1', recommendation: 'accept', reason: 'r1', evidenceRef: 'e', confidence: 'high' },
        { findingId: 'f-2', recommendation: 'reject', reason: 'r2', evidenceRef: 'e', confidence: 'high' }
      ]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2], triage })
    ));
    // f-1 was decided by someone else moments ago; f-2 is still fully valid.
    bridge.set('codeReview:decide', (input) => {
      const { findingId } = input as { findingId: string };
      return findingId === 'f-1'
        ? fail('This finding was decided by someone else while you were looking at it, so nothing was written.')
        : ok<'codeReview:decide'>(detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] }));
    });
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const applyAll = await screen.findByRole('button', { name: /Apply all recommendations to undecided findings/i });
    await burstClick(applyAll, 1);

    // Both items were attempted — the failure on f-1 did not stop f-2 from
    // being submitted.
    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(2));
    const inputs = bridge.callsTo('codeReview:decide').map((call) => call.input);
    expect(inputs).toContainEqual({ taskId: 'task-1', findingId: 'f-1', expectedRevision: 0, action: 'accept', reason: 'r1' });
    expect(inputs).toContainEqual({ taskId: 'task-1', findingId: 'f-2', expectedRevision: 0, action: 'reject', reason: 'r2' });

    expect(await screen.findByText(/1 of 2 recommendations could not be applied/i)).toBeTruthy();
    // The aggregate error is thrown AFTER the loop, inside act()'s try —
    // its catch does not return early, so the unconditional codeReview:get
    // re-read below it still runs: one on mount, one after this batch.
    expect(bridge.callsTo('codeReview:get').length).toBeGreaterThanOrEqual(2);
  });

  it('never shows a stored recommendation once the reviewed subject has changed', async () => {
    const f1 = finding({ id: 'f-1' });
    const staleTriage = triageRecord(
      [['f-1', 0]],
      [{ findingId: 'f-1', recommendation: 'accept', reason: 'Stale recommendation.', evidenceRef: 'e', confidence: 'high' }],
      { subjectSha256: OTHER_SUBJECT_SHA }
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1], triage: staleTriage })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    await screen.findByText(/The retry is ambiguous/);
    expect(screen.queryByText(/Recommended: accept/)).toBeNull();
    expect(screen.queryByText(/Stale recommendation\./)).toBeNull();
  });

  it('never shows a stored recommendation once one of its analyzed findings has since been decided', async () => {
    // Live revision (1) has moved past what the stored analysis covered (0) —
    // exactly what recording a decision on this finding does.
    const f1 = finding({ id: 'f-1', revision: 1 });
    const triage = triageRecord(
      [['f-1', 0]],
      [{ findingId: 'f-1', recommendation: 'accept', reason: 'Stale recommendation.', evidenceRef: 'e', confidence: 'high' }]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1], triage })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    await screen.findByText(/The retry is ambiguous/);
    expect(screen.queryByText(/Recommended: accept/)).toBeNull();
    expect(screen.queryByText(/Stale recommendation\./)).toBeNull();
  });

  it('keeps a sibling finding\'s recommendation visible after another finding from the same analysis is decided', async () => {
    // f-1 was decided (its live revision moved from the analyzed 0 to 1);
    // f-2 is untouched and still at the revision it was analyzed at.
    const f1 = finding({ id: 'f-1', revision: 1 });
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second finding' });
    const triage = triageRecord(
      [['f-1', 0], ['f-2', 0]],
      [
        { findingId: 'f-1', recommendation: 'accept', reason: 'r1', evidenceRef: 'e', confidence: 'high' },
        { findingId: 'f-2', recommendation: 'reject', reason: 'r2', evidenceRef: 'e', confidence: 'high' }
      ]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({
        subject: subject(),
        subjectIdentity: 'current',
        findings: [f1, f2],
        latestDecisions: {
          'f-1': {
            id: 'd-1',
            findingId: 'f-1',
            subjectSha256: SUBJECT_SHA,
            action: 'accept',
            reason: 'Decided already.',
            actor: 'operator',
            source: 'test',
            findingRevision: 0,
            decidedAt: '2026-09-06T00:00:00.000Z',
            createdAt: '2026-09-06T00:00:00.000Z'
          }
        },
        triage
      })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    // f-1 shows its decision, not a stale recommendation for itself.
    await screen.findByText(/Decided: accept/);
    expect(screen.queryByText(/^r1$/)).toBeNull();
    // f-2's recommendation, from the SAME analysis, is unaffected by what
    // happened to its sibling and remains applicable.
    expect(screen.getByText(/Recommended: reject/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Apply recommendation$/ })).toBeTruthy();
  });

  it('end to end: after finding A is decided elsewhere, B still applies through the UI, and exactly one decision is submitted for B alone', async () => {
    const f1 = finding({ id: 'f-1', revision: 1 }); // A: already decided elsewhere
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second finding' }); // B: untouched
    const triage = triageRecord(
      [['f-1', 0], ['f-2', 0]],
      [
        { findingId: 'f-1', recommendation: 'accept', reason: 'r1', evidenceRef: 'e', confidence: 'high' },
        { findingId: 'f-2', recommendation: 'reject', reason: 'r2', evidenceRef: 'e', confidence: 'high' }
      ]
    );
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({
        subject: subject(),
        subjectIdentity: 'current',
        findings: [f1, f2],
        latestDecisions: {
          'f-1': {
            id: 'd-1', findingId: 'f-1', subjectSha256: SUBJECT_SHA, action: 'accept',
            reason: 'Decided already.', actor: 'operator', source: 'test', findingRevision: 0,
            decidedAt: '2026-09-06T00:00:00.000Z', createdAt: '2026-09-06T00:00:00.000Z'
          }
        },
        triage
      })
    ));
    bridge.set('codeReview:decide', () => ok<'codeReview:decide'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    // B's apply affordance is present and B alone gets submitted.
    const apply = await screen.findByRole('button', { name: /^Apply recommendation$/ });
    fireEvent.click(apply);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    expect(bridge.callsTo('codeReview:decide')[0]?.input).toEqual({
      taskId: 'task-1',
      findingId: 'f-2',
      expectedRevision: 0,
      action: 'reject',
      reason: 'r2'
    });
  });

  it('preserves an in-progress manual draft for an untouched finding after a sibling finding is decided', async () => {
    const f1 = finding({ id: 'f-1', revision: 0, title: 'First finding' });
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second finding' });
    // Stateful: `act()`'s post-mutation reread is a SEPARATE codeReview:get
    // call, not the codeReview:decide response — the mock must reflect the
    // decision on its NEXT read, or this test cannot tell the fix from a
    // mock that never actually re-rendered anything.
    let f1Decided = false;
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({
        subject: subject(),
        subjectIdentity: 'current',
        findings: [finding({ id: 'f-1', revision: f1Decided ? 1 : 0, title: 'First finding' }), f2],
        latestDecisions: f1Decided ? {
          'f-1': {
            id: 'd-1', findingId: 'f-1', subjectSha256: SUBJECT_SHA, action: 'accept',
            reason: 'Handled.', actor: 'operator', source: 'test', findingRevision: 0,
            decidedAt: '2026-09-06T00:00:00.000Z', createdAt: '2026-09-06T00:00:00.000Z'
          }
        } : {}
      })
    ));
    bridge.set('codeReview:decide', () => {
      f1Decided = true;
      return ok<'codeReview:decide'>(detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] }));
    });
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    await screen.findByText('Second finding');
    const decisionSelects = screen.getAllByLabelText('Decision');
    // Not `getAllByLabelText('Reason')`: the Reason field's label also wraps
    // a hint span ("Required for every decision"), so its accessible name is
    // "ReasonRequired for every decision", not "Reason" alone.
    const reasonInputs = screen.getAllByRole('textbox');
    expect(decisionSelects).toHaveLength(2);

    // A draft in progress for f-2 — never submitted.
    fireEvent.change(decisionSelects[1]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs[1]!, { target: { value: 'Draft reason for the second finding.' } });

    // f-1 is decided through the UI.
    fireEvent.change(decisionSelects[0]!, { target: { value: 'accept' } });
    fireEvent.change(reasonInputs[0]!, { target: { value: 'Handled.' } });
    const submitButtons = screen.getAllByRole('button', { name: /^Submit decision$/ });
    fireEvent.click(submitButtons[0]!);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    // f-1 now shows its decision instead of controls; f-2's draft, entered
    // before f-1 was decided, must still be there — not wiped by the
    // unconditional reread that followed deciding an unrelated sibling.
    await screen.findByText(/Decided: accept/);
    const remainingReasonInputs = screen.getAllByRole('textbox');
    expect(remainingReasonInputs).toHaveLength(1);
    expect((remainingReasonInputs[0] as HTMLInputElement).value).toBe('Draft reason for the second finding.');
  });

  it('preserves an in-progress manual draft when a new finding appears for the same subject', async () => {
    const f1 = finding({ id: 'f-1', revision: 0, title: 'First finding' });
    const f2 = finding({ id: 'f-2', revision: 0, title: 'Second finding' });
    // The refetch after "Analyze" now reports a brand-new third finding for
    // the SAME subject — the set of live finding ids grows, which must not
    // be confused with a genuinely different subject.
    let newFindingAppeared = false;
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({
        subject: subject(),
        subjectIdentity: 'current',
        findings: newFindingAppeared
          ? [f1, f2, finding({ id: 'f-3', revision: 0, title: 'Third finding' })]
          : [f1, f2]
      })
    ));
    bridge.set('codeReview:triage', () => {
      newFindingAppeared = true;
      return ok<'codeReview:triage'>({
        recommendations: [],
        detail: detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2] })
      });
    });
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    await screen.findByText('Second finding');
    const reasonInputs = screen.getAllByRole('textbox');
    fireEvent.change(reasonInputs[1]!, { target: { value: 'Draft reason kept across a new finding.' } });

    const analyze = await screen.findByRole('button', { name: /Analyze undecided findings/i });
    fireEvent.click(analyze);

    await screen.findByText('Third finding');
    const reasonInputsAfter = screen.getAllByRole('textbox');
    expect(reasonInputsAfter).toHaveLength(3);
    expect((reasonInputsAfter[1] as HTMLInputElement).value).toBe('Draft reason kept across a new finding.');
  });

  it('resets the busy guard and shows an error when Analyze itself fails, leaving no control stuck disabled', async () => {
    const f1 = finding({ id: 'f-1' });
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({ subject: subject(), subjectIdentity: 'current', findings: [f1] })
    ));
    bridge.set('codeReview:triage', () => fail('Codex did not respond in time.', 'TIMEOUT'));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const button = await screen.findByRole('button', { name: /Analyze undecided findings/i });
    fireEvent.click(button);

    expect(await screen.findByText(/Codex did not respond in time\./)).toBeTruthy();
    // The single-flight guard was released — the button is enabled again,
    // not left stuck disabled by a failure that never called release().
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows an explanatory status, not just the button disappearing, once every live finding has a decision', async () => {
    const f1 = finding({ id: 'f-1' });
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(
      detail({
        subject: subject(),
        subjectIdentity: 'current',
        findings: [f1],
        latestDecisions: {
          'f-1': {
            id: 'd-1', findingId: 'f-1', subjectSha256: SUBJECT_SHA, action: 'accept',
            reason: 'Handled.', actor: 'operator', source: 'test', findingRevision: 0,
            decidedAt: '2026-09-06T00:00:00.000Z', createdAt: '2026-09-06T00:00:00.000Z'
          }
        }
      })
    ));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    expect(await screen.findByText('All live findings have decisions recorded.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Analyze undecided findings/i })).toBeNull();
    // The decided finding itself is still shown, not replaced by the notice.
    expect(screen.getByText(/Decided: accept/)).toBeTruthy();
  });

  it('offers no Analyze button, and shows no code-review panel content, when there is nothing captured and the integration is off', async () => {
    render(<CodeReviewPanel task={task()} integrationEnabled={false} />);
    await waitFor(() => expect(bridge.callsTo('codeReview:get')).toHaveLength(1));
    expect(screen.queryByText('External code review')).toBeNull();
  });
});

describe('the external code-review panel — progress and failure of an analysis, beside its action', () => {
  const f1 = finding({ id: 'f-1' });
  const f2 = finding({ id: 'f-2', title: 'Second finding' });
  const live = (overrides: Partial<CodeReviewDetail> = {}): CodeReviewDetail =>
    detail({ subject: subject(), subjectIdentity: 'current', findings: [f1, f2], ...overrides });
  const decisionRecord = (findingId: string): CodeReviewDetail['latestDecisions'][string] => ({
    id: `d-${findingId}`, findingId, subjectSha256: SUBJECT_SHA, action: 'accept',
    reason: 'Decided by hand.', actor: 'operator', source: 'test', findingRevision: 0,
    decidedAt: '2026-09-06T00:00:00.000Z', createdAt: '2026-09-06T00:00:00.000Z'
  });
  const analyzeButton = (): HTMLElement => screen.getByRole('button', { name: /Analyze undecided findings/i });
  /** The row of buttons that holds the trigger; the feedback must sit directly under it. */
  const controls = (): Element => analyzeButton().closest('.row')!;

  it('says, right under the action, that Codex is analyzing, and keeps the action disabled meanwhile', async () => {
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(live()));
    const answer = deferred<IpcResult<{ recommendations: never[]; detail: CodeReviewDetail }>>();
    bridge.set('codeReview:triage', () => answer.promise);
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    expect(screen.queryByRole('status')).toBeNull();
    await screen.findByRole('button', { name: /Analyze undecided findings/i });
    fireEvent.click(analyzeButton());

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Analyzing findings with Codex…');
    expect(status.textContent).toMatch(/nothing changes until you apply a recommendation/i);
    expect(controls().nextElementSibling).toBe(status);
    expect(analyzeButton()).toHaveProperty('disabled', true);
    expect(screen.queryByRole('alert')).toBeNull();

    await deliver(answer, ok<'codeReview:triage'>({ recommendations: [], detail: live() }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(analyzeButton()).toHaveProperty('disabled', false);
  });

  it('shows a failed analysis beside the action, says no decision changed, and keeps the operator’s drafts', async () => {
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(live()));
    bridge.set('codeReview:triage', () =>
      fail('Codex returned recommendations that do not match the expected shape.', 'PARSE_FAILED')
    );
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    const decisions = await screen.findAllByLabelText('Decision');
    fireEvent.change(decisions[0]!, { target: { value: 'reject' } });
    fireEvent.change(screen.getAllByLabelText(/^Reason/)[0]!, { target: { value: 'Already covered.' } });
    fireEvent.click(analyzeButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Analysis failed');
    expect(alert.textContent).toMatch(/No decisions were changed or applied/);
    expect(alert.textContent).toContain('do not match the expected shape');
    // Directly under the trigger — and reported once, not also at the top of the panel.
    expect(controls().nextElementSibling).toBe(alert);
    expect(screen.getAllByText(/do not match the expected shape/)).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();

    expect(analyzeButton()).toHaveProperty('disabled', false);
    expect((decisions[0] as HTMLSelectElement).value).toBe('reject');
    expect((screen.getAllByLabelText(/^Reason/)[0] as HTMLInputElement).value).toBe('Already covered.');
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('recovers from a timeout-coded failure and from a call that throws, each time re-enabling a retry', async () => {
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(live()));
    bridge.set('codeReview:triage', () => fail('The Codex process timeout expired.', 'TIMEOUT'));
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    await screen.findByRole('button', { name: /Analyze undecided findings/i });
    fireEvent.click(analyzeButton());
    expect((await screen.findByRole('alert')).textContent).toContain('The Codex process timeout expired.');
    expect(analyzeButton()).toHaveProperty('disabled', false);

    bridge.set('codeReview:triage', () => {
      throw new Error('The bridge went away.');
    });
    fireEvent.click(analyzeButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The bridge went away.'));
    expect(screen.getByRole('alert').textContent).not.toContain('timeout expired');
    expect(screen.queryByRole('status')).toBeNull();
    expect(analyzeButton()).toHaveProperty('disabled', false);
  });

  it('keeps a failure on screen while the operator decides findings by hand, and replaces it on the next analysis', async () => {
    let current = live();
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(current));
    bridge.set('codeReview:triage', () => fail('Codex failed.', 'TOOL_FAILED'));
    bridge.set('codeReview:decide', () => {
      current = live({ latestDecisions: { 'f-1': decisionRecord('f-1') } });
      return ok<'codeReview:decide'>(current);
    });
    render(<CodeReviewPanel task={task()} integrationEnabled />);
    await screen.findByRole('button', { name: /Analyze undecided findings/i });
    fireEvent.click(analyzeButton());
    await screen.findByRole('alert');

    // "Decide each finding yourself" is the guidance shown; following it must not erase it.
    fireEvent.change(screen.getAllByLabelText('Decision')[0]!, { target: { value: 'accept' } });
    fireEvent.change(screen.getAllByLabelText(/^Reason/)[0]!, { target: { value: 'Decided by hand.' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Submit decision/i })[0]!);
    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    await screen.findByText(/Decided: accept/);
    expect(screen.getByRole('alert').textContent).toContain('Codex failed.');

    // A new analysis replaces it: pending first, then the result.
    const answer = deferred<IpcResult<{ recommendations: never[]; detail: CodeReviewDetail }>>();
    bridge.set('codeReview:triage', () => answer.promise);
    fireEvent.click(analyzeButton());
    await screen.findByRole('status');
    expect(screen.queryByRole('alert')).toBeNull();
    await deliver(answer, ok<'codeReview:triage'>({ recommendations: [], detail: current }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the summary and the apply controls on success without deciding anything, needs_user included', async () => {
    let current = live();
    bridge.set('codeReview:get', () => ok<'codeReview:get'>(current));
    bridge.set('codeReview:triage', () => {
      current = live({
        triage: triageRecord(
          [['f-1', 0], ['f-2', 0]],
          [
            { findingId: 'f-1', recommendation: 'accept', reason: 'Matches criterion 1.', evidenceRef: 'src/service.ts:42', confidence: 'high' },
            { findingId: 'f-2', recommendation: 'needs_user', reason: 'Genuine uncertainty.', evidenceRef: 'src/service.ts:50', confidence: 'low' }
          ]
        )
      });
      return ok<'codeReview:triage'>({ recommendations: [], detail: current });
    });
    render(<CodeReviewPanel task={task()} integrationEnabled />);

    // A draft typed by hand for the needs-a-human finding survives the analysis.
    const decisions = await screen.findAllByLabelText('Decision');
    fireEvent.change(decisions[1]!, { target: { value: 'reject' } });
    fireEvent.change(screen.getAllByLabelText(/^Reason/)[1]!, { target: { value: 'My own reason.' } });
    fireEvent.click(analyzeButton());

    expect(await screen.findByText(/1 recommended accept/)).toBeTruthy();
    expect(screen.getByText(/1 need a human/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Apply all recommendations to undecided findings/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Apply recommendation$/ })).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    expect((decisions[1] as HTMLSelectElement).value).toBe('reject');
    expect((screen.getAllByLabelText(/^Reason/)[1] as HTMLInputElement).value).toBe('My own reason.');
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });
});
