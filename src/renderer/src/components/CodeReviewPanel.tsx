/**
 * External code review, folded into Run → Actions, alongside `PlanReviewPanel`.
 *
 * Unlike the plan gate, code review has no single row that answers "resolve
 * everything at once": each finding is decided independently and durably via
 * `codeReview:decide`. "Auto decide" asks Codex about ONE finding and, for an
 * accept or a reject, records that same durable decision at once — so the
 * result is on the finding when the click finishes, not waiting for a second
 * "apply" step. "Auto decide all undecided" does that for every finding that has
 * no decision and no draft, a few at a time, and one failure never erases the
 * others' results.
 *
 * Accepting a finding says it is valid; it does not change any code. Accepted
 * findings are therefore shown as correction requirements, handed to the
 * existing correction round, and closed only after a fresh review of the
 * corrected code exists.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { correctionAction } from '@shared/domain/claude-assessment';
import type { Task } from '@shared/domain/models';
import {
  codeReviewCurrentTriageRecommendations,
  type CodeReviewDecisionAction,
  type CodeReviewFinding
} from '@shared/domain/code-review';
import type { CodeReviewDetail } from '@shared/ipc';
import { ApiError, call, expect } from '../lib/api';
import { Field, Notice, Spinner } from './primitives';
import {
  AutoDecideButton,
  AutoDecideSummaryLine,
  AutoFindingStatus,
  DecisionGlossary,
  useAnalysisState,
  useAutoDecideQueue,
  type AutoDecideKind
} from './review-findings';

type CodeDecisionDraft = { action: '' | CodeReviewDecisionAction; reason: string };
const NO_CODE_DECISIONS: Record<string, CodeDecisionDraft> = {};
const NO_CODE_FINDINGS: readonly CodeReviewFinding[] = [];
const NO_ANALYZING: readonly string[] = [];
/** Findings analyzed at once. Each analysis re-reads the working tree, so this stays small. */
const AUTO_DECIDE_CONCURRENCY = 2;

const REQUIREMENT_STATUS_TEXT = {
  open: 'Open — the code has not changed since this was accepted.',
  awaiting_fresh_review:
    'The code has moved on. Capture it and run a fresh external review to see whether this is fixed.',
  fresh_review_done:
    'A fresh review of the corrected code has run. Compare it with this finding, then mark it resolved if it is fixed.'
} as const;

function subjectIdentityLabel(identity: CodeReviewDetail['subjectIdentity']): string {
  switch (identity) {
    case 'no_subject': return 'no subject captured';
    case 'current': return 'current';
    case 'stale': return 'stale — code has changed';
    case 'unknown': return 'unknown — could not be read';
    case 'incomplete': return 'incomplete capture';
  }
}

/** A failed call as the operator should read it: what went wrong, then the backend's own next step. */
function describeFailure(caught: unknown): string {
  if (!(caught instanceof Error)) return String(caught);
  const remediation = caught instanceof ApiError ? caught.remediation : undefined;
  return remediation ? `${caught.message} ${remediation}` : caught.message;
}

