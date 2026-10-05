import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import { hashSnapshotFile } from '../adapters/git/git-code-snapshot';
import { locateExecutable } from '../adapters/process/executable-locator';
import type { ProcessRunner } from '../adapters/process/process-runner';

/** Exact, bounded task bytes, including untracked files; no index or checkout writes. */
export async function stableWorktreeFileIdentity(root: string, runner: ProcessRunner): Promise<string> {
  const git = locateExecutable('git');
  if (!git) throw new AgentRelayError('TOOL_MISSING', 'Git is required to capture specification files.');
  const read = async (args: string[]) => {
    const result = await runner.run(git.path, args, { cwd: root, timeoutMs: 30_000, maxOutputBytes: 4_000_000,
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    if (result.failed || result.exitCode !== 0 || result.stdout.length >= 3_900_000) {
      throw new AgentRelayError('GIT_FAILED', 'Cannot capture the specification file set.');
    }
    return result.stdout;
  };
  const capture = async () => {
    const [head, branch, listed] = await Promise.all([
      read(['rev-parse', 'HEAD']), read(['rev-parse', '--abbrev-ref', 'HEAD']),
      read(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    ]);
    const names = [...new Set(listed.split('\0').filter(Boolean))].sort();
    if (names.length > 20_000) throw new AgentRelayError('VALIDATION_FAILED', 'Specification files exceed the supported limit.');
    const entries: unknown[] = [];
    let totalBytes = 0;
    for (const name of names) {
      const path = join(root, name);
      let mode: number;
      try {
        const stat = await lstat(path);
        totalBytes += stat.size;
        mode = stat.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries.push([name, 'missing']);
        continue;
      }
      if (totalBytes > 256 * 1024 * 1024) throw new AgentRelayError('VALIDATION_FAILED', 'Specification files exceed the 256 MiB capture limit.');
      const digest = await hashSnapshotFile(root, path);
      if ('error' in digest) throw new AgentRelayError('VALIDATION_FAILED', 'A specification file is unreadable or unsafe.');
      entries.push([name, digest.sha256, digest.bytes, mode]);
    }
    return createHash('sha256').update(JSON.stringify({ root: await realpath(root), head: head.trim(), branch: branch.trim(), entries })).digest('hex');
  };
  const first = await capture();
  if (first !== await capture()) throw new AgentRelayError('VALIDATION_FAILED', 'Specification file bytes changed during capture. Retry when editing has stopped.');
  return first;
}
