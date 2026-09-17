import { describe, expect, it } from 'vitest';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_CODE_REVIEW_TOOLS,
  COAI_HUMAN_ESCALATION_TOOLS,
  COAI_PLAN_PROFILE,
  COAI_PLAN_REVIEW_TOOLS,
  COAI_RECONCILIATION_TOOLS,
  canonicalizeJson,
  computeCoaiContractFingerprint,
  detectCoaiCapabilities,
  isAuditedProfile,
  profileOf,
  type CoaiFingerprintableTool
} from '../../src/main/adapters/mcp/coai-profiles';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'coai-mcp';
const SERVER_VERSION = '0.22.0';

function tool(name: string, inputSchema: Record<string, unknown>): CoaiFingerprintableTool {
  return { name, inputSchema };
}

function fingerprint(
  tools: readonly CoaiFingerprintableTool[],
  requiredToolNames: readonly string[] = tools.map((t) => t.name)
): string {
  return computeCoaiContractFingerprint({
    protocolVersion: PROTOCOL_VERSION,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    tools,
    requiredToolNames
  });
}

describe('detectCoaiCapabilities', () => {
  it('reports all four capabilities from the full twelve-tool shape', () => {
    const detected = detectCoaiCapabilities(COAI_ADDRESSABLE_PROFILE);

    expect(detected).toEqual({
      planReview: true,
      humanEscalation: true,
      codeReview: true,
      reconciliation: true,
      unknownToolCount: 0
    });
  });

  it('the published plan-only nine-tool server: plan works, code review does not', () => {
    const detected = detectCoaiCapabilities(COAI_PLAN_PROFILE);

    expect(detected.planReview).toBe(true);
    expect(detected.humanEscalation).toBe(true);
    expect(detected.reconciliation).toBe(true);
    expect(detected.codeReview).toBe(false);
    expect(detected.unknownToolCount).toBe(0);
  });

  it('a server missing review_plan: plan review is unavailable regardless of anything else', () => {
    const detected = detectCoaiCapabilities(
      COAI_ADDRESSABLE_PROFILE.filter((name) => name !== 'review_plan')
    );

    expect(detected.planReview).toBe(false);
    // Independent: losing review_plan does not touch code review's own three tools.
    expect(detected.codeReview).toBe(true);
  });

  it('missing exactly one addressable tool: plan and reconciliation still work, code review does not', () => {
    const detected = detectCoaiCapabilities(
      COAI_ADDRESSABLE_PROFILE.filter((name) => name !== 'round_status')
    );

    expect(detected.planReview).toBe(true);
    expect(detected.reconciliation).toBe(true);
    expect(detected.codeReview).toBe(false);
  });

  it('an unaudited extra tool is counted, but never disables an operation whose own tools are present', () => {
    const detected = detectCoaiCapabilities([...COAI_ADDRESSABLE_PROFILE, 'future_unknown_tool']);

    expect(detected.planReview).toBe(true);
    expect(detected.codeReview).toBe(true);
    expect(detected.unknownToolCount).toBe(1);
  });

  it('losing ask_human affects only human escalation', () => {
    const detected = detectCoaiCapabilities(
      COAI_ADDRESSABLE_PROFILE.filter((name) => name !== 'ask_human')
    );

    expect(detected.humanEscalation).toBe(false);
    expect(detected.planReview).toBe(true);
    expect(detected.codeReview).toBe(true);
    expect(detected.reconciliation).toBe(true);
  });

  it('an empty tool list disables everything and counts nothing as unknown', () => {
    expect(detectCoaiCapabilities([])).toEqual({
      planReview: false,
      humanEscalation: false,
      codeReview: false,
      reconciliation: false,
      unknownToolCount: 0
    });
  });

  it('the four operation constants are disjoint from each other except where documented', () => {
    // Reconciliation is a documented subset of plan review (both need `status`);
    // every other pair is disjoint, so losing one never silently touches another.
    expect(COAI_RECONCILIATION_TOOLS.every((name) => (COAI_PLAN_REVIEW_TOOLS as readonly string[]).includes(name))).toBe(true);
    expect(COAI_PLAN_REVIEW_TOOLS.some((name) => (COAI_CODE_REVIEW_TOOLS as readonly string[]).includes(name))).toBe(false);
    expect(COAI_PLAN_REVIEW_TOOLS.some((name) => (COAI_HUMAN_ESCALATION_TOOLS as readonly string[]).includes(name))).toBe(false);
    expect(COAI_CODE_REVIEW_TOOLS.some((name) => (COAI_HUMAN_ESCALATION_TOOLS as readonly string[]).includes(name))).toBe(false);
  });
});

