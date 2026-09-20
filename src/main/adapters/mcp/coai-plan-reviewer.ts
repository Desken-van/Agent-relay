/** Typed Coai plan-gate adapter over the generic bounded MCP transport. */

import { z } from 'zod';
import { AgentRelayError, PlanReviewNotDispatchedError, type PlanReviewRefusalReason } from '../../../shared/domain/errors';
import {
  PLAN_FINDING_CATEGORIES,
  PLAN_FINDING_SEVERITIES,
  PLAN_REVIEW_VERDICTS,
  planReviewDecisionSchema,
  type PlanReviewDecision,
  type PlanReviewFinding
} from '../../../shared/domain/plan-review';
import { COAI_PLAN_REVIEW_TOOLS, isAuditedProfile } from './coai-profiles';
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpServerConfig,
  ExternalPlanReviewer,
  ExternalPlanReviewRoundCounts,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject
} from '../../ports';

/**
 * The tools the plan gate declares by default.
 *
 * Re-exported under its original name so every existing caller keeps working;
 * the list itself now lives with the other Coai tool constants, and is the
 * four tools this adapter actually calls (open, status, review_plan, resolve)
 * rather than a full server shape — see coai-profiles.ts.
 */
export const COAI_TOOL_ALLOWLIST = COAI_PLAN_REVIEW_TOOLS;

const stageSchema = z.enum(['PlanReview', 'CodeReview', 'Done']);

function lowerEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.toLowerCase() : value),
    z.enum(values)
  );
}

const findingSchema = z
  .object({
    severity: lowerEnum(PLAN_FINDING_SEVERITIES),
    category: lowerEnum(PLAN_FINDING_CATEGORIES),
    file: z.string().max(1_024).nullable().optional(),
    line: z.number().int().nonnegative().nullable().optional(),
    title: z.string().min(1).max(500),
    why: z.string().min(1).max(20_000),
    fix: z.string().min(1).max(20_000),
    providers: z.array(z.string().min(1).max(200)).max(32),
    role: z.string().max(100).optional()
  })
  .transform(
    (value): PlanReviewFinding => ({
      severity: value.severity,
      category: value.category,
      file: value.file ?? '',
      line: value.line ?? 0,
      title: value.title,
      why: value.why,
      fix: value.fix,
      providers: value.providers,
      role: value.role ?? ''
    })
  );

/**
 * The read-only status surface.
 *
 * Passthrough rather than strict: the provider is free to add fields, and this
 * adapter must not fail a recovery because it learned something new. Only the
 * fields below are ever read, and `rounds` is read for one purpose — proving
 * whether a non-idempotent plan round has already run. Note what is absent:
 * status carries no findings, so a completed round cannot be restored from it.
 */
const roundStatusSchema = z.enum(['running', 'done', 'interrupted']);

const statusRoundSchema = z
  .object({
    stage: stageSchema,
    status: roundStatusSchema
  })
  .passthrough();

/**
 * Fold recorded rounds into the tally the gate service reasons about. Only PlanReview
 * rounds count: rounds of a later stage say nothing about whether a plan round may run.
 */
function tallyPlanRounds(rounds: readonly z.infer<typeof statusRoundSchema>[]): ExternalPlanReviewRoundCounts {
  const plan = rounds.filter((round) => round.stage === 'PlanReview');
  return {
    total: plan.length,
    running: plan.filter((round) => round.status === 'running').length,
    done: plan.filter((round) => round.status === 'done').length,
    interrupted: plan.filter((round) => round.status === 'interrupted').length
  };
}

const sessionSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    stage: stageSchema,
    awaitingResolve: z.boolean(),
    planProceeded: z.boolean(),
    // The provider's `open` reports the session's rounds, which is what proves a session
    // fresh. Optional here, not defaulted: an absent list must reach the gate as
    // "not known" and never as "no round has run".
    rounds: z.array(statusRoundSchema).max(64).optional()
  })
  .passthrough();

