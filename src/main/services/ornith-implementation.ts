/**
 * The bounded Ornith implementation/correction loop.
 *
 * Owns exactly one thing: turning an approved specification (plus bounded
 * correction/verification evidence) into a sequence of structured model
 * turns, each one a single JSON action dispatched through
 * {@link OrnithWorktreeTools} or handled here as loop control (`finish`,
 * `blocked`, `run_verification`). Every hard limit in `ORNITH_LIMITS` is
 * enforced here; none of them can be widened by anything the model returns.
 *
 * What this file does NOT own: acquiring or releasing the Ornith execution
 * lease (the caller in `orchestrator.ts` does, because the lease must be held
 * before any of this runs and released on every exit path including one this
 * loop never sees, such as an unrelated crash). It also does not decide
 * whether the attempt counts as verified — Relay's own post-provider
 * `WorktreeVerification` snapshot remains authoritative; `run_verification`
 * here is diagnostic only, exactly as the specification requires.
 *
 * Every request built here is stateless: the full approved specification,
 * addenda and rule evidence are included in FULL on every turn (Ornith keeps
 * no server-side conversation), and only the rolling tool-result log is
 * pruned turn to turn.
 */

import {
  ORNITH_LIMITS,
  containsAbsoluteMachinePath,
  parseOrnithCompletion,
  sanitizeScopedFilePaths,
  type OrnithAction,
  type OrnithActionKind,
  type OrnithDenialCode,
  type OrnithToolDenialEventData
} from '../../shared/domain/ornith';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceMessage,
  type LocalInferenceRequest
} from '../../shared/domain/local-inference';
import type { ClaudePublishBlock, ClaudeRoundAssessmentRecord } from '../../shared/domain/claude-assessment';
import { CLAUDE_ASSESSMENT_VERSION } from '../../shared/domain/claude-assessment';
import { AgentRelayError } from '../../shared/domain/errors';
import { containsSecretShape } from '../../shared/util/redact';
import type { TaskSpecification } from '../../shared/schemas/codex';
import type { AgentProgressEvent, ImplementationResult, OrnithHealthyLease, OrnithInferenceLeaseService } from '../ports';
import type { ProcessRunner } from '../adapters/process/process-runner';
import { OrnithWorktreeTools, type OrnithOperationBudget, type OrnithToolResult } from './ornith-worktree-tools';

/* -------------------------------------------------------------------------- */
/* Request / result                                                           */
/* -------------------------------------------------------------------------- */

export interface OrnithImplementationRequest {
  readonly worktreePath: string;
  readonly worktreesRoot: string;
  readonly repositoryPath: string;
  readonly branchName: string;
  readonly specification: TaskSpecification;
  /** Complete, never truncated. */
  readonly ruleEvidence: string | null;
  /** Complete, never truncated. */
  readonly acceptedPlanReviewAddenda: string | null;
  /** Bounded correction findings or Relay verification-failure evidence, already rendered. */
  readonly correctionFindings: string | null;
  readonly runType: 'implementation' | 'correction';
  readonly round: number;
  readonly maxRounds: number;
  /** `min(settings.processTimeoutMs, ORNITH_LIMITS.maxLoopDeadlineMs)`. */
  readonly loopDeadlineMs: number;
  readonly signal: AbortSignal;
  readonly onProgress: (event: AgentProgressEvent) => void;
  /**
   * Dispatch to the existing WorktreeVerification executor. Diagnostic only —
   * its result never decides the attempt's outcome; only Relay's own
   * post-provider snapshot verification does.
   */
  readonly runVerification: (signal: AbortSignal, timeoutMs: number) => Promise<{ readonly passed: boolean; readonly summary: string }>;
  /** Already acquired and health-confirmed by the caller. */
  readonly lease: OrnithHealthyLease;
  readonly leaseService: OrnithInferenceLeaseService;
  readonly gitExecutablePath?: string | null;
  /** Used only to invoke fixed, read-only Git argv for the worktree tools. */
  readonly runner: ProcessRunner;
}

export interface OrnithImplementationAudit {
  readonly turns: number;
  readonly actions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly changedFiles: number;
  readonly verifications: number;
  readonly outcomes: readonly { sequence: number; action: OrnithActionKind; ok: boolean; code?: OrnithDenialCode }[];
}

