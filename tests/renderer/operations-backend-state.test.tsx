/**
 * @vitest-environment jsdom
 *
 * What the Operations screen knows about work it did not start.
 *
 * The earlier async work made this renderer honest about its own requests. It
 * was still wrong about everything else: a run the backend was executing did
 * not block anything, because no local flag was set; an outcome nobody could
 * confirm released its claim on the way into the very read that was meant to
 * confirm it; and a first list response discarded because a write overtook it
 * left a handful of targets presented as the whole registry.
 *
 * Each test below is one of those, driven through the real controls. Conflict
 * is asserted at the IPC boundary as well as in the DOM: a `disabled` attribute
 * is a rendering fact, and the question here is whether a request was made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

const blockCard = (): HTMLElement | null => {
  const heading = screen.queryByText('This target is in use');
  return heading === null ? null : (heading.closest('.card') as HTMLElement);
};

const disabled = (element: HTMLElement): boolean =>
  (element as HTMLButtonElement).disabled === true;

/** A run the backend is still executing: no finish time, and no result. */
const runningRun = (overrides: Partial<ReturnType<typeof makeRun>> = {}) =>
  makeRun({
    id: 'diag-running',
    status: 'running',
    finishedAt: null,
    result: null,
    ...overrides
  });

const alpha = makeTarget({ id: 'target-a', name: 'Alpha' });
const beta = makeTarget({
  id: 'target-b',
  name: 'Beta',
  config: { version: 1, adapterType: 'local_sqlite', databasePath: 'C:\\data\\beta.sqlite' }
});

/** Render with these targets listed, and select the first. */
async function open(targets = [makeTarget()]): Promise<void> {
  bridge.set('operations:listTargets', () => ok<'operations:listTargets'>(targets));
  renderOperations(<OperationsView />);
  fireEvent.click(await within(targetList()).findByText(targets[0]!.name));
  await screen.findByText('Run a diagnostic');
}

/** Every action that must be refused while a target is in use. */
function expectAllActionsBlocked(): void {
  expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }))).toBe(
    true
  );
  for (const name of ['Edit', 'Disable', 'Remove registration']) {
    expect(disabled(screen.getByRole('button', { name }))).toBe(true);
  }
}

/* -------------------------------------------------------------------------- */
/* A run the backend is executing                                              */
/* -------------------------------------------------------------------------- */

