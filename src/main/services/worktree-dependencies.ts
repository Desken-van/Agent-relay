import { copyFile, lstat, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  type WorktreeDependencyInstallOutcome,
  type WorktreeDependencyInstallOutcomeKind,
  WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES,
  type WorktreeDependencyStatus
} from '../../shared/domain/worktree-dependencies';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { AgentProgressEvent } from '../ports';
import type { ProcessRunner } from '../adapters/process/process-runner';
import { isSamePath } from './path-safety';

export interface WorktreeDependencyTarget {
  readonly repositoryPath: string;
  readonly worktreePath: string;
}

export interface WorktreeDependencyPreparer {
  prepare(target: WorktreeDependencyTarget): Promise<void>;
}

/**
 * The read-only status check and the actionable install step. Kept separate
 * from {@link WorktreeDependencyPreparer} so existing callers/fakes that only
 * ever needed `prepare()` are unaffected by this capability's addition.
 */
export interface WorktreeDependencyInstaller {
  checkStatus(target: WorktreeDependencyTarget): Promise<WorktreeDependencyStatus>;
  installDependencies(
    target: WorktreeDependencyTarget,
    signal: AbortSignal,
    timeoutMs: number,
    maxOutputBytes: number,
    progress: (event: AgentProgressEvent) => void
  ): Promise<WorktreeDependencyInstallOutcome>;
}

const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb'
] as const;

/** Every manifest name that names a package manager other than npm. */
const NON_NPM_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'] as const;

const WINDOWS_NATIVE_HELPERS = [
  'agent-relay-windows-job.exe',
  'agent-relay-fs-guard.exe'
] as const;

async function bytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await bytes(path)) !== null;
}

function sameManifest(name: (typeof MANIFESTS)[number], left: Buffer, right: Buffer): boolean {
  if (left.equals(right)) return true;
  if (name === 'bun.lockb') return false;
  // Git may materialise the same tracked text with LF or CRLF in two Windows
  // checkouts. Package managers treat those forms identically.
  return left.toString('utf8').replace(/\r\n/g, '\n') === right.toString('utf8').replace(/\r\n/g, '\n');
}

