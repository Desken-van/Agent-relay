/**
 * What a Claude round's evidence actually proves.
 *
 * A pure function from telemetry to a verdict. It reads nothing, writes
 * nothing, and — in this phase — decides nothing: the orchestrator does not
 * call it yet, so a round still succeeds or fails exactly as it did before.
 * Wiring it up is a separate, deliberate step.
 *
 * The problem it exists to solve: in `--print` mode a refused tool call is
 * silent. Claude works around it, the CLI exits 0, and the result envelope says
 * "success". A round in which the tests were blocked is indistinguishable from
 * a clean one unless something reconstructs what was actually attempted.
 *
 * It lives in `services` rather than `shared` because it is defined over the
 * evidence contract in `ports.ts`, and a module in `shared` importing from
 * `main` would invert the dependency direction the architecture depends on. The
 * matching it needs — rule grammar, command normalisation, the deny list — is
 * pure and shared, and is imported from `shared/domain/claude-tool-rules` so
 * the Claude adapter and this policy read the same security rules. If the
 * renderer ever needs a verdict, the right move is to lift the evidence
 * contract into `shared/domain` first, not to copy this.
 *
 * The governing bias: every question this cannot answer is answered "no". An
 * unreadable command, a contradicted result, a call with no reply — each one
 * fails the round rather than being rounded towards the tidy case.
 */

import {
  analyseCommand,
  commandTouchesDestructiveOperation,
  findMatchingRule,
  resolveVerificationConfig,
  toolMatchesRule,
  type CommandAnalysis,
  type ShellToolRule,
  type VerificationConfigProblem
} from '../../shared/domain/claude-tool-rules';
import type {
  ClaudePermissionDenial,
  ClaudeStreamEvidence,
  ClaudeToolExecution
} from '../ports';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type DenialCategory =
  /** Named an operation on the canonical deny list. */
  | 'security'
  /** Named a command the verification rules describe. */
  | 'verification'
  /** A readable, ordinary command that proves nothing and threatens nothing. */
  | 'auxiliary'
  /** Not classifiable from the evidence. Never treated as harmless. */
  | 'unknown';

export type VerificationStatus =
  /** The last verification attempt finished and reported success. */
  | 'passed'
  /** The last verification attempt finished and reported failure. */
  | 'failed'
  /** Nothing matching a verification rule was attempted. */
  | 'not_run'
  /** Something was attempted, but the evidence cannot say how it ended. */
  | 'unknown';

export type RoundDisposition = 'pass' | 'warn' | 'fail';

export type PublishBlock =
  | 'none'
  | 'verification'
  | 'security'
  | 'telemetry'
  | 'configuration';

/**
 * Machine-readable grounds for the verdict.
 *
 * Codes, not sentences: the reason a round failed is data the next phase will
 * branch on, and prose is a poor thing to branch on.
 */
export type RoundReasonCode =
  | 'configuration_invalid'
  | 'envelope_missing'
  | 'envelope_error'
  | 'envelope_conflict'
  | 'cli_error'
  | 'stream_malformed'
  | 'telemetry_conflict'
  | 'security_denial'
  | 'unknown_denial'
  | 'verification_denial_unresolved'
  | 'verification_denial_resolved'
  | 'auxiliary_denial'
  | 'verification_not_run'
  | 'verification_unknown'
  | 'verification_failed'
  | 'verification_passed'
  | 'telemetry_incomplete';

export interface ClassifiedDenial {
  readonly denial: ClaudePermissionDenial;
  readonly category: DenialCategory;
  /** The verification rule this denial named, when it named one. */
  readonly rule: ShellToolRule | null;
  /**
   * Invocation number of the later attempt that re-ran what this denial blocked,
   * or null. Only ever set for a `verification` denial.
   */
  readonly resolvedBySequence: number | null;
}

export interface VerificationAttempt {
  readonly execution: ClaudeToolExecution;
  readonly rule: ShellToolRule;
  readonly sequence: number;
}

export interface RoundAssessment {
  readonly disposition: RoundDisposition;
  readonly verificationStatus: VerificationStatus;
  /** Invocation number of the attempt the status came from, or null. */
  readonly verificationSequence: number | null;
  /**
   * The attempt the status came from, or null when none matched.
   *
   * Carried so a caller can name the command that was actually run without
   * re-deriving the match and risking a different answer.
   */
  readonly verificationAttempt: VerificationAttempt | null;
  readonly classifiedDenials: readonly ClassifiedDenial[];
  readonly resolvedVerificationDenials: readonly ClassifiedDenial[];
  /** Denials that still stand: everything except a resolved verification denial. */
  readonly unresolvedDenials: readonly ClassifiedDenial[];
  readonly reasonCodes: readonly RoundReasonCode[];
  readonly publishBlock: PublishBlock;
  /** Empty when the configuration was usable. */
  readonly configurationProblems: readonly VerificationConfigProblem[];
}

