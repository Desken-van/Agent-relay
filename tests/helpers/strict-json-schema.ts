/**
 * OpenAI structured outputs accept an object schema only when
 *   - `required` lists EVERY key of `properties`, and
 *   - `additionalProperties` is `false`,
 * at every object in the schema, not only at the root. This walks a whole JSON
 * Schema and reports each place that breaks either rule, so a field added to any
 * model-facing schema later cannot silently regress.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every keyword whose value is a sub-schema, or a collection of them. */
const SUBSCHEMA_MAPS = ['properties', '$defs', 'definitions', 'patternProperties'] as const;
const SUBSCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;
const SUBSCHEMA_SINGLES = ['items', 'additionalProperties', 'not', 'if', 'then', 'else'] as const;

export function strictSchemaViolations(schema: unknown, path = '#'): string[] {
  if (!isRecord(schema)) return [];
  const violations: string[] = [];

  // An object node is one that says so, or that declares properties: a bare
  // `{ type: 'object' }` (what a free-form record becomes) breaks the rules too.
  const isObject =
    schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || isRecord(schema.properties);
  if (isObject) {
    const declared = Object.keys(isRecord(schema.properties) ? schema.properties : {}).sort();
    const required = Array.isArray(schema.required) ? schema.required.map(String).sort() : [];
    const missing = declared.filter((key) => !required.includes(key));
    const unknown = required.filter((key) => !declared.includes(key));
    if (missing.length > 0) {
      violations.push(`${path}: properties not listed in required: ${missing.join(', ')}`);
    }
    if (unknown.length > 0) {
      violations.push(`${path}: required names no property: ${unknown.join(', ')}`);
    }
    if (schema.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties must be false`);
    }
  }

  for (const key of SUBSCHEMA_MAPS) {
    const map = schema[key];
    if (!isRecord(map)) continue;
    for (const [name, child] of Object.entries(map)) {
      violations.push(...strictSchemaViolations(child, `${path}/${key}/${name}`));
    }
  }
  for (const key of SUBSCHEMA_LISTS) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    list.forEach((child, index) => violations.push(...strictSchemaViolations(child, `${path}/${key}/${index}`)));
  }
  for (const key of SUBSCHEMA_SINGLES) {
    violations.push(...strictSchemaViolations(schema[key], `${path}/${key}`));
  }

  return violations;
}
