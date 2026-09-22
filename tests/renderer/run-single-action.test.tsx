/** @vitest-environment jsdom */
/**
 * The product rule the Run screen enforces: exactly one workflow "next step" control at a time. A task that
 * had a failed verification once showed a repair, a re-run and a retry side by side, and the operator took the
 * wrong one. This renders the REAL Run screen for every recovery state and counts the workflow controls — the
 * ones that start a round, a verification or a review — requiring exactly one, with the right label for what
 * the evidence says. *Stop task* is a separate safety control and is never counted.
 */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { deferred, installBridge, ok, renderApp } from './harness';
import type { VerificationReadiness } from '../../src/shared/domain/verification';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Where the store says the operator is, and which Settings control was named — navigation is observable, not guessed. */
function SectionProbe(): React.JSX.Element {
  const { section, settingsFocus } = useStore();
  return <span data-testid="section">{section}|{settingsFocus ?? ''}</span>;
}

function SeededRun({ detail }: { detail: TaskDetail }): React.JSX.Element {
  const { openTaskDetail } = useStore();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    openTaskDetail(detail);
  }, [detail, openTaskDetail]);
  return <RunView />;
}

const specification: TaskSpecification = {
  title: 'Add configured provider smoke-test checklist',
  summary: 'Add it.',
  assumptions: [],
  acceptanceCriteria: ['It exists.'],
  constraints: [],
  suggestedTests: [],
  implementationPrompt: 'Do it.',
  scopedFilePaths: ['docs/manual-test.md']
};

function run(overrides: Partial<Run>): Run {
  return runSchema.parse({
    id: 'r', taskId: 't', agent: 'ornith', runType: 'implementation', status: 'failed', round: 1,
    startedAt: '2026-09-22T11:00:00.000Z', finishedAt: '2026-09-22T11:09:55.000Z',
    finalMessage: null, structuredResult: null, errorMessage: null, ...overrides
  });
}

const ornithRun = (changedFiles: number): Run => run({
  id: 'ornith',
  structuredResult: JSON.stringify({
    provider: 'ornith',
    counters: { changedFiles, worktreeChangedFiles: changedFiles, verificationAttempts: [] },
    assessment: { reasonCodes: [] }
  })
});

const relayVerification = (extra: Record<string, unknown>, status: Run['status'] = 'failed', id = 'verification'): Run => run({
  id, agent: 'system', runType: 'verification', status,
  structuredResult: JSON.stringify({
    version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false, exitCode: 1, durationMs: 580_014,
    reason: 'npm run verify failed (exit 1).', outcome: 'failed', ...extra
  })
});

function detail(task: Partial<Task>, runs: readonly Run[]): TaskDetail {
  const parsed = taskSchema.parse({
    id: 't', projectId: 'p', title: specification.title, originalRequest: 'Add it.',
    status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: 'spec', claudeSessionId: null,
    worktreePath: 'C:\\worktree', branchName: 'agent/task', baseBranch: 'main',
    specificationJson: JSON.stringify(specification), specificationApprovedAt: '2026-09-22T10:00:00.000Z',
    lastReviewJson: null, lastError: null, codexModel: null, claudeModel: null,
    implementationProvider: 'ornith', reviewProvider: 'codex',
    createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T11:09:55.000Z', ...task
  });
  return {
    task: parsed,
    project: {
      id: 'p', name: 'Agent Relay', localPath: 'C:\\repo', projectType: 'existing', defaultBranch: 'main',
      githubOwner: null, githubRepo: null, githubVisibility: 'private',
      createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T09:00:00.000Z'
    },
    runs: [...runs],
    approvals: [],
    specification,
    lastReview: null,
    worktree: null,
    continuationOf: null,
    continuationEntryAction: null,
    continuedAs: null,
    continuationCreationStatus: null,
    effectivePublishRefusal: null
  };
}

/** Every rendered button that would start a round, a verification or a review — the workflow controls. */
const WORKFLOW_CONTROL = /^(Run implementation|Retry implementation|Fix verification failures|Run verification|Run review|Send corrections|Approve)/;
function workflowControls(): string[] {
  return screen.getAllByRole('button')
    .map((button) => button.textContent?.trim() ?? '')
    .filter((name) => WORKFLOW_CONTROL.test(name));
}

