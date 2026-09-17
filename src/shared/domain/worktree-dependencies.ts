/**
 * Typed dependency-readiness state for a task worktree.
 *
 * Pure data: this module knows nothing about the filesystem, Git, or process
 * execution. `src/main/services/worktree-dependencies.ts` is what determines
 * and acts on these states.
 */

/** Every shape a task worktree's dependency situation can be in. */
export const WORKTREE_DEPENDENCY_STATES = [
  /** No package.json in the worktree: not a Node project, nothing to do. */
  'not_node_project',
  /** node_modules is linked to (or is fast-linkable from) the registered checkout. */
  'ready_linked',
  /** node_modules exists as a real, worktree-local directory. */
  'ready_local',
  /** The registered checkout has node_modules, but its manifests differ from
   *  the worktree's own — the fast link path is unsafe; a local install is
   *  needed. */
  'manifest_mismatch',
  /** The registered checkout itself has no node_modules to link from. */
  'registered_missing',
  /** An existing node_modules link is broken or points outside the
   *  registered checkout. */
  'link_broken',
  /** The worktree's own lockfile names a package manager this build does not
   *  install automatically (only npm is implemented). */
  'unsupported_package_manager'
] as const;
export type WorktreeDependencyState = (typeof WORKTREE_DEPENDENCY_STATES)[number];

/** States where dependencies are already usable — no action is offered. */
export const WORKTREE_DEPENDENCY_READY_STATES: ReadonlySet<WorktreeDependencyState> = new Set([
  'not_node_project',
  'ready_linked',
  'ready_local'
]);

/** States a blocker action button may be offered for. `unsupported_package_manager`
 *  is deliberately excluded — installing automatically for it would always fail. */
export const WORKTREE_DEPENDENCY_INSTALLABLE_BLOCKER_STATES: ReadonlySet<WorktreeDependencyState> = new Set([
  'manifest_mismatch',
  'registered_missing',
  'link_broken'
]);

export interface WorktreeDependencyStatus {
  readonly state: WorktreeDependencyState;
  /** Bounded, safe prose. Never an absolute path. */
  readonly detail: string;
}

export function isWorktreeDependencyBlocker(status: WorktreeDependencyStatus): boolean {
  return !WORKTREE_DEPENDENCY_READY_STATES.has(status.state);
}

/** How the last `installDependencies` attempt (if any) ended. */
export const WORKTREE_DEPENDENCY_INSTALL_OUTCOMES = [
  'succeeded',
  'refused',
  'unsupported_package_manager',
  'manifest_drift',
  'package_manager_failed',
  'cancelled',
  'timed_out'
] as const;
export type WorktreeDependencyInstallOutcomeKind = (typeof WORKTREE_DEPENDENCY_INSTALL_OUTCOMES)[number];

export interface WorktreeDependencyInstallOutcome {
  readonly kind: WorktreeDependencyInstallOutcomeKind;
  /** Bounded, safe prose. Never an absolute path or raw process output. */
  readonly detail: string;
  /** The status re-read after the attempt, whatever it ended with. */
  readonly status: WorktreeDependencyStatus;
}

export function worktreeDependencyInstallSucceeded(outcome: WorktreeDependencyInstallOutcome): boolean {
  return outcome.kind === 'succeeded';
}
