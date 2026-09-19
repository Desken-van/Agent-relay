/**
 * The pieces external plan review and external code review share.
 *
 * Both screens let the operator hand a finding to Codex with one click
 * ("Auto decide") and both need the same things around it: a queue that runs
 * findings a few at a time and never lets one failure erase another's result, a
 * button that says what it is doing, a status line that lives inside the
 * finding it is about, and the same plain explanation of what "accept" and
 * "reject" mean. They are here once so the two screens cannot drift apart.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Notice, Spinner } from './primitives';

/* -------------------------------------------------------------------------- */
/* The queue                                                                    */
/* -------------------------------------------------------------------------- */

/** What one finished analysis came to. `skipped`: something else had already decided it. */
export type AutoDecideKind = 'accept' | 'reject' | 'needs_user' | 'skipped';

export type AutoDecideItemState =
  | { readonly phase: 'queued' }
  | { readonly phase: 'analyzing' }
  | { readonly phase: 'failed'; readonly message: string };

export interface AutoDecideSummary {
  /** Findings in the current batch: finished, failed, and still to come. */
  readonly total: number;
  /** Findings whose analysis finished without failing. */
  readonly analyzed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly needsUser: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pending: number;
}

export interface AutoDecideQueue<K extends string | number> {
  /** The queue's state for a finding, or undefined when it is idle. */
  readonly stateOf: (key: K) => AutoDecideItemState | undefined;
  /** Enqueue findings; ones already queued or running are ignored, so a double click starts one analysis. */
  readonly start: (keys: readonly K[], options?: { readonly bulk?: boolean }) => void;
  /** Re-enqueue every finding whose analysis failed. */
  readonly retryFailed: () => void;
  readonly busy: boolean;
  /** Null until a bulk run has started; stays after it ends, so a partial result stays visible. */
  readonly summary: AutoDecideSummary | null;
  /** Findings that failed, in the order they failed. */
  readonly failedKeys: readonly K[];
}

/**
 * Run analyses for many findings with bounded concurrency.
 *
 * Every finding settles on its own: a rejection marks THAT finding failed and
 * the others go on. `run` does the work and reports what it came to; anything
 * it needs to change on screen it changes itself.
 */
export function useAutoDecideQueue<K extends string | number>(options: {
  readonly concurrency: number;
  readonly run: (key: K) => Promise<AutoDecideKind>;
  /** Called once each time the queue drains, after the last finding has settled. */
  readonly onIdle?: () => void;
}): AutoDecideQueue<K> {
  const { concurrency } = options;
  const [items, setItems] = useState<ReadonlyMap<K, AutoDecideItemState>>(() => new Map());
  const [results, setResults] = useState<ReadonlyMap<K, AutoDecideKind>>(() => new Map());
  const [bulk, setBulk] = useState(false);

  // The latest callbacks, without making the engine below depend on them. A layout
  // effect, so a click straight after a render never runs the previous render's callback.
  const runRef = useRef(options.run);
  const idleRef = useRef(options.onIdle);
  useLayoutEffect(() => {
    runRef.current = options.run;
    idleRef.current = options.onIdle;
  });
  const mounted = useRef(true);

  // Synchronous bookkeeping. React state is for rendering; these decide, in the
  // same tick, whether a click starts work — so two clicks in one tick start one.
  const [engine] = useState(() => {
    const waiting: K[] = [];
    const known = new Set<K>();
    let active = 0;

    const pump = (): void => {
      while (active < concurrency && waiting.length > 0) {
        const key = waiting.shift() as K;
        active += 1;
        setItems((current) => new Map(current).set(key, { phase: 'analyzing' }));
        void runRef.current(key).then(
          (kind) => settle(key, kind, null),
          (error: unknown) => settle(key, null, error instanceof Error ? error.message : String(error))
        );
      }
    };
    const settle = (key: K, kind: AutoDecideKind | null, failure: string | null): void => {
      active -= 1;
      known.delete(key);
      if (mounted.current) {
        setItems((current) => {
          const next = new Map(current);
          if (failure === null) next.delete(key);
          else next.set(key, { phase: 'failed', message: failure });
          return next;
        });
        if (kind !== null) setResults((current) => new Map(current).set(key, kind));
      }
      pump();
      if (active === 0 && waiting.length === 0 && mounted.current) idleRef.current?.();
    };

    return {
      /** Findings still waiting are dropped; one already being analyzed finishes on its own. */
      cancelWaiting(): void {
        for (const key of waiting.splice(0)) known.delete(key);
      },
      start(keys: readonly K[], isBulk: boolean): void {
        const fresh = keys.filter((key) => !known.has(key));
        if (fresh.length === 0) return;
        if (known.size === 0) {
          // A new batch: the previous one's results are history.
          setResults(new Map());
          setBulk(isBulk);
        }
        for (const key of fresh) {
          known.add(key);
          waiting.push(key);
        }
        setItems((current) => {
          const next = new Map(current);
          for (const key of fresh) next.set(key, { phase: 'queued' });
          return next;
        });
        pump();
      }
    };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      engine.cancelWaiting();
    };
  }, [engine]);

  const failedKeys = useMemo(
    () => [...items].filter(([, state]) => state.phase === 'failed').map(([key]) => key),
    [items]
  );
  const summary = useMemo<AutoDecideSummary | null>(() => {
    if (!bulk) return null;
    let accepted = 0;
    let rejected = 0;
    let needsUser = 0;
    let skipped = 0;
    for (const kind of results.values()) {
      if (kind === 'accept') accepted += 1;
      else if (kind === 'reject') rejected += 1;
      else if (kind === 'needs_user') needsUser += 1;
      else skipped += 1;
    }
    const failed = failedKeys.length;
    const pending = [...items.values()].filter((state) => state.phase !== 'failed').length;
    return {
      total: results.size + failed + pending,
      analyzed: results.size,
      accepted,
      rejected,
      needsUser,
      skipped,
      failed,
      pending
    };
  }, [bulk, results, items, failedKeys]);

  return {
    stateOf: (key) => items.get(key),
    start: (keys, opts) => engine.start(keys, opts?.bulk === true),
    retryFailed: () => engine.start(failedKeys, bulk),
    busy: [...items.values()].some((state) => state.phase !== 'failed'),
    summary,
    failedKeys
  };
}

