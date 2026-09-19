/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { PlanAdvanceOutcome } from '../../src/shared/domain/plan-correction';
import type { PlanReviewAutoDecision } from '../../src/shared/domain/plan-review';
import type { IpcResult, PlanReviewDetail } from '../../src/shared/ipc';
import { PlanReviewPanel } from '../../src/renderer/src/components/RunView';
import { burstClick, deferred, deliver, fail, installBridge, ok, type Bridge } from './harness';

const ROUND_SHA = 'b'.repeat(64);
const FINDINGS_JSON = 'stored-findings-json';
const NOW = '2026-09-06T00:00:00.000Z';

const task = (): Task => ({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Add a health route',
  originalRequest: 'Add a health route.',
  status: 'READY_FOR_IMPLEMENTATION',
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
  createdAt: NOW,
  updatedAt: NOW
});

const NO_CORRECTION: PlanReviewDetail['correction'] = {
  used: 0,
  max: 3,
  nextStep: 'decide',
  loop: null,
  latest: null,
  acceptedPending: 0,
  versions: []
};

const TITLES = ['Finding A', 'Finding B', 'Finding C'] as const;

/** A round awaiting decisions on `count` findings. */
function awaiting(count: number, overrides: Partial<PlanReviewDetail> = {}): PlanReviewDetail {
  return {
    ruleEvidenceProblem: null,
    ruleEvidence: {
      snapshotSha256: 'a'.repeat(64),
      boundAt: NOW,
      sources: [{ id: 'project', kind: 'project', revision: 'c'.repeat(40), clean: true }],
      files: [],
      omitted: [],
      totalBytes: 0
    },
    gateIdentity: 'current',
    gate: {
      id: 'gate-1',
      taskId: 'task-1',
      specificationSha256: 'd'.repeat(64),
      ruleEvidenceSha256: 'a'.repeat(64),
      sessionId: 'session-1',
      serverName: 'coai',
      serverVersion: '1.0.0',
      contractFingerprint: 'f'.repeat(64),
      contractMismatchAt: null,
      status: 'awaiting_resolve',
      verdict: 'revise',
      findingsJson: FINDINGS_JSON,
      decisionsJson: null,
      reviewers: 'codex:architecture',
      gatingCount: count,
      threshold: 1,
      lastError: null,
      reconciledAt: null,
      revision: 0,
      triageJson: null,
      triageForFindings: null,
      autoDecisionsJson: null,
      createdAt: NOW,
      updatedAt: NOW
    },
    findingsSha256: ROUND_SHA,
    findings: TITLES.slice(0, count).map((title, index) => ({
      severity: 'major' as const,
      category: 'reliability' as const,
      file: 'src/service.ts',
      line: 40 + index,
      title,
      why: `Why ${title} matters.`,
      fix: `Fix ${title}.`,
      providers: ['codex'],
      role: 'SecurityReliability'
    })),
    autoDecisions: [],
    analyzing: [],
    correction: NO_CORRECTION,
    ...overrides
  };
}

/**
 * A stateful stand-in for the main process's round: each answer changes it the
 * way the real service does (the revision bumps, decisions accumulate, a
 * needs_user answer is stored as a recommendation and no decision).
 */
function round(initial: PlanReviewDetail) {
  let current = initial;
  const bump = (patch: Partial<NonNullable<PlanReviewDetail['gate']>> = {}) => ({
    ...(current.gate as NonNullable<PlanReviewDetail['gate']>),
    revision: (current.gate as NonNullable<PlanReviewDetail['gate']>).revision + 1,
    ...patch
  });
  return {
    get: (): PlanReviewDetail => current,
    /** What the main process reports as being analyzed right now. */
    setAnalyzing(indexes: readonly number[]): void {
      current = { ...current, analyzing: indexes };
    },
    decided(finding: number, action: 'accept' | 'reject', reason = `Because ${finding}.`) {
      const decision: PlanReviewAutoDecision = {
        finding,
        action,
        reason: `Auto-decided by Codex triage (high confidence): ${reason} Evidence: evidence ${finding}`,
        evidenceRef: `evidence ${finding}`,
        confidence: 'high',
        decidedAt: NOW
      };
      current = {
        ...current,
        gate: bump(),
        autoDecisions: [...current.autoDecisions.filter((entry) => entry.finding !== finding), decision].sort(
          (a, b) => a.finding - b.finding
        )
      };
      return ok<'planReview:autoDecide'>({ detail: current, outcome: { kind: 'decided', decision } });
    },
    needsUser(finding: number, reason = 'A product choice.') {
      const existing = current.gate?.triageForFindings === FINDINGS_JSON
        ? (JSON.parse(current.gate.triageJson as string) as { recommendations: unknown[] }).recommendations
        : [];
      current = {
        ...current,
        gate: bump({
          triageForFindings: FINDINGS_JSON,
          triageJson: JSON.stringify({
            recommendations: [
              ...existing,
              { finding, recommendation: 'needs_user', reason, evidenceRef: `evidence ${finding}`, confidence: 'low' }
            ]
          })
        })
      };
      return ok<'planReview:autoDecide'>({
        detail: current,
        outcome: { kind: 'needs_user', reason, evidenceRef: `evidence ${finding}`, confidence: 'low' }
      });
    }
  };
}

