/**
 * The two structured contracts Agent Relay has with Codex.
 *
 * Both schemas serve double duty:
 *   1. they are converted to JSON Schema and handed to the Codex SDK as
 *      `turnOptions.outputSchema`, so the model is constrained up front;
 *   2. they validate whatever actually comes back, because a constrained model
 *      is still not a guarantee.
 *
 * Keeping one definition for both directions is what stops the prompt and the
 * parser from drifting apart.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Specification                                                               */
/* -------------------------------------------------------------------------- */

const specificationFields = {
  title: z.string().min(1).max(200).describe('Short imperative title for the change.'),
  summary: z.string().min(1).describe('One or two paragraphs describing what will be built.'),
  assumptions: z
    .array(z.string().min(1))
    .describe('Assumptions made because the request was ambiguous. May be empty.'),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1)
    .describe('Objectively checkable statements that must all be true when the task is done.'),
  constraints: z
    .array(z.string().min(1))
    .describe('Things the implementer must not do, or must preserve. May be empty.'),
  suggestedTests: z
    .array(z.string().min(1))
    .describe('Concrete tests that should exist or be run. May be empty.'),
  implementationPrompt: z
    .string()
    .min(1)
    .describe(
      'A complete, self-contained instruction for the coding agent that will implement this task.'
    )
};

const scopedFilePathsField = z
  .array(z.string().min(1).max(1024))
  .max(20)
  .describe(
    'Always include this field. When the ENTIRE implementation is confidently limited to a small, ' +
      'explicit list of existing repository-relative file paths (for example, a documentation-only ' +
      'edit to one named file), list every one of them here, using forward slashes relative to the ' +
      'repository root. Otherwise return an empty array: more than a few files might be touched, a ' +
      'new file might need to be created, or you are not fully certain of the exact set of paths. ' +
      'This is a discovery hint for the implementing agent, not an access restriction.'
  );

/**
 * The strict, model-facing specification contract. Every field is required:
 * OpenAI structured outputs reject a schema whose `required` array does not
 * list every key of `properties`, so an optional field can never be part of what
 * the model is asked to produce. {@link taskSpecificationJsonSchema} is
 * generated from this schema and from nothing else.
 */
export const taskSpecificationResponseSchema = z.object({
  ...specificationFields,
  scopedFilePaths: scopedFilePathsField
});

/**
 * How Agent Relay reads a specification: the response contract, except that
 * `scopedFilePaths` may be absent and then means "no declared scope" (`[]`).
 * A specification stored before the field existed must stay readable, and
 * every consumer of a stored specification uses this schema, so the fallback
 * is defined once here. The factory gives each parse its own array.
 *
 * Derived from the response schema, overriding only that one field, so a field
 * added to the contract reaches both the model and every reader.
 */
export const taskSpecificationSchema = taskSpecificationResponseSchema.extend({
  scopedFilePaths: scopedFilePathsField.default(() => [])
});

export type TaskSpecification = z.infer<typeof taskSpecificationSchema>;

/* -------------------------------------------------------------------------- */
/* Review                                                                      */
/* -------------------------------------------------------------------------- */

export const REVIEW_VERDICTS = ['approved', 'changes_requested', 'blocked'] as const;
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const reviewFindingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1).max(300),
  description: z.string().min(1),
  file: z.string().nullable().describe('Repository-relative path, or null when not file-specific.'),
  line: z.number().int().nullable().describe('1-based line number, or null when unknown.')
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const codexReviewResultSchema = z.object({
  verdict: z
    .enum(REVIEW_VERDICTS)
    .describe(
      'approved = ship it; changes_requested = fixable problems; blocked = the approach itself is wrong.'
    ),
  summary: z.string().min(1),
  findings: z.array(reviewFindingSchema),
  followUpPrompt: z
    .string()
    .describe(
      'Instruction to hand back to the implementing agent. Empty string when the verdict is approved.'
    ),
  suggestedTests: z.array(z.string().min(1))
});

export type CodexReviewResult = z.infer<typeof codexReviewResultSchema>;

/* -------------------------------------------------------------------------- */
/* Automatic finding triage                                                    */
/* -------------------------------------------------------------------------- */

export const TRIAGE_RECOMMENDATIONS = ['accept', 'reject', 'needs_user'] as const;
export const TRIAGE_CONFIDENCES = ['high', 'medium', 'low', 'uncertain'] as const;

