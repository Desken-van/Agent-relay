/**
 * Scaffolding for renderer tests.
 *
 * These render the real components against a fake preload bridge. The bridge is
 * the renderer's entire view of the outside world — `window.agentRelay.invoke`
 * and nothing else — so replacing it is enough to drive every screen without a
 * main process, a database or a child process anywhere in sight.
 *
 * Deferred promises rather than timers: a race is only worth testing if the test
 * decides when each answer arrives. A sleep would make the same assertions pass
 * or fail depending on how loaded the machine is.
 */

import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react';
import type { IpcChannel, IpcResponseMap, IpcResult } from '@shared/ipc';
import type { OperationTarget } from '@shared/domain/operations';
import type {
  ConnectionHealthResult,
  OperationDiagnosticRun,
  SchemaSummaryResult
} from '@shared/domain/operations-diagnostics';
import { OperationsProvider } from '../../src/renderer/src/state/operations';
import { StoreProvider } from '../../src/renderer/src/state/store';

/* -------------------------------------------------------------------------- */
/* Deferred promises                                                           */
/* -------------------------------------------------------------------------- */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* -------------------------------------------------------------------------- */
/* The fake bridge                                                             */
/* -------------------------------------------------------------------------- */

export type Handler = (input: unknown) => unknown;

export interface RecordedCall {
  readonly channel: string;
  readonly input: unknown;
}

export interface Bridge {
  /** Every invoke, in order, whatever the channel. */
  readonly calls: RecordedCall[];
  /** Just the ones for a given channel. */
  callsTo(channel: IpcChannel): RecordedCall[];
  /** Replace a handler mid-test. */
  set(channel: IpcChannel, handler: Handler): void;
}

export function ok<C extends IpcChannel>(data: IpcResponseMap[C]): IpcResult<IpcResponseMap[C]> {
  return { ok: true, data };
}

export function fail(message: string, code = 'VALIDATION_FAILED', remediation?: string): IpcResult<never> {
  return {
    ok: false,
    error: {
      code: code as never,
      message,
      ...(remediation === undefined ? {} : { remediation })
    }
  };
}

/**
 * Install a bridge on `window`, with sensible answers for the channels the main
 * store loads on start-up so a test only has to describe what it cares about.
 */
