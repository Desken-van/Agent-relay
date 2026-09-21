/**
 * The relay timeline.
 *
 * Each run is a full-width card in chronological order. Colour still encodes
 * who acted — a 3px agent-coloured left border plus the coloured agent tag —
 * so the "who has the baton" glance read survives without the old two-lane,
 * half-width layout that clipped headers and squeezed the event log into a
 * handful of characters per column.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run, RunEvent } from '@shared/domain/models';
import { readVerification } from '@shared/domain/verification';
import { isOrnithToolDenialEventData, type OrnithToolDenialEventData } from '@shared/domain/ornith';
import {
  formatVerificationDuration,
  isOrnithVerificationEventData,
  type OrnithVerificationEventData
} from '@shared/domain/ornith-verification';
import { call } from '../lib/api';
import { readClaudeAssessment } from '@shared/domain/claude-assessment';
import { decodeEvent, formatDuration, formatTime } from '../lib/format';
import { useStore } from '../state/store';
import { agentTone, Empty } from './primitives';

const RUN_LABELS: Record<Run['runType'], string> = {
  verification: 'Verification · npm run verify',
  specification: 'Specification',
  implementation: 'Implementation',
  review: 'Review',
  correction: 'Correction',
  git: 'Git',
  github: 'GitHub',
  dependencies: 'Install dependencies'
};

const AGENT_LABELS: Record<Run['agent'], string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  ornith: 'Ornith',
  system: 'Agent Relay'
};

export function RelayTimeline({ runs }: { runs: readonly Run[] }): React.JSX.Element {
  // The newest run is expanded by default; older ones collapse to keep the spine
  // legible. Only the user's explicit toggles are stored, so "which node is open"
  // is derived rather than synchronised — no effect, and the default follows the
  // newest run automatically as the relay progresses.
  const newestId = runs.at(-1)?.id ?? null;
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  if (runs.length === 0) {
    return (
      <Empty
        title="Nothing has run yet"
        hint="Generate a specification to put the first node on the timeline."
      />
    );
  }

  return (
    <div className="relay">
      {runs.map((run) => {
        const defaultOpen = run.id === newestId;
        const open = toggled[run.id] ?? defaultOpen;
        return (
          <RelayNode
            key={run.id}
            run={run}
            open={open}
            onToggle={() => setToggled((current) => ({ ...current, [run.id]: !open }))}
          />
        );
      })}
    </div>
  );
}

function RelayNode({
  run,
  open,
  onToggle
}: {
  run: Run;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const tone = agentTone(run.agent);
  const running = run.status === 'running';

  return (
    <div className={`relay__node relay__node--${tone}`}>
      <button type="button" className="relay__head" onClick={onToggle} aria-expanded={open}>
        <span
          className={`relay__dot relay__dot--${tone}${running ? ' relay__dot--running' : ''}`}
          style={{ width: 9, height: 9 }}
          aria-hidden="true"
        />
        <span className={`relay__chevron${open ? ' relay__chevron--open' : ''}`} aria-hidden="true">
          ▶
        </span>
        <span className={`tag tag--${tone}`}>{AGENT_LABELS[run.agent]}</span>
        <span className="relay__label">{RUN_LABELS[run.runType]}</span>
        {run.round > 0 ? <span className="tag">round {run.round}</span> : null}
        <RunStatusTag run={run} />
        <VerificationTag run={run} />
        <span className="relay__time">{formatDuration(run.startedAt, run.finishedAt)}</span>
      </button>

      {open ? <RelayNodeBody run={run} /> : null}
    </div>
  );
}

function RunStatusTag({ run }: { run: Run }): React.JSX.Element {
  switch (run.status) {
    case 'running':
      return <span className="tag tag--warn">running</span>;
    case 'succeeded':
      return <span className="tag tag--ok">done</span>;
    case 'failed':
      return <span className="tag tag--danger">failed</span>;
    case 'cancelled':
      return <span className="tag">cancelled</span>;
    default:
      return <span className="tag">{run.status}</span>;
  }
}

/**
 * How a round's verification ended, for the run header.
 *
 * Renders nothing for a run with no assessment — a specification round, or an
 * implementation round from before this existed. An older task has to keep
 * opening cleanly, so an unreadable or newer record is simply not shown rather
 * than being guessed at or thrown over.
 */
