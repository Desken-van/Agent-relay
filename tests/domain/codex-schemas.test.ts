import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IMPLEMENTATION_REPORT_SCHEMA } from '../../src/main/adapters/codex/codex-adapter';
import {
  codexReviewResultJsonSchema,
  codexReviewResultSchema,
  extractJsonObject,
  findingTriageResultJsonSchema,
  parseCodexReviewResult,
  parseFindingTriageResult,
  parseTaskSpecification,
  taskSpecificationJsonSchema,
  taskSpecificationResponseSchema,
  taskSpecificationSchema
} from '../../src/shared/schemas/codex';
import { makeReview, makeSpecification } from '../helpers/fakes';
import { strictSchemaViolations } from '../helpers/strict-json-schema';

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

  it('accepts a specification with scopedFilePaths', () => {
    const outcome = parseTaskSpecification(
      JSON.stringify({ ...makeSpecification(), scopedFilePaths: ['docs/manual-test.md'] })
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.scopedFilePaths).toEqual(['docs/manual-test.md']);
  });

  it('reads a legacy specification with no scopedFilePaths and normalizes it to an empty scope', () => {
    const { scopedFilePaths: _dropped, ...legacy } = makeSpecification();
    expect('scopedFilePaths' in legacy).toBe(false);

    const outcome = parseTaskSpecification(JSON.stringify(legacy));
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.scopedFilePaths).toEqual([]);

    // The reader every stored specification goes through agrees.
    expect(taskSpecificationSchema.parse(legacy).scopedFilePaths).toEqual([]);
  });

  it('leaves an explicit scopedFilePaths untouched, including an explicit empty one', () => {
    const scope = ['docs/manual-test.md', 'src/a.ts'];
    expect(taskSpecificationSchema.parse(makeSpecification({ scopedFilePaths: scope })).scopedFilePaths).toEqual(scope);
    expect(taskSpecificationSchema.parse(makeSpecification({ scopedFilePaths: [] })).scopedFilePaths).toEqual([]);
  });

  it('gives every parse of a legacy specification its own scope array', () => {
    const { scopedFilePaths: _dropped, ...legacy } = makeSpecification();
    const first = taskSpecificationSchema.parse(legacy);
    const second = taskSpecificationSchema.parse(legacy);
    first.scopedFilePaths.push('mutated.ts');
    expect(second.scopedFilePaths).toEqual([]);
    expect(taskSpecificationSchema.parse(legacy).scopedFilePaths).toEqual([]);
  });

  it('rejects a null or non-array scopedFilePaths rather than treating it as absent', () => {
    for (const bad of [null, 'docs/a.md', 3]) {
      const outcome = parseTaskSpecification(JSON.stringify({ ...makeSpecification(), scopedFilePaths: bad }));
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('scopedFilePaths');
    }
  });

  it('requires scopedFilePaths in the strict response contract the model is held to', () => {
    const { scopedFilePaths: _dropped, ...legacy } = makeSpecification();
    const outcome = taskSpecificationResponseSchema.safeParse(legacy);
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome.error?.issues)).toContain('scopedFilePaths');
    expect(taskSpecificationResponseSchema.safeParse(makeSpecification()).success).toBe(true);
  });

  it('keeps the reading schema and the response schema on exactly the same fields, in the same order', () => {
    // Order matters: the reader's key order is what specification identities hash.
    expect(Object.keys(taskSpecificationSchema.shape)).toEqual(Object.keys(taskSpecificationResponseSchema.shape));
    expect(Object.keys(taskSpecificationSchema.shape).at(-1)).toBe('scopedFilePaths');
    // Every field except the one with a legacy default is the very same definition.
    for (const [key, field] of Object.entries(taskSpecificationResponseSchema.shape)) {
      if (key !== 'scopedFilePaths') {
        expect(taskSpecificationSchema.shape[key as keyof typeof taskSpecificationSchema.shape]).toBe(field);
      }
    }
  });

  it('reads any valid response identically through the strict and the reading schema', () => {
    const value = makeSpecification({ scopedFilePaths: ['docs/manual-test.md'] });
    expect(taskSpecificationSchema.parse(value)).toEqual(taskSpecificationResponseSchema.parse(value));
  });

  it('rejects scopedFilePaths beyond the count limit, without rejecting the rest of the specification unnecessarily', () => {
    const tooMany = Array.from({ length: 21 }, (_unused, i) => `f${i}.ts`);
    const outcome = parseTaskSpecification(
      JSON.stringify({ ...makeSpecification(), scopedFilePaths: tooMany })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('scopedFilePaths');
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
  interface ObjectSchema {
    type: string;
    required: string[];
    properties: Record<string, unknown>;
    additionalProperties: unknown;
  }

  it('lists exactly the same names in the specification schema properties and required', () => {
    const schema = taskSpecificationJsonSchema() as unknown as ObjectSchema;
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('requires scopedFilePaths in the schema handed to the model', () => {
    const schema = taskSpecificationJsonSchema() as unknown as ObjectSchema;
    expect(schema.properties.scopedFilePaths).toBeDefined();
    expect(schema.required).toContain('scopedFilePaths');
  });

  it('tells the model to return an empty array, not to omit scopedFilePaths, in the schema itself', () => {
    const schema = taskSpecificationJsonSchema() as unknown as {
      properties: { scopedFilePaths: { description: string; type: string; maxItems: number } };
    };
    const { description, type, maxItems } = schema.properties.scopedFilePaths;
    expect(type).toBe('array');
    expect(maxItems).toBe(20);
    expect(description).toMatch(/empty array/i);
    expect(description).toMatch(/always include/i);
    expect(description).not.toMatch(/\bomit\b/i);
    expect(description).toMatch(/not an access restriction/i);
  });

  it('sends no default keyword: the schema comes from the strict contract, not the reader', () => {
    expect(JSON.stringify(taskSpecificationJsonSchema())).not.toContain('"default"');
  });

  it('holds every model-facing Codex schema to the strict-output rules at every object level', () => {
    const schemas: Record<string, unknown> = {
      specification: taskSpecificationJsonSchema(),
      review: codexReviewResultJsonSchema(),
      planTriage: findingTriageResultJsonSchema('index'),
      codeTriage: findingTriageResultJsonSchema('id'),
      implementationReport: IMPLEMENTATION_REPORT_SCHEMA
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect({ name, violations: strictSchemaViolations(schema) }).toEqual({ name, violations: [] });
    }
  });

  it('the strict-schema check is not vacuous: it catches an optional field, at the root and nested', () => {
    const optionalAtRoot = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } },
      required: ['a'],
      additionalProperties: false
    };
    expect(strictSchemaViolations(optionalAtRoot)).toEqual(['#: properties not listed in required: b']);

    const nested = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { x: { type: 'string' } }, required: [], additionalProperties: false }
        },
        maybe: { anyOf: [{ type: 'null' }, { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] }] }
      },
      required: ['list', 'maybe'],
      additionalProperties: false
    };
    expect(strictSchemaViolations(nested)).toEqual([
      '#/properties/list/items: properties not listed in required: x',
      '#/properties/maybe/anyOf/1: additionalProperties must be false'
    ]);
  });

  it('the strict-schema check also rejects an object that declares no properties, such as a free-form record', () => {
    const record = z.toJSONSchema(z.object({ notes: z.record(z.string(), z.string()) }), {
      target: 'draft-7',
      io: 'output'
    });
    expect(strictSchemaViolations(record)).toEqual(['#/properties/notes: additionalProperties must be false']);
    expect(strictSchemaViolations({ type: 'object' })).toEqual(['#: additionalProperties must be false']);
    expect(strictSchemaViolations({ anyOf: [{ type: ['object', 'null'] }, { type: 'string' }] })).toEqual([
      '#/anyOf/0: additionalProperties must be false'
    ]);
  });

  it('the strict-schema check accepts a closed object with no properties', () => {
    expect(strictSchemaViolations({ type: 'object', additionalProperties: false })).toEqual([]);
    expect(strictSchemaViolations({ type: 'object', properties: {}, required: [], additionalProperties: false })).toEqual([]);
  });

  it('produces an object schema for the specification with all fields required', () => {
    const schema = taskSpecificationJsonSchema() as unknown as ObjectSchema;
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

  it('keeps the JSON Schema and the Zod validator in agreement, in both directions', () => {
    // Required in the JSON Schema => required by Zod, otherwise the model would
    // be constrained differently from the parser.
    const specSchema = taskSpecificationJsonSchema() as unknown as ObjectSchema;
    for (const field of specSchema.required) {
      const stripped = { ...makeSpecification() } as Record<string, unknown>;
      delete stripped[field];
      expect(taskSpecificationResponseSchema.safeParse(stripped).success).toBe(false);
    }

    // Required by Zod => listed as required in the JSON Schema. This is the
    // direction that catches an optional field being advertised to the model.
    for (const field of Object.keys(makeSpecification())) {
      const stripped = { ...makeSpecification() } as Record<string, unknown>;
      delete stripped[field];
      if (!taskSpecificationResponseSchema.safeParse(stripped).success) {
        expect(specSchema.required).toContain(field);
      }
    }
    // Every field the Zod contract defines is one the model is given, and no more.
    expect(Object.keys(specSchema.properties).sort()).toEqual(
      Object.keys(taskSpecificationResponseSchema.shape).sort()
    );

    const reviewSchema = codexReviewResultJsonSchema() as { required: string[] };
    for (const field of reviewSchema.required) {
      const stripped = { ...makeReview() } as Record<string, unknown>;
      delete stripped[field];
      expect(codexReviewResultSchema.safeParse(stripped).success).toBe(false);
    }
  });
});

