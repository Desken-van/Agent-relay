/**
 * The verification-rules setting: defaults, persistence and validation.
 *
 * The backward-compatibility case is the important one. Settings are stored as
 * key/value rows, so a database written before this field existed simply has no
 * row for it — and must come back with the defaults rather than an empty list,
 * which would block every round.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { defaultSettings } from '../../src/main/container';
import { resolveVerificationConfig } from '../../src/shared/domain/claude-tool-rules';
import {
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_VERIFICATION_TOOLS,
  defaultClaudePermissionRules,
  settingsSchema,
  type Settings
} from '../../src/shared/domain/models';

let db: Db;
let defaults: Settings;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  defaults = defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });
});

afterEach(() => {
  closeDatabase(db);
});

const repository = () => new SqliteSettingsRepository(db, defaults);

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

describe('defaults', () => {
  it('ships the two shell rules', () => {
    expect(defaults.claudeVerificationTools).toEqual([
      'Bash(npm test *)',
      'PowerShell(npm test *)'
    ]);
  });

  it('ships a usable configuration out of the box', () => {
    const config = resolveVerificationConfig(
      defaults.claudeAllowedTools,
      defaults.claudeVerificationTools
    );

    expect(config.ok).toBe(true);
  });

  it('keeps the verification list separate from the allowed list', () => {
    // Equal today, and separately defined. Deriving one from the other would
    // turn every newly permitted command into evidence that the change works.
    expect(DEFAULT_CLAUDE_VERIFICATION_TOOLS).toEqual([...DEFAULT_CLAUDE_ALLOWED_TOOLS]);
    expect(DEFAULT_CLAUDE_VERIFICATION_TOOLS).not.toBe(DEFAULT_CLAUDE_ALLOWED_TOOLS);
  });
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

describe('persistence', () => {
  it('returns the defaults for a database that has never been written', () => {
    expect(repository().get().claudeVerificationTools).toEqual(
      defaults.claudeVerificationTools
    );
  });

  /**
   * A database from before this field existed.
   *
   * Every other key is present and the new one is not, which is exactly what an
   * upgrade looks like. No migration is involved: the key/value table has no
   * column to add, and a missing key already falls back to the default.
   */
  it('fills in the default for a database written by an older version', () => {
    const insert = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    for (const [key, value] of Object.entries(defaults)) {
      if (key === 'claudeVerificationTools') continue;
      insert.run(key, JSON.stringify(value));
    }

    const stored = repository().get();

    expect(stored.claudeVerificationTools).toEqual(defaults.claudeVerificationTools);
    // And nothing else was disturbed by the missing key.
    expect(stored.claudeAllowedTools).toEqual(defaults.claudeAllowedTools);
    expect(stored.claudeMaxTurns).toBe(defaults.claudeMaxTurns);
  });

  it('round-trips an edited list', () => {
    const repo = repository();
    repo.update({
      claudeAllowedTools: ['Bash(npm test *)', 'Bash(npm run verify *)'],
      claudeVerificationTools: ['Bash(npm run verify *)']
    });

    expect(repository().get().claudeVerificationTools).toEqual(['Bash(npm run verify *)']);
  });

  it('trims surrounding whitespace, as the textarea will produce it', () => {
    const repo = repository();
    repo.update({ claudeVerificationTools: ['  Bash(npm test *)  '] });

    expect(repo.get().claudeVerificationTools).toEqual(['Bash(npm test *)']);
  });

  it('falls back to the default when a stored value is not a rule list', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      'claudeVerificationTools',
      JSON.stringify('Bash(npm test *)')
    );

    expect(repository().get().claudeVerificationTools).toEqual(
      defaults.claudeVerificationTools
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

describe('what the schema rejects', () => {
  it('refuses a rule containing a control character', () => {
    const parsed = settingsSchema.safeParse({
      ...defaults,
      claudeVerificationTools: [`Bash(npm test${String.fromCharCode(9)}*)`]
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses an empty rule', () => {
    const parsed = settingsSchema.safeParse({
      ...defaults,
      claudeVerificationTools: ['   ']
    });

    expect(parsed.success).toBe(false);
  });

  it('saves nothing when any part of the update is invalid', () => {
    const repo = repository();
    repo.update({
      claudeAllowedTools: ['Bash(npm test *)', 'Bash(npm run verify *)'],
      claudeVerificationTools: ['Bash(npm run verify *)']
    });

    expect(() =>
      repo.update({
        claudeMaxTurns: 9_999_999,
        claudeVerificationTools: ['Bash(npm test *)']
      })
    ).toThrow();

    // Atomic: the valid half of a rejected update must not land either.
    expect(repo.get().claudeVerificationTools).toEqual(['Bash(npm run verify *)']);
  });
});

/**
 * Rules the *schema* accepts but the policy cannot use.
 *
 * The schema only knows that a rule is a plausible string; whether it can be
 * matched against is `resolveVerificationConfig`'s question, and both the
 * Settings form and the orchestrator ask it before a round starts.
 */
describe('what the configuration rejects', () => {
  const check = (verification: string[], allowed = ['Bash(npm test *)']) =>
    resolveVerificationConfig(allowed, verification);

  it('rejects an empty list', () => {
    const config = check([]);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]?.code).toBe('empty');
  });

  it('rejects a rule that is not also pre-approved', () => {
    const config = check(['Bash(npm run docs *)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]?.code).toBe('not_allowed');
  });

  it('rejects an unsupported wildcard', () => {
    const config = check(['Bash(npm * test)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ detail: 'wildcard' });
  });

  it('rejects a compound command', () => {
    const config = check(['Bash(npm test; git status)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ detail: 'compound' });
  });

  it('rejects a wrapper', () => {
    const config = check(['Bash(cmd /c npm test)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ detail: 'wrapper' });
  });

  it('rejects an unsupported tool', () => {
    const config = check(['Read(**)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ detail: 'unsupported_tool' });
  });

  it('rejects malformed syntax', () => {
    const config = check(['npm test']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ detail: 'syntax' });
  });

  it('reports every bad rule, not just the first', () => {
    const config = check(['Bash(npm * test)', 'Read(**)']);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The repository is the boundary, not the form                                */
/* -------------------------------------------------------------------------- */

describe('cross-field validation where the write happens', () => {
  it('accepts by schema what the repository still refuses', () => {
    // The schema checks each field alone, so it is perfectly happy with a
    // verification rule the run could never execute. That is the gap the
    // repository closes, and the reason the renderer is not the boundary.
    const candidate = {
      ...defaults,
      claudeAllowedTools: ['Bash(npm run lint *)'],
      claudeVerificationTools: ['Bash(npm test *)']
    };

    expect(settingsSchema.safeParse(candidate).success).toBe(true);
    expect(() => repository().update(candidate)).toThrow(/cannot be used/i);
  });

  it('refuses an empty verification list', () => {
    expect(() => repository().update({ claudeVerificationTools: [] })).toThrow(/cannot be used/i);
  });

  it('refuses a rule with a wildcard in the middle', () => {
    expect(() =>
      repository().update({
        claudeAllowedTools: ['Bash(npm * test)'],
        claudeVerificationTools: ['Bash(npm * test)']
      })
    ).toThrow(/cannot be used/i);
  });

  it('refuses a compound rule', () => {
    expect(() =>
      repository().update({
        claudeAllowedTools: ['Bash(npm test; git status)'],
        claudeVerificationTools: ['Bash(npm test; git status)']
      })
    ).toThrow(/cannot be used/i);
  });

  it('refuses a wrapper rule', () => {
    expect(() =>
      repository().update({
        claudeAllowedTools: ['Bash(cmd /c npm test)'],
        claudeVerificationTools: ['Bash(cmd /c npm test)']
      })
    ).toThrow(/cannot be used/i);
  });

  it('refuses a tool that is neither shell', () => {
    expect(() =>
      repository().update({
        claudeAllowedTools: ['Read(**)'],
        claudeVerificationTools: ['Read(**)']
      })
    ).toThrow(/cannot be used/i);
  });

  it('writes nothing at all when the update is refused', () => {
    const repo = repository();
    const before = repo.get();

    expect(() =>
      repo.update({ githubOwner: 'someone-else', claudeVerificationTools: [] })
    ).toThrow();

    const after = repo.get();
    expect(after.githubOwner).toBe(before.githubOwner);
    expect(after.claudeVerificationTools).toEqual(before.claudeVerificationTools);
  });

  it('names the offending rule so it can be fixed', () => {
    try {
      repository().update({ claudeVerificationTools: ['Bash(npm run docs *)'] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { details?: string }).details).toContain('Bash(npm run docs *)');
      expect((error as { remediation?: string }).remediation).toMatch(/pre-approved/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Reset                                                                       */
/* -------------------------------------------------------------------------- */

describe('resetting the permission rules', () => {
  it('restores the two shipped rules for both lists', () => {
    // What the Settings form's Reset applies. It goes back to the shipped rules
    // rather than the last saved ones because that is the way out of a saved
    // configuration the validator now rejects.
    expect(defaultClaudePermissionRules()).toEqual({
      claudeAllowedTools: ['Bash(npm test *)', 'PowerShell(npm test *)'],
      claudeVerificationTools: ['Bash(npm test *)', 'PowerShell(npm test *)']
    });
  });

  it('hands back copies, so editing the result cannot alter the defaults', () => {
    const first = defaultClaudePermissionRules();
    first.claudeAllowedTools.push('Bash(*)');

    expect(defaultClaudePermissionRules().claudeAllowedTools).toEqual([
      'Bash(npm test *)',
      'PowerShell(npm test *)'
    ]);
  });

  it('produces a configuration the repository accepts', () => {
    const repo = repository();
    repo.update({
      claudeAllowedTools: ['Bash(npm run verify *)'],
      claudeVerificationTools: ['Bash(npm run verify *)']
    });

    expect(() => repo.update(defaultClaudePermissionRules())).not.toThrow();
    expect(repo.get().claudeVerificationTools).toEqual([
      'Bash(npm test *)',
      'PowerShell(npm test *)'
    ]);
  });
});
