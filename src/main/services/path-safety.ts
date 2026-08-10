/**
 * Path containment checks.
 *
 * Agent Relay creates directories, spawns agents with a working directory, and
 * removes worktrees. Every one of those is a chance to act on the wrong folder,
 * so all of them route through here first.
 *
 * The rule is containment, not string prefixing: `C:\roots\wt` must not be
 * considered inside `C:\roots\w`, and `..` segments are resolved before the
 * comparison rather than merely rejected as substrings.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';

/** Windows paths are case-insensitive; POSIX paths are not. */
function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSamePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * True when `candidate` is strictly inside `root` (not equal to it).
 */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedRoot === normalizedCandidate) return false;

  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel.length === 0) return false;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export function assertAbsolutePath(path: string, what: string): void {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new AgentRelayError('UNSAFE_PATH', `${what} must be a non-empty path.`);
  }
  if (!isAbsolute(path)) {
    throw new AgentRelayError('UNSAFE_PATH', `${what} must be an absolute path.`, { details: path });
  }
  // Reject NUL and other control characters outright — they have no legitimate
  // use in a path and are a classic truncation trick. Matching control
  // characters is precisely the intent here, so the lint rule does not apply.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) {
    throw new AgentRelayError('UNSAFE_PATH', `${what} contains control characters.`);
  }
}

export function assertWithinRoot(root: string, candidate: string, what: string): void {
  assertAbsolutePath(root, `${what} root`);
  assertAbsolutePath(candidate, what);
  if (!isInsideDirectory(root, candidate)) {
    throw new AgentRelayError('UNSAFE_PATH', `${what} must be inside ${root}.`, {
      details: candidate,
      remediation: 'Change the worktrees root in Settings, or recreate the task.'
    });
  }
}

export interface WorktreePathCheck {
  readonly worktreePath: string;
  readonly worktreesRoot: string;
  readonly repositoryPath: string;
}

/**
 * The full set of conditions a task worktree path must satisfy before Agent
 * Relay will create anything there or launch an agent inside it.
 */
export function assertSafeWorktreePath({
  worktreePath,
  worktreesRoot,
  repositoryPath
}: WorktreePathCheck): void {
  assertAbsolutePath(worktreePath, 'Worktree path');
  assertAbsolutePath(worktreesRoot, 'Worktrees root');
  assertAbsolutePath(repositoryPath, 'Repository path');

  // Must live under the application-managed worktrees root.
  assertWithinRoot(worktreesRoot, worktreePath, 'Worktree path');

  // Must never be, or sit inside, the user's actual repository — that is the
  // whole point of the isolation.
  if (isSamePath(worktreePath, repositoryPath) || isInsideDirectory(repositoryPath, worktreePath)) {
    throw new AgentRelayError(
      'UNSAFE_PATH',
      'A task worktree may not be located inside the project repository.',
      { details: worktreePath }
    );
  }

  // Refuse a root or drive-root target.
  const resolved = resolve(worktreePath);
  const parent = resolve(resolved, '..');
  if (isSamePath(resolved, parent)) {
    throw new AgentRelayError('UNSAFE_PATH', 'A task worktree may not be a filesystem root.', {
      details: resolved
    });
  }
}

/**
 * Guard for "open this folder in the file manager" style requests coming from
 * the renderer: the path must be one Agent Relay already knows about.
 */
export function assertKnownPath(candidate: string, allowedRoots: readonly string[]): void {
  assertAbsolutePath(candidate, 'Path');
  const allowed = allowedRoots.some(
    (root) => root.length > 0 && (isSamePath(root, candidate) || isInsideDirectory(root, candidate))
  );
  if (!allowed) {
    throw new AgentRelayError('UNSAFE_PATH', 'That path is not managed by Agent Relay.', {
      details: candidate
    });
  }
}