let bridge: Bridge;
let server: ReturnType<typeof round>;

beforeEach(() => {
  bridge = installBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

const renderPanel = (
  extra: { renderPrimary?: boolean; onGuidanceStateChanged?: (state: string) => void } = {}
) =>
  render(
    <PlanReviewPanel
      task={task()}
      integrationEnabled
      onChanged={async () => undefined}
      onGuidanceStateChanged={extra.onGuidanceStateChanged as never}
      renderPrimary={extra.renderPrimary}
    />
  );

/** Serve `initial` and answer Auto decide with `answer(index)`. */
function serve(
  initial: PlanReviewDetail,
  answer: (index: number, s: typeof server) => IpcResult<unknown> | Promise<IpcResult<unknown>>
): void {
  server = round(initial);
  bridge.set('planReview:get', () => ok<'planReview:get'>(server.get()));
  bridge.set('planReview:autoDecide', (input) =>
    answer((input as { findingIndex: number }).findingIndex, server)
  );
}

const autoButton = (title: string): HTMLElement => screen.getByRole('button', { name: `Auto decide: ${title}` });
const decisionSelects = (): HTMLSelectElement[] => screen.getAllByLabelText('Decision') as HTMLSelectElement[];
const reasonInputs = (): HTMLInputElement[] => screen.getAllByLabelText(/^Reason/) as HTMLInputElement[];
const autoCalls = () => bridge.callsTo('planReview:autoDecide').map((call) => call.input as { findingIndex: number });

describe('plan review: Auto decide beside every Decision', () => {
  it('puts an Auto decide button in each finding’s Decision row, next to its Decision and Reason', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, 'accept'));
    renderPanel();

    await screen.findByText('Finding A');
    const selects = decisionSelects();
    for (const [index, title] of (['Finding A', 'Finding B'] as const).entries()) {
      const row = autoButton(title).closest('.decision-row') as HTMLElement;
      expect(row).not.toBeNull();
      // The same row holds that finding's own Decision and Reason, not another's.
      expect(within(row).getByLabelText('Decision')).toBe(selects[index]);
      expect(within(row).getByLabelText(/^Reason/)).toBe(reasonInputs()[index]);
      expect(autoButton(title).textContent).toContain('Auto decide');
    }
  });

  it('analyzes exactly the finding whose button was clicked, and nothing else', async () => {
    serve(awaiting(3), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding B');

    fireEvent.click(autoButton('Finding B'));

    await waitFor(() => expect(autoCalls()).toHaveLength(1));
    expect(bridge.callsTo('planReview:autoDecide')[0]?.input).toEqual({
      taskId: 'task-1',
      gateId: 'gate-1',
      findingsSha256: ROUND_SHA,
      findingIndex: 1
    });
  });

  it('puts an accept into Decision and Reason at once, with no second Apply click', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, 'accept', 'Matches criterion 1.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    await waitFor(() => expect(decisionSelects()[0]!.value).toBe('accept'));
    expect(reasonInputs()[0]!.value).toContain('Matches criterion 1.');
    expect(await screen.findByText('Auto-decided: Accept')).toBeTruthy();
    // The other finding is untouched.
    expect(decisionSelects()[1]!.value).toBe('');
    // Nothing was resolved: only the operator does that.
    expect(bridge.callsTo('planReview:resolve')).toHaveLength(0);
    expect(bridge.callsTo('planReview:resolveAndRevise')).toHaveLength(0);
  });

  it('puts a reject into Decision with its reason, which is what makes a reject valid', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, 'reject', 'The premise is contradicted by src/x.ts.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding B'));

    await waitFor(() => expect(decisionSelects()[1]!.value).toBe('reject'));
    expect(reasonInputs()[1]!.value).toContain('contradicted by src/x.ts');
    expect(await screen.findByText('Auto-decided: Reject')).toBeTruthy();
  });

  it('leaves Decision unset for needs_user and says, beside the field, why automation stopped', async () => {
    serve(awaiting(2), (index, s) => s.needsUser(index, 'This is an architecture choice.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    expect(await screen.findByText(/Needs your decision — automation stopped on purpose/)).toBeTruthy();
    expect(screen.getByText('This is an architecture choice.')).toBeTruthy();
    expect(decisionSelects()[0]!.value).toBe('');
    expect(reasonInputs()[0]!.value).toBe('');
  });

  it('shows Analyzing… inside the finding, disables only that finding’s button, and leaves the rest usable', async () => {
    const answer = deferred<IpcResult<unknown>>();
    serve(awaiting(2), (index, s) => (index === 0 ? answer.promise : s.decided(index, 'accept')));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const first = screen.getByRole('button', { name: 'Auto decide: Finding A' });
    await waitFor(() => expect(first.textContent).toContain('Analyzing…'));
    expect(first).toHaveProperty('disabled', true);
    expect(first.getAttribute('aria-busy')).toBe('true');
    // The status is in that finding's own card.
    const card = first.closest('.finding') as HTMLElement;
    expect(within(card).getByRole('status').textContent).toContain('Analyzing…');
    // Only what conflicts is disabled: the other finding can still be worked on.
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);
    expect(decisionSelects()[0]).toHaveProperty('disabled', false);

    await deliver(answer, server.decided(0, 'accept'));
    await waitFor(() => expect(decisionSelects()[0]!.value).toBe('accept'));
  });

  it('keeps a failure inside its own finding with the real error and a Retry that works', async () => {
    let attempts = 0;
    serve(awaiting(2), (index, s) => {
      if (index === 0 && (attempts += 1) === 1) return fail('Codex timed out.', 'TIMEOUT', 'Try again.');
      return s.decided(index, 'accept');
    });
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed — Retry. Nothing was decided.');
    expect(alert.textContent).toContain('Codex timed out. Try again.');
    expect((alert.closest('.finding') as HTMLElement).textContent).toContain('Finding A');
    expect(decisionSelects()[0]!.value).toBe('');
    // The other finding is unaffected.
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);

    const retry = screen.getByRole('button', { name: 'Retry auto decide: Finding A' });
    expect(retry.textContent).toBe('Retry');
    fireEvent.click(retry);
    await waitFor(() => expect(decisionSelects()[0]!.value).toBe('accept'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts one analysis for a burst of clicks on the same button', async () => {
    const answer = deferred<IpcResult<unknown>>();
    serve(awaiting(2), () => answer.promise);
    renderPanel();
    await screen.findByText('Finding A');

    await burstClick(autoButton('Finding A'), 4);

    expect(autoCalls()).toHaveLength(1);
    await deliver(answer, server.decided(0, 'accept'));
  });

  it('keeps what Auto decide saved across a refresh or restart', async () => {
    const saved = awaiting(2, {
      autoDecisions: [
        {
          finding: 0,
          action: 'accept',
          reason: 'Auto-decided by Codex triage (high confidence): Sound. Evidence: src/a.ts',
          evidenceRef: 'src/a.ts',
          confidence: 'high',
          decidedAt: NOW
        }
      ]
    });
    serve(saved, () => fail('unused'));

    const first = renderPanel();
    await screen.findByText('Auto-decided: Accept');
    expect(decisionSelects()[0]!.value).toBe('accept');
    expect(reasonInputs()[0]!.value).toContain('Sound.');
    first.unmount();

    // A fresh mount reads the same durable state.
    renderPanel();
    await screen.findByText('Auto-decided: Accept');
    expect(decisionSelects()[0]!.value).toBe('accept');
  });

  it('lets a choice made by hand override a saved automatic one, and says so', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Auto-decided: Accept');

    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'I checked and it is wrong.' } });

    expect(await screen.findByText(/You chose Reject instead/)).toBeTruthy();
    expect(decisionSelects()[0]!.value).toBe('reject');
  });

  it('after a reload, still shows an analysis the main process is running, offers no second click, and picks up its result', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(awaiting(2, { analyzing: [0] }), (index, s) => s.decided(index, 'accept'));
    renderPanel();

    // This screen has no memory of the request, but the process says it is running.
    const first = await screen.findByRole('button', { name: 'Auto decide: Finding A' });
    expect(first.textContent).toContain('Analyzing…');
    expect(first).toHaveProperty('disabled', true);
    expect(within(first.closest('.finding') as HTMLElement).getByRole('status').textContent).toContain('Analyzing…');
    fireEvent.click(first);
    expect(autoCalls()).toHaveLength(0);
    // Other findings are unaffected, and "all undecided" leaves the running one alone.
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));
    await waitFor(() => expect(autoCalls().map((call) => call.findingIndex)).toEqual([1]));

    // The request finishes in the main process; the next read shows its saved decision.
    server.decided(0, 'accept');
    server.setAnalyzing([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(decisionSelects()[0]!.value).toBe('accept'));
    expect(autoButton('Finding A').textContent).not.toContain('Analyzing');
    expect(autoCalls().map((call) => call.findingIndex)).toEqual([1]);
  });

  it('will not analyze a finding the operator has already chosen or typed for, so a draft can never be discarded', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.change(reasonInputs()[0]!, { target: { value: 'My own reasoning.' } });

    const blocked = autoButton('Finding A');
    expect(blocked).toHaveProperty('disabled', true);
    expect(blocked.getAttribute('title')).toMatch(/already chosen a decision/i);
    fireEvent.click(blocked);
    expect(autoCalls()).toHaveLength(0);
    expect(reasonInputs()[0]!.value).toBe('My own reasoning.');
    // Another finding is unaffected.
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);

    // Emptying the draft again hands the finding back to Auto decide.
    fireEvent.change(reasonInputs()[0]!, { target: { value: '' } });
    expect(autoButton('Finding A')).toHaveProperty('disabled', false);
    fireEvent.click(autoButton('Finding A'));
    await waitFor(() => expect(decisionSelects()[0]!.value).toBe('accept'));
  });

  it('never replaces a decision the operator edits while Codex is still analyzing', async () => {
    const answer = deferred<IpcResult<unknown>>();
    serve(awaiting(2), () => answer.promise);
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await waitFor(() => expect(autoButton('Finding A').textContent).toContain('Analyzing…'));

    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'My own reason.' } });
    await deliver(answer, server.decided(0, 'accept'));

    await screen.findByText('Auto-decided: Accept');
    expect(decisionSelects()[0]!.value).toBe('reject');
    expect(reasonInputs()[0]!.value).toBe('My own reason.');
  });
});

