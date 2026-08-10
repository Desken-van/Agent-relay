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

import { accessSync, constants, statSync } from 'node:fs';
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

/** Standard Windows install locations, checked in order of likelihood. */
export function wellKnownWindowsLocations(command: string): string[] {
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const bases: string[] = [
    join(appData, 'npm'),
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

  const onPath = findOnPath(command, options.env ?? process.env);
  if (onPath) return { path: onPath, source: 'path' };

  if (process.platform === 'win32') {
    for (const candidate of wellKnownWindowsLocations(command)) {
      if (isExecutableFile(candidate)) return { path: candidate, source: 'well-known' };
    }
  }

  return null;
}

/** True when a configured path was supplied but does not point at a real file. */
export function configuredPathIsBroken(configuredPath: string | null | undefined): boolean {
  const configured = configuredPath?.trim();
  if (!configured) return false;
  return !isExecutableFile(isAbsolute(configured) ? configured : resolve(configured));
}
