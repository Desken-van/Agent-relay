/**
 * Executable discovery.
 *
 * On Windows a missing command frequently surfaces as `exit code 1` from
 * `cmd.exe` rather than `ENOENT`, so "is this tool installed?" cannot be
 * answered reliably by trying to spawn it and reading the error. We resolve the
 * path explicitly instead, in the order the spec requires:
 *
 *   1. a path the user configured in Settings;
 *   2. a normal PATH lookup (including `.cmd` / `.exe` / `.ps1` shims);
 *   3. well-known Windows install locations.
 *
 * Deliberately absent: anything that pokes at a VS Code extension directory or
 * another application's private files.
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface LocatedExecutable {
  readonly path: string;
  readonly source: 'configured' | 'path' | 'well-known' | 'bundled';
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    if (!stats.isFile()) return false;
    accessSync(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Extensions Windows treats as executable, most specific first. */
function windowsExtensions(): string[] {
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return pathext.split(';').filter((ext) => ext.length > 0);
}

function candidateNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  if (/\.[A-Za-z0-9]+$/.test(command)) return [command];
  // Prefer .exe and .cmd — npm shims are .cmd, native installs are .exe.
  const exts = windowsExtensions();
  return [`${command}.exe`, `${command}.cmd`, ...exts.map((ext) => `${command}${ext}`), command];
}

/** Resolve `command` against PATH, honouring PATHEXT on Windows. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);
  const names = candidateNames(command);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Directory-name prefix WinGet gives the official Claude Code package.
 *
 * The full name carries a source id — `Anthropic.ClaudeCode_<source-id>` — that
 * differs per WinGet source and is not something to hard-code, so only the
 * prefix is matched.
 */
const WINGET_CLAUDE_PACKAGE_PREFIX = 'Anthropic.ClaudeCode_';

function localAppDataDir(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

/**
 * Claude Code executables inside WinGet's package-scoped directories.
 *
 * Needed because not every WinGet package gets a shim in `WinGet\Links`: the
 * Claude Code package installs into `WinGet\Packages\Anthropic.ClaudeCode_<id>\`
 * and appends *that* directory to the user PATH. A process started before the
 * install — an already-open terminal, or a shortcut holding a stale environment
 * block — never sees the PATH change, and would report Claude as missing while
 * it sits right there on disk.
 *
 * The scan is deliberately bounded: direct children of the Packages directory
 * only, name prefix must match exactly, and `claude.exe` must sit directly
 * inside. No recursion, no globbing, and nothing outside WinGet's own tree —
 * in particular never another application's private directories.
 *
 * A missing or unreadable Packages directory simply means "no candidate"; on a
 * machine without WinGet this must not be an error.
 */
export function wingetClaudePackageCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const packagesRoot = join(localAppDataDir(env), 'Microsoft', 'WinGet', 'Packages');

  let entries;
  try {
    entries = readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINGET_CLAUDE_PACKAGE_PREFIX))
    .map((entry) => entry.name)
    // Sorted so that a machine with more than one matching package directory
    // resolves the same way on every run.
    .sort()
    .map((name) => join(packagesRoot, name, 'claude.exe'));
}

/** Standard Windows install locations, checked in order of likelihood. */
export function wellKnownWindowsLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const home = homedir();
  const localAppData = localAppDataDir(env);
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const bases: string[] = [
    join(appData, 'npm'),
    // Where WinGet places a shim when a package publishes one. Checking it
    // explicitly matters because WinGet's PATH change only reaches processes
    // started afterwards: a window launched from an already-open shell would
    // otherwise report a freshly installed tool as missing. Not every package
    // uses a shim, which is what `wingetClaudePackageCandidates` covers.
    join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    join(localAppData, 'Programs', command),
    join(localAppData, 'Programs', command, 'bin'),
    join(home, '.local', 'bin'),
    join(home, `.${command}`, 'local'),
    join(home, `.${command}`, 'bin'),
    join(localAppData, command),
    join(localAppData, command, 'bin'),
    join(programFiles, command),
    join(programFiles, command, 'bin'),
    join(programFilesX86, command),
    join(programFilesX86, command, 'bin')
  ];

  // `gh` installs under "GitHub CLI", which does not follow the pattern above.
  if (command === 'gh') {
    bases.push(join(programFiles, 'GitHub CLI'), join(programFilesX86, 'GitHub CLI'), join(localAppData, 'Programs', 'GitHub CLI'));
  }

  const names = candidateNames(command);
  const results: string[] = [];
  for (const base of bases) {
    for (const name of names) {
      results.push(join(base, name));
    }
  }

  // Last, because a published shim is the more stable location when both exist.
  if (command === 'claude') {
    results.push(...wingetClaudePackageCandidates(env));
  }

  return results;
}

