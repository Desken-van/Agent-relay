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
import { normalizeTargetPath } from "@shared/domain/operations";
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
 * How long a diagnostic request may go unanswered.
 *
 * Generous, because a probe legitimately takes time. Expiry says only that
 * THIS renderer stopped waiting: the backend operation is not cancelled, the
 * outcome becomes unknown rather than failed, and the target stays blocked.
 */
export const DIAGNOSTIC_TIMEOUT_MS = 60_000;

/**
 * How long a registry write may go unanswered.
 *
 * The registry write is a synchronous SQLite call behind one IPC hop, so this
 * is generous rather than tight. It bounds only how long the SCREEN waits: the
 * bridge cannot be cancelled, so on expiry the request is still out there, the
 * target stays blocked, and the write is never sent again. Without it, a bridge
 * that never answered held the claim — and the `finally` that releases it — for
 * the life of the window.
 */
export const WRITE_TIMEOUT_MS = 30_000;

/**
 * How long any single read may go unanswered.
 *
 * Reads had no bound at all, which is how a bridge that never answered could
 * leave `Loading targets…` on screen for the life of the window, and how a
 * 500-row search for one run could hold a target blocked with no way out — the
 * very lock-up the deep search exists to prevent. Expiry is this screen's
 * patience running out and nothing more: it is not an answer, it proves no
 * terminal state, and it always leaves an explicit way to ask again.
 */
export const READ_TIMEOUT_MS = 10_000;

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
  /**
   * The request is still in flight; this renderer merely stopped waiting.
   *
   * Different from a reply that was lost, where the request is over and the
   * recorded history is the best evidence available. Here the operation may
   * still be running, so a history page that happens not to mention it is not
   * grounds to release the target and let a second one start on top.
   */
  readonly outstanding?: boolean;
}

/**
 * What re-reading the registry proved about an unconfirmed registration.
 *
 * Three genuinely different answers, and the form says which. Reporting them
 * as one "something went wrong" is how an operator ends up submitting a second
 * time to find out.
 */
export type CreateResolution =
  /** The read failed too, so the outcome is still nobody's knowledge. */
  | { readonly kind: "unconfirmed" }
  /** A target matching the draft appeared where there was none: it was applied. */
  | { readonly kind: "registered"; readonly targetId: string }
  /** That name is taken in that environment by a different target. */
  | { readonly kind: "conflict"; readonly targetId: string }
  /**
   * The identical registration was already there before the request was sent.
   *
   * Distinct from `registered`, and the distinction is the whole point: a row
   * that predates the request is not evidence the request created it. The
   * registry refuses a second `(environment, name)`, so what actually happened
   * is that this submission was refused and the reply was lost.
   */
  | { readonly kind: "already-existed"; readonly targetId: string }
  /** A complete list without it: the create never happened. */
  | { readonly kind: "not-applied" };

/**
 * A complete list response, and when it was accepted.
 *
 * Kept as a pair because both halves are needed to reason about a write: the
 * stamp says whether a read is newer than the request, and the rows say what
 * the registry held before it.
 */
interface ListRead {
  readonly stamp: number;
  readonly targets: OperationTarget[];
}

/**
 * What one list read actually established — never a boolean.
 *
 * A boolean cannot tell "this read succeeded" from "a complete list existed at
 * some point", and conflating the two is how a *superseded* read came to stand
 * as the confirmation of an unknown write: the branch returned the global
 * completeness flag, and reconciliation read it as its own evidence. Only
 * `accepted` is evidence, and it carries the stamp of the read that produced
 * it, so a caller can tell whether it is looking at its own answer.
 */
type ListEvidence =
  /** This read answered, was still current, and its rows are on screen. */
  | { readonly kind: "accepted"; readonly stamp: number; readonly targets: OperationTarget[] }
  /** A newer read owns the phase. This one concludes nothing. */
  | { readonly kind: "superseded" }
  /** A write landed while this was in the air; its rows are older than the screen. */
  | { readonly kind: "overtaken" }
  /** The backend refused, or the call fell over. */
  | { readonly kind: "failed" }
  /** The wait ran out. The request may still answer; this read proves nothing. */
  | { readonly kind: "timeout" };

/** The same, for the pair of reads a target's reconciliation needs. */
interface ReconcileEvidence {
  readonly list: ListEvidence;
  /** Whether the target's history read also answered. Absent when not asked for. */
  readonly historyRead: boolean;
}

/**
 * What a completed read-back proves about an unknown update or delete.
 *
 * Deliberately not a boolean either. "The read succeeded" says nothing about
 * whether the change took effect, and treating it as though it did let the
 * screen drop the doubt — and, with it, the error notice — over a mutation
 * that never applied. Each of these is a different thing to tell an operator.
 */
export type WriteResolution =
  /** The registry now holds what was asked for. Not proof THIS request did it. */
  | { readonly kind: "matches-request" }
  /** The target is still exactly as it was before the request. */
  | { readonly kind: "unchanged" }
  /** Present, but matching neither the request nor the state before it. */
  | { readonly kind: "conflicting" }
  /** No complete current read, so the registry's state is still unknown. */
  | { readonly kind: "inconclusive" };

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
  /**
   * A refusal that arrived after this screen had stopped waiting for it.
   *
   * The caller has long since been handed an uncertain outcome, so there is no
   * return value left to put this in. Dropping it would leave the operator with
   * "nobody knows" for a request the backend had in fact answered, and said no to.
   */
  readonly lateWriteError: Readonly<Record<string, SerializedError>>;
  /**
   * What the confirming read-back established about an unknown write.
   *
   * Kept per target and stated in its own words, because "the read worked" is
   * not "the change took effect": the registry can come back holding the
   * requested state, holding exactly what it held before, or holding something
   * that is neither.
   */
  readonly writeResolution: Readonly<Record<string, WriteResolution>>;
  /** True while any registry mutation is in flight, anywhere. */
  readonly registryBusy: boolean;

  /** Survives a remount, so an unresolved registration is not retyped. */
  readonly createDraft: RegistrationDraft | null;
  /** A registration refusal that arrived after the screen stopped waiting. */
  readonly createLateError: SerializedError | null;
  readonly createUnconfirmed: Unconfirmed | null;
  /** What the confirming read established about it. Null until it has run. */
  readonly createResolution: CreateResolution | null;
  /**
   * A confirming read for the registration is in flight.
   *
   * Its own flag rather than a corner of `createUnconfirmed`, because "the
   * registry could not be re-read" and "the registry is being re-read" are
   * different things to tell somebody, and the form used to say the first while
   * the first read was still outstanding.
   */
  readonly createReconciling: boolean;
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
  | {
      type: "late-write-error";
      targetId: string;
      error: SerializedError | null;
    }
  | { type: "write-resolution"; targetId: string; value: WriteResolution | null }
  | { type: "registry-busy"; value: boolean }
  | { type: "create-late-error"; error: SerializedError | null }
  | { type: "create-draft"; draft: RegistrationDraft | null }
  | { type: "create-unconfirmed"; value: Unconfirmed | null }
  | { type: "create-resolution"; value: CreateResolution | null }
  | { type: "create-reconciling"; value: boolean };

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
  lateWriteError: {},
  writeResolution: {},
  registryBusy: false,
  createDraft: null,
  createLateError: null,
  createUnconfirmed: null,
  createResolution: null,
  createReconciling: false,
};

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** Does the form still hold exactly what was submitted? */
function draftMatches(
  draft: RegistrationDraft | null,
  input: NewOperationTargetInput | null,
): boolean {
  if (draft === null || input === null) return false;
  return (
    draft.name.trim() === input.name &&
    draft.environment === input.environment &&
    // Both sides through the same normalisation the schema applied on the way
    // out. The draft holds what was typed; `input` holds what the schema made
    // of it, and `C:\data\reports.sqlite\` and `C:\data\reports.sqlite` are one
    // path spelled twice. Comparing the two spellings told an operator who had
    // changed nothing that the form was theirs to keep, and left a stale entry
    // in front of a target that had in fact been registered.
    normalizeTargetPath(draft.databasePath) === input.config.databasePath
  );
}

