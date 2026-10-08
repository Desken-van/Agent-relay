import { describe, expect, it } from 'vitest';
import type { LocalInferenceQuitOutcome } from '../../src/main/ports';
import { createQuitCoordinator } from '../../src/main/quit-coordinator';

describe('quitting with a local runtime', () => {
  it('defers the first quit until the runtime stop settles, then quits once more and lets that through', async () => {
    let finish!: (outcome: LocalInferenceQuitOutcome) => void;
    let stops = 0;
    let quits = 0;
    const reports: LocalInferenceQuitOutcome[] = [];
    const coordinator = createQuitCoordinator({
      stopRuntime: () => { stops += 1; return new Promise((resolve) => { finish = resolve; }); },
      quit: () => { quits += 1; },
      report: (outcome) => reports.push(outcome)
    });

    expect(coordinator.beforeQuit()).toBe(false);
    // Asked again while the stop runs (a second Ctrl+Q, the last window closing): still deferred, nothing new started.
    expect(coordinator.beforeQuit()).toBe(false);
    expect(stops).toBe(1);
    expect(quits).toBe(0);

    finish({ kind: 'stopped' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toEqual([{ kind: 'stopped' }]);
    expect(quits).toBe(1);
    expect(coordinator.beforeQuit()).toBe(true);
    expect(stops).toBe(1);
  });

  it('still quits when the stop fails or is unconfirmed, and reports it', async () => {
    const reports: LocalInferenceQuitOutcome[] = [];
    let quits = 0;
    const coordinator = createQuitCoordinator({
      stopRuntime: () => Promise.reject(new Error('boom')),
      quit: () => { quits += 1; },
      report: (outcome) => reports.push(outcome)
    });
    expect(coordinator.beforeQuit()).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toEqual([{ kind: 'unconfirmed', reason: 'The local runtime stop failed.' }]);
    expect(quits).toBe(1);
    expect(coordinator.beforeQuit()).toBe(true);
  });

  it('lets the quit straight through when there is no application to stop anything for', () => {
    let quits = 0;
    const coordinator = createQuitCoordinator({ stopRuntime: () => null, quit: () => { quits += 1; }, report: () => undefined });
    expect(coordinator.beforeQuit()).toBe(true);
    expect(quits).toBe(0);
  });
});
