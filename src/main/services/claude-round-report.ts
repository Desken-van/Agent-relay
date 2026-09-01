/**
 * Turning a verdict into the two things the rest of the application needs: a
 * record to persist, and a sentence to show someone.
 *
 * Both derive from the assessment's codes, never the other way round. The text
 * is a rendering of a decision that was already made; nothing here can change
 * what the round was judged to be.
 *
 * The reason this is a separate module from the policy: the policy has no
 * business knowing about persistence formats or English, and the wording is the
 * part most likely to be revised. Keeping them apart means a copy edit cannot
 * accidentally move a decision boundary.
 */

import {
  CLAUDE_ASSESSMENT_VERSION,
  type ClaudeDenialRecord,
  type ClaudeRoundAssessmentRecord
} from '../../shared/domain/claude-assessment';
import { redactSecrets } from '../../shared/util/redact';
import type { ClaudePermissionDenial } from '../ports';
import type { ClassifiedDenial, RoundAssessment } from './claude-round-policy';

/** Matches the bound the persisted schema enforces. */
const TEXT_LIMIT = 500;

function bounded(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > TEXT_LIMIT ? `${redacted.slice(0, TEXT_LIMIT - 1)}…` : redacted;
}

function boundedOrNull(text: string | null): string | null {
  return text === null ? null : bounded(text);
}

/** Keep a record from growing without limit when a round goes badly wrong. */
const DENIAL_LIMIT = 50;

function toDenialRecord(entry: ClassifiedDenial): ClaudeDenialRecord {
  const { denial } = entry;
  return {
    category: entry.category,
    tool: bounded(denial.tool),
    command: boundedOrNull(denial.command),
    commandTruncated: denial.commandTruncated,
    reason: bounded(denial.reason),
    resolved: entry.resolvedBySequence !== null
  };
}

/**
 * Build the record that goes into `runs.structured_result`.
 *
 * Everything is redacted again on the way in. The values arriving here were
 * already redacted by the parser, and doing it twice costs nothing next to
 * writing a key into a database row that is later rendered in the UI.
 */
export function toAssessmentRecord(assessment: RoundAssessment): ClaudeRoundAssessmentRecord {
  const attempt = assessment.verificationAttempt;

  return {
    version: CLAUDE_ASSESSMENT_VERSION,
    disposition: assessment.disposition,
    verificationStatus: assessment.verificationStatus,
    publishBlock: assessment.publishBlock,
    reasonCodes: [...assessment.reasonCodes],
    verification:
      attempt === null
        ? null
        : {
            tool: bounded(attempt.execution.tool),
            command: bounded(attempt.execution.command ?? ''),
            matchedRule: bounded(attempt.rule.canonical),
            toolUseSequence: attempt.sequence
          },
    denials: assessment.classifiedDenials.slice(0, DENIAL_LIMIT).map(toDenialRecord)
  };
}

/* -------------------------------------------------------------------------- */
/* User-facing text                                                            */
/* -------------------------------------------------------------------------- */

function quoted(command: string | null): string {
  return command === null || command.length === 0 ? 'an unnamed command' : `‘${command}’`;
}

function countedDenials(denials: readonly ClassifiedDenial[]): string {
  return denials.length === 1 ? '1 command was' : `${denials.length} commands were`;
}

/**
 * What to say about a round that succeeded but is worth a second look.
 *
 * Returns null when there is nothing to say — a genuinely clean round needs no
 * warning, and manufacturing one would train people to ignore them.
 *
 * The old blanket line ("work such as running the tests may have been skipped")
 * is deliberately gone. When the evidence shows the verification ran, saying it
 * might not have is simply false, and a warning nobody believes is worse than
 * no warning at all.
 */
export function describeWarning(assessment: RoundAssessment): string | null {
  if (assessment.disposition !== 'warn') return null;

  const command = assessment.verificationAttempt?.execution.command ?? null;
  const resolved = assessment.resolvedVerificationDenials;
  const auxiliary = assessment.classifiedDenials.filter((entry) => entry.category === 'auxiliary');

  const parts: string[] = [];

  if (resolved.length > 0) {
    const outcome = assessment.verificationStatus === 'passed' ? 'passed' : 'failed';
    parts.push(
      'A verification command was initially denied, then retried as a separate allowed ' +
        `invocation. The latest result is ${outcome}.`
    );
  }

  if (assessment.verificationStatus === 'failed') {
    parts.push(
      `Verification ran but failed: ${quoted(command)}. The round can proceed to Codex review, ` +
        'but publishing remains blocked until a later implementation round passes verification.'
    );
  } else if (auxiliary.length > 0) {
    parts.push(
      `${countedDenials(auxiliary)} denied by Claude permissions. Verification completed ` +
        `successfully with ${quoted(command)}, so the round can proceed to review.`
    );
  }

  if (parts.length === 0) {
    // Reached when the only blemish was a gap in unrelated telemetry.
    parts.push(
      'Parts of this run’s telemetry were incomplete. Verification itself completed ' +
        `successfully with ${quoted(command)}, so the round can proceed to review.`
    );
  }

  return parts.join(' ');
}

