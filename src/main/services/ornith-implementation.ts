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
  ORNITH_ACTION_JSON_SCHEMA,
  ORNITH_LIMITS,
  ORNITH_NONTERMINAL_ACTION_KINDS,
  containsAbsoluteMachinePath,
  parseOrnithCompletion,
  type OrnithAction,
  type OrnithActionKind,
  type OrnithDenialCode
} from '../../shared/domain/ornith';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceMessage,
  type LocalInferenceRequest
} from '../../shared/domain/local-inference';
import type { ClaudeRoundAssessmentRecord } from '../../shared/domain/claude-assessment';
import { CLAUDE_ASSESSMENT_VERSION } from '../../shared/domain/claude-assessment';
import { AgentRelayError } from '../../shared/domain/errors';
import { containsSecretShape } from '../../shared/util/redact';
import type { TaskSpecification } from '../../shared/schemas/codex';
import type { AgentProgressEvent, ImplementationResult, OrnithHealthyLease, OrnithInferenceLeaseService } from '../ports';
import type { ProcessRunner } from '../adapters/process/process-runner';
import { OrnithWorktreeTools, type OrnithOperationBudget, type OrnithToolResult } from './ornith-worktree-tools';

type OrnithResponseSchema = NonNullable<LocalInferenceRequest['responseFormat']>['schema'];

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
  readonly action: OrnithActionKind | 'protocol_error';
  /** Bounded JSON text: either the tool's `forModel`, or a denial description. */
  readonly resultText: string;
}

interface ReadCoverage {
  readonly sha256: string;
  readonly ranges: readonly { start: number; end: number }[];
  /** Exact byte position immediately after the file when a successful read reached EOF. */
  readonly eofAt: number | null;
}

const RECOVERABLE_TOOL_CODES = new Set<OrnithDenialCode>([
  'duplicate_action',
  'verification_not_ready',
  'file_exists',
  'file_not_found',
  'stale_hash',
  'replacement_mismatch',
  'timeout'
]);

/**
 * Only cool down an action when repeating that action kind cannot be the
 * immediate repair. A stale hash or mismatched replacement must keep
 * `replace_text` available: the safe recovery is another replacement using
 * the trusted current hash/exact text, not deleting and recreating the file.
 */
const COOLDOWN_TOOL_CODES = new Set<OrnithDenialCode>([
  'verification_not_ready',
  'file_exists',
  'file_not_found',
  'timeout'
]);

const ORNITH_OBSERVATION_ACTIONS: readonly OrnithActionKind[] = [
  'list_files',
  'read_file',
  'search_text',
  'git_status',
  'git_diff'
];

function nextUnreadAction(
  action: Extract<OrnithAction, { action: 'read_file' }>,
  coverage: ReadCoverage | undefined
): Extract<OrnithAction, { action: 'read_file' }> | null {
  if (coverage === undefined) return action;
  if (coverage.eofAt !== null && action.offset >= coverage.eofAt) return null;
  const requestedEnd = Math.min(
    action.offset + action.limit,
    coverage.eofAt ?? Number.POSITIVE_INFINITY
  );
  let start = action.offset;
  const ranges = [...coverage.ranges].sort((left, right) => left.start - right.start);
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start > start) break;
    start = Math.max(start, range.end);
  }
  if (start >= requestedEnd) return null;
  const nextCovered = ranges.find((range) => range.start > start && range.start < requestedEnd);
  return {
    ...action,
    offset: start,
    limit: Math.max(1, (nextCovered?.start ?? requestedEnd) - start)
  };
}

function addReadCoverage(coverage: Map<string, ReadCoverage>, value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const result = value as Record<string, unknown>;
  if (
    typeof result.path !== 'string' ||
    typeof result.offset !== 'number' ||
    typeof result.bytesRead !== 'number' ||
    typeof result.sha256 !== 'string'
  ) return;
  const previous = coverage.get(result.path);
  const ranges = previous?.sha256 === result.sha256 ? [...previous.ranges] : [];
  if (result.bytesRead > 0) {
    ranges.push({ start: result.offset, end: result.offset + result.bytesRead });
  }
  const eofAt = result.eof === true
    ? result.offset + result.bytesRead
    : previous?.sha256 === result.sha256
      ? previous.eofAt
      : null;
  coverage.set(result.path, { sha256: result.sha256, ranges, eofAt });
}

