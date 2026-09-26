/**
 * The checkout a specification is generated from, and the check that it still
 * describes the task's target.
 *
 * The project's source checkout is never read for a specification: it can be on
 * another branch, at another commit, and carry uncommitted edits, none of which
 * the task branch will contain. Codex reads the task's own worktree when it
 * exists, and otherwise a temporary, clean, detached checkout of the base
 * branch's commit — the commit the task branch is then cut from. Only Git is used:
 * no file is copied, nothing in the source checkout is touched, nothing is forced.
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Project, Settings, Task } from '../../shared/domain/models';
import {
  shortCommit,
  specificationGroundingProblem,
  specificationGroundingState,
  type SpecificationGrounding
} from '../../shared/domain/specification-grounding';
import type { RepositoryInfo } from '../../shared/domain/git';
import type { Clock, GitAdapter } from '../ports';
import { assertSafeWorktreePath, isInsideDirectory, isSamePath } from './path-safety';

/** Under the worktrees root, beside the task worktrees and never inside a repository. */
export const SPECIFICATION_CHECKOUT_DIR = '.agent-relay-specification';

export interface SpecificationCheckoutTarget {
  /** The directory Codex reads. */
  readonly path: string;
  readonly grounding: SpecificationGrounding;
  /** Removes a temporary checkout (never forced); a no-op for the task worktree. Returns why removal failed, or null. */
  close(): Promise<string | null>;
}

export type SpecificationGroundingCheck =
  | { readonly ok: true }
  /** The record itself says it cannot be trusted: missing, already stale, or for another implementer. */
  | { readonly ok: false; readonly kind: 'untrusted'; readonly reason: string }
  /** The record was fine, but the target no longer matches it. Definitive: Git answered. */
  | { readonly ok: false; readonly kind: 'mismatch'; readonly reason: string };

interface Target {
  readonly task: Task;
  readonly project: Project;
  readonly settings: Settings;
}

function files(list: readonly string[]): string {
  const shown = list.slice(0, 5).join(', ');
  return list.length > 5 ? `${shown} and ${list.length - 5} more` : shown;
}

export class SpecificationGroundingService {
  constructor(private readonly deps: { readonly git: GitAdapter; readonly clock: Clock }) {}

