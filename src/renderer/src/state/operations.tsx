/**
 * State for the Operations screen.
 *
 * Deliberately a second, separate context rather than a slice of the main store.
 * Two reasons, and both are about blast radius:
 *
 *  * **Isolation.** A failure loading targets, or a probe that never answers,
 *    must not be able to leave Projects, Tasks, Run or Settings in a bad state.
 *    Nothing here writes into the development workflow's state at all.
 *  * **Survival.** It is mounted above the router, so a request that is still in
 *    flight is still in flight after the user visits another section and comes
 *    back. If this lived inside the screen, navigating away and returning would
 *    forget the request and let a second one start on top of the first.
 *
 * Five ideas do the work, and each replaced something that looked right.
 *
 * **A load has a phase, not a pair of booleans.** "No data and not loading" is
 * true both before the first attempt and after a failed one, so an effect that
 * fires on that condition retries for ever, hammering a backend that has just
 * said no. The phase tells the two apart, and only `idle` starts a request.
 *
 * **A list is complete or it is not, and that is tracked separately.** A first
 * response discarded because a write overtook it leaves only what the write
 * added. Announcing that as the registry hides every existing registration.
 *
 * **Local request lifetime is not backend execution state.** A run the backend
 * reports as `running` blocks its target even though nothing is in flight in
 * this renderer — and a bounded history page that omits a run it once showed is
 * not evidence that the run finished.
 *
 * **An unknown outcome holds its claim until something confirms it.** Releasing
 * on the way into reconciliation lets a second write start against a target
 * whose state nobody knows yet.
 *
 * **Anything that can arrive late is keyed by target id**, so an answer for A
 * writes A's slot and can never be painted under B.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { SerializedError } from "@shared/domain/errors";
import type {
  NewOperationTargetInput,
  OperationEnvironment,
  OperationTarget,
  OperationTargetPatch,
} from "@shared/domain/operations";
import type {
  DiagnosticProbeId,
  OperationDiagnosticRun,
} from "@shared/domain/operations-diagnostics";
import type { IpcChannel, IpcInput, IpcResponseMap } from "@shared/ipc";
import { call, describeError } from "../lib/api";

/**
 * How much history is shown.
 *
 * Well under the channel's ceiling, and shown to the user as "the last N",
 * because a list that silently stops is a list somebody will read as complete.
 */
export const HISTORY_LIMIT = 25;

/**
 * How far back a targeted search for one run may look.
 *
 * The ceiling `operations:listDiagnostics` accepts. Used only to answer one
 * question — did run X finish? — when the displayed page no longer contains it.
 * It never becomes the displayed page.
 */
export const HISTORY_DEEP_LIMIT = 500;

/**
 * How long a re-read may run before the screen stops calling itself busy.
 *
 * The bridge has no timeout of its own, so a request that never settles would
 * otherwise leave a spinner and a held claim for the life of the window. On
 * expiry the target stays blocked — nothing has been confirmed — but the block
 * becomes a stated uncertainty with a re-read the operator can trigger.
 */
export const RECONCILE_TIMEOUT_MS = 10_000;

/**
 * Where a load has got to.
 *
 * `error` is a resting state: it does not decay back into `idle`, so nothing
 * re-fires on the next render. Only an explicit Retry moves it on.
 */
export type LoadPhase = "idle" | "loading" | "loaded" | "error";

/** What a registry write is doing, so a conflicting action can be refused. */
export type WriteKind = "update" | "delete";

/** Which action's outcome is unknown. */
export type ActionKind = "create" | "update" | "delete" | "diagnostic";

/**
 * A run the backend has reported as running.
 *
 * Tracked by id, because the question is always about one particular run:
 * a later page still showing an already-finished run as running is stale, and
 * a page that has simply scrolled past it says nothing at all.
 */
export interface BackendRun {
  readonly runId: string;
  /** When the run started, as the backend recorded it. */
  readonly since: string;
  /** The most recent history read did not contain this run. */
  readonly omitted: boolean;
  /** A search to the channel's ceiling also failed to find it. */
  readonly searchedDeeply: boolean;
}

/**
 * An action whose outcome is genuinely unknown.
 *
 * Reserved for a call that fell over in transport, or a confirming read that
 * did not settle. A backend that answered "no" is a different thing entirely.
 */
export interface Unconfirmed {
  readonly action: ActionKind;
  readonly message: string;
  /** Whether the confirming read actually succeeded. Never assumed. */
  readonly listRefreshed: boolean;
}

/** The registration form's fields, held here while a create is unresolved. */
export interface RegistrationDraft {
  readonly name: string;
  /** Empty until the operator chooses. Never defaulted from a name or a path. */
  readonly environment: "" | OperationEnvironment;
  readonly databasePath: string;
}

interface OperationsState {
  readonly targetsPhase: LoadPhase;
  readonly targets: OperationTarget[];
  readonly targetsError: SerializedError | null;
  /** A load whose outcome is unknown because the call itself failed. */
  readonly targetsUncertain: string | null;
  /** A full list response has been accepted. Until then the list is partial. */
  readonly targetsComplete: boolean;
  readonly selectedTargetId: string | null;

