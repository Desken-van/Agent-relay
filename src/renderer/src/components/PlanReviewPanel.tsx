/**
 * External plan review, folded into Run → Actions.
 *
 * Moved out of `RunView.tsx` unchanged in behaviour, then reworked: Auto decide
 * sits in every finding's Decision row, one bulk action replaces the old
 * Analyze → Apply → Resolve sequence, and accepted findings are resolved
 * together with a real revision of the plan (see `PlanCorrectionService`).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '@shared/domain/models';
import type { PlanAdvanceOutcome } from '@shared/domain/plan-correction';
import { type PlanReviewDecision, parsePlanReviewTriage } from '@shared/domain/plan-review';
import type { PlanReviewPreparation, RunActionKey } from '@shared/domain/run-guidance';
import type { PlanReviewDetail } from '@shared/ipc';
import { ApiError, call, expect } from '../lib/api';
import { Field, Notice, Scope, Spinner } from './primitives';
import {
  AutoDecideButton,
  AutoDecideSummaryLine,
  AutoFindingStatus,
  DecisionGlossary,
  useAnalysisState,
  useAutoDecideQueue,
  type AutoDecideKind
} from './review-findings';

/**
 * A failed call as the operator should read it: what went wrong, followed by the
 * backend's own next step when it gave one (for example, to decide some findings
 * by hand, or to reload a round that moved).
 */
function describeFailure(caught: unknown): string {
  if (!(caught instanceof Error)) return String(caught);
  const remediation = caught instanceof ApiError ? caught.remediation : undefined;
  return remediation ? `${caught.message} ${remediation}` : caught.message;
}

/**
 * What the operator chose by hand for one finding. A draft, when it exists, is
 * the WHOLE decision and overrides whatever Auto decide saved for that finding —
 * including an explicit "Choose…" that clears it.
 */
type DecisionDraft = { action: '' | 'accept' | 'reject'; reason: string };

/** Decision drafts, tagged with the round they answer. */
type DecisionDrafts = {
  readonly roundKey: string | null;
  readonly drafts: Record<number, DecisionDraft>;
};

/** Shared empty map, so a stale round renders no drafts and no new objects. */
const NO_DRAFTS: Record<number, DecisionDraft> = {};
const NO_PLAN_REVIEW_FINDINGS: PlanReviewDetail['findings'] = [];
const NO_AUTO_DECISIONS: PlanReviewDetail['autoDecisions'] = [];
const NO_ANALYZING: readonly number[] = [];

/** Findings analyzed at once. The claim is per finding, so different ones may overlap. */
const AUTO_DECIDE_CONCURRENCY = 2;
/** How often the panel re-reads the round while the correction loop runs. */
const LOOP_POLL_MS = 2_000;

function planReviewPreparationState(input: {
  readonly task: Task;
  readonly integrationEnabled: boolean;
  readonly loading: boolean;
  readonly busy: string | null;
  readonly error: string | null;
  readonly detail: PlanReviewDetail | null;
  readonly resolutionReady?: boolean;
  /** At least one finding is accepted: resolving must revise the plan, not just resolve it. */
  readonly acceptedPresent?: boolean;
}): PlanReviewPreparation {
  const {
    task,
    integrationEnabled,
    loading,
    busy,
    error,
    detail,
    resolutionReady = false,
    acceptedPresent = false
  } = input;
  const awaitingApproval =
    task.status === 'DRAFT' ||
    (task.status === 'READY_FOR_IMPLEMENTATION' && !task.specificationApprovedAt);
  if (!awaitingApproval) return 'not_required';
  if (loading) return 'loading';
  if (error !== null || detail === null || detail.ruleEvidenceProblem !== null) return 'unavailable';
  if (!integrationEnabled) return detail.ruleEvidence ? 'unavailable' : 'not_required';
  if (busy !== null) return 'working';
  if (task.status === 'DRAFT') return detail.ruleEvidence ? 'ready' : 'capture_rules';
  if (!detail.ruleEvidence) return 'not_required';

  const gate = detail.gate;
  if (gate === null) return 'prepare_review';
  if (['opening', 'reviewing', 'resolving', 'failed'].includes(gate.status)) return 'reconcile';
  if (gate.status === 'awaiting_resolve') {
    if (!resolutionReady) return 'resolve_blocked';
    return acceptedPresent ? 'resolve_and_revise' : 'resolve';
  }
  // Accepted findings the specification does not yet reflect are the next thing,
  // whatever the gate's own status says about the round that produced them.
  const step = detail.correction.nextStep;
  if (
    step === 'revise' ||
    (step === 'run_review' && detail.correction.latest?.status === 'completed' && detail.gateIdentity === 'obsolete')
  ) {
    return 'continue_correction';
  }
  if (step === 'round_limit') return 'correction_limit';
  if (detail.gateIdentity === 'current') {
    if (gate.status === 'prepared') return 'run_review';
    if (gate.status === 'changes_requested' || gate.status === 'interrupted') return 'run_next_review';
    if (gate.status === 'proceeded') return 'passed';
  }
  if (detail.gateIdentity === 'obsolete' &&
      !['opening', 'reviewing', 'awaiting_resolve', 'resolving', 'failed'].includes(gate.status)) {
    return 'prepare_review';
  }
  return 'unavailable';
}

