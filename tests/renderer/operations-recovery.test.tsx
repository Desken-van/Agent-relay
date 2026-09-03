/**
 * @vitest-environment jsdom
 *
 * Recovery paths, and the things that must not depend on anything else.
 *
 * A review of the committed 7C-B code found six defects that share a shape: the
 * screen decided something was over before the evidence for it had arrived, or
 * made one part of the application wait on another that had nothing to do with
 * it. A hung development bootstrap held a section that needs no project. A list
 * read was treated as a whole confirmation while the history read behind it was
 * still outstanding. An unconfirmed registration was cleared without ever being
 * resolved against the registry. A probe request had no bound at all.
 *
 * Each test below drives the real controls and asserts on the actual IPC calls,
 * because every one of these defects looked fine on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
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
  renderApp,
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

const runningRun = () =>
  makeRun({ id: 'diag-running', status: 'running', finishedAt: null, result: null });

/** A promise that never settles, as a wedged bridge produces. */
const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

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

/* -------------------------------------------------------------------------- */
/* Operations does not wait for the development workflow                       */
/* -------------------------------------------------------------------------- */

describe('a development bootstrap that never finishes', () => {
  it('does not keep the Operations section off screen', async () => {
    // The store's initial load awaits both of these together and clears its
    // `loading` flag only afterwards. One that never answers used to hold every
    // section behind "Loading…", including the one an operator would open to
    // look at a database while the rest of the application was unwell.
    bridge = installBridge({
      'projects:list': () => neverSettles(),
      'settings:get': () => neverSettles(),
      'operations:listTargets': () => ok<'operations:listTargets'>([makeTarget()])
    });

    renderApp(<App />);

    const operations = await screen.findByRole('button', { name: /Operations/ });
    expect(disabled(operations)).toBe(false);
    fireEvent.click(operations);

    // The section renders, and it reached its own channel — this is not a
    // placeholder that happens to look right.
    expect(await within(targetList()).findByText('Reporting snapshot')).toBeTruthy();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);

    // The development sections are still legitimately waiting; that is their
    // business, and it is no longer Operations' business.
    await settle();
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Manual recovery holds until every read it needs has answered                */
/* -------------------------------------------------------------------------- */

describe('a manual re-read of the registry', () => {
  /** An update whose reply is lost, with the automatic confirmation failing. */
  async function unconfirmedUpdate(): Promise<void> {
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
  }

  it('keeps the target held while a fast list waits on a slow history', async () => {
    await unconfirmedUpdate();

    const slowHistory = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => slowHistory.promise);

    fireEvent.click(within(blockCard()!).getByRole('button', { name: /Re-read the registry/ }));

    // The list has answered and the history has not. That is not a completed
    // confirmation, and the target must not be released on the strength of it.
    await waitFor(() =>
      expect(bridge.callsTo('operations:listTargets').length).toBeGreaterThan(2)
    );
    await settle();
    expect(blockCard()).not.toBeNull();

    const updatesSoFar = bridge.callsTo('operations:updateTarget').length;
    await burstClick(screen.getByRole('button', { name: 'Disable' }));
    await burstClick(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }));
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(updatesSoFar);
    expect(bridge.callsTo('operations:runDiagnostic')).toEqual([]);

    // Both reads have now answered, so the recovery is genuinely over.
    await deliver(slowHistory, ok<'operations:listDiagnostics'>([]));
    await waitFor(() => expect(blockCard()).toBeNull());
    expect(disabled(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }))).toBe(
      false
    );
  });

  it('does not start a second recovery while one is running', async () => {
    await unconfirmedUpdate();

    const slowHistory = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => slowHistory.promise);

    const before = bridge.callsTo('operations:listTargets').length;
    await burstClick(within(blockCard()!).getByRole('button', { name: /Re-read the registry/ }));
    await settle();

    // Three clicks, one recovery.
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(before + 1);

    await deliver(slowHistory, ok<'operations:listDiagnostics'>([]));
  });
});

/* -------------------------------------------------------------------------- */
/* An unconfirmed registration is resolved against the registry                */
/* -------------------------------------------------------------------------- */

