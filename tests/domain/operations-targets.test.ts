/**
 * The target contract.
 *
 * A registry entry is the one place an operator describes something outside
 * Agent Relay, so it is also the one place a secret or an executable could be
 * smuggled in under a friendly field name. These tests are mostly about what the
 * shape refuses.
 */

import { describe, expect, it } from 'vitest';
import {
  OPERATION_ADAPTER_TYPES,
  OPERATION_CONFIG_VERSION,
  OPERATION_ENVIRONMENTS,
  adapterAcceptsCredentialRef,
  canonicalConfigJson,
  credentialRefSchema,
  isAbsolutePathLike,
  newOperationTargetSchema,
  normalizeTargetPath,
  operationTargetPatchSchema,
  parseTargetConfig,
  type OperationTargetConfig
} from '../../src/shared/domain/operations';

const validConfig: OperationTargetConfig = {
  version: OPERATION_CONFIG_VERSION,
  adapterType: 'local_sqlite',
  databasePath: 'C:\\data\\reports.sqlite'
};

const validTarget = {
  name: 'Reporting snapshot',
  environment: 'local' as const,
  config: validConfig
};

describe('registering a target', () => {
  it('accepts a complete, well-formed one', () => {
    const parsed = newOperationTargetSchema.parse(validTarget);

    expect(parsed.name).toBe('Reporting snapshot');
    expect(parsed.environment).toBe('local');
    expect(parsed.config.adapterType).toBe('local_sqlite');
    expect(parsed.config.databasePath).toBe('C:\\data\\reports.sqlite');
  });

  it('requires the environment to be stated, never inferred', () => {
    // A name or a path can say "prod" and mean nothing. Making the operator
    // choose puts the answer on record as a decision rather than a guess.
    expect(() => newOperationTargetSchema.parse({ ...validTarget, environment: undefined })).toThrow();
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, environment: 'prod-ish' })
    ).toThrow();

    const inferable = newOperationTargetSchema.parse({
      name: 'production customer database',
      environment: 'local',
      config: { ...validConfig, databasePath: '/srv/production/live.sqlite' }
    });
    // Neither the name nor the path moved it out of `local`.
    expect(inferable.environment).toBe('local');
  });

  it('takes the adapter type from an enum, not from a string', () => {
    expect(OPERATION_ADAPTER_TYPES).toEqual(['local_sqlite']);
    for (const adapterType of ['postgres', 'shell', './my-adapter.js', 'local_sqlite ']) {
      expect(() =>
        newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, adapterType } })
      ).toThrow();
    }
  });

  it('rejects a config version it does not know', () => {
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, version: 2 } })
    ).toThrow();
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, version: 0 } })
    ).toThrow();
  });

  it('refuses fields the shape does not declare', () => {
    // `.strict()` is what stops a password, a host or a connection string being
    // carried along beside the fields that are allowed.
    for (const extra of [
      { password: 'hunter2' },
      { connectionString: 'postgres://user:pw@host/db' },
      { token: 'abc' },
      { command: 'rm -rf /' }
    ]) {
      expect(() =>
        newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, ...extra } })
      ).toThrow();
      expect(() => newOperationTargetSchema.parse({ ...validTarget, ...extra })).toThrow();
    }
  });
});

describe('the database path', () => {
  it('must be absolute', () => {
    expect(isAbsolutePathLike('C:\\data\\x.sqlite')).toBe(true);
    expect(isAbsolutePathLike('/var/lib/x.sqlite')).toBe(true);
    expect(isAbsolutePathLike('\\\\server\\share\\x.sqlite')).toBe(true);
    expect(isAbsolutePathLike('data/x.sqlite')).toBe(false);
    expect(isAbsolutePathLike('./x.sqlite')).toBe(false);

    for (const databasePath of ['reports.sqlite', './reports.sqlite', 'data\\reports.sqlite', '']) {
      expect(() =>
        newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, databasePath } })
      ).toThrow();
    }
  });

  it('refuses relative segments rather than resolving them', () => {
    // Stored once, read much later: a `..` would make what the target points at
    // depend on where the process happened to be standing.
    for (const databasePath of [
      'C:\\data\\..\\windows\\x.sqlite',
      '/var/lib/../../etc/x.sqlite',
      '/var/./lib/x.sqlite'
    ]) {
      expect(() =>
        newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, databasePath } })
      ).toThrow();
    }
  });

  it('refuses control characters, including NUL', () => {
    for (const code of [0, 9, 10, 13, 27, 0x7f]) {
      const databasePath = `C:\\data\\${String.fromCharCode(code)}x.sqlite`;
      expect(() =>
        newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, databasePath } })
      ).toThrow();
    }
  });

  it('is bounded', () => {
    const databasePath = `C:\\${'a'.repeat(5000)}.sqlite`;
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, config: { ...validConfig, databasePath } })
    ).toThrow();
  });

  it('normalises to one spelling', () => {
    expect(normalizeTargetPath('C:\\\\data\\\\x.sqlite')).toBe('C:\\data\\x.sqlite');
    expect(normalizeTargetPath('/var//lib///x.sqlite')).toBe('/var/lib/x.sqlite');
    expect(normalizeTargetPath('/var/lib/')).toBe('/var/lib');
    // A root keeps its separator; it is not a directory name with a stray slash.
    expect(normalizeTargetPath('/')).toBe('/');
    expect(normalizeTargetPath('C:\\')).toBe('C:\\');
    // UNC keeps both leading separators.
    expect(normalizeTargetPath('\\\\server\\share\\x.sqlite')).toBe('\\\\server\\share\\x.sqlite');

    const parsed = newOperationTargetSchema.parse({
      ...validTarget,
      config: { ...validConfig, databasePath: '/var//lib/x.sqlite/' }
    });
    expect(parsed.config.databasePath).toBe('/var/lib/x.sqlite');
  });
});