export interface LocateOptions {
  /** Absolute path from Settings or an environment variable. */
  readonly configuredPath?: string | null;
  /** Paths shipped with the app (e.g. the Codex binary from node_modules). */
  readonly bundledPaths?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Locate `command`, or return null when it genuinely cannot be found.
 *
 * A configured path that does not exist returns null rather than silently
 * falling through to PATH — otherwise a typo in Settings would be invisible.
 */
export function locateExecutable(command: string, options: LocateOptions = {}): LocatedExecutable | null {
  const configured = options.configuredPath?.trim();
  if (configured) {
    const absolute = isAbsolute(configured) ? configured : resolve(configured);
    return isExecutableFile(absolute) ? { path: absolute, source: 'configured' } : null;
  }

  for (const bundled of options.bundledPaths ?? []) {
    if (isExecutableFile(bundled)) return { path: bundled, source: 'bundled' };
  }

  const env = options.env ?? process.env;

  const onPath = findOnPath(command, env);
  if (onPath) return { path: onPath, source: 'path' };

  if (process.platform === 'win32') {
    // Same environment as the PATH lookup, so an injected one relocates the
    // well-known roots too and the whole search becomes testable.
    for (const candidate of wellKnownWindowsLocations(command, env)) {
      if (isExecutableFile(candidate)) return { path: candidate, source: 'well-known' };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Launching what was located                                                  */
/* -------------------------------------------------------------------------- */

export interface ExecutableLaunch {
  /** The program to spawn. */
  readonly file: string;
  /** Arguments that must precede the tool's own, or empty. */
  readonly prefixArgs: readonly string[];
  /** Environment the launch itself needs, merged over the scrubbed parent env. */
  readonly env: Readonly<Record<string, string>>;
}

/** Extensions that name a JavaScript entry point rather than a program. */
const JAVASCRIPT_ENTRY_POINT = /\.[cm]?js$/i;

/**
 * How to spawn a located path, given that Agent Relay never uses a shell.
 *
 * Most tools resolve to a native binary and are spawned directly. Some resolve
 * to a JavaScript entry point instead: an npm install of Claude Code puts
 * `cli.js` on disk and only a `.cmd`/shell shim next to it, and running that
 * shim would require the shell this application refuses to use. A `.js`, `.mjs`
 * or `.cjs` file is not executable on its own, so it is run through the runtime
 * the application is already using.
 *
 * `ELECTRON_RUN_AS_NODE` is what makes that safe in a packaged build, where
 * `process.execPath` is the Electron binary: without it, spawning `execPath`
 * would start a second copy of Agent Relay rather than run the script. Plain
 * Node ignores the variable, so one code path covers both.
 */
export function launchFor(executablePath: string): ExecutableLaunch {
  if (!JAVASCRIPT_ENTRY_POINT.test(executablePath)) {
    return { file: executablePath, prefixArgs: [], env: {} };
  }

  return {
    file: process.execPath,
    prefixArgs: [executablePath],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  };
}

/** True when a configured path was supplied but does not point at a real file. */
export function configuredPathIsBroken(configuredPath: string | null | undefined): boolean {
  const configured = configuredPath?.trim();
  if (!configured) return false;
  return !isExecutableFile(isAbsolute(configured) ? configured : resolve(configured));
}