/**
 * Why a round was rejected, in terms of what actually happened.
 *
 * Built from the reason codes in a fixed order of severity, so the first
 * sentence is the thing most worth fixing. Each one says what the evidence
 * showed, not what it might have shown.
 */
export function describeFailure(assessment: RoundAssessment): string {
  const codes = new Set(assessment.reasonCodes);
  const command = assessment.verificationAttempt?.execution.command ?? null;

  if (codes.has('configuration_invalid')) {
    return (
      'Claude verification settings are not usable, so the round could not be judged. ' +
      'Fix them in Settings → Claude permissions.'
    );
  }

  if (codes.has('security_denial')) {
    const denied = assessment.unresolvedDenials.find((entry) => entry.category === 'security');
    return (
      `A security-critical command was blocked: ${quoted(denied?.denial.command ?? null)}. ` +
      'Agent Relay never lets an unattended round commit, push or use gh directly — ' +
      'publishing is done through the confirmation dialog instead.'
    );
  }

  if (codes.has('unknown_denial')) {
    return (
      'A denied command could not be identified from the run’s telemetry, so it is not ' +
      'possible to tell whether anything important was blocked. The round is treated as ' +
      'unsuccessful rather than assumed harmless.'
    );
  }

  if (codes.has('verification_denial_unresolved')) {
    const denied = assessment.unresolvedDenials.find((entry) => entry.category === 'verification');
    return (
      `Verification was denied and never re-ran: ${quoted(denied?.denial.command ?? null)}. ` +
      'Add a matching rule under Settings → Claude permissions, or adjust the task so the ' +
      'checks can run.'
    );
  }

  if (codes.has('envelope_missing') || codes.has('envelope_conflict')) {
    return (
      'Claude’s output ended without a usable final result, so what the round did cannot be ' +
      'established. Nothing is assumed about whether the work was checked.'
    );
  }

  if (codes.has('telemetry_conflict')) {
    return (
      'Claude raised an error and then reported the round as successful. The two halves of ' +
      'its output contradict each other, so neither can be relied on.'
    );
  }

  if (codes.has('envelope_error') || codes.has('cli_error')) {
    return 'Claude reported that the round itself did not complete successfully.';
  }

  if (codes.has('stream_malformed')) {
    return (
      'Part of Claude’s output could not be read, so the record of what ran is incomplete ' +
      'and the round cannot be judged.'
    );
  }

  if (codes.has('verification_not_run')) {
    return (
      'No verification command ran in this round, so there is no evidence the change works. ' +
      'Check that the verification rules under Settings → Claude permissions match how this ' +
      'project runs its tests.'
    );
  }

  if (codes.has('verification_unknown')) {
    return (
      `Verification telemetry is ambiguous${command === null ? '' : ` around ${quoted(command)}`}` +
      ': the run did not report a definitive result, so it cannot be treated as verified.'
    );
  }

  if (codes.has('telemetry_incomplete')) {
    return (
      'The record of what this round did is incomplete — a tool call with no result, a result ' +
      'belonging to no call, or two results that disagreed. What ran cannot be established.'
    );
  }

  return 'The round could not be shown to have verified its work.';
}

/** Compact per-denial lines for the timeline's expandable detail. */
export function denialDetails(
  denials: readonly ClassifiedDenial[]
): readonly { tool: string; command: string | null; reason: string; category: string; resolved: boolean }[] {
  return denials.slice(0, DENIAL_LIMIT).map((entry) => {
    const denial: ClaudePermissionDenial = entry.denial;
    return {
      tool: bounded(denial.tool),
      command: boundedOrNull(denial.command),
      reason: bounded(denial.reason),
      category: entry.category,
      resolved: entry.resolvedBySequence !== null
    };
  });
}
