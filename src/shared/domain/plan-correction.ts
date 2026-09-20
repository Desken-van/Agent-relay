/**
 * The plan-correction loop's durable records and its one decision function.
 *
 * Accepting an external plan-review finding says the finding is valid. It does
 * not change the specification. The correction loop is what does: Codex revises
 * the specification from ONLY the accepted findings, the result becomes a new
 * immutable specification version, and a fresh external review is run against
 * it. Everything here is data and pure functions, so the main process and the
 * renderer read one definition of "what happens next".
 */

import { z } from 'zod';
import {
  SPECIFICATION_FIELD_NAMES,
  type SpecificationRevisionAddressed,
  type TaskSpecification
} from '../schemas/codex';
import { idSchema, isoDateTime } from './models';
import {
  PLAN_FINDING_CATEGORIES,
  PLAN_FINDING_SEVERITIES,
  parsePlanReviewDecisions,
  type PlanReviewAutoDecision,
  type PlanReviewGate,
  type PlanReviewGateIdentity,
  type PlanReviewRecoveryReason,
  type PlanReviewTriageRecommendation
} from './plan-review';

export const PLAN_CORRECTION_STATUSES = ['running', 'completed', 'failed'] as const;
export type PlanCorrectionStatus = (typeof PLAN_CORRECTION_STATUSES)[number];

/**
 * Where a specification version came from. `generated` is whatever Codex
 * produced when the specification was generated (recorded lazily, the first
 * time a correction starts, so the reviewed text is never lost); `plan_correction`
 * is a revision made from accepted external findings.
 */
export const SPECIFICATION_VERSION_ORIGINS = ['generated', 'plan_correction'] as const;
export type SpecificationVersionOrigin = (typeof SPECIFICATION_VERSION_ORIGINS)[number];

/**
 * An accepted finding as it was when the correction began, frozen into the
 * correction row. The gate's own findings and decisions are immutable too, but
 * the frozen copy is what Codex was actually given, which is the audit fact.
 */
export const acceptedPlanFindingSchema = z
  .object({
    finding: z.number().int().nonnegative(),
    severity: z.enum(PLAN_FINDING_SEVERITIES),
    category: z.enum(PLAN_FINDING_CATEGORIES),
    file: z.string().max(1_024),
    line: z.number().int().nonnegative(),
    title: z.string().min(1).max(500),
    why: z.string().min(1).max(20_000),
    fix: z.string().min(1).max(20_000),
    operatorNote: z.string().max(10_000)
  })
  .strict();
export type AcceptedPlanFinding = z.infer<typeof acceptedPlanFindingSchema>;

export const planCorrectionSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    /** The gate whose accepted decisions this correction answers. UNIQUE: the idempotency key. */
    sourceGateId: idSchema,
    /** 1-based ordinal of this correction within the task. */
    round: z.number().int().min(1),
    fromSpecificationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedJson: z.string().min(2),
    status: z.enum(PLAN_CORRECTION_STATUSES),
    /** How many times Codex has been asked. Retrying a failed correction reopens THIS row. */
    attempts: z.number().int().min(0),
    toSpecificationSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    toVersion: z.number().int().min(1).nullable(),
    /** Which accepted finding Codex says it addressed in which field; set when the correction completes. */
    addressedJson: z.string().nullable(),
    lastError: z.string().max(10_000).nullable(),
    revision: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type PlanCorrection = z.infer<typeof planCorrectionSchema>;

export type PlanRevisionAddressed = SpecificationRevisionAddressed;

