/**
 * Run bookkeeping.
 *
 * Wraps "start a run, stream its events into SQLite and to the UI, close it out"
 * so the orchestrator can stay focused on workflow decisions.
 *
 * The log budget is enforced here rather than at the database layer: once a run
 * has produced `maxStoredLogBytes` of events, further events stop being
 * persisted (a single truncation marker is written instead) but are still
 * forwarded live to the UI. A runaway agent therefore cannot fill the disk, and
 * the user still sees what is happening.
 */

import type { Run, RunAgent, RunEventType, RunStatus, RunType } from '../../shared/domain/models';
import { redactSecrets } from '../../shared/util/redact';
import type {
  AgentProgressEvent,
  Clock,
  EventPublisher,
  IdGenerator,
  RunEventRepository,
  RunRepository
} from '../ports';

export interface StartRunInput {
  readonly taskId: string;
  readonly agent: RunAgent;
  readonly runType: RunType;
  readonly round: number;
}

const MAX_SINGLE_EVENT_CHARS = 32_000;

export class RunRecorder {
  constructor(
    private readonly runs: RunRepository,
    private readonly runEvents: RunEventRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly events: EventPublisher,
    private readonly maxStoredLogBytes: number
  ) {}

  start(input: StartRunInput): RunHandle {
    const run = this.runs.create({
      id: this.ids.next(),
      taskId: input.taskId,
      agent: input.agent,
      runType: input.runType,
      status: 'running',
      round: input.round,
      startedAt: this.clock.nowIso()
    });

    this.events.publishRun(run, 'run-started');

    return new RunHandle(
      run,
      this.runs,
      this.runEvents,
      this.clock,
      this.ids,
      this.events,
      this.maxStoredLogBytes
    );
  }
}

export class RunHandle {
  private budgetExhausted = false;

  constructor(
    public readonly run: Run,
    private readonly runs: RunRepository,
    private readonly runEvents: RunEventRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly events: EventPublisher,
    private readonly maxStoredLogBytes: number
  ) {}

  /** Persist and broadcast one event from an agent. */
  append(event: AgentProgressEvent): void {
    const text =
      event.text.length > MAX_SINGLE_EVENT_CHARS
        ? `${event.text.slice(0, MAX_SINGLE_EVENT_CHARS)}\n…[event truncated]`
        : event.text;

    const payload = JSON.stringify({
      text: redactSecrets(text),
      ...(event.data ? { data: event.data } : {})
    });

    const stored = this.persist(event.type, payload);
    if (stored) {
      this.events.publishRunEvent(this.run.taskId, stored);
      return;
    }

    // Over budget: still show it live, just do not keep it.
    this.events.publishRunEvent(this.run.taskId, {
      id: `ephemeral-${this.ids.next()}`,
      runId: this.run.id,
      timestamp: this.clock.nowIso(),
      type: event.type,
      payload
    });
  }

  private persist(type: RunEventType, payload: string): ReturnType<RunEventRepository['append']> | null {
    if (this.budgetExhausted) return null;

    const used = this.runEvents.storedBytes(this.run.id);
    if (used + payload.length > this.maxStoredLogBytes) {
      this.budgetExhausted = true;
      return this.runEvents.append({
        id: this.ids.next(),
        runId: this.run.id,
        type: 'log',
        timestamp: this.clock.nowIso(),
        payload: JSON.stringify({
          text: `[Agent Relay] Log budget of ${this.maxStoredLogBytes} characters reached for this run. Further events are shown live but not stored.`
        })
      });
    }

    return this.runEvents.append({
      id: this.ids.next(),
      runId: this.run.id,
      type,
      timestamp: this.clock.nowIso(),
      payload
    });
  }

  finish(outcome: {
    status: RunStatus;
    finalMessage?: string | null;
    structuredResult?: unknown;
    errorMessage?: string | null;
  }): Run {
    const finished = this.runs.finish(this.run.id, {
      status: outcome.status,
      finishedAt: this.clock.nowIso(),
      finalMessage:
        outcome.finalMessage === undefined || outcome.finalMessage === null
          ? null
          : redactSecrets(outcome.finalMessage),
      structuredResult:
        outcome.structuredResult === undefined ? null : JSON.stringify(outcome.structuredResult),
      errorMessage:
        outcome.errorMessage === undefined || outcome.errorMessage === null
          ? null
          : redactSecrets(outcome.errorMessage)
    });

    this.events.publishRun(finished, 'run-updated');
    return finished;
  }
}
