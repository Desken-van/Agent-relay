import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexSdkAdapter } from '../../src/main/adapters/codex/codex-adapter';
import { resolveCodexExecutable } from '../../src/main/adapters/codex/codex-executable';
import type { ProcessResult, ProcessRunner } from '../../src/main/adapters/process/process-runner';

let base: string;

/** An executable file named `name` in its own new directory; returns that directory. */
function installAt(directory: string, name = process.platform === 'win32' ? 'codex.exe' : 'codex'): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return directory;
}

const pathOf = (...directories: string[]): NodeJS.ProcessEnv => ({ PATH: directories.join(delimiter), PATHEXT: '.EXE;.CMD' });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-relay-codex-executable-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('which Codex Agent Relay runs', () => {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  it('a configured path wins over an installed and a bundled Codex', () => {
    const configured = join(installAt(join(base, 'configured')), executableName);
    const installed = installAt(join(base, 'installed'));
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    expect(resolveCodexExecutable(configured, { env: pathOf(installed), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: configured, source: 'configured' });
  });

  it('a configured path that is not an executable file is that error: nothing else is substituted', () => {
    const installed = installAt(join(base, 'installed'));
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    const missing = join(base, 'nowhere', executableName);
    expect(resolveCodexExecutable(missing, { env: pathOf(installed), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'configured_missing', configuredPath: missing });
  });

  it('without a configured path, the installed Codex on PATH wins over the bundled copy', () => {
    const installed = installAt(join(base, 'installed'));
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    expect(resolveCodexExecutable(null, { env: pathOf(installed), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: join(installed, executableName), source: 'installed' });
    expect(resolveCodexExecutable('   ', { env: pathOf(installed), bundledPaths: () => [bundled] }))
      .toMatchObject({ source: 'installed' });
  });

  it('started by npm, Agent Relay\'s own node_modules/.bin is skipped: its bundled Codex is not "installed"', () => {
    // npm puts the app's own node_modules/.bin (which holds the SDK's codex) in front of PATH.
    const own = resolve('node_modules', '.bin');
    const installed = installAt(join(base, 'installed'));
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    expect(resolveCodexExecutable(null, { env: pathOf(own, installed), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: join(installed, executableName), source: 'installed' });
    // With nothing else installed, the answer is the bundled copy by name, not a PATH hit.
    expect(resolveCodexExecutable(null, { env: pathOf(own), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: bundled, source: 'bundled' });
  });

  it('falls back to the bundled copy only when nothing is installed, and reports missing when neither exists', () => {
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    expect(resolveCodexExecutable(null, { env: pathOf(join(base, 'empty')), bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: bundled, source: 'bundled' });
    expect(resolveCodexExecutable(null, { env: pathOf(join(base, 'empty')), bundledPaths: () => [join(base, 'gone', executableName)] }))
      .toEqual({ kind: 'missing' });
    expect(resolveCodexExecutable(null, { env: pathOf(join(base, 'empty')), bundledPaths: () => [] }))
      .toEqual({ kind: 'missing' });
  });

  it('on Windows an installed Codex counts only as an .exe: an npm .cmd shim cannot be spawned without a shell', () => {
    const shim = installAt(join(base, 'npm-shim'), executableName);
    const bundled = join(installAt(join(base, 'bundled')), executableName);
    // On this host the PATH hit is named `codex` (no .exe), which is exactly what Windows must refuse.
    if (process.platform === 'win32') return;
    expect(resolveCodexExecutable(null, { env: pathOf(shim), platform: 'win32', bundledPaths: () => [bundled] }))
      .toEqual({ kind: 'found', path: bundled, source: 'bundled' });
    expect(resolveCodexExecutable(null, { env: pathOf(shim), platform: 'linux', bundledPaths: () => [bundled] }))
      .toMatchObject({ source: 'installed' });
  });
});

describe('Codex diagnostics and execution use the same answer', () => {
  const unusedRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> { throw new Error('nothing should be spawned'); }
  };

  it('a broken configured path is reported as such, naming it, and nothing is spawned', async () => {
    const missing = join(base, 'nowhere', 'codex');
    const diagnostic = await new CodexSdkAdapter(unusedRunner, { configuredPath: missing }).diagnose();
    expect(diagnostic).toMatchObject({ tool: 'codex', status: 'missing', executablePath: missing, version: null });
    expect(diagnostic.detail).toContain(missing);
    expect(diagnostic.detail).toMatch(/does not fall back/);
    expect(diagnostic.remediation).toMatch(/clear it to use the installed Codex/);
  });

  it('reports which Codex it found and where it came from', async () => {
    const configured = join(installAt(join(base, 'configured')), process.platform === 'win32' ? 'codex.exe' : 'codex');
    const runner: ProcessRunner = {
      async run(_file, args): Promise<ProcessResult> {
        const stdout = args[0] === '--version' ? 'codex-cli 9.9.9' : 'Logged in using ChatGPT';
        return { command: 'codex', exitCode: 0, stdout, stderr: '', timedOut: false, cancelled: false, durationMs: 1, failed: false };
      }
    };
    const diagnostic = await new CodexSdkAdapter(runner, { configuredPath: configured }).diagnose();
    expect(diagnostic).toMatchObject({ status: 'ok', executablePath: configured, version: 'codex-cli 9.9.9' });
    expect(diagnostic.detail).toContain('(path set in Settings)');
  });
});
