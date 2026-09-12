/**
 * The Local inference lifecycle panel (LOCAL-B2).
 *
 * Exposes exactly the five bounded IPC operations that already exist:
 * getCapabilities, start, getState, checkHealth and stop. Nothing here can
 * name a prompt, an executable, a path, a host or a request — those channels
 * accept only a strict empty object, and this panel never asks for more.
 *
 * On mount it calls `getState` and nothing else: no automatic capability
 * check, no automatic start, no polling, no retry. Every other call is a
 * direct response to an operator clicking a button.
 *
 * Lifecycle operations always act on *saved* settings — this component takes
 * `enabled` and `unsaved` as props computed from the store's saved settings
 * and the Settings draft, never from anything it reads itself.
 */

import { useEffect, useRef, useState } from 'react';
import { call } from '../lib/api';
import type {
  LocalInferenceCapabilities,
  LocalInferenceState,
  LocalInferenceStateKind
} from '@shared/domain/local-inference';
import { Card, Notice, Spinner } from './primitives';

type PrimaryOperation = 'capabilities' | 'start' | 'health' | 'refresh';
type PendingOperation = PrimaryOperation | 'stop' | null;

/** What the primary button currently offers, independent of pending/unsaved overlays. */
type BaseAction =
  | { readonly kind: 'capabilities' | 'start' | 'health' | 'refresh'; readonly label: string }
  | { readonly kind: null; readonly label: string; readonly reason: string };

/**
 * The display condition the primary action is projected from: the saved
 * `enabled` flag, the lifecycle state, and — only while stopped — whether
 * capability evidence has been gathered yet.
 *
 * `'disabled'` and `'available'` are not members of {@link LocalInferenceStateKind}:
 * they are this panel's own vocabulary for "settings say no" and "stopped,
 * and we already know the executable is there."
 */
type DisplayKind = 'disabled' | 'unknown' | 'available' | LocalInferenceStateKind;

function displayKindFor(
  enabled: boolean,
  state: LocalInferenceState | null,
  capabilities: LocalInferenceCapabilities | null
): DisplayKind {
  if (!enabled) return 'disabled';
  if (state === null) return 'unknown';
  if (state.kind === 'stopped') {
    if (capabilities === null) return 'unknown';
    return capabilities.available ? 'available' : 'unavailable';
  }
  return state.kind;
}

const BASE_ACTIONS: Record<DisplayKind, BaseAction> = {
  // Unreachable in practice: `projectPrimaryAction` returns before consulting
  // this table when settings are disabled. Present anyway so the table stays
  // total over every value `displayKindFor` could type-check as returning.
  disabled: {
    kind: null,
    label: 'Start runtime',
    reason: 'Enable local inference in Settings and save to use these controls.'
  },
  unknown: { kind: 'capabilities', label: 'Check capabilities' },
  available: { kind: 'start', label: 'Start runtime' },
  unavailable: { kind: 'capabilities', label: 'Re-check capabilities' },
  starting: { kind: 'refresh', label: 'Refresh state' },
  healthy: { kind: 'health', label: 'Check health' },
  inferring: { kind: 'refresh', label: 'Refresh state' },
  stopping: { kind: 'refresh', label: 'Refresh state' },
  stopped: { kind: 'capabilities', label: 'Check capabilities' },
  failed: {
    kind: null,
    label: 'Start unavailable (cleanup required)',
    reason: 'Stop the retained runtime before starting again.'
  },
  cancelled: {
    kind: null,
    label: 'Start unavailable (cleanup required)',
    reason: 'Stop the retained runtime before starting again.'
  },
  timed_out: {
    kind: null,
    label: 'Start unavailable (cleanup required)',
    reason: 'Stop the retained runtime before starting again.'
  }
};

interface PrimaryAction {
  readonly label: string;
  readonly kind: Exclude<PendingOperation, 'stop'>;
  readonly disabled: boolean;
  /** Shown under the button only when it is disabled for a settings/save reason. */
  readonly reason: string | null;
}

