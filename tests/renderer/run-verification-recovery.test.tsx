/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrimaryActionButton, RunFlowOverview } from '../../src/renderer/src/components/RunView';
import { RelayTimeline } from '../../src/renderer/src/components/RelayTimeline';
import { runSchema, taskSchema, type Run, type Task } from '../../src/shared/domain/models';
import type { OrnithVerificationAttempt } from '../../src/shared/domain/ornith-verification';
import { runGuidance, type RunGuidance } from '../../src/shared/domain/run-guidance';
import { burstClick, installBridge, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function task(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    id: 'task-1', projectId: 'project-1', title: 'Add configured provider smoke-test checklist', originalRequest: 'Add it',
    status: 'READY_FOR_IMPLEMENTATION', currentRound: 1, maxRounds: 3, codexThreadId: null, claudeSessionId: null,
    worktreePath: null, branchName: null, baseBranch: 'main', specificationJson: null,
    specificationApprovedAt: '2026-09-11T00:00:00.000Z', lastReviewJson: null, lastError: null, codexModel: null,
    claudeModel: null, createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
    implementationProvider: 'ornith', ...overrides
  });
}

function run(overrides: Partial<Run> = {}): Run {
  return runSchema.parse({
    id: 'ornith-run', taskId: 'task-1', agent: 'ornith', runType: 'implementation', status: 'failed',
    round: 1, startedAt: '2026-09-11T00:00:00.000Z', finishedAt: '2026-09-11T00:01:00.000Z',
    finalMessage: null, structuredResult: null, errorMessage: null, ...overrides
  });
}

const failedAttempt = (overrides: Partial<OrnithVerificationAttempt> = {}): OrnithVerificationAttempt => ({
  sequence: 3, command: 'npm run verify', outcome: 'failed', exitCode: 1, durationMs: 511_795,
  reason: 'npm run verify exited with code 1 after 8m32s.',
  summary: ' FAIL  tests/adapters/native.test.ts > guard\nAssertionError: expected timeout to be stale_hash',
  code: null, fingerprint: 'abc123', ...overrides
});

function ornithRun(input: { changedFiles: number; attempts?: readonly OrnithVerificationAttempt[]; reasonCodes?: readonly string[] }): Run {
  return run({
    structuredResult: JSON.stringify({
      provider: 'ornith',
      counters: { changedFiles: input.changedFiles, worktreeChangedFiles: input.changedFiles, verificationAttempts: input.attempts ?? [] },
      assessment: { reasonCodes: input.reasonCodes ?? [] }
    })
  });
}

const guidanceFor = (value: Task, runs: readonly Run[]): RunGuidance =>
  runGuidance(value, runs, true, false, 'not_required', { ornithLocalInferenceState: 'healthy' });

/** What the Run screen renders for the guidance: the flow overview plus the primary and secondary controls. */
function renderRunScreen(value: RunGuidance, handlers: { primary?: () => void; secondary?: () => void } = {}) {
  return render(<>
    <RunFlowOverview guidance={value} />
    {value.action ? <PrimaryActionButton action={value.action} pending={false} blocked={false} onClick={handlers.primary ?? (() => undefined)} /> : null}
    {value.secondaryAction ? (
      <PrimaryActionButton secondary action={value.secondaryAction} pending={false} blocked={false} onClick={handlers.secondary ?? (() => undefined)} />
    ) : null}
  </>);
}

