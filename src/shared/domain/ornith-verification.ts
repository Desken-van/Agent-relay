/**
 * What Ornith's verification attempts were, told truthfully.
 *
 * A dispatched `run_verification` is not a passing verification. The loop used to record only that the
 * action ran (`ok: true`) plus a fixed "did not pass" sentence, so a run that changed files and then
 * failed, timed out or ran out of time left no command, exit code, duration or reason behind. This
 * module is the one place that says what an attempt's outcome is, bounds and sanitizes what is kept of
 * its output, and reads it back for the timeline and the Run screen. It is pure: no I/O, no clock.
 */

import { z } from 'zod';
import { redactSecrets } from '../util/redact';
import type { Run } from './models';
import { ORNITH_LIMITS, redactAbsoluteMachinePaths } from './ornith';

/** The one command Relay verifies with. Its identity is part of every persisted attempt. */
export const ORNITH_VERIFICATION_COMMAND = 'npm run verify' as const;

export const ORNITH_VERIFICATION_OUTCOMES = ['passed', 'failed', 'timed_out', 'cancelled', 'not_run'] as const;
export type OrnithVerificationOutcome = (typeof ORNITH_VERIFICATION_OUTCOMES)[number];

/** An outcome that means the command actually ran (as opposed to `not_run`). */
export type ExecutedVerificationOutcome = Exclude<OrnithVerificationOutcome, 'not_run'>;

/**
 * One attempt to verify, executed or refused. Bounded by construction: `reason` and `summary` are
 * length-limited, and a run keeps at most `ORNITH_LIMITS.maxVerificationAttemptsRecorded` of them.
 */
export const ornithVerificationAttemptSchema = z.object({
  /** The loop's action sequence, so an attempt can be matched to its tool_use event. */
  sequence: z.number().int().min(0),
  command: z.literal(ORNITH_VERIFICATION_COMMAND),
  outcome: z.enum(ORNITH_VERIFICATION_OUTCOMES),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  /** Why it did not pass (or was not started). Null when it passed. */
  reason: z.string().max(400).nullable(),
  /** Sanitized, bounded tail of the command's output. Empty when it never ran. */
  summary: z.string().max(ORNITH_LIMITS.maxVerificationSummaryChars),
  /** The denial code when the attempt was refused before it started; null otherwise. */
  code: z.string().max(80).nullable(),
  /** Short fingerprint of the files the attempt ran against; null when it could not be taken. */
  fingerprint: z.string().max(64).nullable()
});
export type OrnithVerificationAttempt = z.infer<typeof ornithVerificationAttemptSchema>;

/** The raw facts about one execution, as the process layer reported them. Nothing here is interpreted yet. */
export interface OrnithVerificationExecution {
  readonly exitCode: number | null;
  /** The process layer's own failure flag (non-zero exit, spawn failure, output cap…). */
  readonly failed: boolean;
  /** The command's own timeout fired. */
  readonly timedOut: boolean;
  /** The run was aborted through its signal. */
  readonly cancelled: boolean;
  readonly durationMs: number;
  /** Raw stdout/stderr text; never stored as is — {@link summarizeVerificationOutput} bounds and sanitizes it. */
  readonly output: string;
}

/** `8m32s`, `45s`, `320ms` — the same words everywhere a duration is shown. */
export function formatVerificationDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown time';
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Decide what an execution was. The single place that does it, so a loop, a test and the screen cannot
 * disagree.
 *
 * `budgetExpired` is the loop's own verification timer having fired (the run was stopped to leave time
 * to finish); it outranks a bare `cancelled`, which is otherwise what an abort looks like.
 */
