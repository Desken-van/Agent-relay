import { describe, expect, it } from 'vitest';
import {
  codexReviewResultJsonSchema,
  codexReviewResultSchema,
  extractJsonObject,
  parseCodexReviewResult,
  parseTaskSpecification,
  taskSpecificationJsonSchema,
  taskSpecificationSchema
} from '../../src/shared/schemas/codex';
import { makeReview, makeSpecification } from '../helpers/fakes';

describe('extractJsonObject', () => {
  it('finds a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('finds an object wrapped in prose', () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('finds an object inside a fenced code block', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    const text = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonObject(`noise ${text} more`)).toBe(text);
  });

  it('does not stop at a brace inside a string literal', () => {
    const text = '{"a":"}{ not the end","b":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"a":"say \\"hi\\" }","b":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('returns null when there is no object at all', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('returns null for an unbalanced object', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe('specification parsing', () => {
  it('accepts a valid specification', () => {
    const outcome = parseTaskSpecification(JSON.stringify(makeSpecification()));
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.acceptanceCriteria).toHaveLength(1);
  });

  it('accepts a specification wrapped in a fence', () => {
    const outcome = parseTaskSpecification(
      '```json\n' + JSON.stringify(makeSpecification()) + '\n```'
    );
    expect(outcome.ok).toBe(true);
  });

  it('rejects an empty response with a usable message', () => {
    const outcome = parseTaskSpecification('   ');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('empty');
  });

  it('rejects a response with no JSON', () => {
    const outcome = parseTaskSpecification('I could not do that.');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('No JSON object');
    expect(outcome.raw).toContain('I could not');
  });

  it('rejects malformed JSON and reports why', () => {
    const outcome = parseTaskSpecification('{"title": }');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not valid JSON');
  });

  it('rejects a specification with no acceptance criteria', () => {
    const outcome = parseTaskSpecification(
      JSON.stringify(makeSpecification({ acceptanceCriteria: [] }))
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('acceptanceCriteria');
  });

  it('names the offending field when a required field is missing', () => {
    const { implementationPrompt: _dropped, ...rest } = makeSpecification();
    const outcome = parseTaskSpecification(JSON.stringify(rest));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('implementationPrompt');
  });

  it('rejects a wrong field type', () => {
    const outcome = parseTaskSpecification(
      JSON.stringify({ ...makeSpecification(), assumptions: 'not an array' })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('assumptions');
  });
});

describe('review parsing', () => {
  it('accepts an approval with no findings', () => {
    const outcome = parseCodexReviewResult(JSON.stringify(makeReview()));
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.verdict).toBe('approved');
  });

  it('accepts changes_requested with findings', () => {
    const review = makeReview({
      verdict: 'changes_requested',
      followUpPrompt: 'Fix the null check.',
      findings: [
        {
          severity: 'high',
          title: 'Null dereference',
          description: 'user may be null here.',
          file: 'src/app.ts',
          line: 42
        }
      ]
    });
    const outcome = parseCodexReviewResult(JSON.stringify(review));
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.findings[0]?.line).toBe(42);
  });

  it('accepts null file and line on a finding', () => {
    const review = makeReview({
      verdict: 'changes_requested',
      findings: [
        { severity: 'low', title: 'Naming', description: 'Consider a clearer name.', file: null, line: null }
      ]
    });
    expect(parseCodexReviewResult(JSON.stringify(review)).ok).toBe(true);
  });

  it('rejects an unknown verdict', () => {
    const outcome = parseCodexReviewResult(JSON.stringify(makeReview({ verdict: 'lgtm' as never })));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('verdict');
  });

  it('rejects an unknown severity', () => {
    const outcome = parseCodexReviewResult(
      JSON.stringify(
        makeReview({
          findings: [
            { severity: 'catastrophic' as never, title: 'x', description: 'y', file: null, line: null }
          ]
        })
      )
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('severity');
  });
});

describe('JSON Schema projection handed to Codex', () => {
  it('produces an object schema for the specification with all fields required', () => {
    const schema = taskSpecificationJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    for (const field of [
      'title',
      'summary',
      'assumptions',
      'acceptanceCriteria',
      'constraints',
      'suggestedTests',
      'implementationPrompt'
    ]) {
      expect(schema.required).toContain(field);
      expect(schema.properties[field]).toBeDefined();
    }
  });

  it('produces an object schema for the review with the verdict enumerated', () => {
    const schema = codexReviewResultJsonSchema() as {
      properties: { verdict: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.verdict.enum).toEqual(['approved', 'changes_requested', 'blocked']);
    expect(schema.required).toContain('findings');
    expect(schema.required).toContain('followUpPrompt');
  });

  it('keeps the JSON Schema and the Zod validator in agreement', () => {
    // Anything the JSON Schema declares required must be required by Zod too,
    // otherwise the model would be constrained differently from the parser.
    const specSchema = taskSpecificationJsonSchema() as { required: string[] };
    for (const field of specSchema.required) {
      const stripped = { ...makeSpecification() } as Record<string, unknown>;
      delete stripped[field];
      expect(taskSpecificationSchema.safeParse(stripped).success).toBe(false);
    }

    const reviewSchema = codexReviewResultJsonSchema() as { required: string[] };
    for (const field of reviewSchema.required) {
      const stripped = { ...makeReview() } as Record<string, unknown>;
      delete stripped[field];
      expect(codexReviewResultSchema.safeParse(stripped).success).toBe(false);
    }
  });
});
