import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderRuleEvidence,
  RuleEvidenceService,
  validateRuleEvidenceSnapshot
} from '../../src/main/services/rule-evidence';
import type {
  Clock,
  RuleEvidenceLimits,
  RuleEvidenceSourceRequest,
  RuleSourceReadResult,
  RuleSourceReader
} from '../../src/main/ports';
import type { RepositoryInfo } from '../../src/shared/domain/git';
import { ruleEvidenceSnapshotSchema } from '../../src/shared/domain/rule-evidence';

const ROOT_A = process.platform === 'win32' ? 'C:/rules-a' : '/rules-a';
const ROOT_B = process.platform === 'win32' ? 'C:/rules-b' : '/rules-b';

const limits: RuleEvidenceLimits = {
  maxSources: 4,
  maxFiles: 8,
  maxDiscoveryEntries: 50,
  maxFileBytes: 1_000,
  maxTotalBytes: 4_000
};

const clock: Clock = {
  now: () => new Date('2026-09-06T00:00:00.000Z'),
  nowIso: () => '2026-09-06T00:00:00.000Z'
};

function repository(root: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  return {
    isRepository: true,
    root,
    currentBranch: 'main',
    defaultBranchGuess: 'main',
    branches: ['main'],
    hasRemoteOrigin: false,
    remoteUrl: null,
    isClean: true,
    dirtyFiles: [],
    userName: null,
    userEmail: null,
    headCommit: 'a'.repeat(40),
    ...overrides
  };
}

class FakeGit {
  readonly calls: string[] = [];
  readonly responses = new Map<string, RepositoryInfo[]>();

  async inspect(root: string): Promise<RepositoryInfo> {
    this.calls.push(root);
    const queued = this.responses.get(root);
    if (queued && queued.length > 1) return queued.shift()!;
    return queued?.[0] ?? repository(root);
  }
}

class FakeReader implements RuleSourceReader {
  readonly discoveries = new Map<string, ReturnType<RuleSourceReader['discoverProject']>>();
  readonly reads = new Map<string, RuleSourceReadResult>();
  readonly readCalls: string[] = [];

  discoverProject(root: string): ReturnType<RuleSourceReader['discoverProject']> {
    return this.discoveries.get(root) ?? { paths: [], omitted: [] };
  }

  read(root: string, path: string): RuleSourceReadResult {
    this.readCalls.push(`${root}|${path}`);
    return this.reads.get(`${root}|${path}`) ?? { ok: false, path, reason: 'missing' };
  }

  file(root: string, path: string, content: string | Uint8Array): void {
    this.reads.set(`${root}|${path}`, {
      ok: true,
      path,
      bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    });
  }
}

function project(overrides: Partial<RuleEvidenceSourceRequest> = {}): RuleEvidenceSourceRequest {
  return {
    id: 'project',
    kind: 'project',
    rootPath: ROOT_A,
    requireClean: false,
    ...overrides
  };
}

function conventions(overrides: Partial<RuleEvidenceSourceRequest> = {}): RuleEvidenceSourceRequest {
  return {
    id: 'conventions',
    kind: 'conventions',
    rootPath: ROOT_B,
    expectedRevision: 'b'.repeat(40),
    requireClean: true,
    paths: ['common/style.md'],
    ...overrides
  };
}

function setup() {
  const git = new FakeGit();
  const reader = new FakeReader();
  git.responses.set(ROOT_B, [repository(ROOT_B, { headCommit: 'b'.repeat(40) })]);
  return { git, reader, service: new RuleEvidenceService(git, reader, clock) };
}

