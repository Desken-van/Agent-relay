import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import type { ProcessRunner } from '../adapters/process/process-runner';
import { locateExecutable } from '../adapters/process/executable-locator';

/** A known tooling failure before any verification command was started. */
export class VerificationEnvironmentError extends AgentRelayError {
  constructor(message: string) { super('TOOL_MISSING', message); }
}

/** Prepare installed tooling without running package entry points, which may download or reinstall. */
export async function prepareVerificationEnvironment(root: string, runner: ProcessRunner, signal?: AbortSignal): Promise<Record<string, string>> {
  if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'Verification preparation cancelled.');
  let modules: string;
  try { modules = await realpath(join(root, 'node_modules')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (await installed(join(modules, 'vite', 'package.json'))) {
    const git = locateExecutable('git');
    if (!git) throw new AgentRelayError('TOOL_MISSING', 'Git is required to prepare verification caches.');
    const ignored = await Promise.all(['node_modules/.vite-temp', 'node_modules/.vite'].map(path =>
      runner.run(git.path, ['check-ignore', '--quiet', '--no-index', '--', path],
        { cwd: root, signal, timeoutMs: 30_000, maxOutputBytes: 2_000 })));
    if (signal?.aborted) throw new AgentRelayError('CANCELLED', 'Verification preparation cancelled.');
    if (ignored.some(result => result.failed || result.exitCode !== 0)) {
      throw new AgentRelayError('WORKTREE_INVALID', 'Verification caches must be ignored by Git before they are prepared.');
    }
    // Creating the first directory through a Windows dependency junction can fail with ENOENT.
    // Use the resolved directory, create one component at a time, and refuse redirected caches.
    try {
      for (const parts of [['.vite-temp'], ['.vite'], ['.vite', 'vitest']]) {
        await plainDirectory(join(modules, ...parts));
      }
    } catch (error) {
      if (error instanceof AgentRelayError) throw error;
      throw new VerificationEnvironmentError('Verification cache preparation failed. Repair access to the installed Vite cache directories; the task files are preserved.');
    }
  }
  const electronPackage = join(modules, 'electron', 'package.json');
  if (!(await installed(electronPackage))) return {};
  try {
    const electronRoot = await realpath(join(modules, 'electron'));
    const pkg = JSON.parse(await readFile(electronPackage, 'utf8')) as { version?: unknown };
    const name = await readFile(join(electronRoot, 'path.txt'), 'utf8');
    if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('invalid executable');
    }
    const distribution = await realpath(join(electronRoot, 'dist'));
    const executable = await lstat(join(distribution, name));
    const version = (await readFile(join(distribution, 'version'), 'utf8')).trim().replace(/^v/, '');
    if (!executable.isFile() || executable.isSymbolicLink() || version !== pkg.version) throw new Error('incomplete distribution');
    return { ELECTRON_OVERRIDE_DIST_PATH: distribution };
  } catch {
    throw new VerificationEnvironmentError('Electron is missing or incomplete. Repair the installed Electron dependency before verification; the task files are preserved.');
  }
}

async function installed(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function plainDirectory(path: string): Promise<void> {
  try { await mkdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentRelayError('WORKTREE_INVALID', 'A verification cache is not a plain directory. No redirected cache is used.');
  }
}
