/**
 * The persisted, shareable form of a Claude round's verdict.
 *
 * The policy that produces a verdict lives in `main/services` because it is
 * defined over the evidence contract in `ports.ts`, which the renderer must not
 * see. This module is the narrow thing that crosses that line: a small,
 * versioned, already-redacted record that is written into `runs.structured_result`
 * and read back by the timeline and the publish gate.
 *
 * Three properties it has to keep:
 *
 * - **Versioned.** A record written by an older build has to be readable, and a
 *   record from a *newer* one has to be recognisably unreadable rather than
 *   silently misinterpreted. `version` is checked, not assumed.
 * - **Bounded and redacted.** Everything here is persisted and rendered, so it
 *   carries commands and reasons that have already been through redaction and
 *   truncation, and never raw tool output.
 * - **Safe to parse.** {@link readClaudeAssessment} never throws. A run from
 *   before this existed, a hand-edited row, a future version — each comes back
 *   as a describable absence, because a crash while opening an old task would
 *   be a worse failure than the one it is reporting.
 */

import { z } from 'zod';
import type { TaskStatus } from './workflow';

/** Bumped only when a change would make an older reader wrong. */
export const CLAUDE_ASSESSMENT_VERSION = 1;

export const CLAUDE_ROUND_DISPOSITIONS = ['pass', 'warn', 'fail'] as const;
export const CLAUDE_VERIFICATION_STATUSES = ['passed', 'failed', 'not_run', 'unknown'] as const;
export const CLAUDE_PUBLISH_BLOCKS = [
  'none',
  'verification',
  'security',
  'telemetry',
  'configuration'
] as const;
export const CLAUDE_DENIAL_CATEGORIES = [
  'security',
  'verification',
  'auxiliary',
  'unknown'
] as const;

export type ClaudeRoundDisposition = (typeof CLAUDE_ROUND_DISPOSITIONS)[number];
export type ClaudeVerificationStatus = (typeof CLAUDE_VERIFICATION_STATUSES)[number];
export type ClaudePublishBlock = (typeof CLAUDE_PUBLISH_BLOCKS)[number];
export type ClaudeDenialCategory = (typeof CLAUDE_DENIAL_CATEGORIES)[number];

/** Longest command or reason kept in a persisted record. */
export const ASSESSMENT_TEXT_LIMIT = 500;

/** Upper bound on how many denials one record describes. */
export const ASSESSMENT_DENIAL_LIMIT = 50;

const boundedText = z.string().max(ASSESSMENT_TEXT_LIMIT);

export const claudeVerificationRecordSchema = z.object({
  tool: z.string().max(100),
  command: boundedText,
  /** Canonical text of the rule that matched, e.g. `Bash(npm test *)`. */
  matchedRule: boundedText,
  toolUseSequence: z.number().int().min(1)
});

export const claudeDenialRecordSchema = z.object({
  category: z.enum(CLAUDE_DENIAL_CATEGORIES),
  tool: z.string().max(100),
  /** Null when the CLI never said which command was refused. */
  command: boundedText.nullable(),
  commandTruncated: z.boolean(),
  reason: boundedText,
  /** True only for a verification denial a later matching attempt re-ran. */
  resolved: z.boolean()
});

export const claudeRoundAssessmentRecordSchema = z.object({
  version: z.literal(CLAUDE_ASSESSMENT_VERSION),
  disposition: z.enum(CLAUDE_ROUND_DISPOSITIONS),
  verificationStatus: z.enum(CLAUDE_VERIFICATION_STATUSES),
  publishBlock: z.enum(CLAUDE_PUBLISH_BLOCKS),
  reasonCodes: z.array(z.string().max(80)).max(40),
  /** The attempt the status came from, or null when there was none. */
  verification: claudeVerificationRecordSchema.nullable(),
  denials: z.array(claudeDenialRecordSchema).max(ASSESSMENT_DENIAL_LIMIT)
});

export type ClaudeVerificationRecord = z.infer<typeof claudeVerificationRecordSchema>;
export type ClaudeDenialRecord = z.infer<typeof claudeDenialRecordSchema>;
export type ClaudeRoundAssessmentRecord = z.infer<typeof claudeRoundAssessmentRecordSchema>;

/** Why a run has no usable verdict. */
export type AssessmentAbsence =
  /** The run predates this feature, or was not a Claude implementation round. */
  | 'absent'
  /** Present but unreadable: hand-edited, truncated, or written by a bug. */
  | 'malformed'
  /** Written by a newer build than this one. */
  | 'unsupported_version';

/**
 * Every reason publishing can be refused on evidence grounds.
 *
 * The block kinds and the ways a record can be missing, in one type, so a
 * caller has to handle all of them and cannot fall through to "allowed".
 */
export type PublishRefusalCode = ClaudePublishBlock | AssessmentAbsence;

export type AssessmentReadResult =
  | { readonly ok: true; readonly assessment: ClaudeRoundAssessmentRecord }
  | { readonly ok: false; readonly absence: AssessmentAbsence };

const versionProbe = z.object({ version: z.number() });

/**
 * Read the verdict out of a run's `structured_result`, without ever throwing.
 *
 * Accepts either the whole `structured_result` object or the assessment on its
 * own, so a caller does not have to know how the orchestrator nests it.
 */