describe('plan review: Auto decide all undecided', () => {
  it('is the primary bulk action, and the old two-step Analyze → Apply workflow is gone', async () => {
    serve(awaiting(3), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');

    const bulk = screen.getByRole('button', { name: /Auto decide all undecided/ });
    expect(bulk.className).toContain('btn--primary');
    // The blind action is secondary and dangerous, never the recommended path.
    const blind = screen.getByRole('button', { name: /Accept all without analysis/ });
    expect(blind.className).toContain('btn--danger');
    expect(blind.className).not.toContain('btn--primary');
    expect(screen.queryByRole('button', { name: /Analyze undecided findings/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply recommendation/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply all recommendations/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Clear unsaved decisions/ })).toBeTruthy();
  });

  it('analyzes every finding on its own, applies every accept and reject, and never a needs_user', async () => {
    serve(awaiting(3), (index, s) => {
      if (index === 0) return s.decided(0, 'accept');
      if (index === 1) return s.decided(1, 'reject');
      return s.needsUser(2, 'Undecidable without the product owner.');
    });
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));

    await waitFor(() => expect(screen.getByText(/Auto decide finished/)).toBeTruthy());
    // One call per finding, each naming only that finding.
    expect(autoCalls().map((call) => call.findingIndex).sort()).toEqual([0, 1, 2]);
    expect(decisionSelects().map((select) => select.value)).toEqual(['accept', 'reject', '']);
    const summary = screen.getByText(/3 analyzed/).closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/3 analyzed · 1 accepted · 1 rejected · 1 need you · 0 failed/);
    expect(screen.getByText('Undecidable without the product owner.')).toBeTruthy();
    expect(bridge.callsTo('planReview:resolveAndRevise')).toHaveLength(0);
  });

  it('never touches a decision the operator already made or is drafting', async () => {
    serve(awaiting(3), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Refuted by hand.' } });

    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));

    await waitFor(() => expect(screen.getByText(/Auto decide finished/)).toBeTruthy());
    expect(autoCalls().map((call) => call.findingIndex).sort()).toEqual([1, 2]);
    expect(decisionSelects().map((select) => select.value)).toEqual(['reject', 'accept', 'accept']);
    expect(reasonInputs()[0]!.value).toBe('Refuted by hand.');
  });

  it('isolates a failure: the others keep their results and only the failed one is retried', async () => {
    let failing = true;
    serve(awaiting(3), (index, s) =>
      index === 1 && failing ? fail('Codex crashed on this one.', 'TOOL_FAILED') : s.decided(index, 'accept')
    );
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));

    await screen.findByText(/Auto decide finished with failures/);
    expect(decisionSelects().map((select) => select.value)).toEqual(['accept', '', 'accept']);
    const summary = screen.getByText(/analyzed/).closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/2 analyzed · 2 accepted · 0 rejected · 0 need you · 1 failed/);
    expect(summary.textContent).toMatch(/2 finding\(s\) kept their results/);
    const alert = screen.getByRole('alert');
    expect((alert.closest('.finding') as HTMLElement).textContent).toContain('Finding B');
    expect(alert.textContent).toContain('Codex crashed on this one.');

    failing = false;
    const before = autoCalls().length;
    fireEvent.click(screen.getByRole('button', { name: /Retry 1 failed/ }));

    await waitFor(() => expect(decisionSelects()[1]!.value).toBe('accept'));
    // Only the failed finding was asked again.
    expect(autoCalls().slice(before).map((call) => call.findingIndex)).toEqual([1]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows live counts while it runs, near the button', async () => {
    const holds = [deferred<IpcResult<unknown>>(), deferred<IpcResult<unknown>>(), deferred<IpcResult<unknown>>()];
    serve(awaiting(3), (index) => holds[index]!.promise);
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));

    const running = await screen.findByText(/Auto decide running/);
    const summary = running.closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/3 left/);
    // Two are analyzed at once; the third waits.
    await waitFor(() => expect(autoCalls()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Auto decide: Finding C' }).textContent).toContain('Waiting…');

    await deliver(holds[0]!, server.decided(0, 'accept'));
    await deliver(holds[1]!, server.decided(1, 'reject'));
    await waitFor(() => expect(autoCalls()).toHaveLength(3));
    await deliver(holds[2]!, server.decided(2, 'accept'));
    await screen.findByText(/Auto decide finished/);
  });

  it('fails safe when the round was replaced: nothing is applied and the reason is shown on the finding', async () => {
    serve(awaiting(2), () =>
      fail('These findings belong to a plan-review round that is no longer the current one.', 'VALIDATION_FAILED', 'Reload the plan review.')
    );
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no longer the current one');
    expect(alert.textContent).toContain('Reload the plan review.');
    expect(decisionSelects().map((select) => select.value)).toEqual(['', '']);
    // The panel reads the round back once the queue drains.
    await waitFor(() => expect(bridge.callsTo('planReview:get').length).toBeGreaterThanOrEqual(2));
  });

  it('leaves out a finding Codex already stopped on, and offers nothing when nothing is left', async () => {
    const stopped = awaiting(2);
    serve(stopped, (index, s) => s.decided(index, 'accept'));
    server.needsUser(0);
    renderPanel();
    await screen.findByText(/Needs your decision — automation stopped on purpose/);

    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));
    await waitFor(() => expect(screen.getByText(/Auto decide finished/)).toBeTruthy());

    expect(autoCalls().map((call) => call.findingIndex)).toEqual([1]);
    expect(decisionSelects().map((select) => select.value)).toEqual(['', 'accept']);
    // Everything is now either decided or waiting for the operator.
    expect(screen.getByRole('button', { name: /Auto decide all undecided/ })).toHaveProperty('disabled', true);
  });

  it('warns before accepting everything without analysis, and never over saved or drafted decisions', async () => {
    serve(awaiting(3), (index, s) => s.decided(index, 'reject', 'Refuted.'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Auto-decided: Reject');
    fireEvent.change(decisionSelects()[1]!, { target: { value: 'reject' } });

    fireEvent.click(screen.getByRole('button', { name: /Accept all without analysis/ }));
    expect(screen.getByText(/without looking at any of them/i)).toBeTruthy();
    expect(decisionSelects()[2]!.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /Yes, accept all without analysis/ }));

    expect(decisionSelects().map((select) => select.value)).toEqual(['reject', 'reject', 'accept']);
  });

  it('explains the choices in words, where they are made', async () => {
    serve(awaiting(1), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');

    const glossary = screen.getByText('What the choices mean').closest('.notice') as HTMLElement;
    expect(glossary.textContent).toMatch(/Accept and address.*the finding is valid and must be incorporated/);
    expect(glossary.textContent).toMatch(/does not by itself change the plan/);
    expect(glossary.textContent).toMatch(/Reject with reason.*not valid.*contrary evidence/);
    expect(glossary.textContent).toMatch(/Needs your decision.*stopped on purpose/);
  });
});