export function installBridge(handlers: Partial<Record<IpcChannel, Handler>> = {}): Bridge {
  const calls: RecordedCall[] = [];
  const table: Partial<Record<string, Handler>> = {
    'projects:list': () => ok<'projects:list'>([]),
    'settings:get': () => ({ ok: false, error: { code: 'INTERNAL', message: 'not used' } }),
    'diagnostics:run': () => ({ ok: false, error: { code: 'INTERNAL', message: 'not used' } }),
    'codex:listModels': () =>
      ok<'codex:listModels'>({ available: false, models: [], detail: 'not used' }),
    'operations:listTargets': () => ok<'operations:listTargets'>([]),
    'operations:listDiagnostics': () => ok<'operations:listDiagnostics'>([]),
    ...handlers
  };

  const invoke = async (channel: string, input: unknown): Promise<unknown> => {
    calls.push({ channel, input });
    const handler = table[channel];
    if (!handler) {
      return { ok: false, error: { code: 'INTERNAL', message: `no handler for ${channel}` } };
    }
    return handler(input);
  };

  (window as unknown as { agentRelay: unknown }).agentRelay = {
    invoke,
    onEvent: () => () => undefined
  };

  return {
    calls,
    callsTo: (channel) => calls.filter((entry) => entry.channel === channel),
    set: (channel, handler) => {
      table[channel] = handler;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/** The Operations screen, mounted the way the application mounts it. */
export function renderOperations(children: ReactNode): RenderResult {
  return render(<OperationsProvider>{children}</OperationsProvider>);
}

/** The whole application, for the tests that are about navigation. */
export function renderApp(children: ReactNode): RenderResult {
  return render(
    <StoreProvider>
      <OperationsProvider>{children}</OperationsProvider>
    </StoreProvider>
  );
}

/**
 * A two-section shell.
 *
 * Stands in for the application's router so a test can leave the Operations
 * screen and come back while the provider above it stays mounted — which is how
 * the real application is put together, and the only arrangement in which "the
 * request outlived the screen" means anything.
 */
export function Sections({ children }: { children: ReactNode }): React.JSX.Element {
  const [showing, setShowing] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setShowing(false)}>
        Go elsewhere
      </button>
      <button type="button" onClick={() => setShowing(true)}>
        Back to Operations
      </button>
      {showing ? children : <p>Somewhere else entirely</p>}
    </div>
  );
}

/**
 * Let every pending microtask and timer turn run, inside `act`.
 *
 * Not a sleep standing in for a race — nothing here is waiting on a real answer.
 * It exists so that an effect which re-fires on the state its own failure
 * produced has every chance to fire again before an assertion counts the
 * requests. Without it, "asked once" would only mean "asked once so far".
 */
export async function settle(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

/**
 * Click the same control several times in one tick.
 *
 * `fireEvent` on its own is wrapped in `act`, so React re-renders between two
 * consecutive calls and the second lands on a button that is already disabled —
 * which tests the `disabled` attribute, not the guard behind it. Nested inside a
 * single `act`, nothing is flushed in between, every click sees the same state,
 * and only a synchronous claim can stop the second request. That is what a real
 * double click is.
 */
export async function burstClick(element: HTMLElement, times = 3): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) fireEvent.click(element);
  });
}

/** Resolve a deferred answer and let React finish reacting to it. */
export async function deliver<T>(gate: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    gate.resolve(value);
  });
  await settle(2);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export function makeTarget(overrides: Partial<OperationTarget> = {}): OperationTarget {
  return {
    id: 'target-1',
    name: 'Reporting snapshot',
    environment: 'local',
    adapterType: 'local_sqlite',
    config: { version: 1, adapterType: 'local_sqlite', databasePath: 'C:\\data\\reports.sqlite' },
    credentialRef: null,
    enabled: true,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...overrides
  };
}

export function makeHealthResult(
  overrides: Partial<ConnectionHealthResult> = {}
): ConnectionHealthResult {
  return {
    version: 1,
    probeId: 'connection_health',
    targetId: 'target-1',
    environment: 'local',
    adapterType: 'local_sqlite',
    opened: true,
    readOnly: true,
    queryOnly: true,
    sqliteVersion: '3.50.0',
    fileExists: true,
    fileReadable: true,
    fileSizeBytes: 8192,
    fileModifiedAt: '2026-09-03T09:00:00.000Z',
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:00.100Z',
    durationMs: 100,
    warnings: [],
    ...overrides
  };
}

export function makeSchemaResult(
  overrides: Partial<SchemaSummaryResult> = {}
): SchemaSummaryResult {
  return {
    version: 1,
    probeId: 'schema_summary',
    targetId: 'target-1',
    environment: 'local',
    adapterType: 'local_sqlite',
    tables: [
      {
        name: 'invoices',
        columns: [{ name: 'id', declaredType: 'INTEGER', nullable: false, primaryKey: true }],
        omittedColumns: 0
      }
    ],
    omittedTables: 0,
    omittedColumns: 0,
    truncated: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:00.050Z',
    durationMs: 50,
    warnings: [],
    ...overrides
  };
}

export function makeRun(overrides: Partial<OperationDiagnosticRun> = {}): OperationDiagnosticRun {
  return {
    id: 'diag-1',
    targetId: 'target-1',
    probeId: 'connection_health',
    status: 'succeeded',
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:00.100Z',
    result: makeHealthResult(),
    failureKind: null,
    errorMessage: null,
    version: 1,
    ...overrides
  };
}
