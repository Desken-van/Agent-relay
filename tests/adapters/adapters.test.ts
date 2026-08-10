import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from '../../src/main/adapters/claude/claude-adapter';
import {
  consumeLine,
  createStreamState,
  finalizeState
} from '../../src/main/adapters/claude/stream-parser';
import { describeItem } from '../../src/main/adapters/codex/codex-adapter';
import {
  buildCorrectionPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
  buildSpecificationPrompt
} from '../../src/main/adapters/codex/prompts';
import {
  extractGithubUrl,
  GhGitHubAdapter,
  parseGhAuthStatus
} from '../../src/main/adapters/github/github-adapter';
import { ExecaProcessRunner, type ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { findOnPath, locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { extractTestOutput } from '../../src/main/services/orchestrator';
import { makeChangeSet, makeReview, makeSpecification } from '../helpers/fakes';

/* -------------------------------------------------------------------------- */
/* Claude stream parser                                                        */
/* -------------------------------------------------------------------------- */

describe('Claude stream-json parser', () => {
  it('extracts the session id from the init envelope', () => {
    const state = createStreamState();
    consumeLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: 'C:\\wt' }),
      state
    );
    expect(state.sessionId).toBe('sess-1');
  });

  it('keeps the first session id it sees', () => {
    const state = createStreamState();
    consumeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }), state);
    consumeLine(JSON.stringify({ type: 'assistant', session_id: 'sess-2', message: {} }), state);
    expect(state.sessionId).toBe('sess-1');
  });

  it('accepts camelCase session ids as well', () => {
    const state = createStreamState();
    consumeLine(JSON.stringify({ type: 'system', sessionId: 'sess-camel' }), state);
    expect(state.sessionId).toBe('sess-camel');
  });

  it('flattens assistant text blocks', () => {
    const state = createStreamState();
    const events = consumeLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello there' }] }
      }),
      state
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('assistant_message');
    expect(events[0]?.text).toBe('Hello there');
  });

  it('reports tool use separately, with the identifying argument', () => {
    const state = createStreamState();
    const events = consumeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } },
            { type: 'text', text: 'Editing now' }
          ]
        }
      }),
      state
    );

    expect(events[0]?.type).toBe('tool_use');
    expect(events[0]?.text).toBe('Edit: src/app.ts');
    expect(events[1]?.type).toBe('assistant_message');
  });

  it('captures the final result and turn count', () => {
    const state = createStreamState();
    consumeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'All done.',
        num_turns: 7,
        session_id: 'sess-9'
      }),
      state
    );

    const final = finalizeState(state);
    expect(final.finalMessage).toBe('All done.');
    expect(final.numTurns).toBe(7);
    expect(final.isError).toBe(false);
    expect(final.sessionId).toBe('sess-9');
    expect(final.rawResultJson).toContain('All done.');
  });

  it('marks an error result', () => {
    const state = createStreamState();
    consumeLine(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'It broke.' }),
      state
    );
    expect(finalizeState(state).isError).toBe(true);
  });

  it('does not throw on an unknown event type', () => {
    const state = createStreamState();
    const events = consumeLine(JSON.stringify({ type: 'brand_new_thing', data: 1 }), state);
    expect(events[0]?.type).toBe('progress');
  });

  it('falls back to plain text when the CLI does not emit JSON', () => {
    const state = createStreamState();
    consumeLine('just some text', state);
    consumeLine('more text', state);

    const final = finalizeState(state);
    expect(final.finalMessage).toBe('just some text\nmore text');
    expect(final.sessionId).toBeNull();
  });

  it('does not throw on malformed JSON', () => {
    const state = createStreamState();
    expect(() => consumeLine('{"type": "assistant"', state)).not.toThrow();
  });

  it('ignores blank lines', () => {
    const state = createStreamState();
    expect(consumeLine('   ', state)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Claude adapter                                                              */
/* -------------------------------------------------------------------------- */

describe('Claude adapter', () => {
  const nullRunner: ProcessRunner = {
    async run() {
      throw new Error('should not be called');
    }
  };

  it('reports a clear, actionable diagnostic when the CLI is missing', async () => {
    const adapter = new ClaudeCliAdapter(nullRunner, {
      configuredPath: 'C:\\definitely\\not\\here\\claude.exe'
    });

    const diagnostic = await adapter.diagnose();
    expect(diagnostic.status).toBe('missing');
    expect(diagnostic.remediation).toBeTruthy();
    expect(diagnostic.detail).toContain('C:\\definitely\\not\\here\\claude.exe');
  });

  it('never passes --dangerously-skip-permissions', async () => {
    const seen: string[][] = [];
    const runner: ProcessRunner = {
      async run(_file, args) {
        seen.push([...args]);
        return {
          command: 'claude',
          exitCode: 0,
          stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's1' }),
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: false
        };
      }
    };

    // Point at a file we know exists so the locator resolves.
    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });

    await adapter.run(
      {
        worktreePath: process.cwd(),
        branchName: 'agent-relay/x',
        prompt: 'do the thing',
        sessionId: null,
        maxTurns: 5
      },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    const args = seen[0] ?? [];
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--print');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--max-turns');
    expect(args).toContain('5');
  });

  it('resumes an existing session with --resume', async () => {
    let captured: string[] = [];
    const runner: ProcessRunner = {
      async run(_file, args) {
        captured = [...args];
        return {
          command: 'claude',
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: false
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    await adapter.run(
      {
        worktreePath: process.cwd(),
        branchName: 'b',
        prompt: 'p',
        sessionId: 'sess-abc',
        maxTurns: 3
      },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    expect(captured).toContain('--resume');
    expect(captured[captured.indexOf('--resume') + 1]).toBe('sess-abc');
  });

  it('sends the prompt on stdin rather than on the command line', async () => {
    let capturedArgs: string[] = [];
    let capturedInput: string | undefined;
    const longPrompt = 'x'.repeat(50_000);

    const runner: ProcessRunner = {
      async run(_file, args, options) {
        capturedArgs = [...args];
        capturedInput = options?.input;
        return {
          command: 'claude',
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: false
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    await adapter.run(
      { worktreePath: process.cwd(), branchName: 'b', prompt: longPrompt, sessionId: null, maxTurns: 3 },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    expect(capturedInput).toBe(longPrompt);
    expect(capturedArgs.join(' ')).not.toContain(longPrompt);
  });

  it('turns an authentication failure into an actionable error', async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          command: 'claude',
          exitCode: 1,
          stdout: '',
          stderr: 'Error: Not logged in. Please run /login.',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: true
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    await expect(
      adapter.run(
        { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3 },
        { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
      )
    ).rejects.toMatchObject({ code: 'TOOL_UNAUTHENTICATED' });
  });

  it('turns a timeout into a TIMEOUT error with remediation', async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          command: 'claude',
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          cancelled: false,
          durationMs: 1000,
          failed: true
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    await expect(
      adapter.run(
        { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3 },
        { signal: new AbortController().signal, timeoutMs: 60_000, onProgress: () => undefined }
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

/* -------------------------------------------------------------------------- */
/* GitHub adapter                                                              */
/* -------------------------------------------------------------------------- */

describe('gh auth status parsing', () => {
  it('parses the modern multi-account format and picks the active account', () => {
    const output = `github.com
  ✓ Logged in to github.com account Desken-van (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account other-user (keyring)
  - Active account: false`;

    const summary = parseGhAuthStatus(output);
    expect(summary.loggedIn).toBe(true);
    expect(summary.accounts).toEqual(['Desken-van', 'other-user']);
    expect(summary.activeAccount).toBe('Desken-van');
  });

  it('parses the legacy single-account format', () => {
    const summary = parseGhAuthStatus('✓ Logged in to github.com as octocat (oauth_token)');
    expect(summary.accounts).toEqual(['octocat']);
    expect(summary.activeAccount).toBe('octocat');
  });

  it('reports logged out', () => {
    const summary = parseGhAuthStatus('You are not logged into any GitHub hosts.');
    expect(summary.loggedIn).toBe(false);
    expect(summary.activeAccount).toBeNull();
  });

  it('never captures a token as an account name', () => {
    const summary = parseGhAuthStatus(`  ✓ Logged in to github.com account real-user (keyring)
  - Token: ghp_abcdefghijklmnopqrstuvwxyz012345`);
    expect(summary.accounts).toEqual(['real-user']);
    expect(JSON.stringify(summary)).not.toContain('ghp_');
  });
});

describe('extractGithubUrl', () => {
  it('pulls the URL out of gh output', () => {
    expect(extractGithubUrl('https://github.com/acme/thing/pull/12\n')).toBe(
      'https://github.com/acme/thing/pull/12'
    );
  });

  it('strips trailing punctuation', () => {
    expect(extractGithubUrl('Created https://github.com/acme/thing.')).toBe(
      'https://github.com/acme/thing'
    );
  });

  it('returns null when there is no URL', () => {
    expect(extractGithubUrl('nothing here')).toBeNull();
  });
});

describe('GitHub adapter diagnostics', () => {
  it('reports missing with install instructions when gh cannot be found', async () => {
    const adapter = new GhGitHubAdapter(new ExecaProcessRunner(), {
      configuredPath: 'C:\\nope\\gh.exe'
    });
    const diagnostic = await adapter.diagnose();

    expect(diagnostic.status).toBe('missing');
    expect(diagnostic.remediation).toContain('gh auth login');
    expect(diagnostic.accounts).toEqual([]);
  });

  it('rejects an invalid owner without spawning anything', async () => {
    const adapter = new GhGitHubAdapter(
      {
        async run() {
          throw new Error('should not spawn');
        }
      },
      { configuredPath: process.execPath }
    );

    expect(await adapter.hasAccessToOwner('not a valid owner!')).toBe(false);
    expect(await adapter.repositoryExists('bad owner', 'repo')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Executable locator                                                          */
/* -------------------------------------------------------------------------- */

describe('executable locator', () => {
  it('returns null for a configured path that does not exist', () => {
    expect(locateExecutable('claude', { configuredPath: 'C:\\nope\\claude.exe' })).toBeNull();
  });

  it('prefers a valid configured path over PATH', () => {
    const located = locateExecutable('anything', { configuredPath: process.execPath });
    expect(located?.source).toBe('configured');
    expect(located?.path).toBe(process.execPath);
  });

  it('finds a real binary on PATH', () => {
    expect(findOnPath('git')).toBeTruthy();
  });

  it('returns null for a command that does not exist', () => {
    expect(findOnPath('definitely-not-a-real-command-xyz')).toBeNull();
    expect(locateExecutable('definitely-not-a-real-command-xyz')).toBeNull();
  });

  it('prefers a bundled path when one is supplied and no config is set', () => {
    const located = locateExecutable('codex', { bundledPaths: [process.execPath] });
    expect(located?.source).toBe('bundled');
  });
});

/* -------------------------------------------------------------------------- */
/* Codex event mapping                                                         */
/* -------------------------------------------------------------------------- */

describe('Codex thread item mapping', () => {
  it('shows a completed agent message', () => {
    const event = describeItem({ id: '1', type: 'agent_message', text: 'the answer' }, true);
    expect(event?.type).toBe('assistant_message');
    expect(event?.text).toBe('the answer');
  });

  it('suppresses an in-progress agent message', () => {
    expect(describeItem({ id: '1', type: 'agent_message', text: 'partial' }, false)).toBeNull();
  });

  it('renders command execution with status', () => {
    const event = describeItem(
      {
        id: '1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: '',
        status: 'completed',
        exit_code: 0
      },
      true
    );
    expect(event?.type).toBe('command');
    expect(event?.text).toContain('npm test');
    expect(event?.text).toContain('✓');
  });

  it('renders file changes', () => {
    const event = describeItem(
      {
        id: '1',
        type: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'update' }],
        status: 'completed'
      },
      true
    );
    expect(event?.text).toBe('update src/a.ts');
  });

  it('renders an error item', () => {
    const event = describeItem({ id: '1', type: 'error', message: 'boom' }, true);
    expect(event?.type).toBe('error');
  });
});

/* -------------------------------------------------------------------------- */
/* Prompts                                                                     */
/* -------------------------------------------------------------------------- */

describe('prompt construction', () => {
  it('tells the specifier it is read-only and names the repository', () => {
    const prompt = buildSpecificationPrompt({
      projectPath: 'C:\\repo\\demo',
      taskTitle: 'Add health endpoint',
      originalRequest: 'please add /health'
    });

    expect(prompt).toContain('C:\\repo\\demo');
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('please add /health');
    expect(prompt).toContain('implementationPrompt');
  });

  it('tells the reviewer it must not modify files and gives it the evidence', () => {
    const prompt = buildReviewPrompt({
      specification: makeSpecification(),
      changes: makeChangeSet(),
      claudeReport: 'I added the route.',
      testOutput: '2 passed',
      round: 2,
      maxRounds: 3
    });

    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('must not');
    expect(prompt).toContain('round 2 of at most 3');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('I added the route.');
    expect(prompt).toContain('2 passed');
    expect(prompt).toContain('GET /health responds 200');
  });

  it('warns the reviewer when the diff was truncated', () => {
    const prompt = buildReviewPrompt({
      specification: makeSpecification(),
      changes: makeChangeSet({ diffTruncated: true }),
      claudeReport: '',
      testOutput: '',
      round: 1,
      maxRounds: 3
    });
    expect(prompt).toContain('truncated');
  });

  it('gives the implementer the worktree, branch and the do-not-commit rule', () => {
    const prompt = buildImplementationPrompt({
      specification: makeSpecification(),
      worktreePath: 'C:\\wt\\task-1',
      branchName: 'agent-relay/task-1',
      originalRequest: 'please add /health'
    });

    expect(prompt).toContain('C:\\wt\\task-1');
    expect(prompt).toContain('agent-relay/task-1');
    expect(prompt).toContain('Inspect before you edit');
    expect(prompt).toContain('Preserve unrelated work');
    expect(prompt).toContain('git commit');
    expect(prompt).toContain('Do NOT create a pull request');
  });

  it('groups correction findings by severity and carries the follow-up', () => {
    const prompt = buildCorrectionPrompt({
      review: makeReview({
        verdict: 'changes_requested',
        summary: 'Nearly there.',
        followUpPrompt: 'Fix the null check.',
        findings: [
          { severity: 'critical', title: 'Crash', description: 'NPE', file: 'a.ts', line: 3 },
          { severity: 'low', title: 'Naming', description: 'unclear', file: null, line: null }
        ]
      }),
      round: 2,
      maxRounds: 3
    });

    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('LOW');
    expect(prompt).toContain('[a.ts:3]');
    expect(prompt).toContain('Fix the null check.');
    expect(prompt).toContain('correction round 2 of at most 3');
    expect(prompt).toContain('do not commit');
  });
});

/* -------------------------------------------------------------------------- */
/* Test output extraction                                                      */
/* -------------------------------------------------------------------------- */

describe('extractTestOutput', () => {
  it('lifts fenced blocks that look like command output', () => {
    const report = 'I ran the tests.\n\n```\n> vitest run\n12 passed\n```\n\nAll good.';
    expect(extractTestOutput(report)).toContain('12 passed');
  });

  it('ignores fenced blocks that are just code', () => {
    const report = 'Here is the code:\n\n```ts\nconst greeting = "hello";\n```';
    expect(extractTestOutput(report)).toBe('');
  });

  it('returns an empty string for an empty report', () => {
    expect(extractTestOutput('')).toBe('');
  });

  it('joins several blocks', () => {
    const report = '```\nnpm test\n1 passed\n```\ntext\n```\npytest\n2 failed\n```';
    const output = extractTestOutput(report);
    expect(output).toContain('1 passed');
    expect(output).toContain('2 failed');
  });
});