export function readClaudeAssessment(structuredResult: string | null): AssessmentReadResult {
  if (structuredResult === null || structuredResult.trim().length === 0) {
    return { ok: false, absence: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(structuredResult);
  } catch {
    return { ok: false, absence: 'malformed' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, absence: 'malformed' };
  }

  const container = parsed as Record<string, unknown>;
  const nested = 'assessment' in container;
  const candidate = nested ? container['assessment'] : container;

  // A run from before assessments existed simply has no key. That is not a
  // failure to report as corruption — it is an older run, and the publish gate
  // has its own, gentler message for it. The same goes for a structured result
  // that is plainly something else entirely, such as the `{numTurns, sessionId}`
  // an earlier build wrote: nothing is missing from it, it is just not this.
  if (candidate === undefined || candidate === null) {
    return { ok: false, absence: 'absent' };
  }
  if (
    !nested &&
    (typeof candidate !== 'object' || candidate === null || !('version' in candidate))
  ) {
    return { ok: false, absence: 'absent' };
  }

  // Check the version before the shape: a record from a newer build is not
  // malformed, it is one this build must decline to interpret.
  const probe = versionProbe.safeParse(candidate);
  if (probe.success && probe.data.version !== CLAUDE_ASSESSMENT_VERSION) {
    return { ok: false, absence: 'unsupported_version' };
  }

  const record = claudeRoundAssessmentRecordSchema.safeParse(candidate);
  if (!record.success) return { ok: false, absence: 'malformed' };

  return { ok: true, assessment: record.data };
}

/**
 * Whether this verdict permits publishing, and why not when it does not.
 *
 * Fail-closed by construction: every path that is not a readable, unblocked,
 * version-1 record returns a refusal. Absence is a refusal too — a round that
 * predates assessments proved nothing about itself.
 */
export function assessmentPublishRefusal(
  result: AssessmentReadResult
): { readonly blocked: false } | { readonly blocked: true; readonly code: PublishRefusalCode } {
  if (!result.ok) return { blocked: true, code: result.absence };
  if (result.assessment.publishBlock !== 'none') {
    return { blocked: true, code: result.assessment.publishBlock };
  }
  return { blocked: false };
}

/* -------------------------------------------------------------------------- */
/* What the "another round" button should offer                                */
/* -------------------------------------------------------------------------- */

/**
 * The two reasons a task needs another Claude round.
 *
 * They are different situations and deserve different words. After a review
 * asked for changes, there are findings to act on. After the publish gate
 * refused an approved round, there are none — the reviewer was satisfied and it
 * was the evidence that fell short — so calling that "send corrections" would
 * describe work nobody asked for.
 */
export type CorrectionActionKind = 'corrections' | 'retry_verification' | 'unavailable';

export interface CorrectionAction {
  readonly kind: CorrectionActionKind;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, for a tooltip. Null when it is enabled or hidden. */
  readonly disabledReason: string | null;
}

export interface CorrectionActionInput {
  /** Null while no task is selected, which offers nothing. */
  readonly status: TaskStatus | null;
  readonly currentRound: number;
  readonly maxRounds: number;
  /**
   * `structured_result` of the most recent Claude round, or null when there is
   * none. Only consulted for a task waiting to publish.
   *
   * Use {@link latestClaudeRoundResult} to obtain it, so the renderer, the
   * orchestrator and the publish gate all read the same round.
   */
  readonly latestClaudeStructuredResult: string | null;
}

/** The shape of a run, as much of it as choosing the latest round needs. */
export interface ClaudeRoundRun {
  readonly agent: string;
  readonly runType: string;
  readonly structuredResult: string | null;
}

/**
 * The `structured_result` of the most recent Claude implementation or
 * correction round, or null when the task has had none.
 *
 * One selector for all three callers. "Most recent" means last in the run
 * order, not "the newest correction, else the implementation" — with a recovery
 * round able to follow an approval, picking by type would eventually name the
 * wrong round, and three callers picking differently would disagree about
 * whether a task may publish.
 *
 * Expects `runs` in the order the repository returns them: oldest first.
 */
export function latestClaudeRoundResult(runs: readonly ClaudeRoundRun[]): string | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run === undefined) continue;
    if (run.agent !== 'claude') continue;
    if (run.runType !== 'implementation' && run.runType !== 'correction') continue;
    return run.structuredResult;
  }
  return null;
}

const ROUND_BUDGET_SPENT = 'The review round budget for this task is exhausted.';

/**
 * Decide what the button does, if anything.
 *
 * Pure, and separate from the component, because "may the user start another
 * round" is a rule the orchestrator also enforces — and the two must agree. A
 * button that is enabled where the backend refuses is a confusing error; one
 * that is disabled where the backend would allow is a dead end, which is the
 * bug this function exists to fix.
 */
export function correctionAction(input: CorrectionActionInput): CorrectionAction {
  const budgetSpent = input.currentRound >= input.maxRounds;

  if (input.status === 'CHANGES_REQUESTED') {
    return {
      kind: 'corrections',
      label: 'Send corrections',
      enabled: !budgetSpent,
      disabledReason: budgetSpent ? ROUND_BUDGET_SPENT : null
    };
  }

  if (input.status === 'READY_TO_PUBLISH') {
    // Only when something is actually standing in the way. A round that is
    // clear to publish needs no retry, and offering one would invite a pointless
    // extra round on work that is finished.
    const refusal = assessmentPublishRefusal(
      readClaudeAssessment(input.latestClaudeStructuredResult)
    );
    if (!refusal.blocked) {
      return { kind: 'unavailable', label: 'Send corrections', enabled: false, disabledReason: null };
    }

    return {
      kind: 'retry_verification',
      label: 'Retry verification',
      enabled: !budgetSpent,
      disabledReason: budgetSpent ? ROUND_BUDGET_SPENT : null
    };
  }

  return { kind: 'unavailable', label: 'Send corrections', enabled: false, disabledReason: null };
}
