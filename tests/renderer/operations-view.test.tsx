/**
 * @vitest-environment jsdom
 *
 * The Operations screen, driven through its real buttons and fields.
 *
 * These render the actual components against a fake preload bridge and click
 * what a person would click. A helper test that never mounts JSX proves the
 * helper; it does not prove that a button is wired to it, that Save is disabled
 * when it should be, or that a late answer cannot overwrite the screen — which
 * is the whole of what could go wrong here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { OperationsView } from '../../src/renderer/src/components/OperationsView';
import {
  burstClick,
  deferred,
  deliver,
  fail,
  installBridge,
  makeRun,
  makeSchemaResult,
  makeTarget,
  ok,
  renderApp,
  renderOperations,
  Sections,
  settle,
  type Bridge
} from './harness';

let bridge: Bridge;

beforeEach(() => {
  bridge = installBridge();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

/** The visible list of registered targets. */
const targetList = (): HTMLElement =>
  screen.getByText(/^Targets/).closest('.card') as HTMLElement;

/** Asserted through the DOM property, so no extra matcher library is needed. */
const disabled = (element: HTMLElement): boolean =>
  (element as HTMLButtonElement).disabled === true;

/** The `<summary>` lines of the history list, without their expanded bodies. */
const historySummaries = (card: HTMLElement): HTMLElement[] =>
  Array.from(card.querySelectorAll('summary'));

/* -------------------------------------------------------------------------- */
/* Reaching the screen                                                         */
/* -------------------------------------------------------------------------- */