  readonly historyPhase: Readonly<Record<string, LoadPhase>>;
  readonly history: Readonly<Record<string, OperationDiagnosticRun[]>>;
  readonly historyError: Readonly<Record<string, SerializedError | null>>;

  /** A diagnostic this renderer started, per target. */
  readonly running: Readonly<Record<string, boolean>>;
  /** A registry write this renderer started, per target. */
  readonly pendingWrite: Readonly<Record<string, WriteKind>>;
  /** A confirming read after an unknown outcome, per target. */
  readonly reconciling: Readonly<Record<string, boolean>>;
  readonly creating: boolean;

  /** A run the backend says is in progress, per target. */
  readonly backendRuns: Readonly<Record<string, BackendRun>>;
  /** Run ids proven finished, so a stale page cannot resurrect them. */
  readonly terminalRuns: Readonly<Record<string, true>>;

  readonly lastRun: Readonly<Record<string, OperationDiagnosticRun>>;
  readonly unconfirmed: Readonly<Record<string, Unconfirmed>>;
  /**
   * A lost diagnostic reply, per target, kept for the operator to read.
   *
   * Separate from `unconfirmed` on purpose. `unconfirmed` is a *block*, and a
   * successful history read answers it. This is a *statement* — that a request
   * this renderer made never came back — and it stays on screen until the
   * operator runs something else, because a message that clears itself the
   * moment the next read succeeds is a message nobody sees.
   */
  readonly uncertain: Readonly<Record<string, string>>;
  readonly runError: Readonly<Record<string, SerializedError>>;

  /** Survives a remount, so an unresolved registration is not retyped. */
  readonly createDraft: RegistrationDraft | null;
  readonly createUnconfirmed: Unconfirmed | null;
}

type Action =
  | { type: "targets-loading" }
  | { type: "targets"; targets: OperationTarget[] }
  | { type: "targets-error"; error: SerializedError }
  | { type: "targets-uncertain"; message: string }
  | { type: "targets-overtaken" }
  | { type: "select"; targetId: string | null }
  | { type: "target-upserted"; target: OperationTarget }
  | { type: "target-removed"; targetId: string }
  | { type: "history-loading"; targetId: string }
  | { type: "history"; targetId: string; runs: OperationDiagnosticRun[] }
  | { type: "history-error"; targetId: string; error: SerializedError }
  | { type: "running"; targetId: string; value: boolean }
  | { type: "pending-write"; targetId: string; kind: WriteKind | null }
  | { type: "reconciling"; targetId: string; value: boolean }
  | { type: "creating"; value: boolean }
  | { type: "backend-run"; targetId: string; run: BackendRun | null }
  | { type: "run-terminal"; runId: string }
  | { type: "run-finished"; targetId: string; run: OperationDiagnosticRun }
  | { type: "unconfirmed"; targetId: string; value: Unconfirmed | null }
  | { type: "uncertain"; targetId: string; message: string | null }
  | { type: "run-error"; targetId: string; error: SerializedError | null }
  | { type: "create-draft"; draft: RegistrationDraft | null }
  | { type: "create-unconfirmed"; value: Unconfirmed | null };

const initialState: OperationsState = {
  targetsPhase: "idle",
  targets: [],
  targetsError: null,
  targetsUncertain: null,
  targetsComplete: false,
  selectedTargetId: null,
  historyPhase: {},
  history: {},
  historyError: {},
  running: {},
  pendingWrite: {},
  reconciling: {},
  creating: false,
  backendRuns: {},
  terminalRuns: {},
  lastRun: {},
  unconfirmed: {},
  uncertain: {},
  runError: {},
  createDraft: null,
  createUnconfirmed: null,
};

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function byEnvironmentThenName(a: OperationTarget, b: OperationTarget): number {
  return (
    a.environment.localeCompare(b.environment) || a.name.localeCompare(b.name)
  );
}

/** Drop every unconfirmed registry write: a complete list read has settled them. */
function withoutRegistryDoubt(
  record: Readonly<Record<string, Unconfirmed>>,
): Record<string, Unconfirmed> {
  const next: Record<string, Unconfirmed> = {};
  for (const [targetId, entry] of Object.entries(record)) {
    if (entry.action === "diagnostic") next[targetId] = entry;
  }
  return next;
}

