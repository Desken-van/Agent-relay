/**
 * Which Codex binary Agent Relay runs — one answer for execution, diagnostics and the model
 * catalogue, so the three can never disagree.
 *
 *  1. A path set in Settings (or AGENT_RELAY_CODEX_PATH) wins. If it does not name an executable
 *     file, the answer is that error — never a silent substitute.
 *  2. Otherwise the Codex the user installed, found on PATH. That PATH is the app's own minus the
 *     `node_modules/.bin` directories npm put in front for Agent Relay itself when it was started
 *     with `npm run dev` / `npm start`; otherwise `codex` would resolve to the SDK's bundled copy.
 *     On Windows only a real `.exe` counts: a `codex.cmd` npm shim cannot be spawned without a
 *     shell, which neither the SDK nor Agent Relay uses.
 *  3. Only when no installed Codex is found, the binary bundled with the SDK.
 *
 * Nothing here names a model or touches the user's Codex files (`~/.codex`).
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { locateExecutable } from '../process/executable-locator';
import { withoutOwnNodeBinaries } from '../process/process-runner';

/**
 * Platform packages that ship the Codex binary, mirroring the mapping inside
 * `@openai/codex`. The SDK resolves this itself when it spawns, but Agent Relay
 * resolves it too so that **diagnostics and execution agree**: without this,
 * Codex reports "missing" (it is not on PATH) while runs work perfectly, which
 * is the worst possible combination for a diagnostics screen.
 */
const CODEX_PLATFORM_PACKAGES: Readonly<Record<string, { pkg: string; triple: string }>> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
};

/** Absolute paths to the Codex binary that ships with the installed SDK. */
export function bundledCodexPaths(): string[] {
  const entry = CODEX_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!entry) return [];

  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';

  try {
    const requireFrom = createRequire(import.meta.url);
    const manifest = requireFrom.resolve(`${entry.pkg}/package.json`);
    return [join(dirname(manifest), 'vendor', entry.triple, 'bin', executable)];
  } catch {
    // The platform package is optional; absence just means "not bundled".
    return [];
  }
}


export type CodexExecutableSource = 'configured' | 'installed' | 'bundled';

export type CodexExecutableResolution =
  | { readonly kind: 'found'; readonly path: string; readonly source: CodexExecutableSource }
  /** A path is configured but does not name an executable file. Nothing else is tried. */
  | { readonly kind: 'configured_missing'; readonly configuredPath: string }
  | { readonly kind: 'missing' };

export interface CodexExecutableEnvironment {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly bundledPaths?: () => readonly string[];
}

export function resolveCodexExecutable(
  configuredPath: string | null | undefined,
  environment: CodexExecutableEnvironment = {}
): CodexExecutableResolution {
  const configured = configuredPath?.trim();
  if (configured) {
    const located = locateExecutable('codex', { configuredPath: configured });
    return located === null
      ? { kind: 'configured_missing', configuredPath: configured }
      : { kind: 'found', path: located.path, source: 'configured' };
  }

  const platform = environment.platform ?? process.platform;
  const installed = locateExecutable('codex', { env: withoutOwnNodeBinaries(environment.env ?? process.env) });
  if (installed !== null && (platform !== 'win32' || installed.path.toLowerCase().endsWith('.exe'))) {
    return { kind: 'found', path: installed.path, source: 'installed' };
  }

  for (const candidate of (environment.bundledPaths ?? bundledCodexPaths)()) {
    // Checked as an exact file, never as a search: a missing bundled copy must not wander off to PATH.
    const bundled = locateExecutable('codex', { configuredPath: candidate });
    if (bundled !== null) return { kind: 'found', path: bundled.path, source: 'bundled' };
  }
  return { kind: 'missing' };
}

/** One sentence for a resolution that found nothing, naming why and what to do. */
export function describeMissingCodex(resolution: Exclude<CodexExecutableResolution, { kind: 'found' }>): {
  readonly detail: string;
  readonly remediation: string;
} {
  return resolution.kind === 'configured_missing'
    ? {
        detail:
          `The Codex path set in Settings (${resolution.configuredPath}) is not an executable file. ` +
          'Agent Relay does not fall back to another Codex when a path is set.',
        remediation: 'Correct the Codex path in Settings, or clear it to use the installed Codex.'
      }
    : {
        detail: 'No Codex executable was found: none is installed on PATH and the copy bundled with the SDK is missing.',
        remediation:
          'Install the Codex CLI (`npm install -g @openai/codex`), reinstall dependencies (`npm install`), or set an explicit path in Settings.'
      };
}