/** The stored claim of a completed correction; unreadable or absent reads as none. */
export function parsePlanRevisionAddressed(json: string | null): PlanRevisionAddressed[] {
  if (json === null) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PlanRevisionAddressed =>
        typeof entry === 'object' &&
        entry !== null &&
        Number.isInteger((entry as PlanRevisionAddressed).finding) &&
        (SPECIFICATION_FIELD_NAMES as readonly string[]).includes((entry as PlanRevisionAddressed).field) &&
        typeof (entry as PlanRevisionAddressed).change === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Whether a revision can be believed to have addressed what it was asked to.
 * Returns the reason it cannot, or null.
 *
 * This proves less than "the finding is fixed" — only an independent review of
 * the revised text can — but it removes the cheap failures: a finding Codex
 * never mentioned, a finding nobody accepted, and a claim about a field that did
 * not change. Each of those would otherwise be carried into a fresh review as
 * though it had been dealt with.
 */
export function revisionAddressesProblem(input: {
  readonly accepted: readonly Pick<AcceptedPlanFinding, 'finding'>[];
  readonly addressed: readonly PlanRevisionAddressed[];
  readonly current: TaskSpecification;
  readonly revised: TaskSpecification;
}): string | null {
  const acceptedIndexes = new Set(input.accepted.map((entry) => entry.finding));
  const claimed = new Set<number>();
  for (const entry of input.addressed) {
    if (!acceptedIndexes.has(entry.finding)) {
      return `Codex said it addressed finding ${entry.finding}, which was not one of the accepted findings.`;
    }
    if (JSON.stringify(input.current[entry.field]) === JSON.stringify(input.revised[entry.field])) {
      return `Codex said it addressed finding ${entry.finding} in "${entry.field}", but that field is unchanged.`;
    }
    claimed.add(entry.finding);
  }
  const missing = [...acceptedIndexes].filter((index) => !claimed.has(index)).sort((a, b) => a - b);
  if (missing.length > 0) {
    return `Codex did not say where it addressed accepted finding${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`;
  }
  // A revision may change only what an accepted finding asked for. A field that
  // changed without being tied to one is an unrequested rewrite — of a constraint,
  // the scope or the implementation prompt — and is never carried forward.
  const claimedFields = new Set<string>(input.addressed.map((entry) => entry.field));
  for (const field of SPECIFICATION_FIELD_NAMES) {
    if (
      JSON.stringify(input.current[field]) !== JSON.stringify(input.revised[field]) &&
      !claimedFields.has(field)
    ) {
      return `Codex changed "${field}" without tying the change to an accepted finding.`;
    }
  }
  return null;
}

export const specificationVersionSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    /** 1-based and gapless per task. The only uniqueness: identical content may recur as a later version. */
    version: z.number().int().min(1),
    specificationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    specificationJson: z.string().min(2),
    origin: z.enum(SPECIFICATION_VERSION_ORIGINS),
    /** The correction that produced this version; null for a generated one. */
    sourceCorrectionId: idSchema.nullable(),
    createdAt: isoDateTime
  })
  .strict();
export type SpecificationVersion = z.infer<typeof specificationVersionSchema>;

export function parseAcceptedPlanFindings(json: string): AcceptedPlanFinding[] {
  return z.array(acceptedPlanFindingSchema).max(256).parse(JSON.parse(json));
}

/** What the loop is doing right now, while a loop claim is held. */
export const PLAN_CORRECTION_LOOP_PHASES = ['resolving', 'revising', 'reviewing', 'deciding'] as const;
export type PlanCorrectionLoopPhase = (typeof PLAN_CORRECTION_LOOP_PHASES)[number];

/**
 * The single next thing the plan-review workflow needs, derived from durable
 * state only.
 *
 * - `none`            nothing for this workflow to do (no gate, or an identity we cannot judge).
 * - `decide`          a round awaits decisions (Auto decide, or the operator).
 * - `reconcile`       a dispatched external call has an unknown outcome; read it back first.
 * - `revise`          accepted findings exist on a settled round and the specification is unchanged:
 *                     Codex must revise it before anything else happens.
 * - `recover_review`  the latest review attempt cannot count — the provider refused it before a round
 *                     existed, or its session belongs to another review — so it must be replaced under a
 *                     fresh review identity before anything else can happen.
 * - `run_review`      the specification changed (or a gate is only prepared): review it.
 * - `run_next_review` a settled `changes_requested` round with nothing accepted: review again.
 * - `round_limit`     `revise` is needed but the configured correction budget is spent.
 * - `clean`           the current specification passed with nothing accepted.
 */
export const PLAN_CORRECTION_NEXT_STEPS = [
  'none',
  'decide',
  'reconcile',
  'revise',
  'recover_review',
  'run_review',
  'run_next_review',
  'round_limit',
  'clean'
] as const;
export type PlanCorrectionNextStep = (typeof PLAN_CORRECTION_NEXT_STEPS)[number];

const RECONCILE_STATUSES: readonly PlanReviewGate['status'][] = [
  'opening',
  'reviewing',
  'resolving',
  'failed'
];

/** Whether a settled gate recorded at least one accepted finding. Unreadable decisions count as none. */
export function gateHasAcceptedDecisions(gate: Pick<PlanReviewGate, 'decisionsJson'>): boolean {
  try {
    return parsePlanReviewDecisions(gate.decisionsJson).some((decision) => decision.action === 'accept');
  } catch {
    return false;
  }
}