function reducer(state: OperationsState, action: Action): OperationsState {
  switch (action.type) {
    case "targets-loading":
      return {
        ...state,
        targetsPhase: "loading",
        targetsError: null,
        targetsUncertain: null,
      };

    case "targets":
      return {
        ...state,
        targetsPhase: "loaded",
        targetsComplete: true,
        targets: [...action.targets].sort(byEnvironmentThenName),
        targetsError: null,
        targetsUncertain: null,
        // A complete read of the registry is what an unknown write was waiting
        // for: whatever it did or did not do, this is the result.
        unconfirmed: withoutRegistryDoubt(state.unconfirmed),
        createUnconfirmed: null,
        // A target that has gone away cannot stay selected.
        selectedTargetId: action.targets.some(
          (target) => target.id === state.selectedTargetId,
        )
          ? state.selectedTargetId
          : null,
      };

    case "targets-error":
      return {
        ...state,
        targetsPhase: "error",
        targetsError: action.error,
        targetsUncertain: null,
      };

    case "targets-uncertain":
      return {
        ...state,
        targetsPhase: "error",
        targetsUncertain: action.message,
        targetsError: null,
      };

    /**
     * A response a write overtook, after the bounded re-read was spent.
     *
     * The write already put newer data on screen, so the load is over — but it
     * must not rest at `loading`, or the spinner never stops, and it must not
     * claim completeness, or existing registrations vanish from a list the
     * screen presents as the whole registry.
     */
    case "targets-overtaken":
      return {
        ...state,
        targetsPhase:
          state.targetsPhase === "loading" ? "loaded" : state.targetsPhase,
      };

    case "select":
      return { ...state, selectedTargetId: action.targetId };

    case "target-upserted": {
      const exists = state.targets.some(
        (target) => target.id === action.target.id,
      );
      const targets = exists
        ? state.targets.map((target) =>
            target.id === action.target.id ? action.target : target,
          )
        : [...state.targets, action.target];

      // Deliberately does not touch `targetsPhase` or `targetsComplete`: one
      // confirmed write is not a reading of the registry.
      return { ...state, targets: targets.sort(byEnvironmentThenName) };
    }

    case "target-removed":
      return {
        ...state,
        targets: state.targets.filter(
          (target) => target.id !== action.targetId,
        ),
        selectedTargetId:
          state.selectedTargetId === action.targetId
            ? null
            : state.selectedTargetId,
        history: withoutKey(state.history, action.targetId),
        historyPhase: withoutKey(state.historyPhase, action.targetId),
        lastRun: withoutKey(state.lastRun, action.targetId),
        // `backendRuns` is deliberately NOT cleared here. It is mirrored in a
        // ref that the synchronous guards read, and a reducer cannot reach that
        // ref — clearing one without the other is exactly how the screen and the
        // guard come to disagree. `deleteTarget` clears both together.
      };

    case "history-loading":
      return {
        ...state,
        historyPhase: { ...state.historyPhase, [action.targetId]: "loading" },
        historyError: withoutKey(state.historyError, action.targetId),
      };

    case "history":
      return {
        ...state,
        historyPhase: { ...state.historyPhase, [action.targetId]: "loaded" },
        history: { ...state.history, [action.targetId]: action.runs },
        // `unconfirmed` is deliberately NOT cleared here, for the same reason as
        // `backendRuns` above: it is mirrored in a ref the guards read. Clearing
        // only the store left the button enabled and the guard still closed, so
        // the next click reached no channel at all. `loadHistory` clears both.
      };

    case "history-error":
      return {
        ...state,
        historyPhase: { ...state.historyPhase, [action.targetId]: "error" },
        historyError: {
          ...state.historyError,
          [action.targetId]: action.error,
        },
      };

    case "running":
      return {
        ...state,
        running: { ...state.running, [action.targetId]: action.value },
      };

    case "pending-write":
      return {
        ...state,
        pendingWrite:
          action.kind === null
            ? withoutKey(state.pendingWrite, action.targetId)
            : { ...state.pendingWrite, [action.targetId]: action.kind },
      };

    case "reconciling":
      return {
        ...state,
        reconciling: action.value
          ? { ...state.reconciling, [action.targetId]: true }
          : withoutKey(state.reconciling, action.targetId),
      };

    case "creating":
      return { ...state, creating: action.value };

    case "backend-run":
      return {
        ...state,
        backendRuns:
          action.run === null
            ? withoutKey(state.backendRuns, action.targetId)
            : { ...state.backendRuns, [action.targetId]: action.run },
      };

    case "run-terminal":
      return {
        ...state,
        terminalRuns: { ...state.terminalRuns, [action.runId]: true },
      };

    case "run-finished":
      return {
        ...state,
        lastRun: { ...state.lastRun, [action.targetId]: action.run },
        runError: withoutKey(state.runError, action.targetId),
      };

    case "run-error":
      return {
        ...state,
        runError:
          action.error === null
            ? withoutKey(state.runError, action.targetId)
            : { ...state.runError, [action.targetId]: action.error },
      };

    case "unconfirmed":
      return {
        ...state,
        unconfirmed:
          action.value === null
            ? withoutKey(state.unconfirmed, action.targetId)
            : { ...state.unconfirmed, [action.targetId]: action.value },
      };

    case "uncertain":
      return {
        ...state,
        uncertain:
          action.message === null
            ? withoutKey(state.uncertain, action.targetId)
            : { ...state.uncertain, [action.targetId]: action.message },
      };

    case "create-draft":
      return { ...state, createDraft: action.draft };

    case "create-unconfirmed":
      return { ...state, createUnconfirmed: action.value };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Talking to the main process                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three ways a call can end, kept apart on purpose.
 *
 * `refused` is the backend answering "no" — a fact about the request. `unknown`
 * is the call itself failing, where whether the work happened is genuinely not
 * known. Reporting the two as the same thing is how a UI ends up telling
 * somebody nothing was written when something was.
 */
type Attempt<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "refused"; readonly error: SerializedError }
  | { readonly kind: "unknown"; readonly message: string };

async function attempt<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>,
): Promise<Attempt<IpcResponseMap[C]>> {
  try {
    const result = await call(channel, input);
    return result.ok
      ? { kind: "ok", data: result.data }
      : { kind: "refused", error: result.error };
  } catch (error) {
    // `call` normally resolves with a discriminated result, but a bridge that
    // has gone away rejects. Nothing below may be left half-finished by that.
    return { kind: "unknown", message: describeError(error).message };
  }
}