function VerificationTag({ run }: { run: Run }): React.JSX.Element | null {
  if (run.runType === 'verification') {
    const record = readVerification(run);
    return <span className={`tag tag--${record.success && record.data.passed ? 'ok' : 'warn'}`}>snapshot verification {record.success && record.data.passed ? 'passed' : 'unconfirmed'}</span>;
  }
  const result = readClaudeAssessment(run.structuredResult);
  if (!result.ok) return null;

  const { verificationStatus: status, publishBlock, reasonCodes } = result.assessment;
  // Agent-side verification runs inside the provider sandbox and is diagnostic.
  // Relay's separate snapshot verification is authoritative, so an unavailable
  // or failed provider check is a warning here rather than a failed run.
  const tone = status === 'passed' ? 'ok' : 'warn';

  // "not run" alone reads as an unexplained problem with verification itself,
  // but a round can just as easily fail for a reason that never reaches
  // verification at all (a read-only tool timeout, a resource limit, a
  // security refusal). When that is why, name the real reason on the tag
  // itself rather than leaving it to the hover-only title.
  if (status === 'not_run' && publishBlock !== 'none' && publishBlock !== 'verification') {
    const reason = reasonCodes[0]?.replace(/_/g, ' ') ?? 'not reached';
    return (
      <span className="tag tag--warn" title={reasonCodes.join(', ')}>
        verification not reached ({reason})
      </span>
    );
  }

  return (
    <span className={`tag tag--${tone}`} title={reasonCodes.join(', ')}>
      provider verification {status.replace(/_/g, ' ')}
    </span>
  );
}

