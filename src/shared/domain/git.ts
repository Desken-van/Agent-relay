/**
 * Git-facing value objects shared with the renderer.
 *
 * These describe *observations* about a repository. Agent Relay only ever reads
 * with these; anything that mutates a repository lives behind an explicit
 * approval in the publish service.
 */

export interface ChangedFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** Porcelain status code, e.g. `M`, `A`, `D`, `R`, `??`. */
  readonly status: string;
  readonly insertions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface GitChangeSet {
  /** Raw `git status --short` output. */
  readonly statusShort: string;
  readonly changedFiles: readonly ChangedFile[];
  /** Raw `git diff --stat` output. */
  readonly diffStat: string;
  /** Full diff, possibly truncated to the configured byte budget. */
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly diffBytes: number;
  /** `git log --oneline` for the branch, newest first. */
  readonly recentCommits: readonly string[];
  /** True when there is nothing at all to review. */
  readonly isEmpty: boolean;
  readonly collectedAt: string;
}

export interface RepositoryInfo {
  readonly isRepository: boolean;
  readonly root: string | null;
  readonly currentBranch: string | null;
  readonly defaultBranchGuess: string | null;
  readonly branches: readonly string[];
  readonly hasRemoteOrigin: boolean;
  readonly remoteUrl: string | null;
  readonly isClean: boolean;
  readonly dirtyFiles: readonly string[];
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly headCommit: string | null;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly isLocked: boolean;
}

export interface ProjectValidation {
  readonly ok: boolean;
  readonly localPath: string;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly repository: RepositoryInfo | null;
}