/**
 * Stop waiting after `ms`, without cancelling the work.
 *
 * The bridge has no timeout, so a request that never settles would hold a claim
 * and a spinner for ever. The underlying call is left to finish: its own
 * sequence guard decides whether a late answer is still worth applying.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const UNCERTAIN_MESSAGE =
  "The request did not come back, so whether it was applied is unknown.";

const BLOCKED: SerializedError = {
  code: "VALIDATION_FAILED",
  message: "Another action for this target is still in progress.",
  remediation: "Wait for it to finish, then try again.",
};

function unconfirmedError(entry: Unconfirmed): SerializedError {
  return {
    code: "INTERNAL",
    message: entry.message,
    remediation: entry.listRefreshed
      ? "The registry has been re-read. Check the current state before trying again."
      : "The registry could NOT be re-read, so the current state is still unknown. Re-read it before trying again.",
    details: entry.message,
  };
}

/* -------------------------------------------------------------------------- */
/* The context                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a write attempt produced.
 *
 * Returned to the caller rather than stored centrally: a refusal belongs to the
 * panel that asked for it, and a single shared slot put a refused delete under
 * the registration form as well, where it read as a reason the *new* target
 * could not be saved.
 */
export type WriteOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: SerializedError;
      readonly uncertain?: boolean;
    };

export interface OperationsValue extends OperationsState {
  readonly selectedTarget: OperationTarget | null;
  loadTargets(): Promise<void>;
  selectTarget(targetId: string | null): void;
  createTarget(
    input: NewOperationTargetInput,
  ): Promise<WriteOutcome<OperationTarget>>;
  updateTarget(
    targetId: string,
    patch: OperationTargetPatch,
  ): Promise<WriteOutcome<OperationTarget>>;
  deleteTarget(targetId: string): Promise<WriteOutcome<null>>;
  loadHistory(targetId: string): Promise<void>;
  runDiagnostic(targetId: string, probeId: DiagnosticProbeId): Promise<void>;
  /** Re-read the registry after an unknown outcome. Never repeats the write. */
  rereadRegistry(targetId?: string): Promise<void>;
  /** Give up tracking a run the history can no longer account for. */
  stopTrackingRun(targetId: string): void;
  /** The registration draft, kept here so an unresolved create survives a remount. */
  setCreateDraft(draft: RegistrationDraft | null): void;
  /** True while anything is in flight or unresolved for this target. */
  isBusy(targetId: string): boolean;
  /** Why this target is blocked, for the operator. Null when it is free. */
  blockedReason(targetId: string): string | null;
}

const OperationsContext = createContext<OperationsValue | null>(null);

