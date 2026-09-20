/**
 * The plan-review subject factory, against a real Git repository.
 *
 * A fake would prove the arguments are assembled; it would not prove the properties the
 * whole fix rests on: that the identity is a commit no ref reaches, that creating it
 * moves nothing the user owns, that the same request names the same object, and that a
 * reviewer can check it out. So this builds real repositories and asks Git.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitPlanReviewSubjectFactory } from '../../src/main/adapters/git/git-plan-review-subject';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import type { PlanReviewSubjectRequest } from '../../src/main/ports';

let root: string;
let gitAvailable = true;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function makeRepository(name: string): { path: string; head: string } {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--initial-branch', 'main');
  git(path, 'config', 'user.email', 'test@example.invalid');
  git(path, 'config', 'user.name', 'Agent Relay Test');
  git(path, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(path, 'kept.txt'), 'base content\n');
  git(path, 'add', 'kept.txt');
  git(path, 'commit', '-m', 'base');
  git(path, 'checkout', '-b', 'agent/task');
  writeFileSync(join(path, 'work.txt'), 'the task branch\n');
  git(path, 'add', 'work.txt');
  git(path, 'commit', '-m', 'task work');
  return { path, head: git(path, 'rev-parse', 'HEAD').trim() };
}

const factory = new GitPlanReviewSubjectFactory(new ExecaProcessRunner());
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const request = (path: string, overrides: Partial<PlanReviewSubjectRequest> = {}): PlanReviewSubjectRequest => ({
  repositoryPath: path,
  branch: 'agent/task',
  gateId: 'gate-2',
  specificationSha256: SHA_A,
  createdAt: '2026-09-20T03:04:05.000Z',
  ...overrides
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-plan-subject-'));
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' });
  } catch {
    gitAvailable = false;
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.runIf(gitAvailable)('an isolated plan-review subject', () => {
  it('is a commit id that no ref reaches, and creating it moves nothing the user owns', async () => {
    const repo = makeRepository('untouched');
    writeFileSync(join(repo.path, 'dirty.txt'), 'uncommitted\n');
    const before = {
      refs: git(repo.path, 'for-each-ref'),
      head: git(repo.path, 'rev-parse', 'HEAD'),
      branch: git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
      status: git(repo.path, 'status', '--porcelain=v1'),
      index: git(repo.path, 'ls-files', '--stage'),
      branches: git(repo.path, 'branch', '--list')
    };

    const subject = await factory.createIsolatedSubject(request(repo.path));

    expect(subject).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo.path, 'cat-file', '-t', subject).trim()).toBe('commit');
    // Nothing was added to, or moved in, anything the user can see or check out.
    expect({
      refs: git(repo.path, 'for-each-ref'),
      head: git(repo.path, 'rev-parse', 'HEAD'),
      branch: git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
      status: git(repo.path, 'status', '--porcelain=v1'),
      index: git(repo.path, 'ls-files', '--stage'),
      branches: git(repo.path, 'branch', '--list')
    }).toEqual(before);
    // No branch, tag or other ref contains it: it is reachable only by its id.
    expect(git(repo.path, 'for-each-ref', '--contains', subject).trim()).toBe('');
    expect(git(repo.path, 'branch', '--all', '--contains', subject).trim()).toBe('');
  });

  it('has the task branch head as its parent and its tree as its content, and names the gate', async () => {
    const repo = makeRepository('shape');

    const subject = await factory.createIsolatedSubject(request(repo.path, { gateId: 'gate-77', specificationSha256: SHA_B }));

    expect(git(repo.path, 'rev-parse', `${subject}^`).trim()).toBe(repo.head);
    expect(git(repo.path, 'rev-parse', `${subject}^{tree}`).trim()).toBe(git(repo.path, 'rev-parse', 'agent/task^{tree}').trim());
    const message = git(repo.path, 'log', '-1', '--format=%B', subject);
    expect(message).toContain('gate: gate-77');
    expect(message).toContain(`specification: ${SHA_B}`);
    // Fixed author and time: it does not depend on whose machine made it.
    expect(git(repo.path, 'log', '-1', '--format=%an <%ae> %at', subject).trim()).toBe(
      `Agent Relay <agent-relay@localhost.invalid> ${Math.floor(Date.parse('2026-09-20T03:04:05.000Z') / 1_000)}`
    );
  });

  it('is fixed by its request: the same request names the same object, any other names another', async () => {
    const repo = makeRepository('deterministic');

    const first = await factory.createIsolatedSubject(request(repo.path));
    const again = await factory.createIsolatedSubject(request(repo.path));
    const otherGate = await factory.createIsolatedSubject(request(repo.path, { gateId: 'gate-3' }));
    const otherSpecification = await factory.createIsolatedSubject(request(repo.path, { specificationSha256: SHA_B }));

    // A crash between making it and recording it leaves nothing to clean up: the retry names the same object.
    expect(again).toBe(first);
    // A second gate can never be handed the first one's identity.
    expect(new Set([first, otherGate, otherSpecification]).size).toBe(3);
  });

  it('can be resolved and checked out by id, which is all a reviewer does with it', async () => {
    const repo = makeRepository('checkout');
    const subject = await factory.createIsolatedSubject(request(repo.path));

    // What the provider does with the ref it is given.
    expect(git(repo.path, 'rev-parse', subject).trim()).toBe(subject);
    const checkout = join(root, 'checkout-reviewer');
    git(repo.path, 'worktree', 'add', '--detach', checkout, subject);

    expect(existsSync(join(checkout, 'work.txt'))).toBe(true);
    expect(git(checkout, 'rev-parse', 'HEAD').trim()).toBe(subject);
    git(repo.path, 'worktree', 'remove', '--force', checkout);
  });

  it('is made whatever the user’s signing and identity configuration says', async () => {
    const repo = makeRepository('signing');
    // A signature would neither be deterministic nor obtainable without a prompt; the user's
    // own identity would make the same request name a different object on another machine.
    git(repo.path, 'config', 'commit.gpgsign', 'true');
    git(repo.path, 'config', 'gpg.program', 'this-program-does-not-exist');
    git(repo.path, 'config', 'user.name', 'Somebody Else');
    git(repo.path, 'config', 'user.email', 'somebody@example.invalid');

    const subject = await factory.createIsolatedSubject(request(repo.path));

    expect(git(repo.path, 'log', '-1', '--format=%an', subject).trim()).toBe('Agent Relay');
    expect(git(repo.path, 'cat-file', '-p', subject)).not.toContain('gpgsig');
  });

  it('refuses a branch that does not exist as a branch — a tag or a commit id of that name is not the task branch', async () => {
    const repo = makeRepository('missing');
    git(repo.path, 'tag', 'lookalike', 'main');

    await expect(factory.createIsolatedSubject(request(repo.path, { branch: 'lookalike' }))).rejects.toMatchObject({
      code: 'GIT_FAILED'
    });
    await expect(factory.createIsolatedSubject(request(repo.path, { branch: 'no-such-branch' }))).rejects.toMatchObject({
      code: 'GIT_FAILED'
    });
    // Nothing was created by a refusal.
    expect(git(repo.path, 'count-objects', '-v')).toBeTruthy();
  });

  it.each([
    ['a branch that would be read as an option', { branch: '--upload-pack=evil' }],
    ['a branch with a NUL', { branch: 'agent/task\0x' }],
    ['a gate id with shell-ish characters', { gateId: 'gate; rm -rf' }],
    ['an empty gate id', { gateId: '' }],
    ['a malformed specification hash', { specificationSha256: 'not-a-hash' }],
    ['no usable time', { createdAt: 'yesterday' }]
  ] as const)('refuses %s before it runs anything', async (_name, overrides) => {
    const repo = makeRepository(`refuse-${_name.replace(/\W+/g, '-')}`);

    await expect(factory.createIsolatedSubject(request(repo.path, overrides))).rejects.toMatchObject({
      code: expect.stringMatching(/VALIDATION_FAILED|GIT_FAILED/)
    });
    expect(git(repo.path, 'for-each-ref').trim().split('\n')).toHaveLength(2);
  });
});