function projectPrimaryAction(input: {
  readonly enabled: boolean;
  readonly unsaved: boolean;
  readonly state: LocalInferenceState | null;
  readonly capabilities: LocalInferenceCapabilities | null;
  readonly pending: PendingOperation;
}): PrimaryAction {
  const { enabled, unsaved, state, capabilities, pending } = input;

  if (!enabled) {
    return {
      label: 'Start runtime',
      kind: null,
      disabled: true,
      reason: 'Enable local inference in Settings and save to use these controls.'
    };
  }

  const displayKind = displayKindFor(enabled, state, capabilities);
  const base = BASE_ACTIONS[displayKind];

  if (base.kind === null) {
    return { label: base.label, kind: null, disabled: true, reason: base.reason };
  }
  if (unsaved) {
    return {
      label: base.label,
      kind: base.kind,
      disabled: true,
      reason: 'Save local inference settings before using lifecycle controls.'
    };
  }
  if (pending !== null) {
    return { label: base.label, kind: base.kind, disabled: true, reason: null };
  }
  return { label: base.label, kind: base.kind, disabled: false, reason: null };
}

/** States in which a Stop control is meaningful: an active runtime, or one needing cleanup. */
const STOP_APPLICABLE_KINDS: readonly LocalInferenceStateKind[] = [
  'starting',
  'healthy',
  'inferring',
  'failed',
  'cancelled',
  'timed_out'
];

function describeState(state: LocalInferenceState | null): string {
  if (state === null) return 'Loading current state…';
  switch (state.kind) {
    case 'unavailable':
      return `Unavailable — ${state.reason}`;
    case 'starting':
      return `Starting (runtime ${state.runtimeInstanceId})`;
    case 'healthy':
      return `Healthy (runtime ${state.runtimeInstanceId})`;
    case 'inferring':
      return `Inferring (runtime ${state.runtimeInstanceId})`;
    case 'stopping':
      return 'Stopping…';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return `Failed — ${state.reason}`;
    case 'cancelled':
      return `Cancelled — ${state.reason}`;
    case 'timed_out':
      return `Timed out — ${state.reason}`;
    default:
      return 'Unknown';
  }
}