describe('reaching Operations', () => {
  it('is available with no project and no task selected', async () => {
    bridge = installBridge({ 'projects:list': () => ok<'projects:list'>([]) });
    renderApp(<App />);

    const operations = await screen.findByRole('button', { name: /Operations/ });
    // Tasks and Run are gated on a selection; Operations is not, because a
    // target has nothing to do with a repository.
    expect(disabled(screen.getByRole('button', { name: /Tasks/ }))).toBe(true);
    expect(disabled(screen.getByRole('button', { name: /^Run$/ }))).toBe(true);
    expect(disabled(operations)).toBe(false);

    fireEvent.click(operations);

    expect(await screen.findByText('No targets registered')).toBeTruthy();
  });

  it('shows no development project in the Operations header', async () => {
    const project = {
      id: 'p1',
      name: 'unrelated-repository',
      localPath: 'C:\\repo',
      projectType: 'existing' as const,
      defaultBranch: 'main',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private' as const,
      createdAt: 't',
      updatedAt: 't'
    };
    bridge = installBridge({ 'projects:list': () => ok<'projects:list'>([project]) });
    renderApp(<App />);

    // Select the project, then go to Operations.
    fireEvent.click(await screen.findByText('unrelated-repository'));
    fireEvent.click(screen.getByRole('button', { name: /Operations/ }));

    await screen.findByText('No targets registered');
    const header = document.querySelector('.topbar') as HTMLElement;
    expect(within(header).queryByText(/unrelated-repository/)).toBeNull();
    expect(within(header).getByText('Operations')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

describe('loading targets', () => {
  it('shows an empty state when there are none', async () => {
    renderOperations(<OperationsView />);
    expect(await screen.findByText('No targets registered')).toBeTruthy();
  });

  it('shows the backend error and offers a retry, without pretending the list is empty', async () => {
    bridge = installBridge({
      'operations:listTargets': () => fail('the database is locked', 'INTERNAL')
    });
    renderOperations(<OperationsView />);

    expect(await screen.findByText(/the database is locked/)).toBeTruthy();
    expect(screen.queryByText('No targets registered')).toBeNull();

    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Reporting snapshot')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Registering                                                                 */
/* -------------------------------------------------------------------------- */

describe('registering a target', () => {
  const fillForm = (values: { name?: string; environment?: string; path?: string }): void => {
    const form = screen.getByText('Register a target').closest('.card') as HTMLElement;
    if (values.name !== undefined) {
      fireEvent.change(within(form).getByLabelText('Name'), { target: { value: values.name } });
    }
    if (values.environment !== undefined) {
      fireEvent.change(within(form).getByLabelText('Environment'), {
        target: { value: values.environment }
      });
    }
    if (values.path !== undefined) {
      fireEvent.change(within(form).getByLabelText('Database path'), {
        target: { value: values.path }
      });
    }
  };

  const saveButton = (): HTMLElement => screen.getByRole('button', { name: /Register target/ });

  it('requires the environment to be chosen explicitly', async () => {
    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    // The select starts on no choice at all — not on `local`.
    const form = screen.getByText('Register a target').closest('.card') as HTMLElement;
    expect((within(form).getByLabelText('Environment') as HTMLSelectElement).value).toBe('');

    fillForm({ name: 'Reports', path: 'C:\\data\\reports.sqlite' });
    expect(disabled(saveButton())).toBe(true);
    expect(screen.getByText(/Choose the environment/)).toBeTruthy();

    fillForm({ environment: 'staging' });
    expect(disabled(saveButton())).toBe(false);
  });

  it('keeps Save disabled for a path that is not absolute, and calls nothing', async () => {
    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    for (const path of ['reports.sqlite', './reports.sqlite', 'C:\\data\\..\\reports.sqlite']) {
      fillForm({ name: 'Reports', environment: 'local', path });
      expect(disabled(saveButton())).toBe(true);
    }

    fireEvent.click(saveButton());
    expect(bridge.callsTo('operations:createTarget')).toEqual([]);
  });

  it('sends exactly the payload the shared schema produced', async () => {
    const created = makeTarget({ id: 'target-new', name: 'Reports', environment: 'staging' });
    bridge.set('operations:createTarget', () => ok<'operations:createTarget'>(created));

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    const form = screen.getByText('Register a target').closest('.card') as HTMLElement;
    fillForm({ name: '  Reports  ', environment: 'staging', path: 'C:\\data\\reports.sqlite' });
    fireEvent.click(saveButton());

    await waitFor(() => expect(bridge.callsTo('operations:createTarget')).toHaveLength(1));
    expect(bridge.callsTo('operations:createTarget')[0]?.input).toEqual({
      // Trimmed and normalised by the shared schema, not by the renderer.
      name: 'Reports',
      environment: 'staging',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\reports.sqlite'
      }
    });

    // No credential field exists to send.
    const payload = bridge.callsTo('operations:createTarget')[0]?.input as Record<string, unknown>;
    expect(payload).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(payload)).not.toMatch(/password|token|connectionString/i);

    await waitFor(() =>
      expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('')
    );
    expect(screen.queryByText(/It was registered after all/)).toBeNull();
    expect(screen.queryByText(/The reply was lost/)).toBeNull();
  });

  it('keeps the draft when the backend refuses', async () => {
    bridge.set('operations:createTarget', () =>
      fail('A local target named "Reports" is already registered.')
    );

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    fillForm({ name: 'Reports', environment: 'local', path: 'C:\\data\\reports.sqlite' });
    fireEvent.click(saveButton());

    expect(await screen.findByText(/already registered/)).toBeTruthy();

    // Nothing the operator typed was thrown away.
    const form = screen.getByText('Register a target').closest('.card') as HTMLElement;
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
    expect((within(form).getByLabelText('Database path') as HTMLInputElement).value).toBe(
      'C:\\data\\reports.sqlite'
    );
    expect((within(form).getByLabelText('Environment') as HTMLSelectElement).value).toBe('local');
  });
});

/* -------------------------------------------------------------------------- */
/* Running a diagnostic                                                        */
/* -------------------------------------------------------------------------- */

describe('running a diagnostic', () => {
  const openTarget = async (target = makeTarget()): Promise<void> => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([target]));
    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText(target.name));
    await screen.findByText('Run a diagnostic');
  };

  it('runs nothing on its own — not on mount, not on selecting, not on refresh', async () => {
    await openTarget();

    fireEvent.click(within(targetList()).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets').length).toBeGreaterThan(1));

    const history = screen.getByText('History').closest('.card') as HTMLElement;
    fireEvent.click(within(history).getByRole('button', { name: 'Refresh' }));
    await settle();

    // Listing targets and reading recorded history open no database. Only a
    // click on Run may start a probe. Settled first, so this is "never"
    // rather than "not yet".
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);
  });

  it('shows what is about to be inspected, and says it is read-only', async () => {
    await openTarget();

    const panel = screen.getByText('Run a diagnostic').closest('.card') as HTMLElement;
    expect(within(panel).getByText('Reporting snapshot')).toBeTruthy();
    expect(within(panel).getByText('local')).toBeTruthy();
    expect(within(panel).getByText('C:\\data\\reports.sqlite')).toBeTruthy();
    expect(within(panel).getByText(/no row of any user table is read/i)).toBeTruthy();
  });

  it('sends the target and the probe that were chosen, for both probes', async () => {
    bridge.set('operations:runDiagnostic', () => ok<'operations:runDiagnostic'>(makeRun()));
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: /Run diagnostic/ }));
    await waitFor(() => expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1));
    expect(bridge.callsTo('operations:runDiagnostic')[0]?.input).toEqual({
      targetId: 'target-1',
      probeId: 'connection_health'
    });

    fireEvent.change(screen.getByLabelText('Diagnostic'), {
      target: { value: 'schema_summary' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Run diagnostic/ }));
    await waitFor(() => expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(2));
    expect(bridge.callsTo('operations:runDiagnostic')[1]?.input).toEqual({
      targetId: 'target-1',
      probeId: 'schema_summary'
    });

    // Limits are the backend's defaults; this phase sends none.
    for (const call of bridge.callsTo('operations:runDiagnostic')) {
      expect(call.input).not.toHaveProperty('options');
    }
  });

  it('will not run against a disabled target', async () => {
    await openTarget(makeTarget({ enabled: false }));

    const run = screen.getByRole('button', { name: /Run diagnostic/ });
    expect(disabled(run)).toBe(true);
    fireEvent.click(run);
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);
    expect(screen.getByText(/This target is disabled/)).toBeTruthy();
  });

  it('turns a double click into one run', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:runDiagnostic', () => gate.promise);
    await openTarget();

    // One tick, three clicks: nothing is re-rendered in between, so all three
    // see the same state and only a synchronous claim can refuse the later two.
    await burstClick(screen.getByRole('button', { name: /Run diagnostic/ }));
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

    gate.resolve(ok<'operations:runDiagnostic'>(makeRun()));
    await waitFor(() => expect(screen.getByText('Latest result')).toBeTruthy());
  });

  it('does not let navigating away and back start a second run', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:runDiagnostic', () => gate.promise);
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));

    // The screen is unmounted and remounted, exactly as switching sections
    // does — while the provider above it stays mounted, exactly as the
    // application mounts it. That is the whole point: the request has to
    // outlive the screen.
    renderOperations(
      <Sections>
        <OperationsView />
      </Sections>
    );

    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    fireEvent.click(await screen.findByRole('button', { name: /Run diagnostic/ }));
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    expect(screen.queryByText('Run a diagnostic')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Operations' }));
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    // Still busy, and still one request.
    const run = await screen.findByRole('button', { name: /Running/ });
    expect(disabled(run)).toBe(true);
    fireEvent.click(run);
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

    gate.resolve(ok<'operations:runDiagnostic'>(makeRun()));
    await waitFor(() => expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1));
  });

  it('does not claim nothing happened when the call itself fails', async () => {
    bridge.set('operations:runDiagnostic', () => Promise.reject(new Error('the bridge went away')));
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: /Run diagnostic/ }));

    expect(await screen.findByText(/The request did not come back/)).toBeTruthy();
    expect(screen.getByText(/Whether the diagnostic ran is\s+unknown/)).toBeTruthy();
    // The recorded history is re-read; the diagnostic is never retried.
    await waitFor(() =>
      expect(bridge.callsTo('operations:listDiagnostics').length).toBeGreaterThan(1)
    );
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

