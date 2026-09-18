import { describe, expect, it } from 'vitest';
import { specificationIdentity } from '../../src/main/services/specification-identity';

/**
 * The identity is persisted with every plan-review gate and compared by
 * equality, so it may only change when the specification changes. These hashes
 * were computed from the literal JSON below with plain `JSON.stringify` +
 * sha256 — the algorithm as it was before `scopedFilePaths` was normalized —
 * not from the code under test.
 */
const LEGACY =
  '{"title":"Add a health endpoint","summary":"Expose GET /health returning a JSON status payload.","assumptions":["The service already has an HTTP router."],"acceptanceCriteria":["GET /health responds 200 with {\\"status\\":\\"ok\\"}."],"constraints":["Do not change the existing routes."],"suggestedTests":["A test asserting GET /health returns 200."],"implementationPrompt":"Add a /health route and a test for it."}';

const LEGACY_SHA = '39f206dbe3643d223c200cd63f707e1caf0702be1a3253e7200aa36ce81e8123';
const EMPTY_SCOPE_SHA = '45a7c657298a1b95b752ba5a4ea7633b501866800505f0068e572d13bc8b36e9';
const POPULATED_SCOPE_SHA = 'a160ef4b3bfce58dcd4e5a3d7dd39b643dbd26141ed9c71312d271237509044c';

function withScope(scope: unknown): string {
  return JSON.stringify({ ...JSON.parse(LEGACY), scopedFilePaths: scope });
}

describe('specification identity', () => {
  it('keeps the hash of a specification stored without scopedFilePaths', () => {
    const identity = specificationIdentity(LEGACY);
    expect(identity.canonical).toBe(LEGACY);
    expect(identity.sha256).toBe(LEGACY_SHA);
  });

  it('still hands callers the normalized specification for a legacy value', () => {
    expect(specificationIdentity(LEGACY).specification.scopedFilePaths).toEqual([]);
  });

  it('keeps an explicitly stored empty scope distinct from an absent one', () => {
    const identity = specificationIdentity(withScope([]));
    expect(identity.sha256).toBe(EMPTY_SCOPE_SHA);
    expect(identity.sha256).not.toBe(LEGACY_SHA);
    expect(identity.specification.scopedFilePaths).toEqual([]);
  });

  it('hashes a populated scope unchanged', () => {
    const identity = specificationIdentity(withScope(['docs/manual-test.md']));
    expect(identity.sha256).toBe(POPULATED_SCOPE_SHA);
    expect(identity.specification.scopedFilePaths).toEqual(['docs/manual-test.md']);
  });

  it('hashes the schema key order, not the stored key order, and ignores keys it does not know', () => {
    const stored = JSON.parse(LEGACY) as Record<string, unknown>;
    const shuffled = JSON.stringify(Object.fromEntries([...Object.entries(stored)].reverse()));
    const withUnknown = JSON.stringify({ ...stored, somethingElse: 'stripped by the schema' });

    expect(specificationIdentity(shuffled).sha256).toBe(LEGACY_SHA);
    expect(specificationIdentity(withUnknown).sha256).toBe(LEGACY_SHA);

    const populated = JSON.parse(withScope(['docs/manual-test.md'])) as Record<string, unknown>;
    const populatedShuffled = JSON.stringify(Object.fromEntries([...Object.entries(populated)].reverse()));
    expect(specificationIdentity(populatedShuffled).sha256).toBe(POPULATED_SCOPE_SHA);
  });

  it('is stable across repeated reads of the same stored value', () => {
    expect(specificationIdentity(LEGACY).sha256).toBe(specificationIdentity(LEGACY).sha256);
  });

  it('still refuses a specification that is not valid', () => {
    expect(() => specificationIdentity('{"title":"x"}')).toThrow();
    expect(() => specificationIdentity(null)).toThrow(/no specification/);
    expect(() => specificationIdentity(withScope(null))).toThrow();
  });
});
