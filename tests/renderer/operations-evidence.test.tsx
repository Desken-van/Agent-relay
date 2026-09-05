/**
 * @vitest-environment jsdom
 *
 * What counts as evidence, what a wait means, and who is allowed to write.
 *
 * An external review of the committed branch found twelve defects that share
 * one shape: the screen accepted something weaker than evidence and acted as
 * though it were proof. A *superseded* list read answered with a flag that only
 * meant "a complete list existed at some point", and reconciliation took it as
 * its own confirmation. Reads had no bound at all, so a promise that never
 * settled left a spinner, or a target blocked with the release never offered.
 * Registration had no bound either — the one registry write that did not — and
 * no arbitration with edits and removals, so two writes could decide each
 * other's outcome through `(environment, name)`. And after an unknown update or
 * delete, a read that merely *succeeded* cleared the doubt without ever
 * checking whether the change had taken effect.
 *
 * Each test below drives the real controls, resolves its own promises, and
 * asserts on IPC calls and rendered text rather than on `disabled`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { OperationsView } from '../../src/renderer/src/components/OperationsView';
import {
  deferred,
  deliver,
  fail,
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

const blockCard = (): HTMLElement | null => {
  const heading = screen.queryByText('This target is in use');
  return heading === null ? null : (heading.closest('.card') as HTMLElement);
};

const disabled = (element: HTMLElement): boolean =>
  (element as HTMLButtonElement).disabled === true;

/** A promise that never settles, as a wedged bridge produces. */
const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

const tick = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

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

const registration = {
  name: 'Reports',
  environment: 'local',
  path: 'C:\\data\\reports.sqlite'
};

/* -------------------------------------------------------------------------- */
/* A read that never answers                                                   */
/* -------------------------------------------------------------------------- */