export function CodeReviewPanel({
  task,
  integrationEnabled,
  latestClaudeResult = null,
  onCorrectionsSent
}: {
  task: Task;
  integrationEnabled: boolean;
  /** `structured_result` of the newest implementation round, so the correction action is judged like the backend judges it. */
  latestClaudeResult?: string | null;
  /** Called with the task after a correction round has been sent, so the screen can show it. */
  onCorrectionsSent?: (task: Task) => void | Promise<void>;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<CodeReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<{
    readonly subjectSha256: string | null;
    readonly drafts: Record<string, CodeDecisionDraft>;
  }>({ subjectSha256: null, drafts: {} });
  const [resolveReasons, setResolveReasons] = useState<Record<string, string>>({});
  // Findings whose automatic decision the operator is overruling, and why.
  const [changing, setChanging] = useState<Record<string, boolean>>({});
  const [changeReasons, setChangeReasons] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<void> => {
    const result = await call('codeReview:get', { taskId: task.id });
    if (result.ok) setDetail(result.data);
  }, [task.id]);

  useEffect(() => {
    let active = true;
    void call('codeReview:get', { taskId: task.id }).then((result) => {
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

  const findings = detail?.findings ?? NO_CODE_FINDINGS;
  // Keyed on the subject alone — never on any property of the live findings
  // themselves. Drafts are already stored per finding id, so an individual
  // finding's own draft naturally stays valid for as long as its id is
  // still worth showing controls for; nothing about a SIBLING finding
  // deciding, appearing (a new review round adding one), or disappearing
  // has any bearing on that. Only a genuinely different subject — code that
  // is no longer the code these drafts were written against — invalidates
  // them wholesale.
  const currentSubjectSha256 = detail?.subject?.subjectSha256 ?? null;
  const decisions = draftState.subjectSha256 === currentSubjectSha256 ? draftState.drafts : NO_CODE_DECISIONS;
  const setDecisions = useCallback(
    (update: (current: Record<string, CodeDecisionDraft>) => Record<string, CodeDecisionDraft>): void => {
      setDraftState((current) => ({
        subjectSha256: currentSubjectSha256,
        drafts: update(current.subjectSha256 === currentSubjectSha256 ? current.drafts : {})
      }));
    },
    [currentSubjectSha256]
  );

  const latestDecisions = detail?.latestDecisions ?? {};
  const undecidedFindings = findings.filter((f) => !latestDecisions[f.id]);
  const undecidedIds = undecidedFindings.map((f) => f.id);

  // A stop Codex made on purpose, per finding. Filtered per finding, not gated
  // as one all-or-nothing block: a decision on one covered finding must not hide
  // a still-accurate answer for another. A subject change is still
  // all-or-nothing (nothing it covers is current code anymore). See
  // `codeReviewCurrentTriageRecommendations`.
  const needsUserById = new Map(
    (detail
      ? codeReviewCurrentTriageRecommendations(detail.triage, detail.subject?.subjectSha256 ?? null, findings)
      : []
    )
      .filter((entry) => entry.recommendation === 'needs_user')
      .map((entry) => [entry.findingId, entry] as const)
  );

  /* -------------------------------- Auto decide -------------------------------- */

  const runAutoDecide = useCallback(async (findingId: string): Promise<AutoDecideKind> => {
    let answer;
    try {
      answer = await expect('codeReview:autoDecide', { taskId: task.id, findingId });
    } catch (caught) {
      throw new Error(describeFailure(caught));
    }
    setDetail(answer.detail);
    switch (answer.outcome.kind) {
      case 'decided':
        return answer.outcome.action;
      case 'needs_user':
        return 'needs_user';
      case 'already_decided':
        return 'skipped';
    }
  }, [task.id]);
  const queue = useAutoDecideQueue<string>({
    concurrency: AUTO_DECIDE_CONCURRENCY,
    run: runAutoDecide,
    // Several answers finish out of order and each carries the whole detail, so
    // once the queue drains the panel reads the truth back once.
    onIdle: () => void refresh()
  });
  const autoStateOf = useAnalysisState({ queue, analyzing: detail?.analyzing ?? NO_ANALYZING, refresh });
  // "Undecided" for the bulk action: no durable decision, nothing being drafted,
  // and not a finding Codex already stopped on. Failed ones are included.
  const bulkIds = undecidedFindings
    .filter((finding) => {
      const draft = decisions[finding.id];
      const state = autoStateOf(finding.id);
      return (
        (draft === undefined || (draft.action === '' && draft.reason.trim().length === 0)) &&
        !needsUserById.has(finding.id) &&
        (state === undefined || state.phase === 'failed')
      );
    })
    .map((finding) => finding.id);

  /**
   * Every mutation goes through here. `operation` performs exactly one
   * durable write and then this ALWAYS re-reads `codeReview:get` — even when
   * `operation` threw — so `detail` never reflects a locally guessed outcome.
   */
  const act = useCallback(async (key: string, operation: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(key);
    let opError: string | null = null;
    try {
      await operation();
    } catch (caught) {
      opError = describeFailure(caught);
    }
    // The single-flight guard is released in `finally` below regardless of
    // what happens here: `call` (unlike `expect`) is documented to resolve
    // rather than reject, but a reread that somehow threw anyway must not
    // leave every control on this panel permanently disabled.
    try {
      const result = await call('codeReview:get', { taskId: task.id });
      if (result.ok) setDetail(result.data);
      setError(opError ?? (result.ok ? null : result.error.message));
    } catch (caught) {
      setError(opError ?? (caught instanceof Error ? caught.message : String(caught)));
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  }, [task.id]);

  if (task.worktreePath === null) return null;
  if (!integrationEnabled && detail?.subject == null) return null;

  const subject = detail?.subject ?? null;
  const identity = detail?.subjectIdentity ?? 'no_subject';
  const canCapture = integrationEnabled && busy === null && !queue.busy;
  const canReview = integrationEnabled && busy === null && !queue.busy && identity === 'current';
  // `rounds` is oldest-first (see `CodeReviewRepository.listRounds`); the
  // latest is the last entry, not the first.
  const latestRound = detail?.rounds.at(-1) ?? null;
  const canReconcile = integrationEnabled && busy === null && !queue.busy && latestRound !== null &&
    ['requested', 'reviewing', 'interrupted'].includes(latestRound.status);

  const decide = (finding: CodeReviewFinding, action: CodeReviewDecisionAction, reason: string): void => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    void act(`decide:${finding.id}`, () => expect('codeReview:decide', {
      taskId: task.id,
      findingId: finding.id,
      expectedRevision: finding.revision,
      action,
      reason: trimmed
    }).then(() => undefined));
  };

  const requirements = detail?.correctionRequirements ?? [];
  const sendAction = correctionAction({
    status: task.status,
    currentRound: task.currentRound,
    maxRounds: task.maxRounds,
    latestClaudeStructuredResult: latestClaudeResult,
    externalRequirementsOpen: requirements.length > 0
  });
  // CHANGES_REQUESTED already offers "Send corrections"; the accepted findings
  // ride that same round, so the button here is the same action, not a second one.
  const canSendCorrections =
    requirements.length > 0 && (sendAction.kind === 'external_corrections' || sendAction.kind === 'corrections');

  return (
    <div className="stack" aria-label="External code review">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">External code review</div>
        {subject ? <span className={`tag ${identity === 'current' ? 'tag--ok' : 'tag--warn'}`}>{subjectIdentityLabel(identity)}</span> : null}
      </div>
      {loading ? <div className="muted">Loading code-review evidence…</div> : null}
      {!integrationEnabled ? (
        <Notice tone="warn">This task is bound to external code-review evidence. Re-enable the integration in Settings to continue it.</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {detail?.identityProblem ? <Notice tone="warn">{detail.identityProblem}</Notice> : null}

      {subject ? (
        <div className="kv">
          <span className="kv__k">Subject</span><span className="kv__v mono selectable">{subject.subjectSha256}</span>
          <span className="kv__k">Files</span><span className="kv__v">{subject.fileCount}</span>
          <span className="kv__k">Bytes</span><span className="kv__v">{subject.totalBytes.toLocaleString()}</span>
        </div>
      ) : (
        <div className="muted">Capture the current code as this task&apos;s review subject before running an external review.</div>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!canCapture}
          onClick={() => void act('capture', () => expect('codeReview:capture', { taskId: task.id }).then(() => undefined))}
        >
          {busy === 'capture' ? <Spinner /> : null} {subject ? 'Capture subject again' : 'Capture code-review subject'}
        </button>
        {latestRound && canReconcile ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy !== null}
            onClick={() => void act('reconcile', () => expect('codeReview:reconcile', { taskId: task.id }).then(() => undefined))}
          >
            {busy === 'reconcile' ? <Spinner /> : null} Reconcile outstanding round
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!canReview}
            onClick={() => void act('review', () => expect('codeReview:review', { taskId: task.id }).then(() => undefined))}
          >
            {busy === 'review' ? <Spinner /> : null} Run external code review
          </button>
        )}
      </div>

      {latestRound ? (
        <div className="kv">
          <span className="kv__k">Round status</span><span className="kv__v">{latestRound.status.replace(/_/g, ' ')}</span>
          <span className="kv__k">Verdict</span><span className="kv__v">{latestRound.verdict ?? 'No verdict recorded'}</span>
          <span className="kv__k">Reviewers</span><span className="kv__v selectable">{latestRound.reviewers ?? '—'}</span>
        </div>
      ) : null}

      {findings.length > 0 ? <DecisionGlossary subject="code" /> : null}

      {integrationEnabled && findings.length > 0 && undecidedIds.length > 0 ? (
        <div className="review-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null || bulkIds.length === 0}
            title={
              bulkIds.length === 0
                ? 'Nothing left to analyze: every finding has a decision, a draft, or needs you.'
                : 'Codex analyzes every undecided finding and records an accept or a reject for you. It never touches a finding that already has a decision, and stops on any it cannot decide.'
            }
            onClick={() => queue.start(bulkIds, { bulk: true })}
          >
            {queue.busy ? <Spinner /> : null} Auto decide all undecided
            {bulkIds.length > 0 ? ` (${bulkIds.length})` : ''}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            title="Discards the decisions you have typed and not yet submitted. Anything already recorded stays."
            disabled={busy !== null || Object.keys(decisions).length === 0}
            onClick={() => setDecisions(() => ({}))}
          >
            Clear unsaved decisions
          </button>
        </div>
      ) : null}
      {queue.summary ? (
        <AutoDecideSummaryLine
          summary={queue.summary}
          disabled={busy !== null}
          onRetryFailed={() => queue.retryFailed()}
        />
      ) : null}

      {findings.length > 0 && undecidedIds.length === 0 ? (
        <div className="muted">All live findings have decisions recorded.</div>
      ) : null}

      {findings.length === 0 ? (
        <div className="muted">No live findings for the current subject.</div>
      ) : (
        <div className="stack stack--tight">
          {findings.map((finding) => {
            const decided = latestDecisions[finding.id] ?? null;
            const draft = decisions[finding.id] ?? { action: '', reason: '' };
            const stop = needsUserById.get(finding.id);
            return (
              <div className="finding" key={finding.id}>
                <div className="finding__head">
                  <span className={`tag ${finding.severity === 'blocking' || finding.severity === 'major' ? 'tag--danger' : 'tag--warn'}`}>{finding.severity}</span>
                  <span className="finding__title selectable">{finding.title}</span>
                  <span className="finding__where selectable">{finding.category}{finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}</span>
                </div>
                <div className="finding__desc selectable">{finding.body}</div>
                {finding.fix ? <div className="muted selectable" style={{ marginTop: 6 }}>Suggested: {finding.fix}</div> : null}

                {decided ? (
                  <>
                    <div className="muted selectable" style={{ marginTop: 6 }}>
                      <strong>Decided: {decided.action}</strong>
                      {decided.actor === 'system' ? <span className="tag"> auto-decided</span> : null} — {decided.reason}
                    </div>
                    {/* Codex can be wrong. An automatic accept or reject stays in the audit history;
                        the operator's own decision is recorded after it and is the one in force. */}
                    {decided.actor === 'system' && decided.action !== 'resolved' ? (
                      changing[finding.id] === true ? (
                        <div className="decision-row">
                          <div className="decision-row__reason">
                            <Field label={`Why ${decided.action === 'accept' ? 'reject' : 'accept'} it instead?`} hint="Required">
                              <input
                                className="input"
                                value={changeReasons[finding.id] ?? ''}
                                onChange={(event) =>
                                  setChangeReasons((current) => ({ ...current, [finding.id]: event.target.value }))
                                }
                              />
                            </Field>
                          </div>
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={busy !== null || (changeReasons[finding.id] ?? '').trim().length === 0}
                            aria-label={`${decided.action === 'accept' ? 'Reject' : 'Accept'} instead: ${finding.title}`}
                            onClick={() => {
                              decide(finding, decided.action === 'accept' ? 'reject' : 'accept', changeReasons[finding.id] ?? '');
                              setChanging((current) => ({ ...current, [finding.id]: false }));
                            }}
                          >
                            {decided.action === 'accept' ? 'Reject instead' : 'Accept instead'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost"
                            onClick={() => setChanging((current) => ({ ...current, [finding.id]: false }))}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="row" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={busy !== null}
                            aria-label={`Change decision: ${finding.title}`}
                            title="Codex decided this. Overrule it with your own decision; the automatic one stays in the history."
                            onClick={() => setChanging((current) => ({ ...current, [finding.id]: true }))}
                          >
                            Change decision
                          </button>
                        </div>
                      )
                    ) : null}
                  </>
                ) : (
                  <>
                    <AutoFindingStatus
                      facts={{
                        queue: autoStateOf(finding.id),
                        decided: null,
                        needsUser: stop ? { reason: stop.reason, evidenceRef: stop.evidenceRef, confidence: stop.confidence } : null,
                        operatorChoice: null
                      }}
                    />
                    <div className="decision-row">
                      <div className="decision-row__decision">
                        <Field label="Decision">
                          <select
                            className="select"
                            value={draft.action}
                            onChange={(event) => setDecisions((current) => ({
                              ...current,
                              [finding.id]: { ...draft, action: event.target.value as CodeDecisionDraft['action'] }
                            }))}
                          >
                            <option value="">Choose…</option>
                            <option value="accept">Accept and address</option>
                            <option value="reject">Reject with reason</option>
                            <option value="resolved">Mark resolved (code has moved on)</option>
                          </select>
                        </Field>
                      </div>
                      <AutoDecideButton
                        state={autoStateOf(finding.id)}
                        findingLabel={finding.title}
                        disabled={!integrationEnabled || busy !== null}
                        blockedReason={
                          draft.action !== '' || draft.reason.trim().length > 0
                            ? 'You have already chosen a decision for this finding. Clear it first if you want Auto decide to decide instead.'
                            : null
                        }
                        onClick={() => queue.start([finding.id])}
                      />
                      <div className="decision-row__reason">
                        <Field label="Reason" hint="Required for every decision">
                          <input
                            className="input"
                            value={draft.reason}
                            onChange={(event) => setDecisions((current) => ({
                              ...current,
                              [finding.id]: { ...draft, reason: event.target.value }
                            }))}
                          />
                        </Field>
                      </div>
                    </div>
                    <div className="row" style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={!integrationEnabled || busy !== null || !draft.action || draft.reason.trim().length === 0}
                        onClick={() => decide(finding, draft.action as CodeReviewDecisionAction, draft.reason)}
                      >
                        {busy === `decide:${finding.id}` ? <Spinner /> : null} Submit decision
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {requirements.length > 0 ? (
        <div className="stack stack--tight" aria-label="Correction requirements">
          <div className="section-title">Correction requirements ({requirements.length})</div>
          <Notice tone="info">
            Accepting a finding says it is valid — it does not change any code. These stay open until a fresh
            review of the corrected code exists and you mark them resolved.
          </Notice>
          {requirements.map((requirement) => (
            <div className="finding" key={requirement.finding.id}>
              <div className="finding__head">
                <span className="finding__title selectable">{requirement.finding.title}</span>
                <span className="finding__where selectable">
                  {requirement.finding.file}
                  {requirement.finding.line ? `:${requirement.finding.line}` : ''}
                </span>
              </div>
              {requirement.finding.fix ? (
                <div className="muted selectable">Accepted correction: {requirement.finding.fix}</div>
              ) : null}
              <div className="faint">{REQUIREMENT_STATUS_TEXT[requirement.status]}</div>
              {requirement.status === 'fresh_review_done' ? (
                <div className="decision-row">
                  <div className="decision-row__reason">
                    <Field label="Why is this fixed?" hint="Required">
                      <input
                        className="input"
                        value={resolveReasons[requirement.finding.id] ?? ''}
                        onChange={(event) =>
                          setResolveReasons((current) => ({ ...current, [requirement.finding.id]: event.target.value }))
                        }
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={
                      busy !== null ||
                      (resolveReasons[requirement.finding.id] ?? '').trim().length === 0
                    }
                    aria-label={`Mark resolved: ${requirement.finding.title}`}
                    onClick={() => decide(requirement.finding, 'resolved', resolveReasons[requirement.finding.id] ?? '')}
                  >
                    Mark resolved
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {canSendCorrections ? (
            <div className="review-actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null || queue.busy || !sendAction.enabled}
                title={sendAction.disabledReason ?? undefined}
                onClick={() => void act('corrections', async () => {
                  const updated = await expect('workflow:sendCorrections', { taskId: task.id });
                  await onCorrectionsSent?.(updated);
                })}
              >
                {busy === 'corrections' ? <Spinner /> : null} Send accepted findings as corrections
              </button>
              <span className="faint">
                Sent to the implementation provider chosen for this task, as a correction round. It does not resolve
                anything: only a fresh review of the corrected code can.
              </span>
            </div>
          ) : (
            <div className="faint">
              Corrections can be sent from a ready or approved round, or after a review that asked for changes. This task
              is {task.status.replace(/_/g, ' ').toLowerCase()}.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