describe('plan review: resolve and revise', () => {
  const settled = (round: PlanReviewDetail): PlanReviewDetail => ({
    ...round,
    gate: round.gate ? { ...round.gate, status: 'changes_requested', decisionsJson: '[]', revision: 9 } : null,
    correction: { ...NO_CORRECTION, used: 1, nextStep: 'run_review' }
  });
  const outcome = (over: Partial<PlanAdvanceOutcome> = {}): PlanAdvanceOutcome => ({
    stopped: 'awaiting_decisions',
    message: 'Round 2 of the plan review is waiting for decisions.',
    correctionsRun: 1,
    roundsReviewed: 1,
    ...over
  });

  it('offers “Resolve and revise plan” — not a plain resolve — once a finding is accepted', async () => {
    const states: string[] = [];
    serve(awaiting(2), (index, s) => s.decided(index, 'accept'));
    renderPanel({ onGuidanceStateChanged: (state) => states.push(state) });
    await screen.findByText('Finding A');
    expect(screen.getByRole('button', { name: /Resolve external plan review/ })).toHaveProperty('disabled', true);

    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Refuted.' } });
    fireEvent.change(decisionSelects()[1]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[1]!, { target: { value: 'Also refuted.' } });
    // Nothing accepted: an ordinary resolve.
    expect(screen.getByRole('button', { name: /Resolve external plan review/ })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('button', { name: /Resolve and revise plan/ })).toBeNull();

    fireEvent.change(decisionSelects()[1]!, { target: { value: 'accept' } });
    expect(screen.getByRole('button', { name: /Resolve and revise plan/ })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('button', { name: /^Resolve external plan review$/ })).toBeNull();
    expect(screen.getByText(/1 accepted finding\(s\) will be folded into the specification/)).toBeTruthy();
    expect(states).toContain('resolve');
    expect(states.at(-1)).toBe('resolve_and_revise');
  });

  it('sends the decisions to the loop, keeps going automatically by default, and reports why it stopped', async () => {
    serve(awaiting(2), (index, s) => s.decided(index, index === 0 ? 'accept' : 'reject', 'Because.'));
    bridge.set('planReview:resolveAndRevise', () =>
      ok<'planReview:resolveAndRevise'>({ detail: settled(server.get()), outcome: outcome({ stopped: 'clean', message: 'The current specification passed its external plan review with nothing left to correct.' }) })
    );
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(screen.getByRole('button', { name: /Auto decide all undecided/ }));
    await screen.findByText(/Auto decide finished/);

    fireEvent.click(screen.getByRole('button', { name: /Resolve and revise plan/ }));

    await waitFor(() => expect(bridge.callsTo('planReview:resolveAndRevise')).toHaveLength(1));
    const sent = bridge.callsTo('planReview:resolveAndRevise')[0]!.input as {
      gateId: string;
      expectedRevision: number;
      autoContinue: boolean;
      decisions: { finding: number; action: string; reason: string }[];
    };
    expect(sent.gateId).toBe('gate-1');
    expect(sent.autoContinue).toBe(true);
    expect(sent.decisions.map((entry) => [entry.finding, entry.action])).toEqual([[0, 'accept'], [1, 'reject']]);
    expect(sent.decisions[1]!.reason.length).toBeGreaterThan(0);
    // The plain resolve, which would leave the plan unrevised, is never used for an accepted round.
    expect(bridge.callsTo('planReview:resolve')).toHaveLength(0);

    const result = await screen.findByText(/passed its external plan review with nothing left to correct/);
    expect((result.closest('.notice') as HTMLElement).textContent).toMatch(/1 correction\(s\) run · 1 review round\(s\)/);
  });

  it('can be told not to keep going by itself', async () => {
    serve(awaiting(1), (index, s) => s.decided(index, 'accept'));
    bridge.set('planReview:resolveAndRevise', () =>
      ok<'planReview:resolveAndRevise'>({ detail: settled(server.get()), outcome: outcome() })
    );
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Auto-decided: Accept');
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep going automatically/ }));

    fireEvent.click(screen.getByRole('button', { name: /Resolve and revise plan/ }));

    await waitFor(() => expect(bridge.callsTo('planReview:resolveAndRevise')).toHaveLength(1));
    expect((bridge.callsTo('planReview:resolveAndRevise')[0]!.input as { autoContinue: boolean }).autoContinue).toBe(false);
  });

  it('shows what the loop is doing while it runs, read back from the main process', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(awaiting(1), (index, s) => s.decided(index, 'accept'));
    const running = deferred<IpcResult<unknown>>();
    bridge.set('planReview:resolveAndRevise', () => running.promise);
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Auto-decided: Accept');

    fireEvent.click(screen.getByRole('button', { name: /Resolve and revise plan/ }));
    expect(await screen.findByText(/Working through the correction loop/)).toBeTruthy();

    // The loop is now revising: the next read of the round says so.
    const revising = {
      ...server.get(),
      correction: { ...NO_CORRECTION, used: 0, loop: { phase: 'revising' as const, round: 1 } }
    };
    bridge.set('planReview:get', () => ok<'planReview:get'>(revising));
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(await screen.findByText(/Codex is revising the specification \(correction round 1 of 3\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resolve and revise plan/ })).toHaveProperty('disabled', true);

    await deliver(running, ok<'planReview:resolveAndRevise'>({ detail: settled(server.get()), outcome: outcome() }));
    await screen.findByText(/Round 2 of the plan review is waiting for decisions/);
  });

  it('shows the real error when the loop fails, where the button is, and offers to continue', async () => {
    serve(awaiting(1), (index, s) => s.decided(index, 'accept'));
    bridge.set('planReview:resolveAndRevise', () => fail('Codex timed out while revising.', 'TIMEOUT', 'Nothing was changed.'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Auto-decided: Accept');
    // After the failure the round is read back, and now says a correction is owed.
    const failed = awaiting(1, {
      gate: { ...awaiting(1).gate!, status: 'changes_requested', decisionsJson: '[]', revision: 5 },
      correction: {
        ...NO_CORRECTION,
        used: 1,
        nextStep: 'revise',
        acceptedPending: 1,
        latest: { round: 1, status: 'failed', attempts: 1, lastError: 'Codex timed out while revising.', acceptedCount: 1, addressed: [] }
      }
    });

    fireEvent.click(screen.getByRole('button', { name: /Resolve and revise plan/ }));
    bridge.set('planReview:get', () => ok<'planReview:get'>(failed));

    const alert = await screen.findByText(/The correction loop stopped\. Nothing further was changed\./);
    expect((alert.closest('[role="alert"]') as HTMLElement).textContent).toContain('Codex timed out while revising. Nothing was changed.');
    const continueButton = await screen.findByRole('button', { name: /Continue correction/ });
    bridge.set('planReview:continueCorrection', () =>
      ok<'planReview:continueCorrection'>({ detail: settled(server.get()), outcome: outcome({ stopped: 'clean', message: 'Done.' }) })
    );
    fireEvent.click(continueButton);
    await waitFor(() => expect(bridge.callsTo('planReview:continueCorrection')).toHaveLength(1));
    expect(bridge.callsTo('planReview:continueCorrection')[0]!.input).toEqual({ taskId: 'task-1', autoContinue: true });
  });

  it('shows, per accepted finding, which field Codex changed for it in the last revision', async () => {
    serve(
      awaiting(1, {
        correction: {
          ...NO_CORRECTION,
          used: 1,
          latest: {
            round: 1,
            status: 'completed',
            attempts: 1,
            lastError: null,
            acceptedCount: 1,
            addressed: [
              { finding: 0, title: 'Add a retry budget', field: 'implementationPrompt', change: 'Now tells the implementer to cap retries.' }
            ]
          }
        }
      }),
      () => fail('unused')
    );
    renderPanel();

    const block = await screen.findByLabelText('What the last revision changed');
    expect(block.textContent).toContain('round 1');
    expect(block.textContent).toContain('Add a retry budget');
    expect(block.textContent).toContain('implementationPrompt');
    expect(block.textContent).toContain('Now tells the implementer to cap retries.');
  });

  it('shows the correction budget and the specification versions', async () => {
    serve(
      awaiting(1, {
        correction: {
          ...NO_CORRECTION,
          used: 2,
          max: 3,
          versions: [
            { version: 1, specificationSha256: '1'.repeat(64), origin: 'generated', createdAt: NOW },
            { version: 2, specificationSha256: '2'.repeat(64), origin: 'plan_correction', createdAt: NOW },
            { version: 3, specificationSha256: '3'.repeat(64), origin: 'plan_correction', createdAt: NOW }
          ]
        }
      }),
      () => fail('unused')
    );
    renderPanel();

    const block = (await screen.findByLabelText('Plan correction')) as HTMLElement;
    expect(block.textContent).toContain('2 of 3 used');
    expect(block.textContent).toContain('v1 (generated) → v2 (revised) → v3 (revised)');
  });

  it('says plainly when the correction budget is spent, and never offers approval', async () => {
    const states: string[] = [];
    serve(
      awaiting(1, {
        gate: { ...awaiting(1).gate!, status: 'changes_requested', decisionsJson: '[]', revision: 4 },
        correction: { ...NO_CORRECTION, used: 3, max: 3, nextStep: 'round_limit', acceptedPending: 2 }
      }),
      () => fail('unused')
    );
    renderPanel({ onGuidanceStateChanged: (state) => states.push(state) });

    const notice = await screen.findByText(/The correction budget \(3 round\(s\)\) is spent/);
    expect(notice.textContent).toMatch(/2\s+accepted finding\(s\) are still not in the specification/);
    await waitFor(() => expect(states.at(-1)).toBe('correction_limit'));
    expect(screen.queryByRole('button', { name: /Continue correction/ })).toBeNull();
  });

  it('reports "continue correction" as the next action while accepted findings await their revision', async () => {
    const states: string[] = [];
    serve(
      awaiting(1, {
        gate: { ...awaiting(1).gate!, status: 'changes_requested', decisionsJson: '[]', revision: 4 },
        correction: { ...NO_CORRECTION, used: 0, nextStep: 'revise', acceptedPending: 1 }
      }),
      () => fail('unused')
    );
    renderPanel({ renderPrimary: false, onGuidanceStateChanged: (state) => states.push(state) });

    await waitFor(() => expect(states.at(-1)).toBe('continue_correction'));
    // The app's own primary control carries the action, so the panel adds no second button.
    expect(screen.queryByRole('button', { name: /Continue correction/ })).toBeNull();
  });
});

describe('plan review: the request is always about one named round', () => {
  it('never lets the renderer supply a decision, recommendation or prompt for Auto decide', async () => {
    serve(awaiting(1), (index, s) => s.decided(index, 'accept'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await waitFor(() => expect(autoCalls()).toHaveLength(1));

    expect(Object.keys(bridge.callsTo('planReview:autoDecide')[0]!.input as object).sort()).toEqual([
      'findingIndex',
      'findingsSha256',
      'gateId',
      'taskId'
    ]);
  });
});