export interface OrnithImplementationResult extends ImplementationResult {
  readonly ornithAudit: OrnithImplementationAudit;
  /** Present when the retained runtime itself did not produce a completion. */
  readonly providerFailure?: {
    readonly kind: 'failed' | 'timed_out';
    readonly reason: string;
    readonly dispatchOutcome: 'not_dispatched' | 'rejected' | 'unknown';
  } | null;
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

interface RollingResult {
  readonly turn: number;
  readonly action: OrnithActionKind;
  /** Bounded JSON text: either the tool's `forModel`, or a denial description. */
  readonly resultText: string;
}

const BOUND_TASK_WORKTREE_MARKER = '[bound task worktree]';
const ROLLING_HISTORY_OVERHEAD_BYTES = 256;

function isBoundPathStartBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s=:[({,"']/.test(value[index - 1] ?? '');
}

function isBoundPathEndBoundary(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const character = value[index] ?? '';
  if (/[\\/\s,;:!?()[\]{}"'<>]/.test(character)) return true;
  return character === '.' && (index + 1 >= value.length || /\s/.test(value[index + 1] ?? ''));
}

/**
 * Replace only a path that Relay has already bound and independently verified.
 * Unknown host paths remain untouched so the general absolute-path check below
 * still rejects them. A known root may be followed by a relative descendant;
 * replacing just the root preserves that instruction without exposing a host
 * location or directing the model at the non-isolated source checkout.
 */
function replaceBoundMachinePath(value: string, boundPath: string): string {
  const trimmed = boundPath.replace(/[\\/]+$/, '');
  if (
    trimmed.length === 0 ||
    /^[A-Za-z]:$/.test(trimmed) ||
    /^(?:\\\\|\/\/)[^\\/]+$/.test(trimmed)
  ) return value;
  const forms = [...new Set([
    trimmed,
    trimmed.replaceAll('\\', '/'),
    trimmed.replaceAll('/', '\\')
  ])].sort((left, right) => right.length - left.length);

  let output = value;
  for (const form of forms) {
    const caseInsensitive = /^[A-Za-z]:[\\/]/.test(form) || form.startsWith('\\\\');
    let cursor = 0;
    for (;;) {
      const haystack = caseInsensitive ? output.toLowerCase() : output;
      const needle = caseInsensitive ? form.toLowerCase() : form;
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) break;
      const end = index + form.length;
      if (isBoundPathStartBoundary(output, index) && isBoundPathEndBoundary(output, end)) {
        output = `${output.slice(0, index)}${BOUND_TASK_WORKTREE_MARKER}${output.slice(end)}`;
        cursor = index + BOUND_TASK_WORKTREE_MARKER.length;
      } else {
        cursor = end;
      }
    }
  }
  return output;
}

export function normalizeOrnithPromptInput(
  request: OrnithPromptPreflightInput,
  boundPaths: readonly string[]
): OrnithPromptPreflightInput {
  const safe = (value: string): string => boundPaths
    .reduce((current, boundPath) => replaceBoundMachinePath(current, boundPath), value);
  return {
    specification: {
      ...request.specification,
      title: safe(request.specification.title),
      summary: safe(request.specification.summary),
      acceptanceCriteria: request.specification.acceptanceCriteria.map(safe),
      constraints: request.specification.constraints.map(safe),
      assumptions: request.specification.assumptions.map(safe),
      suggestedTests: request.specification.suggestedTests.map(safe),
      implementationPrompt: safe(request.specification.implementationPrompt),
      scopedFilePaths: sanitizeScopedFilePaths(request.specification.scopedFilePaths?.map(safe))
    },
    ruleEvidence: request.ruleEvidence === null ? null : safe(request.ruleEvidence),
    acceptedPlanReviewAddenda:
      request.acceptedPlanReviewAddenda === null ? null : safe(request.acceptedPlanReviewAddenda),
    correctionFindings: request.correctionFindings === null ? null : safe(request.correctionFindings),
    round: request.round,
    maxRounds: request.maxRounds,
    lease: request.lease
  };
}

function renderSpecification(specification: TaskSpecification): string {
  const scope = specification.scopedFilePaths ?? [];
  const scopeSection = scope.length > 0
    ? `\n=== SCOPE ===
The approved specification confidently limits this task to the following existing repository
file(s). Read them directly with "read_file" — you do not need "list_files" or "search_text" to
find them; a search does NOT automatically narrow itself to this list, so calling one anyway to
"double check" costs the same as any other repository-wide search. The list can be incomplete: if
the work turns out to need other files, or a new one, discover them normally with "list_files"
and "search_text".
${scope.map((path) => `  - ${path}`).join('\n')}
`
    : '';
  return `=== THE APPROVED SPECIFICATION ===
Title: ${specification.title}

Summary:
${specification.summary}

Acceptance criteria — all of these must be true when you are done:
${specification.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

Constraints:
${specification.constraints.length > 0 ? specification.constraints.map((c) => `  - ${c}`).join('\n') : '  (none stated)'}

Assumptions the specification made:
${specification.assumptions.length > 0 ? specification.assumptions.map((a) => `  - ${a}`).join('\n') : '  (none stated)'}

Tests to add or run:
${specification.suggestedTests.length > 0 ? specification.suggestedTests.map((t) => `  - ${t}`).join('\n') : '  (none suggested)'}
${scopeSection}
=== DETAILED INSTRUCTION ===
${specification.implementationPrompt}`;
}

const ORNITH_PROTOCOL_INSTRUCTIONS = `You are Ornith, an implementation agent working through Agent Relay in a bounded
tool loop. You do not have a shell, a terminal, or any way to run an arbitrary command.
Every reply you send MUST be exactly one JSON object and NOTHING else — no prose before
or after it, no Markdown code fence. Reply with only ONE of the following action shapes,
matching this exact JSON structure (all fields required unless marked optional):

{"version":1,"action":"list_files","prefix":"<relative directory prefix; empty string means root>","limit":<=200,"cursor":<optional>}
{"version":1,"action":"read_file","path":"<relative file>","offset":0,"limit":<=65536}
{"version":1,"action":"search_text","query":"<literal text>","caseSensitive":false,"limit":<=100,"files":[<optional relative paths>]}
{"version":1,"action":"create_file","path":"<relative file>","content":"<UTF-8 text>"}
{"version":1,"action":"replace_text","path":"<relative file>","sha256":"<current file sha256>","replacements":[{"oldText":"<exact text>","newText":"<replacement>"}]}
{"version":1,"action":"delete_file","path":"<relative file>","sha256":"<current file sha256>"}
{"version":1,"action":"git_status"}
{"version":1,"action":"git_diff","paths":[<optional relative paths>]}
{"version":1,"action":"run_verification"}
{"version":1,"action":"finish","summary":"<what you changed, at most 4000 characters>"}
{"version":1,"action":"blocked","reason":"<why you cannot proceed, at most 2000 characters>"}

Rules:
- All paths are repository-relative, use forward slashes, and must stay inside the worktree.
- "replace_text" requires the file's CURRENT sha256 (given in the last read_file/create_file/
  replace_text result for that file) and fails with no write if oldText does not occur
  exactly once.
- You have no git commit, push, merge, checkout, reset, or remote access of any kind —
  do not ask for one, it does not exist.
- Call "run_verification" only when you believe the work is complete; Agent Relay itself
  re-verifies afterward regardless.
- Use a narrow prefix or a small page when listing files. If a "read_file" or "search_text"
  result says it was truncated, retry with a smaller limit, offset, or a more specific query
  — do not repeat the identical request. ("list_files" truncation works differently: see the
  "nextCursor" rule below, not this one.)
- Never repeat an identical list_files, read_file, search_text, git_status, or git_diff action after it succeeds.
  Use the returned files, cursor, or status to choose a different next action.
- A "list_files", "read_file", "search_text", "git_status", or "git_diff" action that fails with
  code "timeout" is recoverable a bounded number of times per run: choose a DIFFERENT, narrower
  request (fewer "files", a shorter prefix, a smaller byte range) on your next turn — repeating
  the identical request will be refused outright once, not retried.
- A "search_text" or "read_file" that fails with code "limit_read_bytes_exceeded" gets exactly ONE
  such recovery chance per run: on your next turn, either make the scoped edit now using context you
  already have, or call "blocked" — repeating the identical request will be refused outright.
- "search_text" reads the FULL content of every candidate file toward the same cumulative read
  budget as "read_file" (files over 64 KB and binary files are skipped, never searched: use
  "read_file" on those) — a repository-wide search (no "files" given) is the most expensive
  possible request, and is NEVER automatically narrowed for you, including by a SCOPE section
  above. If you already know which file matters, pass it in "files" explicitly, or better, skip
  the search entirely and use "read_file" directly.
- A "read_file" result reports "totalBytes" (the file's size) and "nextOffset" (where the next
  chunk starts; null at the end of the file). Every "read_file" is charged the file's FULL size
  against the read budget however small the chunk, so NEVER page through a large file in small
  consecutive chunks. If the part you need is not in the chunk you received, jump straight to the
  relevant offset computed from "totalBytes" (to add something after the last section, read from
  a few KB before "totalBytes"), or, when a SCOPE section names the file(s), run "search_text"
  with "files" set to exactly those file(s) (it reports line numbers, not byte offsets). A chunk
  may be shorter than your "limit" so the result fits; "bytesRead" says how much you got.
- A "read_file" result also reports "lineEnding" for the WHOLE file: "lf", "crlf", "mixed" or "none".
  In your JSON reply, "\\r\\n" (one backslash before each letter) decodes to the real CR and LF
  characters, but "\\\\r\\\\n" (doubled backslashes) decodes to four literal characters (backslash, r,
  backslash, n) that will NOT match a line break. Write each real line break in "oldText" and
  "newText" as the single-backslash escape that fits lineEnding (crlf: "\\r\\n", lf: "\\n"; mixed:
  reproduce each break exactly as the content shows it), and never copy a JSON escape from a result
  as literal text. Agent Relay converts neither form for you. A
  "replace_text" refused with code "replacement_escape_suspected" changed nothing and allows exactly
  ONE retry, which must differ from the refused request.
- A "list_files" result's "nextCursor" is the ONLY thing that tells you whether there is more:
  if it is a number, your NEXT "list_files" call for that SAME "prefix" must set "cursor" to
  exactly that number to continue; if it is null, that prefix is fully listed and must not be
  repeated.
- Call "finish" only when the acceptance criteria are met. Call "blocked" only when you
  cannot proceed and must stop.
- Every reply is judged on its own: nothing you say outside the JSON is read.`;

/**
 * Build one complete, stateless request body.
 *
 * @returns `null` when the complete authoritative content (specification,
 * addenda, rule evidence, protocol instructions) alone exceeds the prompt
 * budget — the caller must refuse before inference rather than silently
 * dropping any of it.
 */
export interface OrnithPromptPreflightInput {
  readonly specification: TaskSpecification;
  readonly ruleEvidence: string | null;
  readonly acceptedPlanReviewAddenda: string | null;
  readonly correctionFindings: string | null;
  readonly round: number;
  readonly maxRounds: number;
  readonly lease: Pick<OrnithHealthyLease, 'contextLimitTokens' | 'maxOutputTokens'>;
}

interface OrnithPromptBudget {
  readonly maxPromptBytes: number;
  readonly maxOutputTokens: number;
  readonly maxToolResultBytes: number;
}

export type OrnithPromptPreflight =
  | { readonly ok: true; readonly budget: OrnithPromptBudget }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly requiredContextTokens: number;
    };

function promptBudgetFor(lease: OrnithPromptPreflightInput['lease']): OrnithPromptBudget {
  const contextLimitTokens = Math.max(0, Math.floor(lease.contextLimitTokens));
  const configuredOutputTokens = Math.max(1, Math.floor(lease.maxOutputTokens));
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      configuredOutputTokens,
      ORNITH_LIMITS.maxTurnOutputTokens,
      Math.floor(Math.max(1, contextLimitTokens - ORNITH_LIMITS.contextSafetyTokens) / 4)
    )
  );
  // A byte-level tokenizer cannot produce more content tokens than there are
  // UTF-8 bytes. Using one byte per token is intentionally conservative and,
  // together with the template reserve, makes this a fail-closed bound without
  // requiring a model-specific tokenizer in the trusted host process.
  const maxPromptBytes = Math.min(
    ORNITH_LIMITS.maxPromptBytes,
    Math.max(0, contextLimitTokens - maxOutputTokens - ORNITH_LIMITS.contextSafetyTokens)
  );
  return {
    maxPromptBytes,
    maxOutputTokens,
    maxToolResultBytes: Math.min(
      ORNITH_LIMITS.maxToolResultBytes,
      Math.max(0, Math.floor(maxPromptBytes / 2))
    )
  };
}

function authoritativePromptText(request: OrnithPromptPreflightInput): string {
  return [
    renderSpecification(request.specification),
    request.acceptedPlanReviewAddenda
      ? `=== USER-ACCEPTED EXTERNAL PLAN-REVIEW ADDENDA ===\n${request.acceptedPlanReviewAddenda}`
      : null,
    request.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${request.ruleEvidence}` : null,
    request.correctionFindings ? `=== EVIDENCE FROM THE PREVIOUS ATTEMPT ===\n${request.correctionFindings}` : null,
    ORNITH_PROTOCOL_INSTRUCTIONS
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

/**
 * Prove the immutable part of every stateless Ornith request fits the exact
 * retained runtime window. Callers use this before creating a worktree or
 * consuming a round; the loop repeats the same check before inference.
 */
export function preflightOrnithPrompt(input: OrnithPromptPreflightInput): OrnithPromptPreflight {
  const initialBudget = promptBudgetFor(input.lease);
  const authoritativeBytes = Buffer.byteLength(authoritativePromptText(input), 'utf8');
  const fixedBudgetBytesFor = (maxToolResultBytes: number): number => Buffer.byteLength(`=== REMAINING BUDGET ===
Model turns remaining: ${ORNITH_LIMITS.maxModelTurns}
Non-terminal actions remaining: ${ORNITH_LIMITS.maxNonterminalActions}
Verification calls remaining: ${ORNITH_LIMITS.maxVerificationCalls}
Repository read bytes remaining: ${ORNITH_LIMITS.maxCumulativeReadBytes}
Repository write bytes remaining: ${ORNITH_LIMITS.maxCumulativeWriteBytes}
Changed files remaining: ${ORNITH_LIMITS.maxChangedFiles}
Maximum retained tool-result bytes: ${maxToolResultBytes}
Round ${input.round} of at most ${input.maxRounds}.

Reply with exactly one JSON action now.`, 'utf8');
  let maxToolResultBytes = initialBudget.maxToolResultBytes;
  // Reserve room for two recent results. Without this, a large authoritative
  // specification can fit while every tool result is silently omitted from
  // the next stateless turn, causing the model to repeat the same action.
  for (let pass = 0; pass < 2; pass += 1) {
    const fixedBytes = authoritativeBytes + 2 + fixedBudgetBytesFor(maxToolResultBytes);
    const rollingBytes = Math.max(0, initialBudget.maxPromptBytes - fixedBytes);
    maxToolResultBytes = Math.min(
      initialBudget.maxToolResultBytes,
      Math.max(256, Math.floor(Math.max(0, rollingBytes - ROLLING_HISTORY_OVERHEAD_BYTES) / 2))
    );
  }
  const budget = { ...initialBudget, maxToolResultBytes };
  const requiredPromptBytes = authoritativeBytes + 2 + fixedBudgetBytesFor(maxToolResultBytes);
  const requiredWithFeedback = requiredPromptBytes + ORNITH_LIMITS.minRollingFeedbackBytes;
  if (requiredWithFeedback <= budget.maxPromptBytes) return { ok: true, budget };
  return {
    ok: false,
    reason:
      `The immutable Ornith prompt and minimum tool feedback need ${requiredWithFeedback} bytes, but the retained ` +
      `${input.lease.contextLimitTokens}-token runtime allows at most ${budget.maxPromptBytes} prompt bytes ` +
      `after output and template reserves.`,
    requiredContextTokens:
      requiredWithFeedback + budget.maxOutputTokens + ORNITH_LIMITS.contextSafetyTokens
  };
}

function buildOrnithPromptText(
  request: OrnithPromptPreflightInput,
  rolling: readonly RollingResult[],
  remaining: { turns: number; actions: number; verifications: number; readBytes: number; writeBytes: number; changedFiles: number },
  promptBudget: OrnithPromptBudget
): string | null {
  const authoritative = authoritativePromptText(request);

  if (Buffer.byteLength(authoritative, 'utf8') > promptBudget.maxPromptBytes) {
    return null;
  }

  const budget = `=== REMAINING BUDGET ===
Model turns remaining: ${remaining.turns}
Non-terminal actions remaining: ${remaining.actions}
Verification calls remaining: ${remaining.verifications}
Repository read bytes remaining: ${remaining.readBytes}
Repository write bytes remaining: ${remaining.writeBytes}
Changed files remaining: ${remaining.changedFiles}
Maximum retained tool-result bytes: ${promptBudget.maxToolResultBytes}
Round ${request.round} of at most ${request.maxRounds}.`;

  const fixedTail = `${budget}\n\nReply with exactly one JSON action now.`;
  const fixedBytes = Buffer.byteLength(`${authoritative}\n\n${fixedTail}`, 'utf8');
  if (fixedBytes > promptBudget.maxPromptBytes) return null;
  const rollingByteBudget = Math.min(
    ORNITH_LIMITS.maxRollingContextBytes,
    Math.max(0, promptBudget.maxPromptBytes - fixedBytes - ROLLING_HISTORY_OVERHEAD_BYTES)
  );

  let history = '';
  let omitted = 0;
  const kept: string[] = [];
  let contextBytes = 0;
  for (let i = rolling.length - 1; i >= 0; i -= 1) {
    const entry = rolling[i];
    if (entry === undefined) continue;
    const entryText = `turn ${entry.turn} [${entry.action}]: ${entry.resultText}`;
    const bytes = Buffer.byteLength(entryText, 'utf8');
    if (kept.length >= ORNITH_LIMITS.maxRetainedResults || contextBytes + bytes > rollingByteBudget) {
      if (kept.length === 0 && rollingByteBudget >= 256) {
        const compact = `turn ${entry.turn} [${entry.action}]: ${JSON.stringify({
          truncated: true,
          originalBytes: Buffer.byteLength(entry.resultText, 'utf8'),
          reason: 'The prior tool result did not fit. Retry with a smaller page, read chunk, or narrower query; do not repeat the identical request.'
        })}`;
        if (Buffer.byteLength(compact, 'utf8') <= rollingByteBudget) {
          kept.unshift(compact);
          contextBytes += Buffer.byteLength(compact, 'utf8');
          continue;
        }
      }
      omitted += 1;
      continue;
    }
    kept.unshift(entryText);
    contextBytes += bytes;
  }
  if (kept.length > 0) {
    history = `=== PRIOR TOOL RESULTS (most recent last${omitted > 0 ? `; ${omitted} older result(s) omitted` : ''}) ===\n${kept
      .join('\n')}`;
  }

  const full = [authoritative, history, budget, 'Reply with exactly one JSON action now.']
    .filter((part) => part.length > 0)
    .join('\n\n');

  return Buffer.byteLength(full, 'utf8') > promptBudget.maxPromptBytes
    ? // The rolling section alone pushed it over; drop history entirely and
      // retry with just the authoritative content and budget, which was
      // already proven to fit above.
      [authoritative, budget, 'Reply with exactly one JSON action now.'].join('\n\n')
    : full;
}

function toMessages(promptText: string): LocalInferenceMessage[] {
  const CHUNK = 190_000;
  const messages: LocalInferenceMessage[] = [];
  for (let offset = 0; offset < promptText.length; offset += CHUNK) {
    messages.push({ role: 'user', content: promptText.slice(offset, offset + CHUNK) });
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: promptText }];
}

/* -------------------------------------------------------------------------- */
/* Tool-denial classification                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every `OrnithDenialCode` sorted into the same `publishBlock` buckets
 * Claude's own `RoundReasonCode` -> bucket mapping uses
 * (`claude-round-policy.ts`): `'security'` is reserved for a genuine
 * path/identity/credential-shape refusal; everything else — including a
 * plain `timeout`, every resource-budget `limit_*` code, and an
 * infrastructural failure like `lease_busy` or `internal_error` — is
 * `'configuration'`, matching every other loop-level limit/timeout condition
 * already classified that way elsewhere in this file (deadline, turns,
 * prompt size, output tokens). A `Record` over the full `OrnithDenialCode`
 * union makes this exhaustive at compile time: a new denial code with no
 * entry here fails to build rather than silently defaulting to one bucket
 * or the other.
 */
const ORNITH_DENIAL_PUBLISH_BLOCK: Record<OrnithDenialCode, ClaudePublishBlock> = {
  runtime_unavailable: 'configuration',
  runtime_unhealthy: 'security',
  runtime_identity_changed: 'configuration',
  lease_busy: 'configuration',
  malformed_output: 'configuration',
  oversized_output: 'configuration',
  unknown_action: 'configuration',
  disallowed_action: 'security',
  invalid_path: 'security',
  path_outside_worktree: 'security',
  path_not_regular_file: 'security',
  path_symlink: 'security',
  checkout_identity_changed: 'security',
  stale_hash: 'configuration',
  replacement_mismatch: 'configuration',
  replacement_escape_suspected: 'configuration',
  file_exists: 'configuration',
  file_not_found: 'configuration',
  limit_turns_exceeded: 'configuration',
  limit_actions_exceeded: 'configuration',
  limit_context_exceeded: 'configuration',
  limit_prompt_exceeded: 'configuration',
  limit_result_exceeded: 'configuration',
  limit_read_bytes_exceeded: 'configuration',
  limit_write_bytes_exceeded: 'configuration',
  limit_changed_files_exceeded: 'configuration',
  limit_manifest_files_exceeded: 'configuration',
  limit_verification_calls_exceeded: 'configuration',
  limit_deadline_exceeded: 'configuration',
  timeout: 'configuration',
  blocked: 'configuration',
  cancelled: 'configuration',
  internal_error: 'configuration'
};

/**
 * A plain `timeout`, or a `limit_read_bytes_exceeded`, on a read-only action
 * is fed back to the model as recoverable feedback instead of ending the run
 * outright — every other denial, including every other resource-budget
 * `limit_*` code, stays terminal-but-explicit. Read-only actions are the ones
 * a repeat cannot corrupt anything by retrying; a mutation or
 * `run_verification` denial is never retried here. The two recoverable codes
 * are tracked against SEPARATE bounded counters (see the loop) because they
 * have different causes — a transient timeout vs. an exhausted resource
 * budget — and a read-budget denial gets exactly one chance, not three.
 */
function isRecoverableToolDenial(action: OrnithAction, code: OrnithDenialCode): boolean {
  // The one mutation denial that is recoverable: `replace_text` refused with
  // `replacement_escape_suspected` provably wrote nothing (the refusal precedes
  // every mutation step), so a DIFFERENT retry cannot corrupt anything.
  if (code === 'replacement_escape_suspected') return action.action === 'replace_text';
  return (code === 'timeout' || code === 'limit_read_bytes_exceeded') && isNoProgressGuardAction(action);
}

/** One safe, specific sentence naming the action, its exact denial code, and the tool's own reason. */
function describeOrnithToolDenial(action: OrnithAction, toolResult: Extract<OrnithToolResult, { ok: false }>): {
  readonly message: string;
  readonly publishBlock: ClaudePublishBlock;
} {
  return {
    message: `Agent Relay stopped the Ornith "${action.action}" action (${toolResult.code}): ${toolResult.reason}`,
    publishBlock: ORNITH_DENIAL_PUBLISH_BLOCK[toolResult.code]
  };
}

/* -------------------------------------------------------------------------- */
/* Assessment mapping                                                         */
/* -------------------------------------------------------------------------- */

function assessmentFor(input: {
  disposition: 'pass' | 'fail';
  publishBlock: ClaudeRoundAssessmentRecord['publishBlock'];
  reasonCodes: readonly string[];
}): ClaudeRoundAssessmentRecord {
  return {
    version: CLAUDE_ASSESSMENT_VERSION,
    disposition: input.disposition,
    // Relay's own post-provider snapshot verification is what decides
    // publish eligibility; Ornith's tool-loop `run_verification` is
    // diagnostic and never sets this to "passed" on its own account.
    verificationStatus: 'not_run',
    publishBlock: input.publishBlock,
    reasonCodes: [...input.reasonCodes].slice(0, 40),
    verification: null,
    denials: []
  };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

export class OrnithImplementationService {
  async implement(request: OrnithImplementationRequest): Promise<OrnithImplementationResult> {
    const deadline = Date.now() + request.loopDeadlineMs;
    let promptInput = normalizeOrnithPromptInput(
      request,
      [request.worktreePath, request.repositoryPath]
    );
    const tools = new OrnithWorktreeTools({
      worktreePath: request.worktreePath,
      worktreesRoot: request.worktreesRoot,
      repositoryPath: request.repositoryPath,
      branchName: request.branchName,
      runner: request.runner,
      gitExecutablePath: request.gitExecutablePath ?? null,
      scopedFilePathCandidates: promptInput.specification.scopedFilePaths
    });

    const rolling: RollingResult[] = [];
    let turnsUsed = 0;
    let nonterminalActionsUsed = 0;
    let verificationsUsed = 0;
    let cumulativeReadBytes = 0;
    let cumulativeWriteBytes = 0;
    let previousReadOnlyFingerprint: string | null = null;
    /** The prior no-progress-guard action's real outcome, so a repeat of a failed
     *  action is not told it "already succeeded". `null` before any such action. */
    let previousReadOnlyOutcome: 'succeeded' | OrnithDenialCode | null = null;
    let consecutiveIdenticalReadOnlyActions = 0;
    let readOnlyRecoveryAttemptsUsed = 0;
    let readBudgetRecoveryAttemptsUsed = 0;
    let replacementEscapeRecoveryAttemptsUsed = 0;
    /** The exact `replace_text` action refused with `replacement_escape_suspected`, so an
     *  identical repeat is refused before dispatch. `null` until such a denial.
     *  Sound to keep for the whole run: the action carries `path` and the expected
     *  `sha256`, so an identical later action addresses byte-identical content (the tool
     *  would fail the same way) or a changed file (it would be `stale_hash`). Key order
     *  cannot defeat it: the schema-parsed action has a canonical key order. */
    let escapeDeniedFingerprint: string | null = null;
    const outcomes: Array<{ sequence: number; action: OrnithActionKind; ok: boolean; code?: OrnithDenialCode }> = [];
    const finish = (
      disposition: 'pass' | 'fail', message: string,
      publishBlock: ClaudeRoundAssessmentRecord['publishBlock'], reasonCodes: readonly string[],
      providerFailure: OrnithImplementationResult['providerFailure'] = null
    ): OrnithImplementationResult => ({
      ...finishedResult(disposition, message, publishBlock, reasonCodes),
      providerFailure,
      ornithAudit: {
        turns: turnsUsed,
        actions: nonterminalActionsUsed,
        readBytes: cumulativeReadBytes,
        writeBytes: cumulativeWriteBytes,
        changedFiles: tools.changedFileCount(),
        verifications: verificationsUsed,
        outcomes: outcomes.slice(-20)
      }
    });

    // These sources are authoritative. The only transport substitution is an
    // exact, already-verified project/worktree root, represented by one stable
    // logical marker. Unknown host paths and credentials still cause refusal
    // before the first inference rather than being silently rewritten.
    const promptSources = [
      renderSpecification(promptInput.specification),
      promptInput.acceptedPlanReviewAddenda,
      promptInput.ruleEvidence,
      promptInput.correctionFindings
    ].filter((value): value is string => value !== null);
    if (promptSources.some((value) => containsSecretShape(value) || containsAbsoluteMachinePath(value))) {
      return finish(
        'fail',
        'The approved Ornith inputs contain credential-shaped text or an absolute machine path.',
        'security',
        ['disallowed_action']
      );
    }

    const promptPreflight = preflightOrnithPrompt(promptInput);
    if (!promptPreflight.ok) {
      return finish(
        'fail',
        `${promptPreflight.reason} Increase the Local inference context limit to at least ` +
          `${promptPreflight.requiredContextTokens} tokens and restart the runtime.`,
        'configuration',
        ['limit_context_exceeded']
      );
    }
    const promptBudget = promptPreflight.budget;

    // Resolve the specification's declared scope against the real manifest
    // once, eagerly, so even the very first prompt can name the confirmed
    // file(s) instead of the model discovering them lazily on first tool
    // dispatch. A candidate the manifest does not confirm is dropped; if
    // nothing survives (including a resolution failure, which `tools` itself
    // already treats as "no scope" rather than throwing), fall back to the
    // unmodified, unrestricted discovery behavior — scope is an optimization,
    // never a precondition for the run to proceed.
    const declaredScopeCandidates = promptInput.specification.scopedFilePaths ?? [];
    if (declaredScopeCandidates.length > 0) {
      // Bounded by the SAME whole-loop deadline as every other await in this
      // method: without it a slow or hung manifest build (two attempts, each
      // with its own git timeouts) could keep implement() running past the
      // caller's deadline before the loop ever got to check it.
      const scopeRemainingMs = deadline - Date.now();
      if (scopeRemainingMs <= 0) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      request.onProgress({ type: 'progress', text: 'Confirming specification scope against the worktree manifest…' });
      const scopeSignal = deadlineSignal(request.signal, scopeRemainingMs);
      let resolvedScope: readonly string[] | null;
      try {
        resolvedScope = await tools.resolveAuthoritativeScope(scopeSignal.signal);
      } finally {
        scopeSignal.dispose();
      }
      if (request.signal.aborted) {
        throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
      }
      if (scopeSignal.timedOut() || Date.now() >= deadline) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      if (resolvedScope === null) {
        request.onProgress({
          type: 'progress',
          text: 'Specification scope could not be confirmed against this worktree; using unrestricted discovery.'
        });
      }
      promptInput = {
        ...promptInput,
        specification: { ...promptInput.specification, scopedFilePaths: resolvedScope !== null ? [...resolvedScope] : [] }
      };
    }

    for (;;) {
      if (request.signal.aborted) {
        throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return finish(
          'fail',
          'The Ornith implementation loop exceeded its overall time budget.',
          'configuration',
          ['limit_deadline_exceeded']
        );
      }
      if (turnsUsed >= ORNITH_LIMITS.maxModelTurns) {
        return finish(
          'fail',
          'The Ornith implementation loop used its full turn budget without finishing.',
          'configuration',
          ['limit_turns_exceeded']
        );
      }

      const checkoutSignal = deadlineSignal(request.signal, remainingMs);
      let checkoutOk: boolean;
      try {
        checkoutOk = await tools.assertCheckoutIdentity(checkoutSignal.signal);
      } catch (error) {
        if (request.signal.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
        if (checkoutSignal.timedOut()) {
          return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
        }
        throw error;
      } finally {
        checkoutSignal.dispose();
      }
      if (checkoutSignal.timedOut() || Date.now() >= deadline) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      if (!checkoutOk) {
        return finish(
          'fail',
          'The task worktree no longer matches its expected checkout identity.',
          'security',
          ['checkout_identity_changed']
        );
      }

      const promptText = buildOrnithPromptText(promptInput, rolling, {
        turns: Math.max(0, ORNITH_LIMITS.maxModelTurns - turnsUsed),
        actions: Math.max(0, ORNITH_LIMITS.maxNonterminalActions - nonterminalActionsUsed),
        verifications: Math.max(0, ORNITH_LIMITS.maxVerificationCalls - verificationsUsed),
        readBytes: Math.max(0, ORNITH_LIMITS.maxCumulativeReadBytes - cumulativeReadBytes),
        writeBytes: Math.max(0, ORNITH_LIMITS.maxCumulativeWriteBytes - cumulativeWriteBytes),
        changedFiles: Math.max(0, ORNITH_LIMITS.maxChangedFiles - tools.changedFileCount())
      }, promptBudget);
      if (promptText === null) {
        return finish(
          'fail',
          'The approved specification, addenda and rule evidence do not fit the Ornith prompt budget.',
          'configuration',
          ['limit_prompt_exceeded']
        );
      }

      const requestId = `ornith-${Date.now().toString(36)}-${turnsUsed}`;
      const inferRequest: LocalInferenceRequest = {
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId,
        messages: toMessages(promptText),
        maxOutputTokens: promptBudget.maxOutputTokens,
        structuredOutput: 'ornith_action_v1'
      };

      turnsUsed += 1;
      request.onProgress({ type: 'progress', text: `Ornith turn ${turnsUsed}` });

      const inferenceRemainingMs = deadline - Date.now();
      if (inferenceRemainingMs <= 0) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      const inferenceSignal = deadlineSignal(request.signal, inferenceRemainingMs);
      let outcome;
      try {
        outcome = await request.leaseService.inferForOrnith(request.lease, inferRequest, inferenceSignal.signal);
      } finally {
        inferenceSignal.dispose();
      }

      if (request.signal.aborted) {
        throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
      }
      if (inferenceSignal.timedOut() || Date.now() >= deadline) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      if (outcome.kind !== 'completed') {
        if (outcome.kind === 'cancelled') {
          throw new AgentRelayError('CANCELLED', 'The local runtime cancelled the Ornith inference.');
        }
        const safeReason = safeProviderFailureReason(outcome.reason);
        return finish(
          'fail',
          `The local runtime ${outcome.kind === 'timed_out' ? 'timed out' : 'failed'} ` +
            `(${outcome.dispatchOutcome}): ${safeReason}`,
          'configuration',
          [outcome.kind === 'timed_out' ? 'timeout' : 'runtime_unavailable'],
          {
            kind: outcome.kind,
            reason: safeReason,
            dispatchOutcome: outcome.dispatchOutcome
          }
        );
      }

      const response = outcome.response;
      if (
        response.providerId !== request.lease.providerId ||
        response.modelId !== request.lease.modelId ||
        response.runtimeInstanceId !== request.lease.runtimeInstanceId
      ) {
        return finish(
          'fail',
          'The local runtime identity changed during this run.',
          'configuration',
          ['runtime_identity_changed']
        );
      }

      const parsed = parseOrnithCompletion(response.completion);
      if (!parsed.ok) {
        if (response.finishReason.kind === 'length') {
          return finish(
            'fail',
            `Ornith reached the ${inferRequest.maxOutputTokens}-token output limit before returning a complete JSON action. ` +
              'Increase Local inference → Default max output tokens and restart the runtime.',
            'configuration',
            ['limit_output_exceeded']
          );
        }
        return finish('fail', 'Ornith returned output that could not be accepted.', 'configuration', [parsed.code]);
      }
      const action = parsed.action;

      // The identity/health check inside `inferForOrnith` covers the instant
      // the completion arrived; it proves nothing about the moment between
      // then and now. Re-confirm the exact lease owner, retained provider
      // instance, runtime instance, provider/model/settings fingerprint, and
      // Healthy state immediately before accepting ANY parsed action —
      // `finish`, `blocked`, or a nonterminal tool dispatch alike — so an
      // unexpected exit in that window discards the completion outright
      // rather than letting one more action run on its strength.
      const leaseRemainingMs = deadline - Date.now();
      if (leaseRemainingMs <= 0) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      const leaseSignal = deadlineSignal(request.signal, leaseRemainingMs);
      let leaseStillHealthy: boolean;
      try {
        leaseStillHealthy = await request.leaseService.recheckOrnithLease(request.lease, leaseSignal.signal);
      } catch (error) {
        if (request.signal.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
        if (leaseSignal.timedOut()) {
          return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
        }
        throw error;
      } finally {
        leaseSignal.dispose();
      }
      if (request.signal.aborted) {
        throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
      }
      if (leaseSignal.timedOut() || Date.now() >= deadline) {
        return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
      }
      if (!leaseStillHealthy) {
        return finish(
          'fail',
          'The local runtime identity or health changed before this action could be accepted.',
          'security',
          ['runtime_unhealthy']
        );
      }

      if (action.action === 'finish') {
        if (containsAbsoluteMachinePath(action.summary)) {
          return finish(
            'fail',
            'Ornith finished with a summary that referenced an absolute machine path, which was refused.',
            'security',
            ['disallowed_action']
          );
        }
        request.onProgress({ type: 'assistant_message', text: 'Ornith finished.' });
        return finish('pass', action.summary, 'verification', []);
      }
      if (action.action === 'blocked') {
        request.onProgress({
          type: 'tool_use',
          text: 'Ornith ended the run as blocked.',
          data: {
            sequence: nonterminalActionsUsed + 1,
            action: 'blocked',
            ok: false,
            code: 'blocked',
            providerId: request.lease.providerId,
            modelId: request.lease.modelId,
            runtimeInstanceId: request.lease.runtimeInstanceId
          }
        });
        return finish('fail', 'Ornith reported that it could not continue.', 'configuration', ['blocked']);
      }

      if (nonterminalActionsUsed >= ORNITH_LIMITS.maxNonterminalActions) {
        return finish(
          'fail',
          'The Ornith implementation loop used its full action budget without finishing.',
          'configuration',
          ['limit_actions_exceeded']
        );
      }
      nonterminalActionsUsed += 1;

      const readOnlyFingerprint = isNoProgressGuardAction(action)
        ? JSON.stringify(action)
        : null;
      if (readOnlyFingerprint !== null && readOnlyFingerprint === previousReadOnlyFingerprint) {
        consecutiveIdenticalReadOnlyActions += 1;
      } else {
        previousReadOnlyFingerprint = readOnlyFingerprint;
        consecutiveIdenticalReadOnlyActions = readOnlyFingerprint === null ? 0 : 1;
      }
      if (consecutiveIdenticalReadOnlyActions >= ORNITH_LIMITS.maxConsecutiveIdenticalReadOnlyActions) {
        outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: false });
        request.onProgress({
          type: 'tool_use',
          text: `Ornith repeated ${action.action} without progress; the loop stopped.`,
          data: { sequence: nonterminalActionsUsed, turn: turnsUsed, action: action.action, ok: false, code: 'no_progress_loop' }
        });
        return finish(
          'fail',
          `Ornith repeated the same ${action.action} request without using its result.`,
          'configuration',
          ['no_progress_loop']
        );
      }
      if (consecutiveIdenticalReadOnlyActions === 2) {
        outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: false });
        const priorFailureCode = previousReadOnlyOutcome !== null && previousReadOnlyOutcome !== 'succeeded'
          ? previousReadOnlyOutcome
          : null;
        const duplicateFeedback = {
          ok: false,
          code: priorFailureCode ?? 'duplicate_no_progress',
          reason: priorFailureCode !== null
            ? `The identical ${action.action} request (${describeActionParams(action)}) already failed ` +
              `(${priorFailureCode}) and was not retried unchanged. Narrow "files", the query, offset, or limit ` +
              'before retrying — repeating the exact same request will not succeed.'
            : `The identical ${action.action} request already succeeded and was not executed again. ` +
              'Use its prior result and choose a different action; narrow the query or page only if the result was truncated.'
        };
        rolling.push({
          turn: turnsUsed,
          action: action.action,
          resultText: JSON.stringify(duplicateFeedback)
        });
        request.onProgress({
          type: 'tool_use',
          text: `Skipped duplicate Ornith ${action.action} request with no progress.`,
          data: { sequence: nonterminalActionsUsed, turn: turnsUsed, action: action.action, ok: false, code: 'duplicate_no_progress' }
        });
        continue;
      }

      const changedPath = 'path' in action && (action.action === 'create_file' || action.action === 'replace_text' || action.action === 'delete_file')
        ? action.path : null;
      if (changedPath !== null && tools.wouldExceedChangedFileLimit(changedPath)) {
        return finish(
          'fail',
          'The Ornith implementation loop exceeded the changed-file limit.',
          'configuration',
          ['limit_changed_files_exceeded']
        );
      }

      let toolResult: OrnithToolResult;
      let identicalEscapeRetryRefused = false;
      const operationStarted = Date.now();
      if (action.action === 'replace_text' && escapeDeniedFingerprint !== null && JSON.stringify(action) === escapeDeniedFingerprint) {
        // Never dispatched: it would fail exactly as before. The single retry was
        // supposed to CHANGE the escaping, so this ends the run.
        identicalEscapeRetryRefused = true;
        toolResult = {
          ok: false,
          code: 'replacement_escape_suspected',
          reason: 'The identical replace_text request already failed with replacement_escape_suspected and was ' +
            'not dispatched again. The file is unchanged.'
        };
      } else if (action.action === 'run_verification') {
        if (verificationsUsed >= ORNITH_LIMITS.maxVerificationCalls) {
          return finish('fail', 'The verification-call budget for this run is exhausted.', 'configuration', ['limit_verification_calls_exceeded']);
        } else {
          verificationsUsed += 1;
          // The caller's closure additionally clamps this to its own process
          // timeout — see the `runVerification` field doc and the Orchestrator
          // wiring, which is where `settings.processTimeoutMs` is known.
          const remainingLoopMs = Math.max(1, deadline - Date.now());
          const verificationSignal = deadlineSignal(request.signal, remainingLoopMs);
          try {
            const result = await request.runVerification(verificationSignal.signal, remainingLoopMs);
            if (verificationSignal.timedOut() || Date.now() >= deadline) {
              return finish(
                'fail',
                'The Ornith implementation loop exceeded its overall time budget.',
                'configuration',
                ['limit_deadline_exceeded']
              );
            }
            toolResult = {
              ok: true,
              forModel: { passed: result.passed, summary: result.summary.slice(0, ORNITH_LIMITS.maxToolResultBytes) },
              readBytes: 0,
              writeBytes: 0,
              auditSummary: `run_verification -> ${result.passed ? 'passed' : 'failed'}`
            };
          } catch (error) {
            if (request.signal.aborted) {
              throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
            }
            if (verificationSignal.timedOut()) {
              return finish(
                'fail',
                'The Ornith implementation loop exceeded its overall time budget.',
                'configuration',
                ['limit_deadline_exceeded']
              );
            }
            toolResult = { ok: false, code: 'timeout', reason: boundedVerificationError(error) };
          } finally {
            verificationSignal.dispose();
          }
        }
      } else {
        const operationRemainingMs = deadline - Date.now();
        if (operationRemainingMs <= 0) {
          return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
        }
        const operationSignal = deadlineSignal(request.signal, operationRemainingMs);
        try {
          if (!(await tools.assertCheckoutIdentity(operationSignal.signal))) {
            return finish('fail', 'The task worktree checkout identity changed.', 'security', ['checkout_identity_changed']);
          }
          toolResult = await this.dispatchToolAction(tools, action, operationSignal.signal, {
            readBytes: ORNITH_LIMITS.maxCumulativeReadBytes - cumulativeReadBytes,
            writeBytes: ORNITH_LIMITS.maxCumulativeWriteBytes - cumulativeWriteBytes
          }, promptBudget.maxToolResultBytes);
        } catch (error) {
          if (request.signal.aborted) throw new AgentRelayError('CANCELLED', 'The Ornith run was cancelled.');
          if (operationSignal.timedOut()) {
            return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
          }
          throw error;
        } finally {
          operationSignal.dispose();
        }
        if (operationSignal.timedOut() || Date.now() >= deadline) {
          return finish('fail', 'The Ornith implementation loop exceeded its overall time budget.', 'configuration', ['limit_deadline_exceeded']);
        }
      }

      const durationMs = Date.now() - operationStarted;
      if (isNoProgressGuardAction(action)) {
        previousReadOnlyOutcome = toolResult.ok ? 'succeeded' : toolResult.code;
      }
      if (!toolResult.ok) {
        outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code });

        const isBudgetDenial = toolResult.code === 'limit_read_bytes_exceeded';
        const isEscapeDenial = toolResult.code === 'replacement_escape_suspected';
        const recoveryAttemptsUsed = isBudgetDenial
          ? readBudgetRecoveryAttemptsUsed
          : isEscapeDenial ? replacementEscapeRecoveryAttemptsUsed : readOnlyRecoveryAttemptsUsed;
        const recoveryAttemptsMax = isBudgetDenial
          ? ORNITH_LIMITS.maxReadBudgetRecoveryAttempts
          : isEscapeDenial
            ? ORNITH_LIMITS.maxReplacementEscapeRecoveryAttempts
            : ORNITH_LIMITS.maxReadOnlyRecoveryAttempts;
        const willRecover = !identicalEscapeRetryRefused &&
          isRecoverableToolDenial(action, toolResult.code) && recoveryAttemptsUsed < recoveryAttemptsMax;

        // One event covers both facts (denied, and whether it will recover)
        // so there is exactly one notification for this operation — never a
        // second one moments later when the recovery branch below runs.
        // Typed against the shared OrnithToolDenialEventData contract (see
        // shared/domain/ornith.ts) so a field rename/removal here fails this
        // build instead of only showing up as RelayTimeline silently falling
        // back to plain text.
        const denialEventData: Record<string, unknown> & OrnithToolDenialEventData = {
          sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code, durationMs,
          recoverable: willRecover,
          readBytesUsed: cumulativeReadBytes,
          readBytesConfigured: ORNITH_LIMITS.maxCumulativeReadBytes,
          changedFiles: tools.changedFileCount()
        };
        request.onProgress({
          type: 'tool_use',
          text: willRecover
            ? `Ornith action ${action.action} denied (${toolResult.code}); recovering with feedback.`
            : `Ornith action ${action.action} denied (${toolResult.code}); the run stopped.`,
          data: denialEventData
        });

        if (willRecover) {
          if (isBudgetDenial) readBudgetRecoveryAttemptsUsed += 1;
          else if (isEscapeDenial) {
            replacementEscapeRecoveryAttemptsUsed += 1;
            escapeDeniedFingerprint = JSON.stringify(action);
          } else readOnlyRecoveryAttemptsUsed += 1;
          const remaining = recoveryAttemptsMax - (recoveryAttemptsUsed + 1);
          const recoveryFeedback = {
            ok: false,
            code: toolResult.code,
            reason: isEscapeDenial
              ? `${toolResult.reason} The file is unchanged and still has the sha256 you supplied. You have one ` +
                'retry: send a DIFFERENT replace_text (or read_file again first), writing every real line break in ' +
                'oldText and newText as the single-backslash JSON escape that matches the lineEnding read_file ' +
                'reported. The identical request will not be dispatched again.'
              : isBudgetDenial
              ? `${toolResult.reason} (${describeActionParams(action)}) No further reads or searches are ` +
                'available for this request; the repository read budget for this run cannot fit it. Use the ' +
                'verified context you already have to make the scoped edit now, or call "blocked" if you cannot ' +
                'safely continue without it. This exact request will not be retried.'
              : `${toolResult.reason} (${describeActionParams(action)}) ${remaining} read-only recovery ` +
                `attempt${remaining === 1 ? '' : 's'} remain this run. Narrow "files", the query, offset, or limit ` +
                'before retrying; repeating this exact request will be refused.'
          };
          rolling.push({ turn: turnsUsed, action: action.action, resultText: JSON.stringify(recoveryFeedback) });
          continue;
        }

        const { message, publishBlock } = describeOrnithToolDenial(action, toolResult);
        return finish('fail', message, publishBlock, [toolResult.code]);
      }

      if (cumulativeReadBytes + toolResult.readBytes > ORNITH_LIMITS.maxCumulativeReadBytes) {
        return finish('fail', 'The Ornith repository read budget was exceeded.', 'configuration', ['limit_read_bytes_exceeded']);
      }
      if (cumulativeWriteBytes + toolResult.writeBytes > ORNITH_LIMITS.maxCumulativeWriteBytes) {
        return finish('fail', 'The Ornith repository write budget was exceeded.', 'configuration', ['limit_write_bytes_exceeded']);
      }
      cumulativeReadBytes += toolResult.readBytes;
      cumulativeWriteBytes += toolResult.writeBytes;
      outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: true });

      request.onProgress({
        type: 'tool_use',
        text: toolResult.auditSummary,
        data: {
          sequence: nonterminalActionsUsed, turn: turnsUsed, action: action.action, ok: true,
          durationMs, readBytes: toolResult.readBytes, writeBytes: toolResult.writeBytes,
          changedPath: toolResult.changedPath ?? null, cumulativeReadBytes, cumulativeWriteBytes,
          changedFiles: tools.changedFileCount(), verifications: verificationsUsed,
          providerId: request.lease.providerId, modelId: request.lease.modelId,
          runtimeInstanceId: request.lease.runtimeInstanceId
        }
      });

      const resultText = resultTextFor(action.action, toolResult.forModel, promptBudget.maxToolResultBytes);
      rolling.push({ turn: turnsUsed, action: action.action, resultText });
    }
  }

  private async dispatchToolAction(
    tools: OrnithWorktreeTools,
    action: Exclude<OrnithAction, { action: 'finish' } | { action: 'blocked' } | { action: 'run_verification' }>,
    signal: AbortSignal,
    budget: OrnithOperationBudget,
    maxToolResultBytes: number
  ): Promise<OrnithToolResult> {
    switch (action.action) {
      case 'list_files':
        return tools.listFiles(action, signal, maxToolResultBytes);
      case 'read_file':
        // Packed against the exact serialized budget inside `readFile` (see its
        // doc comment) instead of pre-clamping the raw byte limit: a raw-byte
        // clamp cannot know how much JSON escaping will inflate the slice, and
        // an over-budget result used to be replaced by a content-free stub.
        return tools.readFile(action, signal, budget, maxToolResultBytes);
      case 'search_text':
        return tools.searchText(action, signal, budget, maxToolResultBytes);
      case 'create_file':
        return tools.createFile(action, signal, budget);
      case 'replace_text':
        return tools.replaceText(action, signal, budget);
      case 'delete_file':
        return tools.deleteFile(action, signal, budget);
      case 'git_status':
        return tools.gitStatus(signal);
      case 'git_diff':
        return tools.gitDiff(action, signal, budget);
      default: {
        const exhaustive: never = action;
        return { ok: false, code: 'unknown_action', reason: `Unhandled action ${String((exhaustive as { action?: string }).action)}.` };
      }
    }
  }
}

function isNoProgressGuardAction(action: OrnithAction): boolean {
  return action.action === 'list_files' ||
    action.action === 'read_file' ||
    action.action === 'search_text' ||
    action.action === 'git_status' ||
    action.action === 'git_diff';
}

/**
 * A compact, safe rendering of a read-only action's own parameters, for
 * feedback that names exactly which request timed out or was repeated. Every
 * field here is the model's own prior input, already bounded and validated
 * as safe prose/paths by the action schema — never file content or a
 * denial's internal detail.
 */
function describeActionParams(action: OrnithAction): string {
  switch (action.action) {
    case 'search_text':
      return `query=${JSON.stringify(action.query)} caseSensitive=${action.caseSensitive} ` +
        `files=${action.files ? JSON.stringify(action.files) : '<whole manifest>'} limit=${action.limit}`;
    case 'read_file':
      return `path=${JSON.stringify(action.path)} offset=${action.offset} limit=${action.limit}`;
    case 'list_files':
      return `prefix=${JSON.stringify(action.prefix)} limit=${action.limit}` +
        (action.cursor !== undefined ? ` cursor=${action.cursor}` : '');
    case 'git_diff':
      return `paths=${action.paths ? JSON.stringify(action.paths) : '<whole manifest>'}`;
    default:
      return '(no parameters)';
  }
}

function finishedResult(
  disposition: 'pass' | 'fail',
  message: string,
  publishBlock: ClaudeRoundAssessmentRecord['publishBlock'],
  reasonCodes: readonly string[]
): ImplementationResult {
  return {
    sessionId: null,
    finalMessage: message,
    assessment: assessmentFor({ disposition, publishBlock, reasonCodes })
  };
}

function boundedJson(value: unknown, maxBytes: number): string {
  try {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes > maxBytes
      ? JSON.stringify({
          truncated: true,
          originalBytes: bytes,
          retainedLimitBytes: maxBytes,
          reason: 'Tool result exceeded this runtime context budget; request a smaller page or read chunk.'
        })
      : text;
  } catch {
    return '(unserializable result)';
  }
}

/** Actions whose `OrnithWorktreeTools` method packs its own result to already fit the
 *  budget it is given (`nextCursor`/`total` for list_files, `truncated` for
 *  search_text, `totalBytes`/`nextOffset`/`sha256` for read_file), so falling through
 *  to the generic byte-cap-and-replace stub would erase continuation-bearing fields
 *  these actions specifically rely on. */
const SELF_PACKED_ACTIONS: ReadonlySet<OrnithAction['action']> = new Set(['list_files', 'search_text', 'read_file']);

/**
 * See `SELF_PACKED_ACTIONS`. For those actions this does not degrade a budget-fit
 * violation to the generic `boundedJson` stub, which would erase `nextCursor`/`total`
 * or `truncated` exactly like the defect the pagination fix exists to close; instead
 * it treats a violation of the fit-by-construction invariant as the programming
 * defect it would be, failing loudly rather than silently.
 */
function resultTextFor(actionKind: OrnithAction['action'], forModel: unknown, maxToolResultBytes: number): string {
  if (!SELF_PACKED_ACTIONS.has(actionKind)) return boundedJson(forModel, maxToolResultBytes);
  const text = JSON.stringify(forModel);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxToolResultBytes) {
    throw new AgentRelayError(
      'INTERNAL',
      `${actionKind} produced a ${bytes}-byte result against a ${maxToolResultBytes}-byte budget it was given to ` +
        'pack against. This violates that method\'s own fit-by-construction invariant and is a packing defect, ' +
        'not a runtime condition to truncate away.'
    );
  }
  return text;
}

function safeProviderFailureReason(reason: string): string {
  const bounded = reason.trim().slice(0, ORNITH_LIMITS.maxErrorChars);
  if (
    bounded.length === 0 ||
    containsSecretShape(bounded) ||
    containsAbsoluteMachinePath(bounded)
  ) {
    return 'The runtime returned an unsafe or empty failure description.';
  }
  return bounded;
}

function boundedVerificationError(error: unknown): string {
  const message = error instanceof Error ? error.constructor.name : 'unknown error';
  return `Verification could not be run (${message}).`.slice(0, ORNITH_LIMITS.maxErrorChars);
}

function deadlineSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  const abort = (): void => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    }
  };
}