describe('a registry list that never answers', () => {
  it('stops calling itself loading and offers a way to ask again', async () => {
    vi.useFakeTimers();
    try {
      bridge.set('operations:listTargets', () => neverSettles());
      renderOperations(<OperationsView />);
      await tick();

      // Before the bound existed, this is where the screen stayed for the life
      // of the window: a spinner, no error, and registration disabled because
      // the registry had never been read in full.
      expect(screen.getByText(/Loading targets…/)).toBeTruthy();

      await tick(10_000);

      expect(screen.getByText(/The registry did not answer in time/)).toBeTruthy();
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(bridge.callsTo('operations:listTargets')).toHaveLength(1);

      // A timeout is not an answer, so the only way on is one the operator asks
      // for — and it really does ask again.
      fireEvent.click(retry);
      await tick();
      expect(bridge.callsTo('operations:listTargets')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a deep search that never answers', () => {
  it('still offers the operator the explicit release', async () => {
    vi.useFakeTimers();
    const runningRun = makeRun({ id: 'diag-running', status: 'running', finishedAt: null, result: null });
    try {
      let page = 0;
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
      bridge.set('operations:listDiagnostics', (input) => {
        const { limit } = input as { limit: number };
        // The search to the channel's ceiling is the one that hangs.
        if (limit === 500) return neverSettles();
        page += 1;
        // First page: a run the backend is executing. Second: it has scrolled
        // past, which is what starts the deep search.
        return page === 1
          ? ok<'operations:listDiagnostics'>([runningRun])
          : ok<'operations:listDiagnostics'>([makeRun({ id: 'diag-other' })]);
      });

      renderOperations(<OperationsView />);
      await tick();
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await tick();
      await tick();
      expect(blockCard()).not.toBeNull();

      fireEvent.click(within(blockCard()!).getByRole('button', { name: /Refresh history/ }));
      await tick();

      // While the search hangs, the run is neither found nor given up on. This
      // is where the target stayed blocked with no way out at all.
      expect(
        within(blockCard()!).queryByRole('button', { name: /Stop tracking this run/ })
      ).toBeNull();

      await tick(10_000);

      // The search did not answer, so it proves nothing — and precisely because
      // it proves nothing, the operator is given the explicit release.
      expect(
        within(blockCard()!).getByRole('button', { name: /Stop tracking this run/ })
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A registration that never answers                                           */
/* -------------------------------------------------------------------------- */

describe('a registration that never answers', () => {
  it('stops waiting, keeps the draft, and never sends it again', async () => {
    vi.useFakeTimers();
    try {
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([]));
      bridge.set('operations:createTarget', () => neverSettles());

      renderOperations(<OperationsView />);
      await tick();
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick();

      // The bound update and delete already had, and this one did not.
      expect(screen.getByRole('button', { name: /Saving…/ })).toBeTruthy();

      await tick(30_000);

      expect(screen.getByText(/was not answered in time/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Saving…/ })).toBeNull();

      // The entry survives, and expiry is not permission to send it again.
      const form = registerForm();
      expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Reports');
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick();
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a late success exactly once, and keeps a newer draft', async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();
    try {
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([]));
      bridge.set('operations:createTarget', () => create.promise);

      renderOperations(<OperationsView />);
      await tick();
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick(30_000);
      expect(screen.getByText(/was not answered in time/)).toBeTruthy();

      // The operator starts a different registration while the first is unknown.
      fillRegistration({ name: 'Something else' });

      const created = makeTarget({ id: 'target-new', name: 'Reports' });
      await act(async () => {
        create.resolve(ok<'operations:createTarget'>(created));
        await vi.advanceTimersByTimeAsync(0);
      });

      // The registration landed…
      await tick();
      expect(within(targetList()).getByText('Reports')).toBeTruthy();
      // …and the work begun since is not what it was told to clear.
      const form = registerForm();
      expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Something else'
      );
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a late refusal instead of leaving "nobody knows" standing', async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();
    try {
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([]));
      bridge.set('operations:createTarget', () => create.promise);

      renderOperations(<OperationsView />);
      await tick();
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick(30_000);

      await act(async () => {
        create.resolve(fail('That name is already registered in local.'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText(/answered after all, and refused/)).toBeTruthy();
      expect(screen.getByText(/That name is already registered in local\./)).toBeTruthy();
      // One notice for one answer.
      expect(screen.getAllByText(/answered after all, and refused/)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a timely successful registration', () => {
  it('does not clear a draft the operator has since replaced', async () => {
    const create = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([]));
    bridge.set('operations:createTarget', () => create.promise);

    renderOperations(<OperationsView />);
    await screen.findByText('No targets registered');
    fillRegistration(registration);
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

    // Typed while the request was still in the air, and never submitted.
    fillRegistration({ name: 'Something else' });

    await deliver(create, ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' })));

    const form = registerForm();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Something else'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One registry mutation at a time                                             */
/* -------------------------------------------------------------------------- */

describe('a registration and a conflicting registry write in one tick', () => {
  it('sends one of them, not both', async () => {
    const slowUpdate = deferred<unknown>();
    bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    bridge.set('operations:updateTarget', () => slowUpdate.promise);
    bridge.set('operations:createTarget', () =>
      ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' }))
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await settle();
    fillRegistration(registration);

    // Both in one tick: nothing re-renders in between, so a disabled attribute
    // cannot arbitrate — only a synchronous claim can.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    });
    await settle();

    const writes =
      bridge.callsTo('operations:updateTarget').length +
      bridge.callsTo('operations:createTarget').length;
    expect(writes).toBe(1);
    expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
    expect(screen.getByText(/Another change to the registry is still in progress/)).toBeTruthy();

    await deliver(slowUpdate, ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
  });
});

/* -------------------------------------------------------------------------- */
/* A superseded read proves nothing                                            */
/* -------------------------------------------------------------------------- */

describe('a list read that a newer one has overtaken', () => {
  /**
   * Two recoveries, reachable from the screen as it stands.
   *
   * A registration whose reply was lost leaves the form with its own re-read,
   * and that re-read is a full list read. Start one while a target's
   * confirming read is still in the air and the target's read is superseded —
   * which is precisely the case where it used to answer with a flag meaning
   * only "a complete list existed at some point".
   */
  async function overlappingReads(): Promise<{
    targetRead: ReturnType<typeof deferred<unknown>>;
    createRead: ReturnType<typeof deferred<unknown>>;
  }> {
    const targetRead = deferred<unknown>();
    const createRead = deferred<unknown>();
    let lists = 0;
    bridge.set('operations:listTargets', () => {
      lists += 1;
      if (lists === 1) return ok<'operations:listTargets'>([makeTarget()]);
      // The registration's first confirming read fails, which is what leaves
      // its re-read button on screen and available.
      if (lists === 2) return fail('the registry could not be read');
      return lists === 3 ? targetRead.promise : createRead.promise;
    });
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    bridge.set('operations:createTarget', () =>
      Promise.reject(new Error('the bridge went away'))
    );
    bridge.set('operations:updateTarget', () =>
      Promise.reject(new Error('the bridge went away'))
    );

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await settle();

    // An unresolved registration, with its own re-read available.
    fillRegistration(registration);
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() =>
      expect(
        within(registerForm()).queryByRole('button', { name: /^Re-read the registry$/ })
      ).not.toBeNull()
    );

    // An unknown update on the target starts the confirming read this test is
    // about.
    fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
    await waitFor(() => expect(bridge.callsTo('operations:listTargets')).toHaveLength(3));
    expect(blockCard()).not.toBeNull();

    // And the registration's re-read overtakes it.
    fireEvent.click(
      within(registerForm()).getByRole('button', { name: /^Re-read the registry$/ })
    );
    await waitFor(() => expect(bridge.callsTo('operations:listTargets')).toHaveLength(4));

    return { targetRead, createRead };
  }

  it('does not settle the doubt it was started to settle', async () => {
    const { targetRead, createRead } = await overlappingReads();

    // The overtaken read answers, and carries exactly the state the request
    // asked for. Taken as evidence it would settle the doubt outright — and a
    // flag meaning only "a complete list existed once" is what let it.
    await deliver(targetRead, ok<'operations:listTargets'>([makeTarget({ enabled: false })]));

    expect(blockCard()).not.toBeNull();
    expect(screen.queryByText(/now matches the requested state/)).toBeNull();
    expect(screen.getByText(/could not be read back in full/)).toBeTruthy();

    await deliver(createRead, ok<'operations:listTargets'>([makeTarget()]));
  });

  it('does not report the other recovery as finished', async () => {
    const { targetRead, createRead } = await overlappingReads();

    // The registration's re-read is still running. An older reconciliation
    // answering must not make the form claim it is over.
    // Scoped to the form: the target's own block card says the same words about
    // its own recovery, and this test is about the registration's.
    const form = () => registerForm();
    expect(within(form()).getByText(/The registry is being re-read now/)).toBeTruthy();

    await deliver(targetRead, ok<'operations:listTargets'>([makeTarget()]));
    expect(within(form()).getByText(/The registry is being re-read now/)).toBeTruthy();

    // Only its own answer ends it.
    await deliver(createRead, ok<'operations:listTargets'>([makeTarget()]));
    await settle();
    expect(within(form()).queryByText(/The registry is being re-read now/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* An answer outranks a read-back                                              */
/* -------------------------------------------------------------------------- */

describe('an update that answers while the read-back is running', () => {
  it('reports the answer, not an unknown outcome', async () => {
    vi.useFakeTimers();
    const update = deferred<unknown>();
    const reconcileList = deferred<unknown>();
    try {
      let lists = 0;
      bridge.set('operations:listTargets', () => {
        lists += 1;
        return lists === 1
          ? ok<'operations:listTargets'>([makeTarget()])
          : reconcileList.promise;
      });
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:updateTarget', () => update.promise);

      renderOperations(<OperationsView />);
      await tick();
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await tick();

      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick(30_000);

      // The update succeeds while the confirming read is still outstanding.
      await act(async () => {
        update.resolve(ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        reconcileList.resolve(ok<'operations:listTargets'>([makeTarget({ enabled: false })]));
        await vi.advanceTimersByTimeAsync(0);
      });

      // The change is on screen, and the screen does not also claim nobody knows.
      expect(screen.getByRole('button', { name: /^Enable$/ })).toBeTruthy();
      expect(screen.queryByText(/was not answered in time/)).toBeNull();
      expect(screen.queryByText(/now matches the requested state/)).toBeNull();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a read-back while an update is still outstanding', () => {
  it('does not claim the change failed before the request has answered', async () => {
    vi.useFakeTimers();
    const update = deferred<unknown>();
    try {
      bridge.set('operations:listTargets', () =>
        ok<'operations:listTargets'>([makeTarget()])
      );
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:updateTarget', () => update.promise);

      renderOperations(<OperationsView />);
      await tick();
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await tick();
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick(30_000);
      await tick();

      // The accepted read saw the old state, but the mutation is still alive.
      // It cannot yet prove either that the mutation failed or that it landed.
      expect(screen.getByText(/has not been answered/)).toBeTruthy();
      expect(screen.queryByText(/The change did not take effect/)).toBeNull();
      expect(screen.queryByText(/now matches the requested state/)).toBeNull();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a refusal that arrives with the editor open', () => {
  it('is shown there rather than only in the read-only view', async () => {
    vi.useFakeTimers();
    const update = deferred<unknown>();
    try {
      bridge.set('operations:listTargets', () => ok<'operations:listTargets'>([makeTarget()]));
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:updateTarget', () => update.promise);

      renderOperations(<OperationsView />);
      await tick();
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await tick();

      fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
      const editor = screen.getByText('Save changes').closest('form') as HTMLElement;
      fireEvent.change(within(editor).getByLabelText('Name'), {
        target: { value: 'Renamed' }
      });
      fireEvent.click(within(editor).getByRole('button', { name: /Save changes/ }));
      await tick(30_000);

      expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();

      await act(async () => {
        update.resolve(fail('That name is already registered in local.'));
        await vi.advanceTimersByTimeAsync(0);
      });

      // The editor is still open, and this is where the reason used to be hidden.
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
      expect(screen.getByText(/answered after all, and refused/)).toBeTruthy();
      expect(screen.getAllByText(/answered after all, and refused/)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* What a read-back proves about an unknown mutation                           */
/* -------------------------------------------------------------------------- */

describe('an update nobody could confirm', () => {
  /** Lose the update reply, then answer the confirming read with `listed`. */
  async function unknownUpdate(listed: ReturnType<typeof makeTarget>[]): Promise<void> {
    let lists = 0;
    bridge.set('operations:listTargets', () => {
      lists += 1;
      return lists === 1
        ? ok<'operations:listTargets'>([makeTarget()])
        : ok<'operations:listTargets'>(listed);
    });
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    bridge.set('operations:updateTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
    await settle();
  }

  it('says the change did not take effect when the registry is unchanged', async () => {
    // The read succeeds and shows the target exactly as it was. Clearing the
    // doubt on that alone is what left an operator with no notice at all.
    await unknownUpdate([makeTarget()]);
    expect(screen.getByText(/The change did not take effect/)).toBeTruthy();
    expect(screen.queryByText(/now matches the requested state/)).toBeNull();
  });

  it('says the registry matches the request when it does', async () => {
    await unknownUpdate([makeTarget({ enabled: false })]);
    expect(screen.getByText(/now matches the requested state/)).toBeTruthy();
    // And says only that: a read cannot attribute the state to this request.
    expect(screen.getByText(/not proof that this request is what applied it/)).toBeTruthy();
  });

  it('says so when the registry holds neither state', async () => {
    await unknownUpdate([makeTarget({ name: 'Renamed by somebody else' })]);
    expect(screen.getByText(/The registry holds something else/)).toBeTruthy();
  });
});

describe('a removal nobody could confirm', () => {
  async function unknownDelete(
    listed: ReturnType<typeof makeTarget>[] | 'read-fails'
  ): Promise<void> {
    let lists = 0;
    bridge.set('operations:listTargets', () => {
      lists += 1;
      if (lists === 1) return ok<'operations:listTargets'>([makeTarget()]);
      return listed === 'read-fails'
        ? fail('the registry could not be read')
        : ok<'operations:listTargets'>(listed);
    });
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    bridge.set('operations:deleteTarget', () => Promise.reject(new Error('the bridge went away')));

    renderOperations(<OperationsView />);
    fireEvent.click(await within(targetList()).findByText('Reporting snapshot'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove the registration' }));
    await settle();
  }

  it('says the registry matches when the target is gone', async () => {
    await unknownDelete([]);
    expect(screen.getByText(/now matches the requested state/)).toBeTruthy();
  });

  it('says the removal did not take effect when the target is still there', async () => {
    await unknownDelete([makeTarget()]);
    expect(screen.getByText(/The change did not take effect/)).toBeTruthy();
  });

  it('keeps the doubt when the read itself could not be completed', async () => {
    await unknownDelete('read-fails');
    expect(screen.getByText(/could not be read back in full/)).toBeTruthy();
    expect(screen.queryByText(/now matches the requested state/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* An answer that arrives while the read-back is running                       */
/* -------------------------------------------------------------------------- */

describe('a registration that falls over while its read-back is running', () => {
  it('stops calling the request unanswered, and lets the form be used again', async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();
    const reconcileList = deferred<unknown>();
    try {
      let lists = 0;
      bridge.set('operations:listTargets', () => {
        lists += 1;
        return lists === 1
          ? ok<'operations:listTargets'>([])
          : reconcileList.promise;
      });
      bridge.set('operations:createTarget', () => create.promise);

      renderOperations(<OperationsView />);
      await tick();
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));

      // The wait runs out with the request still in flight, and the confirming
      // read starts.
      await tick(30_000);
      // The caller has not returned yet — it is inside the confirming read — so
      // the doubt is visible as the form's own notice rather than as an error.
      expect(screen.getByText(/The last registration was not confirmed/)).toBeTruthy();
      expect(bridge.callsTo('operations:listTargets')).toHaveLength(2);

      // The request then falls over in transport, while that read is still out.
      await act(async () => {
        create.reject(new Error('the bridge went away'));
        await vi.advanceTimersByTimeAsync(0);
      });

      // And the read completes afterwards. Rebuilding the state from the doubt
      // this call started with put `outstanding` back on a request that had
      // already finished, and left Register disabled over it.
      await act(async () => {
        reconcileList.resolve(ok<'operations:listTargets'>([]));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByText(/was not answered in time/)).toBeNull();
      expect(screen.queryByText(/has not been answered/)).toBeNull();

      // A complete read that does not contain it is an answer, so the form is
      // usable again — and nothing was sent a second time on its own.
      expect(
        disabled(screen.getByRole('button', { name: /Register target/ }))
      ).toBe(false);
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The registry slot belongs to the request, not to the wait                   */
/* -------------------------------------------------------------------------- */

describe('a registry mutation this renderer has stopped waiting for', () => {
  const second = makeTarget({ id: 'target-2', name: 'Second target' });

  /** A registration that timed out and has not answered. Returns its promise. */
  async function timedOutCreate(): Promise<ReturnType<typeof deferred<unknown>>> {
    const create = deferred<unknown>();
    bridge.set('operations:listTargets', () =>
      ok<'operations:listTargets'>([makeTarget()])
    );
    bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
    bridge.set('operations:createTarget', () => create.promise);
    bridge.set('operations:updateTarget', () =>
      ok<'operations:updateTarget'>(makeTarget({ enabled: false }))
    );

    renderOperations(<OperationsView />);
    await tick();
    fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
    await tick();
    fillRegistration(registration);
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await tick(30_000);
    return create;
  }

  it('keeps the slot while the registration is still unanswered', async () => {
    vi.useFakeTimers();
    try {
      await timedOutCreate();

      // The renderer stopped waiting; the request did not stop running. Letting
      // an edit start now is exactly the concurrent pair the slot prevents —
      // the two can decide each other's outcome through the name.
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));
      await tick();
      const confirm = screen.queryByRole('button', {
        name: 'Yes, remove the registration'
      });
      if (confirm !== null) fireEvent.click(confirm);
      await tick();
      expect(bridge.callsTo('operations:deleteTarget')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the slot back when the registration answers with a success', async () => {
    vi.useFakeTimers();
    try {
      const create = await timedOutCreate();
      expect(disabled(screen.getByRole('button', { name: /^Disable$/ }))).toBe(true);

      await act(async () => {
        create.resolve(
          ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' }))
        );
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the slot back when the registration answers with a refusal', async () => {
    vi.useFakeTimers();
    try {
      const create = await timedOutCreate();

      await act(async () => {
        create.resolve(fail('That name is already registered in local.'));
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the slot back on a transport failure without calling it a success', async () => {
    vi.useFakeTimers();
    try {
      const create = await timedOutCreate();

      await act(async () => {
        create.reject(new Error('the bridge went away'));
        await vi.advanceTimersByTimeAsync(0);
      });

      // The slot is free…
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

      // …and nothing claims the registration succeeded.
      expect(screen.queryByText(/It was registered after all/)).toBeNull();
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the slot while an edit is unanswered, against every other target', async () => {
    vi.useFakeTimers();
    const update = deferred<unknown>();
    try {
      bridge.set('operations:listTargets', () =>
        ok<'operations:listTargets'>([makeTarget(), second])
      );
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:updateTarget', () => update.promise);
      bridge.set('operations:createTarget', () =>
        ok<'operations:createTarget'>(makeTarget({ id: 'target-new', name: 'Reports' }))
      );

      renderOperations(<OperationsView />);
      await tick();
      fireEvent.click(within(targetList()).getByText('Reporting snapshot'));
      await tick();
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick(30_000);
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

      // A registration must wait…
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick();
      expect(bridge.callsTo('operations:createTarget')).toHaveLength(0);

      // …and so must a change to a completely different target: the slot is
      // the registry's, not this target's.
      fireEvent.click(within(targetList()).getByText('Second target'));
      await tick();
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(1);

      // The answer, and only the answer, gives it back.
      await act(async () => {
        update.resolve(ok<'operations:updateTarget'>(makeTarget({ enabled: false })));
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
      await tick();
      expect(bridge.callsTo('operations:updateTarget')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the registry slot block a diagnostic on another target', async () => {
    vi.useFakeTimers();
    try {
      bridge.set('operations:listTargets', () =>
        ok<'operations:listTargets'>([makeTarget(), second])
      );
      bridge.set('operations:listDiagnostics', () => ok<'operations:listDiagnostics'>([]));
      bridge.set('operations:runDiagnostic', () =>
        ok<'operations:runDiagnostic'>(makeRun({ targetId: 'target-2' }))
      );
      bridge.set('operations:createTarget', () => neverSettles());

      renderOperations(<OperationsView />);
      await tick();
      fillRegistration(registration);
      fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
      await tick(30_000);

      // Reading a different target is not a registry mutation, and is not held.
      fireEvent.click(within(targetList()).getByText('Second target'));
      await tick();
      fireEvent.click(screen.getByRole('button', { name: /Run diagnostic/ }));
      await tick();
      expect(bridge.callsTo('operations:runDiagnostic')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
