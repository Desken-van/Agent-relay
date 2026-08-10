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

export const taskSpecificationSchema = z.object({
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
  toCodexOutputSchema(taskSpecificationSchema);

export const codexReviewResultJsonSchema = (): Record<string, unknown> =>
  toCodexOutputSchema(codexReviewResultSchema);

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
