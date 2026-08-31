import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCliAdapter,
  destructiveToolDenyRules
} from '../../src/main/adapters/claude/claude-adapter';
import {
  consumeLine,
  createStreamState,
  describeDenials,
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
import {
  findOnPath,
  locateExecutable,
  wellKnownWindowsLocations,
  wingetClaudePackageCandidates
} from '../../src/main/adapters/process/executable-locator';
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
/* Permission denials — the reason a "successful" run can be a failed one       */
/* -------------------------------------------------------------------------- */

describe('Claude permission denials', () => {
  const denialEvent = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      decision_reason: 'This command requires approval',
      ...overrides
    });

  const successResult = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done.',
      num_turns: 3,
      session_id: 'sess-1',
      ...overrides
    });

  it('fails a run whose result claims success after a denial', () => {
    const state = createStreamState();
    const events = consumeLine(denialEvent(), state);
    consumeLine(successResult(), state);

    expect(events[0]?.type).toBe('error');
    expect(events[0]?.text).toContain('Bash');
    expect(events[0]?.text).toContain('This command requires approval');

    const final = finalizeState(state);
    expect(final.isError).toBe(true);
    expect(final.denials).toHaveLength(1);
    expect(final.denials[0]?.tool).toBe('Bash');
    expect(describeDenials(final.denials)).toContain('Bash');
  });

  it('catches a denial reported only in the result envelope', () => {
    const state = createStreamState();
    const events = consumeLine(
      successResult({
        permission_denials: [
          { tool_name: 'PowerShell', tool_use_id: 'toolu_9', tool_input: { command: 'npm test' } }
        ]
      }),
      state
    );

    // The denial is announced before the result it invalidates.
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.text).toContain('PowerShell');
    expect(events[1]?.type).toBe('error');

    const final = finalizeState(state);
    expect(final.isError).toBe(true);
    expect(final.denials).toHaveLength(1);
  });

  it('deduplicates a denial reported as an event and again in the result', () => {
    const state = createStreamState();
    consumeLine(denialEvent(), state);
    consumeLine(
      successResult({
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1' }]
      }),
      state
    );

    expect(finalizeState(state).denials).toHaveLength(1);
  });

  it('deduplicates by tool and reason when the CLI sends no tool_use_id', () => {
    const state = createStreamState();
    consumeLine(denialEvent({ tool_use_id: undefined }), state);
    consumeLine(denialEvent({ tool_use_id: undefined }), state);

    expect(finalizeState(state).denials).toHaveLength(1);
  });

  it('truncates a long denial reason', () => {
    const state = createStreamState();
    consumeLine(denialEvent({ decision_reason: 'x'.repeat(5000) }), state);

    const reason = finalizeState(state).denials[0]?.reason ?? '';
    expect(reason.length).toBeLessThanOrEqual(301);
  });

  it('reports thinking_tokens as progress, not as a second session start', () => {
    const state = createStreamState();
    const events = consumeLine(
      JSON.stringify({ type: 'system', subtype: 'thinking_tokens', tokens: 128 }),
      state
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('progress');
    expect(events[0]?.type).not.toBe('started');
  });

  it('still treats init as the session start', () => {
    const state = createStreamState();
    const events = consumeLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: 'C:\\wt' }),
      state
    );

    expect(events[0]?.type).toBe('started');
  });

  it('leaves a clean run successful', () => {
    const state = createStreamState();
    consumeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }), state);
    consumeLine(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }), state);
    const events = consumeLine(successResult(), state);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('result');

    const final = finalizeState(state);
    expect(final.isError).toBe(false);
    expect(final.denials).toHaveLength(0);
    expect(describeDenials(final.denials)).toBe('');
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

  /** Run the adapter against a recording runner and return the argv it built. */
  async function captureClaudeArgs(
    options: { allowedTools?: readonly string[] } = {},
    request: { model?: string | null; sessionId?: string | null } = {}
  ): Promise<string[]> {
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

    const adapter = new ClaudeCliAdapter(runner, {
      configuredPath: process.execPath,
      ...options
    });

    await adapter.run(
      {
        worktreePath: process.cwd(),
        branchName: 'b',
        prompt: 'p',
        sessionId: request.sessionId ?? null,
        maxTurns: 3,
        model: request.model ?? null
      },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    return captured;
  }

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
        maxTurns: 5,
        model: null
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
        maxTurns: 3,
        model: null
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
      { worktreePath: process.cwd(), branchName: 'b', prompt: longPrompt, sessionId: null, maxTurns: 3, model: null },
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
        { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3, model: null },
        { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
      )
    ).rejects.toMatchObject({ code: 'TOOL_UNAUTHENTICATED' });
  });

  it('builds exactly the expected argv, in order', async () => {
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

    const adapter = new ClaudeCliAdapter(runner, {
      configuredPath: process.execPath,
      allowedTools: ['Bash(npm test *)', 'PowerShell(npm test *)']
    });

    await adapter.run(
      {
        worktreePath: process.cwd(),
        branchName: 'agent-relay/x',
        prompt: 'do the thing',
        sessionId: 'sess-abc',
        maxTurns: 5,
        model: null
      },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    expect(captured).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      '5',
      '--resume',
      'sess-abc',
      '--allowedTools',
      'Bash(npm test *)',
      'PowerShell(npm test *)',
      '--disallowedTools',
      ...destructiveToolDenyRules()
    ]);
  });

  it('passes the task model through --model on a fresh run', async () => {
    const captured = await captureClaudeArgs({}, { model: 'opus' });
    const index = captured.indexOf('--model');

    expect(index).toBeGreaterThanOrEqual(0);
    expect(captured[index + 1]).toBe('opus');
  });

  it('passes --model alongside --resume on a correction round', async () => {
    const captured = await captureClaudeArgs({}, { model: 'opus', sessionId: 'sess-abc' });

    expect(captured[captured.indexOf('--model') + 1]).toBe('opus');
    expect(captured[captured.indexOf('--resume') + 1]).toBe('sess-abc');
  });

  it('accepts a full model id, not just an alias', async () => {
    const captured = await captureClaudeArgs({}, { model: 'claude-opus-5' });
    expect(captured[captured.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  it('omits --model entirely when the task has no override', async () => {
    const captured = await captureClaudeArgs({}, { model: null });
    expect(captured).not.toContain('--model');
  });

  it('keeps the permission arguments intact when a model is set', async () => {
    const captured = await captureClaudeArgs(
      { allowedTools: ['Bash(npm test *)'] },
      { model: 'sonnet' }
    );

    // The model must not disturb the security-relevant ordering.
    expect(captured.slice(0, 8)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--permission-mode',
      'acceptEdits'
    ]);
    expect(captured).toContain('--allowedTools');
    expect(captured).toContain('--disallowedTools');
    expect(captured.indexOf('--model')).toBeLessThan(captured.indexOf('--allowedTools'));
  });

  it('names the model in the error and never retries with another one', async () => {
    let runs = 0;
    const runner: ProcessRunner = {
      async run() {
        runs += 1;
        return {
          command: 'claude',
          exitCode: 1,
          stdout: '',
          stderr: 'Error: model "gpt-nonsense" is not available for this account',
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
        {
          worktreePath: process.cwd(),
          branchName: 'b',
          prompt: 'p',
          sessionId: null,
          maxTurns: 3,
          model: 'gpt-nonsense'
        },
        { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
      )
    ).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: expect.stringContaining('gpt-nonsense')
    });

    // Exactly one attempt: no silent fallback to a different model.
    expect(runs).toBe(1);
  });

  it('isolates the run from the operator\'s personal Claude configuration', async () => {
    const captured = await captureClaudeArgs({});
    const index = captured.indexOf('--setting-sources');

    expect(index).toBeGreaterThanOrEqual(0);
    expect(captured[index + 1]).toBe('project');
    expect(captured).not.toContain('user');
    expect(captured).not.toContain('--bare');
  });

  it('passes each permission rule as its own argument, never comma-joined', async () => {
    const captured = await captureClaudeArgs({
      allowedTools: ['Bash(npm test *)', 'Bash(npm run lint *)']
    });

    expect(captured).toContain('Bash(npm test *)');
    expect(captured).toContain('Bash(npm run lint *)');
    expect(captured.some((arg) => arg.includes(','))).toBe(false);
  });

  it('omits --allowedTools entirely when nothing is granted', async () => {
    const captured = await captureClaudeArgs({ allowedTools: [] });

    expect(captured).not.toContain('--allowedTools');
    // The deny list is not optional, though.
    expect(captured).toContain('--disallowedTools');
  });

  it('always denies the destructive Git and GitHub commands', async () => {
    for (const allowedTools of [
      undefined,
      [],
      // Even a user who explicitly tries to grant them.
      ['Bash(git push *)', 'Bash(gh *)', 'PowerShell(git commit *)']
    ]) {
      const captured = await captureClaudeArgs({ allowedTools });
      const denyIndex = captured.indexOf('--disallowedTools');
      expect(denyIndex).toBeGreaterThanOrEqual(0);

      const denied = captured.slice(denyIndex + 1);
      for (const rule of destructiveToolDenyRules()) {
        expect(denied).toContain(rule);
      }
    }
  });

  it('covers both shells and both bare and argument forms in the deny list', () => {
    const rules = destructiveToolDenyRules();

    for (const command of [
      'git commit',
      'git push',
      'git reset',
      'git clean',
      'git checkout',
      'git switch',
      'git merge',
      'git rebase',
      'gh'
    ]) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(rules).toContain(`${tool}(${command})`);
        expect(rules).toContain(`${tool}(${command}:*)`);
        expect(rules).toContain(`${tool}(${command} *)`);
      }
    }

    // No duplicates: the argv would still work, but it would be noise.
    expect(new Set(rules).size).toBe(rules.length);
  });

  it('fails the round when a tool call was denied, even on a success envelope', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        decision_reason: 'This command requires approval'
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'All done.',
        num_turns: 3,
        session_id: 'sess-1'
      })
    ];

    const runner: ProcessRunner = {
      async run(_file, _args, options) {
        for (const line of stream) options?.onLine?.(line);
        return {
          command: 'claude',
          exitCode: 0,
          stdout: stream.join('\n'),
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: false
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    const result = await adapter.run(
      { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3, model: null },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    expect(result.isError).toBe(true);
    expect(result.permissionDenials).toHaveLength(1);
    expect(result.finalMessage).toContain('denied permission');
    // The model's own summary is kept, after the warning.
    expect(result.finalMessage).toContain('All done.');
    expect(result.sessionId).toBe('sess-1');
  });

  it('leaves a clean run successful', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Tests pass.',
        num_turns: 2,
        session_id: 'sess-2'
      })
    ];

    const runner: ProcessRunner = {
      async run(_file, _args, options) {
        for (const line of stream) options?.onLine?.(line);
        return {
          command: 'claude',
          exitCode: 0,
          stdout: stream.join('\n'),
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          failed: false
        };
      }
    };

    const adapter = new ClaudeCliAdapter(runner, { configuredPath: process.execPath });
    const result = await adapter.run(
      { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3, model: null },
      { signal: new AbortController().signal, timeoutMs: 1000, onProgress: () => undefined }
    );

    expect(result.isError).toBe(false);
    expect(result.permissionDenials).toHaveLength(0);
    expect(result.finalMessage).toBe('Tests pass.');
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
        { worktreePath: process.cwd(), branchName: 'b', prompt: 'p', sessionId: null, maxTurns: 3, model: null },
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

  it('resolves a WinGet-installed Claude when PATH does not have it', () => {
    // The exact case a stale process hits: WinGet appended the package
    // directory to PATH after this process inherited its environment.
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      const packages = join(root, 'Microsoft', 'WinGet', 'Packages');
      const claudePackage = join(packages, 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe');
      mkdirSync(claudePackage, { recursive: true });
      const executable = join(claudePackage, 'claude.exe');
      writeFileSync(executable, '');

      const located = locateExecutable('claude', {
        env: { LOCALAPPDATA: root, PATH: join(root, 'nothing-here') }
      });

      expect(located?.source).toBe('well-known');
      expect(located?.path).toBe(executable);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores unrelated WinGet packages, and nested executables', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      const packages = join(root, 'Microsoft', 'WinGet', 'Packages');

      // A different vendor's package that happens to ship a claude.exe.
      const other = join(packages, 'SomeoneElse.ClaudeLookalike_abc123');
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, 'claude.exe'), '');

      // A prefix that is close but not exact.
      const nearMiss = join(packages, 'Anthropic.ClaudeCodeExtra');
      mkdirSync(nearMiss, { recursive: true });
      writeFileSync(join(nearMiss, 'claude.exe'), '');

      // The real prefix, but the executable is nested one level down.
      const nested = join(packages, 'Anthropic.ClaudeCode_nested', 'bin');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'claude.exe'), '');

      const candidates = wingetClaudePackageCandidates({ LOCALAPPDATA: root });

      // Neither the other vendor nor the near-miss prefix is considered.
      expect(candidates.some((c) => c.includes('SomeoneElse'))).toBe(false);
      expect(candidates.some((c) => c.includes('ClaudeLookalike'))).toBe(false);
      expect(candidates.some((c) => c.includes('ClaudeCodeExtra'))).toBe(false);

      // The matching directory yields exactly one candidate, directly inside it
      // — the scan does not descend into `bin`.
      expect(candidates).toEqual([join(packages, 'Anthropic.ClaudeCode_nested', 'claude.exe')]);

      // And since nothing is actually there, discovery still finds nothing.
      expect(
        locateExecutable('claude', { env: { LOCALAPPDATA: root, PATH: join(root, 'nothing-here') } })
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns candidates deterministically when several matching packages exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      const packages = join(root, 'Microsoft', 'WinGet', 'Packages');
      for (const suffix of ['zzz', 'aaa', 'mmm']) {
        const dir = join(packages, `Anthropic.ClaudeCode_${suffix}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'claude.exe'), '');
      }

      const candidates = wingetClaudePackageCandidates({ LOCALAPPDATA: root });
      expect(candidates).toEqual([
        join(packages, 'Anthropic.ClaudeCode_aaa', 'claude.exe'),
        join(packages, 'Anthropic.ClaudeCode_mmm', 'claude.exe'),
        join(packages, 'Anthropic.ClaudeCode_zzz', 'claude.exe')
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a missing WinGet Packages directory as no candidate, not an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      // No Microsoft\WinGet\Packages at all — a machine without WinGet.
      expect(() => wingetClaudePackageCandidates({ LOCALAPPDATA: root })).not.toThrow();
      expect(wingetClaudePackageCandidates({ LOCALAPPDATA: root })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers PATH over the WinGet package directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      const packages = join(root, 'Microsoft', 'WinGet', 'Packages');
      const claudePackage = join(packages, 'Anthropic.ClaudeCode_x');
      mkdirSync(claudePackage, { recursive: true });
      writeFileSync(join(claudePackage, 'claude.exe'), '');

      const onPath = join(root, 'on-path');
      mkdirSync(onPath, { recursive: true });
      writeFileSync(join(onPath, 'claude.exe'), '');

      const located = locateExecutable('claude', { env: { LOCALAPPDATA: root, PATH: onPath } });
      expect(located?.source).toBe('path');
      expect(located?.path).toBe(join(onPath, 'claude.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('looks in the WinGet Links directory', () => {
    // The official Claude Code package installs a shim here and appends the
    // directory to PATH, which an already-running shell will not have picked up.
    const candidates = wellKnownWindowsLocations('claude');
    const expected = join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'Microsoft',
      'WinGet',
      'Links'
    );

    expect(candidates.some((candidate) => candidate.startsWith(expected))).toBe(true);
    expect(candidates).toContain(join(expected, 'claude.exe'));
  });

  it('scans the WinGet Packages directory only for claude, and only when bounded', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-winget-'));
    try {
      const packages = join(root, 'Microsoft', 'WinGet', 'Packages');
      const claudePackage = join(packages, 'Anthropic.ClaudeCode_someSourceId');
      mkdirSync(claudePackage, { recursive: true });
      writeFileSync(join(claudePackage, 'claude.exe'), '');

      // Only `claude` triggers the package scan; other tools do not get one.
      expect(
        wellKnownWindowsLocations('gh', { LOCALAPPDATA: root }).some((c) =>
          c.includes('WinGet\\Packages')
        )
      ).toBe(false);

      const claudeCandidates = wellKnownWindowsLocations('claude', { LOCALAPPDATA: root });
      expect(claudeCandidates).toContain(join(claudePackage, 'claude.exe'));

      // The Links shim is still checked, and is preferred over the package dir.
      const links = join(root, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
      expect(claudeCandidates.indexOf(links)).toBeLessThan(
        claudeCandidates.indexOf(join(claudePackage, 'claude.exe'))
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hard-codes no username, source id, or absolute install path', () => {
    // The source-id suffix differs per WinGet source and the path is per-user;
    // discovery must derive both at runtime.
    const source = readFileSync(
      join(process.cwd(), 'src/main/adapters/process/executable-locator.ts'),
      'utf8'
    );

    expect(source).not.toMatch(/8wekyb3d8bbwe/);
    expect(source).not.toMatch(/nickp/i);
    expect(source).not.toMatch(/C:\\\\Users\\\\/);
    // The prefix itself is intentionally present; the suffix is not.
    expect(source).toContain('Anthropic.ClaudeCode_');
  });

  it('still looks in the native ~/.local/bin location', () => {
    expect(wellKnownWindowsLocations('claude')).toContain(
      join(homedir(), '.local', 'bin', 'claude.exe')
    );
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