/**
 * Does this target already hold everything the patch asked for?
 *
 * Only the keys the patch actually carried are compared: a patch that changed
 * one field says nothing about the others, and demanding they match too would
 * report a successful edit as a conflict.
 */
function matchesPatch(
  target: OperationTarget,
  patch: OperationTargetPatch,
): boolean {
  if (patch.name !== undefined && target.name !== patch.name) return false;
  if (patch.environment !== undefined && target.environment !== patch.environment) {
    return false;
  }
  if (patch.enabled !== undefined && target.enabled !== patch.enabled) return false;
  if (
    patch.credentialRef !== undefined &&
    target.credentialRef !== patch.credentialRef
  ) {
    return false;
  }
  if (patch.config !== undefined) {
    if (target.config.adapterType !== patch.config.adapterType) return false;
    if (target.config.version !== patch.config.version) return false;
    if (target.config.databasePath !== patch.config.databasePath) return false;
  }
  return true;
}

/** Is this the same registration, field for field, as the one recorded before? */
function sameRegistration(a: OperationTarget, b: OperationTarget): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.environment === b.environment &&
    a.enabled === b.enabled &&
    a.credentialRef === b.credentialRef &&
    a.config.adapterType === b.config.adapterType &&
    a.config.databasePath === b.config.databasePath
  );
}

