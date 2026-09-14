/**
 * The Ornith action protocol: strict parsing, exhaustive action coverage,
 * path validation, and the implementation/review provider split.
 *
 * Pure data and pure functions only — no filesystem, no process, no model.
 */

import { describe, expect, it } from 'vitest';
import {
  isOrnithTerminalAction,
  ORNITH_ACTION_KINDS,
  ORNITH_LIMITS,
  ORNITH_NONTERMINAL_ACTION_KINDS,
  ORNITH_PROTOCOL_VERSION,
  ornithActionSchema,
  ornithRelativePathSchema,
  ornithRelativePrefixSchema,
  ornithSha256Schema,
  parseOrnithCompletion
} from '../../src/shared/domain/ornith';
import {
  implementationProviderSchema,
  providerLabel,
  reviewProviderSchema
} from '../../src/shared/domain/execution-providers';
import { isRunAgentAllowedForType, runSchema, RUN_AGENTS } from '../../src/shared/domain/models';

const HASH = 'a'.repeat(64);

function envelope(action: Record<string, unknown>): Record<string, unknown> {
  return { version: ORNITH_PROTOCOL_VERSION, ...action };
}

describe('implementation vs review provider schemas', () => {
  it('implementation accepts claude, codex, and ornith', () => {
    expect(implementationProviderSchema.safeParse('claude').success).toBe(true);
    expect(implementationProviderSchema.safeParse('codex').success).toBe(true);
    expect(implementationProviderSchema.safeParse('ornith').success).toBe(true);
  });

  it('review accepts only claude and codex, never ornith', () => {
    expect(reviewProviderSchema.safeParse('claude').success).toBe(true);
    expect(reviewProviderSchema.safeParse('codex').success).toBe(true);
    expect(reviewProviderSchema.safeParse('ornith').success).toBe(false);
  });

  it('rejects unknown provider strings on both schemas', () => {
    expect(implementationProviderSchema.safeParse('gpt5').success).toBe(false);
    expect(reviewProviderSchema.safeParse('gpt5').success).toBe(false);
  });

  it('providerLabel is exhaustive and returns Ornith for ornith', () => {
    expect(providerLabel('claude')).toBe('Claude');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('ornith')).toBe('Ornith');
  });
});

describe('Ornith run domain pairing', () => {
  const run = (runType: 'implementation' | 'correction' | 'review') => ({
    id: 'run-1', taskId: 'task-1', agent: 'ornith', runType, status: 'running', round: 1,
    startedAt: '2026-09-13T00:00:00.000Z', finishedAt: null, finalMessage: null,
    structuredResult: null, errorMessage: null
  });

  it('refines complete run objects so Ornith is implementation/correction only', () => {
    expect(runSchema.safeParse(run('implementation')).success).toBe(true);
    expect(runSchema.safeParse(run('correction')).success).toBe(true);
    expect(runSchema.safeParse(run('review')).success).toBe(false);
  });
});

describe('RUN_AGENTS / isRunAgentAllowedForType', () => {
  it('includes ornith', () => {
    expect(RUN_AGENTS).toContain('ornith');
  });

  it('allows ornith only for implementation and correction run types', () => {
    expect(isRunAgentAllowedForType('ornith', 'implementation')).toBe(true);
    expect(isRunAgentAllowedForType('ornith', 'correction')).toBe(true);
    expect(isRunAgentAllowedForType('ornith', 'review')).toBe(false);
    expect(isRunAgentAllowedForType('ornith', 'specification')).toBe(false);
    expect(isRunAgentAllowedForType('ornith', 'verification')).toBe(false);
    expect(isRunAgentAllowedForType('ornith', 'git')).toBe(false);
    expect(isRunAgentAllowedForType('ornith', 'github')).toBe(false);
  });

  it('never restricts claude/codex/system by run type', () => {
    expect(isRunAgentAllowedForType('claude', 'review')).toBe(true);
    expect(isRunAgentAllowedForType('codex', 'specification')).toBe(true);
    expect(isRunAgentAllowedForType('system', 'git')).toBe(true);
  });
});

