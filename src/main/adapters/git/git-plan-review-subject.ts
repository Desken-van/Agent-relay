/**
 * Gives a plan-review gate a review identity of its own — without touching a ref.
 *
 * ## Why this exists
 *
 * The plan reviewer keys a session by (repository, ref) and `open` is idempotent, so
 * every gate of one task that names the task's branch is handed the same session. The
 * first gate's review, once resolved, leaves that session past the plan stage, and the
 * plan-correction loop's review of the REVISED specification then asks a finished
 * session for a new plan round and is refused. The provider offers no "new session"
 * parameter, and it resolves the ref it is given with `git rev-parse`, so a fresh
 * identity has to be a ref Git can resolve that no other gate has used.
 *
 * ## What is created
 *
 * One commit object, and nothing else: the tree of the task branch's head, that head as
 * its parent, and a message naming the gate. It is reachable from no branch, tag or
 * other ref, so `git branch`, `git tag` and `git for-each-ref` are exactly what they
 * were; nothing is checked out, staged or pushed; the task branch, its worktree and the
 * user's checkout are never written. The provider is given the commit's id in place of a
 * branch name, which is what it documents for reviewing an existing commit.
 *
 * ## Lifecycle and cleanup
 *
 * - **Deterministic per request.** Author, committer, both timestamps, parent, tree and
 *   message are fixed by the request, so the same request always names the same commit,
 *   and a second gate cannot receive it (the gate id is in the message). For a gate whose
 *   row already exists — the loop's review of a revised specification — a crash between
 *   creating the object and recording its id therefore leaves nothing to clean up: the
 *   retry names the same object. A recovery retry (`retryInFreshSession`) is a NEW gate
 *   with a new id each time, so an interrupted one leaves one more unreferenced object,
 *   which nothing points at and Git prunes with the rest.
 * - **Cleaned up by Git.** An unreachable object is pruned by `git gc` once it is older
 *   than `gc.pruneExpire` (two weeks by default); Agent Relay creates no ref that would
 *   keep it and deletes nothing. A gate that still waits on the provider after that finds
 *   its identity unresolvable, which surfaces as the provider's own refusal and is
 *   recovered like any spent identity — with a new one, by a person.
 * - **Cheap.** Two `rev-parse` reads and one `commit-tree`; the tree object already exists.
 *
 * ## What it may run
 *
 * An allowlist of exactly `rev-parse` and `commit-tree`. `commit-tree` is plumbing: it runs
 * no hook, reads no index and writes only the object database.
 */

import { AgentRelayError } from '../../../shared/domain/errors';
import { redactSecrets } from '../../../shared/util/redact';
import type { PlanReviewSubjectFactory, PlanReviewSubjectRequest } from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../process/process-runner';

/** Every Git invocation this class is permitted to make. */
const ALLOWED: ReadonlyArray<readonly string[]> = [['rev-parse'], ['commit-tree']];

/**
 * A fixed identity. The commit is never shown to a person as history, and using the
 * user's own would make the same request name different objects on different machines.
 */
const IDENTITY = { name: 'Agent Relay', email: 'agent-relay@localhost.invalid' } as const;

const GIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function assertAllowed(args: readonly string[]): void {
  // A leading `-c key=value` pair is configuration for the one command that follows.
  const command = args[0] === '-c' ? args.slice(2) : args;
  if (!ALLOWED.some((prefix) => prefix.every((part, index) => command[index] === part))) {
    throw new AgentRelayError('GIT_FAILED', 'A plan-review subject may only be made with rev-parse and commit-tree.', {
      details: `git ${command.slice(0, 2).join(' ')}`
    });
  }
}

export interface GitPlanReviewSubjectOptions {
  readonly configuredPath?: string | null;
  readonly timeoutMs?: number;
}

export class GitPlanReviewSubjectFactory implements PlanReviewSubjectFactory {
  private resolvedPath: string | null = null;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: GitPlanReviewSubjectOptions = {}
  ) {}

  private gitPath(): string {
    if (this.resolvedPath) return this.resolvedPath;
    const located = locateExecutable('git', { configuredPath: this.options.configuredPath ?? null });
    if (!located) {
      throw new AgentRelayError('TOOL_MISSING', 'Git was not found on this machine.', {
        remediation: 'Install Git for Windows from https://git-scm.com/download/win and restart Agent Relay.'
      });
    }
    this.resolvedPath = located.path;
    return located.path;
  }

  private async git(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    env: Readonly<Record<string, string>> = {}
  ): Promise<ProcessResult> {
    assertAllowed(args);
    const result = await this.runner.run(this.gitPath(), args, {
      cwd,
      signal,
      timeoutMs: this.options.timeoutMs ?? 60_000,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
        ...env
      }
    });
    if (result.exitCode !== 0) {
      throw new AgentRelayError('GIT_FAILED', `git ${args.find((part) => !part.startsWith('-') && !part.includes('=')) ?? ''} failed while preparing an isolated review subject.`, {
        details: redactSecrets((result.stderr || result.stdout).slice(0, 2_000))
      });
    }
    return result;
  }

  async createIsolatedSubject(request: PlanReviewSubjectRequest, signal?: AbortSignal): Promise<string> {
    const { repositoryPath, branch, gateId, specificationSha256, createdAt } = request;
    // Everything below is placed on a command line or into a commit message, so it is
    // checked to be what it should be before it is used for either.
    if (!SAFE_ID.test(gateId) || !SHA256.test(specificationSha256)) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The plan-review subject request is malformed.');
    }
    if (branch.length === 0 || branch.startsWith('-') || branch.includes('\0')) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The task branch name cannot be used to build a review subject.');
    }
    const epoch = Math.floor(Date.parse(createdAt) / 1_000);
    if (!Number.isFinite(epoch) || epoch < 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The plan-review subject request carries no usable time.');
    }

    // The task branch is a local branch: naming it under `refs/heads/` means a tag or a
    // remote of the same name can never be what this resolves to.
    const head = (
      await this.git(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], signal)
    ).stdout.trim();
    if (!GIT_ID.test(head)) {
      throw new AgentRelayError('GIT_FAILED', 'The task branch does not resolve to a commit.');
    }
    const tree = (await this.git(repositoryPath, ['rev-parse', '--verify', '--quiet', `${head}^{tree}`], signal)).stdout.trim();
    if (!GIT_ID.test(tree)) {
      throw new AgentRelayError('GIT_FAILED', 'The task branch head has no tree.');
    }

    const stamp = `${epoch} +0000`;
    const message = ['Agent Relay plan-review subject', '', `gate: ${gateId}`, `specification: ${specificationSha256}`, ''].join('\n');
    const created = (
      await this.git(
        repositoryPath,
        // Signing is switched off for this one command whatever the user's configuration
        // says: a signature is not deterministic, and asking for a key would hang the app.
        ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-m', message],
        signal,
        {
          GIT_AUTHOR_NAME: IDENTITY.name,
          GIT_AUTHOR_EMAIL: IDENTITY.email,
          GIT_AUTHOR_DATE: stamp,
          GIT_COMMITTER_NAME: IDENTITY.name,
          GIT_COMMITTER_EMAIL: IDENTITY.email,
          GIT_COMMITTER_DATE: stamp
        }
      )
    ).stdout.trim();
    if (!GIT_ID.test(created)) {
      throw new AgentRelayError('GIT_FAILED', 'Git did not return a commit id for the review subject.');
    }
    return created;
  }
}
