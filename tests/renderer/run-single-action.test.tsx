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
import { cleanup, screen } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import type { TaskDetail } from '../../src/shared/ipc';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { installBridge, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
      'an output that overflowed the stored log budget (never a plain re-run)',
      detail({ lastError: OUTPUT_LIMIT_REASON }, [ornithRun(1), relayVerification({ failureKind: 'output_limit', exitCode: null, reason: OUTPUT_LIMIT_REASON, ...FINGERPRINTS })]),
      'Run verification after changes'
    ],
    [
      'a second materially identical unclassifiable failure on the same snapshot (diagnostic re-run exhausted)',
      detail({ lastError: UNKNOWN_REASON }, [
        ornithRun(1),
        relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-1'),
        relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-2')
      ]),
      'Run verification after changes'
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
  ])('after %s renders exactly one workflow control: %s', async (_state, taskDetail, expected) => {
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' })
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

  it('after an exhausted diagnostic re-run renders neither "to diagnose" nor "again", and says the step is gated', async () => {
    installBridge({
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' })
    });
    renderApp(<SeededRun detail={detail({ lastError: UNKNOWN_REASON }, [
      ornithRun(1),
      relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-1'),
      relayVerification({ failureKind: 'unknown', reason: UNKNOWN_REASON, ...FINGERPRINTS }, 'failed', 'verification-2')
    ])} />);

    await screen.findByRole('button', { name: 'Run verification after changes' });
    expect(workflowControls()).toEqual(['Run verification after changes']);
    expect(screen.queryByRole('button', { name: 'Run verification to diagnose' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run verification again' })).toBeNull();
    expect(document.body.textContent).toContain('not offered again');
    expect(document.body.textContent).toContain('no implementation round is spent');
    expect(screen.getByRole('button', { name: /Stop task/ })).toBeTruthy();
  });
});