describe('ornithRelativePathSchema', () => {
  it.each([
    'src/index.ts',
    'a',
    'deep/nested/path/file.txt'
  ])('accepts %s', (value) => {
    expect(ornithRelativePathSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/System32', 'drive-rooted'],
    ['C:foo', 'drive-relative'],
    ['\\\\server\\share', 'UNC'],
    ['../escape', 'parent segment'],
    ['a/../b', 'embedded parent segment'],
    ['./a', 'current-dir segment'],
    ['a//b', 'empty segment'],
    ['.git/config', 'touches .git'],
    ['a/.git', '.git as final segment'],
    ['a\u0000b', 'control character'],
    ['a\\b', 'backslash']
  ])('rejects %s (%s)', (value) => {
    expect(ornithRelativePathSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a path longer than the limit', () => {
    const long = `${'a/'.repeat(ORNITH_LIMITS.maxRelativePathChars)}x`;
    expect(ornithRelativePathSchema.safeParse(long).success).toBe(false);
  });
});

describe('ornithRelativePrefixSchema', () => {
  it('accepts an empty string as the worktree root', () => {
    expect(ornithRelativePrefixSchema.safeParse('').success).toBe(true);
  });
  it('applies the same rules as the path schema when non-empty', () => {
    expect(ornithRelativePrefixSchema.safeParse('../escape').success).toBe(false);
    expect(ornithRelativePrefixSchema.safeParse('src').success).toBe(true);
  });
});

describe('ornithSha256Schema', () => {
  it('accepts a lowercase 64-hex-character digest', () => {
    expect(ornithSha256Schema.safeParse(HASH).success).toBe(true);
  });
  it.each([
    ['A'.repeat(64), 'uppercase'],
    ['a'.repeat(63), 'too short'],
    ['a'.repeat(65), 'too long'],
    ['z'.repeat(64), 'non-hex']
  ])('rejects %s (%s)', (value) => {
    expect(ornithSha256Schema.safeParse(value).success).toBe(false);
  });
});

describe('ornithActionSchema: strict per-action acceptance', () => {
  it('list_files: accepts a minimal valid request', () => {
    const result = ornithActionSchema.safeParse(
      envelope({ action: 'list_files', prefix: '', limit: 50 })
    );
    expect(result.success).toBe(true);
  });

  it('list_files: rejects a limit over the ceiling', () => {
    const result = ornithActionSchema.safeParse(
      envelope({ action: 'list_files', prefix: '', limit: ORNITH_LIMITS.maxListFilesLimit + 1 })
    );
    expect(result.success).toBe(false);
  });

  it('read_file: accepts and rejects an over-limit read', () => {
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'read_file', path: 'a.ts', offset: 0, limit: ORNITH_LIMITS.maxReadBytes })
      ).success
    ).toBe(true);
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'read_file', path: 'a.ts', offset: 0, limit: ORNITH_LIMITS.maxReadBytes + 1 })
      ).success
    ).toBe(false);
  });

  it('search_text: rejects an empty query and a too-long query', () => {
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'search_text', query: '', caseSensitive: false, limit: 10 })
      ).success
    ).toBe(false);
    expect(
      ornithActionSchema.safeParse(
        envelope({
          action: 'search_text',
          query: 'x'.repeat(ORNITH_LIMITS.maxSearchQueryLength + 1),
          caseSensitive: false,
          limit: 10
        })
      ).success
    ).toBe(false);
  });

  it('search_text: rejects more than the allowed number of explicit files', () => {
    const files = Array.from({ length: ORNITH_LIMITS.maxSearchFiles + 1 }, (_, i) => `f${i}.ts`);
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'search_text', query: 'needle', caseSensitive: true, limit: 10, files })
      ).success
    ).toBe(false);
  });

  it('create_file: accepts UTF-8 content within the byte limit', () => {
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'create_file', path: 'new.ts', content: 'export const x = 1;\n' })
      ).success
    ).toBe(true);
  });

  it('create_file: rejects content over the byte limit', () => {
    const big = 'a'.repeat(ORNITH_LIMITS.maxFileBytes + 1);
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'create_file', path: 'big.ts', content: big })).success
    ).toBe(false);
  });

  it('create_file: rejects credential-shaped content', () => {
    expect(
      ornithActionSchema.safeParse(
        envelope({
          action: 'create_file',
          path: 'secret.ts',
          content: 'const token = "ghp_1234567890123456789012345678";'
        })
      ).success
    ).toBe(false);
  });

  it('replace_text: requires a sha256 and 1-32 replacements', () => {
    const ok = ornithActionSchema.safeParse(
      envelope({
        action: 'replace_text',
        path: 'a.ts',
        sha256: HASH,
        replacements: [{ oldText: 'foo', newText: 'bar' }]
      })
    );
    expect(ok.success).toBe(true);

    const noReplacements = ornithActionSchema.safeParse(
      envelope({ action: 'replace_text', path: 'a.ts', sha256: HASH, replacements: [] })
    );
    expect(noReplacements.success).toBe(false);

    const tooMany = ornithActionSchema.safeParse(
      envelope({
        action: 'replace_text',
        path: 'a.ts',
        sha256: HASH,
        replacements: Array.from({ length: ORNITH_LIMITS.maxReplacements + 1 }, () => ({
          oldText: 'foo',
          newText: 'bar'
        }))
      })
    );
    expect(tooMany.success).toBe(false);

    const emptyOldText = ornithActionSchema.safeParse(
      envelope({
        action: 'replace_text',
        path: 'a.ts',
        sha256: HASH,
        replacements: [{ oldText: '', newText: 'bar' }]
      })
    );
    expect(emptyOldText.success).toBe(false);

    const missingHash = ornithActionSchema.safeParse(
      envelope({ action: 'replace_text', path: 'a.ts', replacements: [{ oldText: 'foo', newText: 'bar' }] })
    );
    expect(missingHash.success).toBe(false);
  });

  it('delete_file: requires a sha256', () => {
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'delete_file', path: 'a.ts', sha256: HASH })).success
    ).toBe(true);
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'delete_file', path: 'a.ts' })).success
    ).toBe(false);
  });

  it('git_status: takes no fields', () => {
    expect(ornithActionSchema.safeParse(envelope({ action: 'git_status' })).success).toBe(true);
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'git_status', extra: 'nope' })).success
    ).toBe(false);
  });

  it('git_diff: paths are optional and bounded', () => {
    expect(ornithActionSchema.safeParse(envelope({ action: 'git_diff' })).success).toBe(true);
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'git_diff', paths: ['a.ts', 'b.ts'] })).success
    ).toBe(true);
    const tooMany = Array.from({ length: ORNITH_LIMITS.maxGitDiffPaths + 1 }, (_, i) => `f${i}.ts`);
    expect(ornithActionSchema.safeParse(envelope({ action: 'git_diff', paths: tooMany })).success).toBe(false);
    // A ref/revision field is not part of the schema at all.
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'git_diff', ref: 'HEAD~1' })).success
    ).toBe(false);
  });

  it('run_verification: takes no fields, never a command', () => {
    expect(ornithActionSchema.safeParse(envelope({ action: 'run_verification' })).success).toBe(true);
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'run_verification', command: 'npm test' })).success
    ).toBe(false);
  });

  it('finish: bounds the summary length', () => {
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'finish', summary: 'Done.' })).success
    ).toBe(true);
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'finish', summary: 'x'.repeat(ORNITH_LIMITS.maxFinishSummaryChars + 1) })
      ).success
    ).toBe(false);
    expect(ornithActionSchema.safeParse(envelope({ action: 'finish', summary: '' })).success).toBe(false);
  });

  it('blocked: bounds the reason length', () => {
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'blocked', reason: 'Cannot proceed.' })).success
    ).toBe(true);
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'blocked', reason: 'x'.repeat(ORNITH_LIMITS.maxBlockedReasonChars + 1) })
      ).success
    ).toBe(false);
  });

  it('rejects an unknown action kind', () => {
    expect(
      ornithActionSchema.safeParse(envelope({ action: 'run_shell', command: 'ls' })).success
    ).toBe(false);
  });

  it('rejects extra properties on every action (strict)', () => {
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'git_status', shellCommand: 'rm -rf /' })
      ).success
    ).toBe(false);
    expect(
      ornithActionSchema.safeParse(
        envelope({ action: 'finish', summary: 'ok', url: 'https://example.com' })
      ).success
    ).toBe(false);
  });

  it('rejects a mismatched or missing protocol version', () => {
    expect(
      ornithActionSchema.safeParse({ version: 2, action: 'git_status' }).success
    ).toBe(false);
    expect(ornithActionSchema.safeParse({ action: 'git_status' }).success).toBe(false);
  });
});

