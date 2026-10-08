/**
 * What Agent Relay does with its own local runtime when the application quits.
 *
 * Electron's `before-quit` is synchronous; stopping a runtime is not. So the first quit request is
 * deferred while the application's own runtime is stopped (`LocalInferenceLifecycleService.stopForQuit`,
 * which is bounded), and the quit is then requested again and allowed through. A quit requested while
 * that stop is still running is deferred again and starts nothing new. Nothing here looks for processes
 * by name: only the runtime this application started and still owns is stopped.
 *
 * On Windows the runtime additionally lives in a Job Object with kill-on-close, so it cannot outlive the
 * application even when this path never runs. On Linux it leads its own process group and nothing else
 * stops it: an application that ends without a quit (SIGKILL, a crash) leaves it running.
 */

import type { LocalInferenceQuitOutcome } from './ports';

export interface QuitCoordinatorDependencies {
  /** The bounded quit-time stop, or null when there is no application (nothing to stop). */
  readonly stopRuntime: () => Promise<LocalInferenceQuitOutcome> | null;
  /** Ask the application to quit again once the stop has settled. */
  readonly quit: () => void;
  /** Told how the stop ended, once. */
  readonly report: (outcome: LocalInferenceQuitOutcome) => void;
}

export interface QuitCoordinator {
  /** From `before-quit`: true lets this quit proceed now; false means it was deferred (call `preventDefault`). */
  beforeQuit(): boolean;
}

export function createQuitCoordinator(dependencies: QuitCoordinatorDependencies): QuitCoordinator {
  let phase: 'idle' | 'stopping' | 'done' = 'idle';
  return {
    beforeQuit(): boolean {
      if (phase === 'done') return true;
      if (phase === 'stopping') return false;
      const stopping = dependencies.stopRuntime();
      if (stopping === null) {
        phase = 'done';
        return true;
      }
      phase = 'stopping';
      void stopping
        .catch((): LocalInferenceQuitOutcome => ({ kind: 'unconfirmed', reason: 'The local runtime stop failed.' }))
        .then((outcome) => {
          phase = 'done';
          try {
            dependencies.report(outcome);
          } finally {
            dependencies.quit();
          }
        });
      return false;
    }
  };
}