describe('isAuditedProfile / profileOf (labelling only, never gating)', () => {
  it('recognises the two labelled shapes exactly, and nothing else', () => {
    expect(profileOf(COAI_PLAN_PROFILE)).toBe('plan');
    expect(profileOf(COAI_ADDRESSABLE_PROFILE)).toBe('addressable');
    expect(profileOf([...COAI_PLAN_PROFILE, 'reserve_round'])).toBeNull();
    expect(profileOf(COAI_PLAN_PROFILE.slice(0, 8))).toBeNull();
  });

  it('treats a duplicate as not matching, even with the right count', () => {
    const withDuplicate = [...COAI_PLAN_PROFILE.slice(0, 8), COAI_PLAN_PROFILE[0]!];
    expect(isAuditedProfile(withDuplicate, COAI_PLAN_PROFILE)).toBe(false);
  });
});

describe('computeCoaiContractFingerprint', () => {
  it('changes when a required tool’s schema tightens a property type, though the name and server version did not change', () => {
    const before = fingerprint([
      tool('run_round', { type: 'object', properties: { planText: { type: 'string' } } })
    ]);
    const after = fingerprint([
      tool('run_round', { type: 'object', properties: { planText: { type: 'number' } } })
    ]);

    expect(before).not.toBe(after);
  });

  it('is unchanged by object-key ordering inside a schema, or by the order tools were listed in', () => {
    const a = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: { repoPath: { type: 'string' }, branch: { type: 'string' } },
        required: ['repoPath', 'branch']
      }),
      tool('run_round', { type: 'object', properties: { planText: { type: 'string' } } })
    ]);
    // Same two tools, same schemas, both reordered: keys inside `reserve_round`'s
    // schema swapped, and the tools array itself listed in the opposite order.
    const b = fingerprint([
      tool('run_round', { type: 'object', properties: { planText: { type: 'string' } } }),
      tool('reserve_round', {
        type: 'object',
        required: ['repoPath', 'branch'],
        properties: { branch: { type: 'string' }, repoPath: { type: 'string' } }
      })
    ]);

    expect(a).toBe(b);
  });

  it('canonicalizeJson sorts nested object keys and normalizes required/enum/type array order', () => {
    // `required`, `enum` and a `type` union are JSON Schema SETS — listing
    // them in a different order changes nothing about what the schema means,
    // so canonicalization must not let that difference move the hash.
    const canonical = canonicalizeJson({
      type: ['string', 'null'],
      required: ['b', 'a'],
      enum: ['slow', 'fast'],
      properties: { b: { type: 'string' }, a: { type: 'number' } }
    });

    expect(JSON.stringify(canonical)).toBe(
      JSON.stringify({
        enum: ['fast', 'slow'],
        properties: { a: { type: 'number' }, b: { type: 'string' } },
        required: ['a', 'b'],
        type: ['null', 'string']
      })
    );
  });

  it('canonicalizeJson leaves every other array in its own order, including nested inside required/enum/type', () => {
    // A tuple-form `items` and a literal array value inside `const` are
    // ORDERED constructs — reordering either changes what the schema
    // requires, so canonicalization must never touch them.
    const canonical = canonicalizeJson({
      type: 'object',
      properties: {
        pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
        fixed: { const: ['first', 'second', 'third'] }
      }
    });

    expect(canonical).toEqual({
      type: 'object',
      properties: {
        fixed: { const: ['first', 'second', 'third'] },
        pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] }
      }
    });
  });

  it('fingerprints differently when an array inside a const literal is reordered, though its key is spelled "enum"', () => {
    // The exact case the schema-context split exists for: `const`'s value is
    // literal DATA, not a schema, so a key inside it that happens to be
    // spelled "enum" must never be mistaken for the schema keyword — the two
    // literal arrays [1, 2] and [2, 1] are genuinely different values.
    const first = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: { x: { const: { enum: [1, 2] } } }
      })
    ]);
    const second = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: { x: { const: { enum: [2, 1] } } }
      })
    ]);

    expect(first).not.toBe(second);
  });

  it('sorts the outer enum alternatives as a set, while preserving each alternative’s own nested array order', () => {
    const forward = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: {
          mode: {
            enum: [
              { name: 'fast', tags: ['a', 'b'] },
              { name: 'slow', tags: ['c', 'd'] }
            ]
          }
        }
      })
    ]);
    const reversed = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: {
          mode: {
            enum: [
              { name: 'slow', tags: ['c', 'd'] },
              { name: 'fast', tags: ['a', 'b'] }
            ]
          }
        }
      })
    ]);
    expect(forward).toBe(reversed);

    // But reordering an array INSIDE one alternative is a real, different
    // value — the alternative itself is data, and its own structure is
    // preserved exactly, never reordered as though it were another schema.
    const innerReordered = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: {
          mode: {
            enum: [
              { name: 'fast', tags: ['b', 'a'] },
              { name: 'slow', tags: ['c', 'd'] }
            ]
          }
        }
      })
    ]);
    expect(innerReordered).not.toBe(forward);
  });

  it('leaves default and examples arrays in their own order, treating their contents as data even under keys spelled like schema keywords', () => {
    const canonical = canonicalizeJson({
      type: 'object',
      default: { required: [2, 1] },
      examples: [{ type: ['b', 'a'] }]
    });

    expect(canonical).toEqual({
      default: { required: [2, 1] },
      examples: [{ type: ['b', 'a'] }],
      type: 'object'
    });
  });

  /**
   * `properties` is a MAP from arbitrary property NAMES to subschemas — a
   * property is free to be named `default`, `const`, `examples`, `enum`,
   * `required` or `type` without that name meaning anything about the
   * property's own subschema. Each case here is a property named after one
   * of those six keywords, whose OWN subschema has a genuine `enum` that
   * must still be treated as the order-insensitive set it is: fingerprinting
   * these differently because of what the PROPERTY happens to be called
   * would be exactly the location-blind bug this test guards against.
   */
  it.each(['default', 'const', 'examples', 'required', 'type', 'enum'] as const)(
    'treats a property named "%s" as an ordinary property, sorting its own subschema’s enum as a set',
    (propertyName) => {
      const forward = fingerprint([
        tool('reserve_round', {
          type: 'object',
          properties: { [propertyName]: { type: 'string', enum: ['a', 'b'] } }
        })
      ]);
      const reversed = fingerprint([
        tool('reserve_round', {
          type: 'object',
          properties: { [propertyName]: { type: 'string', enum: ['b', 'a'] } }
        })
      ]);

      expect(forward).toBe(reversed);
    }
  );

  it('treats a $defs/definitions entry the same way — its name never switches its own subschema into data mode', () => {
    const forward = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: { mode: { $ref: '#/$defs/default' } },
        $defs: { default: { type: 'string', enum: ['a', 'b'] } }
      })
    ]);
    const reversed = fingerprint([
      tool('reserve_round', {
        type: 'object',
        properties: { mode: { $ref: '#/$defs/default' } },
        $defs: { default: { type: 'string', enum: ['b', 'a'] } }
      })
    ]);

    expect(forward).toBe(reversed);
  });

  it('produces the same fingerprint for a required list, an enum and a type union in any order', () => {
    const forward = fingerprint([
      tool('reserve_round', {
        type: 'object',
        required: ['repoPath', 'branch', 'baseRef'],
        properties: {
          repoPath: { type: 'string' },
          branch: { type: 'string' },
          baseRef: { type: 'string' },
          mode: { enum: ['fast', 'careful', 'default'] },
          note: { type: ['string', 'null'] }
        }
      })
    ]);
    const reversed = fingerprint([
      tool('reserve_round', {
        type: 'object',
        required: ['baseRef', 'branch', 'repoPath'],
        properties: {
          repoPath: { type: 'string' },
          branch: { type: 'string' },
          baseRef: { type: 'string' },
          mode: { enum: ['default', 'careful', 'fast'] },
          note: { type: ['null', 'string'] }
        }
      })
    ]);

    expect(forward).toBe(reversed);
  });

  it('is unaffected by a tool this operation never required, whatever that tool advertises', () => {
    const required = [
      tool('reserve_round', { type: 'object', properties: { repoPath: { type: 'string' } } }),
      tool('run_round', { type: 'object', properties: { planText: { type: 'string' } } }),
      tool('round_status', { type: 'object', properties: {} })
    ];
    const requiredNames = required.map((t) => t.name);

    const withoutExtra = fingerprint(required, requiredNames);
    // An entirely unrelated tool, with a schema that would fail closed if it
    // were ever hashed in: it is not in `requiredNames`, so it must not move
    // the fingerprint at all — a server growing an unrelated capability, or
    // changing that capability's own schema, is invisible to this operation.
    const extra = tool('providers', {
      type: 'object',
      properties: { scope: { enum: ['all', 'enabled'] } },
      required: ['scope']
    });
    const withExtra = fingerprint([...required, extra], requiredNames);
    const withExtraChanged = fingerprint(
      [...required, { ...extra, inputSchema: { type: 'object', properties: {} } }],
      requiredNames
    );

    expect(withExtra).toBe(withoutExtra);
    expect(withExtraChanged).toBe(withoutExtra);
  });

  it('changes when the negotiated protocol version or the server version changes, names and schemas held fixed', () => {
    const tools = [tool('status', { type: 'object', properties: {} })];
    const base = computeCoaiContractFingerprint({
      protocolVersion: PROTOCOL_VERSION,
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      tools,
      requiredToolNames: ['status']
    });
    const differentProtocol = computeCoaiContractFingerprint({
      protocolVersion: '2025-06-18',
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      tools,
      requiredToolNames: ['status']
    });
    const differentVersion = computeCoaiContractFingerprint({
      protocolVersion: PROTOCOL_VERSION,
      serverName: SERVER_NAME,
      serverVersion: '0.23.0',
      tools,
      requiredToolNames: ['status']
    });

    expect(differentProtocol).not.toBe(base);
    expect(differentVersion).not.toBe(base);
  });

  it('throws rather than silently omitting a required tool this build never discovered', () => {
    expect(() => fingerprint([], ['run_round'])).toThrow(/run_round/);
  });
});
