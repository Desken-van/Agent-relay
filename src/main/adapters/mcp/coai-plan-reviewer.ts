/** Typed Coai plan-gate adapter over the generic bounded MCP transport. */

import { z } from 'zod';
import { AgentRelayError } from '../../../shared/domain/errors';
import {
  PLAN_FINDING_CATEGORIES,
  PLAN_FINDING_SEVERITIES,
  PLAN_REVIEW_VERDICTS,
  planReviewDecisionSchema,
  type PlanReviewDecision,
  type PlanReviewFinding
} from '../../../shared/domain/plan-review';
import { COAI_ADDRESSABLE_PROFILE, COAI_PLAN_PROFILE, isAuditedProfile } from './coai-profiles';
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpServerConfig,
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject
} from '../../ports';

/**
 * The profile the plan gate configures by default.
 *
 * Re-exported under its original name so every existing caller keeps working;
 * the list itself now lives with the other audited profiles, beside the
 * addressable one it is a prefix of.
 */
export const COAI_TOOL_ALLOWLIST = COAI_PLAN_PROFILE;

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

const sessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  stage: stageSchema,
  awaitingResolve: z.boolean(),
  planProceeded: z.boolean()
});

const reviewSchema = z.object({
  verdict: lowerEnum(PLAN_REVIEW_VERDICTS),
  gatingCount: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  reviewers: z.string().min(1).max(2_000),
  findings: z.array(findingSchema).max(256),
  instruction: z.string().max(20_000)
});

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

/**
 * Either audited profile, and nothing between them.
 *
 * The plan tools are identical in both, so a server presenting the exact
 * ten-tool profile serves this gate as well as the seven-tool one does — and a
 * deployment that has the newer server should not have to run two of them to
 * keep plan review working. What is NOT accepted is a superset: "the seven I
 * need are present" would admit any server that grew tools nobody here has
 * read, and its other tools may have changed too.
 */
function assertCoaiAllowlist(config: ExternalMcpServerConfig): void {
  if (
    !isAuditedProfile(config.allowedTools, COAI_PLAN_PROFILE) &&
    !isAuditedProfile(config.allowedTools, COAI_ADDRESSABLE_PROFILE)
  ) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The Coai plan adapter requires one of its exact audited profiles: the seven plan tools, or those ten.'
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
      ...value,
      serverName: result.server.name,
      serverVersion: result.server.version
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
      serverVersion: result.server.version
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
    const value = parseCall(result, reviewSchema);
    return {
      ...value,
      serverName: result.server.name,
      serverVersion: result.server.version
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
      serverVersion: result.server.version
    };
  }
}