describe('finding triage: exactly one kind of finding reference per call', () => {
  const recommendation = (findingRef: unknown): Record<string, unknown> => ({
    findingRef,
    recommendation: 'accept',
    reason: 'Matches acceptance criterion 1.',
    evidenceRef: 'criterion 1',
    confidence: 'high'
  });
  const result = (...refs: unknown[]): unknown => ({ results: refs.map(recommendation) });
  const accepts = (schema: Record<string, unknown>, value: unknown): boolean => new Ajv().compile(schema)(value) === true;

  interface ResultSchema {
    properties: { results: { items: { properties: { findingRef: Record<string, unknown> } } } };
  }
  const findingRefSchema = (kind: 'index' | 'id'): Record<string, unknown> =>
    (findingTriageResultJsonSchema(kind) as unknown as ResultSchema).properties.results.items.properties.findingRef;

  it('hands the model a plan schema whose findingRef is an integer number and nothing else', () => {
    const findingRef = findingRefSchema('index');
    expect(findingRef.type).toBe('integer');
    expect(findingRef).not.toHaveProperty('anyOf');
    expect(JSON.stringify(findingRef)).not.toContain('"string"');

    const schema = findingTriageResultJsonSchema('index');
    expect(accepts(schema, result(0, 1))).toBe(true);
    expect(accepts(schema, result('0'))).toBe(false);
    expect(accepts(schema, result(-1))).toBe(false);
    expect(accepts(schema, result(1.5))).toBe(false);
  });

  it('hands the model a code-review schema whose findingRef is a non-empty string and nothing else', () => {
    const findingRef = findingRefSchema('id');
    expect(findingRef.type).toBe('string');
    expect(findingRef).not.toHaveProperty('anyOf');
    expect(JSON.stringify(findingRef)).not.toContain('"integer"');

    const schema = findingTriageResultJsonSchema('id');
    expect(accepts(schema, result('finding-1', 'finding-2'))).toBe(true);
    expect(accepts(schema, result(0))).toBe(false);
    expect(accepts(schema, result(''))).toBe(false);
  });

  it('tells the model, in the schema itself, which JSON type to copy the reference as', () => {
    expect(findingRefSchema('index').description).toMatch(/JSON number/);
    expect(findingRefSchema('id').description).toMatch(/JSON string/);
  });

  // The exact answer Codex gave for the real plan gate that lost its triage:
  // valid JSON, valid under the old shared `number | string` contract, and
  // rejected wholesale later by the plan-review validator.
  const ORIGINAL_STRING_REFS = JSON.stringify({
    results: [
      {
        findingRef: '0',
        recommendation: 'accept',
        reason: 'The finding is valid.',
        evidenceRef: 'acceptance criterion 2',
        confidence: 'high'
      },
      {
        findingRef: '1',
        recommendation: 'needs_user',
        reason: 'An architecture choice.',
        evidenceRef: 'constraint 1',
        confidence: 'low'
      }
    ]
  });

  it('no longer lets the plan-review contract produce the string references the provider once returned', () => {
    expect(accepts(findingTriageResultJsonSchema('index'), JSON.parse(ORIGINAL_STRING_REFS))).toBe(false);

    const parsed = parseFindingTriageResult(ORIGINAL_STRING_REFS, 'index');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('results.0.findingRef');
    expect(parsed.value).toBeUndefined();
  });

  it('parses the plan answer with numeric references, also when it is wrapped in a fence', () => {
    const numeric = JSON.stringify(result(0, 1));
    const parsed = parseFindingTriageResult('```json\n' + numeric + '\n```', 'index');
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.results.map((entry) => entry.findingRef)).toEqual([0, 1]);
  });

  it('parses the code-review answer with string ids, and rejects numbers for it', () => {
    const parsed = parseFindingTriageResult(JSON.stringify(result('a1', 'b2')), 'id');
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.results.map((entry) => entry.findingRef)).toEqual(['a1', 'b2']);

    expect(parseFindingTriageResult(JSON.stringify(result(0, 1)), 'id').ok).toBe(false);
  });

  it('does not coerce a numeric-looking string into an index, or a number into an id', () => {
    expect(parseFindingTriageResult(JSON.stringify(result('7')), 'index').ok).toBe(false);
    expect(parseFindingTriageResult(JSON.stringify(result(7)), 'id').ok).toBe(false);
  });

  it('keeps the shape rules shared by both kinds: at least one result, no unknown fields', () => {
    for (const kind of ['index', 'id'] as const) {
      expect(parseFindingTriageResult(JSON.stringify({ results: [] }), kind).ok).toBe(false);
      const extra = { results: [{ ...recommendation(kind === 'index' ? 0 : 'a'), note: 'x' }] };
      expect(parseFindingTriageResult(JSON.stringify(extra), kind).ok).toBe(false);
    }
  });
});
