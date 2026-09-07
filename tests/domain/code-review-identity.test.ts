/**
 * The identity contract, tested as pure functions.
 *
 * Everything the code-review gate promises rests on two hashes behaving
 * exactly as claimed: a snapshot hash that changes when and only when the
 * reviewed content changes, and a finding fingerprint that merges an exact
 * repeat and nothing else. Both are pure, so they are tested without a
 * database, a process or a clock — nothing here can pass for the wrong reason.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalCodeSnapshot,
  codeFindingFingerprintInput,
  codeReviewSnapshotSchema,
  normaliseFindingText,
  type CodeReviewSnapshot,
  type ProviderCodeFinding
} from '../../src/shared/domain/code-review';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function content(seed: string): string {
  return digest(seed);
}

function snapshot(overrides: Partial<CodeReviewSnapshot> = {}): CodeReviewSnapshot {
  return codeReviewSnapshotSchema.parse({
    version: 1,
    baseCommit: A,
    headCommit: B,
    branch: 'agent/task-1',
    entries: [
      { path: 'src/one.ts', change: 'modified', contentSha256: content('one'), bytes: 10 },
      { path: 'src/two.ts', change: 'added', contentSha256: content('two'), bytes: 20 }
    ],
    omitted: [],
    totalBytes: 30,
    truncated: false,
    complete: true,
    hasUncommittedState: false,
    ...overrides
  });
}

const hash = (value: CodeReviewSnapshot): string => digest(canonicalCodeSnapshot(value));

describe('the code-review snapshot identity', () => {
  it('gives the same canonical hash to the same snapshot', () => {
    expect(hash(snapshot())).toBe(hash(snapshot()));
    expect(canonicalCodeSnapshot(snapshot())).toBe(canonicalCodeSnapshot(snapshot()));
  });

  it('does not depend on the order the files were discovered in', () => {
    const forwards = snapshot();
    const backwards = snapshot({ entries: [...snapshot().entries].reverse() });

    // A snapshot is a set of facts about paths, not a listing order. If the
    // order mattered, two captures of an unchanged tree could disagree purely
    // because the filesystem enumerated them differently.
    expect(hash(backwards)).toBe(hash(forwards));
  });

  it('changes when the committed head moves', () => {
    expect(hash(snapshot({ headCommit: 'c'.repeat(40) }))).not.toBe(hash(snapshot()));
  });

  it('changes when the base the work is measured against moves', () => {
    expect(hash(snapshot({ baseCommit: 'd'.repeat(40) }))).not.toBe(hash(snapshot()));
  });

  it('changes when tracked content changes', () => {
    const edited = snapshot({
      entries: [
        { path: 'src/one.ts', change: 'modified', contentSha256: content('one-edited'), bytes: 11 },
        { path: 'src/two.ts', change: 'added', contentSha256: content('two'), bytes: 20 }
      ],
      totalBytes: 31
    });
    expect(hash(edited)).not.toBe(hash(snapshot()));
  });

  it('changes when an untracked file appears or disappears', () => {
    const withScratch = snapshot({
      entries: [
        ...snapshot().entries,
        { path: 'scratch.txt', change: 'untracked', contentSha256: content('scratch'), bytes: 5 }
      ],
      totalBytes: 35
    });
    expect(hash(withScratch)).not.toBe(hash(snapshot()));
  });

  it('changes when a file is deleted, even though it has no content', () => {
    const deleted = snapshot({
      entries: [
        { path: 'src/one.ts', change: 'deleted', contentSha256: null, bytes: 0 },
        { path: 'src/two.ts', change: 'added', contentSha256: content('two'), bytes: 20 }
      ],
      totalBytes: 20
    });
    expect(hash(deleted)).not.toBe(hash(snapshot()));
  });

  it('changes when content is omitted rather than read', () => {
    // A snapshot that quietly stopped reading would otherwise hash the same as
    // one that read everything, and would then claim to cover bytes it never
    // looked at. What was skipped is part of the statement.
    const omitting = snapshot({
      entries: [snapshot().entries[0]!],
      omitted: [{ path: 'src/two.ts', reason: 'unreadable', bytes: 20 }],
      totalBytes: 10
    });
    expect(hash(omitting)).not.toBe(hash(snapshot()));
  });

  it('tells two different files of exactly the same size apart', () => {
    // The defect this replaced: a file skipped for being large recorded only
    // its path, a reason and a byte count. Two different files of identical
    // length then produced identical entries and therefore one subject hash —
    // different code with the same identity, which is the single failure this
    // design exists to prevent. Content is digested now, so length is not
    // identity.
    const first = snapshot({
      entries: [
        { path: 'big.bin', change: 'modified', contentSha256: content('first'), bytes: 4_194_304 }
      ],
      totalBytes: 4_194_304
    });
    const second = snapshot({
      entries: [
        { path: 'big.bin', change: 'modified', contentSha256: content('second'), bytes: 4_194_304 }
      ],
      totalBytes: 4_194_304
    });

    expect(first.entries[0]?.bytes).toBe(second.entries[0]?.bytes);
    expect(hash(first)).not.toBe(hash(second));
  });

  it('keeps two omissions of equal size apart by the path they name', () => {
    // Omissions are still part of the statement, so they still need to say
    // WHICH file could not be read. Two different unreadable files of the same
    // length are not the same snapshot.
    const omittingOne = snapshot({
      entries: [],
      omitted: [{ path: 'src/one.ts', reason: 'unreadable', bytes: 100 }],
      totalBytes: 0,
      complete: false
    });
    const omittingTwo = snapshot({
      entries: [],
      omitted: [{ path: 'src/two.ts', reason: 'unreadable', bytes: 100 }],
      totalBytes: 0,
      complete: false
    });

    expect(hash(omittingOne)).not.toBe(hash(omittingTwo));
  });

  it('separates an exact snapshot from a partial one that saw the same files', () => {
    // Completeness is in the identity, so a capture that gave up cannot share a
    // hash with one that finished.
    expect(hash(snapshot({ complete: false }))).not.toBe(hash(snapshot()));
    expect(hash(snapshot({ truncated: true }))).not.toBe(hash(snapshot()));
    expect(hash(snapshot({ hasUncommittedState: true }))).not.toBe(hash(snapshot()));
  });

  it('carries no absolute path, checkout location, timestamp or machine identity', () => {
    const canonical = canonicalCodeSnapshot(snapshot());

    // Two machines reviewing the same code must agree on what it is. Anything
    // local in here would make the identity unportable without the reviewed
    // content differing at all.
    for (const local of ['C:\\', '/home/', '/Users/', 'H:/', 'worktrees', 'capturedAt']) {
      expect(canonical).not.toContain(local);
    }
    expect(canonical).toContain('src/one.ts');
    expect(canonical).toContain(A);
  });

  it('is stable against a snapshot object built with a different key order', () => {
    const reordered = codeReviewSnapshotSchema.parse({
      hasUncommittedState: false,
      complete: true,
      truncated: false,
      totalBytes: 30,
      omitted: [],
      entries: [
        { bytes: 20, contentSha256: content('two'), change: 'added', path: 'src/two.ts' },
        { bytes: 10, contentSha256: content('one'), change: 'modified', path: 'src/one.ts' }
      ],
      branch: 'agent/task-1',
      headCommit: B,
      baseCommit: A,
      version: 1
    });
    expect(hash(reordered)).toBe(hash(snapshot()));
  });
});

function finding(overrides: Partial<ProviderCodeFinding> = {}): ProviderCodeFinding {
  return {
    severity: 'major',
    category: 'reliability',
    gating: true,
    title: 'The retry is ambiguous',
    body: 'A lost response may repeat work.',
    fix: 'Persist the intent before calling out.',
    file: 'src/service.ts',
    line: 42,
    provider: 'codex',
    role: 'SecurityReliability',
    ...overrides
  };
}

const SUBJECT = 'e'.repeat(64);
const fingerprint = (value: ProviderCodeFinding, subject = SUBJECT): string =>
  digest(codeFindingFingerprintInput(subject, value));

describe('the code-review finding fingerprint', () => {
  it('gives an exact repeat the same fingerprint', () => {
    expect(fingerprint(finding())).toBe(fingerprint(finding()));
  });

  it('ignores case and whitespace, which are not defects', () => {
    const rewrapped = finding({
      title: '  The   Retry Is Ambiguous ',
      body: 'A lost response\n  may repeat work.'
    });
    expect(fingerprint(rewrapped)).toBe(fingerprint(finding()));
    expect(normaliseFindingText(' A  B \n C ')).toBe('a b c');
  });

  it('keeps two different defects apart', () => {
    // Every field that identifies a defect is part of the key. Merging on
    // similarity would hide one of two real problems for good, which is a far
    // worse failure than listing a repeat twice.
    const variants: Partial<ProviderCodeFinding>[] = [
      { title: 'The retry is unbounded' },
      { body: 'A lost response may lose work.' },
      { file: 'src/other.ts' },
      { line: 43 },
      { severity: 'minor' },
      { category: 'security' },
      { provider: 'claude' },
      { role: 'Architecture' }
    ];
    for (const variant of variants) {
      expect(fingerprint(finding(variant))).not.toBe(fingerprint(finding()));
    }
  });

  it('keeps a materially rewritten finding separate from the original', () => {
    // It says something the first one did not, so inheriting the first one's
    // decision would apply an answer to a question nobody asked.
    const rewritten = finding({
      body: 'A lost response may repeat work, and the second attempt double-charges.'
    });
    expect(fingerprint(rewritten)).not.toBe(fingerprint(finding()));
  });

  it('does not merge the same sentence written about a different snapshot', () => {
    // The same words about different code are a different defect: the file may
    // not even contain the same lines any more.
    expect(fingerprint(finding(), 'f'.repeat(64))).not.toBe(fingerprint(finding()));
  });

  it('does not depend on the fix text, which is advice rather than identity', () => {
    expect(fingerprint(finding({ fix: 'Something else entirely.' }))).toBe(
      fingerprint(finding())
    );
  });
});
