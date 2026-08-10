import { describe, expect, it } from 'vitest';
import { AgentRelayError } from '../../src/shared/domain/errors';
import {
  assertAbsolutePath,
  assertKnownPath,
  assertSafeWorktreePath,
  assertWithinRoot,
  isInsideDirectory,
  isSamePath
} from '../../src/main/services/path-safety';

const WIN = process.platform === 'win32';
const ROOT = WIN ? 'C:\\relay\\worktrees' : '/relay/worktrees';
const REPO = WIN ? 'C:\\code\\project' : '/code/project';
const inRoot = (name: string): string => (WIN ? `${ROOT}\\${name}` : `${ROOT}/${name}`);

describe('isInsideDirectory', () => {
  it('accepts a genuine child', () => {
    expect(isInsideDirectory(ROOT, inRoot('task-1'))).toBe(true);
  });

  it('accepts a nested descendant', () => {
    expect(isInsideDirectory(ROOT, inRoot(WIN ? 'a\\b\\c' : 'a/b/c'))).toBe(true);
  });

  it('rejects the directory itself', () => {
    expect(isInsideDirectory(ROOT, ROOT)).toBe(false);
  });

  it('rejects a sibling whose name merely shares a prefix', () => {
    // The classic string-prefix bug: "worktrees-evil" is not inside "worktrees".
    const sibling = WIN ? 'C:\\relay\\worktrees-evil\\x' : '/relay/worktrees-evil/x';
    expect(isInsideDirectory(ROOT, sibling)).toBe(false);
  });

  it('rejects a parent', () => {
    expect(isInsideDirectory(ROOT, WIN ? 'C:\\relay' : '/relay')).toBe(false);
  });

  it('resolves .. before deciding, so traversal cannot escape', () => {
    const escaping = inRoot(WIN ? '..\\..\\windows\\system32' : '../../etc');
    expect(isInsideDirectory(ROOT, escaping)).toBe(false);
  });

  it('does not treat a .. that stays inside as an escape', () => {
    expect(isInsideDirectory(ROOT, inRoot(WIN ? 'a\\..\\b' : 'a/../b'))).toBe(true);
  });
});

describe('isSamePath', () => {
  it('normalises separators and relative segments', () => {
    expect(isSamePath(inRoot('a'), inRoot(WIN ? 'b\\..\\a' : 'b/../a'))).toBe(true);
  });

  it.runIf(WIN)('is case-insensitive on Windows', () => {
    expect(isSamePath('C:\\Relay\\WorkTrees', 'c:\\relay\\worktrees')).toBe(true);
  });
});

describe('assertAbsolutePath', () => {
  it('rejects an empty path', () => {
    expect(() => assertAbsolutePath('', 'Worktree path')).toThrow(AgentRelayError);
  });

  it('rejects a relative path', () => {
    expect(() => assertAbsolutePath('some/relative/path', 'Worktree path')).toThrow(/absolute/i);
  });

  it('rejects control characters, including a NUL truncation attempt', () => {
    expect(() => assertAbsolutePath(`${inRoot('ok')}\u0000.txt`, 'Worktree path')).toThrow(
      /control characters/i
    );
  });

  it('accepts a normal absolute path', () => {
    expect(() => assertAbsolutePath(inRoot('task'), 'Worktree path')).not.toThrow();
  });
});

describe('assertWithinRoot', () => {
  it('accepts a child', () => {
    expect(() => assertWithinRoot(ROOT, inRoot('task'), 'Worktree path')).not.toThrow();
  });

  it('rejects anything outside', () => {
    expect(() => assertWithinRoot(ROOT, REPO, 'Worktree path')).toThrow(AgentRelayError);
  });
});

describe('assertSafeWorktreePath — invalid worktree paths are rejected', () => {
  const valid = { worktreePath: inRoot('abc-task'), worktreesRoot: ROOT, repositoryPath: REPO };

  it('accepts a well-formed worktree path', () => {
    expect(() => assertSafeWorktreePath(valid)).not.toThrow();
  });

  it('rejects a relative worktree path', () => {
    expect(() => assertSafeWorktreePath({ ...valid, worktreePath: 'worktrees/task' })).toThrow(
      /absolute/i
    );
  });

  it('rejects a path outside the worktrees root', () => {
    const outside = WIN ? 'C:\\elsewhere\\task' : '/elsewhere/task';
    expect(() => assertSafeWorktreePath({ ...valid, worktreePath: outside })).toThrow(
      /must be inside/i
    );
  });

  it('rejects a traversal that escapes the worktrees root', () => {
    const escaping = inRoot(WIN ? '..\\..\\Users\\victim' : '../../home/victim');
    expect(() => assertSafeWorktreePath({ ...valid, worktreePath: escaping })).toThrow(
      /must be inside/i
    );
  });

  it('rejects the worktrees root itself', () => {
    expect(() => assertSafeWorktreePath({ ...valid, worktreePath: ROOT })).toThrow(/must be inside/i);
  });

  it('rejects a worktree that is the repository', () => {
    expect(() =>
      assertSafeWorktreePath({ worktreePath: REPO, worktreesRoot: REPO, repositoryPath: REPO })
    ).toThrow(AgentRelayError);
  });

  it('rejects a worktree nested inside the repository', () => {
    const nested = WIN ? `${REPO}\\wt\\task` : `${REPO}/wt/task`;
    expect(() =>
      assertSafeWorktreePath({
        worktreePath: nested,
        worktreesRoot: WIN ? `${REPO}\\wt` : `${REPO}/wt`,
        repositoryPath: REPO
      })
    ).toThrow(/may not be located inside the project repository/i);
  });

  it('rejects a filesystem root', () => {
    const driveRoot = WIN ? 'C:\\' : '/';
    expect(() =>
      assertSafeWorktreePath({
        worktreePath: driveRoot,
        worktreesRoot: driveRoot,
        repositoryPath: REPO
      })
    ).toThrow(AgentRelayError);
  });

  it('rejects a NUL-terminated path', () => {
    expect(() =>
      assertSafeWorktreePath({ ...valid, worktreePath: `${inRoot('task')}\u0000` })
    ).toThrow(/control characters/i);
  });
});

describe('assertKnownPath', () => {
  it('accepts a path Agent Relay manages', () => {
    expect(() => assertKnownPath(inRoot('task'), [ROOT, REPO])).not.toThrow();
  });

  it('accepts a managed root exactly', () => {
    expect(() => assertKnownPath(REPO, [ROOT, REPO])).not.toThrow();
  });

  it('rejects an unmanaged path', () => {
    const elsewhere = WIN ? 'C:\\Windows\\System32' : '/etc';
    expect(() => assertKnownPath(elsewhere, [ROOT, REPO])).toThrow(/not managed/i);
  });

  it('rejects everything when there are no known roots', () => {
    expect(() => assertKnownPath(inRoot('task'), [])).toThrow(/not managed/i);
  });

  it('ignores empty strings in the allow list', () => {
    expect(() => assertKnownPath(inRoot('task'), ['', ''])).toThrow(/not managed/i);
  });
});