function finishSummaryReportsBlockage(summary: string): boolean {
  const normalized = summary.replace(/\s+/gu, ' ').trim();
  return /(?:^|[.!?]\s+)(?:i|we)\s+(?:cannot|can't|could not|couldn't)\b/iu.test(normalized) ||
    /(?:^|[.!?]\s+)(?:i am|we are)\s+blocked\b/iu.test(normalized);
}

function addKnownFileHashes(hashes: Map<string, string>, value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const result = value as Record<string, unknown>;
  if (typeof result.path === 'string' && typeof result.sha256 === 'string') {
    hashes.set(result.path, result.sha256);
  }
  if (!Array.isArray(result.matches)) return;
  for (const match of result.matches) {
    if (typeof match !== 'object' || match === null) continue;
    const record = match as Record<string, unknown>;
    if (typeof record.path === 'string' && typeof record.sha256 === 'string') {
      hashes.set(record.path, record.sha256);
    }
  }
}

function reusableReadOnlyActionKey(action: OrnithAction): string | null {
  return action.action === 'list_files' ||
    action.action === 'search_text' ||
    action.action === 'git_status' ||
    action.action === 'git_diff'
    ? JSON.stringify(action)
    : null;
}

function responseSchemaWithoutActions(actions: readonly OrnithActionKind[]): OrnithResponseSchema {
  const schema = structuredClone(ORNITH_ACTION_JSON_SCHEMA);
  const excluded = new Set(actions);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    for (const key of ['anyOf', 'oneOf']) {
      const branches = record[key];
      if (!Array.isArray(branches)) continue;
      record[key] = branches.filter((branch) => {
        if (typeof branch !== 'object' || branch === null) return true;
        const properties = (branch as Record<string, unknown>).properties;
        if (typeof properties !== 'object' || properties === null) return true;
        const actionProperty = (properties as Record<string, unknown>).action;
        if (typeof actionProperty !== 'object' || actionProperty === null) return true;
        return !excluded.has((actionProperty as Record<string, unknown>).const as OrnithActionKind);
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(schema);
  return schema;
}

function redactBoundRootPaths(
  value: string,
  roots: readonly { path: string; replacement: string }[]
): string {
  return [...roots]
    .filter(({ path }) => path.trim().length > 0)
    .sort((left, right) => right.path.length - left.path.length)
    .reduce((redacted, { path, replacement }) => {
      const normalized = path.replace(/[\\/]+$/u, '');
      const pattern = normalized
        .split(/[\\/]+/u)
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[\\\\/]');
      return redacted.replace(new RegExp(pattern, 'giu'), replacement);
    }, value);
}

function promptRequestWithBoundRootsRedacted(
  request: OrnithImplementationRequest
): OrnithPromptPreflightInput {
  const roots = [
    { path: request.worktreePath, replacement: '[worktree-root]' },
    { path: request.worktreesRoot, replacement: '[worktrees-root]' },
    { path: request.repositoryPath, replacement: '[repository-root]' }
  ];
  const redact = (value: string): string => redactBoundRootPaths(value, roots);
  return {
    specification: {
      title: redact(request.specification.title),
      summary: redact(request.specification.summary),
      acceptanceCriteria: request.specification.acceptanceCriteria.map(redact),
      constraints: request.specification.constraints.map(redact),
      assumptions: request.specification.assumptions.map(redact),
      suggestedTests: request.specification.suggestedTests.map(redact),
      implementationPrompt: redact(request.specification.implementationPrompt)
    },
    ruleEvidence: request.ruleEvidence === null ? null : redact(request.ruleEvidence),
    acceptedPlanReviewAddenda: request.acceptedPlanReviewAddenda === null
      ? null
      : redact(request.acceptedPlanReviewAddenda),
    correctionFindings: request.correctionFindings === null
      ? null
      : redact(request.correctionFindings),
    round: request.round,
    maxRounds: request.maxRounds,
    lease: request.lease
  };
}

function renderSpecification(specification: TaskSpecification): string {
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
- Use "create_file" only for a path that does not exist. Use "replace_text" to edit an
  existing file. Never delete and recreate an existing file as a workaround for a stale
  hash or replacement mismatch; refresh the hash/exact text and retry "replace_text".
- Use "delete_file" only when the approved specification explicitly requires that file
  to be removed. A failed edit is never permission to delete the file.
- You have no git commit, push, merge, checkout, reset, or remote access of any kind —
  do not ask for one, it does not exist.
- Call "run_verification" only when you believe the work is complete; Agent Relay itself
  re-verifies afterward regardless. Verification is unavailable until a repository mutation
  has produced a changed file, and becomes unavailable again after it runs until another
  mutation changes the worktree.
- Treat PRIOR TOOL RESULTS as memory. Never request a byte range that a successful
  read_file result already returned for the same file and sha256. Use search_text plus
  small, non-overlapping read_file ranges for long files, then edit and move on.
- read_file offset and limit are UTF-8 BYTE positions/counts, never line numbers. A
  reviewer location such as README.md:495 means line 495, not byte offset 495. Find
  the named text with search_text or inspect git_diff; never guess a byte offset from
  a review line number.
- A successful git_diff result contains the current patch and exact edit anchors. A
  successful list_files/git_status result proves those paths exist. Do not claim a file
  is absent or inaccessible after those results prove otherwise.
- Every turn must advance the task. Do not repeat a successful read, search, status or
  diff action unless a later write could have changed its result.
- Call "finish" only when the acceptance criteria are met; its summary must describe
  completed work and must not report inability or blockage. Call "blocked" when you
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
    request.correctionFindings ? `=== EVIDENCE FROM THE PREVIOUS ATTEMPT ===\n${request.correctionFindings}` : null
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
  const budget = promptBudgetFor(input.lease);
  const authoritativeBytes = Buffer.byteLength(
    `${ORNITH_PROTOCOL_INSTRUCTIONS}\n\n${authoritativePromptText(input)}`,
    'utf8'
  );
  const fixedBudgetBytes = Buffer.byteLength(`=== REMAINING BUDGET ===
Model turns remaining: ${ORNITH_LIMITS.maxModelTurns}
Non-terminal actions remaining: ${ORNITH_LIMITS.maxNonterminalActions}
Verification calls remaining: ${ORNITH_LIMITS.maxVerificationCalls}
Repository read bytes remaining: ${ORNITH_LIMITS.maxCumulativeReadBytes}
Repository write bytes remaining: ${ORNITH_LIMITS.maxCumulativeWriteBytes}
Changed files remaining: ${ORNITH_LIMITS.maxChangedFiles}
Maximum retained tool-result bytes: ${budget.maxToolResultBytes}
Round ${input.round} of at most ${input.maxRounds}.

Reply with exactly one JSON action now.`, 'utf8');
  const requiredPromptBytes = authoritativeBytes + 2 + fixedBudgetBytes;
  // A stateless turn is useful only if at least one bounded tool result can be
  // carried into the next request. Previously the first read could consume
  // half of the nominal prompt window even when the immutable specification
  // already occupied most of it; buildOrnithPromptText then silently omitted
  // that result and the model repeated the read forever. Reserve explicit
  // rolling-context headroom and clamp every individual result to that exact
  // remainder.
  const rollingEntryOverheadBytes = 512;
  const minimumRetainedToolResultBytes = 2_048;
  const availableRollingBytes = budget.maxPromptBytes - requiredPromptBytes;
  if (availableRollingBytes >= minimumRetainedToolResultBytes + rollingEntryOverheadBytes) {
    return {
      ok: true,
      budget: {
        ...budget,
        maxToolResultBytes: Math.min(
          budget.maxToolResultBytes,
          availableRollingBytes - rollingEntryOverheadBytes
        )
      }
    };
  }
  const requiredWithRollingContext =
    requiredPromptBytes + rollingEntryOverheadBytes + minimumRetainedToolResultBytes;
  return {
    ok: false,
    reason:
      `The immutable Ornith prompt plus one retained tool result needs ${requiredWithRollingContext} bytes, but the retained ` +
      `${input.lease.contextLimitTokens}-token runtime allows at most ${budget.maxPromptBytes} prompt bytes ` +
      `after output and template reserves.`,
    requiredContextTokens:
      requiredWithRollingContext + budget.maxOutputTokens + ORNITH_LIMITS.contextSafetyTokens
  };
}

function buildOrnithPromptText(
  request: OrnithPromptPreflightInput,
  rolling: readonly RollingResult[],
  remaining: { turns: number; actions: number; verifications: number; readBytes: number; writeBytes: number; changedFiles: number },
  promptBudget: OrnithPromptBudget
): string | null {
  const authoritative = authoritativePromptText(request);

  const protocolBytes = Buffer.byteLength(ORNITH_PROTOCOL_INSTRUCTIONS, 'utf8');
  if (protocolBytes + Buffer.byteLength(authoritative, 'utf8') > promptBudget.maxPromptBytes) {
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
  const fixedBytes = protocolBytes + Buffer.byteLength(`${authoritative}\n\n${fixedTail}`, 'utf8');
  if (fixedBytes > promptBudget.maxPromptBytes) return null;
  const rollingByteBudget = Math.min(
    ORNITH_LIMITS.maxRollingContextBytes,
    promptBudget.maxPromptBytes - fixedBytes
  );

  let history = '';
  let omitted = 0;
  const kept: RollingResult[] = [];
  let contextBytes = 0;
  for (let i = rolling.length - 1; i >= 0; i -= 1) {
    const entry = rolling[i];
    if (entry === undefined) continue;
    const entryText = `turn ${entry.turn} [${entry.action}]: ${entry.resultText}`;
    const bytes = Buffer.byteLength(entryText, 'utf8');
    if (kept.length >= ORNITH_LIMITS.maxRetainedResults || contextBytes + bytes > rollingByteBudget) {
      omitted += 1;
      continue;
    }
    kept.unshift(entry);
    contextBytes += bytes;
  }
  if (kept.length > 0) {
    history = `=== PRIOR TOOL RESULTS (most recent last${omitted > 0 ? `; ${omitted} older result(s) omitted` : ''}) ===\n${kept
      .map((entry) => `turn ${entry.turn} [${entry.action}]: ${entry.resultText}`)
      .join('\n')}`;
  }

  const full = [authoritative, history, budget, 'Reply with exactly one JSON action now.']
    .filter((part) => part.length > 0)
    .join('\n\n');

  return protocolBytes + Buffer.byteLength(full, 'utf8') > promptBudget.maxPromptBytes
    ? // The rolling section alone pushed it over; drop history entirely and
      // retry with just the authoritative content and budget, which was
      // already proven to fit above.
      [authoritative, budget, 'Reply with exactly one JSON action now.'].join('\n\n')
    : full;
}

function toMessages(promptText: string): LocalInferenceMessage[] {
  const CHUNK = 190_000;
  const messages: LocalInferenceMessage[] = [
    { role: 'system', content: ORNITH_PROTOCOL_INSTRUCTIONS }
  ];
  for (let offset = 0; offset < promptText.length; offset += CHUNK) {
    messages.push({ role: 'user', content: promptText.slice(offset, offset + CHUNK) });
  }
  return promptText.length > 0
    ? messages
    : [...messages, { role: 'user', content: 'Reply with exactly one JSON action now.' }];
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
    const tools = new OrnithWorktreeTools({
      worktreePath: request.worktreePath,
      worktreesRoot: request.worktreesRoot,
      repositoryPath: request.repositoryPath,
      branchName: request.branchName,
      runner: request.runner,
      gitExecutablePath: request.gitExecutablePath ?? null
    });

    const deadline = Date.now() + request.loopDeadlineMs;
    const rolling: RollingResult[] = [];
    const readCoverage = new Map<string, ReadCoverage>();
    const knownFileHashes = new Map<string, string>();
    const successfulReadOnlyActions = new Set<string>();
    let turnsUsed = 0;
    let nonterminalActionsUsed = 0;
    let verificationsUsed = 0;
    let cumulativeReadBytes = 0;
    let cumulativeWriteBytes = 0;
    let malformedRetries = 0;
    let verificationReady = false;
    let verificationPassedForCurrentSnapshot = false;
    let nonMutatingActionsSinceWrite = 0;
    const actionCooldowns = new Map<OrnithActionKind, number>();
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

    // Credential-shaped input is never rewritten. Bound checkout roots are
    // different: Relay and its specification agent may legitimately mention
    // them, but Ornith can only act through repository-relative tools. Replace
    // those exact, already-verified roots with stable labels before inference,
    // then refuse any other absolute machine path that remains.
    const rawPromptSources = [
      renderSpecification(request.specification),
      request.acceptedPlanReviewAddenda,
      request.ruleEvidence,
      request.correctionFindings
    ].filter((value): value is string => value !== null);
    if (rawPromptSources.some((value) => containsSecretShape(value))) {
      return finish(
        'fail',
        'The approved Ornith inputs contain credential-shaped text.',
        'security',
        ['disallowed_action']
      );
    }

    const promptRequest = promptRequestWithBoundRootsRedacted(request);
    const promptSources = [
      renderSpecification(promptRequest.specification),
      promptRequest.acceptedPlanReviewAddenda,
      promptRequest.ruleEvidence,
      promptRequest.correctionFindings
    ].filter((value): value is string => value !== null);
    if (promptSources.some((value) => containsAbsoluteMachinePath(value))) {
      return finish(
        'fail',
        'The approved Ornith inputs contain an absolute machine path outside the bound checkout.',
        'security',
        ['disallowed_action']
      );
    }

    const promptPreflight = preflightOrnithPrompt(promptRequest);
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

      const promptText = buildOrnithPromptText(promptRequest, rolling, {
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
      const excludedActions = new Set([...actionCooldowns.entries()]
        .filter(([, remaining]) => remaining > 0)
        .map(([action]) => action));
      if (!verificationReady || tools.changedFileCount() === 0) {
        excludedActions.add('run_verification');
      }
      if (
        nonMutatingActionsSinceWrite >= ORNITH_LIMITS.maxNonMutatingActionsBetweenWrites ||
        (turnsUsed >= ORNITH_LIMITS.maxModelTurns - 5 && tools.changedFileCount() > 0)
      ) {
        for (const action of ORNITH_OBSERVATION_ACTIONS) excludedActions.add(action);
      }
      if (verificationPassedForCurrentSnapshot) {
        for (const action of ORNITH_NONTERMINAL_ACTION_KINDS) excludedActions.add(action);
      }
      for (const [action, remaining] of actionCooldowns) {
        if (remaining <= 1) actionCooldowns.delete(action);
        else actionCooldowns.set(action, remaining - 1);
      }
      const inferRequest: LocalInferenceRequest = {
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId,
        messages: toMessages(promptText),
        maxOutputTokens: promptBudget.maxOutputTokens,
        // The protocol should choose the best next action, not sample a
        // different workflow on each retry. Schema gates below provide the
        // exploration needed to recover from a refused action.
        temperature: 0,
        // Ornith is an action generator inside a bounded machine protocol.
        // Hidden reasoning consumes the same output budget but cannot be
        // parsed or acted upon, so require the Qwen-compatible non-thinking
        // template path for every turn.
        chatTemplateParameters: { enable_thinking: false },
        responseFormat: {
          type: 'json_schema',
          name: excludedActions.size === 0
            ? 'ornith_action_v1'
            : 'ornith_action_v1_recovery',
          schema: excludedActions.size === 0
            ? ORNITH_ACTION_JSON_SCHEMA
            : responseSchemaWithoutActions([...excludedActions])
        }
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
        malformedRetries += 1;
        if (parsed.attemptedAction !== undefined) {
          actionCooldowns.set(
            parsed.attemptedAction,
            Math.max(actionCooldowns.get(parsed.attemptedAction) ?? 0, 4)
          );
        }
        if (malformedRetries <= ORNITH_LIMITS.maxMalformedRetries) {
          rolling.push({
            turn: turnsUsed,
            action: 'protocol_error',
            resultText: boundedJson({
              ok: false,
              code: parsed.code,
              reason: parsed.reason,
              instruction: 'Return exactly one complete action matching the supplied JSON schema. No action was executed.'
            }, promptBudget.maxToolResultBytes)
          });
          request.onProgress({
            type: 'progress',
            text: `Ornith protocol output was rejected; retry ${malformedRetries} of ${ORNITH_LIMITS.maxMalformedRetries}.`
          });
          continue;
        }
        return finish(
          'fail',
          `Ornith returned output that could not be accepted: ${parsed.reason}`,
          'configuration',
          [parsed.code]
        );
      }
      malformedRetries = 0;
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
        if (request.runType === 'correction' && tools.changedFileCount() === 0) {
          actionCooldowns.set('finish', Math.max(actionCooldowns.get('finish') ?? 0, 4));
          rolling.push({
            turn: turnsUsed,
            action: 'finish',
            resultText: boundedJson({
              ok: false,
              code: 'verification_not_ready',
              reason: 'A correction cannot finish before this run makes at least one repository mutation.',
              instruction: 'Apply the requested correction with create_file, replace_text, or delete_file before finishing.'
            }, promptBudget.maxToolResultBytes)
          });
          request.onProgress({
            type: 'tool_use',
            text: 'Ornith finish denied because the correction made no changes.',
            data: {
              sequence: nonterminalActionsUsed + 1,
              action: 'finish',
              ok: false,
              code: 'verification_not_ready',
              providerId: request.lease.providerId,
              modelId: request.lease.modelId,
              runtimeInstanceId: request.lease.runtimeInstanceId
            }
          });
          continue;
        }
        if (finishSummaryReportsBlockage(action.summary)) {
          request.onProgress({
            type: 'tool_use',
            text: 'Ornith used finish for a blocked outcome; Agent Relay rejected it.',
            data: {
              sequence: nonterminalActionsUsed + 1,
              action: 'finish',
              ok: false,
              code: 'blocked',
              providerId: request.lease.providerId,
              modelId: request.lease.modelId,
              runtimeInstanceId: request.lease.runtimeInstanceId
            }
          });
          return finish('fail', 'Ornith reported that it could not continue.', 'configuration', ['blocked']);
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

      const changedPath = 'path' in action && (action.action === 'create_file' || action.action === 'replace_text' || action.action === 'delete_file')
        ? action.path : null;
      const readOnlyActionKey = reusableReadOnlyActionKey(action);
      if (changedPath !== null && tools.wouldExceedChangedFileLimit(changedPath)) {
        return finish(
          'fail',
          'The Ornith implementation loop exceeded the changed-file limit.',
          'configuration',
          ['limit_changed_files_exceeded']
        );
      }

      let toolResult: OrnithToolResult;
      const operationStarted = Date.now();
      if (action.action === 'run_verification') {
        if (!verificationReady || tools.changedFileCount() === 0) {
          toolResult = {
            ok: false,
            code: 'verification_not_ready',
            reason:
              'Verification is available only after a repository mutation has produced a changed file, ' +
              'and only once per resulting snapshot. Make the required edit first.'
          };
        } else if (verificationsUsed >= ORNITH_LIMITS.maxVerificationCalls) {
          return finish('fail', 'The verification-call budget for this run is exhausted.', 'configuration', ['limit_verification_calls_exceeded']);
        } else {
          verificationsUsed += 1;
          verificationReady = false;
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
            verificationPassedForCurrentSnapshot = result.passed;
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
        const requestedReadPath = action.action === 'read_file' ? action.path : null;
        let effectiveAction: Exclude<OrnithAction, { action: 'finish' } | { action: 'blocked' } | { action: 'run_verification' }> | null = action;
        let duplicateReason: string | null = null;
        if (readOnlyActionKey !== null && successfulReadOnlyActions.has(readOnlyActionKey)) {
          effectiveAction = null;
          duplicateReason =
            'That read-only action already succeeded and no write has changed its result. ' +
            'Use its PRIOR TOOL RESULT and choose a different action.';
        } else if (action.action === 'read_file') {
          effectiveAction = nextUnreadAction(action, readCoverage.get(action.path));
        }
        if (effectiveAction === null) {
          toolResult = {
            ok: false,
            code: 'duplicate_action',
            reason: duplicateReason ??
              `That byte range of "${requestedReadPath ?? 'the requested file'}" was already returned and remains available in PRIOR TOOL RESULTS. ` +
              'Use an unread range, search a named file, make the edit, or finish.'
          };
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
            toolResult = await this.dispatchToolAction(tools, effectiveAction, operationSignal.signal, {
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
      }

      const durationMs = Date.now() - operationStarted;
      if (!toolResult.ok) {
        nonMutatingActionsSinceWrite += 1;
        outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code });
        request.onProgress({
          type: 'tool_use',
          text: `Ornith action ${action.action} denied (${toolResult.code}).`,
          data: { sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code, durationMs }
        });
        if (RECOVERABLE_TOOL_CODES.has(toolResult.code)) {
          if (COOLDOWN_TOOL_CODES.has(toolResult.code)) {
            actionCooldowns.set(action.action, Math.max(actionCooldowns.get(action.action) ?? 0, 4));
          }
          const knownSha = 'path' in action ? knownFileHashes.get(action.path) : undefined;
          const recoveryReason = toolResult.code === 'stale_hash' && knownSha !== undefined
            ? `${toolResult.reason} Use the exact current SHA-256 ${knownSha}.`
            : toolResult.reason;
          const recoveryInstruction = toolResult.code === 'stale_hash'
            ? 'Retry the intended replace_text or delete_file with the exact current SHA-256. Do not delete and recreate an existing file to repair an edit.'
            : toolResult.code === 'replacement_mismatch'
              ? 'Read or search for a small exact current fragment, then retry replace_text with that unique oldText. Do not delete and recreate the file.'
              : toolResult.code === 'file_exists'
                ? 'The file already exists. Edit it with replace_text using its current SHA-256; do not delete and recreate it.'
                : 'Correct the next action and do not repeat this request unchanged.';
          rolling.push({
            turn: turnsUsed,
            action: action.action,
            resultText: boundedJson({
              ok: false,
              code: toolResult.code,
              reason: recoveryReason,
              instruction: recoveryInstruction
            }, promptBudget.maxToolResultBytes)
          });
          continue;
        }
        return finish('fail', 'Agent Relay refused an unsafe or over-limit Ornith action.', 'security', [toolResult.code]);
      }

      if (cumulativeReadBytes + toolResult.readBytes > ORNITH_LIMITS.maxCumulativeReadBytes) {
        return finish('fail', 'The Ornith repository read budget was exceeded.', 'configuration', ['limit_read_bytes_exceeded']);
      }
      if (cumulativeWriteBytes + toolResult.writeBytes > ORNITH_LIMITS.maxCumulativeWriteBytes) {
        return finish('fail', 'The Ornith repository write budget was exceeded.', 'configuration', ['limit_write_bytes_exceeded']);
      }
      cumulativeReadBytes += toolResult.readBytes;
      cumulativeWriteBytes += toolResult.writeBytes;
      if (action.action === 'read_file') addReadCoverage(readCoverage, toolResult.forModel);
      addKnownFileHashes(knownFileHashes, toolResult.forModel);
      if (readOnlyActionKey !== null) successfulReadOnlyActions.add(readOnlyActionKey);
      if ('path' in action && (
        action.action === 'create_file' || action.action === 'replace_text' || action.action === 'delete_file'
      )) {
        readCoverage.delete(action.path);
        knownFileHashes.delete(action.path);
        successfulReadOnlyActions.clear();
      }
      if (
        action.action === 'create_file' ||
        action.action === 'replace_text' ||
        action.action === 'delete_file'
      ) {
        verificationReady = tools.changedFileCount() > 0;
        verificationPassedForCurrentSnapshot = false;
        nonMutatingActionsSinceWrite = 0;
        if (verificationReady) actionCooldowns.delete('run_verification');
      } else {
        nonMutatingActionsSinceWrite += 1;
      }
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

      const resultText = boundedJson(toolResult.forModel, promptBudget.maxToolResultBytes);
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
        return tools.listFiles(action, signal);
      case 'read_file':
        return tools.readFile(
          { ...action, limit: Math.min(action.limit, Math.max(1, maxToolResultBytes - 512)) },
          signal,
          budget
        );
      case 'search_text':
        return tools.searchText(action, signal, budget);
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