describe('a registration whose reply was lost', () => {
  /** Lose the create reply; answer the confirming read with `listed`. */
  async function lostCreate(listed: ReturnType<typeof makeTarget>[]): Promise<void> {
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1
        ? ok<'operations:listTargets'>([])
        : ok<'operations:listTargets'>(listed);
    });
    bridge.set('operations:createTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
  }

  it('says it was registered when the re-read finds it, and clears the form', async () => {
    const created = makeTarget({ id: 'target-new', name: 'Reports', environment: 'local' });
    await lostCreate([created]);

    expect(await screen.findByText(/It was registered after all/)).toBeTruthy();

    // The form is cleared only because it still held exactly what was sent.
    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('');
    // And the create was never sent a second time.
    await settle();
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });

  it('says it was not registered when a complete re-read does not contain it', async () => {
    await lostCreate([makeTarget({ id: 'target-other', name: 'Something else' })]);

    expect(
      await screen.findByText(/registry has been read in full and does not contain it/)
    ).toBeTruthy();

    // The entry survives, so the operator can submit it themselves.
    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
    expect((within(form).getByLabelText('Database path') as HTMLInputElement).value).toBe(
      'C:\\data\\reports.sqlite'
    );
    await settle();
    expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
  });

  it('separates a name already taken from a registration that went through', async () => {
    // Same name and environment, a different database: this is somebody else's
    // target, so the create was refused rather than applied.
    const other = makeTarget({
      id: 'target-other',
      name: 'Reports',
      environment: 'local',
      config: {
        version: 1,
        adapterType: 'local_sqlite',
        databasePath: 'C:\\data\\somewhere-else.sqlite'
      }
    });
    await lostCreate([other]);

    expect(
      await screen.findByText(/A different target already uses that name in that environment/)
    ).toBeTruthy();
    expect(screen.queryByText(/It was registered after all/)).toBeNull();

    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
  });

  it('does not discard edits made while the outcome was unknown', async () => {
    const slowList = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1 ? ok<'operations:listTargets'>([]) : slowList.promise;
    });
    bridge.set('operations:createTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration({
      name: 'Reports',
      environment: 'local',
      path: 'C:\\data\\reports.sqlite'
    });
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets')).toHaveLength(2));

    // The operator carries on typing while the outcome is unknown.
    fillRegistration({ name: 'Reports renamed' });

    await deliver(
      slowList,
      ok<'operations:listTargets'>([
        makeTarget({ id: 'target-new', name: 'Reports', environment: 'local' })
      ])
    );

    // The original submission did land, and the screen says so — but what the
    // operator typed since is theirs, and clearing it was never asked for.
    expect(screen.getByText(/It was registered after all/)).toBeTruthy();
    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Reports renamed'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A probe request that goes unanswered                                        */
/* -------------------------------------------------------------------------- */

