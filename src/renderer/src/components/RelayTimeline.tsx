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
                <span className="logs__text selectable">{decoded.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
