import { copyFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { ProcessRunner } from '../adapters/process/process-runner';
import { isSamePath } from './path-safety';

export interface WorktreeDependencyTarget {
  readonly repositoryPath: string;
  readonly worktreePath: string;
}

export interface WorktreeDependencyPreparer {
  prepare(target: WorktreeDependencyTarget): Promise<void>;
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

/**
 * Makes an isolated Git worktree runnable without downloading a second copy of
 * dependencies. It reuses the registered checkout's existing node_modules only
 * when both checkouts describe the same dependency graph and Git proves the
 * link is ignored. No package manager or network operation is performed.
 */
export class LocalWorktreeDependencyPreparer implements WorktreeDependencyPreparer {
  constructor(private readonly runner: ProcessRunner) {}

  async prepare({ repositoryPath, worktreePath }: WorktreeDependencyTarget): Promise<void> {
    const worktreePackage = await bytes(join(worktreePath, 'package.json'));
    if (worktreePackage === null) return;

    const target = join(worktreePath, 'node_modules');
    const source = join(repositoryPath, 'node_modules');
    const targetKind = await existingNodeModules(target);
    if (targetKind === 'link') {
      let actual: string;
      try {
        actual = await realpath(target);
      } catch {
        throw new AgentRelayError('WORKTREE_INVALID', 'The worktree node_modules link is broken.', {
          remediation: 'Remove the broken link and retry the task.'
        });
      }
      const expected = await realpath(source).catch(() => null);
      if (expected === null || !isSamePath(actual, expected)) {
        throw new AgentRelayError('WORKTREE_INVALID', 'The worktree node_modules link points outside the registered project checkout.');
      }
    } else if (targetKind === 'missing') {
      try {
        if (!(await lstat(source)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new AgentRelayError('TOOL_MISSING', 'Project dependencies are not installed in the registered checkout.', {
          remediation: 'Run `npm ci` in the project folder once, then retry this action.'
        });
      }

      for (const name of MANIFESTS) {
        const [repositoryBytes, worktreeBytes] = await Promise.all([
          bytes(join(repositoryPath, name)),
          bytes(join(worktreePath, name))
        ]);
        if (
          (repositoryBytes === null) !== (worktreeBytes === null) ||
          (repositoryBytes !== null && worktreeBytes !== null && !sameManifest(name, repositoryBytes, worktreeBytes))
        ) {
          throw new AgentRelayError('VALIDATION_FAILED', 'The worktree dependency manifest differs from the registered checkout.', {
            remediation: 'Install dependencies inside this worktree before running implementation or verification.'
          });
        }
      }

      await this.assertIgnored(worktreePath, 'node_modules/.agent-relay-dependency-probe', 'node_modules');

      try {
        await symlink(await realpath(source), target, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        // A concurrent preparation may have won the race. Accept only the exact
        // link we would have created; every other EEXIST remains a hard refusal.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const [actual, expected] = await Promise.all([realpath(target), realpath(source)]);
          if (isSamePath(actual, expected)) {
            await this.prepareWindowsNativeHelpers(repositoryPath, worktreePath);
            return;
          }
        }
        throw error;
      }
    }

    await this.prepareWindowsNativeHelpers(repositoryPath, worktreePath);
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