export interface VerificationPolicyConfig {
  /** Permission rules the run was granted, exactly as the CLI received them. */
  readonly allowedTools: readonly string[];
  /** Rules whose successful execution counts as having checked the work. */
  readonly verificationTools: readonly string[];
}

/**
 * The evidence one round produced.
 *
 * Structural, so a `ClaudeImplementationResult` satisfies it as-is and the
 * orchestrator will not need an adapter layer in the next phase.
 */
export interface ClaudeRoundEvidence {
  readonly evidence: ClaudeStreamEvidence;
  readonly permissionDenials: readonly ClaudePermissionDenial[];
  /**
   * The CLI reported a failure — an `error` event, or an envelope saying so.
   *
   * Read, not merely recorded. The CLI can raise an error event and still close
   * with `is_error: false`, and a round that hits both cannot be called a
   * success on the strength of the half that was cheerful.
   */
  readonly isError: boolean;
}

/* -------------------------------------------------------------------------- */
/* Evidence helpers                                                            */
/* -------------------------------------------------------------------------- */

/** True when this entry records a call Claude actually made. */
function isRealInvocation(execution: ClaudeToolExecution): execution is ClaudeToolExecution & {
  toolUseSequence: number;
} {
  return execution.toolUseSeen && execution.toolUseSequence !== null;
}

/** True when the entry finished and said, unambiguously, how it went. */
function hasDefinitiveOutcome(execution: ClaudeToolExecution): boolean {
  return (
    execution.resultReceived && !execution.resultConflict && typeof execution.isError === 'boolean'
  );
}

