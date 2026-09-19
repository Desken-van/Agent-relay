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
import { idSchema, isoDateTime } from './models';
import {
  PLAN_FINDING_CATEGORIES,
  PLAN_FINDING_SEVERITIES,
  parsePlanReviewDecisions,
  type PlanReviewAutoDecision,
  type PlanReviewGate,
  type PlanReviewGateIdentity,
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
    lastError: z.string().max(10_000).nullable(),
    revision: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type PlanCorrection = z.infer<typeof planCorrectionSchema>;

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
}): PlanCorrectionNextStep {
  const { gate } = input;
  if (gate === null) return 'none';
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