export function planCorrectionNextStep(input: {
  readonly gate: Pick<PlanReviewGate, 'status' | 'decisionsJson'> | null;
  readonly identity: PlanReviewGateIdentity;
  /** The correction whose source is the latest gate, if any. */
  readonly correctionForGate: Pick<PlanCorrection, 'status'> | null;
  /**
   * Corrections started for OTHER gates of this task. The one for the latest gate
   * is excluded on purpose: retrying it spends no new budget, and counting it
   * would refuse the retry of the last permitted round.
   */
  readonly used: number;
  readonly max: number;
  /**
   * Why the latest attempt cannot count, from `planReviewRecovery`. Ahead of everything
   * that reads the gate's own status: a gate stuck in `reviewing` on a session that
   * belongs to another review would otherwise be sent to `reconcile`, which can only
   * read that other review back.
   */
  readonly recovery?: PlanReviewRecoveryReason | null;
}): PlanCorrectionNextStep {
  const { gate } = input;
  if (gate === null) return 'none';
  if (input.recovery !== undefined && input.recovery !== null) return 'recover_review';
  if (RECONCILE_STATUSES.includes(gate.status)) return 'reconcile';
  if (gate.status === 'awaiting_resolve') return 'decide';

  if (input.identity === 'unknown' || input.identity === 'no_gate') return 'none';

  if (input.identity === 'obsolete') {
    // The specification moved on after this gate. It is only the loop's own
    // doing when a completed correction sits behind it; otherwise it is an
    // ordinary regenerated specification and the existing flow applies.
    return input.correctionForGate?.status === 'completed' ? 'run_review' : 'none';
  }

  // `current`: this gate still speaks for the specification on screen.
  if (gateHasAcceptedDecisions(gate)) {
    return input.used >= input.max ? 'round_limit' : 'revise';
  }
  switch (gate.status) {
    case 'proceeded':
      return 'clean';
    case 'changes_requested':
    case 'interrupted':
      return 'run_next_review';
    case 'prepared':
      return 'run_review';
    default:
      return 'none';
  }
}

/** What Auto decide made of ONE plan-review finding. */
export type PlanAutoDecideOutcome =
  /** Codex accepted or rejected the finding, and the decision is now in the durable draft. */
  | { readonly kind: 'decided'; readonly decision: PlanReviewAutoDecision }
  /** Codex stopped on purpose. Nothing was decided. */
  | {
      readonly kind: 'needs_user';
      readonly reason: string;
      readonly evidenceRef: string;
      readonly confidence: PlanReviewTriageRecommendation['confidence'];
    };

/**
 * Why the correction loop handed control back. Everything but `clean` needs a
 * person, or an explicit retry.
 *
 * - `clean`               the current specification passed with nothing accepted.
 * - `awaiting_decisions`  a round of the (revised) specification waits for decisions.
 * - `settled`             nothing was accepted, so there is nothing to revise.
 * - `needs_user`          Auto decide stopped: a finding needs a person, or could not be analyzed.
 * - `verdict_needs_human` the provider's own verdict asks for a person.
 * - `contract_drift`      the Coai contract changed between rounds.
 * - `reconcile_required`  a dispatched external call has an unknown outcome.
 * - `recovery_required`   the latest review attempt cannot count and must be retried in a fresh session.
 * - `round_limit`         accepted findings remain but the correction budget is spent.
 * - `none`                nothing for this workflow to do.
 */
export const PLAN_ADVANCE_STOPS = [
  'clean',
  'awaiting_decisions',
  'settled',
  'needs_user',
  'verdict_needs_human',
  'contract_drift',
  'reconcile_required',
  'recovery_required',
  'round_limit',
  'none'
] as const;
export type PlanAdvanceStop = (typeof PLAN_ADVANCE_STOPS)[number];

export interface PlanAdvanceOutcome {
  readonly stopped: PlanAdvanceStop;
  /** One plain sentence for the operator. */
  readonly message: string;
  /** Corrections that produced a new specification version during THIS call. */
  readonly correctionsRun: number;
  /** External plan-review rounds started during THIS call. */
  readonly roundsReviewed: number;
}

/** What `planReview:get` says about the correction workflow. */
export interface PlanCorrectionDetail {
  /** Corrections started for this task. */
  readonly used: number;
  /** The configured budget (`Settings.maxReviewRounds`). */
  readonly max: number;
  readonly nextStep: PlanCorrectionNextStep;
  /** Set only while a loop is running in this process. */
  readonly loop: { readonly phase: PlanCorrectionLoopPhase; readonly round: number } | null;
  /** The newest correction, with `running` read as `interrupted` when no loop is alive. */
  readonly latest: {
    readonly round: number;
    readonly status: PlanCorrectionStatus | 'interrupted';
    readonly attempts: number;
    readonly lastError: string | null;
    readonly acceptedCount: number;
    /** What Codex said it changed for each accepted finding, once the correction completed. */
    readonly addressed: readonly (PlanRevisionAddressed & { readonly title: string })[];
  } | null;
  /** Accepted findings on the latest gate that the specification does not yet reflect. */
  readonly acceptedPending: number;
  readonly versions: readonly {
    readonly version: number;
    readonly specificationSha256: string;
    readonly origin: SpecificationVersionOrigin;
    readonly createdAt: string;
  }[];
}