const BACKEND_ANALYZING: AutoDecideItemState = { phase: 'analyzing' };
const BACKEND_POLL_MS = 2_000;

/**
 * What to show for a finding: what this screen's own queue says, else
 * "analyzing" when the main process says a request for it is still running — a
 * request a reloaded or second screen started and this one has no memory of.
 * While such requests run, the round is read back every couple of seconds, so
 * the finding shows its result when it arrives and never offers a second click
 * for work that is already under way.
 */
export function useAnalysisState<K extends string | number>(options: {
  readonly queue: AutoDecideQueue<K>;
  readonly analyzing: readonly K[];
  readonly refresh: () => Promise<void>;
}): (key: K) => AutoDecideItemState | undefined {
  const { queue, analyzing, refresh } = options;
  const foreign = analyzing.some((key) => queue.stateOf(key) === undefined);
  const busy = queue.busy;
  useEffect(() => {
    if (!foreign || busy) return undefined;
    const timer = setInterval(() => void refresh(), BACKEND_POLL_MS);
    return () => clearInterval(timer);
  }, [foreign, busy, refresh]);
  return (key) => queue.stateOf(key) ?? (analyzing.includes(key) ? BACKEND_ANALYZING : undefined);
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The per-finding button, in the Decision row. It says what it is doing, and it
 * is the finding's own Retry after a failure, so the retry is where the error is.
 */
export function AutoDecideButton({
  state,
  findingLabel,
  disabled,
  blockedReason = null,
  onClick
}: {
  state: AutoDecideItemState | undefined;
  /** Names the finding for assistive technology; the visible text stays "Auto decide". */
  findingLabel: string;
  disabled: boolean;
  /** Why this finding must not be analyzed right now (for example, the operator has already chosen). */
  blockedReason?: string | null;
  onClick: () => void;
}): React.JSX.Element {
  const working = state?.phase === 'analyzing' || state?.phase === 'queued';
  return (
    <button
      type="button"
      className="btn btn--sm btn--primary decision-row__auto"
      disabled={disabled || working || blockedReason !== null}
      aria-busy={working}
      aria-label={`${state?.phase === 'failed' ? 'Retry auto decide' : 'Auto decide'}: ${findingLabel}`}
      title={
        blockedReason ??
        'Ask Codex to analyze this finding, then accept or reject it for you. It stops and asks you when it cannot decide.'
      }
      onClick={onClick}
    >
      {state?.phase === 'analyzing' ? (
        <>
          <Spinner /> Analyzing…
        </>
      ) : state?.phase === 'queued' ? (
        'Waiting…'
      ) : state?.phase === 'failed' ? (
        'Retry'
      ) : (
        'Auto decide'
      )}
    </button>
  );
}

/** What Codex concluded about a finding, in the shapes the two screens both have. */
export interface AutoFindingFacts {
  readonly queue: AutoDecideItemState | undefined;
  /** A decision Auto decide made and saved. */
  readonly decided: {
    readonly action: 'accept' | 'reject';
    readonly confidence: string;
    readonly evidenceRef: string;
  } | null;
  /** Codex stopped on purpose. */
  readonly needsUser: {
    readonly reason: string;
    readonly evidenceRef: string;
    readonly confidence: string;
  } | null;
  /** The operator's own different choice, when it differs from `decided`. */
  readonly operatorChoice: 'accept' | 'reject' | null;
}

const ACTION_WORD = { accept: 'Accept', reject: 'Reject' } as const;

/**
 * The finding's own status line: never a banner elsewhere on the page. Progress,
 * the result, the reason automation stopped, and the failure all render here,
 * next to the Decision they are about.
 */
export function AutoFindingStatus({ facts }: { facts: AutoFindingFacts }): React.JSX.Element {
  const { queue, decided, needsUser, operatorChoice } = facts;

  if (queue?.phase === 'analyzing' || queue?.phase === 'queued') {
    return (
      <div className="finding-status finding-status--working" role="status" aria-live="polite">
        <Spinner />
        <strong>{queue.phase === 'analyzing' ? 'Analyzing…' : 'Waiting to analyze…'}</strong>
        <span className="faint">Codex is reading this finding. Nothing is decided until it answers.</span>
      </div>
    );
  }
  if (queue?.phase === 'failed') {
    return (
      <Notice tone="error" role="alert">
        <div className="stack stack--tight">
          <strong>Failed — Retry. Nothing was decided.</strong>
          <span className="selectable">{queue.message}</span>
        </div>
      </Notice>
    );
  }
  if (needsUser !== null) {
    return (
      <Notice tone="warn" role="status">
        <div className="stack stack--tight">
          <strong>Needs your decision — automation stopped on purpose.</strong>
          <span className="selectable">{needsUser.reason}</span>
          <span className="faint selectable">
            Evidence: {needsUser.evidenceRef} · {needsUser.confidence} confidence
          </span>
        </div>
      </Notice>
    );
  }
  if (decided !== null) {
    return (
      <div className="finding-status finding-status--decided" role="status">
        <strong>Auto-decided: {ACTION_WORD[decided.action]}</strong>
        <span className="faint selectable">
          {decided.confidence} confidence · Evidence: {decided.evidenceRef}
        </span>
        {operatorChoice !== null && operatorChoice !== decided.action ? (
          <span className="tag tag--warn">
            You chose {ACTION_WORD[operatorChoice]} instead — your choice is what will be sent
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="finding-status" role="status">
      <span className="faint">Not analyzed</span>
    </div>
  );
}

/** The plain-language meaning of each choice, visible where the choices are made. */
export function DecisionGlossary({
  subject,
  children
}: {
  subject: 'plan' | 'code';
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <Notice tone="info">
      <div className="stack stack--tight">
        <strong>What the choices mean</strong>
        <ul className="bullets">
          <li>
            <strong>Accept and address</strong> — the finding is valid and must be incorporated.{' '}
            {subject === 'plan'
              ? 'Accepting it does not by itself change the plan: “Resolve and revise plan” has Codex revise the specification and reviews the revision again.'
              : 'Accepting it does not change any code: it becomes a correction still owed until a fresh review of the corrected code shows it fixed.'}
          </li>
          <li>
            <strong>Reject with reason</strong> — the finding is not valid. The reason is the
            auditable, contrary evidence, and it is required.
          </li>
          <li>
            <strong>Needs your decision</strong> — Auto decide stopped on purpose. Nothing was
            decided for that finding.
          </li>
        </ul>
        {children}
      </div>
    </Notice>
  );
}

/** The live counts of a bulk run, next to the button that started it. */
export function AutoDecideSummaryLine({
  summary,
  onRetryFailed,
  disabled
}: {
  summary: AutoDecideSummary;
  onRetryFailed: () => void;
  disabled: boolean;
}): React.JSX.Element {
  const done = summary.pending === 0;
  const partial = done && summary.failed > 0;
  return (
    <div className="autodecide-summary" role="status" aria-live="polite">
      <strong>
        {done
          ? partial
            ? 'Auto decide finished with failures'
            : 'Auto decide finished'
          : `Auto decide running — ${summary.pending} left`}
      </strong>
      <span>
        {summary.analyzed} analyzed · {summary.accepted} accepted · {summary.rejected} rejected ·{' '}
        {summary.needsUser} need you · {summary.failed} failed
        {summary.skipped > 0 ? ` · ${summary.skipped} already decided` : ''}
      </span>
      {partial ? (
        <>
          <span>
            {summary.analyzed} finding(s) kept their results. Only the failed ones will be retried.
          </span>
          <button type="button" className="btn btn--sm" disabled={disabled} onClick={onRetryFailed}>
            Retry {summary.failed} failed
          </button>
        </>
      ) : null}
    </div>
  );
}
