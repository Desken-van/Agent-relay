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
      implementationPrompt: safe(request.specification.implementationPrompt)
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
- You have no git commit, push, merge, checkout, reset, or remote access of any kind —
  do not ask for one, it does not exist.
- Call "run_verification" only when you believe the work is complete; Agent Relay itself
  re-verifies afterward regardless.
- Use a narrow prefix or a small page when listing files. If a tool result says it was
  truncated, retry with a smaller limit or a more specific prefix.
- Never repeat an identical list_files, read_file, search_text, git_status, or git_diff action after it succeeds.
  Use the returned files, cursor, or status to choose a different next action.
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
    const promptInput = normalizeOrnithPromptInput(
      request,
      [request.worktreePath, request.repositoryPath]
    );
    const rolling: RollingResult[] = [];
    let turnsUsed = 0;
    let nonterminalActionsUsed = 0;
    let verificationsUsed = 0;
    let cumulativeReadBytes = 0;
    let cumulativeWriteBytes = 0;
    let previousReadOnlyFingerprint: string | null = null;
    let consecutiveIdenticalReadOnlyActions = 0;
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
        const duplicateFeedback = {
          ok: false,
          code: 'duplicate_no_progress',
          reason:
            `The identical ${action.action} request already succeeded and was not executed again. ` +
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
      const operationStarted = Date.now();
      if (action.action === 'run_verification') {
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
      if (!toolResult.ok) {
        outcomes.push({ sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code });
        request.onProgress({
          type: 'tool_use',
          text: `Ornith action ${action.action} denied (${toolResult.code}).`,
          data: { sequence: nonterminalActionsUsed, action: action.action, ok: false, code: toolResult.code, durationMs }
        });
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

function isNoProgressGuardAction(action: OrnithAction): boolean {
  return action.action === 'list_files' ||
    action.action === 'read_file' ||
    action.action === 'search_text' ||
    action.action === 'git_status' ||
    action.action === 'git_diff';
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