/** One denied command, as the warning event recorded it. */
interface DenialDetail {
  readonly tool?: unknown;
  readonly command?: unknown;
  readonly reason?: unknown;
  readonly category?: unknown;
  readonly resolved?: unknown;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A warning line, with the denials behind it available on demand.
 *
 * Collapsed by default: the sentence is the part that matters, and a round with
 * six auxiliary denials should not push the rest of the log off the screen.
 */
function WarningLine({
  text,
  data
}: {
  text: string;
  data: Record<string, unknown> | null;
}): React.JSX.Element {
  const raw = data?.['denials'];
  const denials: DenialDetail[] = Array.isArray(raw) ? (raw as DenialDetail[]) : [];

  return (
    <div className="logs__warning">
      <div className="logs__text selectable">{text}</div>
      {denials.length > 0 ? (
        <details className="logs__denials">
          <summary>
            {denials.length} denied command{denials.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {denials.map((denial, index) => (
              <li key={index}>
                <span className="mono">{asText(denial.tool) ?? 'unknown tool'}</span>
                {': '}
                <span className="mono selectable">
                  {asText(denial.command) ?? '(command not reported)'}
                </span>
                <div className="faint">
                  {asText(denial.category) ?? 'unknown'}
                  {/* "retried", not "retried successfully": a denied command
                      can be run again and fail, and the retry still resolves
                      the denial. What the retry produced is the verification
                      status in the run header, not a claim made here. */}
                  {denial.resolved === true ? ' · retried' : ''}
                  {asText(denial.reason) === null ? '' : ` · ${asText(denial.reason) ?? ''}`}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The limits a byte-related denial can name: the two budgets and the per-file size bound. Each
 * carries its own label — the size bound is never called an exhausted budget — and the safe
 * next step once the run has stopped on it.
 */
const ORNITH_BUDGET_DENIALS: Partial<Record<OrnithToolDenialEventData['code'], { readonly label: string; readonly next: string }>> = {
  limit_read_bytes_exceeded: {
    label: 'repository discovery budget exhausted',
    next: 'retry naming the exact file(s) so Ornith reads them instead of searching'
  },
  limit_mutation_validation_bytes_exceeded: {
    label: 'internal edit-validation budget exhausted',
    next: 'retry with a smaller change, or split it across smaller files'
  },
  limit_mutation_target_bytes_exceeded: {
    label: 'file above the per-change size limit (no budget exhausted)',
    next: 'split the change so each edit touches a smaller file, or make it by hand'
  }
};

/**
 * A precise line for an Ornith denied-action event, replacing the plain
 * "Ornith action X denied (code)." text with the exact facts an operator
 * needs: which action, which code, WHICH of the two byte budgets ran out
 * (repository discovery vs. internal edit validation — they are separate and
 * never conflated), the used/configured bytes of each, whether the run may
 * still retry/pivot or has stopped, whether anything has changed yet, and, once
 * stopped on a budget, the safe next step — never a generic "unsafe or
 * over-limit action" message when a precise reason already exists in `data`.
 * Events recorded before the edit-validation budget existed carry no
 * validation figures, and simply omit that part.
 */
function OrnithDenialLine({ data }: { data: OrnithToolDenialEventData }): React.JSX.Element {
  const budget = ORNITH_BUDGET_DENIALS[data.code];
  const hasValidation =
    typeof data.validationBytesUsed === 'number' && typeof data.validationBytesConfigured === 'number';
  return (
    <div className="logs__text selectable">
      Ornith action <span className="mono">{data.action}</span> denied (
      <span className="mono">{data.code}</span>)
      {budget ? ` — ${budget.label}` : ''} · discovery budget {data.readBytesUsed} /{' '}
      {data.readBytesConfigured} bytes
      {hasValidation
        ? ` · edit-validation budget ${data.validationBytesUsed} / ${data.validationBytesConfigured} bytes`
        : ''}{' '}
      · {data.recoverable ? 'recovering with feedback' : 'the run stopped'} ·{' '}
      {data.changedFiles === 0 ? 'no files changed yet' : `${data.changedFiles} file(s) changed`}
      {budget && !data.recoverable ? ` · next: ${budget.next}` : ''}
    </div>
  );
}

const VERIFICATION_OUTCOME_WORDS: Record<OrnithVerificationEventData['verification']['outcome'], string> = {
  passed: 'passed',
  failed: 'FAILED',
  timed_out: 'TIMED OUT',
  cancelled: 'was CANCELLED'
};

/**
 * An Ornith `run_verification` event. Two facts, said separately: the action ran (`dispatched`), and the
 * verification's own outcome — with its command, exit code, duration, reason and the bounded, sanitized tail
 * of its output. A failed verification must never read as a success just because the action was dispatched.
 */
function OrnithVerificationLine({ data }: { data: OrnithVerificationEventData }): React.JSX.Element {
  const verification = data.verification;
  return (
    <div className="logs__text selectable">
      Ornith verification <span className="mono">{verification.command}</span>{' '}
      {VERIFICATION_OUTCOME_WORDS[verification.outcome]}
      {verification.exitCode !== null ? ` · exit code ${verification.exitCode}` : ''}
      {` · ${formatVerificationDuration(verification.durationMs)}`}
      {verification.reason ? ` · ${verification.reason}` : ''}
      {verification.summary.length > 0 ? (
        <details>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>Command output (bounded)</summary>
          <pre className="pre selectable" style={{ marginTop: 6 }}>{verification.summary}</pre>
        </details>
      ) : null}
    </div>
  );
}

function RelayNodeBody({ run }: { run: Run }): React.JSX.Element {
  const { liveEvents } = useStore();
  const [stored, setStored] = useState<RunEvent[] | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Stored history is fetched once per run. State is only written after the
  // await resolves, and the `active` flag drops a response that arrives after
  // the node has been collapsed or the task switched.
  useEffect(() => {
    let active = true;
    void call('runs:events', { runId: run.id, limit: 2000 }).then((result) => {
      if (!active) return;
      setStored(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [run.id]);

  const loading = stored === null;

  // Stored history plus anything streamed since, de-duplicated by id.
  const events = useMemo(() => {
    const merged = new Map<string, RunEvent>();
    for (const event of stored ?? []) merged.set(event.id, event);
    for (const event of liveEvents[run.id] ?? []) merged.set(event.id, event);
    return [...merged.values()];
  }, [stored, liveEvents, run.id]);

  // Follow the tail while the run is live.
  useEffect(() => {
    if (run.status === 'running' && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length, run.status]);

  return (
    <div className="relay__body">
      {run.runType === 'verification' ? (
        <RelayBodySection title="Verification evidence">
          <VerificationSummary run={run} />
        </RelayBodySection>
      ) : null}

      {run.finalMessage ? (
        <RelayBodySection title="Outcome">
          <div className="relay__final selectable">{run.finalMessage}</div>
        </RelayBodySection>
      ) : null}

      {run.errorMessage ? (
        <RelayBodySection title="Error">
          <div className="relay__error selectable">{run.errorMessage}</div>
        </RelayBodySection>
      ) : null}

      <RelayBodySection
        title={`Events${events.length > 0 ? ` (${events.length})` : ''}`}
        actions={
          events.length > 0 ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-expanded={logExpanded}
              onClick={() => setLogExpanded((current) => !current)}
            >
              {logExpanded ? 'Collapse event log' : 'Show full event log'}
            </button>
          ) : null
        }
      >
        {loading && events.length === 0 ? (
          <div className="faint">Loading events…</div>
        ) : events.length === 0 ? (
          <div className="faint">No events were recorded for this run.</div>
        ) : (
          <div className={`logs${logExpanded ? ' logs--full' : ''}`} ref={logRef}>
            {events.map((event) => {
              const decoded = decodeEvent(event);
              return (
                <div key={event.id} className={`logs__line logs__line--${event.type}`}>
                  <span className="logs__meta">
                    <span className="logs__time">{formatTime(event.timestamp)}</span>
                    <span className="logs__type">{event.type.replace(/_/g, ' ')}</span>
                  </span>
                  {event.type === 'warning' ? (
                    <WarningLine text={decoded.text} data={decoded.data} />
                  ) : event.type === 'tool_use' && isOrnithToolDenialEventData(decoded.data) ? (
                    <OrnithDenialLine data={decoded.data} />
                  ) : event.type === 'tool_use' && isOrnithVerificationEventData(decoded.data) ? (
                    <OrnithVerificationLine data={decoded.data} />
                  ) : (
                    <span className="logs__text selectable">{decoded.text}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </RelayBodySection>
    </div>
  );
}

/**
 * One labelled subsection of an expanded run: Verification evidence, Outcome,
 * Error or Events, each visually distinct rather than blended into one block.
 * `actions` sits beside the title — used by Events for its "Show full event
 * log" disclosure.
 */
function RelayBodySection({
  title,
  actions,
  children
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="relay__section">
      <div className="relay__section-head">
        <div className="section-title">{title}</div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function VerificationSummary({ run }: { run: Run }): React.JSX.Element | null {
  const record = readVerification(run);
  if (!record.success) return <div className="relay__final">No completed verification evidence. This does not prove a pass.</div>;
  const value = record.data;
  return <div className="relay__final selectable">
    <div>Command: {value.command}</div>
    <div>Exit: {value.exitCode ?? 'unknown'} · Duration: {value.durationMs} ms</div>
    <div>Snapshot: {value.identity.slice(0, 16)}…</div>
    <div>{value.reason ?? 'Passed for the recorded code snapshot.'}</div>
    <div className="hint">Historical result. Current files are checked again before review and publishing.</div>
  </div>;
}
