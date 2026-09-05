import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGitAdapter } from '../../src/main/adapters/git/git-adapter';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { FilesystemRuleSourceReader } from '../../src/main/adapters/rules/filesystem-rule-source';
import { RuleEvidenceService } from '../../src/main/services/rule-evidence';
import type { Clock, RuleEvidenceLimits } from '../../src/main/ports';

const roots: string[] = [];
const runner = new ExecaProcessRunner();
const locatedGit = locateExecutable('git');
if (!locatedGit) throw new Error('Git is required by the rule-evidence integration suite.');
const gitPath = locatedGit.path;

const git = new CliGitAdapter(runner, { configuredPath: gitPath });
const reader = new FilesystemRuleSourceReader();
const clock: Clock = {
  now: () => new Date('2026-09-06T01:00:00.000Z'),
  nowIso: () => '2026-09-06T01:00:00.000Z'
};
const limits: RuleEvidenceLimits = {
  maxSources: 4,
  maxFiles: 32,
  maxDiscoveryEntries: 100,
  maxFileBytes: 32 * 1024,
  maxTotalBytes: 128 * 1024
};

let repository: string;
let revision: string;

async function runGit(args: readonly string[]): Promise<string> {
  const result = await runner.run(gitPath, args, {
    cwd: repository,
    timeoutMs: 20_000,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true'
    }
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

beforeEach(async () => {
  repository = mkdtempSync(join(tmpdir(), 'agent-relay-rule-repo-'));
  roots.push(repository);
  await runGit(['init', '-b', 'main']);
  await runGit(['config', 'user.name', 'Rule Fixture']);
  await runGit(['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(repository, 'common'), { recursive: true });
  writeFileSync(join(repository, 'AGENTS.md'), 'Run the repository verification command.\n', 'utf8');
  writeFileSync(join(repository, 'common', 'style.md'), 'Prefer explicit evidence.\n', 'utf8');
  await runGit(['add', '--', 'AGENTS.md', 'common/style.md']);
  await runGit(['commit', '-m', 'Add rule fixtures']);
  revision = await runGit(['rev-parse', 'HEAD']);
});

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('rule evidence through real Git and filesystem adapters', () => {
  it('binds selected conventions bytes to the exact clean Git revision', async () => {
    const service = new RuleEvidenceService(git, reader, clock);

    const snapshot = await service.capture({
      sources: [
        {
          id: 'shared-conventions',
          kind: 'conventions',
          rootPath: repository,
          expectedRevision: revision,
          requireClean: true,
          paths: ['common/style.md']
        }
      ],
      limits
    });

    expect(snapshot.sources).toEqual([
      { id: 'shared-conventions', kind: 'conventions', revision, clean: true }
    ]);
    expect(snapshot.files[0]).toMatchObject({
      sourceId: 'shared-conventions',
      path: 'common/style.md',
      content: 'Prefer explicit evidence.\n'
    });
    expect(JSON.stringify(snapshot)).not.toContain(repository);
  });

  it('refuses to bind a dirty conventions checkout to its old revision', async () => {
    writeFileSync(join(repository, 'common', 'style.md'), 'Changed but not committed.\n', 'utf8');
    const service = new RuleEvidenceService(git, reader, clock);

    await expect(
      service.capture({
        sources: [
          {
            id: 'shared-conventions',
            kind: 'conventions',
            rootPath: repository,
            expectedRevision: revision,
            requireClean: true,
            paths: ['common/style.md']
          }
        ],
        limits
      })
    ).rejects.toMatchObject({ code: 'GIT_DIRTY' });
  });

  it('captures current project rules and records that the worktree is dirty', async () => {
    writeFileSync(join(repository, 'AGENTS.md'), 'Current uncommitted project rule.\n', 'utf8');
    const service = new RuleEvidenceService(git, reader, clock);

    const snapshot = await service.capture({
      sources: [
        {
          id: 'project',
          kind: 'project',
          rootPath: repository,
          requireClean: false
        }
      ],
      limits
    });

    expect(snapshot.sources[0]).toEqual({
      id: 'project',
      kind: 'project',
      revision,
      clean: false
    });
    expect(snapshot.files.find((file) => file.path === 'AGENTS.md')?.content).toBe(
      'Current uncommitted project rule.\n'
    );
    expect(snapshot.omitted).toContainEqual({
      sourceId: 'project',
      path: 'CLAUDE.md',
      reason: 'missing'
    });
  });
});
