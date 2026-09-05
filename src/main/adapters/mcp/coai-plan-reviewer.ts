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
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpServerConfig,
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewSubject
} from '../../ports';

export const COAI_TOOL_ALLOWLIST = [
  'providers',
  'open',
  'review_plan',
  'review_code',
  'resolve',
  'status',
  'ask_human'
] as const;

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

const resolutionSchema = z.object({
  stage: stageSchema,
  awaitingResolve: z.boolean(),
  recordedDecisions: z.number().int().nonnegative(),
  instruction: z.string().max(20_000)
});

function assertCoaiAllowlist(config: ExternalMcpServerConfig): void {
  const actual = [...config.allowedTools].sort();
  const expected = [...COAI_TOOL_ALLOWLIST].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The Coai adapter requires its exact audited seven-tool allowlist.'
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

