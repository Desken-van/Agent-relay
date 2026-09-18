/**
 * Choosing the failure a Codex run reports to the user.
 *
 * A failed Codex turn produces two independent signals:
 *
 *  * a structured terminal event on the JSONL stream (`error` / `turn.failed`),
 *    whose `message` is often itself a JSON document carrying the provider's
 *    error `code`, `type` and `param`; and
 *  * the child process's stderr, which the SDK only surfaces by throwing
 *    `Codex Exec exited with code N: <all stderr>` once stdout ends.
 *
 * Stderr is diagnostics, not the cause: it routinely opens with unrelated
 * warnings (a stale models cache, plugin manifests) that say nothing about why
 * the turn failed. Everything here is pure so that choice can be tested.
 */

import { homedir } from 'node:os';
import { redactSecrets } from '../../../shared/util/redact';

export interface CodexTerminalError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly type?: string | undefined;
  readonly param?: string | undefined;
  readonly status?: number | undefined;
}

/** Bound on the terminal error placed in the task's `last_error`. */
export const MAX_TERMINAL_ERROR_CHARS = 600;
/** Bound on the stderr excerpt kept in the run event log. */
export const MAX_STDERR_DIAGNOSTIC_CHARS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fromDocument(document: Record<string, unknown>, depth: number): CodexTerminalError | null {
  const inner = isRecord(document.error) ? document.error : null;
  const message =
    text(inner?.message) ?? (typeof document.error === 'string' ? text(document.error) : undefined) ?? text(document.message);
  if (message === undefined) return null;

  // A provider message can itself wrap another JSON error document.
  const nested = depth < 1 ? parseJsonObject(message) : null;
  const unwrapped = nested === null ? null : fromDocument(nested, depth + 1);

  const outerType = text(document.type);
  const type = text(inner?.type) ?? (outerType === 'error' ? undefined : outerType);
  const code = text(inner?.code) ?? text(document.code);
  const param = text(inner?.param) ?? text(document.param);
  const status = count(document.status) ?? count(inner?.status);

  return {
    message: unwrapped?.message ?? message,
    code: unwrapped?.code ?? code,
    type: unwrapped?.type ?? type,
    param: unwrapped?.param ?? param,
    status: unwrapped?.status ?? status
  };
}

/**
 * Interpret the message of a terminal event. Accepts plain text, or a JSON
 * document in any of the shapes Codex has been seen to emit
 * (`{type:'error',error:{type,code,message,param},status}`, `{error:{…}}`,
 * `{message,code,…}`). Never throws; a document with no usable message keeps
 * its raw text rather than yielding an empty or "undefined" message.
 */
export function parseCodexTerminalError(raw: string): CodexTerminalError {
  const document = parseJsonObject(raw);
  const parsed = document === null ? null : fromDocument(document, 0);
  return parsed ?? { message: raw.trim() };
}

const isStructured = (error: CodexTerminalError): boolean =>
  error.code !== undefined || error.type !== undefined || error.status !== undefined;

/**
 * Codex reports one failure twice (an `error` event, then `turn.failed`). Keep
 * the later report unless it would replace a provider-classified error with a
 * bare message: the structured one names the cause.
 */
export function preferTerminalError(
  previous: CodexTerminalError | null,
  next: CodexTerminalError
): CodexTerminalError {
  return previous !== null && isStructured(previous) && !isStructured(next) ? previous : next;
}

/**
 * The message a `turn.failed` / `error` event carries, or null when it has none.
 * The SDK types both as `{message: string}`, but a newer CLI may nest an
 * `error` object instead, so the event is read as untyped data.
 */
export function terminalEventMessage(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const direct = text(event.message);
  if (direct !== undefined) return direct;
  const nested = event.error;
  if (isRecord(nested)) {
    const message = text(nested.message);
    if (message !== undefined) return message;
    return JSON.stringify(nested);
  }
  return text(nested) ?? null;
}

/**
 * Replace the current user's home directory with `~`.
 *
 * Tools print absolute paths (`C:\Users\<name>\.codex\…`) into their warnings;
 * the account name has no business in a message that is stored and displayed.
 * Matches either slash direction and JSON-escaped (doubled) backslashes.
 */
export function scrubHomeDirectory(input: string, home: string = homedir()): string {
  if (home.length < 3) return input;
  const segments = home.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return input;
  const escaped = segments.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const prefix = /^[\\/]/.test(home) ? '[\\\\/]{1,2}' : '';
  // The lookahead keeps `/home/alice` from eating the front of `/home/alicebob`.
  const pattern = new RegExp(`${prefix}${escaped.join('[\\\\/]{1,2}')}(?![A-Za-z0-9_-])`, 'gi');
  return input.replace(pattern, '~');
}

function bounded(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}

/** Redact, scrub, and bound a fragment of provider/process output for storage or display. */
export function safeExcerpt(input: string, max: number): string {
  return bounded(scrubHomeDirectory(redactSecrets(input)), max);
}

/** `[code] message (param …, HTTP n)` — bounded, redacted, and free of the home directory. */
export function formatTerminalError(error: CodexTerminalError): string {
  const label = error.code ?? error.type;
  const facts = [
    error.param === undefined ? null : `param ${error.param}`,
    error.status === undefined ? null : `HTTP ${error.status}`
  ].filter((fact): fact is string => fact !== null);
  const line = `${label === undefined ? '' : `[${label}] `}${error.message}${
    facts.length > 0 ? ` (${facts.join(', ')})` : ''
  }`;
  return safeExcerpt(line, MAX_TERMINAL_ERROR_CHARS);
}

/**
 * True when the provider itself said the request was not authenticated: HTTP
 * 401, or an authentication error code. Neither the error type nor any message
 * text counts — an unrelated failure must not send the user to `codex login`.
 */
export function isAuthenticationFailure(error: CodexTerminalError): boolean {
  if (error.status === 401) return true;
  return /unauthori[sz]ed|authentication|invalid_api_key|not_authenticated/i.test(error.code ?? '');
}

const PROCESS_EXIT = /^Codex Exec exited with (code \d+|signal \S+): ([\s\S]*)$/;

/** Split the SDK's process-exit error into its exit description and the stderr it carries. */
export function splitProcessExit(message: string): { readonly exit: string; readonly stderr: string } | null {
  const match = PROCESS_EXIT.exec(message);
  return match === null ? null : { exit: match[1] ?? '', stderr: match[2] ?? '' };
}
