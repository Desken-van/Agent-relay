/**
 * The Local inference lifecycle panel (LOCAL-B2 + LOCAL-B3).
 *
 * Exposes the five bounded lifecycle IPC operations — getCapabilities, start,
 * getState, checkHealth and stop — plus one manual smoke-test operation,
 * `runTestInference`, which accepts only `{prompt}`. Nothing here can name an
 * executable, a path, a host or a request id; those still travel as strict
 * empty objects, and the prompt channel accepts nothing else either.
 *
 * On mount it calls `getState` and nothing else: no automatic capability
 * check, no automatic start, no automatic inference, no polling, no retry.
 * Every other call is a direct response to an operator clicking a button.
 *
 * Lifecycle operations always act on *saved* settings — this component takes
 * `enabled` and `unsaved` as props computed from the store's saved settings
 * and the Settings draft, never from anything it reads itself. The prompt and
 * its result live only in this component's own state: never the global
 * store, Settings, or any browser storage, so both vanish on unmount or
 * restart.
 */

import { useEffect, useRef, useState } from 'react';
import { call } from '../lib/api';
import {
  localInferencePromptSchema,
  type LocalInferenceCapabilities,
  type LocalInferenceFinishReason,
  type LocalInferenceResponse,
  type LocalInferenceState,
  type LocalInferenceStateKind
} from '@shared/domain/local-inference';
import { redactAndTruncate } from '@shared/util/redact';
import { Card, Field, Notice, Spinner } from './primitives';

/** Bounded so a defensively-redacted IPC error message still fits on screen. */
const IPC_ERROR_MESSAGE_MAX = 500;
const IPC_TRANSPORT_FAILURE_REASON =
  'The local inference request failed before a typed response was received.';

type PanelOperation = 'capabilities' | 'start' | 'health' | 'refresh' | 'inference' | 'stop';
type PendingOperation = PanelOperation | null;

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

/**
 * Every typed finish-reason variant, honestly. `unknown` and `other` are
 * distinct labels rather than being folded into `stop` — a caller reading
 * "stop" here must be able to trust that the runtime actually said so.
 */
function describeFinishReason(reason: LocalInferenceFinishReason): string {
  switch (reason.kind) {
    case 'stop':
      return 'Stop (the runtime reported a normal end)';
    case 'length':
      return 'Length (the output token limit was reached)';
    case 'content_filter':
      return 'Content filter';
    case 'tool_calls':
      return 'Tool calls';
    case 'other':
      return `Other — ${reason.reason}`;
    case 'unknown':
      return 'Unknown (the runtime did not report a finish reason)';
    default:
      return 'Unknown';
  }
}

/**
 * What the test-inference panel has to show, once an attempt has been made.
 *
 * `outcome_failure` covers the contract's own failed/cancelled/timed_out
 * outcomes, whose `reason` is already bounded and redacted by the adapter.
 * `ipc_error` covers either a structured IPC failure (redacted and truncated
 * defensively) or a rejected/thrown bridge call, which receives only a fixed,
 * allowlisted reason because its untyped message is not safe to render.
 */
