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

import type { RunEventType } from '../../../shared/domain/models';

export interface ParsedStreamEvent {
  readonly type: RunEventType;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

export interface StreamState {
  sessionId: string | null;
  finalMessage: string | null;
  isError: boolean;
  numTurns: number | null;
  rawResultJson: string | null;
  /** Lines that were not valid JSON — usually a plain-text fallback. */
  plainTextLines: string[];
}

export function createStreamState(): StreamState {
  return {
    sessionId: null,
    finalMessage: null,
    isError: false,
    numTurns: null,
    rawResultJson: null,
    plainTextLines: []
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Flatten Anthropic message content blocks into readable text, and report any
 * tool calls separately so the timeline can show what Claude actually did.
 */
function describeMessage(message: Record<string, unknown>): {
  text: string;
  toolUses: string[];
} {
  const content = message['content'];
  if (typeof content === 'string') return { text: content, toolUses: [] };
  if (!Array.isArray(content)) return { text: '', toolUses: [] };

  const textParts: string[] = [];
  const toolUses: string[] = [];

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
      const summary = summariseToolInput(name, input);
      toolUses.push(summary);
    } else if (blockType === 'tool_result') {
      const resultContent = block['content'];
      if (typeof resultContent === 'string' && resultContent.length > 0) {
        textParts.push(truncate(resultContent, 2000));
      }
    }
  }

  return { text: textParts.join('\n').trim(), toolUses };
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

  return identifying ? `${name}: ${truncate(identifying, 300)}` : name;
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
    return [{ type: 'log', text: trimmed }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    state.plainTextLines.push(trimmed);
    return [{ type: 'log', text: truncate(trimmed, 4000) }];
  }

  const record = asRecord(parsed);
  if (!record) return [{ type: 'log', text: truncate(trimmed, 4000) }];

  // The session id can appear on any envelope; take the first one we see and
  // keep it stable for the rest of the run.
  const sessionId = readString(record, 'session_id', 'sessionId');
  if (sessionId && !state.sessionId) {
    state.sessionId = sessionId;
  }

  const type = record['type'];

  if (type === 'system') {
    const subtype = readString(record, 'subtype') ?? 'system';
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

    const { text, toolUses } = describeMessage(message);
    const events: ParsedStreamEvent[] = [];

    for (const tool of toolUses) {
      events.push({ type: 'tool_use', text: tool });
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
    state.isError = record['is_error'] === true || readString(record, 'subtype') === 'error';

    const result = readString(record, 'result', 'final_message', 'text');
    if (result) state.finalMessage = result;

    const turns = record['num_turns'];
    if (typeof turns === 'number') state.numTurns = turns;

    const errorText = readString(record, 'error');
    if (errorText && !state.finalMessage) state.finalMessage = errorText;

    return [
      {
        type: state.isError ? 'error' : 'result',
        text: state.finalMessage ?? '(Claude returned no final message)',
        data: { numTurns: state.numTurns, isError: state.isError }
      }
    ];
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
export function finalizeState(state: StreamState): {
  sessionId: string | null;
  finalMessage: string;
  isError: boolean;
  numTurns: number | null;
  rawResultJson: string | null;
} {
  const fallback = state.plainTextLines.join('\n').trim();
  return {
    sessionId: state.sessionId,
    finalMessage: state.finalMessage ?? (fallback.length > 0 ? fallback : ''),
    isError: state.isError,
    numTurns: state.numTurns,
    rawResultJson: state.rawResultJson
  };
}