/** What the correction loop is doing right now, in words. */
function loopPhaseText(detail: PlanReviewDetail | null): string {
  const loop = detail?.correction.loop ?? null;
  const max = detail?.correction.max ?? 0;
  switch (loop?.phase) {
    case 'resolving':
      return 'Recording the decisions with the external reviewer…';
    case 'revising':
      return `Codex is revising the specification (correction round ${loop.round} of ${max})…`;
    case 'reviewing':
      return 'The external reviewer is reviewing the revised specification…';
    case 'deciding':
      return 'Auto decide is analyzing the new findings…';
    default:
      return 'Working through the correction loop…';
  }
}

/**
 * External plan review, folded into Run → Actions.
 *
 * Renders active status, verdict, findings, decision inputs, the last error
 * and any evidence problem as passive content, plus — at most — the single
 * primary button this state calls for. There is no separate card for it: it
 * lives inside Actions, right alongside the rest of the workflow.
 *
 * Deciding is one click: "Auto decide" sits in each finding's Decision row and
 * saves the decision durably; "Auto decide all undecided" does every finding at
 * once and never touches a decision the operator made. Accepted findings are
 * then resolved TOGETHER with a revision of the plan (Codex rewrites the
 * specification, a fresh external round reviews it) — accepting alone changes
 * nothing about the plan.
 *
 * This component decides its own button from the same durable state
 * `runGuidance` reads (via {@link planReviewPreparationState}, reported
 * upward through `onGuidanceStateChanged`), so the two can never disagree —
 * `RunView` uses that same reported state to know when to suppress its own,
 * separate primary button rather than duplicating this one.
 */