type TestInferenceDisplay =
  | { readonly kind: 'completed'; readonly response: LocalInferenceResponse }
  | { readonly kind: 'outcome_failure'; readonly reason: string }
  | { readonly kind: 'ipc_error'; readonly reason: string };

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
  const [pending, setPending] = useState<PendingOperation>(null);
  // One synchronous panel-wide claim, checked and set before any state update
  // or await. A burst of clicks inside one tick still issues exactly one IPC
  // call, and Stop cannot overlap another panel action (or vice versa).
  // `disabled` alone only takes effect on the next render.
  const pendingRef = useRef<PendingOperation>(null);
  // Every state-changing response is tagged with the action order. Renderer
  // actions are serialized, but this also protects against any stale answer
  // from a future non-UI caller changing the interaction model.
  const stateOperationEpochRef = useRef(0);

  // The manual smoke-test prompt and its most recent outcome. Component state
  // only: never the global store, Settings, or any browser storage, so both
  // are gone on unmount and never come back on restart.
  const [prompt, setPrompt] = useState('');
  const [testInference, setTestInference] = useState<TestInferenceDisplay | null>(null);

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

  const primary = projectPrimaryAction({ enabled, unsaved, state, capabilities, pending });
  const showStop =
    pending !== null ||
    (state !== null && STOP_APPLICABLE_KINDS.includes(state.kind));
  const stopDisabled = pending !== null;

  // The prompt editor's own enabling condition is deliberately independent of
  // prompt *content*: an operator must be able to focus the field and type a
  // first prompt, and must be able to edit or clear an invalid one, whenever
  // the runtime is actually usable. Only "Run test inference" additionally
  // requires a valid, non-empty prompt — see `promptValid` below.
  const promptEditable =
    enabled && !unsaved && state !== null && state.kind === 'healthy' && pending === null;
  const promptValid = localInferencePromptSchema.safeParse(prompt).success;
  const inferenceDisabled = !promptEditable || !promptValid;

  function inferenceUnavailableReason(): string | null {
    // The `!enabled` and `unsaved` cases are already explained elsewhere on
    // this card (the disabled-settings Notice and the primary action's own
    // "Next action" reason); repeating the same sentence here would only be a
    // second copy of the same text, not new information.
    if (!enabled || unsaved) return null;
    if (state === null || state.kind !== 'healthy') {
      return 'The runtime must be Healthy to run a test inference.';
    }
    if (pending !== null) return null;
    if (!promptValid) {
      return prompt.length === 0
        ? 'Enter a prompt to run a test inference.'
        : 'The prompt is too long.';
    }
    return null;
  }

  async function runPrimary(): Promise<void> {
    if (primary.kind === null || primary.disabled) return;
    if (pendingRef.current !== null) return;
    const operation = primary.kind;
    pendingRef.current = operation;
    setPending(operation);
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
      if (pendingRef.current === operation) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }

  /**
   * One manual smoke-test request. It shares the panel-wide claim with every
   * lifecycle action, so a burst of clicks across any controls dispatches at
   * most one operation at a time.
   */
  async function runInference(): Promise<void> {
    if (inferenceDisabled) return;
    if (pendingRef.current !== null) return;
    const operation: PanelOperation = 'inference';
    pendingRef.current = operation;
    setPending(operation);
    const epoch = ++stateOperationEpochRef.current;
    const submittedPrompt = prompt;
    try {
      const response = await call('localInference:runTestInference', { prompt: submittedPrompt });
      if (epoch !== stateOperationEpochRef.current) return;
      if (response.ok) {
        const outcome = response.data;
        if (outcome.kind === 'completed') {
          setTestInference({ kind: 'completed', response: outcome.response });
          // Mirrors the transition the provider itself just made: an
          // inference that completes returns the provider to `healthy`.
          setState({ kind: 'healthy', runtimeInstanceId: outcome.response.runtimeInstanceId });
          setWhatHappened('Ran test inference.');
          // Deliberately generic: the Completion/Finish reason/Duration/
          // Provider-model fields below already carry the detail, and
          // repeating it here would just be a second copy of the same text.
          setResult('Completed.');
        } else {
          setTestInference({ kind: 'outcome_failure', reason: outcome.reason });
          // The provider's own Healthy-only transition already moved it to
          // this exact terminal state before this outcome was returned.
          setState({ kind: outcome.kind, reason: outcome.reason });
          setWhatHappened('Test inference did not complete.');
          setResult('Not completed.');
        }
      } else {
        const reason = redactAndTruncate(response.error.message, IPC_ERROR_MESSAGE_MAX);
        setTestInference({ kind: 'ipc_error', reason });
        setWhatHappened('Test inference failed.');
        setResult('Not completed.');
      }
    } catch {
      // `call` forwards the preload bridge's promise unwrapped: a transport
      // failure (main process gone, channel torn down) rejects rather than
      // resolving `{ok:false}`. Never render that untyped rejection: it could
      // contain a response body, path, argv, or credential. Use one bounded,
      // allowlisted reason and replace any stale completion.
      if (epoch !== stateOperationEpochRef.current) return;
      setTestInference({ kind: 'ipc_error', reason: IPC_TRANSPORT_FAILURE_REASON });
      setWhatHappened('Test inference failed.');
      setResult('Not completed.');
    } finally {
      if (pendingRef.current === operation) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }

  async function runStop(): Promise<void> {
    if (pendingRef.current !== null) return;
    const operation: PanelOperation = 'stop';
    pendingRef.current = operation;
    setPending(operation);
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
      if (pendingRef.current === operation) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }

  const inferenceReason = inferenceUnavailableReason();

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
            {pending === primary.kind ? <Spinner /> : null} {primary.label}
          </button>
          {showStop ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={stopDisabled}
              onClick={() => void runStop()}
            >
              {pending === 'stop' ? <Spinner /> : null} Stop
            </button>
          ) : null}
        </div>

        {!enabled ? (
          <Notice tone="info">
            Local inference is disabled. Enable it above and save Settings to use these controls.
          </Notice>
        ) : null}

        <Field label="Test inference prompt" hint="Sent once, exactly as typed. Never saved or logged.">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={!promptEditable}
            rows={3}
          />
        </Field>

        <div className="row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={inferenceDisabled}
            onClick={() => void runInference()}
          >
            {pending === 'inference' ? <Spinner /> : null} Run test inference
          </button>
        </div>
        {inferenceReason ? <Notice tone="info">{inferenceReason}</Notice> : null}

        {testInference !== null ? (
          testInference.kind === 'completed' ? (
            <div className="stack">
              <div className="row">
                <strong>Completion</strong>
                <span>{testInference.response.completion}</span>
              </div>
              <div className="row">
                <strong>Finish reason</strong>
                <span>{describeFinishReason(testInference.response.finishReason)}</span>
              </div>
              <div className="row">
                <strong>Duration</strong>
                <span>{testInference.response.durationMs} ms</span>
              </div>
              <div className="row">
                <strong>Provider/model</strong>
                <span>
                  {testInference.response.providerId} / {testInference.response.modelId}
                </span>
              </div>
            </div>
          ) : (
            <div className="row">
              <strong>Failure reason</strong>
              <span>{testInference.reason}</span>
            </div>
          )
        ) : null}
      </div>
    </Card>
  );
}
