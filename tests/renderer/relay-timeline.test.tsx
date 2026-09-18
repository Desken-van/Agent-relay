/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { RelayTimeline } from '../../src/renderer/src/components/RelayTimeline';
import type { Run } from '../../src/shared/domain/models';
import { installBridge, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    taskId: 't',
    agent: 'claude',
    runType: 'implementation',
    status: 'succeeded',
    round: 1,
    startedAt: '2026-09-10T10:00:00.000Z',
    finishedAt: '2026-09-10T10:00:05.000Z',
    finalMessage: null,
    errorMessage: null,
    structuredResult: null,
    ...overrides
  };
}

describe('Relay timeline — full run detail', () => {
  it('shows who acted, the run type, round, status and duration for every run', async () => {
    installBridge();
    const runs: Run[] = [
      makeRun({ id: 'r1', agent: 'codex', runType: 'specification', round: 0, status: 'succeeded' }),
      makeRun({ id: 'r2', agent: 'claude', runType: 'implementation', round: 1, status: 'failed' }),
      makeRun({
        id: 'r3',
        agent: 'system',
        runType: 'verification',
        round: 1,
        status: 'succeeded',
        structuredResult: JSON.stringify({
          version: 1,
          command: 'npm run verify',
          identity: 'a'.repeat(64),
          passed: true,
          exitCode: 0,
          durationMs: 10,
          reason: null
        })
      })
    ];
    renderApp(<RelayTimeline runs={runs} />);

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getAllByText('Agent Relay').length).toBeGreaterThan(0);
    expect(screen.getByText('Specification')).toBeTruthy();
    expect(screen.getByText('Implementation')).toBeTruthy();
    expect(screen.getByText('Verification · npm run verify')).toBeTruthy();
    expect(screen.getAllByText('round 1')).toHaveLength(2);
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('snapshot verification passed')).toBeTruthy();
    // Flushes the default-expanded node's pending `runs:events` fetch before unmount.
    await screen.findByText(/^Events/);
  });

  it('keeps every badge readable on a run that carries round, status, verification and duration at once', async () => {
    installBridge();
    const run = makeRun({
      id: 'busy',
      agent: 'claude',
      runType: 'correction',
      round: 3,
      status: 'succeeded',
      structuredResult: JSON.stringify({
        assessment: {
          version: 1,
          disposition: 'pass',
          verificationStatus: 'passed',
          publishBlock: 'none',
          reasonCodes: [],
          verification: null,
          denials: []
        }
      })
    });
    renderApp(<RelayTimeline runs={[run]} />);

    const head = document.querySelector('.relay__head');
    expect(head).toBeTruthy();
    const scoped = within(head as HTMLElement);
    expect(scoped.getByText('Claude Code')).toBeTruthy();
    expect(scoped.getByText('Correction')).toBeTruthy();
    expect(scoped.getByText('round 3')).toBeTruthy();
    expect(scoped.getByText('done')).toBeTruthy();
    expect(scoped.getByText(/provider verification passed/)).toBeTruthy();
    await screen.findByText(/^Events/);
  });

  it('expanding a node splits Outcome, Error and Events into separate labelled sections without truncating any of them', async () => {
    const longMessage = 'Outcome line. '.repeat(60);
    const longEventText = 'x'.repeat(400);
    installBridge({
      'runs:events': () =>
        ok<'runs:events'>([
          {
            id: 'e1',
            runId: 'last',
            timestamp: '2026-09-10T10:00:01.000Z',
            type: 'log',
            payload: JSON.stringify({ text: longEventText })
          }
        ])
    });
    const run = makeRun({
      id: 'last',
      finalMessage: longMessage,
      errorMessage: 'Something recoverable happened.'
    });
    renderApp(<RelayTimeline runs={[run]} />);

    // Newest run is expanded by default — no click needed to see the body.
    expect(await screen.findByText('Outcome')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText(/^Events/)).toBeTruthy();

    expect(screen.getByText(longMessage.trim(), { exact: false }).textContent).toContain(longMessage.trim());
    expect(await screen.findByText(longEventText)).toBeTruthy();
  });

  it('toggles the event log between its bounded default and a full, unbounded view', async () => {
    installBridge({
      'runs:events': () =>
        ok<'runs:events'>([
          { id: 'e1', runId: 'r1', timestamp: '2026-09-10T10:00:01.000Z', type: 'log', payload: JSON.stringify({ text: 'first' }) }
        ])
    });
    const run = makeRun({ id: 'r1' });
    renderApp(<RelayTimeline runs={[run]} />);

    const toggle = await screen.findByRole('button', { name: 'Show full event log' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const log = document.querySelector('.logs');
    expect(log?.className).not.toContain('logs--full');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse event log' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.logs')?.className).toContain('logs--full');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse event log' }));
    expect(screen.getByRole('button', { name: 'Show full event log' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.logs')?.className).not.toContain('logs--full');
  });

  it('omits the full-log toggle when a run recorded no events', async () => {
    installBridge({ 'runs:events': () => ok<'runs:events'>([]) });
    const run = makeRun({ id: 'r1' });
    renderApp(<RelayTimeline runs={[run]} />);

    await screen.findByText('No events were recorded for this run.');
    expect(screen.queryByRole('button', { name: /event log/ })).toBeNull();
  });

  it('toggles a collapsed node open on click, exposing aria-expanded state', async () => {
    installBridge();
    const runs: Run[] = [
      makeRun({ id: 'older', finalMessage: 'first round done' }),
      makeRun({ id: 'newest', startedAt: '2026-09-10T10:01:00.000Z', finishedAt: '2026-09-10T10:01:05.000Z' })
    ];
    renderApp(<RelayTimeline runs={runs} />);

    const olderHead = screen.getByRole('button', { expanded: false });
    expect(olderHead.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('first round done')).toBeNull();

    fireEvent.click(olderHead);
    expect(olderHead.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('first round done')).toBeTruthy();
  });
});

describe('Relay timeline — Ornith read-budget denial events', () => {
  it('renders the precise budget/recoverable state instead of the plain generic denial text, for a recoverable denial', async () => {
    installBridge({
      'runs:events': () =>
        ok<'runs:events'>([
          {
            id: 'e1',
            runId: 'ornith-run',
            timestamp: '2026-09-10T10:00:01.000Z',
            type: 'tool_use',
            payload: JSON.stringify({
              text: 'Ornith action search_text denied (limit_read_bytes_exceeded); recovering with feedback.',
              data: {
                sequence: 3,
                action: 'search_text',
                ok: false,
                code: 'limit_read_bytes_exceeded',
                recoverable: true,
                readBytesUsed: 4_160_000,
                readBytesConfigured: 4_194_304,
                changedFiles: 0
              }
            })
          }
        ])
    });
    const run = makeRun({ id: 'ornith-run', agent: 'ornith' });
    renderApp(<RelayTimeline runs={[run]} />);

    await screen.findByText('tool use');
    const lines = document.querySelectorAll('.logs__text');
    expect(lines).toHaveLength(1); // exactly one rendered line for this one recorded event
    const text = lines[0]!.textContent ?? '';
    expect(text).toContain('search_text');
    expect(text).toContain('limit_read_bytes_exceeded');
    expect(text).toContain('4160000 / 4194304 bytes');
    expect(text).toContain('recovering with feedback');
    expect(text).toContain('no files changed yet');
    expect(text).not.toContain('unsafe or over-limit');
  });

  it('renders the stopped state, distinctly, once the recovery budget is exhausted', async () => {
    installBridge({
      'runs:events': () =>
        ok<'runs:events'>([
          {
            id: 'e1',
            runId: 'ornith-run',
            timestamp: '2026-09-10T10:00:01.000Z',
            type: 'tool_use',
            payload: JSON.stringify({
              text: 'Ornith action search_text denied (limit_read_bytes_exceeded); the run stopped.',
              data: {
                sequence: 4,
                action: 'search_text',
                ok: false,
                code: 'limit_read_bytes_exceeded',
                recoverable: false,
                readBytesUsed: 4_194_000,
                readBytesConfigured: 4_194_304,
                changedFiles: 1
              }
            })
          }
        ])
    });
    const run = makeRun({ id: 'ornith-run', agent: 'ornith', status: 'failed' });
    renderApp(<RelayTimeline runs={[run]} />);

    await screen.findByText('tool use');
    const text = document.querySelector('.logs__text')?.textContent ?? '';
    expect(text).toContain('the run stopped');
    expect(text).toContain('1 file(s) changed');
    expect(text).not.toContain('recovering with feedback');
  });

  it('leaves an ordinary tool_use event (no enriched denial data) rendered as plain text, unaffected', async () => {
    installBridge({
      'runs:events': () =>
        ok<'runs:events'>([
          {
            id: 'e1',
            runId: 'ornith-run',
            timestamp: '2026-09-10T10:00:01.000Z',
            type: 'tool_use',
            payload: JSON.stringify({ text: 'read_file path="docs/manual-test.md" offset=0 bytes=120', data: { ok: true } })
          }
        ])
    });
    const run = makeRun({ id: 'ornith-run', agent: 'ornith' });
    renderApp(<RelayTimeline runs={[run]} />);

    expect(await screen.findByText('read_file path="docs/manual-test.md" offset=0 bytes=120')).toBeTruthy();
  });
});

describe('Relay timeline — provider vs snapshot verification stay distinct', () => {
  it('renders a diagnostic provider-side assessment as a warning, never as a failed run, even when the provider check itself failed', async () => {
    installBridge();
    const run = makeRun({
      agent: 'claude',
      runType: 'implementation',
      status: 'succeeded',
      structuredResult: JSON.stringify({
        assessment: {
          version: 1,
          disposition: 'fail',
          verificationStatus: 'failed',
          publishBlock: 'verification',
          reasonCodes: ['no_verification_evidence'],
          verification: null,
          denials: []
        }
      })
    });
    renderApp(<RelayTimeline runs={[run]} />);

    const tag = screen.getByText(/provider verification failed/);
    expect(tag.className).toContain('tag--warn');
    expect(tag.className).not.toContain('tag--danger');
    await screen.findByText(/^Events/);
  });

  it('renders Relay-owned snapshot verification as its own, separately worded tag', async () => {
    installBridge();
    const run = makeRun({
      agent: 'system',
      runType: 'verification',
      structuredResult: JSON.stringify({
        version: 1,
        command: 'npm run verify',
        identity: 'b'.repeat(64),
        passed: false,
        exitCode: 1,
        durationMs: 20,
        reason: 'tests failed'
      })
    });
    renderApp(<RelayTimeline runs={[run]} />);

    const tag = screen.getByText(/snapshot verification unconfirmed/);
    expect(tag.className).toContain('tag--warn');
    expect(screen.queryByText(/provider verification/)).toBeNull();
    await screen.findByText(/^Events/);
  });

  it('names the real reason inline when a round failed before verification was ever reached, instead of an unexplained "not run"', async () => {
    installBridge();
    const run = makeRun({
      agent: 'ornith',
      runType: 'implementation',
      status: 'failed',
      structuredResult: JSON.stringify({
        assessment: {
          version: 1,
          disposition: 'fail',
          verificationStatus: 'not_run',
          publishBlock: 'configuration',
          reasonCodes: ['timeout'],
          verification: null,
          denials: []
        }
      })
    });
    renderApp(<RelayTimeline runs={[run]} />);

    expect(screen.queryByText(/provider verification not run/)).toBeNull();
    const tag = screen.getByText(/verification not reached \(timeout\)/);
    expect(tag.className).toContain('tag--warn');
    await screen.findByText(/^Events/);
  });

  it('still renders the plain "not run" tag when nothing else failed (an unrelated older run, or a genuinely diagnostic-only round)', async () => {
    installBridge();
    const run = makeRun({
      agent: 'ornith',
      runType: 'implementation',
      status: 'succeeded',
      structuredResult: JSON.stringify({
        assessment: {
          version: 1,
          disposition: 'pass',
          verificationStatus: 'not_run',
          publishBlock: 'none',
          reasonCodes: [],
          verification: null,
          denials: []
        }
      })
    });
    renderApp(<RelayTimeline runs={[run]} />);

    expect(screen.getByText(/provider verification not run/)).toBeTruthy();
    expect(screen.queryByText(/verification not reached/)).toBeNull();
    await screen.findByText(/^Events/);
  });
});