export function classifyVerificationExecution(
  execution: OrnithVerificationExecution,
  options: { readonly budgetExpired: boolean; readonly budgetMs: number }
): { readonly outcome: ExecutedVerificationOutcome; readonly reason: string | null } {
  if (execution.exitCode === 0 && !execution.failed && !execution.timedOut && !execution.cancelled && !options.budgetExpired) {
    return { outcome: 'passed', reason: null };
  }
  if (options.budgetExpired) {
    return {
      outcome: 'timed_out',
      reason: `${ORNITH_VERIFICATION_COMMAND} was stopped after ${formatVerificationDuration(execution.durationMs)}: the implementation time budget left no more time for it.`
    };
  }
  if (execution.timedOut) {
    return {
      outcome: 'timed_out',
      reason: `${ORNITH_VERIFICATION_COMMAND} exceeded its own timeout after ${formatVerificationDuration(execution.durationMs)}.`
    };
  }
  if (execution.cancelled) {
    return { outcome: 'cancelled', reason: `${ORNITH_VERIFICATION_COMMAND} was cancelled before it finished.` };
  }
  return {
    outcome: 'failed',
    reason: execution.exitCode !== null
      ? `${ORNITH_VERIFICATION_COMMAND} exited with code ${execution.exitCode} after ${formatVerificationDuration(execution.durationMs)}.`
      : `${ORNITH_VERIFICATION_COMMAND} failed without an exit code.`
  };
}

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const FAILING_LINE = /^\s*(FAIL\b|×|✗|✖)|AssertionError|\bError:|\bnpm error\b|^\s*(Test Files|Tests)\s/;
const SUMMARY_LINE_MAX = 200;
const SUMMARY_TAIL_LINES = 8;
const SUMMARY_FAILING_LINES = 6;
/**
 * All of a command's output is never examined: it can be tens of megabytes, and the work below runs on the
 * main thread. Only the start (where a run announces itself) and, above all, the end (where failures are
 * summarised) are kept; a failing line lost in the middle of a huge log is the price of a bounded cost.
 */
const SUMMARY_INPUT_HEAD_CHARS = 32 * 1024;
const SUMMARY_INPUT_TAIL_CHARS = 256 * 1024;

function boundInput(raw: string): string {
  if (raw.length <= SUMMARY_INPUT_HEAD_CHARS + SUMMARY_INPUT_TAIL_CHARS) return raw;
  return `${raw.slice(0, SUMMARY_INPUT_HEAD_CHARS)}\n${raw.slice(raw.length - SUMMARY_INPUT_TAIL_CHARS)}`;
}

function stripControlCharacters(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) out += '\n';
    else if (code === 9) out += ' ';
    else if (code >= 32 && code !== 127) out += value[index];
  }
  return out;
}

function clipLine(line: string): string {
  return line.length <= SUMMARY_LINE_MAX ? line : `${line.slice(0, SUMMARY_LINE_MAX - 1)}…`;
}

/**
 * Keep the part of a command's output that explains a failure — the failing-test lines and the tail —
 * and nothing else. Sanitized (ANSI escapes and control characters removed, credentials redacted,
 * absolute machine paths omitted) and hard-capped, so it is safe to persist, show and hand back to a
 * model. Never returns more than `maxChars`, and never examines more than a bounded head and tail of the
 * input, however large it is.
 */
export function summarizeVerificationOutput(
  raw: string,
  maxChars: number = ORNITH_LIMITS.maxVerificationSummaryChars
): string {
  const cleaned = redactAbsoluteMachinePaths(
    redactSecrets(stripControlCharacters(boundInput(raw).replace(ANSI_SEQUENCE, '').replace(/\r\n?/g, '\n')))
  );
  const lines = cleaned
    .split('\n')
    .map((line) => clipLine(line.trimEnd()))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return '';

  const tail = lines.slice(-SUMMARY_TAIL_LINES);
  const failing: string[] = [];
  for (const line of lines) {
    if (failing.length >= SUMMARY_FAILING_LINES) break;
    if (FAILING_LINE.test(line) && !tail.includes(line) && !failing.includes(line)) failing.push(line);
  }

  const compose = (head: readonly string[]): string =>
    [...head, ...(head.length > 0 ? ['…'] : []), ...tail].join('\n');
  let head = failing;
  let text = compose(head);
  while (text.length > maxChars && head.length > 0) {
    head = head.slice(0, -1);
    text = compose(head);
  }
  if (text.length > maxChars) text = `…${text.slice(text.length - (maxChars - 1))}`;
  return text;
}

