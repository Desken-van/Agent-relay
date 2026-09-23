/** @vitest-environment jsdom */
/**
 * "Continue correction" on the REAL Run screen. In the Run screen the plan-review panel renders no
 * primary button of its own (`renderPrimary={false}`): the Run screen's one primary action is the only
 * control, and it reaches the panel through the dispatcher the panel registers. A key that the Run
 * screen does not forward is a button that renders, is enabled, and does nothing.
 */
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { RunView } from '../../src/renderer/src/components/RunView';
import { useStore } from '../../src/renderer/src/state/store';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';
import { taskSchema, type Settings } from '../../src/shared/domain/models';
import type { PlanAdvanceOutcome } from '../../src/shared/domain/plan-correction';
import type { PlanReviewDetail, TaskDetail } from '../../src/shared/ipc';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { deferred, fail, installBridge, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = '2026-09-23T09:00:00.000Z';
const FAILURE =
  'Codex changed "constraints" without tying the change to an accepted finding. The revision was not stored, so the accepted findings are still not addressed.';

const specification: TaskSpecification = {
  title: 'Add the Ornith UI smoke test section',
  summary: 'Add it.',
  assumptions: [],
  acceptanceCriteria: ['It exists.'],
  constraints: ['Keep the existing sections.'],
  suggestedTests: [],
  implementationPrompt: 'Do it.',
  scopedFilePaths: []
};

function settings(): Settings {
  return {
    localInference: defaultLocalInferenceSettings(),
    claudeExecutablePath: null, codexExecutablePath: null, ghExecutablePath: null,
    externalPlanReviewEnabled: true, externalCodeReviewEnabled: false,
    coaiMcpExecutablePath: null, coaiMcpArguments: [], coaiMcpWorkingDirectory: null,
    coaiLastKnownContractFingerprint: null, coaiLastKnownContractCheckedAt: null,
    conventionsRepositoryPath: null, conventionsExpectedRevision: null, conventionsRulePaths: [],
    githubOwner: 'acme', projectsRoot: 'C:\\projects', worktreesRoot: 'C:\\worktrees',
    maxReviewRounds: 3, processTimeoutMs: 30 * 60_000, maxStoredLogBytes: 2_000_000, maxDiffBytes: 400_000,
    claudeMaxTurns: 80, claudeAllowedTools: [], claudeVerificationTools: [], codexModel: null, claudeModel: null
  };
}

function taskDetail(): TaskDetail {
  const task = taskSchema.parse({
    id: 't', projectId: 'p', title: specification.title, originalRequest: 'Add it.',
    status: 'READY_FOR_IMPLEMENTATION', currentRound: 0, maxRounds: 3, codexThreadId: 'spec', claudeSessionId: null,
    worktreePath: null, branchName: null, baseBranch: null,
    specificationJson: JSON.stringify(specification), specificationApprovedAt: null,
    lastReviewJson: null, lastError: null, codexModel: null, claudeModel: null,
    implementationProvider: 'claude', reviewProvider: 'codex',
    createdAt: NOW, updatedAt: NOW
  });
  return {
    task,
    project: {
      id: 'p', name: 'Agent Relay', localPath: 'C:\\repo', projectType: 'existing', defaultBranch: 'main',
      githubOwner: null, githubRepo: null, githubVisibility: 'private', createdAt: NOW, updatedAt: NOW
    },
    runs: [],
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

/** A settled round that accepted one finding, and a first correction that Codex failed: what the live task showed. */
function failedCorrection(attempts: number, lastError: string = FAILURE): PlanReviewDetail {
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
      id: 'gate-1', taskId: 't', specificationSha256: 'd'.repeat(64), ruleEvidenceSha256: 'a'.repeat(64),
      sessionId: 'session-1', serverName: 'coai', serverVersion: '1.0.0', contractFingerprint: 'f'.repeat(64),
      contractMismatchAt: null, status: 'changes_requested', verdict: 'revise', findingsJson: 'stored-findings',
      decisionsJson: JSON.stringify([{ finding: 0, action: 'accept', reason: 'Valid.' }]),
      reviewers: 'codex:architecture', gatingCount: 1, threshold: 1, lastError: null, reconciledAt: null,
      revision: 3, triageJson: null, triageForFindings: null, autoDecisionsJson: null, reviewSubject: null,
      roundsAtOpen: null, failureKind: null, supersededBy: null, createdAt: NOW, updatedAt: NOW
    },
    findingsSha256: 'b'.repeat(64),
    findings: [{
      severity: 'major', category: 'reliability', file: 'docs/manual-test.md', line: 1,
      title: 'The section names no fixture policy', why: 'Why.', fix: 'Fix.', providers: ['codex'], role: 'Architecture'
    }],
    autoDecisions: [],
    analyzing: [],
    correction: {
      used: 1,
      max: 3,
      nextStep: 'revise',
      loop: null,
      latest: { round: 1, status: 'failed', attempts, lastError, acceptedCount: 1, addressed: [] },
      acceptedPending: 1,
      versions: [{ version: 1, specificationSha256: 'd'.repeat(64), origin: 'generated', createdAt: NOW }]
    },
    recovery: null
  };
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

/** The whole Run screen mounts and loads settings and the plan review first; slow under a full parallel run. */
const MOUNTED = { timeout: 10_000 };
const continueButton = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /Continue correction/ }, MOUNTED);

