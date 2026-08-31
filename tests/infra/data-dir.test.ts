import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR_ENV_VAR,
  prepareDataDirOverride,
  resolveDataDirOverride
} from '../../src/main/infra/data-dir';

/**
 * The override is what keeps a test run out of the real profile. If it resolved
 * differently in two places, or failed quietly, test data would land in the
 * user's own Electron profile — the exact accident it exists to prevent.
 */
describe('AGENT_RELAY_DATA_DIR resolution', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-relay-datadir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is null when the variable is absent', () => {
    expect(resolveDataDirOverride({})).toBeNull();
  });

  it('is null when the variable is empty or only whitespace', () => {
    expect(resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: '' })).toBeNull();
    expect(resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: '   ' })).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const target = join(root, 'data');
    expect(resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: `  ${target}  ` })).toBe(target);
  });

  it('returns an absolute path unchanged apart from normalisation', () => {
    const target = join(root, 'data');
    expect(resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: target })).toBe(resolve(target));
  });

  it('resolves a relative value against the working directory', () => {
    const resolved = resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: 'relative-data-dir' });
    expect(resolved).toBe(resolve('relative-data-dir'));
  });

  it('does not touch the filesystem while resolving', () => {
    const target = join(root, 'not-created-yet');
    resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: target });
    expect(existsSync(target)).toBe(false);
  });
});

describe('AGENT_RELAY_DATA_DIR preparation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-relay-datadir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null and creates nothing when unset', () => {
    expect(prepareDataDirOverride({})).toBeNull();
  });

  it('creates the directory, including missing parents', () => {
    const target = join(root, 'nested', 'run-1');
    expect(prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target })).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('accepts a directory that already exists', () => {
    const target = join(root, 'existing');
    prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target });
    expect(prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target })).toBe(target);
  });

  it('fails loudly when the override names an existing file', () => {
    const target = join(root, 'a-file');
    writeFileSync(target, 'not a directory');

    expect(() => prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target })).toThrow(
      /AGENT_RELAY_DATA_DIR/
    );
  });

  it('reports the offending path and a remediation when it fails', () => {
    const target = join(root, 'a-file');
    writeFileSync(target, 'not a directory');

    try {
      prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('VALIDATION_FAILED');
      expect((error as Error).message).toContain(target);
      expect((error as { remediation?: string }).remediation).toMatch(/writable directory|directory/);
    }
  });

  it('resolves to the same path the pure resolver reports', () => {
    // The database and Electron's userData must never disagree about where the
    // override points, so both go through one resolver.
    const target = join(root, 'agreement');
    expect(prepareDataDirOverride({ [DATA_DIR_ENV_VAR]: target })).toBe(
      resolveDataDirOverride({ [DATA_DIR_ENV_VAR]: target })
    );
  });
});