/** One sentence per attempt, in the same words for the timeline, the Run screen and the task's own error. */
export function describeVerificationAttempt(attempt: OrnithVerificationAttempt): string {
  const took = formatVerificationDuration(attempt.durationMs);
  switch (attempt.outcome) {
    case 'passed':
      return `Verification passed (${attempt.command}, ${took}).`;
    case 'failed':
      return attempt.reason ?? `Verification failed: ${attempt.command}${attempt.exitCode !== null ? ` exited with code ${attempt.exitCode}` : ''} after ${took}.`;
    case 'timed_out':
      return attempt.reason ?? `Verification timed out: ${attempt.command} was stopped after ${took}.`;
    case 'cancelled':
      return attempt.reason ?? `Verification was cancelled: ${attempt.command} did not finish.`;
    case 'not_run':
      return `Verification was not started: ${attempt.reason ?? 'it was refused.'}`;
  }
}

/** The attempt whose result stands: the latest one that actually ran. A refusal never replaces it. */
export function latestExecutedAttempt(attempts: readonly OrnithVerificationAttempt[]): OrnithVerificationAttempt | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]!.outcome !== 'not_run') return attempts[index]!;
  }
  return null;
}

/**
 * What the run's assessment may say about verification. The latest EXECUTED attempt decides, so a later
 * refusal cannot hide a failure. A passing diagnostic run stays `not_run`: only Relay's own,
 * identity-bound verification can establish `passed`.
 */
export function ornithVerificationStatus(
  attempts: readonly OrnithVerificationAttempt[]
): 'failed' | 'unknown' | 'not_run' {
  const latest = latestExecutedAttempt(attempts);
  if (latest === null || latest.outcome === 'passed') return 'not_run';
  return latest.outcome === 'cancelled' ? 'unknown' : 'failed';
}

/** What is known about a stored Ornith run, read back defensively (older runs simply lack the newer fields). */
export interface OrnithRunEvidence {
  /** Files this run's own tools changed. */
  readonly changedFiles: number | null;
  /** Files the task worktree held changed when the run ended, whoever changed them; null when not known. */
  readonly worktreeChangedFiles: number | null;
  readonly attempts: readonly OrnithVerificationAttempt[];
  readonly reasonCodes: readonly string[];
  readonly deadlineExpired: boolean;
}

export function readOrnithRunEvidence(run: Pick<Run, 'agent' | 'structuredResult'>): OrnithRunEvidence | null {
  if (run.agent !== 'ornith' || run.structuredResult === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.structuredResult);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const container = parsed as { counters?: unknown; assessment?: unknown };
  const counters = typeof container.counters === 'object' && container.counters !== null
    ? (container.counters as Record<string, unknown>)
    : null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  const attempts: OrnithVerificationAttempt[] = [];
  const stored = counters?.['verificationAttempts'];
  if (Array.isArray(stored)) {
    for (const candidate of stored.slice(0, ORNITH_LIMITS.maxVerificationAttemptsRecorded)) {
      const checked = ornithVerificationAttemptSchema.safeParse(candidate);
      if (checked.success) attempts.push(checked.data);
    }
  }
  const assessment = typeof container.assessment === 'object' && container.assessment !== null
    ? (container.assessment as { reasonCodes?: unknown })
    : null;
  const reasonCodes = Array.isArray(assessment?.reasonCodes)
    ? assessment.reasonCodes.filter((code): code is string => typeof code === 'string').slice(0, 40)
    : [];
  return {
    changedFiles: count(counters?.['changedFiles']),
    worktreeChangedFiles: count(counters?.['worktreeChangedFiles']),
    attempts,
    reasonCodes,
    deadlineExpired: reasonCodes.includes('limit_deadline_exceeded')
  };
}

/**
 * How many files an Ornith attempt left changed in the task worktree, taking the most any attempt
 * recorded. A LATER attempt that changed nothing does not erase EARLIER edits: the worktree keeps them,
 * and they are unverified, so the recovery action must stay verification rather than another attempt.
 */
