import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/container';
import { COAI_TOOL_ALLOWLIST } from '../../src/main/adapters/mcp/coai-plan-reviewer';
import {
  assertExternalPlanReviewSettings,
  configuredRuleSources,
  externalPlanReviewConfig
} from '../../src/main/services/plan-review-configuration';
import { settingsSchema, type Settings } from '../../src/shared/domain/models';

const base = (): Settings =>
  defaultSettings({ dataDir: resolve('test-data'), documentsDir: resolve('documents') });

const enabled = (overrides: Partial<Settings> = {}): Settings => ({
  ...base(),
  externalPlanReviewEnabled: true,
  coaiMcpExecutablePath: resolve('bin', 'coai-mcp.cmd'),
  coaiMcpArguments: ['--stdio'],
  ...overrides
});

describe('external plan-review settings', () => {
  it('keeps the integration opt-in', () => {
    expect(() => assertExternalPlanReviewSettings(base())).not.toThrow();
    expect(() => externalPlanReviewConfig(base())).toThrow(/disabled/i);
  });

  it('requires an absolute executable when enabled', () => {
    expect(() =>
      assertExternalPlanReviewSettings({
        ...enabled(),
        coaiMcpExecutablePath: null
      })
    ).toThrow(/absolute MCP executable/i);
  });

  it('rejects credential-shaped arguments even while disabled', () => {
    expect(() =>
      assertExternalPlanReviewSettings({
        ...base(),
        coaiMcpArguments: ['--token', 'not-a-real-secret']
      })
    ).toThrow(/credential/i);
  });

  it('rejects control characters and non-absolute process paths', () => {
    for (const patch of [
      { coaiMcpExecutablePath: `relative${String.fromCharCode(0)}.cmd` },
      { coaiMcpWorkingDirectory: 'relative' },
      { conventionsRepositoryPath: `relative${String.fromCharCode(10)}repo` }
    ]) {
      expect(() => assertExternalPlanReviewSettings({ ...base(), ...patch })).toThrow(
        /absolute path without control characters/i
      );
    }
  });

  it('requires conventions to be configured as one exact tuple', () => {
    expect(() =>
      assertExternalPlanReviewSettings({
        ...base(),
        conventionsRepositoryPath: resolve('conventions')
      })
    ).toThrow(/repository path, exact revision/i);
  });

  it('accepts full SHA-1 and SHA-256 revisions, but not abbreviations', () => {
    for (const revision of ['a'.repeat(40), 'b'.repeat(64)]) {
      expect(
        settingsSchema.safeParse({ ...base(), conventionsExpectedRevision: revision }).success
      ).toBe(true);
    }
    expect(
      settingsSchema.safeParse({ ...base(), conventionsExpectedRevision: 'a'.repeat(12) }).success
    ).toBe(false);
  });

  it('accepts dotted filenames but rejects traversal and platform paths', () => {
    const valid = {
      ...base(),
      conventionsRepositoryPath: resolve('conventions'),
      conventionsExpectedRevision: 'a'.repeat(40),
      conventionsRulePaths: ['common/coding..style.md', 'typescript/doctrine.md']
    };
    expect(() => assertExternalPlanReviewSettings(valid)).not.toThrow();

    for (const path of ['../secret.md', 'common/../secret.md', 'common\\secret.md', '/secret.md']) {
      expect(() =>
        assertExternalPlanReviewSettings({ ...valid, conventionsRulePaths: [path] })
      ).toThrow(/repository-relative POSIX/i);
    }
  });

  it('builds a fixed, shell-free Coai process boundary', () => {
    const settings = enabled({ coaiMcpWorkingDirectory: resolve('coai-work') });
    const config = externalPlanReviewConfig(settings);

    expect(config).toMatchObject({
      id: 'coai-plan-review',
      enabled: true,
      executablePath: settings.coaiMcpExecutablePath,
      args: ['--stdio'],
      cwd: settings.coaiMcpWorkingDirectory,
      allowedTools: COAI_TOOL_ALLOWLIST
    });
    expect(config).not.toHaveProperty('shell');
    expect(config).not.toHaveProperty('env');
  });

  it('binds project rules plus the exact clean conventions revision', () => {
    const conventionsRoot = resolve('conventions');
    const settings = enabled({
      conventionsRepositoryPath: conventionsRoot,
      conventionsExpectedRevision: 'c'.repeat(40),
      conventionsRulePaths: ['common/coding-style.md']
    });

    expect(configuredRuleSources(settings, resolve('project'))).toEqual([
      expect.objectContaining({ id: 'project', kind: 'project', requireClean: false }),
      {
        id: 'conventions',
        kind: 'conventions',
        rootPath: conventionsRoot,
        expectedRevision: 'c'.repeat(40),
        requireClean: true,
        paths: ['common/coding-style.md']
      }
    ]);
  });
});