const outcome = (overrides: Partial<PlanAdvanceOutcome>): PlanAdvanceOutcome => ({
  stopped: 'awaiting_decisions',
  message: 'Round 2 of the plan review is waiting for decisions.',
  correctionsRun: 1,
  roundsReviewed: 1,
  ...overrides
});

describe('Run screen — "Continue correction" after a failed plan correction', () => {
  it('is the one primary action, and a click sends exactly one continueCorrection for this task', async () => {
    const answer = deferred<unknown>();
    const bridge = installBridge({
      'settings:get': () => ok<'settings:get'>(settings()),
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'planReview:get': () => ok<'planReview:get'>(failedCorrection(1)),
      'planReview:continueCorrection': () => answer.promise
    });
    renderApp(<SeededRun detail={taskDetail()} />);

    const button = await continueButton();
    expect(button).toHaveProperty('disabled', false);
    // The panel renders no button of its own here: this one is the Run screen's primary action.
    expect(screen.getAllByRole('button', { name: /Continue correction/ })).toHaveLength(1);
    // The failure the correction row recorded is on screen before the click.
    expect(document.body.textContent).toContain('without tying the change to an accepted finding');

    fireEvent.click(button);
    await waitFor(() => expect(bridge.callsTo('planReview:continueCorrection')).toHaveLength(1));
    expect(bridge.callsTo('planReview:continueCorrection')[0]!.input).toMatchObject({ taskId: 't' });

    answer.resolve(ok<'planReview:continueCorrection'>({ detail: failedCorrection(2), outcome: outcome({}) }));
    await screen.findByText(/Round 2 of the plan review is waiting for decisions/, {}, MOUNTED);
  });

  it('shows the new failure when the retried revision fails again', async () => {
    const again = 'Codex changed "implementationPrompt" without tying the change to an accepted finding. The revision was not stored, so the accepted findings are still not addressed.';
    const bridge = installBridge({
      'settings:get': () => ok<'settings:get'>(settings()),
      'dependencies:status': () => ok<'dependencies:status'>({ state: 'not_node_project', detail: 'No package.json.' }),
      'planReview:get': () => ok<'planReview:get'>(failedCorrection(1))
    });
    renderApp(<SeededRun detail={taskDetail()} />);
    const button = await continueButton();

    // The main process records the second attempt before it answers with the failure.
    bridge.set('planReview:get', () => ok<'planReview:get'>(failedCorrection(2, again)));
    bridge.set('planReview:continueCorrection', () =>
      fail(again, 'VALIDATION_FAILED', 'Nothing was changed. Use "Continue correction" to try again.')
    );
    fireEvent.click(button);

    await waitFor(() => expect(bridge.callsTo('planReview:continueCorrection')).toHaveLength(1));
    await screen.findByText(/The correction loop stopped/, {}, MOUNTED);
    await waitFor(() => expect(document.body.textContent).toContain('changed "implementationPrompt"'));
  });
});