describe('a diagnostic that never answers', () => {
  it('stops waiting, stays blocked, and applies the answer if it does arrive', async () => {
    vi.useFakeTimers();
    try {
      const probe = deferred<unknown>();
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:runDiagnostic', () => probe.promise);

      renderOperations(<OperationsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: /Running…/ })).toBeTruthy();

      // Without a bound of its own, this is where the screen said "Running…"
      // for the life of the window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText(/The request did not come back/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Running…/ })).toBeNull();

      // Expiry is not permission to start it again: nothing here cancelled the
      // backend operation, so a second probe would be a second probe.
      await burstClick(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

      // The probe finishes late. Its answer is still an answer, and applying it
      // is what turns an unknown outcome into a known one.
      const finished = makeRun({ id: 'diag-late', status: 'succeeded' });
      await act(async () => {
        probe.resolve(ok<'operations:runDiagnostic'>(finished));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('Latest result')).toBeTruthy();
      expect(screen.queryByText(/The request did not come back/)).toBeNull();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Refreshing says that it is working                                          */
/* -------------------------------------------------------------------------- */

describe('refreshing a list that is already on screen', () => {
  it('shows progress without throwing away what is displayed', async () => {
    const slow = deferred<unknown>();
    let reads = 0;
    bridge.set('operations:listTargets', () => {
      reads += 1;
      return reads === 1 ? ok<'operations:listTargets'>([makeTarget()]) : slow.promise;
    });

    renderOperations(<OperationsView />);
    await within(targetList()).findByText('Reporting snapshot');

    fireEvent.click(within(targetList()).getByRole('button', { name: 'Refresh' }));

    const refreshing = await within(targetList()).findByRole('button', { name: /Refreshing…/ });
    expect(disabled(refreshing)).toBe(true);
    // The list the operator was reading is still there.
    expect(within(targetList()).getByText('Reporting snapshot')).toBeTruthy();

    // And a click that looks unanswered cannot pile a second read on top.
    await burstClick(refreshing);
    expect(bridge.callsTo('operations:listTargets')).toHaveLength(2);

    await deliver(slow, ok<'operations:listTargets'>([makeTarget()]));
    expect(within(targetList()).getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* One deep search per run, however fast the clicking                          */
/* -------------------------------------------------------------------------- */

describe('repeated refreshes while a run has scrolled off the page', () => {
  it('does not start a second deep search for the same run', async () => {
    const deep = deferred<unknown>();
    const limits: number[] = [];
    let pages = 0;
    bridge.set('operations:listDiagnostics', (input) => {
      const { limit } = input as { limit: number };
      limits.push(limit);
      if (limit === 500) return deep.promise;
      pages += 1;
      // The first read establishes the running run; every page after it has
      // scrolled past, which is what triggers the search.
      return pages === 1
        ? ok<'operations:listDiagnostics'>([runningRun()])
        : ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-other' })]);
    });
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await waitFor(() => expect(blockCard()).not.toBeNull());

    // Deliberately NOT one burst: clicks in a single tick are collapsed by the
    // sequence guard before they ever reach the search, so a burst would prove
    // nothing. Each of these lets its own 25-row page come back — which is what
    // puts a later refresh into the deep-search branch while the first search
    // is still in flight, and that is the case that used to duplicate it.
    for (let click = 0; click < 4; click += 1) {
      fireEvent.click(
        within(blockCard()!).getByRole('button', { name: /Refresh history/ })
      );
      await settle(2);
    }

    // Four refreshes, one 500-row read: the rest ask the same question of the
    // same run and would deserialise the same rows to be thrown away.
    expect(limits.filter((entry) => entry === 500)).toHaveLength(1);
    expect(blockCard()).not.toBeNull();

    await deliver(deep, ok<'operations:listDiagnostics'>([]));

    // That one search was overtaken by the refreshes that followed it, so it
    // draws no conclusion — the R3 rule — and the target stays blocked rather
    // than being released on evidence that is no longer current. What the
    // search concludes when it IS current is covered separately.
    expect(blockCard()).not.toBeNull();
    expect(limits.filter((entry) => entry === 500)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* A request that is still out there                                           */
/* -------------------------------------------------------------------------- */

describe('a diagnostic request that has not answered', () => {
  /**
   * Open a target and start a probe whose reply never comes, then let the
   * renderer's patience run out.
   *
   * Returns the deferred request, so a test can decide when — and whether — it
   * answers. Fake timers throughout: the expiry is a real timeout, and a test
   * that waited for it in wall-clock time would take a minute.
   */
  async function probeThatExpires(
    history: () => unknown = () => ok<'operations:listDiagnostics'>([])
  ): Promise<{ request: ReturnType<typeof deferred<unknown>> }> {
    const request = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', history);
    bridge.set('operations:runDiagnostic', () => request.promise);

    renderOperations(<OperationsView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(within(runPanel()).getByRole('button', { name: /Run diagnostic/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    return { request };
  }

  it('is not released by a manual re-read that proves nothing about it', async () => {
    vi.useFakeTimers();
    try {
      await probeThatExpires();
      expect(screen.getByText(/The request did not come back/)).toBeTruthy();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

      // A successful list and an empty history. Neither says anything about a
      // request that has not answered: the probe was never cancelled, so an
      // absent record is as consistent with "still running" as with "finished".
      fireEvent.click(within(blockCard()!).getByRole('button', { name: /Re-read the registry/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(blockCard()).not.toBeNull();
      expect(
        within(blockCard()!).getByText(/It was not cancelled, so it may still be running/)
      ).toBeTruthy();

      // The assertion that matters is the channel, not the attribute: a second
      // Run here would be a second probe against the same target.
      await burstClick(within(runPanel()).getByRole('button', { name: /Run diagnostic|Waiting/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not lose an answer that arrives while the history is still loading', async () => {
    vi.useFakeTimers();
    try {
      // The history read that follows the expiry never settles, which is what
      // used to swallow the reply: the handler read `runningRef`, and that stays
      // set until the history read is done, so a real answer looked like one
      // arriving before the wait had expired and was dropped on the floor.
      const history = deferred<unknown>();
      const { request } = await probeThatExpires(() => history.promise);

      expect(screen.getByText(/The request did not come back/)).toBeTruthy();

      const finished = makeRun({ id: 'diag-late', status: 'succeeded' });
      await act(async () => {
        request.resolve(ok<'operations:runDiagnostic'>(finished));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Applied, while the history read is still outstanding.
      expect(screen.getByText('Latest result')).toBeTruthy();
      expect(screen.queryByText(/The request did not come back/)).toBeNull();
      expect(blockCard()).toBeNull();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);

      // The history read finishing later changes none of it, and starts nothing.
      await act(async () => {
        history.resolve(ok<'operations:listDiagnostics'>([]));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Latest result')).toBeTruthy();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops calling a refused request outstanding once it has answered', async () => {
    vi.useFakeTimers();
    try {
      const history = deferred<unknown>();
      const { request } = await probeThatExpires(() => history.promise);

      // The backend answers late, and says no. That is an answer: whatever else
      // is true, this request is no longer in flight, and a state still saying
      // it is would hold the target on a question already settled.
      await act(async () => {
        request.resolve(fail('That target is disabled.'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText(/That target is disabled/)).toBeTruthy();
      expect(screen.queryByText(/It was not cancelled, so it may still be running/)).toBeNull();
      expect(blockCard()).toBeNull();

      // Answered, and not retried.
      await act(async () => {
        history.resolve(ok<'operations:listDiagnostics'>([]));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a late transport failure as finished but unknown, not as still waiting', async () => {
    vi.useFakeTimers();
    try {
      const history = deferred<unknown>();
      const { request } = await probeThatExpires(() => history.promise);

      await act(async () => {
        request.reject(new Error('the bridge went away'));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Still unknown — nothing here proves the probe did or did not run — but
      // the request is over, so the recorded history can settle this one.
      // Scoped to the run panel: while the history read is still outstanding the
      // block card states the same doubt, which is correct and not what this
      // test is about.
      expect(within(runPanel()).getByText(/The request did not come back/)).toBeTruthy();
      expect(screen.queryByText(/It was not cancelled, so it may still be running/)).toBeNull();

      await act(async () => {
        history.resolve(ok<'operations:listDiagnostics'>([]));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(blockCard()).toBeNull();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