export function preservedOrnithChanges(runs: readonly Run[]): number {
  let mostEverChanged = 0;
  let latestKnown: number | null = null;
  // Newest first: the latest recorded count of what the worktree holds is the best account of it NOW, so
  // an earlier round that left five files does not keep saying five after a later one left one.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.runType !== 'implementation' && run.runType !== 'correction') continue;
    const evidence = readOrnithRunEvidence(run);
    if (evidence === null) continue;
    if (latestKnown === null && evidence.worktreeChangedFiles !== null) latestKnown = evidence.worktreeChangedFiles;
    mostEverChanged = Math.max(mostEverChanged, evidence.changedFiles ?? 0);
  }
  // Runs recorded before the worktree count existed can only say what each round changed itself.
  return latestKnown ?? mostEverChanged;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The task's own explanation after an Ornith round that left files but no proof they verify. Bounded and
 * made only of counts, outcomes and durations — never a path or command output.
 */
export function describeUnverifiedOrnithOutcome(input: {
  readonly changedFiles: number;
  readonly worktreeChangedFiles: number | null;
  readonly attempts: readonly OrnithVerificationAttempt[];
  readonly deadlineExpired: boolean;
}): string {
  const parts: string[] = [];
  if (input.deadlineExpired) parts.push('The Ornith implementation time limit expired.');
  const preserved = input.worktreeChangedFiles ?? 0;
  if (input.changedFiles > 0) {
    parts.push(`Ornith changed ${plural(input.changedFiles, 'file')}.`);
  } else if (preserved > 0) {
    parts.push(
      `Ornith made no new changes this round, but the task worktree still holds ${plural(preserved, 'changed file')} from an earlier attempt.`
    );
  }
  const executed = latestExecutedAttempt(input.attempts);
  const last = input.attempts.at(-1) ?? null;
  if (executed !== null) parts.push(describeVerificationAttempt(executed));
  if (last !== null && last.outcome === 'not_run') parts.push(describeVerificationAttempt(last));
  if (executed === null && (last === null || last.outcome !== 'not_run')) {
    parts.push('Verification did not run in this round.');
  }
  parts.push(
    input.changedFiles > 0 || preserved > 0
      ? 'The changes are preserved in the task worktree. Run verification in Agent Relay to check them.'
      : 'No files were changed.'
  );
  return parts.join(' ');
}

/** The exact `data` a `run_verification` tool_use event carries. `ok` is the VERIFICATION's result; `dispatched` is the action's. */
export interface OrnithVerificationEventData {
  readonly sequence: number;
  readonly action: 'run_verification';
  /** True only when the verification passed. Never merely "the action ran". */
  readonly ok: boolean;
  /** The action reached the executor. Separate from `ok` on purpose. */
  readonly dispatched: true;
  readonly verification: {
    readonly command: typeof ORNITH_VERIFICATION_COMMAND;
    readonly outcome: ExecutedVerificationOutcome;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly reason: string | null;
    readonly summary: string;
  };
}

export function isOrnithVerificationEventData(
  data: Record<string, unknown> | null
): data is Record<string, unknown> & OrnithVerificationEventData {
  if (data === null || data['action'] !== 'run_verification' || data['dispatched'] !== true || typeof data['ok'] !== 'boolean') {
    return false;
  }
  const verification = data['verification'];
  if (typeof verification !== 'object' || verification === null) return false;
  const record = verification as Record<string, unknown>;
  // Everything the renderer dereferences is checked here, so an older or damaged stored event falls back
  // to plain text rather than throwing. `not_run` is never an EXECUTED outcome, and never an event's.
  return (
    typeof record['outcome'] === 'string' &&
    record['outcome'] !== 'not_run' &&
    (ORNITH_VERIFICATION_OUTCOMES as readonly string[]).includes(record['outcome']) &&
    typeof record['command'] === 'string' &&
    typeof record['durationMs'] === 'number' &&
    (record['exitCode'] === null || typeof record['exitCode'] === 'number') &&
    (record['reason'] === null || typeof record['reason'] === 'string') &&
    typeof record['summary'] === 'string'
  );
}