describe('action kind bookkeeping', () => {
  it('ORNITH_ACTION_KINDS covers exactly finish/blocked plus the nonterminal set', () => {
    const nonterminalPlusTerminal = new Set([...ORNITH_NONTERMINAL_ACTION_KINDS, 'finish', 'blocked']);
    expect(new Set(ORNITH_ACTION_KINDS)).toEqual(nonterminalPlusTerminal);
  });

  it('isOrnithTerminalAction is true only for finish/blocked', () => {
    for (const kind of ORNITH_ACTION_KINDS) {
      expect(isOrnithTerminalAction(kind)).toBe(kind === 'finish' || kind === 'blocked');
    }
  });
});

describe('parseOrnithCompletion', () => {
  it('accepts one complete, exact JSON action', () => {
    const result = parseOrnithCompletion(JSON.stringify(envelope({ action: 'git_status' })));
    expect(result.ok).toBe(true);
  });

  it('accepts surrounding whitespace only', () => {
    const result = parseOrnithCompletion(`\n  ${JSON.stringify(envelope({ action: 'git_status' }))}  \n`);
    expect(result.ok).toBe(true);
  });

  it('rejects an empty completion', () => {
    const result = parseOrnithCompletion('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects prose before the JSON object', () => {
    const result = parseOrnithCompletion(`Sure, here is my action:\n${JSON.stringify(envelope({ action: 'git_status' }))}`);
    expect(result.ok).toBe(false);
  });

  it('rejects a Markdown code fence wrapping the JSON', () => {
    const result = parseOrnithCompletion(`\`\`\`json\n${JSON.stringify(envelope({ action: 'git_status' }))}\n\`\`\``);
    expect(result.ok).toBe(false);
  });

  it('rejects trailing content after the JSON object', () => {
    const result = parseOrnithCompletion(`${JSON.stringify(envelope({ action: 'git_status' }))}\nthanks!`);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid JSON outright', () => {
    const result = parseOrnithCompletion('{action: "git_status"}');
    expect(result.ok).toBe(false);
  });

  it('rejects a JSON array instead of an object', () => {
    const result = parseOrnithCompletion('[]');
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognised action', () => {
    const result = parseOrnithCompletion(JSON.stringify({ version: 1, action: 'exec', command: 'ls' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a completion over the byte limit before attempting to parse', () => {
    const huge = `{"version":1,"action":"finish","summary":"${'a'.repeat(ORNITH_LIMITS.maxCompletionBytes)}"}`;
    const result = parseOrnithCompletion(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('oversized_output');
  });

  it('never asks for repair: malformed output is terminal, not retried', () => {
    // Enforced by contract, not by this test alone: parseOrnithCompletion has
    // no retry/repair path and returns a denial code on the first parse.
    const result = parseOrnithCompletion('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('malformed_output');
  });
});