const INFRASTRUCTURE_REASON = 'Verification could not complete: a Vitest worker stopped answering (worker timeout). That is a failure of the test infrastructure, not of the current files.';
const IMPLEMENTATION_REASON = 'npm run verify failed (exit 1): a test assertion failed. The current files did not pass.';
const UNKNOWN_REASON = 'npm run verify failed (exit 1), but the output does not show which check failed or why.';
const OUTPUT_LIMIT_REASON = "Verification output exceeded Agent Relay's configured retention limit (2000k characters per run), so the result could not be classified safely: the command was stopped at the limit and only the output up to it was kept. Raise \"Stored log budget\" in Settings or reduce what npm run verify prints; running it again unchanged would stop at the same limit.";
/** Both fingerprints the record keeps for the re-run policy; equal on two runs means "materially the same". */
const FINGERPRINTS = { configurationFingerprint: 'c'.repeat(16), evidenceFingerprint: 'e'.repeat(16) };
const OVERFLOW_DETAIL = detail({ lastError: OUTPUT_LIMIT_REASON }, [
  ornithRun(1),
  relayVerification({ failureKind: 'output_limit', exitCode: null, reason: OUTPUT_LIMIT_REASON, ...FINGERPRINTS })
]);
const EXHAUSTED_DETAIL = detail({ lastError: UNKNOWN_REASON }, [
  ornithRun(1),
  relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-1'),
  relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-2')
]);

describe('Run screen — exactly one workflow control, chosen by the evidence', () => {
  it.each([
    [
      'a Vitest worker timeout (retryable infrastructure failure)',
      detail({ lastError: INFRASTRUCTURE_REASON }, [ornithRun(1), relayVerification({ failureKind: 'infrastructure', reason: INFRASTRUCTURE_REASON })]),
      'Run verification again'
    ],
    [
      'a failing assertion (actionable implementation failure)',
      detail({ lastError: IMPLEMENTATION_REASON }, [ornithRun(1), relayVerification({ failureKind: 'implementation', reason: IMPLEMENTATION_REASON, outputSummary: 'AssertionError: expected 1 to be 2' })]),
      'Fix verification failures · Ornith'
    ],
    [
      'an unclassifiable failure (fails closed)',
      detail({ lastError: UNKNOWN_REASON }, [ornithRun(1), relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON })]),
      'Run verification to diagnose'
    ],
    [
      'an output that overflowed the stored log budget, once the main process says the files changed',
      OVERFLOW_DETAIL,
      'Run verification',
      { state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false } satisfies VerificationReadiness
    ],
    [
      'an exhausted diagnostic re-run, once the main process says the verification settings changed',
      EXHAUSTED_DETAIL,
      'Run verification',
      { state: 'ready', cause: 'unknown_exhausted', filesChanged: false, settingsChanged: true } satisfies VerificationReadiness
    ],
    [
      'a record written before classification existed (fails closed)',
      detail({ lastError: 'npm run verify failed (exit 1). See command output.' }, [ornithRun(1), relayVerification({})]),
      'Run verification to diagnose'
    ],
    [
      'a cancelled verification',
      detail({ lastError: 'Verification cancelled; success was not established.' }, [ornithRun(1), relayVerification({ failureKind: 'cancelled', exitCode: null, outcome: 'cancelled' })]),
      'Run verification'
    ],
    [
      'preserved changes that were never verified',
      detail({ lastError: 'Ornith changed 1 file. Verification did not run in this round.' }, [ornithRun(1)]),
      'Run verification'
    ],
    [
      'an attempt that provably changed nothing',
      detail({ lastError: 'Ornith stopped before changing any files.', currentRound: 0 }, [ornithRun(0)]),
      'Retry implementation · Ornith'
    ],
    [
      'an approved specification with no attempt yet',
      detail({ currentRound: 0 }, []),
      'Run implementation · Ornith'
    ],
    [
      'a verification that passed',
      detail({ status: 'READY_FOR_REVIEW' }, [ornithRun(1), relayVerification({ passed: true, exitCode: 0, reason: null, outcome: 'passed' }, 'succeeded')]),
      'Run review · Codex'
    ]
  ])('after %s renders exactly one workflow control: %s', async (_state, taskDetail, expected, readiness?: VerificationReadiness) => {
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      ...(readiness === undefined ? {} : { 'workflow:verificationReadiness': () => ok<'workflow:verificationReadiness'>(readiness) })
    });
    renderApp(<SeededRun detail={taskDetail} />);

    await screen.findByRole('button', { name: expected });
    expect(workflowControls()).toEqual([expected]);
    // The status text names that same step: the label and the recommendation never disagree.
    expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2);
    // Stop task is the one other control, a safety control, and is never counted as a next step.
    expect(screen.getByRole('button', { name: /Stop task/ })).toBeTruthy();
  });

  it('never renders "Run verification again" and "Fix verification failures" together, nor a retry beside a verification', async () => {
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' })
    });
    renderApp(<SeededRun detail={detail({ lastError: INFRASTRUCTURE_REASON }, [ornithRun(1), relayVerification({ failureKind: 'infrastructure', reason: INFRASTRUCTURE_REASON })])} />);

    await screen.findByRole('button', { name: 'Run verification again' });
    expect(screen.queryByRole('button', { name: /Fix verification failures/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry implementation/ })).toBeNull();
    expect(document.body.textContent).not.toContain('Retry implementation');
    expect(document.body.textContent).toContain('no implementation round is spent');
  });
});

