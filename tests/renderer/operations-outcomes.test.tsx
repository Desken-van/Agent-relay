/**
 * @vitest-environment jsdom
 *
 * Which request an outcome belongs to, and what the screen says before it knows.
 *
 * A second review of the committed 7C-B code found four defects and confirmed
 * three more that the previous round had accepted but not yet corrected. They
 * share a shape with everything else in this phase: the screen drew a
 * conclusion that its evidence did not support, and stated it as fact.
 *
 * A row that matched the registration was read as proof the registration had
 * been made — although an identical target registered earlier is exactly what
 * makes the registry REFUSE a second one. A form was compared against the
 * schema's own spelling of the path in it, so an entry nobody had touched
 * looked edited. A confirming read still in flight was announced as a read that
 * had failed. A refresh gave no sign of working, so it was clicked again, and
 * again. And a registry write had no bound at all: a bridge that never answered
 * held the target for the life of the window.
 *
 * Every test drives the real controls and asserts on the actual IPC calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { OperationsView } from '../../src/renderer/src/components/OperationsView';
import {
  Sections,
  burstClick,
  deferred,
  deliver,
  installBridge,
  makeRun,
  makeTarget,
  ok,
  renderOperations,
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

const registerForm = (): HTMLElement =>
  screen.getByText('Register a target').closest('.card') as HTMLElement;

const historyCard = (): HTMLElement =>
  screen.getByText('History').closest('.card') as HTMLElement;

const disabled = (element: HTMLElement): boolean =>
  (element as HTMLButtonElement).disabled === true;

const fieldValue = (label: string): string =>
  (within(registerForm()).getByLabelText(label) as HTMLInputElement).value;

const fillRegistration = (values: {
  name?: string;
  environment?: string;
  path?: string;
}): void => {
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

/** The reply never arrives; the registry's own state is what has to answer. */
const loseTheCreateReply = (): void => {
  bridge.set('operations:createTarget', () => Promise.reject(new Error('the bridge went away')));
};

/* -------------------------------------------------------------------------- */
/* A matching row is not proof that this request created it                    */
/* -------------------------------------------------------------------------- */