export function OperationsProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  /**
   * One counter per target, so an older `listDiagnostics` answer for the *same*
   * target cannot land on top of a newer one.
   */
  const historySeq = useRef<Record<string, number>>({});

  /** The same, for the target list: two Refreshes may answer out of order. */
  const listSeq = useRef(0);

  /**
   * Bumped every time a registry write finishes.
   *
   * A `listTargets` that started before a write completed is describing a world
   * that no longer exists. Comparing the epoch across the call is what stops a
   * slow Refresh putting `Enabled` back after a confirmed Disable, restoring a
   * registration that was just removed, or dropping one that was just created.
   */
  const writeEpoch = useRef(0);

  /**
   * Synchronous mirrors of everything that blocks a target.
   *
   * React state is not visible to a second click in the same tick, and "the
   * button was disabled" is a rendering fact, not a guarantee. These are what
   * actually make a double click one request.
   */
  const runningRef = useRef<Record<string, boolean>>({});
  const writeRef = useRef<Record<string, WriteKind>>({});
  const backendRunRef = useRef<Record<string, BackendRun>>({});
  const unconfirmedRef = useRef<Record<string, Unconfirmed>>({});
  /**
   * Which runs are proven finished.
   *
   * A ref as well, because the evidence rules read it between two awaits, and
   * rendered state would answer with whatever was true at the last render —
   * which, for a page that arrives mid-flight, is the wrong moment entirely.
   */
  const terminalRunsRef = useRef<Record<string, true>>({});
  const creatingRef = useRef(false);
  const completeRef = useRef(false);

  /** The current selection, readable inside a callback without re-binding it. */
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = state.selectedTargetId;
  }, [state.selectedTargetId]);

  /* ------------------------------------------- guarded state, ref and store */

  const setBackendRun = useCallback(
    (targetId: string, run: BackendRun | null) => {
      if (run === null) delete backendRunRef.current[targetId];
      else backendRunRef.current[targetId] = run;
      dispatch({ type: "backend-run", targetId, run });
    },
    [],
  );

  const setUnconfirmed = useCallback(
    (targetId: string, value: Unconfirmed | null) => {
      if (value === null) delete unconfirmedRef.current[targetId];
      else unconfirmedRef.current[targetId] = value;
      dispatch({ type: "unconfirmed", targetId, value });
    },
    [],
  );

  const markTerminal = useCallback((runId: string) => {
    terminalRunsRef.current[runId] = true;
    dispatch({ type: "run-terminal", runId });
  }, []);

  /** Drop every unconfirmed registry write, in both places at once. */
  const clearRegistryDoubt = useCallback(() => {
    for (const targetId of Object.keys(unconfirmedRef.current)) {
      if (unconfirmedRef.current[targetId]?.action !== "diagnostic") {
        delete unconfirmedRef.current[targetId];
      }
    }
  }, []);

  /**
   * Is this target free to be acted on?
   *
   * A probe and a write may not touch the same target at once, in either order:
   * a probe reading a target that is being re-pointed would report on something
   * other than what the finished run claims it looked at. A run the backend is
   * still executing, and an outcome nobody has confirmed, block it just as
   * firmly — neither is something this renderer started, and neither is over.
   */
  const claim = useCallback(
    (targetId: string): boolean =>
      !runningRef.current[targetId] &&
      writeRef.current[targetId] === undefined &&
      backendRunRef.current[targetId] === undefined &&
      unconfirmedRef.current[targetId] === undefined,
    [],
  );

  /* ------------------------------------------------------------------ reads */

  /**
   * Read the target list.
   *
   * `retries` bounds the re-read taken when a write overtakes the very first
   * response — the only case where discarding an answer leaves a list that is
   * partial rather than merely slightly stale. Driven from inside the function
   * rather than from an effect, so a read error can never become a retry loop.
   * Returns whether a complete list is now on screen.
   */
  const loadTargets = useCallback(async (retries = 1): Promise<boolean> => {
    // Named inner function so the bounded re-read below can call itself; the
    // memoised const cannot legally refer to itself.
    const readOnce = async (remaining: number): Promise<boolean> => {
      const seq = ++listSeq.current;
      const epoch = writeEpoch.current;
      dispatch({ type: "targets-loading" });

      const outcome = await attempt("operations:listTargets", {});

      // A newer list request has already been made and owns the phase. Returning
      // the phase to `idle` here would be read by the mount effect as "never
      // loaded" and start a third request on top of the second.
      if (listSeq.current !== seq) return completeRef.current;

      // A write finished while this was in the air. What is on screen came from
      // that write and is newer than anything this response can say.
      if (writeEpoch.current !== epoch) {
        // Before the first complete read, "what is on screen" is only what that
        // write added — announcing it as the registry would hide every existing
        // registration. One bounded re-read, then say plainly that it is partial.
        if (!completeRef.current && remaining > 0)
          return readOnce(remaining - 1);
        dispatch({ type: "targets-overtaken" });
        return completeRef.current;
      }

      if (outcome.kind === "ok") {
        completeRef.current = true;
        clearRegistryDoubt();
        dispatch({ type: "targets", targets: outcome.data });
        return true;
      }

      if (outcome.kind === "refused")
        dispatch({ type: "targets-error", error: outcome.error });
      else dispatch({ type: "targets-uncertain", message: outcome.message });
      return false;
    };

    return readOnce(retries);
  }, [clearRegistryDoubt]);

  /**
   * Decide what a history page says about a run the backend was executing.
   *
   * Split out because the rules are the whole of defect 1: a page that shows
   * the run finished releases the block, a page that still shows it running
   * keeps it, and a page that has simply scrolled past it proves nothing.
   */
  const applyRunEvidence = useCallback(
    async (
      targetId: string,
      runs: OperationDiagnosticRun[],
      isCurrent: () => boolean,
    ): Promise<void> => {
      const tracked = backendRunRef.current[targetId];

      // Read from the ref, not from rendered state: this runs between awaits,
      // and a run proven finished since the last render is still finished.
      const running = runs.find(
        (run) =>
          run.status === "running" &&
          terminalRunsRef.current[run.id] !== true,
      );
      if (running !== undefined) {
        setBackendRun(targetId, {
          runId: running.id,
          since: running.startedAt,
          omitted: false,
          searchedDeeply: false,
        });
        return;
      }

      if (tracked === undefined) return;

      const seen = runs.find((run) => run.id === tracked.runId);
      if (seen !== undefined) {
        // Present, and not running: that is the completion evidence.
        markTerminal(tracked.runId);
        setBackendRun(targetId, null);
        return;
      }

      // Absent. A bounded page omitting a run is not proof it finished, so look
      // once as far back as the channel allows before saying anything. This is
      // a single extra read, never a poll.
      if (!tracked.searchedDeeply) {
        const deep = await attempt("operations:listDiagnostics", {
          targetId,
          limit: HISTORY_DEEP_LIMIT,
        });

        // Everything below writes the guard, and this search is slow enough to
        // be overtaken by a refresh that has already settled the question. A
        // superseded search re-blocking a target the newer read just released
        // is worse than no search at all, so it stops here and writes nothing.
        if (!isCurrent()) return;
        if (terminalRunsRef.current[tracked.runId] === true) return;

        if (deep.kind === "ok") {
          const found = deep.data.find((run) => run.id === tracked.runId);
          if (found !== undefined && found.status !== "running") {
            markTerminal(tracked.runId);
            setBackendRun(targetId, null);
            return;
          }
          if (found !== undefined) return; // still running, block stands
        }

        // Not found even at the ceiling, or the search itself failed. The block
        // stands, and the screen now offers the operator an explicit way out —
        // but only if the run is still the one being tracked.
        if (backendRunRef.current[targetId]?.runId !== tracked.runId) return;
        setBackendRun(targetId, {
          ...tracked,
          omitted: true,
          searchedDeeply: true,
        });
        return;
      }

      setBackendRun(targetId, { ...tracked, omitted: true });
    },
    [setBackendRun, markTerminal],
  );

  const loadHistory = useCallback(
    async (targetId: string): Promise<boolean> => {
      const seq = (historySeq.current[targetId] ?? 0) + 1;
      historySeq.current[targetId] = seq;

      dispatch({ type: "history-loading", targetId });
      const outcome = await attempt("operations:listDiagnostics", {
        targetId,
        limit: HISTORY_LIMIT,
      });

      // Superseded: the newer request owns this target's phase (see above).
      if (historySeq.current[targetId] !== seq) return false;

      if (outcome.kind === "ok") {
        await applyRunEvidence(
          targetId,
          outcome.data,
          () => historySeq.current[targetId] === seq,
        );
        if (historySeq.current[targetId] !== seq) return false;

        // The read succeeded, so an unknown diagnostic outcome has been answered
        // as well as it can be. Cleared through the setter, which is the only
        // thing that keeps the guard and the screen saying the same thing.
        if (unconfirmedRef.current[targetId]?.action === "diagnostic") {
          setUnconfirmed(targetId, null);
        }
        dispatch({ type: "history", targetId, runs: outcome.data });
        return true;
      }

      // A failed read is not completion evidence, so nothing about a tracked
      // run changes here.
      dispatch({
        type: "history-error",
        targetId,
        error:
          outcome.kind === "refused"
            ? outcome.error
            : { code: "INTERNAL", message: outcome.message },
      });
      return false;
    },
    [applyRunEvidence, setUnconfirmed],
  );

  /**
   * Re-read after an outcome nobody knows.
   *
   * Never throws, never retries the thing that failed — reading is safe,
   * repeating a write is not — and reports honestly whether the read worked.
   */
  const reconcile = useCallback(
    async (targetId?: string): Promise<boolean> => {
      try {
        const listed = await loadTargets();
        if (targetId === undefined) return listed;
        const read = await loadHistory(targetId);
        return listed && read;
      } catch {
        // `attempt` swallows rejections, so this is unreachable in practice.
        // It exists so that no path out of a guarded region can skip the
        // release below by throwing.
        return false;
      }
    },
    [loadTargets, loadHistory],
  );

  /** Reconcile, but stop calling the screen busy if the read never settles. */
  const boundedReconcile = useCallback(
    async (targetId?: string): Promise<boolean> =>
      withTimeout(reconcile(targetId), RECONCILE_TIMEOUT_MS, () => false),
    [reconcile],
  );

  /* ----------------------------------------------------------------- writes */

  const createTarget = useCallback(
    async (
      input: NewOperationTargetInput,
    ): Promise<WriteOutcome<OperationTarget>> => {
      if (creatingRef.current) return { ok: false, error: BLOCKED };
      if (state.createUnconfirmed !== null) {
        return { ok: false, error: unconfirmedError(state.createUnconfirmed) };
      }
      creatingRef.current = true;
      dispatch({ type: "creating", value: true });

      // What was selected when Save was pressed. If the user has moved on by the
      // time this lands, the target is still registered — it simply does not
      // yank them away from what they are now looking at.
      const selectionAtStart = selectedRef.current;

      try {
        const result = await attempt("operations:createTarget", input);

        if (result.kind === "ok") {
          writeEpoch.current += 1;
          dispatch({ type: "target-upserted", target: result.data });
          dispatch({ type: "create-draft", draft: null });
          if (selectedRef.current === selectionAtStart) {
            dispatch({ type: "select", targetId: result.data.id });
          }
          return { ok: true, data: result.data };
        }

        if (result.kind === "refused")
          return { ok: false, error: result.error };

        // Unknown: it may well have been registered. The claim is held across
        // the confirming read, so a second Save cannot start meanwhile — not
        // even after the form has been unmounted and remounted.
        writeEpoch.current += 1;
        const pending: Unconfirmed = {
          action: "create",
          message: UNCERTAIN_MESSAGE,
          listRefreshed: false,
        };
        dispatch({ type: "create-unconfirmed", value: pending });
        const refreshed = await boundedReconcile();
        const settled: Unconfirmed = { ...pending, listRefreshed: refreshed };
        // A successful list read clears this in the reducer; if it failed, the
        // doubt stays on screen with a re-read the operator can trigger.
        if (!refreshed)
          dispatch({ type: "create-unconfirmed", value: settled });
        return { ok: false, uncertain: true, error: unconfirmedError(settled) };
      } finally {
        creatingRef.current = false;
        dispatch({ type: "creating", value: false });
      }
    },
    [boundedReconcile, state.createUnconfirmed],
  );

  /**
   * The shared body of `updateTarget` and `deleteTarget`: claim, act, confirm,
   * release.
   *
   * The claim is held across the confirming read. Releasing first — as this
   * once did, on the theory that the re-read would be refused by the write's
   * own guard — let a second write start against a target whose state nobody
   * knew yet. Reads never call `claim()`, so holding it costs nothing.
   */
  const write = useCallback(
    async <T,>(
      targetId: string,
      kind: WriteKind,
      perform: () => Promise<Attempt<T>>,
      apply: (data: T) => void,
    ): Promise<WriteOutcome<T>> => {
      if (!claim(targetId)) {
        const pending = unconfirmedRef.current[targetId];
        return {
          ok: false,
          error: pending ? unconfirmedError(pending) : BLOCKED,
        };
      }
      writeRef.current[targetId] = kind;
      dispatch({ type: "pending-write", targetId, kind });

      try {
        const outcome = await perform();

        if (outcome.kind === "ok") {
          writeEpoch.current += 1;
          apply(outcome.data);
          return { ok: true, data: outcome.data };
        }

        if (outcome.kind === "refused")
          return { ok: false, error: outcome.error };

        writeEpoch.current += 1;
        const pending: Unconfirmed = {
          action: kind,
          message: UNCERTAIN_MESSAGE,
          listRefreshed: false,
        };
        setUnconfirmed(targetId, pending);
        dispatch({ type: "reconciling", targetId, value: true });
        try {
          const refreshed = await boundedReconcile(targetId);
          const settled: Unconfirmed = { ...pending, listRefreshed: refreshed };
          if (refreshed) setUnconfirmed(targetId, null);
          else setUnconfirmed(targetId, settled);
          return {
            ok: false,
            uncertain: true,
            error: unconfirmedError(settled),
          };
        } finally {
          dispatch({ type: "reconciling", targetId, value: false });
        }
      } finally {
        // Released only here — after any confirming read has settled or timed
        // out — and unconditionally, so no path out of this region can leave
        // the target claimed for the life of the window.
        delete writeRef.current[targetId];
        dispatch({ type: "pending-write", targetId, kind: null });
      }
    },
    [claim, boundedReconcile, setUnconfirmed],
  );

  const updateTarget = useCallback(
    async (
      targetId: string,
      patch: OperationTargetPatch,
    ): Promise<WriteOutcome<OperationTarget>> =>
      write(
        targetId,
        "update",
        () => attempt("operations:updateTarget", { targetId, patch }),
        (target) => dispatch({ type: "target-upserted", target }),
      ),
    [write],
  );

  const deleteTarget = useCallback(
    async (targetId: string): Promise<WriteOutcome<null>> =>
      write(
        targetId,
        "delete",
        async (): Promise<Attempt<null>> => {
          const result = await attempt("operations:deleteTarget", { targetId });
          return result.kind === "ok" ? { kind: "ok", data: null } : result;
        },
        () => {
          // The ref first, then the store: a registration that no longer exists
          // must not leave a guard entry behind under its id.
          setBackendRun(targetId, null);
          dispatch({ type: "target-removed", targetId });
        },
      ),
    [write, setBackendRun],
  );

  /* ------------------------------------------------------------ diagnostics */

  const runDiagnostic = useCallback(
    async (targetId: string, probeId: DiagnosticProbeId) => {
      // Checked against the refs, not the rendered state: two clicks in one tick
      // both see the same React state, and only one may proceed. A write, a
      // backend run and an unconfirmed outcome each block a probe too.
      if (!claim(targetId)) return;
      runningRef.current[targetId] = true;

      dispatch({ type: "running", targetId, value: true });
      dispatch({ type: "run-error", targetId, error: null });
      dispatch({ type: "uncertain", targetId, message: null });

      try {
        const outcome = await attempt("operations:runDiagnostic", {
          targetId,
          probeId,
        });

        if (outcome.kind === "ok") {
          dispatch({ type: "run-finished", targetId, run: outcome.data });
          // The domain permits a persisted run to still be `running`. Treating
          // every returned run as finished would re-enable this target while
          // the backend was still working.
          if (outcome.data.status === "running") {
            setBackendRun(targetId, {
              runId: outcome.data.id,
              since: outcome.data.startedAt,
              omitted: false,
              searchedDeeply: false,
            });
          } else {
            markTerminal(outcome.data.id);
            if (backendRunRef.current[targetId]?.runId === outcome.data.id) {
              setBackendRun(targetId, null);
            }
          }
        } else if (outcome.kind === "refused") {
          // The backend answered, and said no. That is a fact about the request
          // — a disabled target, an unknown probe — not an unknown outcome.
          dispatch({ type: "run-error", targetId, error: outcome.error });
        } else {
          // The call fell over. Whether the probe ran is genuinely unknown, and
          // saying "nothing happened" would be a claim nothing supports.
          dispatch({ type: "uncertain", targetId, message: outcome.message });
          setUnconfirmed(targetId, {
            action: "diagnostic",
            message: UNCERTAIN_MESSAGE,
            listRefreshed: false,
          });
        }

        // The recorded history is the thing worth re-reading, whatever happened,
        // and it is what tells us whether a run is still going. Never a retry of
        // the diagnostic itself. Read while the claim is still held.
        await withTimeout(
          loadHistory(targetId),
          RECONCILE_TIMEOUT_MS,
          () => false,
        );
      } finally {
        runningRef.current[targetId] = false;
        dispatch({ type: "running", targetId, value: false });
      }
    },
    [claim, loadHistory, setBackendRun, setUnconfirmed, markTerminal],
  );

  /* -------------------------------------------------------------- recovery */

  const rereadRegistry = useCallback(
    async (targetId?: string) => {
      const refreshed = await boundedReconcile(targetId);
      if (targetId !== undefined) {
        const pending = unconfirmedRef.current[targetId];
        if (pending !== undefined)
          setUnconfirmed(targetId, { ...pending, listRefreshed: refreshed });
      }
      if (state.createUnconfirmed !== null && !refreshed) {
        dispatch({
          type: "create-unconfirmed",
          value: { ...state.createUnconfirmed, listRefreshed: false },
        });
      }
    },
    [boundedReconcile, setUnconfirmed, state.createUnconfirmed],
  );

  /**
   * Give up tracking a run the history can no longer account for.
   *
   * The alternative is a target locked for the life of the window: a run that
   * finished and then fell past the channel's deepest page can never be found
   * again, and nothing here polls. This is the operator saying so explicitly —
   * it is offered only once a deep search has already failed, and it records
   * nothing about whether the run succeeded.
   */
  const stopTrackingRun = useCallback(
    (targetId: string) => {
      setBackendRun(targetId, null);
    },
    [setBackendRun],
  );

  const setCreateDraft = useCallback((draft: RegistrationDraft | null) => {
    dispatch({ type: "create-draft", draft });
  }, []);

  /* ---------------------------------------------------------------- reading */

  const isBusy = useCallback(
    (targetId: string): boolean =>
      state.running[targetId] === true ||
      state.pendingWrite[targetId] !== undefined ||
      state.reconciling[targetId] === true ||
      state.backendRuns[targetId] !== undefined ||
      state.unconfirmed[targetId] !== undefined,
    [
      state.running,
      state.pendingWrite,
      state.reconciling,
      state.backendRuns,
      state.unconfirmed,
    ],
  );

  const blockedReason = useCallback(
    (targetId: string): string | null => {
      const backendRun = state.backendRuns[targetId];
      if (backendRun !== undefined) {
        if (backendRun.searchedDeeply) {
          return "A diagnostic was running on this target and the recorded history no longer accounts for it. Whether it finished is unknown.";
        }
        if (backendRun.omitted) {
          return "A diagnostic was running on this target and the last refresh did not contain it. Whether it finished is unknown.";
        }
        return "A diagnostic is running on this target.";
      }

      // Checked before the record below: while the confirming read is still
      // in flight it has not failed, and saying it could not be read would
      // announce an outcome nobody has yet.
      if (state.reconciling[targetId] === true) {
        const attempted = state.unconfirmed[targetId];
        return attempted === undefined
          ? "Re-reading the registry."
          : `${attempted.message} The registry is being re-read now.`;
      }

      const pending = state.unconfirmed[targetId];
      if (pending !== undefined) {
        return pending.listRefreshed
          ? `${pending.message} The registry has been re-read.`
          : `${pending.message} The registry could not be re-read, so the current state is still unknown.`;
      }
      if (state.pendingWrite[targetId] !== undefined)
        return "A change is being saved.";
      if (state.running[targetId] === true)
        return "A diagnostic is running on this target.";
      return null;
    },
    [
      state.backendRuns,
      state.unconfirmed,
      state.reconciling,
      state.pendingWrite,
      state.running,
    ],
  );

  const value = useMemo<OperationsValue>(
    () => ({
      ...state,
      selectedTarget:
        state.targets.find((target) => target.id === state.selectedTargetId) ??
        null,
      loadTargets: async () => {
        // A Refresh the operator asked for gets its own re-read budget.
        await loadTargets();
      },
      selectTarget: (targetId) => dispatch({ type: "select", targetId }),
      createTarget,
      updateTarget,
      deleteTarget,
      loadHistory: async (targetId) => {
        await loadHistory(targetId);
      },
      runDiagnostic,
      rereadRegistry,
      stopTrackingRun,
      setCreateDraft,
      isBusy,
      blockedReason,
    }),
    [
      state,
      loadTargets,
      createTarget,
      updateTarget,
      deleteTarget,
      loadHistory,
      runDiagnostic,
      rereadRegistry,
      stopTrackingRun,
      setCreateDraft,
      isBusy,
      blockedReason,
    ],
  );

  return (
    <OperationsContext.Provider value={value}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations(): OperationsValue {
  const value = useContext(OperationsContext);
  if (!value)
    throw new Error("useOperations must be used inside <OperationsProvider>.");
  return value;
}