describe('the Run screen after Ornith changed a file and its verification failed', () => {
  const live = () => guidanceFor(
    task({ lastError: 'Ornith changed 1 file. npm run verify exited with code 1 after 8m32s. The changes are preserved in the task worktree. Run verification in Agent Relay to check them.' }),
    [ornithRun({ changedFiles: 1, attempts: [failedAttempt()] })]
  );

  it('says what changed and that verification failed, with the exact command, exit code, duration, reason and output', () => {
    renderRunScreen(live());

    expect(screen.getByText('Implementation changed 1 file; verification failed.')).toBeTruthy();
    const detail = screen.getByRole('region', { name: 'Verification attempt' });
    const inside = within(detail);
    expect(inside.getByText('Ornith verification attempt')).toBeTruthy();
    expect(inside.getByText('npm run verify')).toBeTruthy();
    expect(inside.getByText('Failed')).toBeTruthy();
    expect(inside.getByText('1')).toBeTruthy(); // exit code
    expect(inside.getByText('8m32s')).toBeTruthy();
    expect(inside.getByText('npm run verify exited with code 1 after 8m32s.')).toBeTruthy();
    // The bounded output is offered, collapsed.
    expect(inside.getByText('Command output (bounded)')).toBeTruthy();
    expect(detail.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(detail.querySelector('pre')?.textContent).toContain('AssertionError: expected timeout to be stale_hash');
    expect(screen.getByText(/Manual verification is required before review\./)).toBeTruthy();
  });

  it('makes "Run verification" the one recommended action and "Retry implementation" a plain, secondary button', () => {
    const { container } = renderRunScreen(live());

    expect(container.querySelectorAll('button.btn--recommended')).toHaveLength(1);
    const primary = screen.getByRole('button', { name: 'Run verification' });
    const secondary = screen.getByRole('button', { name: 'Retry implementation · Ornith' });
    expect(primary.className).toContain('btn--recommended');
    expect(secondary.className).not.toContain('btn--recommended');
    expect(secondary.className).not.toContain('btn--primary');
    // "Run implementation · Ornith" is not offered at all: it is no longer the only recovery.
    expect(screen.queryByRole('button', { name: 'Run implementation · Ornith' })).toBeNull();
  });

  it('routes each button to its own action, once per click even under a burst', async () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    renderRunScreen(live(), { primary, secondary });

    await burstClick(screen.getByRole('button', { name: 'Run verification' }));
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).not.toHaveBeenCalled();

    await burstClick(screen.getByRole('button', { name: 'Retry implementation · Ornith' }));
    expect(secondary).toHaveBeenCalledOnce();
  });

  it('distinguishes a timed-out verification and an expired implementation time limit', () => {
    const timedOut = renderRunScreen(guidanceFor(task(), [ornithRun({
      changedFiles: 1,
      attempts: [failedAttempt({ outcome: 'timed_out', exitCode: null, durationMs: 808_391, reason: 'npm run verify was stopped after 13m28s: the implementation time budget left no more time for it.' })]
    })]));
    expect(screen.getByText('Implementation changed 1 file; verification timed out.')).toBeTruthy();
    expect(screen.getByText('Timed out')).toBeTruthy();
    expect(screen.queryByText('Exit code')).toBeNull(); // there is none, and none is invented
    timedOut.unmount();

    renderRunScreen(guidanceFor(task(), [ornithRun({ changedFiles: 1, reasonCodes: ['limit_deadline_exceeded'], attempts: [failedAttempt()] })]));
    expect(screen.getByText('The implementation time limit expired. Implementation changed 1 file.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run verification' })).toBeTruthy();
  });

  it('shows a refused verification as "Not started", with no duration or exit code', () => {
    renderRunScreen(guidanceFor(task(), [ornithRun({
      changedFiles: 1,
      attempts: [failedAttempt({ outcome: 'not_run', exitCode: null, durationMs: 0, summary: '', reason: 'Only 1m of the implementation time budget remain.', code: 'limit_verification_time_insufficient' })]
    })]));

    expect(screen.getByText('Implementation changed 1 file; verification was not started.')).toBeTruthy();
    expect(screen.getByText('Not started')).toBeTruthy();
    expect(screen.queryByText('Duration')).toBeNull();
    expect(screen.queryByText('Exit code')).toBeNull();
    expect(screen.queryByText('Command output (bounded)')).toBeNull();
  });

  it('shows Agent Relay’s own failed verification the same way, with the repair primary and checking again secondary', () => {
    const value = guidanceFor(task({ lastError: 'npm run verify failed (exit 1). See command output.' }), [
      ornithRun({ changedFiles: 1 }),
      run({
        id: 'v', runType: 'verification', agent: 'system', status: 'failed',
        structuredResult: JSON.stringify({
          version: 1, command: 'npm run verify', identity: 'a'.repeat(64), passed: false, exitCode: 1, durationMs: 42_000,
          reason: 'npm run verify failed (exit 1). See command output.', outcome: 'failed', outputSummary: ' FAIL  tests/a.test.ts'
        })
      })
    ]);
    renderRunScreen(value);

    expect(screen.getByText('Agent Relay verification')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fix verification failures · Ornith' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run verification again' })).toBeTruthy();
  });
});