  /** The temporary checkout's path for one task: keyed by the whole task id, so tasks never share one. */
  checkoutPathFor(task: Task, settings: Settings): string {
    return join(settings.worktreesRoot, SPECIFICATION_CHECKOUT_DIR, task.id.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  /** Open the checkout a specification of `task` is generated from, and the record that names it. */
  async open({ task, project, settings }: Target): Promise<SpecificationCheckoutTarget> {
    const { git } = this.deps;
    const baseBranch = task.baseBranch ?? project.defaultBranch;
    const capturedAt = this.deps.clock.nowIso();

    if (task.worktreePath !== null && task.branchName !== null) {
      const { commit, info } = await this.worktreeCommit(task, project, settings);
      // In any round: uncommitted content is something no commit can name, so nothing could
      // later prove the worktree still holds what Codex read. Refused, never read. Agent Relay
      // never discards the changes (a person's edits, or an earlier round's work).
      if (!info.isClean) {
        throw new AgentRelayError('GIT_DIRTY', 'The task worktree has uncommitted changes, so a specification cannot be tied to one commit.', {
          details: files(info.dirtyFiles),
          remediation: 'Commit or discard those changes in the task worktree yourself, then generate the specification again. Agent Relay never discards them.'
        });
      }
      return {
        path: task.worktreePath,
        grounding: {
          version: 1,
          checkout: 'task_worktree',
          baseBranch,
          branch: task.branchName,
          commit,
          clean: info.isClean,
          implementationProvider: task.implementationProvider,
          capturedAt,
          stale: null
        },
        close: async () => null
      };
    }

    const commit = await git.resolveCommit(project.localPath, branchRef(baseBranch));
    if (commit === null) {
      throw new AgentRelayError('GIT_FAILED', `The project's base branch "${baseBranch}" does not exist in ${project.localPath}.`, {
        remediation: 'Update the project settings to point at a branch that exists.'
      });
    }
    const path = this.checkoutPathFor(task, settings);
    assertSafeWorktreePath({ worktreePath: path, worktreesRoot: settings.worktreesRoot, repositoryPath: project.localPath });
    // A leftover from an earlier generation that did not finish. Removed the same way
    // as always — never forced — so one that somehow changed is refused, not deleted.
    if (existsSync(path)) await git.removeWorktree(project.localPath, path);
    await git.createDetachedCheckout({ repositoryPath: project.localPath, commit, checkoutPath: path });
    const close = async (): Promise<string | null> => {
      try {
        await git.removeWorktree(project.localPath, path);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    // Proven to be exactly that commit, clean, before Codex reads it; removed on any failure.
    let info: RepositoryInfo;
    try {
      info = await git.inspect(path);
    } catch (error) {
      await close();
      throw error;
    }
    if (!info.isRepository || info.headCommit !== commit || !info.isClean) {
      await close();
      throw new AgentRelayError('GIT_FAILED', 'The temporary checkout for the specification is not a clean checkout of the base commit.', {
        details: path
      });
    }
    return {
      path,
      grounding: {
        version: 1,
        checkout: 'base_commit',
        baseBranch,
        branch: null,
        commit,
        clean: true,
        implementationProvider: task.implementationProvider,
        capturedAt,
        stale: null
      },
      close
    };
  }

  /**
   * Whether the task's target is still exactly what its specification was generated
   * against. Read-only. A Git failure throws — it is not an answer — so only a
   * definite "no" is ever reported as a mismatch.
   */
  async check({ task, project, settings }: Target): Promise<SpecificationGroundingCheck> {
    const state = specificationGroundingState(task);
    if (state.kind === 'none') return { ok: true };
    if (state.kind !== 'recorded') {
      return { ok: false, kind: 'untrusted', reason: specificationGroundingProblem(state) ?? 'The specification is not grounded.' };
    }
    const recorded = state.grounding;

    if (task.worktreePath !== null && task.branchName !== null) {
      let observed: { readonly commit: string; readonly info: RepositoryInfo };
      try {
        observed = await this.worktreeCommit(task, project, settings);
      } catch (error) {
        if (error instanceof AgentRelayError && error.code === 'WORKTREE_INVALID') {
          return { ok: false, kind: 'mismatch', reason: error.message };
        }
        throw error;
      }
      const { commit, info } = observed;
      if (commit !== recorded.commit) {
        return {
          ok: false,
          kind: 'mismatch',
          reason: `the task branch moved from ${shortCommit(recorded.commit)} to ${shortCommit(commit)}.`
        };
      }
      // A trusted record is always a clean checkout (`unverifiable` covers the rest), so any
      // uncommitted change since is a change to what was read.
      if (!info.isClean) {
        return { ok: false, kind: 'mismatch', reason: `the task worktree now has uncommitted changes (${files(info.dirtyFiles)}).` };
      }
      return { ok: true };
    }

    if (recorded.checkout === 'task_worktree') {
      return { ok: false, kind: 'mismatch', reason: 'the task worktree it was generated from no longer exists.' };
    }
    const tip = await this.deps.git.resolveCommit(project.localPath, branchRef(recorded.baseBranch));
    if (tip === null) {
      return { ok: false, kind: 'mismatch', reason: `the base branch "${recorded.baseBranch}" no longer exists.` };
    }
    if (!(await this.deps.git.isAncestor(project.localPath, recorded.commit, tip))) {
      return {
        ok: false,
        kind: 'mismatch',
        reason: `the base branch "${recorded.baseBranch}" no longer contains ${shortCommit(recorded.commit)}.`
      };
    }
    return { ok: true };
  }

  /**
   * After Codex has read `target`: is the checkout still exactly the commit its record names,
   * and still clean? Returns why not, or null. A Git failure throws — it is not an answer.
   * The record is only written after this says null, so a commit or an edit made while Codex
   * was reading can never be stored under the commit that was there before it.
   */
  async confirmUnchanged(target: SpecificationCheckoutTarget, { task, project, settings }: Target): Promise<string | null> {
    const recorded = target.grounding;
    let info: RepositoryInfo;
    if (recorded.checkout === 'task_worktree') {
      try {
        info = (await this.worktreeCommit(task, project, settings)).info;
      } catch (error) {
        if (error instanceof AgentRelayError && error.code === 'WORKTREE_INVALID') return error.message;
        throw error;
      }
    } else {
      info = await this.deps.git.inspect(target.path);
    }
    if (!info.isRepository || info.headCommit === null) return 'the checkout Codex read is no longer a Git checkout.';
    if (info.headCommit !== recorded.commit) {
      return `it moved from ${shortCommit(recorded.commit)} to ${shortCommit(info.headCommit)}.`;
    }
    if (!info.isClean) return `it now has uncommitted changes (${files(info.dirtyFiles)}).`;
    return null;
  }

  /**
   * The task worktree's HEAD, after proving the directory is that task's checkout of
   * the project: inside the worktrees root, on the task branch, and at the commit the
   * project repository's own ref for that branch names.
   */
  private async worktreeCommit(
    task: Task,
    project: Project,
    settings: Settings
  ): Promise<{ readonly commit: string; readonly info: RepositoryInfo }> {
    const worktreePath = task.worktreePath as string;
    const branch = task.branchName as string;
    assertSafeWorktreePath({ worktreePath, worktreesRoot: settings.worktreesRoot, repositoryPath: project.localPath });
    const info = await this.deps.git.inspect(worktreePath);
    const branchHead = await this.deps.git.resolveCommit(project.localPath, branchRef(branch));
    // Git expands Windows 8.3 names (RUNNER~1 -> runneradmin) in --show-toplevel.
    // Resolve both existing paths before comparing, and keep the physical checkout
    // within the configured root and outside the source repository.
    let sameSafeDirectory = info.root !== null && isSamePath(info.root, worktreePath);
    // Fake Git adapters in unit tests can describe a virtual checkout. A real
    // checkout has all four paths on disk and must also pass the physical check.
    if (info.root !== null && [worktreePath, info.root, settings.worktreesRoot, project.localPath].every(existsSync)) {
      sameSafeDirectory = false;
      try {
        const actual = realpathSync.native(worktreePath);
        const reported = realpathSync.native(info.root);
        const worktreesRoot = realpathSync.native(settings.worktreesRoot);
        const repositoryRoot = realpathSync.native(project.localPath);
        sameSafeDirectory =
          isSamePath(actual, reported) &&
          isInsideDirectory(worktreesRoot, actual) &&
          !isSamePath(repositoryRoot, actual) &&
          !isInsideDirectory(repositoryRoot, actual);
      } catch {
        // A missing or unresolvable checkout is not a trusted task worktree.
      }
    }
    if (
      !info.isRepository ||
      info.root === null ||
      !sameSafeDirectory ||
      info.currentBranch !== branch ||
      info.headCommit === null ||
      branchHead !== info.headCommit
    ) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task worktree is no longer a checkout of the task branch.', {
        details: worktreePath,
        remediation: `Check the task branch "${branch}" out again in that folder (Agent Relay does not move branches), then retry.`
      });
    }
    return { commit: info.headCommit, info };
  }
}

/**
 * Git's own rules for a branch name (`git check-ref-format`): no control characters,
 * spaces, `~ ^ : ? * [ \`, `..`, `@{`, `//`, a lone `@`, a leading `-` or `/`, a trailing
 * `/` or `.`, or a `.lock` component. Every revision operator is among them, and nothing
 * Git accepts as a branch is refused.
 */
function isPlainBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name === '@') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * The full ref of one branch. A project's base branch is free text in Settings, and Git
 * would read `main~1` or `main^` as a revision expression — a different commit — so
 * anything that is not a plain branch name is refused before it reaches Git.
 */
function branchRef(branch: string): string {
  if (!isPlainBranchName(branch)) {
    throw new AgentRelayError('VALIDATION_FAILED', `"${branch.slice(0, 80)}" is not a plain branch name.`, {
      remediation: 'Set the project’s base branch to the name of an existing local branch, such as main.'
    });
  }
  return `refs/heads/${branch}`;
}