describe('a registration the registry already held', () => {
  const existing = (): ReturnType<typeof makeTarget> =>
    makeTarget({
      id: 'target-existing',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\reports.sqlite'
      }
    });

  it('does not report a target that predates the request as this registration', async () => {
    // The identical target is already there, so the registry refuses a second
    // one — `UNIQUE (environment, name)`. The reply is then lost, and the
    // re-read finds the target that was there all along.
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([existing()]));
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await within(targetList()).findByText('Reports');

    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    expect(await screen.findByText(/was not registered by this submission/)).toBeTruthy();
    // The sentence this used to show instead, on the strength of a row it had
    // no reason to attribute to this request.
    expect(screen.queryByText(/It was registered after all/)).toBeNull();

    // The entry survives, because nothing was created and the operator decides
    // what to do about that.
    expect(fieldValue('Name')).toBe('Reports');
    expect(fieldValue('Database path')).toBe('C:\\data\\reports.sqlite');

    await settle();
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });

  it('still reports a registration that genuinely appeared', async () => {
    // The same flow with the row absent beforehand: this one really was created
    // by the request, and the screen must still say so.
    const other = makeTarget({ id: 'target-other', name: 'Something else' });
    const created = makeTarget({
      id: 'target-new',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\reports.sqlite'
      }
    });
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1
        ? ok<'operations:listTargets'>([other])
        : ok<'operations:listTargets'>([other, created]);
    });
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await within(targetList()).findByText('Something else');

    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    expect(await screen.findByText(/It was registered after all/)).toBeTruthy();
    expect(screen.queryByText(/was not registered by this submission/)).toBeNull();
    expect(fieldValue('Name')).toBe('');
  });

  it('does not attribute a target it registered a moment ago to the next request', async () => {
    // The registry the screen knows about is not only what a read returned: a
    // create the backend confirmed changed it too. Before that was folded in,
    // the target registered in step 2 was missing from the picture step 3 was
    // attributed against, so the read-back in step 5 looked like step 3 having
    // created it — and the screen announced a registration the registry had
    // refused. No Refresh anywhere in this test: that is the whole point.
    const created = makeTarget({
      id: 'target-new',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\reports.sqlite'
      }
    });
    let lists = 0;
    bridge.set('operations:listTargets', () => {
      lists += 1;
      // 1. Empty to begin with. Everything after is the read-back in step 5.
      return lists === 1
        ? ok<'operations:listTargets'>([])
        : ok<'operations:listTargets'>([created]);
    });
    let creates = 0;
    bridge.set('operations:createTarget', () => {
      creates += 1;
      // 2. The first registration succeeds. 4. The second loses its reply.
      return creates === 1
        ? ok<'operations:createTarget'>(created)
        : Promise.reject(new Error('the bridge went away'));
    });

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await within(targetList()).findByText('Reports');

    // A confirmed success clears the form, and nothing re-read the registry.
    expect(fieldValue('Name')).toBe('');
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);

    // 3. The same registration again, with no Refresh in between.
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    // 5. The read-back returns the target from step 2 — which is not evidence
    // that step 3 created anything.
    expect(await screen.findByText(/was not registered by this submission/)).toBeTruthy();
    expect(screen.queryByText(/It was registered after all/)).toBeNull();

    // The draft survives, because nothing was created by this submission.
    expect(fieldValue('Name')).toBe('Reports');
    expect(fieldValue('Database path')).toBe('C:\\data\\reports.sqlite');

    // Two submissions, two requests: the create is never sent again by itself.
    await settle();
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(2);
  });

  it('still separates a name taken by a different database from an identical one', async () => {
    // Also present before the request, but pointing somewhere else. Both facts
    // mean "this submission created nothing", and they are still different
    // things to be told: one says change the name, the other says there is
    // nothing to change.
    const elsewhere = makeTarget({
      id: 'target-existing',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\somewhere-else.sqlite'
      }
    });
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([elsewhere]));
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await within(targetList()).findByText('Reports');

    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    expect(
      await screen.findByText(/A different target already uses that name in that environment/)
    ).toBeTruthy();
    expect(screen.queryByText(/was not registered by this submission/)).toBeNull();
    expect(screen.queryByText(/It was registered after all/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* One path, spelled two ways                                                  */
/* -------------------------------------------------------------------------- */

describe('a draft whose path differs from the stored one only in spelling', () => {
  it('is recognised as untouched and cleared once the registration is confirmed', async () => {
    const created = makeTarget({
      id: 'target-new',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\reports.sqlite'
      }
    });
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1
        ? ok<'operations:listTargets'>([])
        : ok<'operations:listTargets'>([created]);
    });
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');

    // A trailing separator: the same path, spelled the way a paste out of a
    // file manager spells it. The schema normalises it on the way out, so the
    // form and the request disagree about nothing but punctuation.
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite\\'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    expect(await screen.findByText(/It was registered after all/)).toBeTruthy();

    // This is what a raw comparison got wrong: an entry nobody had touched was
    // read as the operator's own edit and left in front of a target that had in
    // fact been registered.
    expect(fieldValue('Name')).toBe('');
    expect(fieldValue('Database path')).toBe('');
  });

  it('still keeps a draft the operator has actually changed', async () => {
    const created = makeTarget({ id: 'target-new', name: 'Reports', environment: 'local' });
    const slowList = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1 ? ok<'operations:listTargets'>([]) : slowList.promise;
    });
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets')).toHaveLength(2));

    // Typed while the outcome was unknown, and not something this flow asked for.
    fillRegistration({ name: 'Reports renamed' });
    await deliver(slowList, ok<'operations:listTargets'>([created]));

    expect(fieldValue('Name')).toBe('Reports renamed');
  });
});

/* -------------------------------------------------------------------------- */
/* A read that is running has not failed                                       */
/* -------------------------------------------------------------------------- */