describe('showing a result', () => {
  const runWith = async (run: ReturnType<typeof makeRun>): Promise<void> => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:runDiagnostic', () => ok<'operations:runDiagnostic'>(run));
    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    fireEvent.click(await screen.findByRole('button', { name: /Run diagnostic/ }));
    await screen.findByText('Latest result');
  };

  it('does not hide warnings or truncation behind a green status', async () => {
    await runWith(
      makeRun({
        probeId: 'schema_summary',
        result: makeSchemaResult({
          omittedTables: 12,
          omittedColumns: 40,
          truncated: true,
          warnings: ['The connection did not report query_only.'],
          tables: [
            {
              name: 'invoices',
              columns: [{ name: 'id', declaredType: 'INTEGER', nullable: false, primaryKey: true }],
              omittedColumns: 7
            }
          ]
        })
      })
    );

    const panel = screen.getByText('Latest result').closest('.card') as HTMLElement;
    expect(within(panel).getByText('succeeded')).toBeTruthy();
    // …and the incompleteness is stated right beside it.
    expect(within(panel).getByText(/This summary is incomplete/)).toBeTruthy();
    expect(within(panel).getByText(/12 table\(s\) and\s+40 column\(s\) were left out/)).toBeTruthy();
    expect(within(panel).getByText('7 column(s) omitted')).toBeTruthy();
    expect(within(panel).getByText(/did not report query_only/)).toBeTruthy();
  });

  it('does not call a timeout evidence that the database is broken', async () => {
    await runWith(
      makeRun({
        status: 'failed',
        result: null,
        failureKind: 'timeout',
        errorMessage: 'The probe did not finish within 15s and was stopped.'
      })
    );

    const panel = screen.getByText('Latest result').closest('.card') as HTMLElement;
    expect(within(panel).getByText('failed')).toBeTruthy();
    expect(within(panel).getByText(/did not finish within 15s/)).toBeTruthy();
    expect(
      within(panel).getByText(/did not finish, not that the database is unhealthy/)
    ).toBeTruthy();
  });

  it('says so when a run is malformed, and shows no result', async () => {
    await runWith(
      makeRun({
        status: 'failed',
        result: null,
        failureKind: 'malformed',
        errorMessage: 'The probe returned a result this build cannot read.'
      })
    );

    const panel = screen.getByText('Latest result').closest('.card') as HTMLElement;
    expect(within(panel).getByText('malformed')).toBeTruthy();
    expect(within(panel).queryByText('SQLite version')).toBeNull();
    expect(within(panel).queryByText('succeeded')).toBeNull();
  });

  it('renders an unknown value as unknown, never as 0 or no', async () => {
    await runWith(
      makeRun({
        result: {
          ...makeRun().result!,
          probeId: 'connection_health',
          sqliteVersion: null,
          fileSizeBytes: null,
          fileModifiedAt: null
        } as never
      })
    );

    const panel = screen.getByText('Latest result').closest('.card') as HTMLElement;
    expect(within(panel).getAllByText('unknown')).toHaveLength(3);
    expect(within(panel).queryByText('0 bytes')).toBeNull();
  });

  it('renders an HTML-looking table name as text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    await runWith(
      makeRun({
        probeId: 'schema_summary',
        result: makeSchemaResult({
          tables: [{ name: hostile, columns: [], omittedColumns: 0 }]
        })
      })
    );

    const panel = screen.getByText('Latest result').closest('.card') as HTMLElement;
    // Present as text, and no element was created from it.
    expect(within(panel).getByText(hostile)).toBeTruthy();
    expect(panel.querySelector('img')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Deletion                                                                    */
/* -------------------------------------------------------------------------- */

describe('removing a registration', () => {
  it('explains what is removed, and keeps everything when the backend refuses', async () => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () =>
      ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-old' })])
    );
    bridge.set('operations:deleteTarget', () =>
      fail(
        'This target has 1 diagnostic run(s) on record and cannot be removed.',
        'VALIDATION_FAILED',
        'Disable the target instead. Its history is an audit record of what was inspected and when.'
      )
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove registration' }));
    // The confirmation says what is and is not touched.
    expect(screen.getByText(/removes the registration from Agent Relay only/)).toBeTruthy();
    expect(screen.getByText(/is not touched, moved or\s+deleted/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove the registration' }));

    // Once, and in the target panel — not under the Run button, where it
    // would read as a reason a probe had failed.
    expect(await screen.findByText(/1 diagnostic run\(s\) on record/)).toBeTruthy();
    expect(screen.getAllByText(/1 diagnostic run\(s\) on record/)).toHaveLength(1);
    const runPanel = screen.getByText('Run a diagnostic').closest('.card') as HTMLElement;
    expect(within(runPanel).queryByText(/on record/)).toBeNull();
    expect(screen.getByText(/Disable the target instead/)).toBeTruthy();

    // Nothing was lost: the target is still listed and its history is intact.
    expect(within(targetList()).getByText('Reporting snapshot')).toBeTruthy();
    const history = screen.getByText('History').closest('.card') as HTMLElement;
    expect(within(history).getByText(/Showing the last/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Late answers                                                                */
/* -------------------------------------------------------------------------- */

describe('an answer that arrives after the user moved on', () => {
  it('does not paint target A over target B', async () => {
    const a = makeTarget({ id: 'target-a', name: 'Alpha' });
    const b = makeTarget({ id: 'target-b', name: 'Beta', config: { version: 1, adapterType: 'local_sqlite', databasePath: 'C:\\data\\beta.sqlite' } });
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([a, b]));

    const slowA = deferred<unknown>();
    bridge.set('operations:listDiagnostics', (input) => {
      const { targetId } = input as { targetId: string };
      if (targetId === 'target-a') return slowA.promise;
      return ok<'operations:listDiagnostics'>([
        makeRun({ id: 'diag-beta', targetId: 'target-b', probeId: 'schema_summary' })
      ]);
    });

    renderOperations(<OperationsView />);

    fireEvent.click(await within(targetList()).findByText('Alpha'));
    await screen.findByText('Run a diagnostic');

    fireEvent.click(within(targetList()).getByText('Beta'));
    const history = await screen.findByText('History');
    const historyCard = history.closest('.card') as HTMLElement;
    await waitFor(() =>
      expect(historySummaries(historyCard).map((entry) => entry.textContent)).toHaveLength(1)
    );

    // Alpha's answer lands now, long after the user moved on. Resolved inside
    // `act` and then given time to be processed, so the assertions below run
    // against a screen that has actually seen it — a `waitFor` on a condition
    // that is already true would pass without React having rendered anything.
    await deliver(slowA, ok<'operations:listDiagnostics'>([
      makeRun({ id: 'diag-alpha', targetId: 'target-a', probeId: 'connection_health' })
    ]));

    // Beta is still what is on screen, in every panel.
    const runPanel = screen.getByText('Run a diagnostic').closest('.card') as HTMLElement;
    expect(within(runPanel).getByText('C:\\data\\beta.sqlite')).toBeTruthy();

    const summaries = historySummaries(historyCard).map((entry) => entry.textContent ?? '');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('schema_summary');
    expect(summaries.join(' ')).not.toContain('connection_health');
  });

  it('labels an old run with the environment the run recorded, not the target as it is now', async () => {
    // The target has since been renamed and moved to production; the run that
    // happened before that still describes what it actually looked at.
    const target = makeTarget({ environment: 'production', name: 'Renamed' });
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([target]));
    bridge.set('operations:listDiagnostics', () =>
      ok<'operations:listDiagnostics'>([
        makeRun({ id: 'diag-old', result: { ...makeRun().result!, environment: 'staging' } as never })
      ])
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Renamed'));

    const historyCard = (await screen.findByText('History')).closest('.card') as HTMLElement;
    const summary = historyCard.querySelector('summary') as HTMLElement;
    expect(within(summary).getByText('staging')).toBeTruthy();
    expect(within(summary).queryByText('production')).toBeNull();
  });
});