function describeCapabilities(capabilities: LocalInferenceCapabilities): string {
  const parts = [
    `Executable available: ${capabilities.available ? 'yes' : 'no'}`,
    capabilities.executableSource ? `source: ${capabilities.executableSource}` : null,
    capabilities.runtimeVersion ? `version: ${capabilities.runtimeVersion}` : null,
    `inference verified: ${capabilities.inferenceVerified ? 'yes' : 'no'}`,
    capabilities.unavailableReason ? capabilities.unavailableReason : null
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

export interface LocalInferenceLifecyclePanelProps {
  /** The *saved* enabled flag — never the unsaved draft. */
  readonly enabled: boolean;
  /** Whether the local-inference part of the Settings draft differs from what is saved. */
  readonly unsaved: boolean;
}

export function LocalInferenceLifecyclePanel({
  enabled,
  unsaved
}: LocalInferenceLifecyclePanelProps): React.JSX.Element {
  const [state, setState] = useState<LocalInferenceState | null>(null);
  const [capabilities, setCapabilities] = useState<LocalInferenceCapabilities | null>(null);
  const [whatHappened, setWhatHappened] = useState<string>('No lifecycle action taken yet.');
  const [result, setResult] = useState<string>('—');
  const [primaryPending, setPrimaryPending] = useState<PrimaryOperation | null>(null);
  const [stopPending, setStopPending] = useState(false);
  // A synchronous claim, checked and set before any state update or await, so
  // a burst of clicks inside one tick still issues exactly one IPC call —
  // `disabled` alone only takes effect on the next render.
  const primaryPendingRef = useRef<PrimaryOperation | null>(null);
  const stopPendingRef = useRef(false);
  // Every lifecycle response is tagged with the action order. If Stop starts
  // after Start/Health/Refresh, the older response must not overwrite the
  // newer stop result when it eventually arrives.
  const stateOperationEpochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await call('localInference:getState', {});
      if (cancelled) return;
      if (response.ok) setState(response.data);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: opening the panel reads state once and never again on its own.
  }, []);

  const pending: PendingOperation = stopPending ? 'stop' : primaryPending;
  const primary = projectPrimaryAction({ enabled, unsaved, state, capabilities, pending });
  const showStop =
    primaryPending === 'start' ||
    (state !== null && STOP_APPLICABLE_KINDS.includes(state.kind));
  const stopDisabled = stopPending;

  async function runPrimary(): Promise<void> {
    if (primary.kind === null || primary.disabled) return;
    if (primaryPendingRef.current !== null || stopPendingRef.current) return;
    const operation = primary.kind;
    primaryPendingRef.current = operation;
    setPrimaryPending(operation);
    const epoch = ++stateOperationEpochRef.current;
    try {
      if (operation === 'capabilities') {
        const response = await call('localInference:getCapabilities', {});
        if (epoch !== stateOperationEpochRef.current) return;
        if (response.ok) {
          setCapabilities(response.data);
          // A capability probe never starts a process. Its answer does,
          // however, supersede a passive `unavailable` state captured before
          // enabled settings were saved. Project the next action from the
          // newly checked facts instead of trapping the operator in Re-check.
          setState(
            response.data.available
              ? { kind: 'stopped' }
              : {
                  kind: 'unavailable',
                  reason:
                    response.data.unavailableReason ??
                    'The local inference runtime is unavailable.'
                }
          );
          setWhatHappened('Checked capabilities.');
          setResult(describeCapabilities(response.data));
        } else {
          setWhatHappened('Checking capabilities failed.');
          setResult(response.error.message);
        }
      } else if (operation === 'start') {
        const response = await call('localInference:start', {});
        if (epoch !== stateOperationEpochRef.current) return;
        if (response.ok) {
          setState(response.data);
          setWhatHappened('Requested start.');
          setResult(describeState(response.data));
        } else {
          setWhatHappened('Start failed.');
          setResult(response.error.message);
        }
      } else if (operation === 'health') {
        const response = await call('localInference:checkHealth', {});
        if (epoch !== stateOperationEpochRef.current) return;
        if (response.ok) {
          setState(response.data);
          setWhatHappened('Checked health.');
          setResult(describeState(response.data));
        } else {
          setWhatHappened('Health check failed.');
          setResult(response.error.message);
        }
      } else if (operation === 'refresh') {
        const response = await call('localInference:getState', {});
        if (epoch !== stateOperationEpochRef.current) return;
        if (response.ok) {
          setState(response.data);
          setWhatHappened('Refreshed state.');
          setResult(describeState(response.data));
        } else {
          setWhatHappened('Refreshing state failed.');
          setResult(response.error.message);
        }
      }
    } finally {
      if (primaryPendingRef.current === operation) {
        primaryPendingRef.current = null;
        setPrimaryPending(null);
      }
    }
  }

  async function runStop(): Promise<void> {
    // Deliberately independent of the primary claim for a start/capabilities/health
    // claim: Stop must be able to interrupt those, not queue behind them.
    if (stopPendingRef.current) return;
    stopPendingRef.current = true;
    setStopPending(true);
    const epoch = ++stateOperationEpochRef.current;
    try {
      const response = await call('localInference:stop', {});
      if (epoch !== stateOperationEpochRef.current) return;
      if (response.ok) {
        setState(response.data);
        setWhatHappened('Requested stop.');
        setResult(describeState(response.data));
        if (response.data.kind === 'stopped') setCapabilities(null);
      } else {
        setWhatHappened('Stop failed.');
        setResult(response.error.message);
      }
    } finally {
      stopPendingRef.current = false;
      setStopPending(false);
    }
  }

  return (
    <Card title="Local inference lifecycle">
      <div className="stack">
        <div className="row">
          <strong>What happened</strong>
          <span>{whatHappened}</span>
        </div>
        <div className="row">
          <strong>Current state</strong>
          <span>{describeState(state)}</span>
        </div>
        <div className="row">
          <strong>Result</strong>
          <span>{result}</span>
        </div>
        <div className="row">
          <strong>Next action</strong>
          <span>{primary.reason ?? primary.label}</span>
        </div>

        <div className="row">
          <button type="button" className="btn btn--primary" disabled={primary.disabled} onClick={() => void runPrimary()}>
            {primaryPending === primary.kind ? <Spinner /> : null} {primary.label}
          </button>
          {showStop ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={stopDisabled}
              onClick={() => void runStop()}
            >
              {stopPending ? <Spinner /> : null} Stop
            </button>
          ) : null}
        </div>

        {!enabled ? (
          <Notice tone="info">
            Local inference is disabled. Enable it above and save Settings to use these controls.
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}
