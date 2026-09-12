import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { LocalWorktreeDependencyPreparer } from '../../src/main/services/worktree-dependencies';

let root: string;
let repositoryPath: string;
let worktreePath: string;
const prepare = new LocalWorktreeDependencyPreparer(new ExecaProcessRunner());

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-dependencies-'));
  repositoryPath = join(root, 'repository');
  worktreePath = join(root, 'worktree');
  mkdirSync(repositoryPath);
  git(repositoryPath, 'init', '-b', 'main');
  git(repositoryPath, 'config', 'user.email', 'test@example.invalid');
  git(repositoryPath, 'config', 'user.name', 'Test');
  writeFileSync(join(repositoryPath, 'package.json'), '{"scripts":{"verify":"echo ok"}}\n');
  writeFileSync(join(repositoryPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(repositoryPath, '.gitignore'), 'node_modules/\nbuild/\n');
  git(repositoryPath, 'add', '--', 'package.json', 'package-lock.json', '.gitignore');
  git(repositoryPath, 'commit', '-m', 'fixture');
  git(repositoryPath, 'worktree', 'add', '-b', 'agent/test', worktreePath);
  mkdirSync(join(repositoryPath, 'node_modules'));
  writeFileSync(join(repositoryPath, 'node_modules', '.fixture'), 'installed');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('local worktree dependency preparation', () => {
  it('creates one ignored local link to compatible installed dependencies and is idempotent', async () => {
    if (process.platform === 'win32') {
      mkdirSync(join(repositoryPath, 'build', 'Release'), { recursive: true });
      writeFileSync(join(repositoryPath, 'build', 'Release', 'agent-relay-windows-job.exe'), 'fixture-launcher');
    }

    await prepare.prepare({ repositoryPath, worktreePath });
    await prepare.prepare({ repositoryPath, worktreePath });

    const target = join(worktreePath, 'node_modules');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBeTruthy();
    if (process.platform === 'win32') {
      expect(readFileSync(join(worktreePath, 'build', 'Release', 'agent-relay-windows-job.exe'), 'utf8'))
        .toBe('fixture-launcher');
    }
    expect(execFileSync('git', ['status', '--short'], { cwd: worktreePath, encoding: 'utf8' })).toBe('');
  });

  it('refuses to reuse dependencies when the lockfile differs', async () => {
    writeFileSync(join(worktreePath, 'package-lock.json'), '{"lockfileVersion":2}\n');

    await expect(prepare.prepare({ repositoryPath, worktreePath })).rejects.toThrow(/manifest differs/);
    expect(() => lstatSync(join(worktreePath, 'node_modules'))).toThrow();
  });

  it('requires dependencies to be installed once in the registered checkout', async () => {
    rmSync(join(repositoryPath, 'node_modules'), { recursive: true, force: true });

    await expect(prepare.prepare({ repositoryPath, worktreePath })).rejects.toThrow(/not installed/);
  });
});