describe('the name', () => {
  it('is bounded and free of control characters', () => {
    expect(() => newOperationTargetSchema.parse({ ...validTarget, name: '' })).toThrow();
    expect(() => newOperationTargetSchema.parse({ ...validTarget, name: 'a'.repeat(200) })).toThrow();
    expect(() => newOperationTargetSchema.parse({ ...validTarget, name: 'two\nlines' })).toThrow();
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, name: `nul${String.fromCharCode(0)}` })
    ).toThrow();
  });

  it('is trimmed, and may not be only whitespace', () => {
    expect(newOperationTargetSchema.parse({ ...validTarget, name: '  Reports  ' }).name).toBe('Reports');
    expect(() => newOperationTargetSchema.parse({ ...validTarget, name: '   ' })).toThrow();
  });
});

describe('the credential reference', () => {
  it('accepts an identifier', () => {
    for (const ref of ['vault:reporting/db', 'AWS_PROFILE.reporting', 'ref-1', 'a']) {
      expect(credentialRefSchema.parse(ref)).toBe(ref);
    }
  });

  it('refuses anything shaped like the secret itself', () => {
    // Assembled rather than written out, so no continuous token-shaped literal
    // exists in this file. None of these is real.
    const token = ['gh', 'p', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const apiKey = ['sk', '-', 'ant', '-', 'a1b2c3d4e5f6g7h8i9j0k1l2'].join('');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1'].join('.');

    for (const value of [token, apiKey, jwt]) {
      expect(() => credentialRefSchema.parse(value)).toThrow();
    }
  });

  it('refuses shapes a secret travels in', () => {
    for (const value of [
      'postgres://user:password@host/db',
      'PASSWORD=hunter2',
      'Bearer abcdef1234567890',
      'has spaces',
      'has@at',
      'query?a=b',
      'anchor#frag'
    ]) {
      expect(() => credentialRefSchema.parse(value)).toThrow();
    }
  });

  it('is refused entirely for an adapter that opens a file by path', () => {
    expect(adapterAcceptsCredentialRef('local_sqlite')).toBe(false);
    expect(() =>
      newOperationTargetSchema.parse({ ...validTarget, credentialRef: 'vault:anything' })
    ).toThrow(/accepts no credential reference/);

    // Null and omitted are both fine; there is simply nothing to name.
    expect(newOperationTargetSchema.parse({ ...validTarget, credentialRef: null }).credentialRef).toBeNull();
    expect(newOperationTargetSchema.parse(validTarget).credentialRef).toBeUndefined();
  });
});

describe('the stored config', () => {
  it('has one canonical spelling', () => {
    const json = canonicalConfigJson(validConfig);
    expect(json).toBe(
      '{"version":1,"adapterType":"local_sqlite","databasePath":"C:\\\\data\\\\reports.sqlite"}'
    );
    // Key order in the input cannot change the bytes on disk.
    expect(
      canonicalConfigJson({
        databasePath: validConfig.databasePath,
        adapterType: 'local_sqlite',
        version: OPERATION_CONFIG_VERSION
      })
    ).toBe(json);
  });

  it('round-trips', () => {
    expect(parseTargetConfig(canonicalConfigJson(validConfig))).toEqual(validConfig);
  });

  it('fails closed on a row this build cannot read', () => {
    // What a downgrade sees. Refusing is safe; guessing is not.
    expect(() => parseTargetConfig('{"version":9,"adapterType":"local_sqlite","databasePath":"/x"}')).toThrow();
    expect(() => parseTargetConfig('{"version":1,"adapterType":"postgres","host":"db"}')).toThrow();
    expect(() => parseTargetConfig('not json')).toThrow();
    expect(() => parseTargetConfig('[]')).toThrow();
  });
});

describe('updating a target', () => {
  it('cannot change identity', () => {
    // Neither `id` nor `adapterType` is a field of the patch at all: a
    // diagnostic run refers to a target by id and was produced by one kind of
    // adapter, so moving either would leave an audit row describing something
    // that no longer exists.
    expect(() => operationTargetPatchSchema.parse({ id: 'other' })).toThrow();
    expect(() => operationTargetPatchSchema.parse({ adapterType: 'local_sqlite' })).toThrow();
  });

  it('must actually change something', () => {
    expect(() => operationTargetPatchSchema.parse({})).toThrow();
    expect(operationTargetPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('validates a replacement config exactly as it validates a new one', () => {
    expect(() =>
      operationTargetPatchSchema.parse({ config: { ...validConfig, databasePath: 'relative.sqlite' } })
    ).toThrow();
    expect(operationTargetPatchSchema.parse({ config: validConfig }).config).toEqual(validConfig);
  });

  it('knows every environment it is allowed to name', () => {
    expect(OPERATION_ENVIRONMENTS).toEqual(['local', 'staging', 'production']);
    for (const environment of OPERATION_ENVIRONMENTS) {
      expect(operationTargetPatchSchema.parse({ environment }).environment).toBe(environment);
    }
  });
});
