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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Project, Settings, Task } from '../../shared/domain/models';
import {
  shortCommit,
  specificationGroundingProblem,
  specificationGroundingState,
  type SpecificationGrounding
} from '../../shared/domain/specification-grounding';
import type { Clock, GitAdapter } from '../ports';
import { assertSafeWorktreePath, isSamePath } from './path-safety';

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
      const commit = await this.worktreeCommit(task, project, settings);
      const info = await git.inspect(task.worktreePath);
      // Before any implementation, uncommitted changes here can only be someone's manual
      // edits: content no record could name. Agent Relay never discards them.
      if (!info.isClean && task.currentRound === 0) {
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

    const commit = await git.resolveCommit(project.localPath, `refs/heads/${baseBranch}`);
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
    const info = await git.inspect(path);
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
      let commit: string;
      try {
        commit = await this.worktreeCommit(task, project, settings);
      } catch (error) {
        if (error instanceof AgentRelayError && error.code === 'WORKTREE_INVALID') {
          return { ok: false, kind: 'mismatch', reason: error.message };
        }
        throw error;
      }
      if (commit !== recorded.commit) {
        return {
          ok: false,
          kind: 'mismatch',
          reason: `the task branch moved from ${shortCommit(recorded.commit)} to ${shortCommit(commit)}.`
        };
      }
      const info = await this.deps.git.inspect(task.worktreePath);
      if (recorded.clean && !info.isClean) {
        return { ok: false, kind: 'mismatch', reason: `the task worktree now has uncommitted changes (${files(info.dirtyFiles)}).` };
      }
      return { ok: true };
    }

    if (recorded.checkout === 'task_worktree') {
      return { ok: false, kind: 'mismatch', reason: 'the task worktree it was generated from no longer exists.' };
    }
    const tip = await this.deps.git.resolveCommit(project.localPath, `refs/heads/${recorded.baseBranch}`);
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
   * The task worktree's HEAD, after proving the directory is that task's checkout of
   * the project: inside the worktrees root, on the task branch, and at the commit the
   * project repository's own ref for that branch names.
   */
  private async worktreeCommit(task: Task, project: Project, settings: Settings): Promise<string> {
    const worktreePath = task.worktreePath as string;
    const branch = task.branchName as string;
    assertSafeWorktreePath({ worktreePath, worktreesRoot: settings.worktreesRoot, repositoryPath: project.localPath });
    const info = await this.deps.git.inspect(worktreePath);
    const branchHead = await this.deps.git.resolveCommit(project.localPath, `refs/heads/${branch}`);
    if (
      !info.isRepository ||
      info.root === null ||
      !isSamePath(info.root, worktreePath) ||
      info.currentBranch !== branch ||
      info.headCommit === null ||
      branchHead !== info.headCommit
    ) {
      throw new AgentRelayError('WORKTREE_INVALID', 'The task worktree is no longer a checkout of the task branch.', {
        details: worktreePath
      });
    }
    return info.headCommit;
  }
}