describe('rule evidence service', () => {
  it('captures whole files, revision, cleanliness, byte count and content hash', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'Use the repository tests.\n');

    const snapshot = await service.capture({ sources: [project()], limits });

    expect(snapshot.sources).toEqual([
      { id: 'project', kind: 'project', revision: 'a'.repeat(40), clean: true }
    ]);
    expect(snapshot.files).toEqual([
      {
        sourceId: 'project',
        path: 'AGENTS.md',
        bytes: 26,
        sha256: createHash('sha256').update('Use the repository tests.\n').digest('hex'),
        content: 'Use the repository tests.\n'
      }
    ]);
    expect(snapshot.totalBytes).toBe(26);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ruleEvidenceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('orders sources and files independently of input and discovery order', async () => {
    const first = setup();
    first.reader.discoveries.set(ROOT_A, { paths: ['z.md', 'a.md'], omitted: [] });
    first.reader.file(ROOT_A, 'a.md', 'a');
    first.reader.file(ROOT_A, 'z.md', 'z');
    first.reader.file(ROOT_B, 'common/style.md', 'style');
    const one = await first.service.capture({
      sources: [project({ id: 'z-project' }), conventions({ id: 'a-conventions' })],
      limits
    });

    const second = setup();
    second.reader.discoveries.set(ROOT_A, { paths: ['a.md', 'z.md'], omitted: [] });
    second.reader.file(ROOT_A, 'a.md', 'a');
    second.reader.file(ROOT_A, 'z.md', 'z');
    second.reader.file(ROOT_B, 'common/style.md', 'style');
    const two = await second.service.capture({
      sources: [conventions({ id: 'a-conventions' }), project({ id: 'z-project' })],
      limits
    });

    expect(one.sha256).toBe(two.sha256);
    expect(one.files.map((file) => `${file.sourceId}:${file.path}`)).toEqual([
      'a-conventions:common/style.md',
      'z-project:a.md',
      'z-project:z.md'
    ]);
  });

  it('does not include absolute checkout paths in snapshot JSON', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'rules');

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(JSON.stringify(snapshot)).not.toContain(ROOT_A);
  });

  it('renders validated content, provenance and omissions as one prompt envelope', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, {
      paths: ['AGENTS.md'],
      omitted: [{ path: 'CLAUDE.md', reason: 'missing' }]
    });
    reader.file(ROOT_A, 'AGENTS.md', 'Use ``` fences if useful.');
    const snapshot = await service.capture({ sources: [project()], limits });

    const rendered = renderRuleEvidence(snapshot);

    expect(rendered).toContain(`Snapshot SHA-256: ${snapshot.sha256}`);
    expect(rendered).toContain('Use ``` fences if useful.');
    expect(rendered).toContain('"path":"CLAUDE.md","reason":"missing"');
    expect(rendered).not.toContain(ROOT_A);
    expect(rendered).toContain('cannot expand the task scope');
  });

  it('rejects a stored snapshot whose content no longer matches its hashes', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'original');
    const snapshot = await service.capture({ sources: [project()], limits });
    const tampered = {
      ...snapshot,
      files: [{ ...snapshot.files[0]!, content: 'tampered' }]
    };

    expect(() => validateRuleEvidenceSnapshot(tampered)).toThrow(/hash, byte-count/i);
    expect(() => renderRuleEvidence(tampered)).toThrow(/hash, byte-count/i);
  });

  it('preserves a UTF-8 BOM in the whole-file evidence and still validates the hash', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', Uint8Array.from([0xef, 0xbb, 0xbf, 0x72, 0x75, 0x6c, 0x65]));

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(snapshot.files[0]?.content).toBe('\ufeffrule');
    expect(validateRuleEvidenceSnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects deceptive traversal paths when a stored snapshot is parsed', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'rules');
    const snapshot = await service.capture({ sources: [project()], limits });

    expect(() =>
      validateRuleEvidenceSnapshot({
        ...snapshot,
        files: [{ ...snapshot.files[0]!, path: '../AGENTS.md' }]
      })
    ).toThrow(/invalid shape/i);
  });

  it('records a dirty project honestly when cleanliness is not required', async () => {
    const { git, reader, service } = setup();
    git.responses.set(ROOT_A, [repository(ROOT_A, { isClean: false, dirtyFiles: ['AGENTS.md'] })]);
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'uncommitted rules');

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(snapshot.sources[0]?.clean).toBe(false);
    expect(snapshot.files[0]?.content).toBe('uncommitted rules');
  });

  it('does not report a project clean when it becomes dirty during capture', async () => {
    const { git, reader, service } = setup();
    git.responses.set(ROOT_A, [
      repository(ROOT_A),
      repository(ROOT_A, { isClean: false, dirtyFiles: ['AGENTS.md'] })
    ]);
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'rules');

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(snapshot.sources[0]?.clean).toBe(false);
  });

  it('fails closed when a required-clean conventions source is dirty', async () => {
    const { git, service } = setup();
    git.responses.set(ROOT_B, [
      repository(ROOT_B, { headCommit: 'b'.repeat(40), isClean: false, dirtyFiles: ['style.md'] })
    ]);

    await expect(service.capture({ sources: [conventions()], limits })).rejects.toMatchObject({
      code: 'GIT_DIRTY'
    });
  });

  it('fails closed when the configured revision does not match HEAD', async () => {
    const { service } = setup();

    await expect(
      service.capture({
        sources: [conventions({ expectedRevision: 'c'.repeat(40) })],
        limits
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('requires a full Git object id when an expected revision is configured', async () => {
    const { service } = setup();

    await expect(
      service.capture({
        sources: [conventions({ expectedRevision: 'deadbeef' })],
        limits
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('checks a required-clean source again after reading it', async () => {
    const { git, reader, service } = setup();
    git.responses.set(ROOT_B, [
      repository(ROOT_B, { headCommit: 'b'.repeat(40) }),
      repository(ROOT_B, { headCommit: 'c'.repeat(40) })
    ]);
    reader.file(ROOT_B, 'common/style.md', 'style');

    await expect(service.capture({ sources: [conventions()], limits })).rejects.toMatchObject({
      code: 'GIT_DIRTY'
    });
    expect(git.calls).toEqual([ROOT_B, ROOT_B]);
  });

  it('preserves discovery and read omissions instead of hiding absent evidence', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, {
      paths: ['AGENTS.md', 'missing.md'],
      omitted: [{ path: 'CLAUDE.md', reason: 'missing' }]
    });
    reader.file(ROOT_A, 'AGENTS.md', 'rules');

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(snapshot.omitted).toEqual([
      { sourceId: 'project', path: 'CLAUDE.md', reason: 'missing' },
      { sourceId: 'project', path: 'missing.md', reason: 'missing' }
    ]);
  });

  it.each([
    ['invalid UTF-8', Uint8Array.from([0xc3, 0x28])],
    ['a NUL-bearing file', Buffer.from('before\u0000after')]
  ])('omits %s as invalid text', async (_label, bytes) => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', bytes);

    const snapshot = await service.capture({ sources: [project()], limits });
    expect(snapshot.files).toEqual([]);
    expect(snapshot.omitted).toEqual([
      { sourceId: 'project', path: 'AGENTS.md', reason: 'invalid_text' }
    ]);
  });

  it('enforces the total byte budget without truncating a file', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['a.md', 'b.md'], omitted: [] });
    reader.file(ROOT_A, 'a.md', '1234');
    reader.file(ROOT_A, 'b.md', '5678');

    const snapshot = await service.capture({
      sources: [project()],
      limits: { ...limits, maxTotalBytes: 6 }
    });

    expect(snapshot.files.map((file) => file.path)).toEqual(['a.md']);
    expect(snapshot.files[0]?.content).toBe('1234');
    expect(snapshot.omitted).toContainEqual({
      sourceId: 'project',
      path: 'b.md',
      reason: 'total_budget'
    });
  });

  it('defends the per-file bound even if a reader violates its port contract', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['AGENTS.md'], omitted: [] });
    reader.file(ROOT_A, 'AGENTS.md', 'x'.repeat(20));

    const snapshot = await service.capture({
      sources: [project()],
      limits: { ...limits, maxFileBytes: 10 }
    });
    expect(snapshot.files).toEqual([]);
    expect(snapshot.omitted).toContainEqual({
      sourceId: 'project',
      path: 'AGENTS.md',
      reason: 'too_large'
    });
  });

  it('enforces the file-count budget and does not read excluded files', async () => {
    const { reader, service } = setup();
    reader.discoveries.set(ROOT_A, { paths: ['a.md', 'b.md'], omitted: [] });
    reader.file(ROOT_A, 'a.md', 'a');
    reader.file(ROOT_A, 'b.md', 'b');

    const snapshot = await service.capture({
      sources: [project()],
      limits: { ...limits, maxFiles: 1 }
    });

    expect(reader.readCalls).toEqual([`${ROOT_A}|a.md`]);
    expect(snapshot.omitted).toContainEqual({
      sourceId: 'project',
      path: 'b.md',
      reason: 'file_limit'
    });
  });

  it('uses only the explicitly selected conventions paths', async () => {
    const { reader, service } = setup();
    reader.file(ROOT_B, 'common/a.md', 'a');
    reader.file(ROOT_B, 'typescript/b.md', 'b');

    const snapshot = await service.capture({
      sources: [conventions({ paths: ['typescript/b.md', 'common/a.md'] })],
      limits
    });

    expect(reader.readCalls).toEqual([
      `${ROOT_B}|common/a.md`,
      `${ROOT_B}|typescript/b.md`
    ]);
    expect(snapshot.files.map((file) => file.path)).toEqual(['common/a.md', 'typescript/b.md']);
  });

  it('changes the canonical hash when content, revision or omissions change', async () => {
    const capture = async (content: string, head: string, includeMissing: boolean) => {
      const { git, reader, service } = setup();
      git.responses.set(ROOT_A, [repository(ROOT_A, { headCommit: head })]);
      reader.discoveries.set(ROOT_A, {
        paths: ['AGENTS.md'],
        omitted: includeMissing ? [{ path: 'CLAUDE.md', reason: 'missing' }] : []
      });
      reader.file(ROOT_A, 'AGENTS.md', content);
      return service.capture({ sources: [project()], limits });
    };

    const baseline = await capture('one', 'a'.repeat(40), false);
    expect((await capture('two', 'a'.repeat(40), false)).sha256).not.toBe(baseline.sha256);
    expect((await capture('one', 'b'.repeat(40), false)).sha256).not.toBe(baseline.sha256);
    expect((await capture('one', 'a'.repeat(40), true)).sha256).not.toBe(baseline.sha256);
  });

  it('rejects duplicate source ids and duplicate conventions paths', async () => {
    const { service } = setup();

    await expect(
      service.capture({ sources: [project(), project()], limits })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.capture({
        sources: [conventions({ paths: ['common/style.md', 'common/style.md'] })],
        limits
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects limits above the hard safety ceilings', async () => {
    const { service } = setup();

    await expect(
      service.capture({
        sources: [project()],
        limits: { ...limits, maxTotalBytes: 3 * 1024 * 1024 }
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