describe('a run the backend is executing', () => {
  it('blocks every action on the target it belongs to, and says why', async () => {
    bridge.set('operations:listDiagnostics', (input) =>
      (input as { targetId: string }).targetId === 'target-a'
        ? ok<'operations:listDiagnostics'>([runningRun({ targetId: 'target-a' })])
        : ok<'operations:listDiagnostics'>([])
    );
    await open([alpha, beta]);

    // Nothing is in flight in this renderer. The block comes entirely from what
    // the recorded history says the backend is doing.
    expectAllActionsBlocked();

    const card = blockCard();
    expect(card).not.toBeNull();
    expect(within(card!).getByText(/A diagnostic is running on this target/)).toBeTruthy();
    expect(
      within(card!).getByText(/Running a diagnostic, editing, disabling and removing are/)
    ).toBeTruthy();
    // The one offered action is a read.
    expect(within(card!).getByRole('button', { name: /Refresh history/ })).toBeTruthy();

    // And the refusal is real, not just a disabled attribute: clicking Run
    // reaches no channel.
    await burstClick(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }));
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);
    await settle();
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);

    // The other target is untouched by any of this.
    fireEvent.click(within(targetList()).getByText('Beta'));
    await screen.findByText('Run a diagnostic');
    expect(blockCard()).toBeNull();
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(false);
    expect(disabled(screen.getByRole('button', { name: 'Edit' }))).toBe(false);
  });

  it('stays blocked after a diagnostic whose reply was lost', async () => {
    bridge.set('operations:runDiagnostic', () => Promise.reject(new Error('the bridge went away')));
    // Nothing is recorded when the screen opens; the run the backend started
    // appears only in the re-read that follows the lost reply.
    let reads = 0;
    bridge.set('operations:listDiagnostics', () => {
      reads += 1;
      return reads === 1
        ? ok<'operations:listDiagnostics'>([])
        : ok<'operations:listDiagnostics'>([runningRun()]);
    });
    await open();

    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
    await waitFor(() => expect(blockCard()).not.toBeNull());

    // The local flag has been cleared — the request is over. What keeps this
    // target blocked is the backend's own record.
    expectAllActionsBlocked();
    expect(screen.getByText(/The request did not come back/)).toBeTruthy();
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

    // Nothing was retried on its own.
    await settle();
    expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
  });

  it('releases the block when a manual refresh shows the run finished', async () => {
    let page: ReturnType<typeof makeRun>[] = [runningRun()];
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>(page));
    await open();
    await waitFor(() => expect(blockCard()).not.toBeNull());

    page = [makeRun({ id: 'diag-running', status: 'succeeded' })];
    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));

    await waitFor(() => expect(blockCard()).toBeNull());
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(false);
    expect(disabled(screen.getByRole('button', { name: 'Edit' }))).toBe(false);
  });

  it('keeps the block when the refresh itself fails, and ignores a stale page afterwards', async () => {
    let answer: () => unknown = () => ok<'operations:listDiagnostics'>([runningRun()]);
    bridge.set('operations:listDiagnostics', () => answer());
    await open();
    await waitFor(() => expect(blockCard()).not.toBeNull());

    // A failed read proves nothing, least of all completion.
    answer = () => fail('The history could not be read.', 'INTERNAL');
    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
    await settle();
    expect(blockCard()).not.toBeNull();
    expectAllActionsBlocked();

    // Now the run is confirmed finished.
    answer = () => ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-running' })]);
    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
    await waitFor(() => expect(blockCard()).toBeNull());

    // A later page that still describes it as running is stale evidence about a
    // run already proven terminal, and must not put the block back.
    answer = () => ok<'operations:listDiagnostics'>([runningRun()]);
    fireEvent.click(within(historyCard()).getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(blockCard()).toBeNull();
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(false);
  });

  it('does not treat a page that merely omits the run as proof it finished', async () => {
    const pages: unknown[] = [];
    bridge.set('operations:listDiagnostics', (input) => {
      const { limit } = input as { limit: number };
      pages.push(limit);
      // The first read shows the run; everything after it — including the
      // deepest search the channel allows — has scrolled past it.
      return pages.length === 1
        ? ok<'operations:listDiagnostics'>([runningRun()])
        : ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-other' })]);
    });
    await open();
    await waitFor(() => expect(blockCard()).not.toBeNull());

    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
    await settle();

    // Still blocked, and now honest about why.
    expect(blockCard()).not.toBeNull();
    expect(within(blockCard()!).getByText(/Whether it finished is unknown/)).toBeTruthy();
    expectAllActionsBlocked();

    // It looked as far back as the channel permits before saying so.
    expect(pages).toContain(500);

    // And because that search failed, the operator is given a way out that does
    // not pretend to know the answer.
    const release = within(blockCard()!).getByRole('button', { name: 'Stop tracking this run' });
    fireEvent.click(release);
    await waitFor(() => expect(blockCard()).toBeNull());
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(false);
  });

  it('does not call a returned run finished when the run says it is running', async () => {
    // The domain permits a persisted run to still be `running`.
    bridge.set('operations:runDiagnostic', () => ok<'operations:runDiagnostic'>(runningRun()));
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    await open();

    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
    await waitFor(() => expect(blockCard()).not.toBeNull());
    expectAllActionsBlocked();
  });
});

/* -------------------------------------------------------------------------- */
/* An outcome nobody has confirmed                                             */
/* -------------------------------------------------------------------------- */

