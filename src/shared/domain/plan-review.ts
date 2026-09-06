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

export const PLAN_FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export const PLAN_FINDING_CATEGORIES = [
  'architecture',
  'security',
  'reliability',
  'performance',
  'ux',
  'convention'
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
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type PlanReviewGate = z.infer<typeof planReviewGateSchema>;
export type PlanReviewStatus = (typeof PLAN_REVIEW_STATUSES)[number];
export type PlanReviewVerdict = (typeof PLAN_REVIEW_VERDICTS)[number];

export function parsePlanReviewFindings(json: string | null): PlanReviewFinding[] {
  if (json === null) return [];
  return z.array(planReviewFindingSchema).max(256).parse(JSON.parse(json));
}