describe('while the registry is being re-read after a lost registration', () => {
  it('does not announce a failure it has no evidence for', async () => {
    const slowList = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1 ? ok<'operations:listTargets'>([]) : slowList.promise;
    });
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets')).toHaveLength(2));

    // The confirming read is still outstanding. This is where the form used to
    // state, as settled fact, that the registry could not be re-read.
    expect(screen.getByText(/The registry is being re-read now/)).toBeTruthy();
    expect(screen.queryByText(/could not be re-read/)).toBeNull();

    const button = within(registerForm()).getByRole('button', {
      name: /Re-reading the registry…/
    });
    expect(disabled(button)).toBe(true);

    // And answering it says what actually happened.
    await deliver(slowList, ok<'operations:listTargets'>([]));
    expect(await screen.findByText(/does not contain it/)).toBeTruthy();
  });

  it('starts one read however many times the operator asks', async () => {
    const slowList = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      if (reads === 1) return ok<'operations:listTargets'>([]);
      // The first confirming read fails, which is what puts the enabled
      // Re-read button in front of the operator in the first place.
      if (reads === 2) return Promise.reject(new Error('the bridge went away'));
      return slowList.promise;
    });
    loseTheCreateReply();

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    const button = await within(registerForm()).findByRole('button', {
      name: /^Re-read the registry$/
    });
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(2);

    // Five clicks in one tick. `disabled` cannot stop these — nothing has
    // re-rendered between them — so only a synchronous guard can.
    await burstClick(button, 5);
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(3);

    await deliver(slowList, ok<'operations:listTargets'>([]));
    expect(await screen.findByText(/does not contain it/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* A refresh that says it is working                                           */
/* -------------------------------------------------------------------------- */

describe('refreshing a history that is already on screen', () => {
  it('shows progress, keeps the rows, and asks once however many clicks', async () => {
    const slowHistory = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => {
      reads += 1;
      return reads === 1 ? ok<'operations:listDiagnostics'>([makeRun()]) : slowHistory.promise;
    });

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await screen.findByText(/Showing the last/);
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(1);

    fireEvent.click(within(historyCard()).getByRole('button', { name: /^Refresh$/ }));

    // The screen says it is working, instead of looking like a click that went
    // nowhere — which is what made the next two clicks seem worth making.
    expect(screen.getByText(/Re-reading the recorded history…/)).toBeTruthy();
    const busyRefresh = within(historyCard()).getByRole('button', { name: /Refreshing…/ });
    expect(disabled(busyRefresh)).toBe(true);

    // And they reach nothing: three clicks, one read, where every extra one
    // would have asked the same question of the same rows and been thrown away
    // by the sequence guard inside `loadHistory`.
    fireEvent.click(busyRefresh);
    fireEvent.click(busyRefresh);
    expect(bridge.callsTo('operations:listDiagnostics')).toHaveLength(2);
    // What is already known stays legible while the new read runs.
    expect(screen.getByText(/Showing the last/)).toBeTruthy();

    await deliver(slowHistory, ok<'operations:listDiagnostics'>([makeRun()]));
    expect(within(historyCard()).getByRole('button', { name: /^Refresh$/ })).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* A registry change that never answers                                        */
/* -------------------------------------------------------------------------- */

describe('a registry change that never answers', () => {
  it('stops waiting, stays blocked, and applies the answer if it does arrive', async () => {
    vi.useFakeTimers();
    try {
      const change = deferred<unknown>();
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:updateTarget', () => change.promise);

      renderOperations(<OperationsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Without a bound of its own, this is where the target stayed claimed —
      // and the `finally` that releases the claim never ran at all.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByText(/was not answered in time/)).toBeTruthy();
      expect(
        screen.getByText(/it may still be applied — sending it again would act on a state/)
      ).toBeTruthy();

      // Expiry is not permission to send it again: nothing here cancelled the
      // write, and a second one would act on a state nobody has confirmed.
      const again = screen.queryByRole('button', { name: /^Disable$/ });
      if (again !== null) await burstClick(again, 3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

      // The answer arrives late. It is still an answer, and applying it is what
      // turns an unknown outcome into a known one — exactly once.
      await act(async () => {
        change.resolve(ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByRole('button', { name: /^Enable$/ })).toBeTruthy();
      expect(screen.queryByText(/was not answered in time/)).toBeNull();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a refusal that arrives after it had given up waiting', async () => {
    vi.useFakeTimers();
    try {
      const change = deferred<unknown>();
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:deleteTarget', () => change.promise);

      renderOperations(<OperationsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Yes, remove the registration' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByText(/was not answered in time/)).toBeTruthy();

      // The registry answers late, and says no. The call that asked was handed
      // an uncertain outcome long ago, so this is the only place left to say it.
      await act(async () => {
        change.resolve({
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'This target has recorded diagnostics.',
            remediation: 'Disable it instead.'
          }
        });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText(/answered after all, and refused/)).toBeTruthy();
      expect(screen.getByText(/This target has recorded diagnostics\./)).toBeTruthy();
      expect(screen.queryByText(/was not answered in time/)).toBeNull();
      expect(bridge.callsTo('operations:deleteTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Coming back to the screen is not asking for anything                        */
/* -------------------------------------------------------------------------- */

describe('leaving the Operations screen and returning to it', () => {
  it('runs no diagnostic, with a target already selected', async () => {
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([makeRun()]));

    renderOperations(
      <Sections>
        <OperationsView />
      </Sections>
    );
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await screen.findByText(/Showing the last/);
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Operations' }));
    await settle();

    // The screen is mounted again, with the same target selected and its
    // history read again — none of which is a request to run anything.
    expect(await within(targetList()).findByText('Reporting snapshot')).toBeTruthy();
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(0);

    // Refreshing the history is not either.
    fireEvent.click(within(historyCard()).getByRole('button', { name: /^Refresh$/ }));
    await settle();
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(0);
  });
});
