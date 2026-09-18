/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { CodeReviewDetail } from '../../src/shared/ipc';
import type { CodeReviewFinding, CodeReviewSubject, CodeReviewTriage } from '../../src/shared/domain/code-review';
import { CodeReviewPanel } from '../../src/renderer/src/components/RunView';
import { burstClick, fail, installBridge, ok, type Bridge } from './harness';

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

  it('offers no Analyze button, and shows no code-review panel content, when there is nothing captured and the integration is off', async () => {
    render(<CodeReviewPanel task={task()} integrationEnabled={false} />);
    await waitFor(() => expect(bridge.callsTo('codeReview:get')).toHaveLength(1));
    expect(screen.queryByText('External code review')).toBeNull();
  });
});
