/**
 * @vitest-environment jsdom
 *
 * The Operations screen's asynchronous state, driven through its real controls.
 *
 * Every test here corresponds to something that was actually wrong. A UI made
 * of `disabled` attributes and a local `saving` flag looks correct in a
 * screenshot and still hammers a failing backend, starts two writes from one
 * double click, or paints a stale list over a change the operator has just
 * made. None of that is visible without mounting the components and racing
 * them, so that is what these do.
 *
 * Timing is decided by the test, never by a sleep: every race is driven by a
 * deferred answer that is resolved at a chosen moment, so the result does not
 * depend on how loaded the machine is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { OperationsView } from '../../src/renderer/src/components/OperationsView';
import {
  burstClick,
  deferred,
  deliver,
  fail,
  installBridge,
  makeRun,
  makeTarget,
  ok,
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

const targetList = (): HTMLElement =>
  screen.getByText(/^Targets/).closest('.card') as HTMLElement;

const historyCard = (): HTMLElement =>
  screen.getByText('History').closest('.card') as HTMLElement;

const runPanel = (): HTMLElement =>
  screen.getByText('Run a diagnostic').closest('.card') as HTMLElement;

const registerForm = (): HTMLElement =>
  screen.getByText('Register a target').closest('.card') as HTMLElement;

/** Asserted through the DOM property, so no extra matcher library is needed. */
const disabled = (element: HTMLElement): boolean =>
  (element as HTMLButtonElement).disabled === true;

const historySummaries = (card: HTMLElement): HTMLElement[] =>
  Array.from(card.querySelectorAll('summary'));

/**
 * The open editor.
 *
 * Found through its Save button rather than by label: `Name` and `Database
 * path` also belong to the registration form, and an unscoped lookup would be
 * ambiguous — or worse, silently read the wrong one.
 */
const editorForm = (): HTMLElement =>
  screen.getByRole('button', { name: /Save changes/ }).closest('form') as HTMLElement;

/** The default target, plus a second one with a path of its own. */
const alpha = makeTarget({ id: 'target-a', name: 'Alpha' });
const beta = makeTarget({
  id: 'target-b',
  name: 'Beta',
  config: { version: 1, adapterType: 'local_sqlite', databasePath: 'C:\\data\\beta.sqlite' }
});

/** List these targets, render the screen, and select the first one. */
async function openTarget(target = makeTarget(), others: typeof alpha[] = []): Promise<void> {
  bridge.set('operations:listTargets', () =>
    ok<'operations:listTargets'>([target, ...others])
  );
  renderOperations(<OperationsView />);
  fireEvent.click(await within(targetList()).findByText(target.name));
  await screen.findByText('Run a diagnostic');
}

