/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../../src/shared/domain/models';
import type { CodeReviewDetail, IpcResult } from '../../src/shared/ipc';
import type {
  CodeAutoDecideOutcome,
  CodeCorrectionRequirement,
  CodeRequirementStatus,
  CodeReviewDecision,
  CodeReviewFinding,
  CodeReviewSubject,
  CodeReviewTriage
} from '../../src/shared/domain/code-review';
import { CodeReviewPanel } from '../../src/renderer/src/components/RunView';
import { burstClick, deferred, deliver, fail, installBridge, ok, type Bridge } from './harness';

const SUBJECT_SHA = 'a'.repeat(64);
const NOW = '2026-09-06T00:00:00.000Z';

const task = (overrides: Partial<Task> = {}): Task => ({
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
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides
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
    capturedAt: NOW,
    createdAt: NOW,
    ...overrides
  };
}

function finding(overrides: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
  return {
    id: 'f-1',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function decisionRecord(
  target: CodeReviewFinding,
  action: CodeReviewDecision['action'],
  overrides: Partial<CodeReviewDecision> = {}
): CodeReviewDecision {
  return {
    id: `d-${target.id}`,
    findingId: target.id,
    subjectSha256: target.subjectSha256,
    action,
    reason: 'Decided.',
    actor: 'operator',
    source: 'test',
    findingRevision: target.revision,
    decidedAt: NOW,
    createdAt: NOW,
    ...overrides
  };
}

function triageRecord(
  snapshot: readonly (readonly [string, number])[],
  recommendations: readonly {
    findingId: string;
    recommendation: 'accept' | 'reject' | 'needs_user';
    reason: string;
    evidenceRef: string;
    confidence: 'high' | 'medium' | 'low' | 'uncertain';
  }[]
): CodeReviewTriage {
  return {
    id: 'triage-1',
    taskId: 'task-1',
    subjectId: 'subject-1',
    subjectSha256: SUBJECT_SHA,
    findingsSnapshotJson: JSON.stringify(snapshot.map(([id, revision]) => [id, revision])),
    triageJson: JSON.stringify({ recommendations }),
    createdAt: NOW,
    updatedAt: NOW
  };
}

/**
 * A stateful stand-in for the main process. Deciding bumps the finding's
 * revision exactly as the durable lifecycle does, and a needs_user answer is
 * kept as a stored recommendation with NO decision.
 */
class Server {
  findings: CodeReviewFinding[];
  decisions: Record<string, CodeReviewDecision> = {};
  recommendations: Parameters<typeof triageRecord>[1][number][] = [];
  statusOverrides: Record<string, CodeRequirementStatus> = {};
  subject: CodeReviewSubject = subject();

  constructor(count: number, titles: readonly string[] = ['Finding A', 'Finding B', 'Finding C']) {
    this.findings = Array.from({ length: count }, (_, index) =>
      finding({ id: `f-${index + 1}`, title: titles[index] ?? `Finding ${index + 1}`, line: 40 + index })
    );
  }

  detail(): CodeReviewDetail {
    const requirements: CodeCorrectionRequirement[] = this.findings.flatMap((entry) => {
      const decision = this.decisions[entry.id];
      if (decision?.action !== 'accept') return [];
      return [{ finding: entry, decision, status: this.statusOverrides[entry.id] ?? 'open' }];
    });
    const snapshot = this.findings.map((entry) => [entry.id, entry.revision] as const);
    return {
      subject: this.subject,
      subjectIdentity: 'current',
      rounds: [],
      findings: this.findings,
      historicalFindings: [],
      latestDecisions: this.decisions,
      totalFindingsEverRecorded: this.findings.length,
      identityProblem: null,
      triage: this.recommendations.length > 0 ? triageRecord(snapshot, this.recommendations) : null,
      correctionRequirements: requirements
    };
  }

  /** The finding as decided by Codex: its revision moves on and a system decision is stored. */
  autoDecided(id: string, action: 'accept' | 'reject', reason = 'Codex checked the code.') {
    const target = this.findings.find((entry) => entry.id === id)!;
    this.decisions = {
      ...this.decisions,
      [id]: decisionRecord(target, action, { reason, actor: 'system', source: 'auto_decide' })
    };
    this.findings = this.findings.map((entry) => (entry.id === id ? { ...entry, revision: entry.revision + 1 } : entry));
    const outcome: CodeAutoDecideOutcome = { kind: 'decided', action, reason, confidence: 'high' };
    return ok<'codeReview:autoDecide'>({ detail: this.detail(), outcome });
  }

  needsUser(id: string, reason = 'A product choice.') {
    const target = this.findings.find((entry) => entry.id === id)!;
    this.recommendations = [
      ...this.recommendations,
      { findingId: id, recommendation: 'needs_user', reason, evidenceRef: `${target.file}:${target.line}`, confidence: 'low' }
    ];
    const outcome: CodeAutoDecideOutcome = {
      kind: 'needs_user',
      reason,
      evidenceRef: `${target.file}:${target.line}`,
      confidence: 'low'
    };
    return ok<'codeReview:autoDecide'>({ detail: this.detail(), outcome });
  }

  /** Someone else decided it first: the durable decision stays and Codex's answer is dropped. */
  alreadyDecided(id: string, action: 'accept' | 'reject') {
    const target = this.findings.find((entry) => entry.id === id)!;
    this.decisions = { ...this.decisions, [id]: decisionRecord(target, action, { reason: 'Decided by hand first.' }) };
    this.findings = this.findings.map((entry) => (entry.id === id ? { ...entry, revision: entry.revision + 1 } : entry));
    const outcome: CodeAutoDecideOutcome = { kind: 'already_decided', action };
    return ok<'codeReview:autoDecide'>({ detail: this.detail(), outcome });
  }
}

let bridge: Bridge;
let server: Server;

beforeEach(() => {
  bridge = installBridge({ 'codeReview:get': () => ok<'codeReview:get'>(server.detail()) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

/** Serve `count` findings; `answer` replies to each Auto decide call by finding id. */
function serve(
  count: number,
  answer: (id: string, s: Server) => IpcResult<unknown> | Promise<IpcResult<unknown>> = (id, s) => s.autoDecided(id, 'accept')
): Server {
  server = new Server(count);
  bridge.set('codeReview:get', () => ok<'codeReview:get'>(server.detail()));
  bridge.set('codeReview:autoDecide', (input) => answer((input as { findingId: string }).findingId, server));
  return server;
}

const autoButton = (title: string): HTMLElement => screen.getByRole('button', { name: `Auto decide: ${title}` });
const bulkButton = (): HTMLElement => screen.getByRole('button', { name: /Auto decide all undecided/ });
const decisionSelects = (): HTMLSelectElement[] => screen.getAllByLabelText('Decision') as HTMLSelectElement[];
const reasonInputs = (): HTMLInputElement[] => screen.getAllByLabelText(/^Reason/) as HTMLInputElement[];
const autoCalls = () => bridge.callsTo('codeReview:autoDecide').map((call) => call.input as { taskId: string; findingId: string });
const renderPanel = (
  extra: { task?: Task; latestClaudeResult?: string | null; onCorrectionsSent?: (task: Task) => void } = {}
) =>
  render(
    <CodeReviewPanel
      task={extra.task ?? task()}
      integrationEnabled
      latestClaudeResult={extra.latestClaudeResult ?? null}
      onCorrectionsSent={extra.onCorrectionsSent}
    />
  );

describe('code review: Auto decide beside every Decision', () => {
  it('puts an Auto decide button in each finding’s Decision row, next to its own Decision and Reason', async () => {
    serve(2);
    renderPanel();

    await screen.findByText('Finding A');
    for (const [index, title] of (['Finding A', 'Finding B'] as const).entries()) {
      const row = autoButton(title).closest('.decision-row') as HTMLElement;
      expect(row).not.toBeNull();
      expect(within(row).getByLabelText('Decision')).toBe(decisionSelects()[index]);
      expect(within(row).getByLabelText(/^Reason/)).toBe(reasonInputs()[index]);
    }
  });

  it('asks about exactly the finding whose button was clicked, naming only durable identifiers', async () => {
    serve(3);
    renderPanel();
    await screen.findByText('Finding B');

    fireEvent.click(autoButton('Finding B'));

    await waitFor(() => expect(autoCalls()).toHaveLength(1));
    expect(bridge.callsTo('codeReview:autoDecide')[0]?.input).toEqual({ taskId: 'task-1', findingId: 'f-2' });
  });

  it('records an accept at once: the finding shows its durable decision and the renderer submits nothing itself', async () => {
    serve(2, (id, s) => s.autoDecided(id, 'accept', 'Matches criterion 1.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const decided = await screen.findByText(/Decided: accept/);
    const card = decided.closest('.finding') as HTMLElement;
    expect(card.textContent).toContain('Finding A');
    expect(card.textContent).toContain('auto-decided');
    expect(card.textContent).toContain('Matches criterion 1.');
    // The Decision controls of the decided finding are gone; the other finding is untouched.
    expect(within(card).queryByLabelText('Decision')).toBeNull();
    expect(decisionSelects()).toHaveLength(1);
    // No second "apply" step, no renderer-side decide: the backend wrote it.
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('records a reject at once, with its reason', async () => {
    serve(2, (id, s) => s.autoDecided(id, 'reject', 'The premise is contradicted by src/x.ts.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding B'));

    const decided = await screen.findByText(/Decided: reject/);
    expect((decided.closest('.finding') as HTMLElement).textContent).toContain('contradicted by src/x.ts');
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('leaves a needs_user finding undecided and says, inside that finding, why automation stopped', async () => {
    serve(2, (id, s) => s.needsUser(id, 'This is an architecture choice.'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const stop = await screen.findByText(/Needs your decision — automation stopped on purpose/);
    const card = stop.closest('.finding') as HTMLElement;
    expect(card.textContent).toContain('Finding A');
    expect(card.textContent).toContain('This is an architecture choice.');
    // Still undecided: the operator's own controls remain, and nothing was recorded.
    expect(within(card).getByLabelText('Decision')).toHaveProperty('value', '');
    expect(within(card).getByRole('button', { name: /Submit decision/ })).toBeTruthy();
    expect(screen.queryByText(/Decided:/)).toBeNull();
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('shows Analyzing… in the finding, and disables only what conflicts with it', async () => {
    const answer = deferred<IpcResult<unknown>>();
    serve(2, (id, s) => (id === 'f-1' ? answer.promise : s.autoDecided(id, 'accept')));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const first = autoButton('Finding A');
    await waitFor(() => expect(first.textContent).toContain('Analyzing…'));
    expect(first).toHaveProperty('disabled', true);
    expect(first.getAttribute('aria-busy')).toBe('true');
    expect(within(first.closest('.finding') as HTMLElement).getByRole('status').textContent).toContain('Analyzing…');
    // Another finding can still be worked on; actions that read the tree cannot.
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);
    expect(decisionSelects()[0]).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: /Capture subject again/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Run external code review/ })).toHaveProperty('disabled', true);

    await deliver(answer, server.autoDecided('f-1', 'accept'));
    await screen.findByText(/Decided: accept/);
    expect(screen.getByRole('button', { name: /Capture subject again/ })).toHaveProperty('disabled', false);
  });

  it('keeps a failure inside its own finding with the real error and a Retry that works', async () => {
    let attempts = 0;
    serve(2, (id, s) => {
      if (id === 'f-1' && (attempts += 1) === 1) return fail('Codex timed out.', 'TIMEOUT', 'Try again.');
      return s.autoDecided(id, 'accept');
    });
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed — Retry. Nothing was decided.');
    expect(alert.textContent).toContain('Codex timed out. Try again.');
    expect((alert.closest('.finding') as HTMLElement).textContent).toContain('Finding A');
    expect(screen.queryByText(/Decided:/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry auto decide: Finding A' }));

    await screen.findByText(/Decided: accept/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(autoCalls().map((call) => call.findingId)).toEqual(['f-1', 'f-1']);
  });

  it('will not analyze a finding the operator has already chosen or typed for, so a draft can never be buried', async () => {
    serve(2);
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });

    const blocked = autoButton('Finding A');
    expect(blocked).toHaveProperty('disabled', true);
    expect(blocked.getAttribute('title')).toMatch(/already chosen a decision/i);
    fireEvent.click(blocked);
    expect(autoCalls()).toHaveLength(0);
    expect(decisionSelects()[0]!.value).toBe('reject');
    expect(autoButton('Finding B')).toHaveProperty('disabled', false);

    fireEvent.change(decisionSelects()[0]!, { target: { value: '' } });
    expect(autoButton('Finding A')).toHaveProperty('disabled', false);
  });

  it('starts one analysis for a burst of clicks on the same button', async () => {
    const answer = deferred<IpcResult<unknown>>();
    serve(2, () => answer.promise);
    renderPanel();
    await screen.findByText('Finding A');

    await burstClick(autoButton('Finding A'), 4);

    expect(autoCalls()).toHaveLength(1);
    await deliver(answer, server.autoDecided('f-1', 'accept'));
  });

  it('never contradicts a decision someone else recorded first: the durable one is shown, not Codex’s', async () => {
    serve(2, (id, s) => s.alreadyDecided(id, 'reject'));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(autoButton('Finding A'));

    const decided = await screen.findByText(/Decided: reject/);
    expect((decided.closest('.finding') as HTMLElement).textContent).toContain('Decided by hand first.');
    expect(screen.queryByText(/Decided: accept/)).toBeNull();
  });

  it('keeps what Auto decide saved across a refresh or restart', async () => {
    serve(2, (id, s) => s.autoDecided(id, 'accept'));
    const first = renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText(/Decided: accept/);
    first.unmount();

    renderPanel();

    const decided = await screen.findByText(/Decided: accept/);
    expect(decided.closest('.finding')!.textContent).toContain('auto-decided');
    expect(autoCalls()).toHaveLength(1);
  });

  it('keeps a stop Codex made on purpose across a refresh, until the operator decides', async () => {
    serve(2, (id, s) => s.needsUser(id, 'Undecidable without the owner.'));
    const first = renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(autoButton('Finding A'));
    await screen.findByText('Undecidable without the owner.');
    first.unmount();

    renderPanel();

    expect(await screen.findByText('Undecidable without the owner.')).toBeTruthy();
    expect(autoCalls()).toHaveLength(1);
  });
});

describe('code review: Auto decide all undecided', () => {
  it('is the primary bulk action, and the old Analyze → Apply workflow is gone', async () => {
    serve(3);
    renderPanel();
    await screen.findByText('Finding A');

    expect(bulkButton().className).toContain('btn--primary');
    expect(bulkButton().textContent).toContain('(3)');
    expect(screen.queryByRole('button', { name: /Analyze undecided findings/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply recommendation/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply all recommendations/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Clear unsaved decisions/ })).toBeTruthy();
    // The glossary explains accept / reject / needs_user in words.
    expect(screen.getByText('What the choices mean').closest('.notice')!.textContent).toMatch(/Accepting it does not change any code/);
  });

  it('records every accept and reject, never a needs_user, and reports the counts beside the button', async () => {
    serve(3, (id, s) => {
      if (id === 'f-1') return s.autoDecided(id, 'accept');
      if (id === 'f-2') return s.autoDecided(id, 'reject');
      return s.needsUser(id, 'Undecidable without the product owner.');
    });
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(bulkButton());

    await waitFor(() => expect(screen.getByText(/Auto decide finished/)).toBeTruthy());
    expect(autoCalls().map((call) => call.findingId).sort()).toEqual(['f-1', 'f-2', 'f-3']);
    expect(Object.fromEntries(Object.entries(server.decisions).map(([id, entry]) => [id, entry.action]))).toEqual({
      'f-1': 'accept',
      'f-2': 'reject'
    });
    const summary = screen.getByText(/3 analyzed/).closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/3 analyzed · 1 accepted · 1 rejected · 1 need you · 0 failed/);
    expect(screen.getByText('Undecidable without the product owner.')).toBeTruthy();
    // Needs-user is left for the operator: it is not decided and not asked about again.
    expect(server.decisions['f-3']).toBeUndefined();
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('never touches a finding that has a decision, a draft, or a stop, and keeps the drafts', async () => {
    serve(4);
    server.autoDecided('f-1', 'reject', 'Already rejected.');
    server.needsUser('f-4');
    renderPanel();
    await screen.findByText('Finding B');
    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Refuted by hand.' } });

    fireEvent.click(bulkButton());

    await waitFor(() => expect(screen.getByText(/Auto decide finished/)).toBeTruthy());
    // Finding B is drafted, A is decided, D needs the operator: only C is analyzed.
    expect(autoCalls().map((call) => call.findingId)).toEqual(['f-3']);
    expect(server.decisions['f-1']!.action).toBe('reject');
    expect(server.decisions['f-1']!.reason).toBe('Already rejected.');
    expect(decisionSelects()[0]!.value).toBe('reject');
    expect(reasonInputs()[0]!.value).toBe('Refuted by hand.');
  });

  it('isolates a failure: the others keep their results and only the failed one is retried', async () => {
    let failing = true;
    serve(3, (id, s) =>
      id === 'f-2' && failing ? fail('Codex crashed on this one.', 'TOOL_FAILED') : s.autoDecided(id, 'accept')
    );
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(bulkButton());

    await screen.findByText(/Auto decide finished with failures/);
    expect(Object.keys(server.decisions).sort()).toEqual(['f-1', 'f-3']);
    const summary = screen.getByText(/analyzed/).closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/2 analyzed · 2 accepted · 0 rejected · 0 need you · 1 failed/);
    expect(summary.textContent).toMatch(/2 finding\(s\) kept their results/);
    const alert = screen.getByRole('alert');
    expect((alert.closest('.finding') as HTMLElement).textContent).toContain('Finding B');
    expect(alert.textContent).toContain('Codex crashed on this one.');

    failing = false;
    const before = autoCalls().length;
    fireEvent.click(screen.getByRole('button', { name: /Retry 1 failed/ }));

    await waitFor(() => expect(server.decisions['f-2']?.action).toBe('accept'));
    expect(autoCalls().slice(before).map((call) => call.findingId)).toEqual(['f-2']);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows live counts while it runs, two analyses at a time', async () => {
    const holds: Record<string, ReturnType<typeof deferred<IpcResult<unknown>>>> = {
      'f-1': deferred(),
      'f-2': deferred(),
      'f-3': deferred()
    };
    serve(3, (id) => holds[id]!.promise);
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(bulkButton());

    const running = await screen.findByText(/Auto decide running/);
    expect((running.closest('.autodecide-summary') as HTMLElement).textContent).toMatch(/3 left/);
    await waitFor(() => expect(autoCalls()).toHaveLength(2));
    expect(autoButton('Finding C').textContent).toContain('Waiting…');

    await deliver(holds['f-1']!, server.autoDecided('f-1', 'accept'));
    await deliver(holds['f-2']!, server.autoDecided('f-2', 'reject'));
    await waitFor(() => expect(autoCalls()).toHaveLength(3));
    await deliver(holds['f-3']!, server.autoDecided('f-3', 'accept'));
    await screen.findByText(/Auto decide finished/);
  });

  it('leaves alone a finding someone else decided while it was analyzing, and does not count it as its own', async () => {
    serve(2, (id, s) => (id === 'f-1' ? s.alreadyDecided(id, 'reject') : s.autoDecided(id, 'accept')));
    renderPanel();
    await screen.findByText('Finding A');

    fireEvent.click(bulkButton());

    await screen.findByText(/Auto decide finished/);
    expect(server.decisions['f-1']!.action).toBe('reject');
    expect(server.decisions['f-1']!.actor).toBe('operator');
    const summary = screen.getByText(/analyzed/).closest('.autodecide-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/1 accepted · 0 rejected/);
  });

  it('reads the truth back once the queue is idle, so answers that finished out of order cannot leave stale rows', async () => {
    serve(2);
    renderPanel();
    await screen.findByText('Finding A');
    const reads = bridge.callsTo('codeReview:get').length;

    fireEvent.click(bulkButton());

    await screen.findByText(/Auto decide finished/);
    await waitFor(() => expect(bridge.callsTo('codeReview:get').length).toBeGreaterThan(reads));
  });

  it('offers nothing to analyze once every finding has a decision, and says so', async () => {
    serve(1);
    server.autoDecided('f-1', 'accept');
    renderPanel();

    expect(await screen.findByText('All live findings have decisions recorded.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Auto decide all undecided/ })).toBeNull();
    expect(screen.getByText(/Decided: accept/)).toBeTruthy();
  });

  it('“Clear unsaved decisions” discards only what was typed, never what is recorded', async () => {
    serve(2);
    server.autoDecided('f-1', 'accept');
    renderPanel();
    await screen.findByText('Finding B');
    fireEvent.change(decisionSelects()[0]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Typed, not sent.' } });

    fireEvent.click(screen.getByRole('button', { name: /Clear unsaved decisions/ }));

    expect(decisionSelects()[0]!.value).toBe('');
    expect(reasonInputs()[0]!.value).toBe('');
    expect(screen.getByText(/Decided: accept/)).toBeTruthy();
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });
});

describe('code review: manual decisions keep working beside Auto decide', () => {
  it('preserves an in-progress draft for an untouched finding after a sibling is decided by hand', async () => {
    serve(2);
    renderPanel();
    await screen.findByText('Finding B');
    bridge.set('codeReview:decide', () => {
      server.autoDecided('f-1', 'accept', 'Handled.');
      return ok<'codeReview:decide'>(server.detail());
    });
    fireEvent.change(decisionSelects()[1]!, { target: { value: 'reject' } });
    fireEvent.change(reasonInputs()[1]!, { target: { value: 'Draft reason for the second finding.' } });
    fireEvent.change(decisionSelects()[0]!, { target: { value: 'accept' } });
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Handled.' } });

    fireEvent.click(screen.getAllByRole('button', { name: /^Submit decision$/ })[0]!);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    await screen.findByText(/Decided: accept/);
    expect(reasonInputs()).toHaveLength(1);
    expect(reasonInputs()[0]!.value).toBe('Draft reason for the second finding.');
  });

  it('preserves a draft when Auto decide changes a sibling and when a new finding appears for the same subject', async () => {
    serve(2);
    renderPanel();
    await screen.findByText('Finding B');
    fireEvent.change(reasonInputs()[1]!, { target: { value: 'Draft reason kept.' } });

    server.findings = [...server.findings, finding({ id: 'f-3', title: 'Third finding' })];
    fireEvent.click(autoButton('Finding A'));

    await screen.findByText(/Decided: accept/);
    await screen.findByText('Third finding');
    expect(reasonInputs()).toHaveLength(2);
    expect(reasonInputs()[0]!.value).toBe('Draft reason kept.');
  });

  it('a manual decision needs a reason before it can be submitted, and submits the finding’s own revision', async () => {
    serve(1);
    renderPanel();
    await screen.findByText('Finding A');
    const submit = screen.getByRole('button', { name: /^Submit decision$/ });
    expect(submit).toHaveProperty('disabled', true);
    bridge.set('codeReview:decide', () => ok<'codeReview:decide'>(server.detail()));

    fireEvent.change(decisionSelects()[0]!, { target: { value: 'accept' } });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(reasonInputs()[0]!, { target: { value: 'Yes, it is valid.' } });
    fireEvent.click(submit);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    expect(bridge.callsTo('codeReview:decide')[0]?.input).toEqual({
      taskId: 'task-1',
      findingId: 'f-1',
      expectedRevision: 0,
      action: 'accept',
      reason: 'Yes, it is valid.'
    });
  });
});

describe('code review: accepted findings are correction requirements, not proof of a fix', () => {
  it('lists an accepted finding as a requirement that is still open, and says accepting changed no code', async () => {
    serve(2);
    server.autoDecided('f-1', 'accept');
    renderPanel();

    const block = await screen.findByLabelText('Correction requirements');
    expect(block.textContent).toContain('Correction requirements (1)');
    expect(block.textContent).toContain('Finding A');
    expect(block.textContent).toContain('Accepted correction: Persist the intent before calling out.');
    expect(block.textContent).toContain('Open — the code has not changed since this was accepted.');
    expect(block.textContent).toMatch(/does not change any code/);
    // A rejected or undecided finding is not a requirement.
    expect(within(block).queryByText('Finding B')).toBeNull();
    // Nothing offers to mark an unfixed finding resolved.
    expect(within(block).queryByRole('button', { name: /Mark resolved/ })).toBeNull();
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('hands the accepted findings to the existing correction round, and reports the task it returns', async () => {
    serve(2);
    server.autoDecided('f-1', 'accept');
    const sent = task({ status: 'IMPLEMENTING', currentRound: 2 });
    bridge.set('workflow:sendCorrections', () => ok<'workflow:sendCorrections'>(sent));
    const onCorrectionsSent = vi.fn();
    renderPanel({ onCorrectionsSent });

    const send = await screen.findByRole('button', { name: /Send accepted findings as corrections/ });
    expect(send).toHaveProperty('disabled', false);
    fireEvent.click(send);

    await waitFor(() => expect(bridge.callsTo('workflow:sendCorrections')).toHaveLength(1));
    // Only the task id: the accepted set is read from the durable decisions by the backend.
    expect(bridge.callsTo('workflow:sendCorrections')[0]?.input).toEqual({ taskId: 'task-1' });
    await waitFor(() => expect(onCorrectionsSent).toHaveBeenCalledWith(sent));
    // Sending is not resolving.
    expect(bridge.callsTo('codeReview:decide')).toHaveLength(0);
  });

  it('does not offer to send while the task is somewhere corrections cannot start, and says where they can', async () => {
    serve(1);
    server.autoDecided('f-1', 'accept');
    renderPanel({ task: task({ status: 'IMPLEMENTING' }) });

    const block = await screen.findByLabelText('Correction requirements');
    expect(within(block).queryByRole('button', { name: /Send accepted findings as corrections/ })).toBeNull();
    expect(block.textContent).toMatch(/Corrections can be sent from a ready or approved round/);
    expect(block.textContent).toContain('This task is implementing.');
  });

  it('disables the hand-off, with the reason, once the round budget is spent', async () => {
    serve(1);
    server.autoDecided('f-1', 'accept');
    renderPanel({ task: task({ currentRound: 3, maxRounds: 3 }) });

    const send = await screen.findByRole('button', { name: /Send accepted findings as corrections/ });
    expect(send).toHaveProperty('disabled', true);
    expect(send.getAttribute('title')).toBeTruthy();
  });

  it('tells the operator to capture and re-review once the code has moved, and offers no “resolved” yet', async () => {
    serve(2);
    server.autoDecided('f-1', 'accept');
    server.statusOverrides = { 'f-1': 'awaiting_fresh_review' };
    renderPanel();

    const block = await screen.findByLabelText('Correction requirements');
    expect(block.textContent).toContain('The code has moved on. Capture it and run a fresh external review');
    expect(within(block).queryByRole('button', { name: /Mark resolved/ })).toBeNull();
    expect(within(block).queryByLabelText(/Why is this fixed/)).toBeNull();
  });

  it('offers “Mark resolved” only after a fresh review of the corrected code, and only with a reason', async () => {
    serve(2);
    server.autoDecided('f-1', 'accept');
    server.statusOverrides = { 'f-1': 'fresh_review_done' };
    bridge.set('codeReview:decide', () => ok<'codeReview:decide'>(server.detail()));
    renderPanel();

    const block = await screen.findByLabelText('Correction requirements');
    expect(block.textContent).toContain('A fresh review of the corrected code has run.');
    const resolve = within(block).getByRole('button', { name: 'Mark resolved: Finding A' });
    expect(resolve).toHaveProperty('disabled', true);

    fireEvent.change(within(block).getByLabelText(/Why is this fixed/), { target: { value: 'The intent is persisted first now.' } });
    expect(resolve).toHaveProperty('disabled', false);
    fireEvent.click(resolve);

    await waitFor(() => expect(bridge.callsTo('codeReview:decide')).toHaveLength(1));
    expect(bridge.callsTo('codeReview:decide')[0]?.input).toEqual({
      taskId: 'task-1',
      findingId: 'f-1',
      expectedRevision: 1,
      action: 'resolved',
      reason: 'The intent is persisted first now.'
    });
  });

  it('shows no requirements block when nothing was accepted', async () => {
    serve(2, (id, s) => s.autoDecided(id, 'reject'));
    renderPanel();
    await screen.findByText('Finding A');
    fireEvent.click(bulkButton());
    await screen.findByText(/Auto decide finished/);

    expect(screen.queryByLabelText('Correction requirements')).toBeNull();
    expect(screen.queryByRole('button', { name: /Send accepted findings/ })).toBeNull();
  });
});

describe('code review: panel visibility', () => {
  it('shows nothing when the integration is off and nothing was ever captured', async () => {
    serve(0);
    server.subject = subject();
    bridge.set('codeReview:get', () => ok<'codeReview:get'>({ ...server.detail(), subject: null, subjectIdentity: 'no_subject' }));
    render(<CodeReviewPanel task={task()} integrationEnabled={false} />);

    await waitFor(() => expect(bridge.callsTo('codeReview:get')).toHaveLength(1));
    expect(screen.queryByText('External code review')).toBeNull();
  });

  it('with the integration off, offers no Auto decide, so nothing can be sent to a provider that is disabled', async () => {
    serve(1);
    render(<CodeReviewPanel task={task()} integrationEnabled={false} />);

    await screen.findByText('Finding A');
    expect(screen.queryByRole('button', { name: /Auto decide all undecided/ })).toBeNull();
    expect(autoButton('Finding A')).toHaveProperty('disabled', true);
  });

  it('shows the real error when reading the evidence fails', async () => {
    serve(1);
    bridge.set('codeReview:get', () => fail('The evidence database is locked.'));
    renderPanel();

    expect(await screen.findByText('The evidence database is locked.')).toBeTruthy();
  });
});