async function existingNodeModules(path: string): Promise<'missing' | 'directory' | 'link'> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return 'link';
    if (value.isDirectory()) return 'directory';
    throw new AgentRelayError('WORKTREE_INVALID', 'The worktree node_modules path is not a directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Which package manager the WORKTREE's own lockfile names, or `null` if none is present at all. */
async function detectWorktreeLockfile(worktreePath: string): Promise<'npm' | (typeof NON_NPM_LOCKFILES)[number] | null> {
  for (const name of NPM_LOCKFILES) {
    if (await exists(join(worktreePath, name))) return 'npm';
  }
  for (const name of NON_NPM_LOCKFILES) {
    if (await exists(join(worktreePath, name))) return name;
  }
  return null;
}

/**
 * Makes an isolated Git worktree runnable without downloading a second copy of
 * dependencies where possible, and can install a task-local copy where it is
 * not: it reuses the registered checkout's existing node_modules only when
 * both checkouts describe the same dependency graph and Git proves the link
 * is ignored; otherwise `installDependencies` runs a bounded, cancellable
 * `npm ci` scoped to the exact task worktree.
 */
export class LocalWorktreeDependencyPreparer implements WorktreeDependencyPreparer, WorktreeDependencyInstaller {
  constructor(private readonly runner: ProcessRunner) {}

  /**
   * Read-only: determines the current dependency state without creating,
   * deleting, or modifying anything. `prepare()` below performs the actual
   * fast-link mutation when this reports the link is safe to create; this
   * method never does.
   */
  async checkStatus({ repositoryPath, worktreePath }: WorktreeDependencyTarget): Promise<WorktreeDependencyStatus> {
    if (!(await exists(join(worktreePath, 'package.json')))) {
      return { state: 'not_node_project', detail: 'This task worktree has no package.json.' };
    }

    const target = join(worktreePath, 'node_modules');
    const source = join(repositoryPath, 'node_modules');
    const targetKind = await existingNodeModules(target);

    if (targetKind === 'directory') {
      return { state: 'ready_local', detail: 'Dependencies are installed locally in this task worktree.' };
    }

    if (targetKind === 'link') {
      let actual: string;
      try {
        actual = await realpath(target);
      } catch {
        return { state: 'link_broken', detail: 'The worktree node_modules link is broken.' };
      }
      const expected = await realpath(source).catch(() => null);
      if (expected === null || !isSamePath(actual, expected)) {
        return { state: 'link_broken', detail: 'The worktree node_modules link points outside the registered project checkout.' };
      }
      return { state: 'ready_linked', detail: 'Dependencies are linked from the registered checkout.' };
    }

    // targetKind === 'missing' from here. The fast-link path itself is
    // package-manager-agnostic (it only ever symlinks node_modules), so the
    // worktree's lockfile is checked only at the point a blocker would be
    // reported that `installDependencies` (npm-only) would need to resolve —
    // never while the link is still viable.
    let registeredHasNodeModules = false;
    try {
      registeredHasNodeModules = (await lstat(source)).isDirectory();
    } catch {
      registeredHasNodeModules = false;
    }
    if (!registeredHasNodeModules) {
      const unsupported = await this.unsupportedLockfileStatus(worktreePath);
      if (unsupported) return unsupported;
      return { state: 'registered_missing', detail: 'Project dependencies are not installed in the registered checkout.' };
    }

    for (const name of MANIFESTS) {
      const [repositoryBytes, worktreeBytes] = await Promise.all([
        bytes(join(repositoryPath, name)),
        bytes(join(worktreePath, name))
      ]);
      const mismatched = (repositoryBytes === null) !== (worktreeBytes === null) ||
        (repositoryBytes !== null && worktreeBytes !== null && !sameManifest(name, repositoryBytes, worktreeBytes));
      if (mismatched) {
        const unsupported = await this.unsupportedLockfileStatus(worktreePath);
        if (unsupported) return unsupported;
        return { state: 'manifest_mismatch', detail: 'The worktree dependency manifest differs from the registered checkout.' };
      }
    }

    return { state: 'ready_linked', detail: 'Dependencies can be linked from the registered checkout.' };
  }

  /** `null` when the worktree's lockfile is npm's (or absent — reported as `registered_missing`/`manifest_mismatch` instead, matching existing behavior). */
  private async unsupportedLockfileStatus(worktreePath: string): Promise<WorktreeDependencyStatus | null> {
    const lockfile = await detectWorktreeLockfile(worktreePath);
    if (lockfile === 'npm' || lockfile === null) return null;
    return {
      state: 'unsupported_package_manager',
      detail: `This worktree uses "${lockfile}", which this build does not install automatically.`
    };
  }

  async prepare(target: WorktreeDependencyTarget): Promise<void> {
    const status = await this.checkStatus(target);
    switch (status.state) {
      case 'not_node_project':
        return;
      case 'ready_local':
        await this.prepareWindowsNativeHelpers(target.repositoryPath, target.worktreePath);
        return;
      case 'link_broken':
        throw new AgentRelayError('WORKTREE_INVALID', status.detail, {
          remediation: 'Remove the broken link and retry the task.'
        });
      case 'ready_linked':
        break; // fast-link path below, whether already linked or newly eligible.
      case 'registered_missing':
        throw new AgentRelayError('TOOL_MISSING', status.detail, {
          remediation: 'Run `npm ci` in the project folder once, then retry this action.'
        });
      case 'manifest_mismatch':
        throw new AgentRelayError('VALIDATION_FAILED', status.detail, {
          remediation: 'Use "Install dependencies in task worktree" to install a local copy for this task.'
        });
      case 'unsupported_package_manager':
        throw new AgentRelayError('VALIDATION_FAILED', status.detail, {
          remediation: 'Install dependencies for this worktree manually with its own package manager.'
        });
    }

    const { repositoryPath, worktreePath } = target;
    const nodeModulesTarget = join(worktreePath, 'node_modules');
    if (await existingNodeModules(nodeModulesTarget) === 'link') {
      // Idempotent: checkStatus already proved this points at the registered
      // checkout's real node_modules.
      await this.prepareWindowsNativeHelpers(repositoryPath, worktreePath);
      return;
    }

    const source = join(repositoryPath, 'node_modules');
    await this.assertIgnored(worktreePath, 'node_modules/.agent-relay-dependency-probe', 'node_modules');
    try {
      await symlink(await realpath(source), nodeModulesTarget, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // A concurrent preparation may have won the race. Accept only the exact
      // link we would have created; every other EEXIST remains a hard refusal.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const [actual, expected] = await Promise.all([realpath(nodeModulesTarget), realpath(source)]);
        if (isSamePath(actual, expected)) {
          await this.prepareWindowsNativeHelpers(repositoryPath, worktreePath);
          return;
        }
      }
      throw error;
    }

    await this.prepareWindowsNativeHelpers(repositoryPath, worktreePath);
  }

  /**
   * Installs a task-local copy of dependencies with `npm ci`, scoped
   * exactly to `target.worktreePath` and never touching the registered
   * checkout. Refuses (fail-closed, no process spawned) unless
   * {@link checkStatus} currently reports a state this can actually resolve —
   * in particular, it never runs against `ready_local`/`ready_linked`
   * (nothing to fix, and never risks a directory that already has usable
   * content) or `not_node_project`/`unsupported_package_manager` (nothing
   * this method can safely do).
   */
  async installDependencies(
    target: WorktreeDependencyTarget,
    signal: AbortSignal,
    timeoutMs: number,
    maxOutputBytes: number,
    progress: (event: AgentProgressEvent) => void
  ): Promise<WorktreeDependencyInstallOutcome> {
    if (signal.aborted) {
      return this.installOutcome('cancelled', 'Dependency installation was cancelled.', await this.checkStatus(target));
    }

    const before = await this.checkStatus(target);
    if (!WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES.has(before.state)) {
      return this.installOutcome('refused', `Nothing to install: ${before.detail}`, before);
    }

    // Re-confirm immediately before the irreversible mutation rather than
    // trusting the read above stayed true: closes the window between it and
    // this write for both a lockfile that changed and a node_modules
    // directory that appeared (a real directory would mean `checkStatus` now
    // reports `ready_local`/`ready_linked`, neither of which is an
    // installable blocker) since it was read.
    const immediatelyBefore = await this.checkStatus(target);
    if (!WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES.has(immediatelyBefore.state)) {
      return this.installOutcome(
        'refused',
        `The worktree changed since the last check; nothing was run. ${immediatelyBefore.detail}`,
        immediatelyBefore
      );
    }

    const node = locateExecutable('node');
    const npm = locateExecutable('npm');
    if (!node || !npm) {
      throw new AgentRelayError('TOOL_MISSING', 'Install Node.js and npm to install dependencies.');
    }
    // Never execute a Windows .cmd shim or interpolate a shell command — the
    // same resolution `WorktreeVerification.execute` uses for `npm run verify`.
    const npmCli = process.platform === 'win32'
      ? join(dirname(npm.path), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : await realpath(npm.path);
    await lstat(npmCli);

    progress({ type: 'log', text: 'Command: npm ci (task worktree only)' });
    const result = await this.runner.run(node.path, [npmCli, 'ci'], {
      cwd: target.worktreePath,
      signal,
      timeoutMs,
      maxOutputBytes,
      onLine: (text) => progress({ type: 'log', text }),
      onStderrLine: (text) => progress({ type: 'log', text })
    });

    if (result.cancelled || signal.aborted) {
      await this.cleanupFailedInstall(target);
      return this.installOutcome('cancelled', 'Dependency installation was cancelled.', await this.checkStatus(target));
    }
    if (result.timedOut) {
      await this.cleanupFailedInstall(target);
      return this.installOutcome('timed_out', 'Dependency installation timed out.', await this.checkStatus(target));
    }
    if (result.failed || result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      // `npm ci` refuses outright when package.json and its lockfile are not
      // in sync (EUSAGE) — a different, more specific fact than a generic
      // install failure, and one this method must not paper over by silently
      // running `npm install` instead (that would rewrite the worktree's own
      // lockfile unprompted).
      const driftedManifest = /EUSAGE|in sync|can only install packages when/i.test(combined);
      await this.cleanupFailedInstall(target);
      const after = await this.checkStatus(target);
      return this.installOutcome(
        driftedManifest ? 'manifest_drift' : 'package_manager_failed',
        driftedManifest
          ? 'package.json and its lockfile are out of sync in this worktree. Update the lockfile (e.g. `npm install`) or restore the committed one before installing.'
          : `npm ci failed (exit ${result.exitCode ?? 'unknown'}). See the operation log for details.`,
        after
      );
    }

    const after = await this.checkStatus(target);
    if (after.state !== 'ready_local' && after.state !== 'ready_linked') {
      return this.installOutcome(
        'package_manager_failed',
        'npm ci reported success, but dependencies still are not usable in this worktree.',
        after
      );
    }
    await this.prepareWindowsNativeHelpers(target.repositoryPath, target.worktreePath);
    return this.installOutcome('succeeded', 'Dependencies installed in the task worktree.', after);
  }

  /**
   * `npm ci` can be killed (cancellation, timeout) or exit non-zero after it
   * has already created a partially populated `node_modules`. Left in place,
   * that directory would make a later {@link checkStatus} report `ready_local`
   * even though nothing usable was installed, and — because `ready_local` is
   * not an installable blocker state — permanently block retrying. Remove
   * only a plain directory at the exact task-worktree path; a symlink (the
   * fast-link this method never creates) is left untouched, and a removal
   * failure is swallowed since it leaves status no worse than before this
   * cleanup existed.
   */
  private async cleanupFailedInstall(target: WorktreeDependencyTarget): Promise<void> {
    const nodeModulesTarget = join(target.worktreePath, 'node_modules');
    if (await existingNodeModules(nodeModulesTarget) !== 'directory') return;
    try {
      await rm(nodeModulesTarget, { recursive: true, force: true });
    } catch {
      // Best-effort: a locked file on a lingering handle leaves the stale
      // directory in place, which checkStatus already tolerated before this
      // cleanup was added.
    }
  }

  private installOutcome(
    kind: WorktreeDependencyInstallOutcomeKind,
    detail: string,
    status: WorktreeDependencyStatus
  ): WorktreeDependencyInstallOutcome {
    return { kind, detail, status };
  }

  /**
   * node-gyp places Agent Relay's native Windows helpers outside node_modules.
   * A dependency junction alone therefore cannot run the process-contract and
   * Ornith containment tests in a worktree. Copy only the known ignored,
   * locally built binaries from the registered checkout; never copy the whole
   * build directory, whose other outputs must remain isolated per worktree.
   */
  private async prepareWindowsNativeHelpers(repositoryPath: string, worktreePath: string): Promise<void> {
    if (process.platform !== 'win32') return;

    for (const helper of WINDOWS_NATIVE_HELPERS) {
      await this.prepareWindowsNativeHelper(repositoryPath, worktreePath, helper);
    }
  }

  private async prepareWindowsNativeHelper(
    repositoryPath: string,
    worktreePath: string,
    helper: (typeof WINDOWS_NATIVE_HELPERS)[number]
  ): Promise<void> {
    const source = join(repositoryPath, 'build', 'Release', helper);
    const sourceBytes = await bytes(source);
    if (sourceBytes === null) return;

    const relativeTarget = join('build', 'Release', helper);
    const target = join(worktreePath, relativeTarget);
    const targetBytes = await bytes(target);
    if (targetBytes?.equals(sourceBytes)) return;

    try {
      const value = await lstat(target);
      if (!value.isFile() || value.isSymbolicLink()) {
        throw new AgentRelayError('WORKTREE_INVALID', 'The worktree Windows process launcher path is not a regular file.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await this.assertIgnored(worktreePath, relativeTarget, 'build output');
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  private async assertIgnored(worktreePath: string, relativePath: string, label: string): Promise<void> {
    const git = locateExecutable('git');
    if (!git) throw new AgentRelayError('TOOL_MISSING', 'Git is required to prepare an isolated worktree.');
    const ignored = await this.runner.run(
      git.path,
      ['check-ignore', '--quiet', '--no-index', '--', relativePath],
      {
        cwd: worktreePath,
        timeoutMs: 30_000,
        maxOutputBytes: 2_000
      }
    );
    if (ignored.failed || ignored.exitCode !== 0) {
      throw new AgentRelayError('WORKTREE_INVALID', `Agent Relay will not reuse ${label} because it is not ignored by Git.`, {
        remediation: `Add ${label} to the project ignore rules, then retry.`
      });
    }
  }
}
