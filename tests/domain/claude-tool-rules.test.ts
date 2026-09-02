/**
 * Rule grammar, command normalisation and matching.
 *
 * These decide whether a tool call counts as "the tests ran" and whether one
 * names a forbidden operation. Both answers feed a security decision, so the
 * tests here are mostly about what the matcher refuses: a compound command, a
 * shell wrapper, a glob, a tool that only looks like the right one.
 */

import { describe, expect, it } from 'vitest';
import {
  analyseCommand,
  commandTouchesDestructiveOperation,
  DEFAULT_CLAUDE_VERIFICATION_TOOLS,
  destructiveToolDenyRules,
  findMatchingRule,
  namesDestructiveOperation,
  parseShellToolRule,
  resolveVerificationConfig,
  ruleMatchesCommand
} from '../../src/shared/domain/claude-tool-rules';
import { DEFAULT_CLAUDE_ALLOWED_TOOLS } from '../../src/shared/domain/models';

const rule = (text: string) => {
  const parsed = parseShellToolRule(text);
  if (parsed === null) throw new Error(`expected ${text} to parse`);
  return parsed;
};

const matches = (text: string, tool: string, command: string) =>
  ruleMatchesCommand(rule(text), tool, analyseCommand(command));

/* -------------------------------------------------------------------------- */
/* Canonical deny list                                                         */
/* -------------------------------------------------------------------------- */

describe('canonical security rules', () => {
  it('emits three spellings for each guarded command and shell', () => {
    const rules = destructiveToolDenyRules();

    expect(rules).toHaveLength(54);
    expect(new Set(rules).size).toBe(54);
  });

  it('keeps a stable order, because argv is part of the contract', () => {
    const rules = destructiveToolDenyRules();

    expect(rules.slice(0, 3)).toEqual([
      'Bash(git commit)',
      'Bash(git commit:*)',
      'Bash(git commit *)'
    ]);
    expect(rules[rules.length - 1]).toBe('PowerShell(gh *)');
    expect(destructiveToolDenyRules()).toEqual(rules);
  });
});

/* -------------------------------------------------------------------------- */
/* Command analysis                                                            */
/* -------------------------------------------------------------------------- */