export function PlanReviewPanel({
  task,
  integrationEnabled,
  onChanged,
  onGuidanceStateChanged,
  renderPrimary = true,
  onDispatchReady
}: {
  task: Task;
  integrationEnabled: boolean;
  onChanged: () => Promise<void>;
  onGuidanceStateChanged?: (state: PlanReviewPreparation) => void;
  renderPrimary?: boolean;
  onDispatchReady?: (dispatcher: ((key: RunActionKey) => void) | null) => void;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<PlanReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtyPrompt, setDirtyPrompt] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<DecisionDrafts>({ roundKey: null, drafts: {} });
  const [confirmBlind, setConfirmBlind] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [correctionResult, setCorrectionResult] = useState<
    | { readonly outcome: PlanAdvanceOutcome }
    | { readonly failure: string }
    /** The task was stopped: the loop ended, which is neither a success nor a failure of its own. */
    | { readonly stopped: string }
    | null
  >(null);
  // Keyed on the findings actually rendered, not `gate.revision`: a decision
  // is an answer to a specific finding, and only a NEW set of findings (a
  // fresh round) makes an old answer stop applying. `revision` bumps on every
  // durable write to the row — including each Auto decide result, which
  // changes no finding — and keying on it would wipe in-progress manual
  // decisions the instant an analysis completes.
  const roundKey = detail?.gate ? `${detail.gate.id}:${JSON.stringify(detail.findings)}` : null;
  const decisions = draftState.roundKey === roundKey ? draftState.drafts : NO_DRAFTS;
  const setDecisions = useCallback(
    (update: (current: Record<number, DecisionDraft>) => Record<number, DecisionDraft>): void => {
      setDraftState((current) => ({
        roundKey,
        drafts: update(current.roundKey === roundKey ? current.drafts : {})
      }));
    },
    [roundKey]
  );
  // Bumped by every manual edit of a finding. An Auto decide result replaces a
  // finding's draft ONLY if nothing edited it while Codex was thinking.
  const editVersions = useRef<Record<number, number>>({});
  const editFinding = useCallback(
    (index: number, next: DecisionDraft): void => {
      editVersions.current[index] = (editVersions.current[index] ?? 0) + 1;
      setDecisions((current) => ({ ...current, [index]: next }));
    },
    [setDecisions]
  );

  /**
   * Take a newer read of the round, never an older one. Several analyses finish
   * out of order, and each answers with the whole detail; the gate's revision is
   * what says which is newest.
   */
  const adoptDetail = useCallback((next: PlanReviewDetail): void => {
    setDetail((current) =>
      current?.gate && next.gate && current.gate.id === next.gate.id && next.gate.revision < current.gate.revision
        ? current
        : next
    );
  }, []);
  // A layout effect, not a passive one: the ref must already be current when the
  // DOM the operator is looking at is, or a click straight after a render reads
  // the round before it.
  const latest = useRef<PlanReviewDetail | null>(null);
  useLayoutEffect(() => {
    latest.current = detail;
  });
  const refresh = useCallback(async (): Promise<void> => {
    const result = await call('planReview:get', { taskId: task.id });
    if (result.ok) adoptDetail(result.data);
  }, [adoptDetail, task.id]);

  useEffect(() => {
    let active = true;
    void call('planReview:get', { taskId: task.id }).then((result) => {
      if (!active) return;
      if (result.ok) {
        setDetail(result.data);
        setError(null);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [task.id]);

  const gate = detail?.gate ?? null;
  const findings = detail?.findings ?? NO_PLAN_REVIEW_FINDINGS;
  const autoDecisions = detail?.autoDecisions ?? NO_AUTO_DECISIONS;
  const autoByFinding = new Map(autoDecisions.map((entry) => [entry.finding, entry] as const));
  // The decision that will be sent for a finding: the operator's own draft over
  // whatever Auto decide saved.
  const effective = (index: number): DecisionDraft => {
    const draft = decisions[index];
    if (draft !== undefined) return draft;
    const saved = autoByFinding.get(index);
    return saved ? { action: saved.action, reason: saved.reason } : { action: '', reason: '' };
  };
  // Something the operator has chosen or typed for this finding. A draft emptied
  // again is not one: it holds nothing that Auto decide could overwrite.
  const hasDraft = (index: number): boolean => {
    const draft = decisions[index];
    return draft !== undefined && (draft.action !== '' || draft.reason.trim().length > 0);
  };
  const allDecided = findings.every((_, index) => {
    const decision = effective(index);
    return decision.action === 'accept' ||
      (decision.action === 'reject' && decision.reason.trim().length > 0);
  });
  const acceptedCount = findings.filter((_, index) => effective(index).action === 'accept').length;
  // Only current for THIS exact set of findings: `triageForFindings` is the
  // exact `findingsJson` the recommendations were computed against, not a
  // revision number — a revision-based check would make even a
  // freshly-written result look stale the instant anything else touched the
  // gate. Only a genuinely new round (different findings) invalidates it.
  const currentTriage = gate && gate.triageForFindings === gate.findingsJson
    ? parsePlanReviewTriage(gate.triageJson)
    : null;
  const needsUserByFinding = new Map(
    (currentTriage?.recommendations ?? [])
      .filter((entry) => entry.recommendation === 'needs_user' && !autoByFinding.has(entry.finding))
      .map((entry) => [entry.finding, entry] as const)
  );

  /* -------------------------------- Auto decide -------------------------------- */

  // The round a batch was started for. A finding that waited while the round was
  // replaced must not be analyzed against the new round's finding at that index.
  const batchRound = useRef<string | null>(null);
  const runAutoDecide = useCallback(async (index: number): Promise<AutoDecideKind> => {
    const current = latest.current;
    const round = current?.gate;
    if (!current || !round || current.findingsSha256 === null || current.findingsSha256 !== batchRound.current) {
      throw new Error('The round changed while this finding waited, so it was not analyzed. Start again on the current round.');
    }
    const version = editVersions.current[index] ?? 0;
    let answer;
    try {
      answer = await expect('planReview:autoDecide', {
        taskId: task.id,
        gateId: round.id,
        findingsSha256: current.findingsSha256,
        findingIndex: index
      });
    } catch (caught) {
      throw new Error(describeFailure(caught));
    }
    adoptDetail(answer.detail);
    // Applied at once — unless the operator edited this finding while Codex was
    // thinking, in which case their choice stands and the result is shown beside it.
    if ((editVersions.current[index] ?? 0) === version) {
      setDecisions((drafts) => {
        const { [index]: _replaced, ...rest } = drafts;
        return rest;
      });
    }
    return answer.outcome.kind === 'decided' ? answer.outcome.decision.action : 'needs_user';
  }, [adoptDetail, setDecisions, task.id]);
  const queue = useAutoDecideQueue<number>({
    concurrency: AUTO_DECIDE_CONCURRENCY,
    run: runAutoDecide,
    onIdle: () => void refresh()
  });
  const autoStateOf = useAnalysisState({ queue, analyzing: detail?.analyzing ?? NO_ANALYZING, refresh });
  const startAutoDecide = (indexes: readonly number[], bulk: boolean): void => {
    if (!queue.busy) batchRound.current = detail?.findingsSha256 ?? null;
    queue.start(indexes, { bulk });
  };
  // "Undecided" for the bulk action: nothing chosen or being edited, nothing
  // saved, and not a finding Codex already stopped on. Failed ones are included.
  const bulkIndexes = findings
    .map((_, index) => index)
    .filter((index) => {
      const state = autoStateOf(index);
      return (
        !hasDraft(index) &&
        !autoByFinding.has(index) &&
        !needsUserByFinding.has(index) &&
        (state === undefined || state.phase === 'failed')
      );
    });

  const guidanceState = planReviewPreparationState({
    task,
    integrationEnabled,
    loading,
    busy,
    error,
    detail,
    resolutionReady: allDecided,
    acceptedPresent: acceptedCount > 0
  });
  useEffect(() => {
    onGuidanceStateChanged?.(guidanceState);
  }, [guidanceState, onGuidanceStateChanged]);

  const act = useCallback(async (
    key: string,
    operation: () => Promise<PlanReviewDetail>
  ): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(key);
    setError(null);
    setCorrectionResult(null);
    try {
      const next = await operation();
      setDetail(next);
      setDirtyPrompt(null);
      await onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'GIT_DIRTY' && key === 'prepare') {
        setDirtyPrompt(caught.message + (caught.details ? `\n\n${caught.details}` : ''));
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      // A failed `review` or `resolve` is the one case where the screen is now
      // lying. Both write their durable phase before they dispatch, so a lost
      // answer leaves the gate at `reviewing` or `resolving` in the main
      // process while this panel still holds the `prepared` or
      // `awaiting_resolve` it rendered before the click. One read-only
      // read-back fixes the display — never the operation itself, since
      // `review` and `resolve` are not idempotent and may already have
      // taken effect.
      if (key === 'review' || key === 'resolve') {
        try {
          setDetail(await expect('planReview:get', { taskId: task.id }));
        } catch {
          // Nothing to add: the operator already has the failure that matters.
        }
      }
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  }, [onChanged, task.id]);

  /**
   * Run the correction loop (resolve and revise, or continue it). One long call:
   * while it runs the panel reads the round back to show what the loop is doing,
   * and afterwards it says why the loop stopped — including when it failed.
   */
  const advance = useCallback(async (
    operation: () => Promise<{ detail: PlanReviewDetail; outcome: PlanAdvanceOutcome }>
  ): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy('revise');
    setError(null);
    setCorrectionResult(null);
    try {
      const answer = await operation();
      setDetail(answer.detail);
      setCorrectionResult({ outcome: answer.outcome });
    } catch (caught) {
      // A stop is reported as a stop: never as a success, and not as a fault of the loop.
      setCorrectionResult(
        caught instanceof ApiError && caught.code === 'CANCELLED'
          ? { stopped: describeFailure(caught) }
          : { failure: describeFailure(caught) }
      );
      try {
        setDetail(await expect('planReview:get', { taskId: task.id }));
      } catch {
        // The failure above is the one that matters.
      }
    } finally {
      // The specification may have changed even when a later step failed.
      try {
        await onChanged();
      } catch {
        // Refreshing the task is best-effort; the detail above is already current.
      }
      inFlightRef.current = false;
      setBusy(null);
    }
  }, [onChanged, task.id]);
  useEffect(() => {
    if (busy !== 'revise') return undefined;
    const timer = setInterval(() => void refresh(), LOOP_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  // Stop task ends whatever this panel had running. The task's own status is the
  // signal (it arrives with the task the screen holds), and the round is read back
  // once so nothing here goes on describing work that no longer exists.
  const cancelled = task.status === 'CANCELLED';
  useEffect(() => {
    if (!cancelled) return undefined;
    let active = true;
    void call('planReview:get', { taskId: task.id }).then((result) => {
      if (active && result.ok) adoptDetail(result.data);
    });
    return () => {
      active = false;
    };
  }, [cancelled, task.id, adoptDetail]);

  const resolvePayload = (): PlanReviewDecision[] =>
    findings.map((_, index) => {
      const decision = effective(index);
      return {
        finding: index,
        action: decision.action as 'accept' | 'reject',
        reason: decision.reason.trim()
      };
    });

  const dispatchPlanPrimary = useCallback((key: RunActionKey): void => {
    switch (key) {
      case 'capture_rules':
        void act('bind', () => expect('planReview:bindRules', { taskId: task.id }));
        return;
      case 'prepare_plan_review':
        void act('prepare', () => expect('planReview:prepare', {
          taskId: task.id,
          ...(dirtyPrompt ? { acceptDirtyWorkingTree: true } : {})
        }));
        return;
      case 'run_plan_review':
        void act('review', () => expect('planReview:review', { taskId: task.id }));
        return;
      case 'reconcile_plan_review':
        void act('reconcile', () => expect('planReview:reconcile', { taskId: task.id }));
        return;
      case 'continue_plan_correction':
        void advance(() => expect('planReview:continueCorrection', { taskId: task.id, autoContinue }));
        return;
      case 'resolve_plan_review': {
        if (!gate || !allDecided) return;
        const payload = resolvePayload();
        if (payload.some((decision) => decision.action === 'accept')) {
          void advance(() => expect('planReview:resolveAndRevise', {
            taskId: task.id,
            gateId: gate.id,
            expectedRevision: gate.revision,
            decisions: payload,
            autoContinue
          }));
        } else {
          void act('resolve', () => expect('planReview:resolve', {
            taskId: task.id,
            gateId: gate.id,
            expectedRevision: gate.revision,
            decisions: payload
          }));
        }
        return;
      }
      default:
        return;
    }
    // `resolvePayload` reads the same drafts and saved decisions `effective` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act, advance, allDecided, autoContinue, decisions, autoDecisions, dirtyPrompt, findings, gate, task.id]);
  useEffect(() => {
    onDispatchReady?.(dispatchPlanPrimary);
    return () => onDispatchReady?.(null);
  }, [onDispatchReady, dispatchPlanPrimary]);

  const corrupt = detail?.ruleEvidenceProblem ?? null;
  if (!integrationEnabled && !detail?.ruleEvidence && corrupt === null) return null;

  const unknownOutcome =
    gate !== null && ['opening', 'reviewing', 'resolving', 'failed'].includes(gate.status);

  const identity = detail?.gateIdentity ?? 'no_gate';
  const obsolete = gate !== null && identity === 'obsolete';
  const obsoleteBlocking =
    obsolete &&
    ['opening', 'reviewing', 'awaiting_resolve', 'resolving', 'failed'].includes(gate.status);
  const obsoleteSettled = obsolete && !obsoleteBlocking;
  const identityUnknown = gate !== null && identity === 'unknown';

  return (
    <div className="stack" aria-label="External plan review">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">External plan review</div>
        {gate ? <span className={`tag ${gate.status === 'proceeded' ? 'tag--ok' : gate.status === 'failed' ? 'tag--danger' : 'tag--warn'}`}>{gate.status.replace(/_/g, ' ')}</span> : null}
      </div>
      {loading ? <div className="muted">Loading rule and review evidence…</div> : null}
      {!integrationEnabled ? (
        <Notice tone="warn">This task is bound to external review evidence. Re-enable the integration in Settings to continue it.</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {gate && gate.status !== 'awaiting_resolve' ? (
        <div className="kv" aria-label="External plan review result">
          <span className="kv__k">Result</span><span className="kv__v">{gate.verdict ?? 'No verdict recorded'}</span>
          <span className="kv__k">Required action</span><span className="kv__v">{guidanceState.replace(/_/g, ' ')}</span>
          <span className="kv__k">Reviewers</span><span className="kv__v selectable">{gate.reviewers}</span>
        </div>
      ) : null}
      {gate && gate.status !== 'awaiting_resolve' && findings.length > 0 ? (
        <details>
          <summary className="faint" style={{ cursor: 'pointer' }}>
            Findings ({findings.length})
          </summary>
          <div className="stack stack--tight" style={{ marginTop: 8 }}>
            {findings.map((finding, index) => (
              <div className="finding" key={`${index}:${finding.title}`}>
                <div className="finding__head">
                  <span className={`tag ${finding.severity === 'blocking' || finding.severity === 'major' ? 'tag--danger' : 'tag--warn'}`}>{finding.severity}</span>
                  <span className="finding__title selectable">{finding.title}</span>
                </div>
                <div className="finding__desc selectable">{finding.why}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {corrupt !== null ? (
        <Notice tone="error">
          <strong>The bound rule evidence cannot be read.</strong> This task is bound to a
          rule snapshot, but the stored bytes no longer match their recorded hash or no
          longer parse. Rebinding is refused because the binding is immutable, and Agent
          Relay will not silently replace evidence a specification was reviewed against.
          <div className="mono selectable" style={{ marginTop: 6 }}>{corrupt}</div>
        </Notice>
      ) : !detail?.ruleEvidence ? (
        <>
          <div className="muted">
            Capture the project&apos;s current rule files and the configured conventions before
            generating the specification. The resulting bytes and Git identity are immutable.
          </div>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || task.status !== 'DRAFT'}
            onClick={() => void act('bind', () => expect('planReview:bindRules', { taskId: task.id }))}
          >
            {busy === 'bind' ? <Spinner /> : <Scope kind="read" />} Capture and bind rules
          </button> : null}
          {task.status !== 'DRAFT' ? (
            <Notice tone="info">This existing task did not opt in before specification generation. Its normal workflow remains unchanged.</Notice>
          ) : null}
        </>
      ) : (
        <>
          <div className="kv">
            <span className="kv__k">Evidence</span>
            <span className="kv__v mono selectable">{detail.ruleEvidence.snapshotSha256}</span>
            <span className="kv__k">Sources</span>
            <span className="kv__v">{detail.ruleEvidence.sources.length}</span>
            <span className="kv__k">Files</span>
            <span className="kv__v">{detail.ruleEvidence.files.length}</span>
            <span className="kv__k">Bytes</span>
            <span className="kv__v">{detail.ruleEvidence.totalBytes.toLocaleString()}</span>
          </div>
          <details>
            <summary className="faint" style={{ cursor: 'pointer' }}>Captured files and omissions</summary>
            <div className="stack stack--tight" style={{ marginTop: 8 }}>
              {detail.ruleEvidence.files.map((file) => (
                <div className="filerow" key={`${file.sourceId}:${file.path}`}>
                  <span className="tag">{file.sourceId}</span>
                  <span className="filerow__path mono selectable">{file.path}</span>
                  <span className="filerow__stat faint">{file.bytes} B</span>
                </div>
              ))}
              {detail.ruleEvidence.omitted.map((item) => (
                <div className="filerow" key={`${item.sourceId}:${item.path}:${item.reason}`}>
                  <span className="tag tag--warn">omitted</span>
                  <span className="filerow__path mono selectable">{item.sourceId}: {item.path}</span>
                  <span className="filerow__stat faint">{item.reason}</span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      {renderPrimary && detail?.ruleEvidence && task.status === 'READY_FOR_IMPLEMENTATION' && gate === null ? (
        <button
          type="button"
          className="btn btn--wide btn--primary btn--recommended"
          disabled={!integrationEnabled || busy !== null}
          onClick={() => void act('prepare', () => expect('planReview:prepare', { taskId: task.id }))}
        >
          {busy === 'prepare' ? <Spinner /> : <Scope kind="local" />} Prepare isolated review branch
        </button>
      ) : null}

      {obsoleteSettled ? (
        <div className="stack stack--tight">
          <Notice tone="warn">
            This review settled against an earlier specification. The one on screen now has
            not been reviewed, so it cannot be approved on the strength of that round.
          </Notice>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || task.status !== 'READY_FOR_IMPLEMENTATION'}
            onClick={() => void act('prepare', () => expect('planReview:prepare', { taskId: task.id }))}
          >
            {busy === 'prepare' ? <Spinner /> : <Scope kind="local" />} Prepare isolated review branch
          </button> : null}
        </div>
      ) : null}

      {obsoleteBlocking ? (
        <Notice tone="warn">
          This review settled against an earlier specification, and its previous round is
          still outstanding. Finish that round first — regenerating the specification does
          not close it, and nothing here may start a second one over it.
        </Notice>
      ) : null}

      {identityUnknown ? (
        <Notice tone="warn">
          Whether this review still matches the current specification could not be
          established, because the bound evidence or the specification itself could not be
          read. That is not the same as the review being out of date, and Agent Relay will
          not say it is: nothing here is approved, and preparing a new review would need
          the evidence that could not be read.
        </Notice>
      ) : null}

      {dirtyPrompt ? (
        <Notice tone="warn">
          <div className="stack stack--tight" style={{ width: '100%' }}>
            <strong>Uncommitted files remain outside this task</strong>
            <div style={{ whiteSpace: 'pre-wrap' }}>{dirtyPrompt}</div>
            <span>
              The isolated task branch can use the checkout&apos;s current HEAD. Your uncommitted
              files stay untouched and are not copied into it.
            </span>
            {renderPrimary ? (
              <div className="row">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy !== null}
                  onClick={() => dispatchPlanPrimary('prepare_plan_review')}
                >
                  Continue with current HEAD
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busy !== null}
                  onClick={() => setDirtyPrompt(null)}
                >
                  Cancel
                </button>
              </div>
            ) : ' Click “Prepare isolated review branch” again to continue from the current HEAD.'}
          </div>
        </Notice>
      ) : null}

      {gate?.status === 'interrupted' && identity === 'current' ? (
        <Notice tone="warn">
          A previous round was started in the provider and never finished. It produced no
          findings and nothing is waiting on decisions, so a new round can be started by
          hand — nothing will be repeated.
        </Notice>
      ) : null}

      {/*
        Starting a round is offered only when the gate is PROVEN to describe the
        specification on screen. `obsolete` would review the wrong document, and
        `unknown` cannot say which document it would review — and a round is
        non-idempotent, so an unverifiable one is not worth spending. The same
        fixed label is used for a first round and a next round: the operator is
        starting the external review either way, and the distinction is already
        carried by "What happened" and "Result" above.
      */}
      {renderPrimary && gate && identity === 'current' && ['prepared', 'changes_requested', 'interrupted'].includes(gate.status) ? (
        <button
          type="button"
          className="btn btn--wide btn--primary btn--recommended"
          disabled={!integrationEnabled || busy !== null}
          onClick={() => void act('review', () => expect('planReview:review', { taskId: task.id }))}
        >
          {busy === 'review' ? <Spinner /> : <Scope kind="read" />} Run external plan review
        </button>
      ) : null}

      {unknownOutcome ? (
        <div className="stack stack--tight">
          <Notice tone="warn">
            The external call was recorded as {gate?.status.replace(/_/g, ' ')} and its answer
            never arrived. Agent Relay will not repeat it: a plan round and a resolution are
            not idempotent, and either may already have taken effect. Reconciling reads the
            provider&apos;s own state back without changing it.
          </Notice>
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null}
            onClick={() => void act('reconcile', () => expect('planReview:reconcile', { taskId: task.id }))}
          >
            {busy === 'reconcile' ? <Spinner /> : <Scope kind="read" />} Reconcile external state
          </button> : null}
        </div>
      ) : null}
      {gate?.lastError ? <Notice tone="error">{gate.lastError}</Notice> : null}

      {detail !== null &&
      (busy === 'revise' ||
        correctionResult !== null ||
        detail.correction.used > 0 ||
        detail.correction.acceptedPending > 0) ? (
        <div className="stack stack--tight" aria-label="Plan correction">
          <div className="kv">
            <span className="kv__k">Correction rounds</span>
            <span className="kv__v">
              {detail.correction.used} of {detail.correction.max} used
            </span>
            <span className="kv__k">Specification versions</span>
            <span className="kv__v">
              {detail.correction.versions.length === 0
                ? 'Only the generated specification so far'
                : detail.correction.versions
                    .map((version) => `v${version.version} (${version.origin === 'plan_correction' ? 'revised' : 'generated'})`)
                    .join(' → ')}
            </span>
          </div>
          {detail.correction.latest?.status === 'completed' && detail.correction.latest.addressed.length > 0 ? (
            <div className="stack stack--tight" aria-label="What the last revision changed">
              <strong>What Codex changed for each accepted finding (round {detail.correction.latest.round})</strong>
              {detail.correction.latest.addressed.map((entry) => (
                <div className="faint selectable" key={`${entry.finding}:${entry.field}`}>
                  {entry.title} — <span className="mono">{entry.field}</span>: {entry.change}
                </div>
              ))}
            </div>
          ) : null}
          {busy === 'revise' ? (
            <Notice tone="info" role="status">
              <Spinner />
              <span>{loopPhaseText(detail)}</span>
            </Notice>
          ) : null}
          {busy !== 'revise' && correctionResult === null && detail.correction.latest?.lastError ? (
            <Notice tone="error" role="alert">
              <div className="stack stack--tight">
                <strong>
                  Correction round {detail.correction.latest.round} {detail.correction.latest.status === 'interrupted' ? 'was interrupted' : 'failed'}.
                  The specification was not changed by it.
                </strong>
                <span className="selectable">{detail.correction.latest.lastError}</span>
              </div>
            </Notice>
          ) : null}
          {busy !== 'revise' && detail.correction.nextStep === 'round_limit' ? (
            <Notice tone="error" role="alert">
              The correction budget ({detail.correction.max} round(s)) is spent and {detail.correction.acceptedPending}{' '}
              accepted finding(s) are still not in the specification, so it cannot be approved. Raise the maximum review
              rounds in Settings, or regenerate the specification.
            </Notice>
          ) : null}
          {busy !== 'revise' && correctionResult !== null ? (
            'stopped' in correctionResult ? (
              <Notice tone="warn" role="status">
                <div className="stack stack--tight">
                  <strong>The task was stopped. The correction loop ended and nothing further was changed.</strong>
                  <span className="selectable">{correctionResult.stopped}</span>
                </div>
              </Notice>
            ) : 'failure' in correctionResult ? (
              <Notice tone="error" role="alert">
                <div className="stack stack--tight">
                  <strong>The correction loop stopped. Nothing further was changed.</strong>
                  <span className="selectable">{correctionResult.failure}</span>
                </div>
              </Notice>
            ) : (
              <Notice
                tone={correctionResult.outcome.stopped === 'clean' ? 'success' : correctionResult.outcome.stopped === 'awaiting_decisions' ? 'info' : 'warn'}
                role="status"
              >
                <div className="stack stack--tight">
                  <strong>
                    {correctionResult.outcome.correctionsRun} correction(s) run · {correctionResult.outcome.roundsReviewed} review round(s)
                  </strong>
                  <span className="selectable">{correctionResult.outcome.message}</span>
                </div>
              </Notice>
            )
          ) : null}
          {renderPrimary &&
          busy !== 'revise' &&
          (detail.correction.nextStep === 'revise' ||
            (detail.correction.nextStep === 'run_review' && detail.correction.latest?.status === 'completed')) ? (
            <div className="review-actions">
              <button
                type="button"
                className="btn btn--primary btn--recommended"
                disabled={!integrationEnabled || busy !== null}
                onClick={() => dispatchPlanPrimary('continue_plan_correction')}
              >
                <Scope kind="read" /> Continue correction
              </button>
              <span className="faint">
                Picks up where the loop stopped. Nothing already done is repeated.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {gate?.status === 'awaiting_resolve' ? (
        <div className="stack">
          <Notice tone="warn">
            The verdict does not approve the plan. Decide every finding, then resolve the
            external round. Rejecting a finding requires a written reason.
          </Notice>
          <DecisionGlossary subject="plan" />
          <div className="kv">
            <span className="kv__k">Verdict</span><span className="kv__v">{gate.verdict}</span>
            <span className="kv__k">Gating</span><span className="kv__v">{gate.gatingCount} / threshold {gate.threshold}</span>
            <span className="kv__k">Reviewers</span><span className="kv__v selectable">{gate.reviewers}</span>
          </div>
          <div className="review-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!integrationEnabled || busy !== null || bulkIndexes.length === 0}
              title={
                bulkIndexes.length === 0
                  ? 'Nothing left to analyze: every finding already has a decision, a draft, or needs you.'
                  : 'Codex analyzes every undecided finding and accepts or rejects it for you. It never touches a decision you made, and stops on any it cannot decide.'
              }
              onClick={() => startAutoDecide(bulkIndexes, true)}
            >
              {queue.busy ? <Spinner /> : null} Auto decide all undecided
              {bulkIndexes.length > 0 ? ` (${bulkIndexes.length})` : ''}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              title="Discards the choices you have made by hand and not yet resolved. Decisions Auto decide already saved stay."
              disabled={busy !== null || Object.keys(decisions).length === 0}
              onClick={() => setDecisions(() => ({}))}
            >
              Clear unsaved decisions
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              title="Dangerous: accepts every undecided finding without analyzing any of them."
              disabled={busy !== null || allDecided}
              onClick={() => setConfirmBlind(true)}
            >
              Accept all without analysis
            </button>
          </div>
          {confirmBlind ? (
            <Notice tone="warn">
              <div className="stack stack--tight">
                <strong>Accept every undecided finding without looking at any of them?</strong>
                <span>
                  Nothing is analyzed. Every accepted finding becomes a required correction to the plan, so a
                  finding that is wrong will be built into the specification.
                </span>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => {
                      setConfirmBlind(false);
                      findings.forEach((_, index) => {
                        // Never over a draft the operator has, or a decision already saved.
                        if (!hasDraft(index) && !autoByFinding.has(index)) {
                          editFinding(index, { action: 'accept', reason: '' });
                        }
                      });
                    }}
                  >
                    Yes, accept all without analysis
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmBlind(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}
          {queue.summary ? (
            <AutoDecideSummaryLine
              summary={queue.summary}
              disabled={busy !== null}
              onRetryFailed={() => startAutoDecide(queue.failedKeys, true)}
            />
          ) : null}
          {findings.map((finding, index) => {
            const decision = effective(index);
            const saved = autoByFinding.get(index);
            const stop = needsUserByFinding.get(index);
            const chosen = decisions[index]?.action;
            return (
              <div className="finding" key={`${index}:${finding.title}`}>
                <div className="finding__head">
                  <span className={`tag ${finding.severity === 'blocking' || finding.severity === 'major' ? 'tag--danger' : 'tag--warn'}`}>{finding.severity}</span>
                  <span className="finding__title selectable">{finding.title}</span>
                  <span className="finding__where selectable">{finding.category}{finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}</span>
                </div>
                <div className="finding__desc selectable">{finding.why}</div>
                <div className="muted selectable" style={{ marginTop: 6 }}>Suggested: {finding.fix}</div>
                <AutoFindingStatus
                  facts={{
                    queue: autoStateOf(index),
                    decided: saved ? { action: saved.action, confidence: saved.confidence, evidenceRef: saved.evidenceRef } : null,
                    needsUser: stop ? { reason: stop.reason, evidenceRef: stop.evidenceRef, confidence: stop.confidence } : null,
                    operatorChoice: chosen ? chosen : null
                  }}
                />
                <div className="decision-row">
                  <div className="decision-row__decision">
                    <Field label="Decision">
                      <select
                        className="select"
                        value={decision.action}
                        onChange={(event) => editFinding(index, {
                          ...decision,
                          action: event.target.value as DecisionDraft['action']
                        })}
                      >
                        <option value="">Choose…</option>
                        <option value="accept">Accept and address</option>
                        <option value="reject">Reject with reason</option>
                      </select>
                    </Field>
                  </div>
                  <AutoDecideButton
                    state={autoStateOf(index)}
                    findingLabel={finding.title}
                    disabled={!integrationEnabled || busy !== null}
                    blockedReason={
                      !integrationEnabled
                        ? 'External plan review is turned off in Settings. Turn it back on to use Auto decide.'
                        : hasDraft(index)
                        ? 'You have already chosen a decision for this finding. Clear it first if you want Auto decide to decide instead.'
                        : needsUserByFinding.has(index)
                          ? 'Auto decide stopped on this finding on purpose. It needs your decision.'
                          : null
                    }
                    onClick={() => startAutoDecide([index], false)}
                  />
                  <div className="decision-row__reason">
                    <Field label="Reason" hint={decision.action === 'reject' ? 'Required' : 'Optional audit note'}>
                      <input
                        className="input"
                        value={decision.reason}
                        onChange={(event) => editFinding(index, { ...decision, reason: event.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            );
          })}
          {acceptedCount > 0 ? (
            <div className="stack stack--tight">
              <Notice tone="info">
                {acceptedCount} accepted finding(s) will be folded into the specification: Codex revises it from those
                findings only, and the revised specification is reviewed again before anything can be approved.
              </Notice>
              <label className="row">
                <input
                  type="checkbox"
                  checked={autoContinue}
                  disabled={busy !== null}
                  onChange={(event) => setAutoContinue(event.target.checked)}
                />
                <span>Keep going automatically while every new finding can be auto-decided</span>
              </label>
            </div>
          ) : null}
          {renderPrimary ? <button
            type="button"
            className="btn btn--wide btn--primary btn--recommended"
            disabled={!integrationEnabled || busy !== null || queue.busy || !allDecided}
            onClick={() => dispatchPlanPrimary('resolve_plan_review')}
          >
            {busy === 'resolve' || busy === 'revise' ? <Spinner /> : <Scope kind="read" />}{' '}
            {acceptedCount > 0 ? 'Resolve and revise plan' : 'Resolve external plan review'}
          </button> : null}
        </div>
      ) : null}

      {gate?.status === 'proceeded' && identity === 'current' ? (
        <Notice tone="info">The exact specification and rule snapshot passed resolution. You may now approve the specification.</Notice>
      ) : null}
    </div>
  );
}
