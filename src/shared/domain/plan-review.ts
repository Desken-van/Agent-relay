/** Durable identity and typed evidence for the optional external plan gate. */

import { z } from 'zod';
import { idSchema, isoDateTime } from './models';

export const PLAN_REVIEW_STATUSES = [
  'prepared',
  'opening',
  'reviewing',
  'awaiting_resolve',
  'resolving',
  'changes_requested',
  'proceeded',
  'failed',
  /**
   * A round the provider started and never finished.
   *
   * Distinct from `failed`, which is a refusal before anything was dispatched,
   * and from `prepared`, which has no dispatch behind it at all. It carries no
   * findings, so it is not `changes_requested` either. A new round may be
   * started from here by hand, because the provider's own record proves the
   * previous one produced no result.
   */
  'interrupted'
] as const;

export const PLAN_REVIEW_VERDICTS = [
  'proceed',
  'revise',
  'continue_anyway',
  'good_enough',
  'call_human',
  'escalated'
] as const;

/**
 * Why a gate's review cannot count, when that is KNOWN — never a guess.
 *
 * - `not_dispatched`: the provider refused the round before it created one, or the
 *   session it opened proved unfit before anything was sent. Nothing ran, so the
 *   attempt is safe to replace, but only under a fresh review identity: the identity
 *   it used is spent.
 * - `foreign_session`: the provider session this gate recorded belongs to another
 *   review (another gate's, or one that was already past the plan stage), so nothing
 *   read from it can be evidence about THIS gate's specification.
 *
 * A timeout or a lost answer is deliberately in neither: that is an unknown outcome,
 * which only a read-back may settle and which is never repeated.
 */
export const PLAN_REVIEW_FAILURE_KINDS = ['not_dispatched', 'foreign_session'] as const;
export type PlanReviewFailureKind = (typeof PLAN_REVIEW_FAILURE_KINDS)[number];

export const PLAN_FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export const PLAN_FINDING_CATEGORIES = [
  'architecture',
  'security',
  'reliability',
  'performance',
  'ux',
  'convention',
  'clarity',
  'completeness',
  'consistency',
  'feasibility'
] as const;

export const planReviewFindingSchema = z
  .object({
    severity: z.enum(PLAN_FINDING_SEVERITIES),
    category: z.enum(PLAN_FINDING_CATEGORIES),
    file: z.string().max(1_024),
    line: z.number().int().nonnegative(),
    title: z.string().min(1).max(500),
    why: z.string().min(1).max(20_000),
    fix: z.string().min(1).max(20_000),
    providers: z.array(z.string().min(1).max(200)).max(32),
    role: z.string().max(100)
  })
  .strict();
export type PlanReviewFinding = z.infer<typeof planReviewFindingSchema>;

export const planReviewDecisionSchema = z
  .object({
    finding: z.number().int().nonnegative(),
    action: z.enum(['accept', 'reject']),
    reason: z.string().max(10_000)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'reject' && value.reason.trim().length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A rejected finding requires a reason.'
      });
    }
  });
export type PlanReviewDecision = z.infer<typeof planReviewDecisionSchema>;

export const taskRuleEvidenceBindingSchema = z
  .object({
    taskId: idSchema,
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
    snapshotJson: z.string().min(1).max(2_500_000),
    boundAt: isoDateTime
  })
  .strict();
export type TaskRuleEvidenceBinding = z.infer<typeof taskRuleEvidenceBindingSchema>;