describe('an outcome nobody has confirmed', () => {
  it('holds the target while the confirming read is still in the air', async () => {
    const slowList = deferred<unknown>();
    let listed = 0;
    bridge.set('operations:listTargets', () => {
      listed += 1;
      return listed === 1 ? ok<'operations:listTargets'>([alpha, beta]) : slowList.promise;
    });
    bridge.set('operations:updateTarget', () => Promise.reject(new Error('the bridge went away')));
    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Alpha'));
    await screen.findByText('Run a diagnostic');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets').length).toBe(2));

    // The write is over; its confirmation is not. Releasing here — as this once
    // did — let a probe start against a target whose path and environment are
    // still unconfirmed.
    expectAllActionsBlocked();
    await burstClick(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }));
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);

    // Another target is not caught up in it.
    fireEvent.click(within(targetList()).getByText('Beta'));
    await screen.findByText('Run a diagnostic');
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(false);

    await deliver(slowList, ok<'operations:listTargets'>([alpha, beta]));
    fireEvent.click(within(targetList()).getByText('Alpha'));
    await screen.findByText('Run a diagnostic');
    expect(blockCard()).toBeNull();
  });

  it('survives navigating away and back, and never repeats the write', async () => {
    const slowList = deferred<unknown>();
    let listed = 0;
    bridge.set('operations:listTargets', () => {
      listed += 1;
      return listed === 1 ? ok<'operations:listTargets'>([makeTarget()]) : slowList.promise;
    });
    bridge.set('operations:updateTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(
      <Sections>
        <OperationsView />
      </Sections>
    );
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets').length).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Operations' }));
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));

    await screen.findByText('This target is in use');
    expectAllActionsBlocked();
    await burstClick(screen.getByRole('button', { name: 'Disable' }));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    await deliver(slowList, ok<'operations:listTargets'>([makeTarget()]));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('says plainly when the confirming read also failed, and offers only a re-read', async () => {
    let listed = 0;
    bridge.set('operations:listTargets', () => {
      listed += 1;
      return listed === 1
        ? ok<'operations:listTargets'>([makeTarget()])
        : fail('The registry is unavailable.', 'INTERNAL');
    });
    bridge.set('operations:updateTarget', () => Promise.reject(new Error('the bridge went away')));
    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await screen.findByText('Run a diagnostic');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByText('This target is in use');

    const card = blockCard()!;
    expect(within(card).getByText(/could not be re-read, so the current state is still unknown/))
      .toBeTruthy();
    expectAllActionsBlocked();

    // The offered recovery is the read, and nothing but the read.
    expect(within(card).queryByRole('button', { name: /Refresh history/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /Re-read the registry/ }));
    await settle();
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

    // A successful re-read is what clears it.
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Re-read the registry/ }));
    await waitFor(() => expect(blockCard()).toBeNull());
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
  });

  it('does not hold the target for ever when the confirming read never settles', async () => {
    vi.useFakeTimers();
    try {
      let listed = 0;
      bridge.set('operations:listTargets', () => {
        listed += 1;
        return listed === 1
          ? ok<'operations:listTargets'>([makeTarget()])
          : new Promise(() => undefined); // never settles, as a wedged bridge does
      });
      bridge.set('operations:updateTarget', () =>
        Promise.reject(new Error('the bridge went away'))
      );

      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      renderOperations(<OperationsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Waiting, with no way for the operator to learn anything.
      expect(screen.getByText('This target is in use')).toBeTruthy();

      // The bridge has no timeout of its own, so this is the only thing that
      // stops the spinner. The target stays blocked — nothing was confirmed —
      // but the block is now a stated uncertainty with an action attached.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const card = blockCard()!;
      expect(within(card).getByText(/could not be re-read, so the current state is still unknown/))
        .toBeTruthy();
      expect(within(card).getByRole('button', { name: /Re-read the registry/ })).toBeTruthy();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second registration while the first is unresolved, across a remount', async () => {
    let listed = 0;
    const slowList = deferred<unknown>();
    bridge.set('operations:listTargets', () => {
      listed += 1;
      return listed === 1 ? ok<'operations:listTargets'>([]) : slowList.promise;
    });
    bridge.set('operations:createTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(
      <Sections>
        <OperationsView />
      </Sections>
    );
    await screen.findByText('No targets registered');

    const fill = (): void => {
      const form = registerForm();
      fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Reports' } });
      fireEvent.change(within(form).getByLabelText('Environment'), {
        target: { value: 'local' }
      });
      fireEvent.change(within(form).getByLabelText('Database path'), {
        target: { value: 'C:\\data\\reports.sqlite' }
      });
    };

    fill();
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets').length).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Operations' }));

    // The draft is still there — it was never the form's to lose — and Save is
    // refused for as long as the first attempt is unresolved.
    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
    expect((within(form).getByLabelText('Database path') as HTMLInputElement).value).toBe(
      'C:\\data\\reports.sqlite'
    );
    expect(within(form).getByText(/The last registration was not confirmed/)).toBeTruthy();

    await burstClick(screen.getByRole('button', { name: /Register target/ }));
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);

    await deliver(slowList, ok<'operations:listTargets'>([]));
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* A list that is not the whole registry                                       */
/* -------------------------------------------------------------------------- */

