/**
 * The relay spine.
 *
 * Each run is a node on a vertical timeline: Codex work sits in the left lane,
 * Claude's in the right, and system steps (Git, GitHub) straddle the middle. The
 * point is that a glance tells you who has the baton and how many times it has
 * changed hands — which is the one thing a generic log list never shows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run, RunEvent } from '@shared/domain/models';
import { call } from '../lib/api';
import {
  readClaudeAssessment,
  type ClaudeVerificationStatus
} from '@shared/domain/claude-assessment';
import { decodeEvent, formatDuration, formatTime } from '../lib/format';
import { useStore } from '../state/store';
import { agentTone, Empty } from './primitives';

const RUN_LABELS: Record<Run['runType'], string> = {
  specification: 'Specification',
  implementation: 'Implementation',
  review: 'Review',
  correction: 'Correction',
  git: 'Git',
  github: 'GitHub'
};

const AGENT_LABELS: Record<Run['agent'], string> = {
  codex: 'Codex',
  claude: 'Claude Code',
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
  const side = run.agent === 'claude' ? 'right' : run.agent === 'codex' ? 'left' : 'system';
  const running = run.status === 'running';

  return (
    <div className={`relay__node relay__node--${side === 'system' ? 'left relay__node--system' : side}`}>
      <div className="relay__marker">
        <span className={`relay__dot relay__dot--${tone}${running ? ' relay__dot--running' : ''}`} />
      </div>

      <div className="relay__card">
        <button type="button" className="relay__head" onClick={onToggle} aria-expanded={open}>
          <span className={`relay__chevron${open ? ' relay__chevron--open' : ''}`}>▶</span>
          <span className={`tag tag--${tone}`}>{AGENT_LABELS[run.agent]}</span>
          <span className="relay__label">{RUN_LABELS[run.runType]}</span>
          {run.round > 0 ? <span className="tag">round {run.round}</span> : null}
          <RunStatusTag run={run} />
          <VerificationTag run={run} />
          <span className="relay__time">{formatDuration(run.startedAt, run.finishedAt)}</span>
        </button>

        {open ? <RelayNodeBody run={run} /> : null}
      </div>
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
  const result = readClaudeAssessment(run.structuredResult);
  if (!result.ok) return null;

  const status: ClaudeVerificationStatus = result.assessment.verificationStatus;
  const tone =
    status === 'passed' ? 'ok' : status === 'failed' ? 'danger' : 'warn';

  return (
    <span className={`tag tag--${tone}`} title={result.assessment.reasonCodes.join(', ')}>
      verification {status.replace(/_/g, ' ')}
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

function RelayNodeBody({ run }: { run: Run }): React.JSX.Element {
  const { liveEvents } = useStore();
  const [stored, setStored] = useState<RunEvent[] | null>(null);
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
      {run.finalMessage ? (
        <div className="relay__final selectable">{run.finalMessage}</div>
      ) : null}

      {run.errorMessage ? <div className="relay__error selectable">{run.errorMessage}</div> : null}

      {loading && events.length === 0 ? (
        <div style={{ padding: '10px 13px' }} className="faint">
          Loading events…
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: '10px 13px' }} className="faint">
          No events were recorded for this run.
        </div>
      ) : (
        <div className="logs" ref={logRef}>
          {events.map((event) => {
            const decoded = decodeEvent(event);
            return (
              <div key={event.id} className={`logs__line logs__line--${event.type}`}>
                <span className="logs__time">{formatTime(event.timestamp)}</span>
                <span className="logs__type">{event.type.replace(/_/g, ' ')}</span>
                {event.type === 'warning' ? (
                  <WarningLine text={decoded.text} data={decoded.data} />
                ) : (
                  <span className="logs__text selectable">{decoded.text}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