describe('Run screen — waiting states: a gated verification with nothing changed renders NO workflow control', () => {
  const bridgeWith = (readiness: () => Promise<unknown> | unknown) =>
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:verificationReadiness': () => readiness()
    });

  it('an output overflow with unchanged files and settings: "User action required", a Settings link and a re-check — and no button that could be refused', async () => {
    const bridge = bridgeWith(() => ok<'workflow:verificationReadiness'>({ state: 'blocked', cause: 'output_limit' }));
    renderApp(<><SeededRun detail={OVERFLOW_DETAIL} /><SectionProbe /></>);

    await screen.findAllByText(/User action required/); // said in the guide's next step and in the notice
    expect(workflowControls()).toEqual([]);
    expect(document.body.textContent).toContain('Stored log budget');
    expect(document.body.textContent).toContain('no verification step is offered');
    expect(screen.queryByRole('button', { name: /Run verification/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Stop task/ })).toBeTruthy();

    // The Settings link navigates — observable in the store — and starts nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings · Stored log budget' }));
    await waitFor(() => expect(screen.getByTestId('section').textContent).toBe('settings|maxStoredLogBytes'));
    // The re-check asks the main process again — and starts nothing either.
    const reads = bridge.callsTo('workflow:verificationReadiness').length;
    fireEvent.click(screen.getByRole('button', { name: 'Check for changes' }));
    await waitFor(() => expect(bridge.callsTo('workflow:verificationReadiness').length).toBeGreaterThan(reads));
    expect(bridge.callsTo('workflow:verify')).toEqual([]);
    expect(bridge.callsTo('workflow:implement')).toEqual([]);
    expect(workflowControls()).toEqual([]);
  });

  it('an exhausted diagnostic re-run with unchanged files and settings: "User action required", no Settings link, no recommendation of the provider', async () => {
    const bridge = bridgeWith(() => ok<'workflow:verificationReadiness'>({ state: 'blocked', cause: 'unknown_exhausted' }));
    renderApp(<SeededRun detail={EXHAUSTED_DETAIL} />);

    await screen.findAllByText(/User action required/); // said in the guide's next step and in the notice
    expect(workflowControls()).toEqual([]);
    expect(document.body.textContent).toContain('One diagnostic re-run was already used');
    expect(document.body.textContent).toContain('change the files or the verification settings');
    expect(screen.queryByRole('button', { name: /Open Settings/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check for changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop task/ })).toBeTruthy();
    for (const forbidden of ['Run verification to diagnose', 'Run verification again', 'Fix verification failures', 'Retry implementation']) {
      expect(document.body.textContent).not.toContain(forbidden);
    }
    expect(bridge.callsTo('workflow:verify')).toEqual([]);
  });

  it('while the main process has not answered, and when it cannot check, there is no control either', async () => {
    const never = deferred<unknown>();
    bridgeWith(() => never.promise);
    renderApp(<SeededRun detail={OVERFLOW_DETAIL} />);
    await screen.findByText(/Checking whether the files or the verification settings changed/);
    expect(workflowControls()).toEqual([]);
    cleanup();

    bridgeWith(() => ok<'workflow:verificationReadiness'>({ state: 'unavailable', cause: 'unknown_exhausted', detail: 'The task worktree cannot be checked for changes right now.' }));
    renderApp(<SeededRun detail={EXHAUSTED_DETAIL} />);
    await screen.findAllByText(/User action required/); // said in the guide's next step and in the notice
    expect(document.body.textContent).toContain('cannot be checked for changes right now');
    expect(workflowControls()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Check for changes' })).toBeTruthy();
  });

  it('a refused "Run verification" click discards the stale ready answer and re-reads it, landing on whatever the fresh read says — not the click repeated on the same stale belief', async () => {
    // The readiness that made the button appear can go stale between the read and the click (the operator
    // reverted the file, or the backend simply disagrees for its own reasons); the backend's own gate is
    // what actually refused it. This does not merely re-arm the same stale "ready": it discards it and asks
    // again, and the SECOND read here deliberately answers differently (`blocked`) to prove the new answer
    // — not the old one — is what ends up on screen.
    let reads = 0;
    const bridge = installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:verificationReadiness': () => {
        reads += 1;
        return ok<'workflow:verificationReadiness'>(
          reads === 1
            ? { state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false }
            : { state: 'blocked', cause: 'output_limit' }
        );
      },
      'workflow:verify': () => ({ ok: false, error: { code: 'VALIDATION_FAILED', message: "Verification was not started: the last run's output exceeded the stored log budget." } })
    });
    renderApp(<SeededRun detail={OVERFLOW_DETAIL} />);

    await screen.findByRole('button', { name: 'Run verification' });
    expect(reads).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run verification' }));

    // The refused click discarded the stale `ready` answer (an immediate "Checking…" render) and asked
    // again; the second read answers `blocked`, and that is what the screen now shows — no workflow
    // control, and the click is not repeated on its own.
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await screen.findAllByText(/User action required/);
    expect(workflowControls()).toEqual([]);
    expect(bridge.callsTo('workflow:verify')).toHaveLength(1);
  });

  it('a rejected or failed readiness IPC call is read the same as "cannot check": a retry control appears, never a silent stall', async () => {
    // Distinct from the domain-level `unavailable` answer (which `Orchestrator.verificationReadiness` itself
    // returns): here the CALL fails — thrown, or the main process answered `{ok:false}` — and the renderer
    // must still land on a state with a retry control, never stuck on "Checking…" with nothing to press.
    const bridge = installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:verificationReadiness': () => { throw new Error('IPC channel closed'); }
    });
    renderApp(<SeededRun detail={OVERFLOW_DETAIL} />);

    await screen.findAllByText(/User action required/);
    expect(workflowControls()).toEqual([]);
    expect(document.body.textContent).toContain('could not confirm whether verification may run yet');
    expect(screen.getByRole('button', { name: 'Check for changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop task/ })).toBeTruthy();
    expect(bridge.callsTo('workflow:verify')).toEqual([]);
  });

  it('an "{ok:false}" readiness response (no throw) is read the same way, and a later successful re-check still recovers', async () => {
    let fail = true;
    const bridge = installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'workflow:verificationReadiness': () => fail
        ? { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
        : ok<'workflow:verificationReadiness'>({ state: 'ready', cause: 'unknown_exhausted', filesChanged: true, settingsChanged: false })
    });
    renderApp(<SeededRun detail={EXHAUSTED_DETAIL} />);

    await screen.findAllByText(/User action required/);
    expect(workflowControls()).toEqual([]);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check for changes' }));
    await screen.findByRole('button', { name: 'Run verification' });
    expect(workflowControls()).toEqual(['Run verification']);
    expect(bridge.callsTo('workflow:verify')).toEqual([]);
  });

  it('a re-check that finds the files changed replaces the waiting state with exactly one "Run verification"', async () => {
    let answer: VerificationReadiness = { state: 'blocked', cause: 'output_limit' };
    const bridge = bridgeWith(() => ok<'workflow:verificationReadiness'>(answer));
    renderApp(<SeededRun detail={OVERFLOW_DETAIL} />);
    await screen.findAllByText(/User action required/); // said in the guide's next step and in the notice
    expect(workflowControls()).toEqual([]);

    answer = { state: 'ready', cause: 'output_limit', filesChanged: true, settingsChanged: false };
    fireEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

    await screen.findByRole('button', { name: 'Run verification' });
    expect(workflowControls()).toEqual(['Run verification']);
    expect(document.body.textContent).toContain('The files changed since that run');
    expect(document.body.textContent).not.toContain('User action required');
    expect(bridge.callsTo('workflow:verify')).toEqual([]);
  });
});
