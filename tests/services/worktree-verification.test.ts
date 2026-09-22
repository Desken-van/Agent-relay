import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHarness, type Harness } from '../helpers/harness';
import { WorktreeVerification, type VerificationTarget } from '../../src/main/services/worktree-verification';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';

let h: Harness;
let target: VerificationTarget;
let root: string;
const verifier = new WorktreeVerification(new ExecaProcessRunner());
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, {cwd, encoding:'utf8', windowsHide:true}); }
beforeEach(() => {
  h = createHarness();
  const repo = join(dirname(h.worktreesRoot), 'repo'); root = join(h.worktreesRoot, 'task');
  mkdirSync(repo, {recursive:true});
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo,'package.json'), JSON.stringify({scripts:{verify:"node -e \"console.log('synthetic verification passed')\""}}));
  writeFileSync(join(repo,'input.txt'), 'alpha');
  writeFileSync(join(repo,'.gitignore'), 'out/\nnode_modules/\n');
  git(repo, 'add', '--', 'package.json', 'input.txt', '.gitignore'); git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'agent/task', root);
  const project = h.createProject({localPath:repo});
  const task = h.createTask(project.id, {worktreePath:root, branchName:'agent/task', baseBranch:'main', specificationApprovedAt:h.clock.nowIso()});
  target = {task, project, settings:h.settings.get()};
});
afterEach(() => h.dispose());
it('binds all tracked bytes and non-ignored new files, not just a status or line count', async () => {
  const first = await verifier.identity(target);
  writeFileSync(join(root,'input.txt'), 'bravo');
  const second = await verifier.identity(target); expect(second).not.toBe(first);
  writeFileSync(join(root,'new.txt'), 'new'); expect(await verifier.identity(target)).not.toBe(second);
}, 30_000);
it('retains proof across a commit of the same bytes and ignores only generated ignored artifacts', async () => {
  writeFileSync(join(root,'input.txt'), 'bravo');
  const first = await verifier.identity(target);
  git(root, 'add', '--', 'input.txt'); git(root, 'commit', '-m', 'fixture edit');
  mkdirSync(join(root,'out')); writeFileSync(join(root,'out','build.txt'), 'generated');
  expect(await verifier.identity(target)).toBe(first);
}, 30_000);
it('refuses a different checked-out branch', async () => {
  git(root, 'switch', '-c', 'other'); await expect(verifier.identity(target)).rejects.toThrow(/no longer belongs/);
});
it('runs the real npm script once, without a model or any agent, and never streams its own output as a progress event', async () => {
  const output: string[] = [];
  const result = await verifier.execute(target, new AbortController().signal, event => output.push(event.text));
  expect(result.exitCode).toBe(0); expect(result.failed).toBe(false);
  // The command's output is returned, not streamed: every progress event during execute() is generic
  // (Relay's own "Command: ..." line), and none of them carry a word the child process printed. A caller
  // reduces `result.stdout`/`.stderr` to a sanitized summary itself, once the command has finished.
  expect(result.stdout).toContain('synthetic verification passed');
  expect(output.join('\n')).not.toContain('synthetic verification passed');
  expect(output).toEqual(['Command: npm run verify (existing worktree; no implementation agent)']);
}, 30_000);
it('fails closed when the project has no verify script', async () => {
  writeFileSync(join(root,'package.json'), '{}');
  await expect(verifier.execute(target, new AbortController().signal, () => {})).rejects.toThrow(/scripts.verify/);
});