const fillForm = (values: { name?: string; environment?: string; path?: string }): void => {
  const form = registerForm();
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

/* -------------------------------------------------------------------------- */
/* A load that failed                                                          */
/* -------------------------------------------------------------------------- */

describe('a load that failed', () => {
  it('asks once for the target list, and again only when told to', async () => {
    bridge.set('operations:listTargets', () => fail('The registry is unavailable.', 'INTERNAL'));

    renderOperations(<OperationsView />);
    expect(await screen.findByText(/The registry is unavailable/)).toBeTruthy();

    // "No data and not loading" is true after a failure as well as before the
    // first attempt. An effect keyed on that fires again on the render its own
    // failure caused, and again on the next, for as long as the screen is open.
    await settle();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);

    // The error is still there — it has not been cleared by a silent retry.
    expect(screen.getByText(/The registry is unavailable/)).toBeTruthy();
    expect(screen.queryByText('No targets registered')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(2);
  });

  it('asks once for a history, and again only when told to', async () => {
    bridge.set('operations:listDiagnostics', () =>
      fail('The history could not be read.', 'INTERNAL')
    );
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    expect(await screen.findByText(/The history could not be read/)).toBeTruthy();
    await settle();
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(1);
    expect(screen.getByText(/The history could not be read/)).toBeTruthy();

    fireEvent.click(within(historyCard()).getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(2);
  });

  it('keeps one target’s failed history from speaking for another’s', async () => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([alpha, beta]));
    bridge.set('operations:listDiagnostics', (input) =>
      (input as { targetId: string }).targetId === 'target-a'
        ? fail('The history could not be read.', 'INTERNAL')
        : ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-beta', targetId: 'target-b' })])
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Alpha'));
    await screen.findByText(/The history could not be read/);

    fireEvent.click(within(targetList()).getByText('Beta'));
    await waitFor(() => expect(historySummaries(historyCard())).toHaveLength(1));

    // Beta's history loaded on its own state, and Alpha's failure is not being
    // retried behind the screen.
    expect(screen.queryByText(/The history could not be read/)).toBeNull();
    await settle();
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(2);
  });

  it('does not turn a bridge that rejects into an empty registry', async () => {
    bridge.set('operations:listTargets', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    expect(await screen.findByText(/The list did not come back/)).toBeTruthy();

    // "Nothing is registered" is a claim. A call that fell over supports no
    // claim at all, and says so.
    expect(screen.queryByText('No targets registered')).toBeNull();
    expect(screen.getByText(/registered is unknown until this succeeds/)).toBeTruthy();

    await settle();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);
  });

  it('does not retry a history whose call fell over', async () => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () =>
      Promise.reject(new Error('the bridge went away'))
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    expect(await screen.findByText(/Could not load the history/)).toBeTruthy();
    await settle();
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Answers that arrive out of order                                            */
/* -------------------------------------------------------------------------- */

describe('two reads answering out of order', () => {
  it('keeps the newer target list when the older Refresh answers last', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let attempt = 0;
    bridge.set('operations:listTargets', () => {
      attempt += 1;
      if (attempt === 1) return ok<'operations:listTargets'>([]);
      return attempt === 2 ? older.promise : newer.promise;
    });

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    const refresh = within(targetList()).getByRole('button', { name: 'Refresh' });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(3);

    await deliver(newer, ok<'operations:listTargets'>([makeTarget({ id: 'new', name: 'Newer' })]));
    await deliver(older, ok<'operations:listTargets'>([makeTarget({ id: 'old', name: 'Older' })]));

    expect(within(targetList()).getByText('Newer')).toBeTruthy();
    expect(within(targetList()).queryByText('Older')).toBeNull();

    // And the superseded answer started nothing: handing the phase back to
    // "never loaded" would have looked exactly like a fresh screen to the
    // mount effect, and begun a fourth request.
    await settle();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(3);
  });

  it('keeps the newer history when the older Refresh answers last', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let attempt = 0;
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => {
      attempt += 1;
      if (attempt === 1) return ok<'operations:listDiagnostics'>([]);
      return attempt === 2 ? older.promise : newer.promise;
    });

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await screen.findByText('No diagnostics recorded');

    const refresh = within(historyCard()).getByRole('button', { name: 'Refresh' });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(3);

    await deliver(
      newer,
      ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-newer', probeId: 'schema_summary' })])
    );
    await deliver(
      older,
      ok<'operations:listDiagnostics'>([
        makeRun({ id: 'diag-older', probeId: 'connection_health' }),
        makeRun({ id: 'diag-older-2', probeId: 'connection_health' })
      ])
    );

    const summaries = historySummaries(historyCard()).map((entry) => entry.textContent ?? '');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('schema_summary');

    await settle();
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(3);
  });

  it('does not put a target back the way a write has just changed it', async () => {
    const stale = deferred<unknown>();
    let attempt = 0;
    bridge.set('operations:listTargets', () => {
      attempt += 1;
      return attempt === 1 ? ok<'operations:listTargets'>([makeTarget()]) : stale.promise;
    });
    bridge.set('operations:updateTarget', () =>
      ok<'operations:updateTarget'>(makeTarget({ enabled: false }))
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await screen.findByText('Run a diagnostic');

    // A Refresh goes out, and while it is in the air the target is disabled.
    fireEvent.click(within(targetList()).getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByRole('button', { name: 'Enable' });

    // The Refresh answers with the world as it was before the write. Sequence
    // numbers alone would accept it: it is the newest *list* request there is.
    await deliver(stale, ok<'operations:listTargets'>([makeTarget({ enabled: true })]));

    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(within(targetList()).getByText('Disabled')).toBeTruthy();

    // Nor is the screen left spinning because the answer was discarded.
    expect(screen.queryByText('Loading targets…')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* One action at a time                                                        */
/* -------------------------------------------------------------------------- */

describe('one action per target at a time', () => {
  it('turns a double click on Disable into one request', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:updateTarget', () => gate.promise);
    await openTarget();

    // All three clicks land in one tick, so they see the same React state and
    // the button has not been re-rendered as disabled between them. "It looked
    // disabled" is a rendering fact, not a guarantee, and cannot be what stops
    // the second write.
    await burstClick(screen.getByRole('button', { name: 'Disable' }));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    await deliver(gate, ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('turns a double click on the delete confirmation into one request', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:deleteTarget', () => gate.promise);
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));
    await burstClick(screen.getByRole('button', { name: 'Yes, remove the registration' }));
    expect(bridge.callsTo('operations:deleteTarget')).toHaveLength(1);

    await deliver(gate, ok<'operations:deleteTarget'>({ removed: true }));
    expect(bridge.callsTo('operations:deleteTarget')).toHaveLength(1);
  });

  it('turns a double click on Save changes into one request', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:updateTarget', () => gate.promise);
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = editorForm();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Renamed' } });

    await burstClick(within(form).getByRole('button', { name: /Save changes/ }));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    await deliver(gate, ok<'operations:updateTarget'>(makeTarget({ name: 'Renamed' })));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('will not run a diagnostic while a write for that target is pending', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:updateTarget', () => gate.promise);
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    // A probe of a target that is being re-pointed would report on something
    // other than what the finished run claims it looked at.
    const run = within(runPanel()).getByRole('button', { name: /Waiting/ });
    expect(disabled(run)).toBe(true);
    fireEvent.click(run);
    await settle();
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);

    await deliver(gate, ok<'operations:updateTarget'>(makeTarget({ enabled: false })));

    // And once the write is done the probe is available again — for a target
    // that is now disabled, so the reason it stays unavailable is a different
    // one, and is the target's own state.
    expect(within(runPanel()).getByRole('button', { name: /Run diagnostic/ })).toBeTruthy();
  });

  it('will not start a write while a diagnostic is running', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:runDiagnostic', () => gate.promise);
    await openTarget();

    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));

    for (const name of ['Edit', 'Disable', 'Remove registration']) {
      expect(disabled(screen.getByRole('button', { name }))).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await settle();
    expect(bridge.callsTo('operations:updateTarget')).toEqual([]);

    await deliver(gate, ok<'operations:runDiagnostic'>(makeRun()));
    expect(disabled(screen.getByRole('button', { name: 'Disable' }))).toBe(false);
  });

  it('does not let navigating away and back start a second write', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:updateTarget', () => gate.promise);

    // The screen is unmounted and remounted, exactly as switching sections
    // does, while the provider above it stays mounted. A `saving` flag kept in
    // the panel is gone the moment the panel is, and the second click lands.
    renderOperations(
      <Sections>
        <OperationsView />
      </Sections>
    );

    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    expect(screen.queryByText('Run a diagnostic')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Operations' }));
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    const again = await screen.findByRole('button', { name: 'Disable' });
    expect(disabled(again)).toBe(true);
    fireEvent.click(again);
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    await deliver(gate, ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('turns a double click on Register target into one request', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:createTarget', () => gate.promise);

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    fillForm({ name: 'Reports', environment: 'local', path: 'C:\\data\\reports.sqlite' });
    await burstClick(screen.getByRole('button', { name: /Register target/ }));
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);

    await deliver(gate, ok<'operations:createTarget'>(makeTarget({ id: 'target-new' })));
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* A write whose outcome nobody knows                                          */
/* -------------------------------------------------------------------------- */

describe('a write whose outcome is unknown', () => {
  it('does not say a target was registered, and keeps the draft', async () => {
    bridge.set('operations:createTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    fillForm({ name: 'Reports', environment: 'local', path: 'C:\\data\\reports.sqlite' });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    expect(
      await screen.findByText(/did not come back, so whether it was applied is unknown/)
    ).toBeTruthy();

    // Clearing the form would say the target had been registered. Nothing
    // knows that, and the operator's typing is not thrown away on a guess.
    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
    expect((within(form).getByLabelText('Database path') as HTMLInputElement).value).toBe(
      'C:\\data\\reports.sqlite'
    );

    // The remediation promises the list has been re-read, so it has been —
    // and the create itself is never repeated.
    await waitFor(() => expect(bridge.callsTo('operations:listTargets').length).toBe(2));
    await settle();
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });

  it('re-reads the registry after an update nobody can confirm', async () => {
    bridge.set('operations:updateTarget', () => Promise.reject(new Error('the bridge went away')));
    await openTarget();

    const listsBefore = bridge.callsTo('operations:listTargets').length;
    const historiesBefore = bridge.callsTo('operations:listDiagnostics').length;
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(
      await screen.findByText(/did not come back, so whether it was applied is unknown/)
    ).toBeTruthy();

    await waitFor(() =>
      expect(bridge.callsTo('operations:listTargets').length).toBe(listsBefore + 1)
    );
    expect(bridge.callsTo('operations:listDiagnostics').length).toBe(historiesBefore + 1);

    // Reading is safe; repeating a write is not, and is never done.
    await settle();
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('keeps an uncertain write out of the panel that did not ask for it', async () => {
    bridge.set('operations:deleteTarget', () => Promise.reject(new Error('the bridge went away')));
    await openTarget();

    fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove the registration' }));

    expect(
      await screen.findByText(/did not come back, so whether it was applied is unknown/)
    ).toBeTruthy();
    expect(
      screen.getAllByText(/did not come back, so whether it was applied is unknown/)
    ).toHaveLength(1);

    // Not under Run, where it would read as a probe that failed, and not under
    // Register a target, where it would read as a reason a new target could
    // not be saved.
    expect(within(runPanel()).queryByText(/did not come back/)).toBeNull();
    expect(within(registerForm()).queryByText(/did not come back/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* A create that lands after the operator moved on                             */
/* -------------------------------------------------------------------------- */

describe('a create that lands late', () => {
  it('does not steal a selection made while it was in flight', async () => {
    const gate = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([beta]));
    bridge.set('operations:createTarget', () => gate.promise);

    renderOperations(<OperationsView />);
    await within(targetList()).findByText('Beta');

    fillForm({ name: 'Reports', environment: 'local', path: 'C:\\data\\reports.sqlite' });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);

    // The operator goes and looks at something else while it is in the air.
    fireEvent.click(within(targetList()).getByText('Beta'));
    await screen.findByText('Run a diagnostic');
    expect(within(runPanel()).getByText('C:\\data\\beta.sqlite')).toBeTruthy();

    await deliver(
      gate,
      ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' }))
    );

    // Registered, listed, and the form cleared — but the screen stays where
    // the operator put it rather than jumping to the new target.
    expect(within(targetList()).getByText('Reports')).toBeTruthy();
    expect(within(runPanel()).getByText('C:\\data\\beta.sqlite')).toBeTruthy();
    expect((within(registerForm()).getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('selects the new target when the operator has not moved on', async () => {
    bridge.set('operations:createTarget', () =>
      ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' }))
    );

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    fillForm({ name: 'Reports', environment: 'local', path: 'C:\\data\\reports.sqlite' });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    await screen.findByText('Run a diagnostic');
    expect(within(runPanel()).getByText('C:\\data\\reports.sqlite')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

describe('editing a target', () => {
  const openEditor = async (): Promise<HTMLElement> => {
    await openTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    return editorForm();
  };

  it('keeps Save disabled until something has actually changed', async () => {
    const form = await openEditor();
    const save = within(form).getByRole('button', { name: /Save changes/ });
    expect(disabled(save)).toBe(true);

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Renamed' } });
    expect(disabled(save)).toBe(false);

    // Typed back to what is stored: there is nothing to send again.
    fireEvent.change(within(form).getByLabelText('Name'), {
      target: { value: 'Reporting snapshot' }
    });
    expect(disabled(save)).toBe(true);
  });

  it('keeps Save disabled for a path the shared schema rejects, and calls nothing', async () => {
    const form = await openEditor();
    const save = within(form).getByRole('button', { name: /Save changes/ });

    for (const path of ['reports.sqlite', './reports.sqlite', '']) {
      fireEvent.change(within(form).getByLabelText('Database path'), {
        target: { value: path }
      });
      expect(disabled(save)).toBe(true);
    }

    fireEvent.submit(form);
    await settle();
    expect(bridge.callsTo('operations:updateTarget')).toEqual([]);
  });

  it('sends exactly the patch the shared schema produced, and closes on success', async () => {
    bridge.set('operations:updateTarget', () =>
      ok<'operations:updateTarget'>(makeTarget({ name: 'Renamed', environment: 'staging' }))
    );

    const form = await openEditor();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: '  Renamed  ' } });
    fireEvent.change(within(form).getByLabelText('Environment'), {
      target: { value: 'staging' }
    });
    fireEvent.click(within(form).getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1));
    expect(bridge.callsTo('operations:updateTarget')[0]?.input).toEqual({
      targetId: 'target-1',
      patch: {
        // Trimmed by the shared schema, not by the renderer.
        name: 'Renamed',
        environment: 'staging',
        config: {
          version: 1,
          adapterType: 'local_sqlite',
          databasePath: 'C:\\data\\reports.sqlite'
        }
      }
    });

    // No credential field exists to send.
    const payload = bridge.callsTo('operations:updateTarget')[0]?.input as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toMatch(/password|token|connectionString/i);

    // A success, and only a success, closes the editor.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save changes/ })).toBeNull()
    );
    expect(within(targetList()).getByText('Renamed')).toBeTruthy();
  });

  it('keeps the editor open and the draft intact when the backend refuses', async () => {
    bridge.set('operations:updateTarget', () =>
      fail('A local target named "Renamed" is already registered.')
    );

    const form = await openEditor();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: /Save changes/ }));

    expect(await screen.findByText(/already registered/)).toBeTruthy();
    expect(screen.getAllByText(/already registered/)).toHaveLength(1);

    // Still editing, with what the operator typed still in the field.
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Renamed');
    expect(within(registerForm()).queryByText(/already registered/)).toBeNull();

    // Save is available again — the refusal is not a permanent lock.
    expect(disabled(within(form).getByRole('button', { name: /Save changes/ }))).toBe(false);
  });

  it('writes nothing on Cancel, and restores what is stored', async () => {
    const form = await openEditor();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));

    await settle();
    expect(bridge.callsTo('operations:updateTarget')).toEqual([]);
    expect(screen.queryByRole('button', { name: /Save changes/ })).toBeNull();

    // Reopening shows the stored name, not the abandoned draft.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((within(editorForm()).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Reporting snapshot'
    );
  });
});