/** The command as the matchers want it, or null when it cannot be read. */
function readableCommand(execution: ClaudeToolExecution): CommandAnalysis | null {
  if (execution.command === null) return null;
  // A preview is not a command. Matching the visible half would decide a
  // security question on the half that was cut off.
  if (execution.commandTruncated) return null;
  return analyseCommand(execution.command);
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/** Every real invocation that a verification rule describes, in invocation order. */
function collectVerificationAttempts(
  evidence: ClaudeStreamEvidence,
  rules: readonly ShellToolRule[]
): VerificationAttempt[] {
  const attempts: VerificationAttempt[] = [];

  for (const execution of evidence.toolExecutions) {
    if (!isRealInvocation(execution)) continue;

    const analysis = readableCommand(execution);
    if (analysis === null) continue;

    const rule = findMatchingRule(rules, execution.tool, analysis);
    if (rule === null) continue;

    attempts.push({ execution, rule, sequence: execution.toolUseSequence });
  }

  return attempts.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Real invocations whose verification-membership cannot be decided.
 *
 * A shell call with a truncated or missing command might have been the test run
 * — there is no way to tell. If one of those happened *after* the attempt we
 * would otherwise call authoritative, then the attempt we can see is not
 * necessarily the last one, and the honest status is "unknown".
 */
function ambiguousShellSequences(
  evidence: ClaudeStreamEvidence,
  rules: readonly ShellToolRule[]
): number[] {
  const sequences: number[] = [];

  for (const execution of evidence.toolExecutions) {
    if (!isRealInvocation(execution)) continue;
    if (readableCommand(execution) !== null) continue;
    // Only a tool a verification rule could name is worth worrying about; a
    // truncated `Read` says nothing about whether the tests ran.
    if (!rules.some((rule) => toolMatchesRule(rule, execution.tool))) continue;

    sequences.push(execution.toolUseSequence);
  }

  return sequences;
}

interface VerificationOutcome {
  readonly status: VerificationStatus;
  readonly sequence: number | null;
  readonly latest: VerificationAttempt | null;
  readonly attempts: readonly VerificationAttempt[];
}

/**
 * The authoritative verification attempt, and what it proved.
 *
 * Authoritative means highest invocation number, not last in the array and not
 * last to report: results arrive out of order, so both of those would answer a
 * different question.
 */
function assessVerification(
  evidence: ClaudeStreamEvidence,
  rules: readonly ShellToolRule[]
): VerificationOutcome {
  const attempts = collectVerificationAttempts(evidence, rules);
  const latest = attempts[attempts.length - 1] ?? null;
  const ambiguous = ambiguousShellSequences(evidence, rules);

  // An unreadable shell call after the last thing we could identify means the
  // run may have verified again, and we would be reporting a stale answer.
  const ambiguityAfterLatest = ambiguous.some(
    (sequence) => latest === null || sequence > latest.sequence
  );

  if (latest === null) {
    return {
      status: ambiguityAfterLatest ? 'unknown' : 'not_run',
      sequence: null,
      latest: null,
      attempts
    };
  }

  if (ambiguityAfterLatest || !hasDefinitiveOutcome(latest.execution)) {
    return { status: 'unknown', sequence: latest.sequence, latest, attempts };
  }

  return {
    status: latest.execution.isError === true ? 'failed' : 'passed',
    sequence: latest.sequence,
    latest,
    attempts
  };
}

/* -------------------------------------------------------------------------- */
/* Denials                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Decide what a denial was, from the command alone.
 *
 * The order matters and is fixed:
 *
 *  1. no command, or only a truncated preview → unknown;
 *  2. no link to an invocation → unknown, since nothing can be placed in time;
 *  3. a tool no verification rule could ever name → unknown;
 *  4. names a denied operation → security;
 *  5. compound → security if any segment is denied, otherwise unknown;
 *  6. matches a verification rule → verification;
 *  7. anything else readable → auxiliary.
 *
 * The denial's `reason` text is never consulted. It is written for a human, it
 * changes between CLI versions, and reading a security decision out of prose is
 * how a wording change silently reclassifies a blocked push.
 */
function classifyDenial(
  denial: ClaudePermissionDenial,
  rules: readonly ShellToolRule[]
): ClassifiedDenial {
  const base = { denial, rule: null, resolvedBySequence: null } as const;

  if (denial.command === null || denial.commandTruncated) {
    return { ...base, category: 'unknown' };
  }
  if (denial.toolUseSequence === null) {
    return { ...base, category: 'unknown' };
  }
  if (!rules.some((rule) => toolMatchesRule(rule, denial.tool))) {
    return { ...base, category: 'unknown' };
  }

  const analysis = analyseCommand(denial.command);
  if (analysis.segments.length === 0) {
    return { ...base, category: 'unknown' };
  }

  if (commandTouchesDestructiveOperation(analysis)) {
    return { ...base, category: 'security' };
  }

  if (analysis.compound) {
    // Nothing forbidden is visible, but a chained command is not something this
    // matcher can take apart safely enough to call harmless.
    return { ...base, category: 'unknown' };
  }

  const rule = findMatchingRule(rules, denial.tool, analysis);
  if (rule !== null) return { ...base, category: 'verification', rule };

  return { ...base, category: 'auxiliary' };
}

/**
 * The later attempt that re-ran what a denial blocked, or null.
 *
 * A higher invocation number is necessary and nowhere near sufficient. The
 * retry has to be the same tool running the same verification rule, and it has
 * to have finished and said how it went — otherwise "it was retried" is a claim
 * about a call we cannot read.
 *
 * A *failed* retry still resolves the denial. It proves the check ran; whether
 * it passed is the separate question {@link assessVerification} answers.
 */
function findResolvingAttempt(
  classified: ClassifiedDenial,
  attempts: readonly VerificationAttempt[]
): VerificationAttempt | null {
  const { denial, rule } = classified;
  const deniedAt = denial.toolUseSequence;
  if (rule === null || deniedAt === null) return null;

  const candidates = attempts.filter(
    (attempt) =>
      attempt.sequence > deniedAt &&
      attempt.rule.canonical === rule.canonical &&
      toolMatchesRule(attempt.rule, denial.tool) &&
      !attempt.execution.commandTruncated &&
      hasDefinitiveOutcome(attempt.execution)
  );

  return candidates[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Assessment                                                                  */
/* -------------------------------------------------------------------------- */

/** Most restrictive wins, so a security block is never softened by anything else. */
const BLOCK_PRECEDENCE: readonly PublishBlock[] = [
  'configuration',
  'security',
  'telemetry',
  'verification',
  'none'
];

function strongestBlock(blocks: readonly PublishBlock[]): PublishBlock {
  return BLOCK_PRECEDENCE.find((candidate) => blocks.includes(candidate)) ?? 'none';
}

function configurationFailure(problems: readonly VerificationConfigProblem[]): RoundAssessment {
  return {
    disposition: 'fail',
    verificationStatus: 'unknown',
    verificationSequence: null,
    verificationAttempt: null,
    classifiedDenials: [],
    resolvedVerificationDenials: [],
    unresolvedDenials: [],
    reasonCodes: ['configuration_invalid'],
    publishBlock: 'configuration',
    configurationProblems: problems
  };
}

/**
 * Judge one round.
 *
 * Pure: same evidence and configuration, same verdict, every time. Nothing here
 * is wired to a run status, a task transition, a timeline event or the UI.
 */
export function assessClaudeRound(
  round: ClaudeRoundEvidence,
  config: VerificationPolicyConfig
): RoundAssessment {
  const configured = resolveVerificationConfig(config.allowedTools, config.verificationTools);
  if (!configured.ok) return configurationFailure(configured.problems);

  const { evidence, permissionDenials } = round;
  const rules = configured.rules;

  const verification = assessVerification(evidence, rules);

  const classifiedDenials = permissionDenials.map((denial) => {
    const classified = classifyDenial(denial, rules);
    if (classified.category !== 'verification') return classified;

    const resolving = findResolvingAttempt(classified, verification.attempts);
    return resolving === null
      ? classified
      : { ...classified, resolvedBySequence: resolving.sequence };
  });

  const resolvedVerificationDenials = classifiedDenials.filter(
    (entry) => entry.category === 'verification' && entry.resolvedBySequence !== null
  );
  const unresolvedDenials = classifiedDenials.filter(
    (entry) => !(entry.category === 'verification' && entry.resolvedBySequence !== null)
  );

  const reasonCodes: RoundReasonCode[] = [];
  const blocks: PublishBlock[] = [];
  let hardFail = false;

  /* --- the stream itself ------------------------------------------------- */

  if (!evidence.resultEnvelopeSeen) {
    reasonCodes.push('envelope_missing');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (evidence.resultEnvelopeConflict) {
    reasonCodes.push('envelope_conflict');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (evidence.resultEnvelopeIsError === true) {
    // Blocked as telemetry rather than as a verification problem: the CLI told
    // us the round did not finish cleanly, so nothing else it reported about
    // what ran is worth acting on.
    reasonCodes.push('envelope_error');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (round.isError) {
    // The CLI raised an error. When the envelope disagreed — an error event
    // followed by `is_error: false` — the two halves of the stream contradict
    // each other, which is its own reason to distrust the whole record rather
    // than to believe the more convenient half.
    reasonCodes.push('cli_error');
    if (evidence.resultEnvelopeIsError === false) reasonCodes.push('telemetry_conflict');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (evidence.malformedLineCount > 0) {
    reasonCodes.push('stream_malformed');
    blocks.push('telemetry');
    hardFail = true;
  }

  /* --- denials ------------------------------------------------------------ */

  const hasCategory = (category: DenialCategory) =>
    unresolvedDenials.some((entry) => entry.category === category);

  if (hasCategory('security')) {
    reasonCodes.push('security_denial');
    blocks.push('security');
    hardFail = true;
  }
  if (hasCategory('unknown')) {
    reasonCodes.push('unknown_denial');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (hasCategory('verification')) {
    reasonCodes.push('verification_denial_unresolved');
    blocks.push('verification');
    hardFail = true;
  }
  if (resolvedVerificationDenials.length > 0) {
    reasonCodes.push('verification_denial_resolved');
  }
  if (hasCategory('auxiliary')) {
    reasonCodes.push('auxiliary_denial');
  }

  /* --- verification ------------------------------------------------------- */

  if (verification.status === 'not_run') {
    reasonCodes.push('verification_not_run');
    blocks.push('verification');
    hardFail = true;
  }
  if (verification.status === 'unknown') {
    reasonCodes.push('verification_unknown');
    blocks.push('telemetry');
    hardFail = true;
  }
  if (verification.status === 'failed') {
    reasonCodes.push('verification_failed');
    blocks.push('verification');
  }
  if (verification.status === 'passed') {
    reasonCodes.push('verification_passed');
  }

  /* --- leftover ambiguity ------------------------------------------------- */

  // A call with no answer, a result belonging to no call, two results that
  // disagreed. None of these say what went wrong, and that is the point: the
  // record of what this round did is incomplete, so it is not a record anything
  // should be published on. Failing here rather than warning is the difference
  // between "we noticed" and "we acted on it".
  const telemetryClean =
    evidence.incompleteToolUseCount === 0 &&
    evidence.orphanToolResultCount === 0 &&
    !evidence.toolExecutions.some((execution) => execution.resultConflict);

  if (!telemetryClean) {
    reasonCodes.push('telemetry_incomplete');
    blocks.push('telemetry');
    hardFail = true;
  }

  /* --- verdict ------------------------------------------------------------ */

  const clean =
    !hardFail &&
    telemetryClean &&
    classifiedDenials.length === 0 &&
    verification.status === 'passed';

  const disposition: RoundDisposition = hardFail ? 'fail' : clean ? 'pass' : 'warn';

  return {
    disposition,
    verificationStatus: verification.status,
    verificationSequence: verification.sequence,
    verificationAttempt: verification.latest,
    classifiedDenials,
    resolvedVerificationDenials,
    unresolvedDenials,
    reasonCodes,
    publishBlock: strongestBlock(blocks),
    configurationProblems: []
  };
}