export type TriageRecommendation = (typeof TRIAGE_RECOMMENDATIONS)[number];
export type TriageConfidence = (typeof TRIAGE_CONFIDENCES)[number];

/**
 * One independent recommendation for one undecided finding. `findingRef` is
 * either a plan-review finding's 0-based index or a code-review finding's
 * stable id — the caller validates it names one of the specific undecided
 * findings it asked about; this schema only bounds its shape.
 */
export const findingTriageRecommendationSchema = z
  .object({
    findingRef: z.union([z.number().int().nonnegative(), z.string().min(1).max(100)]),
    recommendation: z
      .enum(TRIAGE_RECOMMENDATIONS)
      .describe('accept = valid, actionable, in scope. reject = false premise, duplicate, out of scope, or already satisfied. needs_user = a product/architecture choice or genuine uncertainty.'),
    reason: z.string().min(1).max(2_000).describe('Concise reason for the recommendation.'),
    evidenceRef: z.string().min(1).max(500).describe('A concrete reference into the reviewed material that supports this recommendation.'),
    confidence: z.enum(TRIAGE_CONFIDENCES)
  })
  .strict();

export type FindingTriageRecommendation = z.infer<typeof findingTriageRecommendationSchema>;

/** Wrapped in an object, not a bare array, so the same brace-scanning `extractJsonObject` parses it. */
export const findingTriageResultSchema = z
  .object({
    results: z.array(findingTriageRecommendationSchema).min(1).max(256)
  })
  .strict();

export type FindingTriageResult = z.infer<typeof findingTriageResultSchema>;

/* -------------------------------------------------------------------------- */
/* JSON Schema projections handed to the Codex SDK                             */
/* -------------------------------------------------------------------------- */

/**
 * Codex expects a plain JSON Schema object. `target: 'draft-7'` keeps the output
 * to the widely-understood subset; `io: 'output'` makes zod emit the shape we
 * expect to *receive*.
 */
function toCodexOutputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
}

export const taskSpecificationJsonSchema = (): Record<string, unknown> =>
  toCodexOutputSchema(taskSpecificationResponseSchema);

export const codexReviewResultJsonSchema = (): Record<string, unknown> =>
  toCodexOutputSchema(codexReviewResultSchema);

export const findingTriageResultJsonSchema = (): Record<string, unknown> =>
  toCodexOutputSchema(findingTriageResultSchema);

/* -------------------------------------------------------------------------- */
/* Tolerant parsing                                                            */
/* -------------------------------------------------------------------------- */

export interface ParseOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
  /** The raw text we tried to parse, truncated — useful in the retry dialog. */
  readonly raw?: string;
}

const MAX_RAW_IN_ERROR = 4_000;

/**
 * Extract the first balanced top-level JSON object from a block of text.
 *
 * Codex normally returns bare JSON when `outputSchema` is set, but a model can
 * still wrap it in a ```json fence or add a sentence before it. Rather than
 * failing the whole round on cosmetics, we look for the first `{` and scan
 * forward tracking brace depth (while respecting string literals and escapes).
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(text: string): string {
  return text.length > MAX_RAW_IN_ERROR ? `${text.slice(0, MAX_RAW_IN_ERROR)}…` : text;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Parse `text` into `schema`, tolerating fences/prose around the JSON. */
export function parseStructured<T>(schema: z.ZodType<T>, text: string): ParseOutcome<T> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Codex returned an empty response.', raw: '' };
  }

  const candidate = extractJsonObject(trimmed);
  if (candidate === null) {
    return {
      ok: false,
      error: 'No JSON object was found in the Codex response.',
      raw: truncate(trimmed)
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      error: `Codex response was not valid JSON: ${(error as Error).message}`,
      raw: truncate(candidate)
    };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Codex response did not match the expected shape — ${formatZodError(parsed.error)}`,
      raw: truncate(candidate)
    };
  }

  return { ok: true, value: parsed.data };
}

export function parseTaskSpecification(text: string): ParseOutcome<TaskSpecification> {
  return parseStructured(taskSpecificationSchema, text);
}

export function parseCodexReviewResult(text: string): ParseOutcome<CodexReviewResult> {
  return parseStructured(codexReviewResultSchema, text);
}

export function parseFindingTriageResult(text: string): ParseOutcome<FindingTriageResult> {
  return parseStructured(findingTriageResultSchema, text);
}