const reviewSchema = z.object({
  verdict: lowerEnum(PLAN_REVIEW_VERDICTS),
  gatingCount: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  reviewers: z.string().min(1).max(2_000),
  findings: z.array(findingSchema).max(256),
  instruction: z.string().max(20_000)
});

const statusSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    stage: stageSchema,
    awaitingResolve: z.boolean(),
    planProceeded: z.boolean(),
    rounds: z.array(statusRoundSchema).max(64)
  })
  .passthrough();

const resolutionSchema = z.object({
  stage: stageSchema,
  awaitingResolve: z.boolean(),
  recordedDecisions: z.number().int().nonnegative(),
  instruction: z.string().max(20_000)
});

const NO_SESSION_REFUSAL = 'no session for this repo+branch — call open first';

/**
 * The provider's refusals of `review_plan` that are documented to happen BEFORE a round
 * exists. Matched on the provider's own sentence, here and nowhere else, and only these:
 * a refusal in any other words is not proof that nothing ran.
 */
const NOT_DISPATCHED_REFUSALS: readonly { readonly reason: PlanReviewRefusalReason; readonly test: (message: string) => boolean }[] = [
  { reason: 'plan_stage_over', test: (message) => message.startsWith('the plan stage is over for this session') },
  { reason: 'no_session', test: (message) => message === NO_SESSION_REFUSAL }
];

/** The text of an error envelope (`{"error": "..."}`), or null when the result is not one. */
function errorEnvelope(result: ExternalMcpCallResult): string | null {
  if (result.isError || result.content.length !== 1) return null;
  try {
    const value: unknown = JSON.parse(result.content[0]!);
    if (typeof value !== 'object' || value === null || !('error' in value)) return null;
    const message = (value as { error?: unknown }).error;
    return typeof message === 'string' && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

/**
 * Coai's current status contract represents an absent session as a refusal
 * rather than as a normal status envelope. Recognise only that documented,
 * exact value; every other refusal keeps failing closed through parseCall.
 */
function isNoSessionRefusal(result: ExternalMcpCallResult): boolean {
  return errorEnvelope(result) === NO_SESSION_REFUSAL;
}

/**
 * This adapter's own construction-time sanity check: was it built with
 * exactly the four tools it is ever going to call, no more and no less?
 *
 * This has nothing to do with what the real server advertises — that is
 * negotiated per call by the transport's required-subset check against
 * `config.allowedTools` (see stdio-mcp-client.ts and coai-profiles.ts). This
 * check exists so a caller cannot hand `CoaiPlanReviewer` a config declaring
 * the wrong local allowlist — too narrow, and a call this adapter needs would
 * be refused locally before it ever reached the server; too wide, and the
 * adapter could be permitted to call a tool (an addressable round tool, say)
 * it was never written to use.
 */
function assertCoaiAllowlist(config: ExternalMcpServerConfig): void {
  if (!isAuditedProfile(config.allowedTools, COAI_PLAN_REVIEW_TOOLS)) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The Coai plan adapter requires a configuration declaring exactly its four tools: open, status, review_plan, resolve.'
    );
  }
}

function parseCall<T>(result: ExternalMcpCallResult, schema: z.ZodType<T>): T {
  if (result.isError) {
    throw new AgentRelayError('TOOL_FAILED', `Coai reported an MCP tool error from ${result.tool.name}.`);
  }
  if (result.content.length !== 1) {
    throw new AgentRelayError('PARSE_FAILED', 'Coai must return exactly one JSON text block.');
  }

  let value: unknown;
  try {
    value = JSON.parse(result.content[0]!);
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'Coai returned malformed JSON inside its MCP result.', {
      cause: error
    });
  }
  if (typeof value === 'object' && value !== null && 'error' in value) {
    const message = (value as { error?: unknown }).error;
    throw new AgentRelayError(
      'TOOL_FAILED',
      typeof message === 'string' && message.length > 0 ? `Coai refused the request: ${message}` : 'Coai refused the request.'
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AgentRelayError('PARSE_FAILED', `Coai returned an invalid ${result.tool.name} result.`, {
      details: parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    });
  }
  return parsed.data;
}

