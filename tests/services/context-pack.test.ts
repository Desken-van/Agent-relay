import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import {
  buildContextPack,
  checkContextPackFreshness,
  refreshContextPack,
  verifyContextPackIntegrity,
  WorktreeContextSourceReader,
  type ContextSourceReader
} from '../../src/main/services/context-pack';
import {
  CONTEXT_PACK_LIMITS,
  contextPackManifest,
  contextPackNonce,
  renderContextPack,
  type ContextPack,
  type ContextPackRequest
} from '../../src/shared/domain/context-pack';

const runner = new ExecaProcessRunner();
const located = locateExecutable('git');
if (!located) throw new Error('Git is required by the Context Pack suite.');
const gitPath = located.path;

let root: string;
let repository: string;
let worktreesRoot: string;
let worktree: string;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run(gitPath, args, {
    cwd,
    timeoutMs: 20_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' }
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

const API = [
  'export function handle(store, request) {',
  "  if (request.path === '/todos' && request.method === 'GET') return { status: 200, body: store.list() };",
  "  return { status: 404, body: { error: 'not found' } };",
  '}',
  ''
].join('\n');
const STORE = 'export function createStore() {\n  const todos = [];\n  return { add(title) { todos.push(title); }, list() { return todos.slice(); } };\n}\n';
const TEST = "import { test } from 'node:test';\n\ntest('GET', () => {});\n\ntest('POST', () => {});\n";

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function reader(): WorktreeContextSourceReader {
  return new WorktreeContextSourceReader({ worktreePath: worktree, worktreesRoot, repositoryPath: repository, branchName: 'task', runner, gitExecutablePath: gitPath });
}

function request(overrides: Partial<ContextPackRequest> = {}): ContextPackRequest {
  return {
    version: 1,
    allowedPaths: ['src/', 'test/app.test.js'],
    selectors: [
      { kind: 'anchor', path: 'src/api.js', anchor: 'export function handle(', linesBefore: 0, linesAfter: 1, reason: 'symbol', label: 'handle' },
      { kind: 'file', path: 'src/store.js', reason: 'scoped_file' },
      { kind: 'file', path: 'test/app.test.js', reason: 'related_test', label: 'src/api.js' }
    ],
    maxContentBytes: 16 * 1024,
    ...overrides
  };
}

async function built(input: unknown = request()): Promise<ContextPack> {
  const result = await buildContextPack(input, reader(), new AbortController().signal);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.pack;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-context-pack-'));
  repository = join(root, 'repository');
  worktreesRoot = join(root, 'worktrees');
  worktree = join(worktreesRoot, 'task');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'test'), { recursive: true });
  mkdirSync(worktreesRoot);
  writeFileSync(join(repository, 'src', 'api.js'), API);
  writeFileSync(join(repository, 'src', 'store.js'), STORE);
  writeFileSync(join(repository, 'test', 'app.test.js'), TEST);
  writeFileSync(join(repository, '.gitignore'), 'ignored.js\n');
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Context Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture']);
  await git(repository, ['worktree', 'add', '-b', 'task', worktree, 'HEAD']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Context Pack building', () => {
  it('reads each selected part with its origin, hashes and anchor, and builds the same pack twice', async () => {
    const pack = await built();
    const again = await built();

    expect(again).toEqual(pack);
    expect(verifyContextPackIntegrity(pack)).toMatchObject({ ok: true });
    expect(pack.checkout).toEqual({ branch: 'task', headCommit: (await git(worktree, ['rev-parse', 'HEAD'])).trim() });
    expect(pack.sources).toEqual([
      { path: 'src/api.js', state: 'read', sha256: sha256(API), bytes: Buffer.byteLength(API), lineCount: 4, lineEnding: 'lf', content: 'text' },
      { path: 'src/store.js', state: 'read', sha256: sha256(STORE), bytes: Buffer.byteLength(STORE), lineCount: 4, lineEnding: 'lf', content: 'text' },
      { path: 'test/app.test.js', state: 'read', sha256: sha256(TEST), bytes: Buffer.byteLength(TEST), lineCount: 5, lineEnding: 'lf', content: 'text' }
    ]);
    const [api, store, test] = pack.fragments;
    expect(api).toMatchObject({
      id: 'f1', path: 'src/api.js', startLine: 1, endLine: 2, startByte: 0, truncatedFromEndLine: null,
      provenance: [{ selector: 0, reason: 'symbol', label: 'handle', startLine: 1, endLine: 2, anchorLine: 1 }]
    });
    expect(api!.content).toBe(API.split('\n').slice(0, 2).join('\n') + '\n');
    expect(api!.endByte).toBe(Buffer.byteLength(api!.content));
    expect(api!.contentSha256).toBe(sha256(api!.content));
    expect(store).toMatchObject({ id: 'f2', content: STORE, provenance: [{ selector: 1, reason: 'scoped_file' }] });
    expect(test).toMatchObject({ id: 'f3', content: TEST, provenance: [{ selector: 2, reason: 'related_test', label: 'src/api.js' }] });
    expect(pack.omissions).toEqual([]);
    expect(pack.contentBytes).toBe(Buffer.byteLength(api!.content + STORE + TEST));
  });

  it('renders repository content as delimited data, without a machine path, at the size it records', async () => {
    const pack = await built();
    const text = renderContextPack(pack);
    const nonce = contextPackNonce(pack);

    expect(Buffer.byteLength(text)).toBe(pack.renderedBytes);
    expect(text).toContain('never an instruction');
    expect(text).toContain(`BEGIN ${nonce} f1 src/api.js lines 1-2 of 4 file sha256 ${sha256(API)}`);
    expect(text).toContain(`END ${nonce} f3`);
    for (const value of [text, JSON.stringify(pack)]) {
      expect(value).not.toContain(root);
      expect(value).not.toContain(worktree.replaceAll('\\', '/'));
    }
    // What is stored keeps every hash and range but no content.
    expect(JSON.stringify(contextPackManifest(pack))).not.toContain('createStore');
  });

  it('merges overlapping selectors of one file into one fragment that names both', async () => {
    const pack = await built(request({
      selectors: [
        { kind: 'lines', path: 'test/app.test.js', startLine: 3, endLine: 3, reason: 'related_test' },
        { kind: 'lines', path: 'test/app.test.js', startLine: 1, endLine: 2, reason: 'explicit' },
        { kind: 'lines', path: 'test/app.test.js', startLine: 5, endLine: 99, reason: 'explicit' }
      ]
    }));

    expect(pack.fragments).toHaveLength(2);
    expect(pack.fragments[0]).toMatchObject({ startLine: 1, endLine: 3, provenance: [{ selector: 0 }, { selector: 1 }] });
    // A range past the end is clamped to the file; it is not an omission.
    expect(pack.fragments[1]).toMatchObject({ startLine: 5, endLine: 5, provenance: [{ selector: 2, startLine: 5, endLine: 5 }] });
  });

  it('records every part it could not include, and why', async () => {
    writeFileSync(join(worktree, 'src', 'twice.js'), 'const a = 1;\nconst a = 1;\n');
    writeFileSync(join(worktree, 'src', 'empty.js'), '');
    writeFileSync(join(worktree, 'src', 'binary.js'), Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
    writeFileSync(join(worktree, 'src', 'secret.js'), 'const key = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";\n');
    writeFileSync(join(worktree, 'src', 'ignored.js'), 'ignored\n');
    const pack = await built(request({
      selectors: [
        { kind: 'file', path: 'src/missing.js', reason: 'explicit' },
        { kind: 'anchor', path: 'src/twice.js', anchor: 'const a = 1;', linesBefore: 0, linesAfter: 0, reason: 'explicit' },
        { kind: 'anchor', path: 'src/api.js', anchor: 'export function nothing(', linesBefore: 0, linesAfter: 0, reason: 'symbol' },
        { kind: 'lines', path: 'src/api.js', startLine: 9, endLine: 12, reason: 'explicit' },
        { kind: 'file', path: 'src/empty.js', reason: 'explicit' },
        { kind: 'file', path: 'src/binary.js', reason: 'explicit' },
        { kind: 'file', path: 'src/secret.js', reason: 'explicit' },
        { kind: 'file', path: 'src/ignored.js', reason: 'explicit' }
      ]
    }));

    expect(pack.fragments).toEqual([]);
    expect(pack.omissions.map(({ selector, reason }) => [selector, reason])).toEqual([
      [0, 'absent'], [1, 'anchor_ambiguous'], [2, 'anchor_not_found'], [3, 'line_out_of_range'],
      [4, 'empty_file'], [5, 'not_text'], [6, 'secret_shaped'], [7, 'absent']
    ]);
    expect(JSON.stringify(pack)).not.toContain('ghp_');
    expect(renderContextPack(pack)).toContain('- src/secret.js: holds credential-shaped text');
    expect(verifyContextPackIntegrity(pack)).toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === 'win32')('refuses to follow a symlink even inside the read scope', async () => {
    symlinkSync(join(worktree, 'src', 'api.js'), join(worktree, 'src', 'link.js'));
    await git(worktree, ['add', 'src/link.js']);
    const pack = await built(request({ selectors: [{ kind: 'file', path: 'src/link.js', reason: 'explicit' }] }));

    expect(pack.sources).toEqual([{ path: 'src/link.js', state: 'refused', reason: 'symlink' }]);
    expect(pack.omissions).toEqual([{ selector: 0, path: 'src/link.js', reason: 'refused' }]);
  });

  it('keeps CRLF content byte for byte', async () => {
    const crlf = 'line one\r\nline two\r\nline three\r\n';
    writeFileSync(join(worktree, 'src', 'crlf.js'), crlf);
    const pack = await built(request({ selectors: [{ kind: 'lines', path: 'src/crlf.js', startLine: 2, endLine: 3, reason: 'explicit' }] }));

    expect(pack.sources[0]).toMatchObject({ lineEnding: 'crlf', lineCount: 3 });
    expect(pack.fragments[0]).toMatchObject({ content: 'line two\r\nline three\r\n', startByte: 10, endByte: crlf.length });
  });
});

describe('Context Pack limits', () => {
  it('cuts a fragment at a line boundary when the budget runs out, and leaves later parts out', async () => {
    const apiBytes = Buffer.byteLength(API.split('\n').slice(0, 2).join('\n') + '\n');
    const storeFirstLine = Buffer.byteLength(`${STORE.split('\n')[0]}\n`);
    const pack = await built(request({ maxContentBytes: apiBytes + storeFirstLine + 5 }));

    // The anchor selector comes first, so it keeps its content; store.js is cut; the test file has no room.
    const [api, store] = pack.fragments;
    expect(api!.truncatedFromEndLine).toBeNull();
    expect(store).toMatchObject({ path: 'src/store.js', startLine: 1, truncatedFromEndLine: 4 });
    expect(store!.endLine).toBeLessThan(4);
    expect(STORE.startsWith(store!.content)).toBe(true);
    expect(store!.content.endsWith('\n')).toBe(true);
    expect(pack.omissions).toEqual([{ selector: 2, path: 'test/app.test.js', reason: 'budget_exhausted' }]);
    expect(pack.contentBytes).toBeLessThanOrEqual(pack.request.maxContentBytes);
    expect(renderContextPack(pack)).toContain(`(f2: lines ${store!.endLine + 1}-4 were left out for the budget)`);
    expect(verifyContextPackIntegrity(pack)).toMatchObject({ ok: true });
  });

  it('leaves out a part whose single line is longer than a fragment may be', async () => {
    writeFileSync(join(worktree, 'src', 'long.js'), `${'x'.repeat(CONTEXT_PACK_LIMITS.maxFragmentBytes + 1)}\nshort\n`);
    const pack = await built(request({
      selectors: [{ kind: 'file', path: 'src/long.js', reason: 'explicit' }],
      maxContentBytes: CONTEXT_PACK_LIMITS.maxContentBytes
    }));

    expect(pack.fragments).toEqual([]);
    expect(pack.omissions).toEqual([{ selector: 0, path: 'src/long.js', reason: 'fragment_too_large' }]);
  });

  it('does not read a file over the size limit, and refuses a request over the read limit', async () => {
    writeFileSync(join(worktree, 'src', 'big.js'), 'y'.repeat(CONTEXT_PACK_LIMITS.maxSourceFileBytes + 1));
    const pack = await built(request({ selectors: [{ kind: 'file', path: 'src/big.js', reason: 'explicit' }] }));
    expect(pack.sources).toEqual([{ path: 'src/big.js', state: 'refused', reason: 'too_large' }]);

    const files = Math.ceil(CONTEXT_PACK_LIMITS.maxReadBytes / CONTEXT_PACK_LIMITS.maxSourceFileBytes) + 1;
    for (let index = 0; index < files; index += 1) {
      writeFileSync(join(worktree, 'src', `part${index}.js`), 'z'.repeat(CONTEXT_PACK_LIMITS.maxSourceFileBytes - 1));
    }
    const result = await buildContextPack(
      request({ selectors: Array.from({ length: files }, (_, index) => ({ kind: 'file' as const, path: `src/part${index}.js`, reason: 'explicit' as const })) }),
      reader(),
      new AbortController().signal
    );
    expect(result).toMatchObject({ ok: false, code: 'read_limit_exceeded' });
  });

  it('refuses a selector outside the read scope before reading anything', async () => {
    let observed = 0;
    const counting: ContextSourceReader = { observe: (paths, signal) => { observed += 1; return reader().observe(paths, signal); } };
    const result = await buildContextPack(
      request({ allowedPaths: ['src/'], selectors: [{ kind: 'file', path: 'test/app.test.js', reason: 'related_test' }] }),
      counting,
      new AbortController().signal
    );

    expect(result).toEqual({ ok: false, code: 'path_not_allowed', message: expect.any(String), path: 'test/app.test.js' });
    expect(observed).toBe(0);
    // A directory entry covers what is under it, not a sibling that shares its prefix.
    expect(await buildContextPack(
      request({ allowedPaths: ['src/'], selectors: [{ kind: 'file', path: 'src-old/api.js', reason: 'explicit' }] }),
      counting,
      new AbortController().signal
    )).toMatchObject({ ok: false, code: 'path_not_allowed' });
    expect(observed).toBe(0);
  });

  it('refuses machine paths, escapes and .git as invalid requests', async () => {
    for (const path of ['/etc/passwd', 'C:/Users/op/a.js', '..\\a.js', '../a.js', 'src/../../a.js', '.git/config', 'src//a.js']) {
      const result = await buildContextPack(
        request({ allowedPaths: ['src/'], selectors: [{ kind: 'file', path, reason: 'explicit' }] }),
        reader(),
        new AbortController().signal
      );
      expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
      if (!result.ok) expect(result.message).not.toContain(path);
    }
    expect(await buildContextPack(request({ allowedPaths: ['/home/op/'] }), reader(), new AbortController().signal))
      .toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await buildContextPack(request({ maxContentBytes: CONTEXT_PACK_LIMITS.maxContentBytes + 1 }), reader(), new AbortController().signal))
      .toMatchObject({ ok: false, code: 'invalid_request' });
  });
});

describe('Context Pack identity and freshness', () => {
  it('detects a wrong hash anywhere in a pack', async () => {
    const pack = await built();
    const fragment = pack.fragments[1]!;
    const tampered: ContextPack[] = [
      { ...pack, fragments: pack.fragments.map((item) => (item === fragment ? { ...item, content: item.content.replace('todos', 'secrets') } : item)) },
      { ...pack, fragments: pack.fragments.map((item) => (item === fragment ? { ...item, contentSha256: sha256('other') } : item)) },
      { ...pack, sources: pack.sources.map((source) => (source.state === 'read' ? { ...source, sha256: sha256('other') } : source)) },
      { ...pack, sha256: sha256('other') },
      { ...pack, renderedBytes: pack.renderedBytes + 1 },
      { ...pack, omissions: [{ selector: 0, path: 'src/api.js', reason: 'absent' }] }
    ];

    for (const value of tampered) expect(verifyContextPackIntegrity(value)).toMatchObject({ ok: false });
    expect(verifyContextPackIntegrity(pack)).toMatchObject({ ok: true });
  });

  it('turns stale when a source file changes, and is rebuilt from its own request', async () => {
    const pack = await built();
    expect(await checkContextPackFreshness(pack, reader(), new AbortController().signal)).toEqual({ fresh: true });

    writeFileSync(join(worktree, 'src', 'store.js'), STORE.replace('slice()', 'slice(0)'));
    expect(await checkContextPackFreshness(pack, reader(), new AbortController().signal))
      .toEqual({ fresh: false, stale: [{ kind: 'source_changed', path: 'src/store.js' }] });

    const refreshed = await refreshContextPack(pack, reader(), new AbortController().signal);
    expect(refreshed).toMatchObject({ ok: true, rebuilt: true });
    if (!refreshed.ok) return;
    expect(refreshed.pack.sha256).not.toBe(pack.sha256);
    expect(refreshed.pack.fragments[1]!.content).toContain('slice(0)');
    expect(await refreshContextPack(refreshed.pack, reader(), new AbortController().signal)).toMatchObject({ ok: true, rebuilt: false });
  });

  it('turns stale when a file it found absent appears, or one it read is deleted', async () => {
    const pack = await built(request({ selectors: [{ kind: 'file', path: 'src/new.js', reason: 'explicit' }, { kind: 'file', path: 'src/store.js', reason: 'explicit' }] }));
    writeFileSync(join(worktree, 'src', 'new.js'), 'export const created = true;\n');
    rmSync(join(worktree, 'src', 'store.js'));

    expect(await checkContextPackFreshness(pack, reader(), new AbortController().signal)).toEqual({
      fresh: false,
      stale: [{ kind: 'source_appeared', path: 'src/new.js' }, { kind: 'source_removed', path: 'src/store.js' }]
    });
  });

  it('turns stale when the worktree moves to another commit, even with the same bytes', async () => {
    const pack = await built();
    await git(worktree, ['commit', '--allow-empty', '-m', 'move']);

    expect(await checkContextPackFreshness(pack, reader(), new AbortController().signal))
      .toEqual({ fresh: false, stale: [{ kind: 'checkout_changed' }] });
  });

  it('refuses a worktree that is not the task branch any more', async () => {
    const pack = await built();
    await git(worktree, ['checkout', '-q', '-b', 'elsewhere']);

    expect(await checkContextPackFreshness(pack, reader(), new AbortController().signal))
      .toEqual({ fresh: false, stale: [{ kind: 'worktree_invalid' }] });
    expect(await buildContextPack(request(), reader(), new AbortController().signal)).toMatchObject({ ok: false, code: 'worktree_invalid' });
  });

  it('refuses a pack whose sources changed while it was being built', async () => {
    let passes = 0;
    const editing: ContextSourceReader = {
      observe: async (paths, signal) => {
        passes += 1;
        if (passes === 2) writeFileSync(join(worktree, 'src', 'api.js'), `${API}// edited\n`);
        return reader().observe(paths, signal);
      }
    };

    expect(await buildContextPack(request(), editing, new AbortController().signal))
      .toMatchObject({ ok: false, code: 'sources_changed', path: 'src/api.js' });
  });
});

describe('Context Pack cancellation', () => {
  it('throws CANCELLED and builds nothing when cancelled before, between or during its reads', async () => {
    const before = new AbortController();
    before.abort();
    await expect(buildContextPack(request(), reader(), before.signal)).rejects.toMatchObject({ code: 'CANCELLED' });

    const between = new AbortController();
    const abortingAfterFirstPass: ContextSourceReader = {
      observe: async (paths, signal) => {
        const observation = await reader().observe(paths, signal);
        between.abort();
        return observation;
      }
    };
    await expect(buildContextPack(request(), abortingAfterFirstPass, between.signal)).rejects.toMatchObject({ code: 'CANCELLED' });

    // During the worktree's own read: cancelled as its identity check starts.
    const during = new AbortController();
    const tools = new WorktreeContextSourceReader({
      worktreePath: worktree, worktreesRoot, repositoryPath: repository, branchName: 'task', gitExecutablePath: gitPath,
      runner: { run: (file, args, options) => { during.abort(); return runner.run(file, args, options); } }
    });
    await expect(buildContextPack(request(), tools, during.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(checkContextPackFreshness(await built(), tools, during.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

/**
 * What every successfully built pack must be: intact by its own checks, every selector answered exactly once, and
 * every fragment exactly the bytes of the file it names, at the range it names, under the hash it names.
 */
function expectFaithful(pack: ContextPack): void {
  expect(verifyContextPackIntegrity(pack)).toEqual({ ok: true, pack });
  const answers = [...pack.fragments.flatMap((fragment) => fragment.provenance.map((item) => item.selector)), ...pack.omissions.map((item) => item.selector)];
  expect(answers.sort((left, right) => left - right)).toEqual(pack.request.selectors.map((_, index) => index));
  for (const fragment of pack.fragments) {
    const raw = readFileSync(join(worktree, ...fragment.path.split('/')));
    const slice = raw.subarray(fragment.startByte, fragment.endByte);
    expect(Buffer.from(fragment.content, 'utf8').equals(slice)).toBe(true);
    expect(fragment.contentSha256).toBe(createHash('sha256').update(slice).digest('hex'));
  }
}

describe('Context Pack bytes: a BOM or U+FEFF is content like any other', () => {
  it('keeps a leading BOM and a U+FEFF that starts a fragment, byte for byte, with LF and CRLF', async () => {
    writeFileSync(join(worktree, 'src', 'bom-lf.js'), '﻿export const x = 1;\nexport const y = 2;\n');
    writeFileSync(join(worktree, 'src', 'bom-crlf.js'), '﻿export const x=1;\r\nexport const z=3;\r\n');
    writeFileSync(join(worktree, 'src', 'inner.js'), 'first\n﻿second\nthird\n');
    const pack = await built(request({
      selectors: [
        { kind: 'file', path: 'src/bom-lf.js', reason: 'explicit' },
        { kind: 'lines', path: 'src/bom-crlf.js', startLine: 1, endLine: 1, reason: 'explicit' },
        { kind: 'anchor', path: 'src/bom-crlf.js', anchor: 'export const z', linesBefore: 0, linesAfter: 0, reason: 'symbol', label: 'z' },
        { kind: 'lines', path: 'src/inner.js', startLine: 2, endLine: 2, reason: 'explicit' },
        { kind: 'anchor', path: 'src/inner.js', anchor: 'third', linesBefore: 0, linesAfter: 0, reason: 'explicit' }
      ]
    }));

    expectFaithful(pack);
    expect(pack.omissions).toEqual([]);
    const byPath = new Map(pack.fragments.map((fragment) => [fragment.path, fragment]));
    expect(byPath.get('src/bom-lf.js')).toMatchObject({ startByte: 0, content: '﻿export const x = 1;\nexport const y = 2;\n' });
    expect(byPath.get('src/bom-crlf.js')).toMatchObject({ startByte: 0, startLine: 1, endLine: 2, content: '﻿export const x=1;\r\nexport const z=3;\r\n' });
    expect(byPath.get('src/inner.js')).toMatchObject({ startLine: 2, endLine: 3, startByte: 6, content: '﻿second\nthird\n' });
    expect(pack.sources.find((source) => source.path === 'src/bom-crlf.js')).toMatchObject({ lineEnding: 'crlf', lineCount: 2 });
  });

  it('finds an anchor in a BOM file at the line it is on, and still leaves out a credential behind a BOM', async () => {
    writeFileSync(join(worktree, 'src', 'bom-anchor.js'), '﻿// header\nexport function handle() {}\n');
    writeFileSync(join(worktree, 'src', 'bom-secret.js'), '﻿const key = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";\n');
    const pack = await built(request({
      selectors: [
        { kind: 'anchor', path: 'src/bom-anchor.js', anchor: 'export function handle(', linesBefore: 0, linesAfter: 0, reason: 'symbol' },
        { kind: 'file', path: 'src/bom-secret.js', reason: 'explicit' }
      ]
    }));

    expectFaithful(pack);
    expect(pack.fragments).toHaveLength(1);
    expect(pack.fragments[0]).toMatchObject({ startLine: 2, endLine: 2, content: 'export function handle() {}\n', provenance: [{ selector: 0, anchorLine: 2 }] });
    expect(pack.omissions).toEqual([{ selector: 1, path: 'src/bom-secret.js', reason: 'secret_shaped' }]);
  });
});