export const planReviewGateSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    specificationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    ruleEvidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sessionId: z.string().min(1).max(128).nullable(),
    serverName: z.string().min(1).max(200).nullable(),
    serverVersion: z.string().min(1).max(200).nullable(),
    /**
     * The EXACT Coai contract this gate's review was proved against — see
     * `computeCoaiContractFingerprint` in `adapters/mcp/coai-profiles.ts`.
     * Bound at `open()` and never silently replaced by a later probe's own
     * reading (in particular, never by reconciliation's read-only `status`
     * call): a historical fingerprint is evidence about what was actually
     * reviewed, not a cache of "whatever the server currently reports."
     */
    contractFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /**
     * Set the moment ANY later probe (a subsequent live call, or
     * reconciliation's `status` read) proves the server's current contract
     * differs from {@link contractFingerprint}. Cleared back to null once a
     * probe proves they agree again. Never itself a reason to discard
     * `contractFingerprint` — it is the explicit "this needs a human look"
     * signal Finding 4 requires, kept separate from the evidence it is about.
     */
    contractMismatchAt: isoDateTime.nullable(),
    status: z.enum(PLAN_REVIEW_STATUSES),
    verdict: z.enum(PLAN_REVIEW_VERDICTS).nullable(),
    findingsJson: z.string().nullable(),
    decisionsJson: z.string().nullable(),
    reviewers: z.string().max(2_000).nullable(),
    gatingCount: z.number().int().nonnegative().nullable(),
    threshold: z.number().int().nonnegative().nullable(),
    lastError: z.string().max(10_000).nullable(),
    /**
     * When an outcome was established by reading the provider back.
     *
     * Null for everything this side drove. Set only by reconciliation, so a
     * `changes_requested` or `proceeded` reached without local decisions is
     * always distinguishable from one this application resolved itself.
     */
    reconciledAt: isoDateTime.nullable(),
    /**
     * A monotonic counter bumped by every durable write to this row.
     *
     * The version a decision was made against, so a write can be made
     * conditional on the state that justified it. `updatedAt` cannot do this
     * job: two writes can land in the same millisecond and read back as
     * identical, which is not a hypothetical here — the test clock does not
     * advance at all, so every write would carry the same timestamp.
     */
    revision: z.number().int().nonnegative(),
    /** Codex-assisted automatic triage recommendations — see `planReviewTriageResultSchema`. */
    triageJson: z.string().nullable(),
    /**
     * The EXACT `findingsJson` string the recommendations in `triageJson`
     * were computed against — not a revision number. `revision` bumps on
     * every durable write to this row, including fields a triage result
     * does not depend on, so a revision-based check would make even a
     * freshly written result read as stale the instant anything else
     * touched the row. A reader compares this against the gate's CURRENT
     * `findingsJson`: only a genuinely different set of findings (a new
     * round) invalidates a stored result.
     */
    triageForFindings: z.string().nullable(),
    /**
     * Decisions Codex triage made AND applied for this round's findings — see
     * `planReviewAutoDecisionsSchema`. Durable so a refresh or a restart keeps
     * what "Auto decide" filled in; never a resolution: only `resolve` sends
     * decisions to the provider.
     */
    autoDecisionsJson: z.string().nullable(),
    /**
     * The ref this gate's review was run under — the provider's session key, with the
     * repository. Null means the task's own branch, which is what every gate used
     * before this field existed. A later gate of the same task is given a ref of its
     * own (see `PlanReviewSubjectFactory`), because the provider hands back the
     * existing session, however far it has advanced, for a ref it has seen.
     */
    reviewSubject: z.string().min(1).max(256).nullable(),
    /**
     * How many plan rounds the provider's session already held when this dispatch
     * opened it. A round counted by a later read-back is this dispatch's only if the
     * count went up; null when it was not known.
     */
    roundsAtOpen: z.number().int().nonnegative().nullable(),
    /** Why this gate's review cannot count, when that is known. See {@link PLAN_REVIEW_FAILURE_KINDS}. */
    failureKind: z.enum(PLAN_REVIEW_FAILURE_KINDS).nullable(),
    /** The gate that replaced this attempt. The attempt and its error stay as they were. */
    supersededBy: idSchema.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type PlanReviewGate = z.infer<typeof planReviewGateSchema>;

/* -------------------------------------------------------------------------- */
/* Automatic finding triage                                                    */
/* -------------------------------------------------------------------------- */

export const planReviewTriageRecommendationSchema = z
  .object({
    /** 0-based index into the gate's `findingsJson` array. */
    finding: z.number().int().nonnegative(),
    recommendation: z.enum(['accept', 'reject', 'needs_user']),
    reason: z.string().min(1).max(2_000),
    evidenceRef: z.string().min(1).max(500),
    confidence: z.enum(['high', 'medium', 'low', 'uncertain'])
  })
  .strict();