describe('command analysis', () => {
  it('collapses whitespace', () => {
    expect(analyseCommand('  npm   test   -- --dot  ').canonical).toBe('npm test -- --dot');
  });

  it('normalises a Windows shim in the executable position only', () => {
    expect(analyseCommand('npm.cmd test').canonical).toBe('npm test');
    expect(analyseCommand('npm.exe test').canonical).toBe('npm test');
    // Not in an argument: a file called npm.cmd is not the npm executable.
    expect(analyseCommand('npm run npm.cmd').canonical).toBe('npm run npm.cmd');
  });

  it('lower-cases the executable but not the arguments', () => {
    expect(analyseCommand('NPM test --grep=Foo').canonical).toBe('npm test --grep=Foo');
  });

  it('treats every shell operator as compound', () => {
    for (const command of [
      'npm test; git status',
      'npm test && npm run build',
      'npm test || echo no',
      'npm test | tee out.txt',
      'npm test & echo done'
    ]) {
      expect(analyseCommand(command).compound).toBe(true);
      expect(analyseCommand(command).canonical).toBeNull();
    }
  });

  it('treats a line break as compound', () => {
    const command = 'npm test' + String.fromCharCode(10) + 'git push';
    expect(analyseCommand(command).compound).toBe(true);
    expect(analyseCommand(command).canonical).toBeNull();
  });

  it('accepts a false negative rather than parsing quotes', () => {
    // A separator inside a quoted argument still reads as compound. Refusing to
    // call this a test run costs a clean verdict; the alternative is a quoting
    // parser standing between a push and the deny list.
    expect(analyseCommand('npm test -- --grep="a&b"').compound).toBe(true);
  });

  it('reports an unusable command rather than guessing', () => {
    expect(analyseCommand(null).canonical).toBeNull();
    expect(analyseCommand('   ').canonical).toBeNull();
    expect(analyseCommand('').segments).toEqual([]);
  });

  it('keeps every segment of a compound command', () => {
    expect(analyseCommand('npm test; git push origin main').segments).toEqual([
      'npm test',
      'git push origin main'
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Destructive detection                                                       */
/* -------------------------------------------------------------------------- */

describe('destructive command detection', () => {
  it('matches a denied command with or without arguments', () => {
    expect(namesDestructiveOperation('git push')).toBe(true);
    expect(namesDestructiveOperation('git push origin main')).toBe(true);
    expect(namesDestructiveOperation('gh pr create')).toBe(true);
  });

  it('does not match a command that merely starts with the same letters', () => {
    expect(namesDestructiveOperation('git pushd')).toBe(false);
    expect(namesDestructiveOperation('github-cli status')).toBe(false);
  });

  it('is case-insensitive, deliberately unlike verification matching', () => {
    expect(namesDestructiveOperation('GIT PUSH origin main')).toBe(true);
  });

  it('inspects every segment of a compound command', () => {
    expect(commandTouchesDestructiveOperation(analyseCommand('npm test; git push'))).toBe(true);
    expect(commandTouchesDestructiveOperation(analyseCommand('npm test; git status'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule grammar                                                                */
/* -------------------------------------------------------------------------- */

describe('rule grammar', () => {
  it('parses an exact rule and a trailing-wildcard rule', () => {
    expect(rule('Bash(npm test)')).toMatchObject({
      tool: 'Bash',
      prefix: 'npm test',
      wildcard: false
    });
    expect(rule('PowerShell(npm test *)')).toMatchObject({
      tool: 'PowerShell',
      prefix: 'npm test',
      wildcard: true
    });
  });

  it('canonicalises so two spellings of one rule compare equal', () => {
    expect(rule('Bash(  npm   test  *)').canonical).toBe(rule('Bash(npm test *)').canonical);
    expect(rule('bash(npm test *)').canonical).toBe(rule('Bash(npm test *)').canonical);
  });

  it('keeps the wildcard out of the canonical form of an exact rule', () => {
    expect(rule('Bash(npm test)').canonical).not.toBe(rule('Bash(npm test *)').canonical);
  });

  it('refuses a wildcard anywhere but the end', () => {
    expect(parseShellToolRule('Bash(npm * test)')).toBeNull();
    expect(parseShellToolRule('Bash(*)')).toBeNull();
    expect(parseShellToolRule('Bash(npm ** )')).toBeNull();
  });

  it('refuses an empty body', () => {
    expect(parseShellToolRule('Bash()')).toBeNull();
    expect(parseShellToolRule('Bash(   )')).toBeNull();
  });

  it('refuses tools other than the two shells', () => {
    expect(parseShellToolRule('Read(**)')).toBeNull();
    expect(parseShellToolRule('Edit(src/*)')).toBeNull();
  });

  it('refuses malformed syntax', () => {
    expect(parseShellToolRule('Bash npm test')).toBeNull();
    expect(parseShellToolRule('Bash(npm test')).toBeNull();
    expect(parseShellToolRule('')).toBeNull();
  });

  it('refuses a rule spanning lines', () => {
    expect(parseShellToolRule('Bash(npm' + String.fromCharCode(10) + 'test)')).toBeNull();
  });

  it('refuses a compound rule body', () => {
    expect(parseShellToolRule('Bash(npm test; git push)')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

describe('rule matching', () => {
  it('matches an exact command only exactly', () => {
    expect(matches('Bash(npm test)', 'Bash', 'npm test')).toBe(true);
    expect(matches('Bash(npm test)', 'Bash', 'npm test -- --dot')).toBe(false);
  });

  it('matches a wildcard rule with and without arguments', () => {
    expect(matches('Bash(npm test *)', 'Bash', 'npm test')).toBe(true);
    expect(matches('Bash(npm test *)', 'Bash', 'npm test -- --reporter=dot')).toBe(true);
  });

  it('respects token boundaries', () => {
    expect(matches('Bash(npm test *)', 'Bash', 'npm testing')).toBe(false);
    expect(matches('Bash(npm test *)', 'Bash', 'npm test:watch')).toBe(false);
  });

  it('treats npm.cmd as npm in the executable position', () => {
    expect(matches('Bash(npm test *)', 'Bash', 'npm.cmd test')).toBe(true);
    expect(matches('PowerShell(npm test *)', 'PowerShell', 'npm.cmd test -- --dot')).toBe(true);
  });

  it('does not treat the two shells as interchangeable', () => {
    expect(matches('Bash(npm test *)', 'PowerShell', 'npm test')).toBe(false);
    expect(matches('PowerShell(npm test *)', 'Bash', 'npm test')).toBe(false);
  });

  it('ignores the case of the tool name itself', () => {
    expect(matches('Bash(npm test *)', 'bash', 'npm test')).toBe(true);
  });

  it('refuses a compound command however it starts', () => {
    expect(matches('Bash(npm test *)', 'Bash', 'npm test; git status')).toBe(false);
    expect(matches('Bash(npm test *)', 'Bash', 'npm test && npm run build')).toBe(false);
  });

  it('refuses a shell wrapper around the right command', () => {
    for (const command of [
      'cmd /c npm test',
      'powershell -Command npm test',
      'bash -lc npm test',
      'wsl npm test'
    ]) {
      expect(matches('Bash(npm test *)', 'Bash', command)).toBe(false);
    }
  });

  it('does not support arbitrary globs', () => {
    // The rule below is refused by the grammar, so nothing can match through it.
    expect(parseShellToolRule('Bash(npm * )')).toBeNull();
  });

  it('finds the first rule that describes a call', () => {
    const rules = [rule('Bash(npm run lint *)'), rule('Bash(npm test *)')];

    expect(findMatchingRule(rules, 'Bash', analyseCommand('npm test'))?.prefix).toBe('npm test');
    expect(findMatchingRule(rules, 'Bash', analyseCommand('npm run build'))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Verification configuration                                                  */
/* -------------------------------------------------------------------------- */

describe('verification configuration', () => {
  it('accepts rules that are also allowed', () => {
    const config = resolveVerificationConfig(
      ['Bash(npm test *)', 'PowerShell(npm test *)', 'Read(**)'],
      ['Bash(npm test *)']
    );

    expect(config.ok).toBe(true);
    if (config.ok) expect(config.rules).toHaveLength(1);
  });

  it('rejects an empty verification list', () => {
    const config = resolveVerificationConfig(['Bash(npm test *)'], []);

    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]?.code).toBe('empty');
  });

  it('rejects a rule the run was never allowed to execute', () => {
    // Being able to prove something the run could not do is not a configuration
    // that can ever pass; saying so beats failing every round without a reason.
    const config = resolveVerificationConfig(['Bash(npm run lint *)'], ['Bash(npm test *)']);

    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ code: 'not_allowed' });
  });

  it('rejects an unparsable rule', () => {
    const config = resolveVerificationConfig(['Bash(npm test *)'], ['Bash(npm * test)']);

    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.problems[0]).toMatchObject({ code: 'unparsable' });
  });

  it('matches allowed rules by canonical form, not by spelling', () => {
    const config = resolveVerificationConfig(['bash(  npm   test *)'], ['Bash(npm test *)']);

    expect(config.ok).toBe(true);
  });

  it('does not derive verification rules from the allowed list', () => {
    // Permission to run a command is not evidence that running it checks
    // anything, so an allowed rule that is not listed as verification stays out.
    const config = resolveVerificationConfig(
      ['Bash(npm test *)', 'Bash(git status *)'],
      ['Bash(npm test *)']
    );

    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.rules.map((entry) => entry.prefix)).toEqual(['npm test']);
    }
  });

  it('ships defaults that the shipped allowed list permits', () => {
    const config = resolveVerificationConfig(
      DEFAULT_CLAUDE_ALLOWED_TOOLS,
      DEFAULT_CLAUDE_VERIFICATION_TOOLS
    );

    expect(config.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Argv regression                                                             */
/* -------------------------------------------------------------------------- */

describe('the deny list as the CLI receives it', () => {
  /**
   * Written out in full, on purpose.
   *
   * Every other test compares argv against the generator, which would happily
   * agree with itself if the generator changed. This is the one place that says
   * what the CLI must actually be told, so moving the rules between modules
   * cannot quietly alter them.
   */
  const EXPECTED_DENY_RULES = [
      'Bash(git commit)',
      'Bash(git commit:*)',
      'Bash(git commit *)',
      'Bash(git push)',
      'Bash(git push:*)',
      'Bash(git push *)',
      'Bash(git reset)',
      'Bash(git reset:*)',
      'Bash(git reset *)',
      'Bash(git clean)',
      'Bash(git clean:*)',
      'Bash(git clean *)',
      'Bash(git checkout)',
      'Bash(git checkout:*)',
      'Bash(git checkout *)',
      'Bash(git switch)',
      'Bash(git switch:*)',
      'Bash(git switch *)',
      'Bash(git merge)',
      'Bash(git merge:*)',
      'Bash(git merge *)',
      'Bash(git rebase)',
      'Bash(git rebase:*)',
      'Bash(git rebase *)',
      'Bash(gh)',
      'Bash(gh:*)',
      'Bash(gh *)',
      'PowerShell(git commit)',
      'PowerShell(git commit:*)',
      'PowerShell(git commit *)',
      'PowerShell(git push)',
      'PowerShell(git push:*)',
      'PowerShell(git push *)',
      'PowerShell(git reset)',
      'PowerShell(git reset:*)',
      'PowerShell(git reset *)',
      'PowerShell(git clean)',
      'PowerShell(git clean:*)',
      'PowerShell(git clean *)',
      'PowerShell(git checkout)',
      'PowerShell(git checkout:*)',
      'PowerShell(git checkout *)',
      'PowerShell(git switch)',
      'PowerShell(git switch:*)',
      'PowerShell(git switch *)',
      'PowerShell(git merge)',
      'PowerShell(git merge:*)',
      'PowerShell(git merge *)',
      'PowerShell(git rebase)',
      'PowerShell(git rebase:*)',
      'PowerShell(git rebase *)',
      'PowerShell(gh)',
      'PowerShell(gh:*)',
      'PowerShell(gh *)'
    ] as const;

  it('matches the exact rules, in order', () => {
    expect(destructiveToolDenyRules()).toEqual([...EXPECTED_DENY_RULES]);
  });
});