function byEnvironmentThenName(a: OperationTarget, b: OperationTarget): number {
  return (
    a.environment.localeCompare(b.environment) || a.name.localeCompare(b.name)
  );
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
        // Deliberately does NOT clear `unconfirmed`. A list read is only part
        // of a confirmation — the history read may still be outstanding — and
        // declaring the doubt settled here released the target early. The flow
        // that asked for the reconciliation decides when it is over.
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
        lateWriteError: withoutKey(state.lateWriteError, action.targetId),
        writeResolution: withoutKey(state.writeResolution, action.targetId),
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

    case "late-write-error":
      return {
        ...state,
        lateWriteError:
          action.error === null
            ? withoutKey(state.lateWriteError, action.targetId)
            : { ...state.lateWriteError, [action.targetId]: action.error },
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

    case "write-resolution":
      return {
        ...state,
        writeResolution:
          action.value === null
            ? withoutKey(state.writeResolution, action.targetId)
            : { ...state.writeResolution, [action.targetId]: action.value },
      };

    case "registry-busy":
      return { ...state, registryBusy: action.value };

    case "create-late-error":
      return { ...state, createLateError: action.error };

    case "create-resolution":
      return { ...state, createResolution: action.value };

    case "create-reconciling":
      return { ...state, createReconciling: action.value };

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

/**
 * Wait for a request, but not for ever, and apply its answer exactly once.
 *
 * The one mechanism behind every bounded call on this screen — reads and writes
 * alike — so that there is a single place where "the wait ended" is kept apart
 * from "the work ended". `onAnswer` runs once, from whichever path reaches the
 * answer first, and is told whether the wait had already expired: a late answer
 * has no caller left to return to, so it has to write what it learned somewhere
 * the screen can show. The request is never cancelled and never repeated.
 */
async function runBounded<T>(
  request: Promise<T>,
  ms: number,
  onAnswer: (value: T, afterExpiry: boolean) => void,
): Promise<{ readonly expired: boolean }> {
  let expired = false;
  let answered = false;

  void request.then((value) => {
    if (answered) return;
    answered = true;
    onAnswer(value, expired);
  });

  expired = await withTimeout(
    request.then(() => false),
    ms,
    () => true,
  );
  return { expired };
}

const UNCERTAIN_MESSAGE =
  "The request did not come back, so whether it was applied is unknown.";

/**
 * A write this screen stopped waiting for, which is not a write that stopped.
 *
 * Worded apart from `UNCERTAIN_MESSAGE` on purpose: there, the call itself
 * fell over and is over; here it is still in flight, and the difference decides
 * whether a subsequent read is allowed to settle the question.
 */
const LIST_TIMEOUT_MESSAGE =
  "The registry did not answer in time. It was not cancelled, so what is registered is still unknown.";

const HISTORY_TIMEOUT_MESSAGE =
  "The recorded history did not answer in time, so nothing here is evidence about the runs on this target.";

const WRITE_TIMEOUT_MESSAGE =
  "The change was not answered in time. It has not been cancelled, so whether it was applied is unknown.";

const REGISTRY_BUSY: SerializedError = {
  code: "VALIDATION_FAILED",
  message: "Another change to the registry is still in progress.",
  remediation:
    "Registrations, edits and removals are applied one at a time. Wait for the current one to finish, then try again.",
};

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
  /** The deep search in flight per target, by the run it is asking about. */
  const deepReadRef = useRef<Record<string, string>>({});
  /** A manual re-read in flight, so a second click does not start another. */
  const rereadRef = useRef<Record<string, true>>({});
  /** The draft as it stands now, readable after an await. */
  const createDraftRef = useRef<RegistrationDraft | null>(null);
  /** One counter per target, so a late diagnostic answer knows if it is stale. */
  const runSeq = useRef<Record<string, number>>({});
  /** The same for registry writes, so a late answer knows if it is stale. */
  const writeSeq = useRef<Record<string, number>>({});
  /** The same, for the registration, which has no target id to be keyed by. */
  const createSeq = useRef(0);
  /**
   * Which reconciliation currently owns a target, and which owns the create.
   *
   * A generation, not a boolean, because two recoveries can overlap: a manual
   * re-read started while an automatic one is still in the air. Without this
   * the older one wrote its conclusion over the newer one's, and its finaliser
   * cleared the newer one's in-progress flag — reopening a target while the
   * newer read, and possibly the original write, were both still outstanding.
   */
  const reconcileSeq = useRef<Record<string, number>>({});
  const createReconcileSeq = useRef(0);
  /**
   * The one registry mutation allowed to be in flight, whatever its shape.
   *
   * Create had no arbitration with update and delete at all: it checked only
   * its own flag, so a registration could be sent while an edit or a removal
   * of the same `(environment, name)` was still in the air, and which of them
   * the registry saw first decided the outcome. A synchronous ref rather than a
   * disabled button, because two clicks in one tick see the same rendered state.
   */
  const registryWriteRef = useRef<number | null>(null);
  /** Ticket numbers for that slot, so a late answer can prove it still owns it. */
  const registryTicket = useRef(0);
  /** A create re-read in flight, so a second click does not start another. */
  const createRereadRef = useRef(false);
  /** What the unresolved create actually submitted. */
  const createInputRef = useRef<NewOperationTargetInput | null>(null);
  /** Mirror of the unresolved create, readable after an await. */
  const createUnconfirmedRef = useRef<Unconfirmed | null>(null);
  /**
   * The last list actually accepted, and when.
   *
   * Stamped, because "a read happened" is not "a read happened AFTER the write
   * whose outcome we are trying to establish". Resolving an unconfirmed create
   * against an older list would answer confidently with stale evidence.
   */
  const listStamp = useRef(0);
  const lastList = useRef<ListRead | null>(null);
  /**
   * The registry as it stood before the unresolved create was sent.
   *
   * Without it, a row that matches the draft proves only that such a row
   * exists — not that this request is what put it there. An identical target
   * registered earlier makes the registry refuse a second one, so finding it
   * afterwards is evidence the submission FAILED, and reporting that as success
   * is how an operator is told a registration went through that never did.
   */
  const createBeforeRef = useRef<ListRead | null>(null);
  const creatingRef = useRef(false);
  const completeRef = useRef(false);

  /** The current selection, readable inside a callback without re-binding it. */
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = state.selectedTargetId;
  }, [state.selectedTargetId]);

  useEffect(() => {
    createDraftRef.current = state.createDraft;
  }, [state.createDraft]);

  useEffect(() => {
    createUnconfirmedRef.current = state.createUnconfirmed;
  }, [state.createUnconfirmed]);

  /**
   * What a list read proved about an unconfirmed registration.
   *
   * `since` is the list stamp taken before the confirming read: anything not
   * newer than that cannot speak about a create that came after it.
   */
  const resolveCreate = useCallback(
    (
      input: NewOperationTargetInput | null,
      since: number,
      before: ListRead | null,
    ): CreateResolution => {
      const read = lastList.current;
      if (input === null || read === null || read.stamp <= since) {
        return { kind: "unconfirmed" };
      }

      // No picture of the registry from before the request, so a matching row
      // cannot be attributed to it either way. Say so rather than guess: an
      // unresolved create the operator is told about is recoverable, and a
      // wrong answer is not.
      if (before === null) return { kind: "unconfirmed" };

      const match = read.targets.find(
        (target) =>
          target.environment === input.environment &&
          target.name === input.name,
      );
      // A complete list that does not contain it is the answer: it never
      // happened. The draft stays, and the operator may submit it themselves.
      if (match === undefined) return { kind: "not-applied" };

      // Same name and environment AND the same database: this is the shape the
      // request asked for. A different path means the name is taken by
      // something else, so the create was refused rather than applied — a
      // different fact, and the operator needs to know which.
      const samePath = match.config.databasePath === input.config.databasePath;

      // Identity, not resemblance. A row carrying an id the pre-request list
      // already held is a row that predates the request, whatever it looks
      // like, so this request did not create it — and since the registry holds
      // one target per (environment, name), nothing new could have been created
      // under that name either.
      if (before.targets.some((target) => target.id === match.id)) {
        return samePath
          ? { kind: "already-existed", targetId: match.id }
          : { kind: "conflict", targetId: match.id };
      }

      // Absent before, present now, and pointing where the request asked: this
      // is the registration that was being attempted.
      return samePath
        ? { kind: "registered", targetId: match.id }
        : { kind: "conflict", targetId: match.id };
    },
    [],
  );

  /* ------------------------------------------ what is known of the registry */

  /**
   * Fold a registry change the backend confirmed into what is known of it.
   *
   * `lastList` is the evidence an unresolved create is attributed against, and
   * a read is not the only thing that establishes what the registry holds: a
   * write the backend answered is a fact about it too. Leaving those out meant
   * a target registered a moment ago was missing from the "before" picture of
   * the *next* request, so finding it in the read-back looked exactly like that
   * request having created it — register something, register it again without
   * refreshing in between, lose the second reply, and the screen announced a
   * registration the registry had in fact refused.
   *
   * The stamp is deliberately NOT advanced. It answers a different question —
   * has a READ happened since the outcome now in doubt — and a write is not a
   * read. Advancing it here would let a confirmed write stand in for the
   * confirmation of a request nobody has answered, which is the protection
   * against stale evidence that the stamp exists to provide.
   *
   * Before any complete read there is nothing to fold into, and nothing is
   * invented: `resolveCreate` then has no picture to attribute against and says
   * the outcome is unknown, which is the honest answer.
   */
  const notePersistedTarget = useCallback((target: OperationTarget): void => {
    const known = lastList.current;
    if (known === null) return;
    const exists = known.targets.some((entry) => entry.id === target.id);
    lastList.current = {
      stamp: known.stamp,
      targets: exists
        ? known.targets.map((entry) =>
            entry.id === target.id ? target : entry,
          )
        : [...known.targets, target],
    };
  }, []);

  /** The same, for a registration the backend confirmed it had removed. */
  const noteRemovedTarget = useCallback((targetId: string): void => {
    const known = lastList.current;
    if (known === null) return;
    lastList.current = {
      stamp: known.stamp,
      targets: known.targets.filter((entry) => entry.id !== targetId),
    };
  }, []);

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

  /**
   * Take the single registry-mutation slot, or refuse.
   *
   * Held until the backend request it belongs to has actually ANSWERED — not
   * merely until this renderer stops waiting for it. Releasing on expiry looked
   * reasonable and was not: nothing cancels the request, so a timed-out create
   * is still on its way to the registry, and letting an edit or a removal start
   * on top of it is exactly the concurrent pair the slot exists to prevent.
   *
   * The ticket is what makes releasing safe. A late answer from a request that
   * has long since been superseded must not hand away a slot somebody else now
   * holds, so it may only release the ticket it was given.
   */
  const claimRegistry = useCallback((): number | null => {
    if (registryWriteRef.current !== null) return null;
    const ticket = ++registryTicket.current;
    registryWriteRef.current = ticket;
    dispatch({ type: "registry-busy", value: true });
    return ticket;
  }, []);

  /** Release the slot, but only for the request that still holds it, once. */
  const releaseRegistry = useCallback((ticket: number): void => {
    if (registryWriteRef.current !== ticket) return;
    registryWriteRef.current = null;
    dispatch({ type: "registry-busy", value: false });
  }, []);

  /** Mirror the registration's doubt into its ref as it is written. */
  const setCreateUnconfirmed = useCallback((value: Unconfirmed | null): void => {
    createUnconfirmedRef.current = value;
    dispatch({ type: "create-unconfirmed", value });
  }, []);

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
  const loadTargets = useCallback(
    async (retries = 1): Promise<ListEvidence> => {
      /** Take a complete answer as the registry, and hand it back as evidence. */
      const accept = (targets: OperationTarget[]): ListEvidence => {
        completeRef.current = true;
        listStamp.current += 1;
        lastList.current = { stamp: listStamp.current, targets };
        dispatch({ type: "targets", targets });
        return { kind: "accepted", stamp: listStamp.current, targets };
      };

      // Named inner function so the bounded re-read below can call itself; the
      // memoised const cannot legally refer to itself.
      const readOnce = async (remaining: number): Promise<ListEvidence> => {
        const seq = ++listSeq.current;
        const epoch = writeEpoch.current;
        dispatch({ type: "targets-loading" });

        const request = attempt("operations:listTargets", {});

        // The wait is bounded; the request is not. An answer arriving after this
        // call has given up is still true data and is still applied — but it can
        // never be handed back as THIS call's evidence, because by then the
        // caller has already been told the read did not answer.
        const { expired } = await runBounded(
          request,
          READ_TIMEOUT_MS,
          (outcome, afterExpiry) => {
            if (!afterExpiry) return;
            if (listSeq.current !== seq) return;
            if (writeEpoch.current !== epoch) return;
            if (outcome.kind === "ok") accept(outcome.data);
          },
        );

        if (expired) {
          // Not `idle`: the mount effect reads that as "never loaded" and would
          // start a third request. An explicit uncertainty with a Retry instead.
          if (listSeq.current !== seq) return { kind: "superseded" };
          dispatch({ type: "targets-uncertain", message: LIST_TIMEOUT_MESSAGE });
          return { kind: "timeout" };
        }

        const outcome = await request;

        // A newer list request owns the phase. This one establishes nothing —
        // and must not answer with what some earlier read happened to prove.
        if (listSeq.current !== seq) return { kind: "superseded" };

        // A write finished while this was in the air. What is on screen came
        // from that write and is newer than anything this response can say.
        if (writeEpoch.current !== epoch) {
          // Before the first complete read, "what is on screen" is only what
          // that write added — announcing it as the registry would hide every
          // existing registration. One bounded re-read, then say it is partial.
          if (!completeRef.current && remaining > 0)
            return readOnce(remaining - 1);
          dispatch({ type: "targets-overtaken" });
          return { kind: "overtaken" };
        }

        if (outcome.kind === "ok") return accept(outcome.data);

        if (outcome.kind === "refused")
          dispatch({ type: "targets-error", error: outcome.error });
        else dispatch({ type: "targets-uncertain", message: outcome.message });
        return { kind: "failed" };
      };

      return readOnce(retries);
    },
    [],
  );

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
        // One search per target and run. Refresh can be clicked faster than a
        // 500-row read comes back, and every extra one asks the same question,
        // deserialises the same rows, and is thrown away by the sequence guard.
        if (deepReadRef.current[targetId] === tracked.runId) return;
        deepReadRef.current[targetId] = tracked.runId;

        let deep: Attempt<OperationDiagnosticRun[]>;
        try {
          // Bounded, because the operator's only way out depends on this read:
          // while it hangs, `searchedDeeply` is never set, the release is never
          // offered, and the target stays blocked for the life of the window —
          // the exact lock-up this search exists to prevent. A timeout is not an
          // answer, so it falls through to the same branch as a failed search:
          // the block stands, and the explicit release appears.
          deep = await withTimeout(
            attempt("operations:listDiagnostics", {
              targetId,
              limit: HISTORY_DEEP_LIMIT,
            }),
            READ_TIMEOUT_MS,
            (): Attempt<OperationDiagnosticRun[]> => ({
              kind: "unknown",
              message: HISTORY_TIMEOUT_MESSAGE,
            }),
          );
        } finally {
          if (deepReadRef.current[targetId] === tracked.runId) {
            delete deepReadRef.current[targetId];
          }
        }

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
      // Bounded for the same reason as the list: a read that never answers must
      // not leave a spinner with nothing past it. A timeout is reported as an
      // unknown outcome, never as an answer, so nothing below treats it as
      // evidence about a tracked run.
      const outcome = await withTimeout(
        attempt("operations:listDiagnostics", {
          targetId,
          limit: HISTORY_LIMIT,
        }),
        READ_TIMEOUT_MS,
        (): Attempt<OperationDiagnosticRun[]> => ({
          kind: "unknown",
          message: HISTORY_TIMEOUT_MESSAGE,
        }),
      );

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
        // Not for a request that is still outstanding: only its own answer, or
        // an explicit re-read the operator asks for, settles that one.
        const doubt = unconfirmedRef.current[targetId];
        if (doubt?.action === "diagnostic" && doubt.outstanding !== true) {
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
    async (targetId?: string): Promise<ReconcileEvidence> => {
      try {
        const list = await loadTargets();
        if (targetId === undefined) return { list, historyRead: false };
        const historyRead = await loadHistory(targetId);
        return { list, historyRead };
      } catch {
        // `attempt` swallows rejections, so this is unreachable in practice.
        // It exists so that no path out of a guarded region can skip the
        // release below by throwing.
        return { list: { kind: "failed" }, historyRead: false };
      }
    },
    [loadTargets, loadHistory],
  );

  /** Reconcile, but stop calling the screen busy if the reads never settle. */
  const boundedReconcile = useCallback(
    async (targetId?: string): Promise<ReconcileEvidence> =>
      withTimeout(reconcile(targetId), RECONCILE_TIMEOUT_MS, () => ({
        list: { kind: "timeout" as const },
        historyRead: false,
      })),
    [reconcile],
  );

  /* ----------------------------------------------------------------- writes */

  const createTarget = useCallback(
    async (
      input: NewOperationTargetInput,
    ): Promise<WriteOutcome<OperationTarget>> => {
      if (creatingRef.current) return { ok: false, error: BLOCKED };
      // Read into a local rather than testing the ref in place: narrowing the
      // ref itself here would follow it down the whole function and make the
      // live re-read below look impossible.
      const openDoubt: Unconfirmed | null = createUnconfirmedRef.current;
      if (openDoubt !== null) {
        return { ok: false, error: unconfirmedError(openDoubt) };
      }
      // The same single registry slot every edit and removal takes. Registration
      // used to check only its own flag, so it could be sent while an edit or a
      // removal of the same `(environment, name)` was still in the air.
      const ticket = claimRegistry();
      if (ticket === null) return { ok: false, error: REGISTRY_BUSY };

      creatingRef.current = true;
      dispatch({ type: "creating", value: true });
      dispatch({ type: "create-late-error", error: null });

      // What was selected when Save was pressed. If the user has moved on by the
      // time this lands, the target is still registered — it simply does not
      // yank them away from what they are now looking at.
      const selectionAtStart = selectedRef.current;

      // Taken here, before the request exists, and not after it: a list read
      // that lands while the create is in the air would already contain
      // whatever the create did, which is precisely the question being asked.
      const before = lastList.current;
      createBeforeRef.current = before;
      createInputRef.current = input;

      const seq = ++createSeq.current;
      // A box rather than a bare `let`: the answer is written from a callback
      // and read from straight-line code below, and only the indirection keeps
      // the two seeing the same declared type.
      const answer: { current: Attempt<OperationTarget> | null } = {
        current: null,
      };
      let returned = false;

      /**
       * Clear the form, but only while it still holds what was submitted.
       *
       * The success path used to clear it unconditionally, which threw away a
       * second registration the operator had begun typing while the first was
       * still in the air — work this request never asked about.
       */
      const clearSubmittedDraft = (): void => {
        if (draftMatches(createDraftRef.current, input)) {
          dispatch({ type: "create-draft", draft: null });
        }
      };

      /** Apply the request's own answer, exactly once, early or late. */
      const applyAnswer = (outcome: Attempt<OperationTarget>): void => {
        // First, and before any staleness check: the registry slot belongs to
        // this request, and the request has now answered. Whatever it says, and
        // whoever is still interested, the next mutation may go ahead.
        releaseRegistry(ticket);

        if (createSeq.current !== seq) return;
        answer.current = outcome;

        if (outcome.kind === "ok") {
          writeEpoch.current += 1;
          notePersistedTarget(outcome.data);
          dispatch({ type: "target-upserted", target: outcome.data });
          clearSubmittedDraft();
          if (selectedRef.current === selectionAtStart) {
            dispatch({ type: "select", targetId: outcome.data.id });
          }
          setCreateUnconfirmed(null);
          // A direct backend answer is ordinary success. The `registered`
          // resolution is reserved for recovery that proves a lost reply by
          // reading the target back from the registry.
          dispatch({ type: "create-resolution", value: null });
          return;
        }

        if (outcome.kind === "refused") {
          // Recorded only once nobody is waiting: while the caller is still
          // here it gets the refusal as its return value, and printing it in
          // both places would be two notices for one answer.
          if (returned) {
            dispatch({ type: "create-late-error", error: outcome.error });
          }
          setCreateUnconfirmed(null);
          return;
        }

        // A transport failure ends the request without saying what it did, so
        // a read may settle this one — which an outstanding request's may not.
        // The wording changes with it: "did not answer in time" stops being
        // true the moment the request answers, even to say it fell over.
        const doubt = createUnconfirmedRef.current;
        if (doubt?.outstanding === true) {
          setCreateUnconfirmed({
            ...doubt,
            outstanding: false,
            message: UNCERTAIN_MESSAGE,
          });
        }
      };

      try {
        const request = attempt("operations:createTarget", input);

        // The bound update and delete already had, and registration did not: a
        // bridge that never answered left Saving on screen, the draft stuck and
        // no uncertain outcome to recover from, for the life of the window.
        const { expired } = await runBounded(
          request,
          WRITE_TIMEOUT_MS,
          applyAnswer,
        );

        if (!expired) {
          const outcome = await request;
          if (outcome.kind === "ok") return { ok: true, data: outcome.data };
          if (outcome.kind === "refused")
            return { ok: false, error: outcome.error };
        }

        // Either the call fell over or the wait ran out with the request still
        // in flight. The registration is never sent again in either case.
        writeEpoch.current += 1;
        const since = listStamp.current;
        const pending: Unconfirmed = expired
          ? {
              action: "create",
              message: WRITE_TIMEOUT_MESSAGE,
              listRefreshed: false,
              outstanding: true,
            }
          : {
              action: "create",
              message: UNCERTAIN_MESSAGE,
              listRefreshed: false,
            };
        setCreateUnconfirmed(pending);
        dispatch({ type: "create-resolution", value: null });

        // Said before the read, cleared after it, so nothing on screen can
        // report the read as having failed while it is still running.
        const generation = ++createReconcileSeq.current;
        dispatch({ type: "create-reconciling", value: true });
        let evidence: ReconcileEvidence;
        try {
          evidence = await boundedReconcile();
        } finally {
          if (createReconcileSeq.current === generation) {
            dispatch({ type: "create-reconciling", value: false });
          }
        }

        // A newer recovery owns the registration now; this one says nothing.
        if (createReconcileSeq.current !== generation) {
          return {
            ok: false,
            uncertain: true,
            error: unconfirmedError(pending),
          };
        }

        // Only an accepted list is evidence. A superseded or timed-out read
        // leaves the outcome exactly as unknown as it was.
        const accepted = evidence.list.kind === "accepted";
        const resolution: CreateResolution = accepted
          ? resolveCreate(input, since, before)
          : { kind: "unconfirmed" };
        dispatch({ type: "create-resolution", value: resolution });

        // An exact answer that arrived while the read was running outranks
        // anything the read could conclude, and the caller is still here.
        const late = answer.current;
        if (late !== null) {
          if (late.kind === "ok") return { ok: true, data: late.data };
          if (late.kind === "refused") return { ok: false, error: late.error };
        }

        // The doubt as it stands NOW, not the one this call started with. The
        // request may have answered while the read was running — `applyAnswer`
        // then cleared `outstanding` — and rebuilding the state from the
        // captured `pending` put that flag straight back, leaving the form
        // disabled over a request that had already finished.
        const live = createUnconfirmedRef.current;
        const settled: Unconfirmed = {
          ...(live ?? pending),
          listRefreshed: accepted,
        };

        if (live !== null) {
          if (resolution.kind === "unconfirmed" || live.outstanding === true) {
            // A request still in flight is not ended by a read, however complete.
            setCreateUnconfirmed(settled);
          } else {
            setCreateUnconfirmed(null);
          }
        }

        if (resolution.kind === "registered") {
          clearSubmittedDraft();
          if (selectedRef.current === selectionAtStart) {
            dispatch({ type: "select", targetId: resolution.targetId });
          }
        }

        return { ok: false, uncertain: true, error: unconfirmedError(settled) };
      } finally {
        returned = true;
        creatingRef.current = false;
        dispatch({ type: "creating", value: false });
        // Deliberately NOT released here. This renderer has stopped waiting;
        // the request has not stopped running, and only its answer frees the
        // slot — `applyAnswer` does it, whenever that answer arrives.
      }
    },
    [
      boundedReconcile,
      resolveCreate,
      notePersistedTarget,
      claimRegistry,
      releaseRegistry,
      setCreateUnconfirmed,
    ],
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
      /**
       * What a complete, current read-back proves about this request.
       *
       * Passed in because only the caller knows what was asked for. "The read
       * succeeded" is not "the change took effect", and the screen used to
       * treat them as the same thing — dropping the doubt, and with it the
       * error notice, over a mutation that had never applied.
       */
      classify: (
        targets: OperationTarget[],
        before: OperationTarget | undefined,
      ) => WriteResolution,
    ): Promise<WriteOutcome<T>> => {
      if (!claim(targetId)) {
        const pending = unconfirmedRef.current[targetId];
        return {
          ok: false,
          error: pending ? unconfirmedError(pending) : BLOCKED,
        };
      }
      // One registry mutation at a time, whatever its shape. A registration in
      // flight can decide this one's outcome through `(environment, name)`, and
      // neither knows about the other, so they are serialised rather than raced.
      const ticket = claimRegistry();
      if (ticket === null) return { ok: false, error: REGISTRY_BUSY };
      writeRef.current[targetId] = kind;
      dispatch({ type: "pending-write", targetId, kind });
      // A refusal or a resolution recorded for a previous attempt is about that
      // attempt, not this one.
      dispatch({ type: "late-write-error", targetId, error: null });
      dispatch({ type: "write-resolution", targetId, value: null });

      const seq = (writeSeq.current[targetId] ?? 0) + 1;
      writeSeq.current[targetId] = seq;

      /** The registration as it stood before this request was sent. */
      const beforeTarget = lastList.current?.targets.find(
        (entry) => entry.id === targetId,
      );

      /**
       * The request's own answer, once it has one, and whether the caller has
       * already been given a return value.
       *
       * Declared out here because both the wait and the confirming read need
       * them: an exact answer that arrives while the read-back is still running
       * outranks anything that read can conclude, and must be returned rather
       * than reported as an unknown outcome.
       */
      let settledAnswer: Attempt<T> | null = null;
      let returned = false;

      /**
       * Read the registry back after an outcome nobody knows.
       *
       * Reads only — repeating the write is what must never happen here. What
       * the read establishes is checked against the doubt as it stands *now*,
       * not against the one this call started with: the request's own answer
       * may have arrived in the meantime, and an answer outranks a read.
       */
      const reconcileAfterDoubt = async (
        pending: Unconfirmed,
      ): Promise<WriteOutcome<T>> => {
        const generation = (reconcileSeq.current[targetId] ?? 0) + 1;
        reconcileSeq.current[targetId] = generation;
        dispatch({ type: "reconciling", targetId, value: true });
        try {
          const evidence = await boundedReconcile(targetId);

          // A newer reconciliation owns this target now. This one concludes
          // nothing: writing its verdict here would overwrite what the newer
          // read is about to establish, and reopening the target on the
          // strength of an older look is how a second write starts against a
          // state the newer read has not finished checking.
          if (reconcileSeq.current[targetId] !== generation) {
            return {
              ok: false,
              uncertain: true,
              error: unconfirmedError(pending),
            };
          }

          // Only a list this read actually accepted counts, and only together
          // with the history read the same recovery needed. A superseded read,
          // an overtaken one and a timeout each prove nothing at all.
          const accepted =
            evidence.list.kind === "accepted" ? evidence.list : null;
          const complete = accepted !== null && evidence.historyRead;

          // An exact answer that arrived while this read was running outranks
          // anything the read could infer. In particular, do not let a stale
          // snapshot put a settlement notice back after `applyAnswer` cleared
          // it for a successful or refused request.
          if (settledAnswer !== null) {
            if (settledAnswer.kind === "ok") {
              dispatch({ type: "write-resolution", targetId, value: null });
              return { ok: true, data: settledAnswer.data };
            }
            if (settledAnswer.kind === "refused") {
              dispatch({ type: "write-resolution", targetId, value: null });
              return { ok: false, error: settledAnswer.error };
            }
          }

          // Built from the doubt as it stands now, for the same reason as the
          // registration's: the request may have answered while this read ran.
          const current = unconfirmedRef.current[targetId];
          const stillOutstanding =
            current !== undefined &&
            current.action === kind &&
            current.outstanding === true;
          const resolution: WriteResolution = complete
            ? classify(accepted.targets, beforeTarget)
            : { kind: "inconclusive" };

          // A read can describe what the registry holds at one instant; while
          // the mutation is still running it cannot say what the registry will
          // hold when that mutation answers. Publishing `unchanged`,
          // `conflicting` or even `matches-request` here produced two mutually
          // exclusive notices: "the request has not answered" and "the change
          // did not take effect". Keep the outcome blank until the request ends.
          dispatch({
            type: "write-resolution",
            targetId,
            value: stillOutstanding ? null : resolution,
          });

          const settled: Unconfirmed = {
            ...(current ?? pending),
            listRefreshed: complete,
          };
          if (current !== undefined && current.action === kind) {
            if (current.outstanding === true) {
              // A request that has not answered has not finished, and no read
              // can say otherwise: an empty page is as consistent with "still
              // being applied" as with "never applied".
              setUnconfirmed(targetId, { ...current, listRefreshed: complete });
            } else if (resolution.kind === "inconclusive") {
              // The request is over but the registry's state is still unknown,
              // which is exactly the case a bare `refreshed === true` used to
              // hide by clearing the doubt anyway.
              setUnconfirmed(targetId, { ...current, listRefreshed: false });
            } else {
              // The request is over and a complete current read says what the
              // registry holds. That is enough to stop blocking the target —
              // and the resolution above says which of the three it is, so a
              // change that never took effect is not passed off as settled.
              setUnconfirmed(targetId, null);
            }
          }

          return {
            ok: false,
            uncertain: true,
            error: unconfirmedError(settled),
          };
        } finally {
          // Only the reconciliation that still owns this target may say it has
          // stopped; an older one clearing the flag would leave the screen
          // claiming nothing is in progress while the newer read runs.
          if (reconcileSeq.current[targetId] === generation) {
            dispatch({ type: "reconciling", targetId, value: false });
          }
        }
      };

      try {
        const request = perform();

        /**
         * Apply the request's own answer, exactly once.
         *
         * Two paths can reach it — the wait below, or the late continuation
         * after that wait has given up — and whichever arrives first does the
         * work. Deliberately independent of the confirming read: a read says
         * what the registry holds, never whether THIS request is what put it
         * there, so nothing a read concludes may stand in for an answer.
         */
        const applyAnswer = (outcome: Attempt<T>): void => {
          // First, and before any staleness check: the slot belongs to this
          // request and the request has answered, so the next mutation may go.
          releaseRegistry(ticket);

          // A newer write owns this target: this answer describes a request
          // nobody is waiting on any more.
          if (writeSeq.current[targetId] !== seq) return;
          settledAnswer = outcome;

          if (outcome.kind === "ok") {
            writeEpoch.current += 1;
            apply(outcome.data);
            dispatch({ type: "write-resolution", targetId, value: null });
          } else if (outcome.kind === "refused" && returned) {
            // Nobody is waiting any more, so the refusal has to be recorded
            // where the screen can still show it. While the caller IS still
            // waiting it gets the refusal as its return value instead — writing
            // it in both places would be two notices for one answer.
            dispatch({ type: "late-write-error", targetId, error: outcome.error });
            dispatch({ type: "write-resolution", targetId, value: null });
          }

          // Whatever it said, the request has come back. A doubt that still
          // called it outstanding would hold this target on a question that has
          // just been answered — but a transport failure only ends the request,
          // it does not say what happened, so that one stays a doubt a read can
          // settle rather than being cleared outright.
          const doubt = unconfirmedRef.current[targetId];
          if (doubt?.action === kind && doubt.outstanding === true) {
            setUnconfirmed(
              targetId,
              outcome.kind === "unknown"
                ? // Answered, even if only to say it fell over: "did not answer
                  // in time" has stopped being true and the wording follows.
                  { ...doubt, outstanding: false, message: UNCERTAIN_MESSAGE }
                : null,
            );
          }
        };

        // This renderer's patience, and nothing more. Expiry is a fact about
        // how long the screen was prepared to wait — never a fact about the
        // request, which was not cancelled and may still be applied. The shared
        // helper is what guarantees the answer is applied exactly once.
        const { expired } = await runBounded(
          request,
          WRITE_TIMEOUT_MS,
          applyAnswer,
        );

        if (!expired) {
          const outcome = await request;

          if (outcome.kind === "ok") return { ok: true, data: outcome.data };
          if (outcome.kind === "refused")
            return { ok: false, error: outcome.error };

          // The call fell over. Whether it was applied is unknown, but the
          // request itself is over, so the confirming read can settle this one.
          writeEpoch.current += 1;
          const pending: Unconfirmed = {
            action: kind,
            message: UNCERTAIN_MESSAGE,
            listRefreshed: false,
          };
          setUnconfirmed(targetId, pending);
          return reconcileAfterDoubt(pending);
        }

        // The wait ran out with the request still in flight. The target stays
        // blocked — a second write against a state nobody knows is exactly what
        // this prevents — and the write is never sent again.
        writeEpoch.current += 1;
        const pending: Unconfirmed = {
          action: kind,
          message: WRITE_TIMEOUT_MESSAGE,
          listRefreshed: false,
          outstanding: true,
        };
        setUnconfirmed(targetId, pending);
        return reconcileAfterDoubt(pending);
      } finally {
        // From here on, an answer has no caller to be returned to.
        returned = true;
        // Released only here — after any confirming read has settled or timed
        // out — and unconditionally, so no path out of this region can leave
        // the target claimed for the life of the window.
        delete writeRef.current[targetId];
        dispatch({ type: "pending-write", targetId, kind: null });
        // Deliberately NOT released here — see `applyAnswer`. The wait is over;
        // the request may not be.
      }
    },
    [claim, boundedReconcile, setUnconfirmed, claimRegistry, releaseRegistry],
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
        (target) => {
          notePersistedTarget(target);
          dispatch({ type: "target-upserted", target });
        },
        (targets, before) => {
          const now = targets.find((entry) => entry.id === targetId);
          // Gone altogether: neither the state that was asked for nor the one
          // that was there. Whatever happened, it was not this edit.
          if (now === undefined) return { kind: "conflicting" };
          if (matchesPatch(now, patch)) return { kind: "matches-request" };
          if (before !== undefined && sameRegistration(now, before)) {
            return { kind: "unchanged" };
          }
          return { kind: "conflicting" };
        },
      ),
    [write, notePersistedTarget],
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
          noteRemovedTarget(targetId);
          dispatch({ type: "target-removed", targetId });
        },
        (targets, before) => {
          const now = targets.find((entry) => entry.id === targetId);
          // Absent from a complete current read is what a removal looks like.
          if (now === undefined) return { kind: "matches-request" };
          if (before !== undefined && sameRegistration(now, before)) {
            return { kind: "unchanged" };
          }
          return { kind: "conflicting" };
        },
      ),
    [write, setBackendRun, noteRemovedTarget],
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

      const seq = (runSeq.current[targetId] ?? 0) + 1;
      runSeq.current[targetId] = seq;

      try {
        const request = attempt("operations:runDiagnostic", {
          targetId,
          probeId,
        });

        /**
         * Apply the request's own result, exactly once.
         *
         * Whichever path reaches it first does the work — the wait below, or
         * the late continuation when that wait has already expired — and the
         * other finds it done. Deliberately independent of the history read and
         * of `runningRef`: neither says anything about whether THIS request has
         * answered, and treating one as though it did is what threw away a
         * reply that arrived while the history was still loading.
         */
        let handled = false;
        const settleRequest = (
          result: Attempt<OperationDiagnosticRun>,
        ): void => {
          if (handled) return;
          handled = true;

          // A newer run owns this target: this answer describes a request
          // nobody is waiting on any more.
          if (runSeq.current[targetId] !== seq) return;

          // Whatever it says, the request has come back. A state that still
          // called it outstanding would hold this target on a question that
          // has just been answered.
          const clearOutstanding = (): void => {
            if (unconfirmedRef.current[targetId]?.action === "diagnostic") {
              setUnconfirmed(targetId, null);
            }
          };

          if (result.kind === "ok") {
            dispatch({ type: "run-finished", targetId, run: result.data });
            // The domain permits a persisted run to still be `running`. Treating
            // every returned run as finished would re-enable this target while
            // the backend was still working.
            if (result.data.status === "running") {
              setBackendRun(targetId, {
                runId: result.data.id,
                since: result.data.startedAt,
                omitted: false,
                searchedDeeply: false,
              });
            } else {
              markTerminal(result.data.id);
              if (backendRunRef.current[targetId]?.runId === result.data.id) {
                setBackendRun(targetId, null);
              }
            }
            dispatch({ type: "uncertain", targetId, message: null });
            clearOutstanding();
            return;
          }

          if (result.kind === "refused") {
            // The backend answered, and said no. That is a fact about the
            // request — a disabled target, an unknown probe — not an unknown
            // outcome, and certainly not a request still in flight.
            dispatch({ type: "run-error", targetId, error: result.error });
            dispatch({ type: "uncertain", targetId, message: null });
            clearOutstanding();
            return;
          }

          // The call fell over. Whether the probe ran is genuinely unknown, and
          // saying "nothing happened" would be a claim nothing supports — but
          // the request itself is over, so the recorded history can settle this
          // one, which an outstanding request's cannot.
          dispatch({ type: "uncertain", targetId, message: result.message });
          setUnconfirmed(targetId, {
            action: "diagnostic",
            message: UNCERTAIN_MESSAGE,
            listRefreshed: false,
          });
        };

        void request.then(settleRequest);

        // This renderer's patience, and nothing more. Expiry is a fact about
        // how long the screen was prepared to wait — never a fact about the
        // request, which was not cancelled and may still be running.
        const expired = await withTimeout(
          request.then(() => false),
          DIAGNOSTIC_TIMEOUT_MS,
          () => true,
        );

        if (expired && !handled) {
          dispatch({
            type: "uncertain",
            targetId,
            message:
              "The diagnostic did not answer in time. It has not been cancelled.",
          });
          setUnconfirmed(targetId, {
            action: "diagnostic",
            message: UNCERTAIN_MESSAGE,
            listRefreshed: false,
            // Still in flight. Only its own answer ends this, which is why no
            // read below is allowed to clear it.
            outstanding: true,
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
      // Held for the whole recovery, not just the list read. A fast list and a
      // slow history used to look like a finished confirmation, releasing the
      // target while the write's outcome was still nobody's knowledge.
      if (targetId !== undefined) {
        if (rereadRef.current[targetId]) return;
        rereadRef.current[targetId] = true;
        dispatch({ type: "reconciling", targetId, value: true });
      }

      // The registration's own recovery needs the same protection, and had
      // none: the button could be clicked as fast as a hand allows, and each
      // click started another list read for one question.
      const forCreate = createUnconfirmedRef.current !== null;
      if (forCreate) {
        if (createRereadRef.current) {
          if (targetId !== undefined) {
            delete rereadRef.current[targetId];
            dispatch({ type: "reconciling", targetId, value: false });
          }
          return;
        }
        createRereadRef.current = true;
        dispatch({ type: "create-reconciling", value: true });
      }

      const since = listStamp.current;

      // This recovery's own generation, so an older one still in the air cannot
      // write its conclusion over what this one is about to establish, and
      // cannot clear the in-progress flag this one owns.
      const generation =
        targetId === undefined ? 0 : (reconcileSeq.current[targetId] ?? 0) + 1;
      if (targetId !== undefined) reconcileSeq.current[targetId] = generation;
      const createGeneration = forCreate ? ++createReconcileSeq.current : 0;

      try {
        const evidence = await boundedReconcile(targetId);

        // Only an accepted list is evidence, and only with the history read the
        // same recovery needed. A superseded or timed-out read proves nothing.
        const accepted =
          evidence.list.kind === "accepted" ? evidence.list : null;
        const complete =
          accepted !== null && (targetId === undefined || evidence.historyRead);

        if (targetId !== undefined && reconcileSeq.current[targetId] === generation) {
          const pending = unconfirmedRef.current[targetId];
          if (pending !== undefined) {
            if (pending.outstanding === true) {
              // A request that has not answered has not finished, and no read
              // can say otherwise. An empty history least of all: nothing here
              // cancelled the operation, so it is still out there, and letting
              // a refresh clear this would permit a second one on top of it.
              setUnconfirmed(targetId, {
                ...pending,
                listRefreshed: complete,
              });
            } else if (complete) {
              // Every read this recovery needed has succeeded and the request is
              // over, so the registry's current state is known and the block can
              // go. What this path does NOT know is what was asked for — the
              // write that raised the doubt owns that comparison — so it settles
              // the block without claiming anything about the request.
              setUnconfirmed(targetId, null);
            } else {
              setUnconfirmed(targetId, { ...pending, listRefreshed: false });
            }
          }
        }

        if (
          createUnconfirmedRef.current !== null &&
          createReconcileSeq.current === createGeneration
        ) {
          const resolution: CreateResolution = accepted
            ? resolveCreate(
                createInputRef.current,
                since,
                createBeforeRef.current,
              )
            : { kind: "unconfirmed" };
          dispatch({ type: "create-resolution", value: resolution });
          const doubt = createUnconfirmedRef.current;
          setCreateUnconfirmed(
            resolution.kind === "unconfirmed" || doubt.outstanding === true
              ? { ...doubt, listRefreshed: accepted !== null }
              : null,
          );
          // Only a registration this request actually made clears the form, and
          // only while the form still holds what was submitted. A target that
          // was already there is somebody else's, and anything typed since is
          // the operator's own work.
          if (
            resolution.kind === "registered" &&
            draftMatches(createDraftRef.current, createInputRef.current)
          ) {
            dispatch({ type: "create-draft", draft: null });
          }
        }
      } finally {
        if (targetId !== undefined) {
          delete rereadRef.current[targetId];
          if (reconcileSeq.current[targetId] === generation) {
            dispatch({ type: "reconciling", targetId, value: false });
          }
        }
        if (forCreate) {
          createRereadRef.current = false;
          if (createReconcileSeq.current === createGeneration) {
            dispatch({ type: "create-reconciling", value: false });
          }
        }
      }
    },
    [boundedReconcile, setUnconfirmed, resolveCreate, setCreateUnconfirmed],
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
        if (pending.outstanding === true) {
          return pending.action === "diagnostic"
            ? "The diagnostic request has not answered. It was not cancelled, so it may still be running — starting another would be a second run."
            : "The change has not been answered. It was not cancelled, so it may still be applied — sending it again would act on a state nobody has confirmed.";
        }
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