export type PlanReviewTriageRecommendation = z.infer<typeof planReviewTriageRecommendationSchema>;

export const planReviewTriageResultSchema = z
  .object({
    recommendations: z.array(planReviewTriageRecommendationSchema).max(256)
  })
  .strict();
export type PlanReviewTriageResult = z.infer<typeof planReviewTriageResultSchema>;

export function parsePlanReviewTriage(json: string | null): PlanReviewTriageResult | null {
  if (json === null) return null;
  try {
    return planReviewTriageResultSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Automatic decisions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One decision Codex triage made for one finding and Agent Relay applied to the
 * operator's decision draft. Only `accept` and `reject`: a `needs_user`
 * recommendation is never a decision and lives only in the triage result.
 */
export const planReviewAutoDecisionSchema = z
  .object({
    /** 0-based index into the gate's `findingsJson` array. */
    finding: z.number().int().nonnegative(),
    action: z.enum(['accept', 'reject']),
    /** The audit reason that goes to the provider on resolve. Never empty. */
    reason: z.string().min(1).max(10_000),
    evidenceRef: z.string().min(1).max(500),
    confidence: z.enum(['high', 'medium', 'low', 'uncertain']),
    decidedAt: isoDateTime
  })
  .strict();
export type PlanReviewAutoDecision = z.infer<typeof planReviewAutoDecisionSchema>;

/**
 * The stored form. `forFindingsSha256` is the SHA-256 of the exact
 * `findingsJson` the decisions answer — the same identity rule the triage
 * columns follow, expressed as a hash because the findings text itself can be
 * large. A reader compares it with the gate's current findings, so a new round
 * can never inherit an earlier round's decisions.
 */
export const planReviewAutoDecisionsSchema = z
  .object({
    forFindingsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    decisions: z.array(planReviewAutoDecisionSchema).max(256)
  })
  .strict();
export type PlanReviewAutoDecisions = z.infer<typeof planReviewAutoDecisionsSchema>;

/** The stored decisions that still describe `expectedFindingsSha256`, else none. */
export function parsePlanReviewAutoDecisions(
  json: string | null,
  expectedFindingsSha256: string | null
): PlanReviewAutoDecision[] {
  if (json === null || expectedFindingsSha256 === null) return [];
  try {
    const stored = planReviewAutoDecisionsSchema.parse(JSON.parse(json));
    return stored.forFindingsSha256 === expectedFindingsSha256 ? stored.decisions : [];
  } catch {
    return [];
  }
}

/**
 * Whether a task's latest gate still speaks for the specification it has now.
 *
 * Four states rather than a boolean, because "no" was doing two incompatible
 * jobs: a gate PROVEN to belong to an earlier specification, and a gate whose
 * identity could not be read at all. Only the first justifies telling an
 * operator the review is out of date and offering to prepare a new one; the
 * second is an admission that the question could not be answered, and the
 * action it would suggest — prepare again — is the one thing certain to fail,
 * because the evidence it needs is the evidence that could not be read.
 *
 * - `no_gate`  — the task has no gate to judge.
 * - `current`  — both hashes were read and both match.
 * - `obsolete` — both were read and at least one differs.
 * - `unknown`  — the binding or the specification could not be read, so
 *                neither answer is available. Never presented as staleness.
 */
export type PlanReviewGateIdentity = 'no_gate' | 'current' | 'obsolete' | 'unknown';
export type PlanReviewStatus = (typeof PLAN_REVIEW_STATUSES)[number];
export type PlanReviewVerdict = (typeof PLAN_REVIEW_VERDICTS)[number];

/**
 * The gate a provider session belongs to: the FIRST one that recorded it.
 *
 * A session is one review. When two gates of a task hold the same session id, the
 * second did not review anything of its own — the provider handed it the session
 * the first had already used — so the session can speak for the first and for no one
 * else. `gates` must be one task's gates in `PlanReviewGateRepository.listByTask`
 * order (newest first), which is why the earliest is the LAST match.
 */
export function planReviewSessionOwner(
  gates: readonly Pick<PlanReviewGate, 'id' | 'sessionId'>[],
  sessionId: string
): Pick<PlanReviewGate, 'id' | 'sessionId'> | null {
  let owner: Pick<PlanReviewGate, 'id' | 'sessionId'> | null = null;
  for (const gate of gates) {
    if (gate.sessionId === sessionId) owner = gate;
  }
  return owner;
}

/** Does this gate's recorded session belong to a different, earlier gate of the task? */
export function planReviewSessionIsForeign(
  gate: Pick<PlanReviewGate, 'id' | 'sessionId'>,
  gates: readonly Pick<PlanReviewGate, 'id' | 'sessionId'>[]
): boolean {
  if (gate.sessionId === null) return false;
  const owner = planReviewSessionOwner(gates, gate.sessionId);
  return owner !== null && owner.id !== gate.id;
}

/**
 * Why a gate's review cannot stand and must be replaced under a fresh review
 * identity — or null when nothing is wrong with it.
 *
 * Derived from durable rows only, so a screen, the correction loop and the backend's
 * own refusals all read the same answer:
 *
 * - `refused_before_dispatch`: the provider refused, or the session it opened proved
 *   unfit, before any round existed. Nothing ran; the identity is spent.
 * - `foreign_session`: the session belongs to another gate. For a gate still waiting
 *   on the provider that is enough by itself — nothing read from that session can be
 *   about this gate. For one already settled it applies only when the settlement was
 *   read back from the provider (`reconciledAt`), because that is exactly the
 *   evidence a shared session cannot supply; a result this side drove — the answer to
 *   its own `review_plan` and `resolve` — is attributed by the call, not by the session.
 *
 * Deliberately absent: a timeout or a lost answer on a session that is the gate's
 * own. That is an unknown outcome, settled only by a read-back and never repeated.
 */
export type PlanReviewRecoveryReason = 'refused_before_dispatch' | 'foreign_session';

/**
 * What to tell a person about a review that cannot count: what happened, and the one safe
 * next step. Kept beside {@link planReviewRecovery} so the screen, the correction loop's
 * outcome and the backend's refusals cannot describe the same state in different words.
 * None of it quotes the provider; the refusal itself is on the gate as `lastError`.
 */
export function planReviewRecoveryMessage(reason: PlanReviewRecoveryReason): string {
  return reason === 'refused_before_dispatch'
    ? 'The provider refused this plan review before any round existed, so nothing ran and the specification is still unreviewed. It can be retried in a fresh review session; nothing is repeated, and this attempt stays on record.'
    : 'This plan review was recorded against a provider session that belongs to a different review, so nothing read from it counts as a review of this specification. It can be retried in a fresh review session; nothing is repeated, and this attempt stays on record.';
}

export function planReviewRecovery(
  gate: Pick<
    PlanReviewGate,
    'id' | 'sessionId' | 'status' | 'failureKind' | 'reconciledAt' | 'supersededBy'
  > | null,
  gates: readonly Pick<PlanReviewGate, 'id' | 'sessionId'>[]
): PlanReviewRecoveryReason | null {
  if (gate === null || gate.supersededBy !== null) return null;
  const foreign = planReviewSessionIsForeign(gate, gates);
  switch (gate.status) {
    case 'prepared':
    case 'opening':
    case 'reviewing':
    case 'failed':
      if (gate.failureKind === 'not_dispatched') return 'refused_before_dispatch';
      return gate.failureKind === 'foreign_session' || foreign ? 'foreign_session' : null;
    case 'proceeded':
    case 'changes_requested':
    case 'interrupted':
      return gate.failureKind === 'foreign_session' || (foreign && gate.reconciledAt !== null)
        ? 'foreign_session'
        : null;
    default:
      // `awaiting_resolve` and `resolving`: the round is this gate's own, returned
      // directly by the call that made it.
      return null;
  }
}

export function parsePlanReviewFindings(json: string | null): PlanReviewFinding[] {
  if (json === null) return [];
  return z.array(planReviewFindingSchema).max(256).parse(JSON.parse(json));
}

export function parsePlanReviewDecisions(json: string | null): PlanReviewDecision[] {
  if (json === null) return [];
  return z.array(planReviewDecisionSchema).max(256).parse(JSON.parse(json));
}