describe('the Run screen when Ornith changed nothing', () => {
  it('keeps "Run implementation · Ornith" as the action, with no verification panel and no secondary button', () => {
    const value = guidanceFor(
      task({ lastError: 'Ornith stopped before changing any files.' }),
      [ornithRun({ changedFiles: 0 })]
    );
    const { container } = renderRunScreen(value);

    expect(screen.getByRole('button', { name: 'Run implementation · Ornith' })).toBeTruthy();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Verification attempt' })).toBeNull();
    // Said as the headline and again as the recorded result — the same words, not two different stories.
    expect(screen.getAllByText('Ornith stopped before changing any files.')).toHaveLength(2);
  });
});

describe('the Relay timeline for an Ornith run_verification event', () => {
  const eventsFor = (payload: unknown) => installBridge({
    'runs:events': () => ok<'runs:events'>([{
      id: 'e1', runId: 'ornith-run', timestamp: '2026-09-11T00:00:01.000Z', type: 'tool_use', payload: JSON.stringify(payload)
    }])
  });

  it('reads a failed command as FAILED with its exit code, duration and reason — not as a success because the action ran', async () => {
    eventsFor({
      text: 'run_verification -> failed (npm run verify exited with code 1 after 8m32s.)',
      data: {
        sequence: 3, action: 'run_verification', ok: false, dispatched: true,
        verification: {
          command: 'npm run verify', outcome: 'failed', exitCode: 1, durationMs: 511_795,
          reason: 'npm run verify exited with code 1 after 8m32s.', summary: ' FAIL  tests/a.test.ts'
        }
      }
    });
    renderApp(<RelayTimeline runs={[run()]} />);

    await screen.findByText('tool use');
    const line = document.querySelector('.logs__text')!;
    const text = line.textContent ?? '';
    expect(text).toContain('Ornith verification npm run verify FAILED');
    expect(text).toContain('exit code 1');
    expect(text).toContain('8m32s');
    expect(text).toContain('npm run verify exited with code 1 after 8m32s.');
    expect(text).not.toMatch(/\bpassed\b/i);
    expect(line.querySelector('pre')?.textContent).toContain('FAIL  tests/a.test.ts');
    expect(line.querySelector('details')?.hasAttribute('open')).toBe(false);
  });

  it('reads a timeout as TIMED OUT and a pass as passed, each in its own words', async () => {
    eventsFor({
      text: 'run_verification -> timed_out',
      data: {
        sequence: 3, action: 'run_verification', ok: false, dispatched: true,
        verification: { command: 'npm run verify', outcome: 'timed_out', exitCode: null, durationMs: 600_000, reason: 'exceeded its own timeout', summary: '' }
      }
    });
    const timedOut = renderApp(<RelayTimeline runs={[run()]} />);
    await screen.findByText('tool use');
    const timedOutText = document.querySelector('.logs__text')!.textContent ?? '';
    expect(timedOutText).toContain('TIMED OUT');
    expect(timedOutText).not.toContain('exit code');
    timedOut.unmount();
    cleanup();

    eventsFor({
      text: 'run_verification -> passed',
      data: {
        sequence: 3, action: 'run_verification', ok: true, dispatched: true,
        verification: { command: 'npm run verify', outcome: 'passed', exitCode: 0, durationMs: 90_000, reason: null, summary: '' }
      }
    });
    renderApp(<RelayTimeline runs={[run()]} />);
    await screen.findByText('tool use');
    expect(document.querySelector('.logs__text')!.textContent).toContain('npm run verify passed · exit code 0 · 1m30s');
  });

  it('falls back to the recorded text for an event written before these fields existed', async () => {
    eventsFor({ text: 'run_verification -> failed', data: { sequence: 3, action: 'run_verification', ok: true } });
    renderApp(<RelayTimeline runs={[run()]} />);

    expect(await screen.findByText('run_verification -> failed')).toBeTruthy();
    expect(document.querySelector('.logs__text pre')).toBeNull();
  });

  it('falls back safely for a damaged verification payload instead of throwing', async () => {
    eventsFor({
      text: 'run_verification -> failed',
      data: { sequence: 3, action: 'run_verification', ok: false, dispatched: true, verification: { outcome: 'failed' } }
    });
    renderApp(<RelayTimeline runs={[run()]} />);

    expect(await screen.findByText('run_verification -> failed')).toBeTruthy();
  });
});