describe('a list that is not the whole registry', () => {
  it('will not register a target before the registry has been read once', async () => {
    const first = deferred<unknown>();
    bridge.set('operations:listTargets', () => first.promise);

    renderOperations(<OperationsView />);
    await settle();

    const form = registerForm();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Reports' } });
    fireEvent.change(within(form).getByLabelText('Environment'), { target: { value: 'local' } });
    fireEvent.change(within(form).getByLabelText('Database path'), {
      target: { value: 'C:\\data\\reports.sqlite' }
    });

    // This is the race at its source: a create that lands while the first list
    // is still pending discards that list, and what is left is the one target
    // the create added — presented as the registry.
    expect(disabled(screen.getByRole('button', { name: /Register target/ }))).toBe(true);
    expect(within(form).getByText(/registry has not been read in full yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await settle();
    expect(bridge.callsTo('operations:createTarget')).toEqual([]);

    await deliver(first, ok<'operations:listTargets'>([makeTarget()]));
    expect(disabled(screen.getByRole('button', { name: /Register target/ }))).toBe(false);
    expect(screen.queryByText(/registry has not been read in full yet/)).toBeNull();
  });

  it('does not mark a complete list partial when a later Refresh is overtaken', async () => {
    // Once the registry has been read in full, a discarded response leaves a
    // list that is slightly stale, not one that is missing registrations —
    // so completeness must not regress, and the write's own result stands.
    const stale = deferred<unknown>();
    let listed = 0;
    bridge.set('operations:listTargets', () => {
      listed += 1;
      return listed === 1 ? ok<'operations:listTargets'>([alpha, beta]) : stale.promise;
    });
    bridge.set('operations:updateTarget', () =>
      ok<'operations:updateTarget'>({ ...alpha, enabled: false })
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Alpha'));
    await screen.findByText('Run a diagnostic');

    fireEvent.click(within(targetList()).getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByRole('button', { name: 'Enable' });

    await deliver(stale, ok<'operations:listTargets'>([alpha, beta]));

    // Both registrations are still listed, the write stands, and nothing
    // claims the list has become partial.
    expect(within(targetList()).getByText('Alpha')).toBeTruthy();
    expect(within(targetList()).getByText('Beta')).toBeTruthy();
    expect(within(targetList()).getByText('Disabled')).toBeTruthy();
    expect(screen.queryByText(/This list is incomplete/)).toBeNull();
    // Registration is not being held back: the empty form's own Save is
    // disabled because there is nothing typed in it, not because the registry
    // is considered unread.
    expect(screen.queryByText(/registry has not been read in full yet/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Guards and screen must agree                                                */
/* -------------------------------------------------------------------------- */

describe('a guard and the screen that disagree', () => {
  it('lets the operator run again once the history has answered', async () => {
    let attempts = 0;
    bridge.set('operations:runDiagnostic', () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('the bridge went away'))
        : ok<'operations:runDiagnostic'>(makeRun({ id: 'diag-second' }));
    });
    // The read that follows the lost reply settles the question: nothing is
    // running, so the target is free again.
    bridge.set('operations:listDiagnostics', () =>
      ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-first' })])
    );
    await open();

    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
    expect(await screen.findByText(/The request did not come back/)).toBeTruthy();

    // The screen now says the target is free.
    await waitFor(() => expect(blockCard()).toBeNull());
    const again = within(runPanel()).getByRole('button', { name: /Run diagnostic/ });
    expect(disabled(again)).toBe(false);

    // So the click has to reach the channel. An enabled button in front of a
    // guard that is still closed is worse than a disabled one: it looks like it
    // worked and does nothing whatsoever. Asserted on the second IPC call, not
    // on the attribute, because the attribute was never the thing that was wrong.
    fireEvent.click(again);
    await waitFor(() =>
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(2)
    );

    // And the message about the lost reply is gone, because this run replaced it.
    await waitFor(() => expect(screen.queryByText(/The request did not come back/)).toBeNull());
  });

  it('does not let a superseded deep search re-block a released target', async () => {
    const deep = deferred<unknown>();
    const limits: number[] = [];
    bridge.set('operations:listDiagnostics', (input) => {
      const { limit } = input as { limit: number };
      limits.push(limit);
      // The search to the channel's ceiling is the slow one, and it is the one
      // that gets overtaken.
      if (limit === 500) return deep.promise;
      const page = limits.filter((entry) => entry !== 500).length;
      if (page === 1) return ok<'operations:listDiagnostics'>([runningRun()]);
      // The first refresh has scrolled past the run, which is what starts the
      // deep search; the second finds it, finished.
      return page === 2
        ? ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-other' })])
        : ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-running' })]);
    });

    await open();
    await waitFor(() => expect(blockCard()).not.toBeNull());

    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
    await waitFor(() => expect(limits).toContain(500));

    // A second refresh answers the question outright while that search is still
    // in the air, and releases the target.
    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
    await waitFor(() => expect(blockCard()).toBeNull());

    // The superseded search now returns, knowing nothing. It must not put back
    // a block that newer evidence has already lifted.
    await deliver(deep, ok<'operations:listDiagnostics'>([]));

    expect(blockCard()).toBeNull();
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(
      false
    );

    // And the release is real, not just painted: a run started now reaches the
    // channel.
    bridge.set('operations:runDiagnostic', () => ok<'operations:runDiagnostic'>(makeRun()));
    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
    await waitFor(() => expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1));
  });
});
