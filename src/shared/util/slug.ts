/**
 * Slug and branch-name helpers.
 *
 * Branch names end up on the command line and (potentially) on a remote, so
 * they are built from a strict allowlist rather than by escaping a free-form
 * string. Anything outside `[a-z0-9-]` is dropped, not encoded.
 */

/** Git's own rules, plus a few extra characters Windows dislikes in paths. */
const FORBIDDEN_BRANCH_SEQUENCES = ['..', '@{', '//'];

export function slugify(input: string, maxLength = 40): string {
  const slug = input
    .normalize('NFKD')
    // Strip combining marks so "café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : 'task';
}

/** Short, collision-resistant suffix taken from a task id. */
export function shortId(id: string, length = 8): string {
  const cleaned = id.replace(/[^A-Za-z0-9]/g, '');
  return (cleaned.length > 0 ? cleaned : 'task').slice(0, length).toLowerCase();
}

/**
 * Build the dedicated branch name for a task: `agent-relay/<short-id>-<slug>`.
 */
export function buildBranchName(taskId: string, title: string): string {
  return `agent-relay/${shortId(taskId)}-${slugify(title)}`;
}

/** Directory name for a task worktree; mirrors the branch but is path-safe. */
export function buildWorktreeDirName(taskId: string, title: string): string {
  return `${shortId(taskId)}-${slugify(title)}`;
}

export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.startsWith('-')) return false;
  return !FORBIDDEN_BRANCH_SEQUENCES.some((seq) => name.includes(seq));
}

/** Repository names allowed by GitHub. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
}

/** Owner (user or organisation) names allowed by GitHub. */
export function isValidGithubOwner(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name);
}