export class CoaiPlanReviewer implements ExternalPlanReviewer {
  constructor(
    private readonly client: ExternalMcpClient,
    private readonly config: ExternalMcpServerConfig
  ) {
    assertCoaiAllowlist(config);
  }

  async open(
    subject: ExternalPlanReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewSession> {
    const result = await this.client.call(
      this.config,
      'open',
      { repoPath: subject.repositoryPath, branch: subject.branch },
      signal
    );
    const value = parseCall(result, sessionSchema);
    return {
      sessionId: value.sessionId,
      stage: value.stage,
      awaitingResolve: value.awaitingResolve,
      planProceeded: value.planProceeded,
      planRounds: value.rounds === undefined ? null : tallyPlanRounds(value.rounds),
      serverName: result.server.name,
      serverVersion: result.server.version,
      contractFingerprint: result.contractFingerprint
    };
  }

  async status(
    subject: ExternalPlanReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewStatus> {
    const result = await this.client.call(
      this.config,
      'status',
      { repoPath: subject.repositoryPath, branch: subject.branch },
      signal
    );
    if (isNoSessionRefusal(result)) {
      throw new AgentRelayError('NOT_FOUND', 'Coai has no session for this repository and branch.');
    }
    const value = parseCall(result, statusSchema);
    // Required by the provider's contract, so a missing `sessionId` or a
    // missing `rounds` is malformed evidence and fails above — never a default.
    // An absent `rounds` defaulted to `[]` would read as "no round has ever
    // run", which is the most dangerous sentence this recovery can say.
    const plan = value.rounds.filter((round) => round.stage === 'PlanReview');
    return {
      sessionId: value.sessionId,
      stage: value.stage,
      awaitingResolve: value.awaitingResolve,
      planProceeded: value.planProceeded,
      planRounds: {
        total: plan.length,
        running: plan.filter((round) => round.status === 'running').length,
        done: plan.filter((round) => round.status === 'done').length,
        interrupted: plan.filter((round) => round.status === 'interrupted').length
      },
      serverName: result.server.name,
      serverVersion: result.server.version,
      contractFingerprint: result.contractFingerprint
    };
  }

  async reviewPlan(
    subject: ExternalPlanReviewSubject,
    planText: string,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewRound> {
    const result = await this.client.call(
      this.config,
      'review_plan',
      { repoPath: subject.repositoryPath, branch: subject.branch, planText },
      signal
    );
    // A refusal the provider documents as coming before any round exists is a fact about
    // this call, and travels as one; every other failure stays what it always was.
    const refusal = errorEnvelope(result);
    const known = refusal === null ? undefined : NOT_DISPATCHED_REFUSALS.find((entry) => entry.test(refusal));
    if (known !== undefined) {
      throw new PlanReviewNotDispatchedError(known.reason, `Coai refused the request: ${refusal}`);
    }
    const value = parseCall(result, reviewSchema);
    return {
      ...value,
      serverName: result.server.name,
      serverVersion: result.server.version,
      contractFingerprint: result.contractFingerprint
    };
  }

  async resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewResolution> {
    const validated = z.array(planReviewDecisionSchema).max(256).parse(decisions);
    const result = await this.client.call(
      this.config,
      'resolve',
      {
        repoPath: subject.repositoryPath,
        branch: subject.branch,
        decisions: JSON.stringify(validated)
      },
      signal
    );
    const value = parseCall(result, resolutionSchema);
    return {
      ...value,
      serverName: result.server.name,
      serverVersion: result.server.version,
      contractFingerprint: result.contractFingerprint
    };
  }
}
