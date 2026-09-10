import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Project, Settings, Task } from '../../shared/domain/models';
import { AgentRelayError } from '../../shared/domain/errors';
import type { AgentProgressEvent } from '../ports';
import { hashSnapshotFile, GitCodeSnapshotSource } from '../adapters/git/git-code-snapshot';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { ProcessRunner, ProcessResult } from '../adapters/process/process-runner';
import { assertSafeWorktreePath, isSamePath } from './path-safety';

export interface VerificationTarget { task: Task; project: Project; settings: Settings }
export interface VerificationExecutor {
  identity(target: VerificationTarget): Promise<string>;
  execute(target: VerificationTarget, signal: AbortSignal, progress: (event: AgentProgressEvent) => void): Promise<ProcessResult>;
}

/** Executes the existing project's verify script, never an LLM or renderer command.
 * Scripts are trusted project code and can write build/test artifacts. */
export class WorktreeVerification implements VerificationExecutor {
  constructor(private readonly runner: ProcessRunner) {}

  private async manifest({ task, project, settings }: VerificationTarget): Promise<string> {
    if (!task.worktreePath || !task.branchName || !task.baseBranch) {
      throw new AgentRelayError('WORKTREE_INVALID', 'Verification requires an existing task worktree.');
    }
    const root = task.worktreePath;
    assertSafeWorktreePath({ worktreePath: root, repositoryPath: project.localPath, worktreesRoot: settings.worktreesRoot });
    const source = new GitCodeSnapshotSource(this.runner);
    const [checkout, repository] = await Promise.all([source.describeCheckout(root), source.describeCheckout(project.localPath)]);
    if (checkout.detached || checkout.branch !== task.branchName || !isSamePath(checkout.commonDir, repository.commonDir)) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The verification checkout no longer belongs to this task.');
    }
    const git = locateExecutable('git');
    if (!git) throw new AgentRelayError('TOOL_MISSING', 'Git is required for verification.');
    const read = async (args: string[]) => {
      const result = await this.runner.run(git.path, args, { cwd: root, timeoutMs: 30_000, maxOutputBytes: 4_000_000 });
      if (result.failed || result.exitCode !== 0 || result.stdout.length >= 3_900_000) throw new AgentRelayError('GIT_FAILED', 'Cannot establish the verification file set.');
      return result.stdout;
    };
    const base = await read(['rev-parse', '--verify', '--end-of-options', task.baseBranch]);
    const names = [...new Set((await read(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
    if (names.length > 20_000) throw new AgentRelayError('VALIDATION_FAILED', 'Verification file set exceeds the supported limit.');
    const entries: unknown[] = [];
    let totalBytes = 0;
    for (const name of names) {
      const path = join(root, name);
      let mode: number;
      try {
        const stat = await lstat(path);
        totalBytes += stat.size; mode = stat.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new AgentRelayError('VALIDATION_FAILED', 'A verification input cannot be read.');
      }
      if (totalBytes > 256 * 1024 * 1024) throw new AgentRelayError('VALIDATION_FAILED', 'Verification inputs exceed the 256 MiB capture limit.');
      const digest = await hashSnapshotFile(root, path);
      if ('error' in digest) throw new AgentRelayError('VALIDATION_FAILED', 'A verification input is unreadable or unsafe.');
      entries.push([name, digest.sha256, digest.bytes, mode]);
    }
    return createHash('sha256').update(JSON.stringify({
      version: 1, root: await realpath(root), commonDir: checkout.commonDir,
      branch: checkout.branch, base: base.trim(), entries,
      specification: task.specificationJson, approvedAt: task.specificationApprovedAt,
      providerRevision: task.providerRevision, command: 'npm run verify'
    })).digest('hex');
  }

  async identity(target: VerificationTarget): Promise<string> {
    const first = await this.manifest(target);
    if (first !== await this.manifest(target)) throw new AgentRelayError('VALIDATION_FAILED', 'Files changed while verification identity was being captured. Try again when editing has stopped.');
    return first;
  }

  async execute({ task, settings }: VerificationTarget, signal: AbortSignal, progress: (event: AgentProgressEvent) => void): Promise<ProcessResult> {
    const root = task.worktreePath!;
    const pkg: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (!pkg || typeof pkg !== 'object' || !('scripts' in pkg) || !pkg.scripts || typeof pkg.scripts !== 'object' || !('verify' in pkg.scripts) || typeof pkg.scripts.verify !== 'string' || !pkg.scripts.verify.trim()) {
      throw new AgentRelayError('VALIDATION_FAILED', 'This project needs a package.json scripts.verify command. No command was started.');
    }
    const node = locateExecutable('node');
    const npm = locateExecutable('npm');
    if (!node || !npm) throw new AgentRelayError('TOOL_MISSING', 'Install Node.js and npm to run verification.');
    // Do not execute a Windows .cmd shim or interpolate a shell command.
    const npmCli = process.platform === 'win32'
      ? join(dirname(npm.path), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : await realpath(npm.path);
    await lstat(npmCli);
    progress({ type: 'log', text: 'Command: npm run verify (existing worktree; no implementation agent)' });
    return this.runner.run(node.path, [npmCli, 'run', 'verify'], {
      cwd: root, signal, timeoutMs: settings.processTimeoutMs, maxOutputBytes: settings.maxStoredLogBytes,
      onLine: text => progress({ type: 'log', text }),
      onStderrLine: text => progress({ type: 'log', text })
    });
  }
}
