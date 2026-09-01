/**
 * Incremental parser for Claude Code's `--output-format stream-json` output.
 *
 * The CLI emits newline-delimited JSON. This parser is deliberately permissive:
 * it never throws on an unrecognised line, because a CLI upgrade that adds a new
 * event type must not break a running implementation round. Unknown objects are
 * surfaced as generic progress rather than discarded silently.
 *
 * The two things we genuinely need out of the stream are the **session id**
 * (so the same conversation can be resumed for correction rounds and after an
 * application restart) and the **final result**.
 */

import type {
  ClaudePermissionDenial,
  ClaudeStreamEvidence,
  ClaudeToolExecution
} from '../../ports';
import type { RunEventType } from '../../../shared/domain/models';
import { redactSecrets } from '../../../shared/util/redact';

export interface ParsedStreamEvent {
  readonly type: RunEventType;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Re-exported for convenience at the call sites in this adapter. The contract
 * itself lives in `ports.ts`, because the orchestrator reasons about denials.
 *
 * They matter more than they look: in `--print` mode there is nobody to answer
 * a permission prompt, so a denial is silent from the model's point of view. It
 * carries on, often working around the block, and the run still exits 0. Left
 * unreported, a round in which the tests never ran is indistinguishable from a
 * clean one.
 */
export type { ClaudePermissionDenial, ClaudeStreamEvidence, ClaudeToolExecution };

/**
 * A tool execution while it is still being assembled.
 *
 * The stream delivers a call and its result as two separate messages, often
 * with other messages in between and occasionally out of order, so the record
 * has to be mutable until the stream ends.
 */
interface PendingToolExecution {
  toolUseId: string | null;
  /** Invocation order, assigned when a real `tool_use` is first seen. */
  toolUseSequence: number | null;
  tool: string;
  command: string | null;
  commandTruncated: boolean;
  summary: string;
  resultReceived: boolean;
  isError: boolean | null;
  resultConflict: boolean;
  /** False while only a result has been seen and its call has not arrived. */
  toolUseSeen: boolean;
}

export interface StreamState {
  sessionId: string | null;
  finalMessage: string | null;
  isError: boolean;
  numTurns: number | null;
  rawResultJson: string | null;
  /** Lines that were not valid JSON — usually a plain-text fallback. */
  plainTextLines: string[];
  /** Every distinct permission denial seen, in the order encountered. */
  denials: ClaudePermissionDenial[];
  /** Tool calls and their results, correlated by `tool_use.id`. */
  executions: PendingToolExecution[];
  /** True once the CLI's final `result` envelope has been parsed. */
  resultEnvelopeSeen: boolean;
  /** `is_error` as an envelope stated it; null while unstated or contradicted. */
  resultEnvelopeIsError: boolean | null;
  /** True once two envelopes have disagreed about `is_error`. */
  resultEnvelopeConflict: boolean;
  /** Non-empty lines that were not valid JSON. */
  malformedLineCount: number;
  /**
   * Number the next distinct `tool_use` will receive.
   *
   * Lives on the state, not in a module-level counter, so it is scoped to one
   * parser and therefore to one CLI process. A resumed round builds a fresh
   * state and starts again at 1.
   */
  nextToolUseSequence: number;
}

export function createStreamState(): StreamState {
  return {
    sessionId: null,
    finalMessage: null,
    isError: false,
    numTurns: null,
    rawResultJson: null,
    plainTextLines: [],
    denials: [],
    executions: [],
    resultEnvelopeSeen: false,
    resultEnvelopeIsError: null,
    resultEnvelopeConflict: false,
    malformedLineCount: 0,
    nextToolUseSequence: 1
  };
}

/** Longest denial explanation kept; the CLI's text is short, but it is model-adjacent. */
const MAX_DENIAL_REASON = 300;

/**
 * Longest command kept as evidence.
 *
 * Long enough to identify what was attempted, bounded on purpose: this is
 * telemetry, and a shell one-liner with an inlined payload should not be able
 * to grow the record without limit.
 */
const MAX_COMMAND_LENGTH = 500;

/**
 * Find the execution carrying `toolUseId`, or null.
 *
 * A null id never matches anything: correlating two unidentified calls would be
 * a guess, and a wrong pairing would attribute one command's failure to another.
 */
function findExecution(state: StreamState, toolUseId: string | null): PendingToolExecution | null {
  if (toolUseId === null) return null;
  return state.executions.find((entry) => entry.toolUseId === toolUseId) ?? null;
}

/**
 * A command as it is safe to keep: redacted, bounded, and honest about the bound.
 */
interface RecordedCommand {
  readonly text: string | null;
  readonly truncated: boolean;
}

/** The tool named no command. Not the same as "the command was empty". */
const NO_COMMAND: RecordedCommand = { text: null, truncated: false };

/**
 * The `command` field of a tool input, redacted and bounded.
 *
 * `text` is null when the tool did not name a command — a file read, say. It is
 * never a reconstruction: a guessed command would later be read as a statement
 * of what Claude tried to run.
 *
 * Redaction runs *before* truncation on purpose. Cutting first can slice a
 * secret into a fragment too short for the patterns to recognise, and the
 * fragment would then be kept forever. Redacting first means the whole secret
 * is already gone whichever side of the boundary it fell on.
 */
function readCommand(input: unknown): RecordedCommand {
  const record = asRecord(input);
  const command = record === null ? null : readString(record, 'command');
  if (command === null) return NO_COMMAND;

  const redacted = redactSecrets(command);
  return {
    text: truncate(redacted, MAX_COMMAND_LENGTH),
    truncated: redacted.length > MAX_COMMAND_LENGTH
  };
}

/**
 * The invocation number of the call `toolUseId` names, or null.
 *
 * Null covers both "no id" and "that call has not been seen yet"; the second
 * case is repaired later by {@link attachDenialSequence}.
 */
function knownSequence(state: StreamState, toolUseId: string | null): number | null {
  const known = findExecution(state, toolUseId);
  if (known === null) return null;
  return known.toolUseSequence;
}

/**
 * Give denials already recorded for `toolUseId` the invocation number that has
 * just become known.
 *
 * The CLI can report a refusal before the call it refused appears in the
 * stream. Without this the denial would keep a null it no longer deserves, and
 * a later policy could not place the refusal among the other invocations.
 *
 * Only an exact id link is repaired. An anonymous denial stays null: pairing it
 * with an anonymous call — or with one running the same command — would be a
 * guess, and it is precisely the guess that would let "a retry succeeded after
 * this was blocked" be asserted about two unrelated invocations.
 */
function attachDenialSequence(state: StreamState, toolUseId: string | null, sequence: number): void {
  if (toolUseId === null) return;

  state.denials.forEach((denial, index) => {
    if (denial.toolUseId === toolUseId && denial.toolUseSequence === null) {
      state.denials[index] = { ...denial, toolUseSequence: sequence };
    }
  });
}

/**
 * Record a tool call.
 *
 * Merges into the placeholder left by a result that outran its call, and
 * ignores a repeat of an id already seen so a re-delivered message cannot turn
 * one attempt into two. Two calls running the same command stay separate: they
 * are told apart by id, never by what they run.
 */
function recordToolUse(state: StreamState, use: ParsedToolUse): void {
  const existing = findExecution(state, use.toolUseId);
  if (existing) {
    // A re-delivered call is not a second invocation, and must not consume a
    // number — doing so would leave a gap that reads as a missing call.
    if (existing.toolUseSeen) return;

    // The placeholder a result left behind: fill in what the call now tells us,
    // and it stops being an orphan. It reserved no number while it waited, so
    // it takes the next one now, in the order the call actually appeared.
    existing.tool = use.tool;
    existing.command = use.command;
    existing.commandTruncated = use.commandTruncated;
    existing.summary = use.summary;
    existing.toolUseSeen = true;
    existing.toolUseSequence = state.nextToolUseSequence;
    state.nextToolUseSequence += 1;
    attachDenialSequence(state, use.toolUseId, existing.toolUseSequence);
    return;
  }

  const toolUseSequence = state.nextToolUseSequence;
  state.nextToolUseSequence += 1;

  state.executions.push({
    toolUseId: use.toolUseId,
    toolUseSequence,
    tool: use.tool,
    command: use.command,
    commandTruncated: use.commandTruncated,
    summary: use.summary,
    resultReceived: false,
    isError: null,
    resultConflict: false,
    toolUseSeen: true
  });

  attachDenialSequence(state, use.toolUseId, toolUseSequence);
}

/**
 * Record what a final `result` envelope said about `is_error`.
 *
 * Only a literal boolean counts. A missing field stays null, and a second
 * envelope contradicting the first sends the value back to null and raises the
 * conflict flag — the same reasoning as two disagreeing tool results: choosing
 * a side would turn a stream we cannot trust into a clean answer.
 *
 * Telemetry only. The outcome the application acts on is decided elsewhere in
 * this file and is not touched by any of this.
 */
function recordEnvelopeOutcome(state: StreamState, record: Record<string, unknown>): void {
  const stated = typeof record['is_error'] === 'boolean' ? record['is_error'] : null;

  if (state.resultEnvelopeConflict) return;
  if (stated === null) return;

  if (state.resultEnvelopeIsError !== null && state.resultEnvelopeIsError !== stated) {
    state.resultEnvelopeIsError = null;
    state.resultEnvelopeConflict = true;
    return;
  }

  state.resultEnvelopeIsError = stated;
}

/**
 * Record a tool result.
 *
 * A repeat for an id already answered is not a second execution, so three cases
 * have to stay apart:
 *
 * - the first result said nothing about the outcome and a later one does — take
 *   the definitive value, since it fills a gap rather than replacing an answer;
 * - the same value again — keep it, nothing happened;
 * - two results that contradict each other — drop back to `null` and raise
 *   {@link PendingToolExecution.resultConflict}. Keeping the first value would
 *   let a contradiction read as a pass to anyone who did not check the flag,
 *   and the only honest reading of a contradiction is "unknown". Nothing is
 *   lost: with two boolean values, the flag itself says both were seen.
 *
 * An unmatched id becomes a placeholder rather than being dropped: the call may
 * still arrive, and a result nobody can attribute is itself worth counting.
 */
function recordToolResult(state: StreamState, toolUseId: string | null, isError: boolean | null): void {
  const existing = findExecution(state, toolUseId);
  if (existing) {
    existing.resultReceived = true;

    // Once two results have disagreed the outcome is unknowable, and a third
    // does not settle it. Without this the next result would refill the field
    // and the entry would look decided again.
    if (existing.resultConflict) return;

    if (existing.isError !== null && isError !== null && existing.isError !== isError) {
      existing.isError = null;
      existing.resultConflict = true;
      return;
    }

    // A later duplicate must not erase a value the first result carried.
    if (existing.isError === null) existing.isError = isError;
    return;
  }

  state.executions.push({
    toolUseId,
    // Nothing was invoked as far as this stream showed, so there is no place in
    // the invocation order to claim — and no number is spent holding one.
    toolUseSequence: null,
    tool: 'unknown tool',
    command: null,
    commandTruncated: false,
    summary: 'result without a matching tool use',
    resultReceived: true,
    isError,
    resultConflict: false,
    toolUseSeen: false
  });
}

/**
 * The command a denial refers to.
 *
 * Taken from the denial's own `tool_input`, or recovered from the tool call it
 * names by id. When neither is available the answer is null: the reason text
 * often mentions a command, but parsing prose into a fact about what ran is
 * exactly the kind of guess this record exists to avoid.
 */
function denialCommand(
  state: StreamState,
  payload: Record<string, unknown>,
  toolUseId: string | null
): RecordedCommand {
  const direct = readCommand(payload['tool_input'] ?? payload['toolInput']);
  if (direct.text !== null) return direct;

  const known = findExecution(state, toolUseId);
  if (known === null) return NO_COMMAND;
  return { text: known.command, truncated: known.commandTruncated };
}

/**
 * Fold a second report of a denial into the one already recorded.
 *
 * The second report is not new information about *whether* something was
 * refused, but it can carry detail the first one lacked — the envelope often
 * names a command the event did not. Keeping the record and enriching it is the
 * only way to have both: one denial, and everything either source knew.
 */
function mergeDenial(
  existing: ClaudePermissionDenial,
  next: ClaudePermissionDenial
): ClaudePermissionDenial {
  const fillCommand = existing.command === null && next.command !== null;

  return {
    ...existing,
    toolUseId: existing.toolUseId === null ? next.toolUseId : existing.toolUseId,
    command: fillCommand ? next.command : existing.command,
    commandTruncated: fillCommand ? next.commandTruncated : existing.commandTruncated,
    // Whichever report managed to name an invocation, keep it: merging must
    // never lose a link that one half of the stream had established.
    toolUseSequence:
      existing.toolUseSequence === null ? next.toolUseSequence : existing.toolUseSequence,
    source: existing.source === next.source ? existing.source : 'both'
  };
}

/**
 * Record a denial, or merge it into the one already known.
 *
 * The same denial arrives twice in a normal run — once as a `permission_denied`
 * event and again in the `result` envelope's `permission_denials` array — so
 * identity is the CLI's `tool_use_id` where there is one, and the tool/reason
 * pair otherwise.
 *
 * @returns true when this was the first report, and so the one worth an event.
 */
function recordDenial(state: StreamState, denial: ClaudePermissionDenial): boolean {
  const index = state.denials.findIndex((seen) =>
    denial.toolUseId !== null && seen.toolUseId !== null
      ? seen.toolUseId === denial.toolUseId
      : seen.tool === denial.tool && seen.reason === denial.reason
  );

  if (index === -1) {
    state.denials.push(denial);
    return true;
  }

  const existing = state.denials[index];
  if (existing) state.denials[index] = mergeDenial(existing, denial);
  return false;
}

function denialEvent(denial: ClaudePermissionDenial): ParsedStreamEvent {
  const command = denial.command === null ? '' : ` (${denial.command})`;
  return {
    type: 'error',
    text: `Permission denied: ${denial.tool}${command} — ${denial.reason}`,
    data: {
      tool: denial.tool,
      toolUseId: denial.toolUseId,
      command: denial.command,
      source: denial.source,
      permissionDenied: true
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A tool call as it appeared in the stream. */
interface ParsedToolUse {
  readonly toolUseId: string | null;
  readonly tool: string;
  readonly command: string | null;
  readonly commandTruncated: boolean;
  readonly summary: string;
}

/** A tool result as it appeared in the stream. */
interface ParsedToolResult {
  readonly toolUseId: string | null;
  /** Null when the block carried no `is_error` field at all. */
  readonly isError: boolean | null;
}

/**
 * Flatten Anthropic message content blocks into readable text, and report any
 * tool calls separately so the timeline can show what Claude actually did.
 *
 * Calls and results are returned structurally rather than as prose, because
 * whether a command actually ran is decided by matching one against the other,
 * and that question cannot be answered from a rendered string.
 */
function describeMessage(message: Record<string, unknown>): {
  text: string;
  toolUses: ParsedToolUse[];
  toolResults: ParsedToolResult[];
} {
  const empty = { text: '', toolUses: [], toolResults: [] };
  const content = message['content'];
  if (typeof content === 'string') return { ...empty, text: content };
  if (!Array.isArray(content)) return empty;

  const textParts: string[] = [];
  const toolUses: ParsedToolUse[] = [];
  const toolResults: ParsedToolResult[] = [];

  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;

    const blockType = block['type'];
    if (blockType === 'text' && typeof block['text'] === 'string') {
      textParts.push(block['text']);
    } else if (blockType === 'thinking' && typeof block['thinking'] === 'string') {
      textParts.push(block['thinking']);
    } else if (blockType === 'tool_use') {
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
      const input = block['input'];
      const command = readCommand(input);
      toolUses.push({
        toolUseId: readString(block, 'id', 'tool_use_id', 'toolUseId'),
        tool: name,
        command: command.text,
        commandTruncated: command.truncated,
        // Redacted a second time on the way out. `summariseToolInput` already
        // does it, and the belt-and-braces costs nothing next to a leaked key.
        summary: redactSecrets(summariseToolInput(name, input))
      });
    } else if (blockType === 'tool_result') {
      // Only the outcome flag is taken. The output itself already reaches the
      // timeline below; copying it into the evidence record would duplicate the
      // largest thing in the stream for no gain.
      toolResults.push({
        toolUseId: readString(block, 'tool_use_id', 'toolUseId'),
        // Never inferred from the text: an error message quoted in successful
        // output would otherwise mark a passing command as failed.
        isError: typeof block['is_error'] === 'boolean' ? block['is_error'] : null
      });

      const resultContent = block['content'];
      if (typeof resultContent === 'string' && resultContent.length > 0) {
        textParts.push(truncate(resultContent, 2000));
      }
    }
  }

  return { text: textParts.join('\n').trim(), toolUses, toolResults };
}

function summariseToolInput(name: string, input: unknown): string {
  const record = asRecord(input);
  if (!record) return name;

  // Show the most identifying field for the common tools without dumping
  // an entire file's contents into the timeline.
  const identifying =
    readString(record, 'file_path', 'path', 'notebook_path') ??
    readString(record, 'command') ??
    readString(record, 'pattern') ??
    readString(record, 'url');

  // Redacted before the cut, so a secret on the boundary cannot survive as an
  // unrecognisable fragment.
  return identifying ? `${name}: ${truncate(redactSecrets(identifying), 300)}` : name;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Consume one line of CLI output, mutate `state`, and return the events that
 * should be shown in the UI and persisted.
 */
export function consumeLine(line: string, state: StreamState): ParsedStreamEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  if (!trimmed.startsWith('{')) {
    // Not JSON — keep it, it may be the whole answer if the CLI ignored
    // --output-format, or a warning worth showing.
    state.plainTextLines.push(trimmed);
    state.malformedLineCount += 1;
    return [{ type: 'log', text: trimmed }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    state.plainTextLines.push(trimmed);
    state.malformedLineCount += 1;
    return [{ type: 'log', text: truncate(trimmed, 4000) }];
  }

  const record = asRecord(parsed);
  if (!record) {
    // Well-formed JSON, but an array or a bare value where an envelope was
    // expected. Nothing here can be correlated, so it counts as unreadable.
    state.malformedLineCount += 1;
    return [{ type: 'log', text: truncate(trimmed, 4000) }];
  }

  // The session id can appear on any envelope; take the first one we see and
  // keep it stable for the rest of the run.
  const sessionId = readString(record, 'session_id', 'sessionId');
  if (sessionId && !state.sessionId) {
    state.sessionId = sessionId;
  }

  const type = record['type'];

  if (type === 'system') {
    const subtype = readString(record, 'subtype') ?? 'system';

    // A refused tool call. Surfaced as an error, not as bookkeeping.
    if (subtype === 'permission_denied') {
      const toolUseId = readString(record, 'tool_use_id', 'toolUseId');
      const command = denialCommand(state, record, toolUseId);
      const denial: ClaudePermissionDenial = {
        tool: readString(record, 'tool_name', 'toolName') ?? 'unknown tool',
        toolUseId,
        reason: truncate(
          redactSecrets(
            readString(record, 'decision_reason', 'message', 'reason') ?? 'no reason given'
          ),
          MAX_DENIAL_REASON
        ),
        command: command.text,
        commandTruncated: command.truncated,
        toolUseSequence: knownSequence(state, toolUseId),
        source: 'stream'
      };
      return recordDenial(state, denial) ? [denialEvent(denial)] : [];
    }

    // Only `init` actually starts a session. Everything else the CLI files
    // under `system` — thinking_tokens, and whatever it adds next — is
    // progress, and must not look like a second session opening.
    if (subtype !== 'init') {
      return [{ type: 'progress', text: `Claude ${subtype}`, data: { subtype } }];
    }

    const cwd = readString(record, 'cwd');
    return [
      {
        type: 'started',
        text: cwd ? `Claude session ${subtype} (cwd: ${cwd})` : `Claude session ${subtype}`,
        data: { subtype, sessionId: state.sessionId }
      }
    ];
  }

  if (type === 'assistant' || type === 'user') {
    const message = asRecord(record['message']);
    if (!message) return [];

    const { text, toolUses, toolResults } = describeMessage(message);
    const events: ParsedStreamEvent[] = [];

    for (const tool of toolUses) {
      recordToolUse(state, tool);
      events.push({
        type: 'tool_use',
        text: tool.summary,
        data: { tool: tool.tool, toolUseId: tool.toolUseId, command: tool.command }
      });
    }
    for (const result of toolResults) {
      recordToolResult(state, result.toolUseId, result.isError);
    }
    if (text.length > 0) {
      events.push({
        type: type === 'assistant' ? 'assistant_message' : 'log',
        text: truncate(text, 20_000)
      });
    }
    return events;
  }

  if (type === 'result') {
    state.rawResultJson = trimmed;
    state.resultEnvelopeSeen = true;
    recordEnvelopeOutcome(state, record);
    state.isError = record['is_error'] === true || readString(record, 'subtype') === 'error';

    const result = readString(record, 'result', 'final_message', 'text');
    if (result) state.finalMessage = result;

    const turns = record['num_turns'];
    if (typeof turns === 'number') state.numTurns = turns;

    const errorText = readString(record, 'error');
    if (errorText && !state.finalMessage) state.finalMessage = errorText;

    // The result envelope repeats every denial, and is the only place they
    // appear when the CLI decided not to emit an event for one.
    const events: ParsedStreamEvent[] = [];
    for (const raw of asArray(record['permission_denials'])) {
      const entry = asRecord(raw);
      if (!entry) continue;

      const toolUseId = readString(entry, 'tool_use_id', 'toolUseId');
      const command = denialCommand(state, entry, toolUseId);
      const denial: ClaudePermissionDenial = {
        tool: readString(entry, 'tool_name', 'toolName') ?? 'unknown tool',
        toolUseId,
        reason: truncate(
          redactSecrets(
            readString(entry, 'decision_reason', 'message', 'reason') ??
              'this command requires approval'
          ),
          MAX_DENIAL_REASON
        ),
        command: command.text,
        commandTruncated: command.truncated,
        toolUseSequence: knownSequence(state, toolUseId),
        source: 'result'
      };
      if (recordDenial(state, denial)) events.push(denialEvent(denial));
    }

    // Denials are recorded, not judged. What a refusal means for the round is
    // decided by the round policy, which can see whether the work was verified
    // anyway; this parser can only see that something was refused.
    events.push({
      type: state.isError ? 'error' : 'result',
      text: state.finalMessage ?? '(Claude returned no final message)',
      data: { numTurns: state.numTurns, isError: state.isError, denials: state.denials.length }
    });
    return events;
  }

  if (type === 'error') {
    const message = readString(record, 'message', 'error') ?? trimmed;
    state.isError = true;
    return [{ type: 'error', text: truncate(message, 8000) }];
  }

  // Unknown but well-formed event: keep it, compactly.
  return [{ type: 'progress', text: truncate(trimmed, 1000) }];
}

/**
 * Everything the adapter knows once the process has exited.
 * Falls back to accumulated plain text when no `result` envelope arrived.
 */
export function collectEvidence(state: StreamState): ClaudeStreamEvidence {
  const toolExecutions: ClaudeToolExecution[] = state.executions.map((entry) => ({
    toolUseId: entry.toolUseId,
    toolUseSequence: entry.toolUseSequence,
    tool: entry.tool,
    command: entry.command,
    commandTruncated: entry.commandTruncated,
    summary: entry.summary,
    toolUseSeen: entry.toolUseSeen,
    resultReceived: entry.resultReceived,
    isError: entry.isError,
    resultConflict: entry.resultConflict
  }));

  return {
    toolExecutions,
    resultEnvelopeSeen: state.resultEnvelopeSeen,
    resultEnvelopeIsError: state.resultEnvelopeIsError,
    resultEnvelopeConflict: state.resultEnvelopeConflict,
    malformedLineCount: state.malformedLineCount,
    // A call whose result never arrived. Counted separately from a failed one:
    // "we do not know how this ended" and "this ended badly" are different
    // facts, and only the first one means the stream was cut short.
    incompleteToolUseCount: state.executions.filter(
      (entry) => entry.toolUseSeen && !entry.resultReceived
    ).length,
    // A result that named a call we never saw. Derivable from the array, but
    // kept as a count so a policy does not have to re-derive it and get the
    // predicate subtly wrong.
    orphanToolResultCount: state.executions.filter((entry) => !entry.toolUseSeen).length
  };
}

export function finalizeState(state: StreamState): {
  sessionId: string | null;
  finalMessage: string;
  isError: boolean;
  numTurns: number | null;
  rawResultJson: string | null;
  denials: readonly ClaudePermissionDenial[];
  evidence: ClaudeStreamEvidence;
} {
  const fallback = state.plainTextLines.join('\n').trim();
  return {
    sessionId: state.sessionId,
    finalMessage: state.finalMessage ?? (fallback.length > 0 ? fallback : ''),
    // Strictly what the CLI reported: an `error` event, or a final envelope
    // that said so. Not a verdict on the round — a refused tool call leaves
    // this false, and the round policy is what decides whether that matters.
    isError: state.isError,
    numTurns: state.numTurns,
    rawResultJson: state.rawResultJson,
    denials: state.denials,
    // Telemetry only. Nothing above reads it, so a gap in the evidence can
    // never quietly turn a failed round into a successful one.
    evidence: collectEvidence(state)
  };
}

/** One line naming what was blocked, for a log or an error detail. */
export function summariseDenials(denials: readonly ClaudePermissionDenial[]): string {
  if (denials.length === 0) return '';

  const tools = [...new Set(denials.map((denial) => denial.tool))].join(', ');
  const detail = denials.map((denial) => `${denial.tool}: ${denial.reason}`).join(' | ');

  // Deliberately states only what happened. The previous wording here claimed
  // work "may have been skipped", which the evidence now often disproves — and
  // a warning that is routinely false is one people learn to ignore.
  return `Claude was denied permission for ${denials.length} tool call(s) (${tools}). ${detail}`;
}
