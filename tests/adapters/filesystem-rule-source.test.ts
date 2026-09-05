import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemRuleSourceReader } from '../../src/main/adapters/rules/filesystem-rule-source';

const roots: string[] = [];
const reader = new FilesystemRuleSourceReader();

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-relay-rules-'));
  roots.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('filesystem rule source', () => {
  it('discovers fixed memories and supported nested rule files in stable order', () => {
    const path = root();
    write(join(path, 'CLAUDE.md'), 'claude');
    write(join(path, 'AGENTS.md'), 'agents');
    write(join(path, '.github', 'copilot-instructions.md'), 'copilot');
    write(join(path, '.claude', 'rules', 'nested', 'z.md'), 'z');
    write(join(path, '.claude', 'rules', 'a.md'), 'a');
    write(join(path, '.cursor', 'rules', 'b.mdc'), 'b');
    write(join(path, '.cursor', 'rules', 'ignored.txt'), 'not a rule');

    const result = reader.discoverProject(path, 100);

    expect(result.paths).toEqual([
      '.claude/rules/a.md',
      '.claude/rules/nested/z.md',
      '.cursor/rules/b.mdc',
      '.github/copilot-instructions.md',
      'AGENTS.md',
      'CLAUDE.md'
    ]);
    expect(result.omitted).toContainEqual({ path: 'GEMINI.md', reason: 'missing' });
    expect(result.paths).not.toContain('.cursor/rules/ignored.txt');
  });

  it('reports missing rule directories instead of pretending discovery was complete', () => {
    const path = root();
    const result = reader.discoverProject(path, 100);

    expect(result.omitted).toContainEqual({ path: '.claude/rules/**', reason: 'missing' });
    expect(result.omitted).toContainEqual({ path: '.cursor/rules/**', reason: 'missing' });
  });

  it('stops recursive discovery at the configured entry limit', () => {
    const path = root();
    write(join(path, '.claude', 'rules', 'a.md'), 'a');
    write(join(path, '.claude', 'rules', 'b.md'), 'b');

    const result = reader.discoverProject(path, 1);

    expect(result.paths).toEqual(['.claude/rules/a.md']);
    expect(result.omitted).toContainEqual({ path: '.claude/rules/**', reason: 'discovery_limit' });
  });

  it('reads the exact bytes of one source-relative file', () => {
    const path = root();
    write(join(path, 'AGENTS.md'), 'first\r\nsecond\n');

    const result = reader.read(path, 'AGENTS.md', 1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('first\r\nsecond\n');
  });

  it('refuses traversal and alternate path spelling', () => {
    const path = root();

    expect(() => reader.read(path, '../outside.md', 1_000)).toThrow(/traverse/i);
    expect(() => reader.read(path, 'rules\\outside.md', 1_000)).toThrow(/relative POSIX/i);
    expect(() => reader.read(path, 'rules/../AGENTS.md', 1_000)).toThrow(/spelling/i);
  });

  it('reports a missing file, a directory, and an oversized file distinctly', () => {
    const path = root();
    mkdirSync(join(path, 'folder'));
    write(join(path, 'large.md'), 'x'.repeat(20));

    expect(reader.read(path, 'missing.md', 100)).toEqual({
      ok: false,
      path: 'missing.md',
      reason: 'missing'
    });
    expect(reader.read(path, 'folder', 100)).toEqual({
      ok: false,
      path: 'folder',
      reason: 'not_file'
    });
    expect(reader.read(path, 'large.md', 10)).toEqual({
      ok: false,
      path: 'large.md',
      reason: 'too_large'
    });
  });

  it('never follows a symlink, even when its destination is inside the source', () => {
    const path = root();
    write(join(path, 'real', 'rules.md'), 'rules');
    symlinkSync(
      join(path, 'real'),
      join(path, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(reader.read(path, 'linked/rules.md', 100)).toEqual({
      ok: false,
      path: 'linked/rules.md',
      reason: 'symlink'
    });
  });

  it('does not enumerate a rule directory that is itself a symlink', () => {
    const path = root();
    write(join(path, 'external', 'secret.md'), 'must not be discovered');
    mkdirSync(join(path, '.claude'), { recursive: true });
    symlinkSync(
      join(path, 'external'),
      join(path, '.claude', 'rules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = reader.discoverProject(path, 100);
    expect(result.paths).not.toContain('.claude/rules/secret.md');
    expect(result.omitted).toContainEqual({ path: '.claude/rules', reason: 'symlink' });
  });
});
