/**
 * `ClaudeCliAdapter` against a real child process.
 *
 * Everything else in the suite gives the adapter a `ProcessRunner` that returns
 * a canned string. That proves the adapter calls the interface correctly, and
 * nothing at all about the boundary the interface stands for: argv as the
 * operating system receives it, a prompt that only exists on stdin, a pipe that
 * delivers half a JSON line, a stderr channel that must never be mistaken for
 * protocol, an exit code, a timeout that has to actually kill something.
 *
 * So these run `node tests/fixtures/fake-claude-cli.mjs` — the real
 * `ExecaProcessRunner`, a real process, real pipes — and assert on what the
 * adapter publicly returns and on what the child publicly recorded about how it
 * was started. No private field is read, and the fixture is addressed by path,
 * so the outcome does not depend on whether Claude Code is installed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destructiveToolDenyRules } from '../../src/shared/domain/claude-tool-rules';
import type { AgentRelayError } from '../../src/shared/domain/errors';
import { launchFor, locateExecutable } from '../../src/main/adapters/process/executable-locator';
import {
  ExecaProcessRunner,
  type ProcessResult,
  type ProcessRunOptions
} from '../../src/main/adapters/process/process-runner';
import type { ClaudeToolExecution } from '../../src/main/ports';
import {
  claudeStream,
  fakeClaudeAdapter,
  fakeClaudeRequest,
  FakeClaudeWorktree,
  FAKE_CLAUDE_CLI,
  recordingContext,
  waitForExit,
  type FakeClaudeScenario
} from '../helpers/fake-claude';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const worktrees: FakeClaudeWorktree[] = [];
const scratchDirs: string[] = [];

function worktree(build?: (path: string) => FakeClaudeScenario): FakeClaudeWorktree {
  const created = new FakeClaudeWorktree();
  worktrees.push(created);
  if (build) created.scenario(build(created.path));
  return created;
}

/** A directory the fake was never told about, for the working-directory case. */
function bareDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-relay-bare-'));
  scratchDirs.push(path);
  return path;
}

afterEach(() => {
  for (const created of worktrees.splice(0)) created.cleanup();
  for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The real runner, with a note of every child it was asked to start.
 *
 * Subclassed rather than replaced: the spawn, the pipes and the kill are all
 * still `ExecaProcessRunner`'s. What is added is a record of the boundary the
 * adapter is not otherwise able to show — the argv handed over, the command
 * label built from it, and how many processes were started for one request.
 */
class ObservingRunner extends ExecaProcessRunner {
  readonly starts: { file: string; args: readonly string[] }[] = [];
  readonly results: ProcessResult[] = [];

  override async run(
    file: string,
    args: readonly string[],
    options: ProcessRunOptions = {}
  ): Promise<ProcessResult> {
    this.starts.push({ file, args: [...args] });
    const result = await super.run(file, args, options);
    this.results.push(result);
    return result;
  }
}

/** Run and return the domain error, failing loudly if the run succeeded. */
async function failureOf(promise: Promise<unknown>): Promise<AgentRelayError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentRelayError;
  }
  throw new Error('expected the Claude run to fail, but it resolved');
}

const byId = (executions: readonly ClaudeToolExecution[], id: string): ClaudeToolExecution => {
  const found = executions.find((entry) => entry.toolUseId === id);
  if (!found) throw new Error(`no tool execution recorded for ${id}`);
  return found;
};

/**
 * Assembled rather than written out, so no continuous token-shaped literal ever
 * exists in this file. It is synthetic and matches nothing real.
 */
const SYNTHETIC_TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

/* -------------------------------------------------------------------------- */
/* 1. A clean round                                                            */
/* -------------------------------------------------------------------------- */

describe('a clean round, end to end through a real process', () => {
  it('returns the session, the final message, the turn count and the evidence', async () => {
    const tree = worktree((path) => ({
      sessionId: 'sess-clean',
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.assistantText('Reading the specification.') },
        { event: claudeStream.toolUse('toolu_1', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_1') },
        { event: claudeStream.result({ text: 'Implemented and verified.', numTurns: 4 }) }
      ],
      exit: 0
    }));

    const { context, events } = recordingContext();
    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    expect(result.sessionId).toBe('sess-clean');
    expect(result.finalMessage).toBe('Implemented and verified.');
    expect(result.numTurns).toBe(4);
    expect(result.isError).toBe(false);
    expect(result.permissionDenials).toEqual([]);
    expect(result.rawResultJson).toContain('"type":"result"');

    expect(result.evidence.resultEnvelopeSeen).toBe(true);
    expect(result.evidence.resultEnvelopeIsError).toBe(false);
    expect(result.evidence.resultEnvelopeConflict).toBe(false);
    expect(result.evidence.malformedLineCount).toBe(0);
    expect(result.evidence.incompleteToolUseCount).toBe(0);
    expect(result.evidence.orphanToolResultCount).toBe(0);

    expect(result.evidence.toolExecutions).toEqual([
      {
        toolUseId: 'toolu_1',
        toolUseSequence: 1,
        tool: 'Bash',
        command: 'npm test',
        commandTruncated: false,
        summary: 'Bash: npm test',
        toolUseSeen: true,
        resultReceived: true,
        isError: false,
        resultConflict: false
      }
    ]);

    // The timeline the user sees is built from the same stream.
    expect(events.map((event) => event.type)).toEqual([
      'started', // the adapter's own "starting a session"
      'started', // the CLI's init
      'assistant_message',
      'tool_use',
      'log', // the tool result's own output
      'result'
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Prompt transport                                                         */
/* -------------------------------------------------------------------------- */

describe('the prompt', () => {
  const prompt = [
    'Implement the specification below.',
    '',
    'Shell metacharacters that must stay inert:',
    '  rm -rf / ; echo chained',
    '  git push && git reset --hard',
    '  $(node -e "require(\'fs\').writeFileSync(\'pwned.txt\',\'x\')")',
    '  `whoami` and %USERPROFILE% and ${HOME}',
    '  "double quoted" and \'single quoted\' and a lone " quote',
    '',
    ...Array.from({ length: 40 }, (_, index) => `Requirement ${index + 1}: keep line ${index + 1} intact.`),
    '',
    'End of prompt.'
  ].join('\n');

  const cleanRound = (path: string): FakeClaudeScenario => ({
    sessionId: 'sess-prompt',
    actions: [
      { event: claudeStream.init(path) },
      { event: claudeStream.result({ text: 'ok', numTurns: 1 }) }
    ],
    exit: 0
  });

  it('arrives on stdin, byte for byte', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(fakeClaudeRequest(tree, { prompt }), context);
    const invocation = tree.invocation();

    expect(invocation.stdinSha256).toBe(createHash('sha256').update(prompt, 'utf8').digest('hex'));
    expect(invocation.stdinBytes).toBe(Buffer.byteLength(prompt, 'utf8'));
    expect(invocation.stdin).toBe(prompt);
    // Line structure survives: a prompt flattened into one line would still
    // match on length but not on this.
    expect(invocation.stdin.split('\n')).toHaveLength(prompt.split('\n').length);
  });

  it('never appears in argv or in the command label', async () => {
    const tree = worktree(cleanRound);
    const runner = new ObservingRunner();
    const { context, events } = recordingContext();

    await fakeClaudeAdapter({}, runner).run(fakeClaudeRequest(tree, { prompt }), context);

    const argv = tree.invocation().argv.join(' ');
    expect(argv).not.toContain('Requirement 1:');
    expect(argv).not.toContain('rm -rf');
    expect(argv).not.toContain('whoami');

    // The label is what gets logged and persisted, so it is checked separately
    // from argv rather than assumed to follow from it.
    const label = runner.results[0]?.command ?? '';
    expect(label).not.toContain('Requirement 1:');
    expect(label).not.toContain('whoami');

    // And nothing echoed it back into the timeline.
    expect(events.map((event) => event.text).join('\n')).not.toContain('Requirement 1:');
  });

  it('is one opaque payload, not a command line', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(fakeClaudeRequest(tree, { prompt }), context);

    // `$(…)` in the prompt would have written this file had a shell ever seen
    // the text; `;` and `&&` would have left other traces. The directory holds
    // exactly the two files the fixture itself writes.
    expect(readdirSync(tree.path).sort()).toEqual([
      'fake-claude-invocation.json',
      'fake-claude-scenario.json'
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. argv                                                                     */
/* -------------------------------------------------------------------------- */

describe('the command line the CLI actually receives', () => {
  const cleanRound = (path: string): FakeClaudeScenario => ({
    actions: [
      { event: claudeStream.init(path) },
      { event: claudeStream.result({ text: 'ok', numTurns: 1 }) }
    ],
    exit: 0
  });

  it('is exactly the documented invocation', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(
      fakeClaudeRequest(tree, {
        maxTurns: 7,
        model: 'claude-sonnet-4-5',
        sessionId: 'sess-previous',
        allowedTools: ['Bash(npm test:*)', 'Bash(npm run verify:*)']
      }),
      context
    );

    expect(tree.invocation().argv).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      '7',
      '--model',
      'claude-sonnet-4-5',
      '--resume',
      'sess-previous',
      '--allowedTools',
      'Bash(npm test:*)',
      'Bash(npm run verify:*)',
      '--disallowedTools',
      ...destructiveToolDenyRules()
    ]);
  });

  it('omits the optional flags rather than inventing values for them', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(
      fakeClaudeRequest(tree, { maxTurns: 3, model: null, sessionId: null }),
      context
    );

    const argv = tree.invocation().argv;
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--allowedTools');
    expect(argv.slice(0, 10)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      '3'
    ]);
  });

  it('passes every permission rule as its own argument', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();
    const allowed = ['Bash(npm test:*)', 'Bash(npm run verify --workspace=a,b:*)'];

    await fakeClaudeAdapter().run(fakeClaudeRequest(tree, { allowedTools: allowed }), context);

    const argv = tree.invocation().argv;
    const allowIndex = argv.indexOf('--allowedTools');
    const denyIndex = argv.indexOf('--disallowedTools');

    // Each rule is one entry. Joining them with commas would make the second
    // rule — which contains a comma of its own — impossible to read back.
    expect(argv.slice(allowIndex + 1, denyIndex)).toEqual(allowed);
    expect(argv.slice(denyIndex + 1)).toEqual(destructiveToolDenyRules());
  });

  it('carries the whole deny list and never skips permissions', async () => {
    const tree = worktree(cleanRound);
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    const argv = tree.invocation().argv;
    const rules = destructiveToolDenyRules();
    expect(rules).toHaveLength(54);
    for (const rule of rules) expect(argv).toContain(rule);

    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv.join(' ')).not.toContain('dangerously');
  });

  it('is resolved from the configured path, never from PATH', async () => {
    // The suite must behave identically on a machine with Claude Code installed
    // and one without, so discovery is short-circuited by an explicit path.
    const located = locateExecutable('claude', { configuredPath: FAKE_CLAUDE_CLI });
    expect(located).toEqual({ path: FAKE_CLAUDE_CLI, source: 'configured' });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Working directory                                                        */
/* -------------------------------------------------------------------------- */

describe('the working directory', () => {
  it('is the requested worktree, as the child itself observes it', async () => {
    const tree = worktree((path) => ({
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.result({ text: 'ok', numTurns: 1 }) }
      ]
    }));
    const { context } = recordingContext();

    await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    // Compared through `realpath` because a temporary directory can be reached
    // by more than one name, and the claim is about the directory, not the spelling.
    expect(realpathSync(tree.invocation().cwd)).toBe(realpathSync(tree.path));
  });

  it('is not somewhere else that happens to work', async () => {
    // The fixture only ever reads its scenario from the working directory, so a
    // run started anywhere else cannot find one — and says so on stderr.
    const elsewhere = bareDirectory();
    const { context } = recordingContext();

    const error = await failureOf(
      fakeClaudeAdapter().run(fakeClaudeRequest(worktree(), { worktreePath: elsewhere }), context)
    );

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('exited with code 91');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Stream fragmentation                                                     */
/* -------------------------------------------------------------------------- */

describe('a stream that does not arrive in tidy lines', () => {
  it('reassembles split lines, splits packed chunks, and accepts either line ending', async () => {
    const tree = new FakeClaudeWorktree();
    worktrees.push(tree);

    const lines = [
      JSON.stringify(claudeStream.init(tree.path)),
      JSON.stringify(claudeStream.assistantText('Working.')),
      JSON.stringify(claudeStream.toolUse('toolu_1', 'Bash', { command: 'npm run verify' })),
      JSON.stringify(claudeStream.toolResult('toolu_1')),
      JSON.stringify(claudeStream.result({ text: 'Done.', numTurns: 2 }))
    ];
    const half = Math.floor(lines[0]!.length / 2);

    tree.scenario({
      sessionId: 'sess-fragmented',
      actions: [
        // One JSON object, delivered as two writes with a gap between them.
        { stdout: lines[0]!.slice(0, half) },
        { sleep: 30 },
        { stdout: `${lines[0]!.slice(half)}\r\n` },
        { sleep: 30 },
        // Two records in a single write, terminated with CRLF.
        { stdout: `${lines[1]}\r\n${lines[2]}\r\n` },
        { sleep: 30 },
        // Three records in a single write, terminated with LF.
        { stdout: `${lines[3]}\n${lines[4]}\n` }
      ],
      exit: 0
    });

    const { context, events } = recordingContext();
    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    // Nothing was lost to the split, and nothing was glued together: a merged
    // pair of records would not parse, and would show up here.
    expect(result.evidence.malformedLineCount).toBe(0);
    expect(result.sessionId).toBe('sess-fragmented');
    expect(result.finalMessage).toBe('Done.');
    expect(result.numTurns).toBe(2);
    expect(result.evidence.toolExecutions).toHaveLength(1);
    expect(result.evidence.toolExecutions[0]?.command).toBe('npm run verify');
    expect(result.evidence.toolExecutions[0]?.resultReceived).toBe(true);

    expect(events.map((event) => event.type)).toEqual([
      'started',
      'started',
      'assistant_message',
      'tool_use',
      'log',
      'result'
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. stdout / stderr                                                          */
/* -------------------------------------------------------------------------- */

describe('the boundary between protocol and diagnostics', () => {
  it('refuses to read stderr as the Claude protocol', async () => {
    const tree = new FakeClaudeWorktree();
    worktrees.push(tree);

    // Everything below goes to stderr. Each line is a well-formed protocol
    // record: if stderr were parsed, this run would report a different session,
    // a tool call that never happened, a refusal that never happened, and a
    // final message the CLI never produced.
    const impostor = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-from-stderr' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_stderr', name: 'Bash', input: { command: 'git push' } }]
        }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        tool_use_id: 'toolu_stderr',
        tool_name: 'Bash',
        decision_reason: 'invented by stderr'
      }),
      JSON.stringify({ type: 'result', is_error: true, num_turns: 99, result: 'invented by stderr' })
    ].join('\n');

    tree.scenario({
      sessionId: 'sess-from-stdout',
      actions: [
        { stderr: 'warning: reticulating splines\n' },
        { stderr: `${impostor}\n` },
        { event: claudeStream.init(tree.path) },
        { event: claudeStream.result({ text: 'the real answer', numTurns: 1 }) }
      ],
      exit: 0
    });

    const { context, events } = recordingContext();
    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    expect(result.sessionId).toBe('sess-from-stdout');
    expect(result.finalMessage).toBe('the real answer');
    expect(result.numTurns).toBe(1);
    expect(result.isError).toBe(false);
    expect(result.permissionDenials).toEqual([]);
    expect(result.evidence.toolExecutions).toEqual([]);
    // stderr never reached the parser, so it could not even be counted as
    // unreadable: a stderr line arriving as protocol would show up here.
    expect(result.evidence.malformedLineCount).toBe(0);

    const timeline = events.map((event) => `${event.type} ${event.text}`).join('\n');
    expect(timeline).not.toContain('reticulating');
    expect(timeline).not.toContain('invented by stderr');
    expect(timeline).not.toContain('sess-from-stderr');
  });

  it('keeps stderr as a diagnostic on the process result', async () => {
    // The same separation at the layer that owns it. Streaming used to iterate
    // execa's combined `all` stream, which is what let a diagnostic be handed
    // to a protocol parser in the first place.
    const runner = new ExecaProcessRunner();
    const lines: string[] = [];
    const diagnostics: string[] = [];

    const result = await runner.run(
      process.execPath,
      ['-e', 'console.log("out-1");console.error("err-1");console.log("out-2");console.error("err-2")'],
      { onLine: (line) => lines.push(line), onStderrLine: (line) => diagnostics.push(line) }
    );

    expect(lines).toEqual(['out-1', 'out-2']);
    expect(diagnostics).toEqual(['err-1', 'err-2']);
    expect(result.stdout).toContain('out-1');
    expect(result.stdout).not.toContain('err-1');
    expect(result.stderr).toContain('err-1');
    expect(result.stderr).not.toContain('out-1');
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Non-zero exit                                                            */
/* -------------------------------------------------------------------------- */

describe('a process that exits non-zero', () => {
  it('fails the run with the exit code', async () => {
    const tree = worktree(() => ({
      actions: [{ stderr: 'the CLI fell over\n' }],
      exit: 2
    }));
    const { context } = recordingContext();

    const error = await failureOf(fakeClaudeAdapter().run(fakeClaudeRequest(tree), context));

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('exited with code 2');
    expect(error.details).toContain('the CLI fell over');
  });

  it('tells an authentication failure apart from a broken run', async () => {
    const tree = worktree(() => ({
      actions: [{ stderr: 'Invalid API key · Please run /login\n' }],
      exit: 1
    }));
    const { context } = recordingContext();

    const error = await failureOf(fakeClaudeAdapter().run(fakeClaudeRequest(tree), context));

    expect(error.code).toBe('TOOL_UNAUTHENTICATED');
    expect(error.remediation).toMatch(/complete the login flow/i);
  });

  it('names the model that was asked for, and starts no second process', async () => {
    const tree = worktree(() => ({
      actions: [{ stderr: 'unknown model\n' }],
      exit: 1
    }));
    const runner = new ObservingRunner();
    const { context } = recordingContext();

    const error = await failureOf(
      fakeClaudeAdapter({}, runner).run(
        fakeClaudeRequest(tree, { model: 'imaginary-model-1' }),
        context
      )
    );

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('(model: imaginary-model-1)');
    expect(error.remediation).toContain('imaginary-model-1');

    // No retry, and no quiet substitution of a model the user did not choose.
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]?.args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(tree.invocation().argv).toContain('imaginary-model-1');
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Exit 0 with no final envelope                                            */
/* -------------------------------------------------------------------------- */

describe('a process that exits 0 without a final envelope', () => {
  it('invents neither a success nor evidence for one', async () => {
    const tree = worktree((path) => ({
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.toolUse('toolu_1', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_1') }
      ],
      exit: 0
    }));
    const { context } = recordingContext();

    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    // The absence is recorded as an absence, not smoothed over.
    expect(result.evidence.resultEnvelopeSeen).toBe(false);
    expect(result.evidence.resultEnvelopeIsError).toBeNull();
    expect(result.evidence.resultEnvelopeConflict).toBe(false);
    expect(result.rawResultJson).toBeNull();
    expect(result.numTurns).toBeNull();
    expect(result.finalMessage).toBe('');

    // `isError` is only ever what the CLI said, and it said nothing. Which is
    // precisely why the round policy reads `resultEnvelopeSeen` and not this.
    expect(result.isError).toBe(false);

    // What did happen is still reported truthfully.
    expect(result.evidence.toolExecutions).toHaveLength(1);
    expect(result.evidence.toolExecutions[0]?.resultReceived).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Permission denial                                                        */
/* -------------------------------------------------------------------------- */

describe('a refused tool call', () => {
  it('survives an exit code of 0 and stays linked to the call it refused', async () => {
    const tree = worktree((path) => ({
      sessionId: 'sess-denied',
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.toolUse('toolu_ok', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_ok') },
        { event: claudeStream.toolUse('toolu_blocked', 'Bash', { command: 'git push origin HEAD' }) },
        {
          event: claudeStream.permissionDenied({
            toolUseId: 'toolu_blocked',
            tool: 'Bash',
            reason: 'Bash(git push) is on the deny list'
          })
        },
        {
          event: {
            type: 'result',
            subtype: 'success',
            session_id: '{{sessionId}}',
            is_error: false,
            num_turns: 3,
            result: 'Finished, working around the block.',
            permission_denials: [
              {
                tool_use_id: 'toolu_blocked',
                tool_name: 'Bash',
                decision_reason: 'Bash(git push) is on the deny list'
              }
            ]
          }
        }
      ],
      exit: 0
    }));
    const { context } = recordingContext();

    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    // The whole reason this evidence exists: the CLI reports success.
    expect(result.isError).toBe(false);
    expect(result.evidence.resultEnvelopeIsError).toBe(false);

    // And the refusal is still there, once, tied to the second invocation.
    expect(result.permissionDenials).toHaveLength(1);
    expect(result.permissionDenials[0]).toMatchObject({
      tool: 'Bash',
      toolUseId: 'toolu_blocked',
      toolUseSequence: 2,
      command: 'git push origin HEAD',
      source: 'both'
    });

    expect(byId(result.evidence.toolExecutions, 'toolu_blocked')).toMatchObject({
      toolUseSequence: 2,
      command: 'git push origin HEAD',
      resultReceived: false
    });
    expect(byId(result.evidence.toolExecutions, 'toolu_ok')).toMatchObject({
      toolUseSequence: 1,
      resultReceived: true
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Evidence out of order                                                   */
/* -------------------------------------------------------------------------- */

describe('evidence that arrives out of order', () => {
  it('correlates by id and still reports the order calls were made in', async () => {
    const tree = worktree((path) => ({
      actions: [
        { event: claudeStream.init(path) },
        // The answer outruns the question.
        { event: claudeStream.toolResult('toolu_late') },
        { event: claudeStream.toolUse('toolu_early', 'Read', { file_path: 'README.md' }) },
        { event: claudeStream.toolUse('toolu_late', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_early') },
        { event: claudeStream.result({ text: 'ok', numTurns: 2 }) }
      ],
      exit: 0
    }));
    const { context } = recordingContext();

    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);
    const executions = result.evidence.toolExecutions;

    expect(executions).toHaveLength(2);
    expect(result.evidence.orphanToolResultCount).toBe(0);
    expect(result.evidence.incompleteToolUseCount).toBe(0);

    // The early result was held for its call rather than counted as a stray.
    expect(byId(executions, 'toolu_late')).toMatchObject({
      tool: 'Bash',
      command: 'npm test',
      toolUseSeen: true,
      resultReceived: true,
      toolUseSequence: 2
    });
    expect(byId(executions, 'toolu_early')).toMatchObject({
      tool: 'Read',
      toolUseSeen: true,
      resultReceived: true,
      toolUseSequence: 1
    });

    // Invocation order is the order the calls appeared, not the order their
    // results did.
    expect(
      [...executions]
        .sort((a, b) => (a.toolUseSequence ?? 0) - (b.toolUseSequence ?? 0))
        .map((entry) => entry.toolUseId)
    ).toEqual(['toolu_early', 'toolu_late']);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. Lines the parser was not designed for                                   */
/* -------------------------------------------------------------------------- */

describe('malformed and unknown output', () => {
  it('survives it, counts it, bounds it, and redacts it', async () => {
    const tree = new FakeClaudeWorktree();
    worktrees.push(tree);

    tree.scenario({
      actions: [
        { event: claudeStream.init(tree.path) },
        { stdout: 'this is not JSON at all\n' },
        { stdout: '{"type":"assistant","message":\n' }, // truncated mid-object
        { stdout: '[1,2,3]\n' }, // valid JSON, but not an envelope
        { stdout: `${JSON.stringify({ type: 'brand_new_event', note: 'z'.repeat(3_000) })}\n` },
        { stdout: `${JSON.stringify({ type: 'brand_new_event', note: `key ${SYNTHETIC_TOKEN}` })}\n` },
        { event: claudeStream.result({ text: 'Finished anyway.', numTurns: 1 }) }
      ],
      exit: 0
    });

    const { context, events } = recordingContext();
    const result = await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);

    // It did not fall over, and the round still has its real result.
    expect(result.finalMessage).toBe('Finished anyway.');
    expect(result.evidence.resultEnvelopeSeen).toBe(true);
    expect(result.evidence.malformedLineCount).toBe(3);

    // An unfamiliar event becomes bounded progress rather than being dropped.
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (const event of progress) expect(event.text.length).toBeLessThanOrEqual(1_001);
    expect(progress.some((event) => event.text.includes('brand_new_event'))).toBe(true);

    // Redaction happens before anything reaches a progress callback, which is
    // also the last point before this text would be persisted.
    const timeline = events.map((event) => `${event.type} ${event.text}`).join('\n');
    expect(timeline).not.toContain(SYNTHETIC_TOKEN);
    expect(timeline).not.toContain('ghp_');
    expect(timeline).toContain('[redacted]');
  });
});

/* -------------------------------------------------------------------------- */
/* 12 & 13. Timeout and cancellation                                           */
/* -------------------------------------------------------------------------- */

describe('a child that will not stop on its own', () => {
  const hangingRound = (path: string): FakeClaudeScenario => ({
    sessionId: 'sess-hanging',
    actions: [{ event: claudeStream.init(path) }],
    hang: true
  });

  it('is killed by the timeout, and the run reports one', async () => {
    const tree = worktree(hangingRound);
    const { context } = recordingContext({ timeoutMs: 2_000 });

    const startedAt = Date.now();
    const error = await failureOf(fakeClaudeAdapter().run(fakeClaudeRequest(tree), context));
    const elapsed = Date.now() - startedAt;

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/did not finish within 2s/);
    // The bound is enforced, not merely reported.
    expect(elapsed).toBeLessThan(15_000);

    // And the process is genuinely gone, not merely detached from.
    expect(await waitForExit(tree.invocation().pid)).toBe(true);
  });

  it('is killed by an abort signal, and the run reports a cancellation', async () => {
    const tree = worktree(hangingRound);
    const abort = new AbortController();
    const { context } = recordingContext({
      timeoutMs: 30_000,
      signal: abort.signal,
      // Abort once the child has demonstrably started and reported itself.
      onEvent: (event) => {
        if ((event.data as { subtype?: string } | undefined)?.subtype === 'init') abort.abort();
      }
    });

    const startedAt = Date.now();
    const error = await failureOf(fakeClaudeAdapter().run(fakeClaudeRequest(tree), context));

    expect(error.code).toBe('CANCELLED');
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await waitForExit(tree.invocation().pid)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 14. The output bound                                                        */
/* -------------------------------------------------------------------------- */

describe('the retained-output bound', () => {
  const runner = new ExecaProcessRunner();

  /** The kept text, without the note that says how much was dropped. */
  const body = (stdout: string): string => stdout.split('\n…[')[0] ?? '';

  it('counts ASCII in bytes', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'for (let i = 0; i < 500; i++) console.log("x".repeat(80))'],
      { onLine: () => undefined, maxOutputBytes: 300 }
    );

    expect(Buffer.byteLength(body(result.stdout), 'utf8')).toBeLessThanOrEqual(300);
    expect(result.stdout).toContain('more bytes omitted');
  });

  it('counts multi-byte characters in bytes too, and never splits one', async () => {
    // Each character is three bytes. Counted as JavaScript characters, this
    // would retain three times the agreed ceiling.
    const result = await runner.run(
      process.execPath,
      ['-e', 'for (let i = 0; i < 500; i++) console.log("\\u4e2d".repeat(80))'],
      { onLine: () => undefined, maxOutputBytes: 300 }
    );

    const kept = body(result.stdout);
    expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(300);
    // A cut inside a three-byte character would leave a replacement character
    // behind; the retained text is still exactly the characters that fitted.
    expect(kept).not.toContain('\uFFFD');
    expect(kept.replace(/[\u4e2d\r\n]/g, '')).toBe('');
    expect(result.stdout).toContain('more bytes omitted');
  });

  it('never keeps half of a secret that straddles the bound', async () => {
    const script = `process.stdout.write("A".repeat(100) + " " + ${JSON.stringify(SYNTHETIC_TOKEN)} + "\\n")`;

    const bounded = await runner.run(process.execPath, ['-e', script], {
      onLine: () => undefined,
      // Lands inside the region the token occupied before redaction replaced it.
      maxOutputBytes: 110
    });

    expect(bounded.stdout).not.toContain(SYNTHETIC_TOKEN);
    expect(bounded.stdout).not.toContain('ghp_');
    expect(bounded.stdout).toContain('more bytes omitted');

    // Unbounded, the same line shows what the truncated one is a prefix of:
    // redaction runs first, so there is no token left to cut in half.
    const whole = await runner.run(process.execPath, ['-e', script], { onLine: () => undefined });
    expect(whole.stdout).toContain('[redacted]');
    expect(whole.stdout).not.toContain('ghp_');
  });
});

/* -------------------------------------------------------------------------- */
/* 15. Resuming                                                                */
/* -------------------------------------------------------------------------- */

describe('resuming a session', () => {
  it('passes the id through and starts the round with fresh parser state', async () => {
    const first = worktree((path) => ({
      sessionId: 'sess-round-1',
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.toolUse('toolu_a', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_a') },
        { event: claudeStream.toolUse('toolu_b', 'Bash', { command: 'npm run lint' }) },
        { event: claudeStream.toolResult('toolu_b') },
        { event: claudeStream.result({ text: 'round one', numTurns: 5 }) }
      ]
    }));

    const adapter = fakeClaudeAdapter();
    const opening = await adapter.run(fakeClaudeRequest(first), recordingContext().context);
    expect(opening.sessionId).toBe('sess-round-1');
    expect(opening.evidence.toolExecutions.map((entry) => entry.toolUseSequence)).toEqual([1, 2]);

    // The correction round: same conversation, new process.
    const second = worktree((path) => ({
      actions: [
        // The fake echoes back whatever `--resume` named, so a mangled id shows
        // up as a mismatched session rather than passing silently.
        { event: claudeStream.init(path) },
        { event: claudeStream.toolUse('toolu_c', 'Bash', { command: 'npm test' }) },
        { event: claudeStream.toolResult('toolu_c') },
        { event: claudeStream.result({ text: 'round two', numTurns: 2 }) }
      ]
    }));

    const resumed = await adapter.run(
      fakeClaudeRequest(second, { sessionId: opening.sessionId }),
      recordingContext().context
    );

    const argv = second.invocation().argv;
    const resumeIndex = argv.indexOf('--resume');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIndex + 1]).toBe('sess-round-1');
    expect(argv.filter((arg) => arg === '--resume')).toHaveLength(1);

    expect(resumed.sessionId).toBe('sess-round-1');
    expect(resumed.finalMessage).toBe('round two');
    // A second round is a second stream: numbering starts again at 1, so a
    // sequence never has to be read relative to some earlier round.
    expect(resumed.evidence.toolExecutions.map((entry) => entry.toolUseSequence)).toEqual([1]);
  });
});

/* -------------------------------------------------------------------------- */
/* 16. Environment                                                             */
/* -------------------------------------------------------------------------- */

describe('the environment the child is given', () => {
  /**
   * Claude Code's own credential variables. Stated here rather than imported so
   * that widening the production list cannot silently widen the assertion.
   */
  const CLAUDE_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

  it('hides other tools’ secrets and passes Claude’s own through', async () => {
    const tree = worktree((path) => ({
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.result({ text: 'ok', numTurns: 1 }) }
      ],
      reportEnv: [...CLAUDE_CREDENTIALS, 'AGENT_RELAY_FAKE_GH_TOKEN', 'AGENT_RELAY_FAKE_PLAIN']
    }));

    // Set, then removed; only presence is ever observed, never a value.
    process.env.AGENT_RELAY_FAKE_GH_TOKEN = 'fixture-value-never-reported';
    process.env.AGENT_RELAY_FAKE_PLAIN = 'ordinary';
    process.env.ANTHROPIC_API_KEY = 'fixture-value-never-reported';

    try {
      const { context } = recordingContext();
      await fakeClaudeAdapter().run(fakeClaudeRequest(tree), context);
      const invocation = tree.invocation();

      // Another tool's credential does not reach Claude.
      expect(invocation.envPresent.AGENT_RELAY_FAKE_GH_TOKEN).toBe(false);
      // An ordinary variable is untouched — this is compartmentalisation, not
      // a blank environment.
      expect(invocation.envPresent.AGENT_RELAY_FAKE_PLAIN).toBe(true);
      // Claude's own credential is allowed through, or it could not run.
      expect(invocation.envPresent.ANTHROPIC_API_KEY).toBe(true);

      // Nothing token-shaped survived except what Claude owns. Names only: the
      // fixture never records, prints or returns a value, so a real credential
      // on this machine cannot reach an assertion message or a snapshot.
      for (const name of invocation.envTokenShapedNames) {
        expect(CLAUDE_CREDENTIALS).toContain(name);
      }
      expect(JSON.stringify(invocation)).not.toContain('fixture-value-never-reported');
    } finally {
      delete process.env.AGENT_RELAY_FAKE_GH_TOKEN;
      delete process.env.AGENT_RELAY_FAKE_PLAIN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 17. The retained-output bound keeps a prefix                                */
/* -------------------------------------------------------------------------- */

describe('the retained-output bound, once it has dropped anything', () => {
  const runner = new ExecaProcessRunner();

  /** The kept text, without the note that says how much was dropped. */
  const body = (text: string): string => text.split('\n…[')[0] ?? '';

  const SENTINEL = 'SENTINEL-AFTER-THE-CUT';
  const filler = (letter: string) => letter.repeat(298);

  /**
   * The arrangement that used to break the prefix.
   *
   * 298 bytes of filler plus its newline leaves exactly one byte of a 300-byte
   * budget. The next line begins with a three-byte character, so none of it
   * fits and the whole line is dropped — which left the buffer *under* its
   * limit. The old `size >= limit` guard therefore did not trip, and the short
   * ASCII line after it was appended, landing in the output after data that had
   * already been discarded.
   */
  it('keeps a contiguous prefix of stdout, and later data never reappears', async () => {
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        String.raw`
process.stdout.write("F".repeat(298) + "\n");
process.stdout.write("\u4e2d\n");
process.stdout.write("SENTINEL-AFTER-THE-CUT\n");
`
      ],
      { onLine: () => undefined, maxOutputBytes: 300 }
    );

    // Exactly the prefix, to the byte: nothing of the dropped character, and
    // nothing at all of what followed it.
    expect(body(result.stdout)).toBe(`${filler('F')}\n`);
    expect(Buffer.byteLength(body(result.stdout), 'utf8')).toBe(299);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout).not.toContain('中');
    expect(result.stdout).not.toContain('\uFFFD');

    // 4 bytes for the character and its newline, 23 for the sentinel line.
    expect(result.stdout).toContain('…[27 more bytes omitted]');
  });

  it('applies the same seal to stderr, which uses the same buffer', async () => {
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        String.raw`
process.stderr.write("E".repeat(298) + "\n");
process.stderr.write("\u4e2d\n");
process.stderr.write("SENTINEL-AFTER-THE-CUT\n");
`
      ],
      { onLine: () => undefined, maxOutputBytes: 300 }
    );

    expect(body(result.stderr)).toBe(`${filler('E')}\n`);
    expect(result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain('\uFFFD');
    expect(result.stderr).toContain('…[27 more bytes omitted]');
  });
});

/* -------------------------------------------------------------------------- */
/* 18. A callback that throws                                                  */
/* -------------------------------------------------------------------------- */

describe('a callback that throws', () => {
  it('kills the child at once and fails the run, without waiting for the timeout', async () => {
    // The child reports itself and then hangs: only a kill can end it, so the
    // run finishing quickly is itself the evidence that one happened.
    const tree = worktree((path) => ({
      sessionId: 'sess-callback',
      actions: [{ event: claudeStream.init(path) }],
      hang: true
    }));

    const runner = new ObservingRunner();
    const { context } = recordingContext({
      timeoutMs: 30_000,
      onEvent: (event) => {
        if ((event.data as { subtype?: string } | undefined)?.subtype === 'init') {
          throw new Error('progress handler exploded');
        }
      }
    });

    const startedAt = Date.now();
    const error = await failureOf(fakeClaudeAdapter({}, runner).run(fakeClaudeRequest(tree), context));
    const elapsed = Date.now() - startedAt;

    // The caller's own error is the reported cause, not execa's account of the
    // kill that followed it.
    expect(error.code).toBe('TOOL_FAILED');
    expect(error.details).toContain('progress handler exploded');

    // A 30-second budget was never touched: this is a failure, not a timeout.
    expect(elapsed).toBeLessThan(15_000);

    const result = runner.results[0];
    expect(result).toMatchObject({
      failed: true,
      timedOut: false,
      cancelled: false,
      exitCode: null
    });

    // And the child is genuinely gone, checked by pid rather than assumed.
    expect(await waitForExit(tree.invocation().pid)).toBe(true);

    // Nothing still holds the working directory open.
    tree.cleanup();
    expect(existsSync(tree.path)).toBe(false);
  });

  it('ends the run the same way when a diagnostic callback throws, and still drains stderr', async () => {
    // The contract, chosen deliberately: a failing `onStderrLine` ends the run
    // exactly as a failing `onLine` does. What it must never do is abandon the
    // reader — a child left writing into a full stderr pipe simply blocks, and
    // a blocked child is indistinguishable from a slow one.
    const runner = new ExecaProcessRunner();
    const diagnostics: string[] = [];
    let pid = 0;

    const startedAt = Date.now();
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        String.raw`
process.stdout.write(String(process.pid) + "\n");
process.stderr.write("err-1\nerr-2\nerr-3\n");
setInterval(() => {}, 1000);
`
      ],
      {
        timeoutMs: 30_000,
        onLine: (line) => {
          pid = Number(line);
        },
        onStderrLine: (line) => {
          diagnostics.push(line);
          throw new Error('diagnostic handler exploded');
        }
      }
    );

    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result.failed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBeNull();

    // Called once, then skipped — but the lines after it were still read.
    expect(diagnostics).toEqual(['err-1']);
    expect(result.stderr).toContain('err-2');
    expect(result.stderr).toContain('err-3');

    expect(pid).toBeGreaterThan(0);
    expect(await waitForExit(pid)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 19. Turning a located path into a spawn                                     */
/* -------------------------------------------------------------------------- */

describe('launchFor', () => {
  const RUNTIME_ENV = { ELECTRON_RUN_AS_NODE: '1' };

  it('runs a JavaScript entry point through the current runtime', () => {
    for (const path of [
      'C:\\tools\\claude\\cli.js',
      'C:\\tools\\claude\\cli.mjs',
      'C:\\tools\\claude\\cli.cjs',
      '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    ]) {
      expect(launchFor(path)).toEqual({
        file: process.execPath,
        prefixArgs: [path],
        env: RUNTIME_ENV
      });
    }
  });

  it('does not care how the extension is spelled', () => {
    for (const path of ['C:\\tools\\CLI.MJS', 'C:\\tools\\Cli.Js', '/opt/claude/CLI.CJS']) {
      expect(launchFor(path)).toEqual({
        file: process.execPath,
        prefixArgs: [path],
        env: RUNTIME_ENV
      });
    }
  });

  it('spawns a native executable directly, with no runtime and no added environment', () => {
    for (const path of [
      'C:\\Program Files\\claude\\claude.exe',
      '/usr/local/bin/claude',
      'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude'
    ]) {
      expect(launchFor(path)).toEqual({ file: path, prefixArgs: [], env: {} });
      expect(launchFor(path).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    }
  });

  it('extends the runtime to no other extension', () => {
    // A `.cmd`, `.bat` or `.ps1` shim would need the shell this application
    // refuses to use. It is handed back unchanged rather than quietly
    // reinterpreted as something the runtime could execute.
    for (const path of [
      'C:\\tools\\claude.cmd',
      'C:\\tools\\claude.bat',
      'C:\\tools\\claude.ps1',
      '/usr/local/bin/claude.sh',
      '/usr/local/bin/claude.py'
    ]) {
      expect(launchFor(path)).toEqual({ file: path, prefixArgs: [], env: {} });
    }
  });

  it('puts the tool arguments after the prefix, unchanged, at the real boundary', async () => {
    const tree = worktree((path) => ({
      actions: [
        { event: claudeStream.init(path) },
        { event: claudeStream.result({ text: 'ok', numTurns: 1 }) }
      ]
    }));
    const runner = new ObservingRunner();
    const { context } = recordingContext();

    await fakeClaudeAdapter({}, runner).run(fakeClaudeRequest(tree, { maxTurns: 5 }), context);

    const start = runner.starts[0];
    expect(start?.file).toBe(process.execPath);
    expect(start?.args[0]).toBe(FAKE_CLAUDE_CLI);
    // Everything after the prefix is the tool's own argv, exactly as the child
    // reports having received it.
    expect(start?.args.slice(1)).toEqual(tree.invocation().argv);
  });
});

/* -------------------------------------------------------------------------- */
/* 20. Diagnostics through the same launch                                     */
/* -------------------------------------------------------------------------- */

describe('diagnose', () => {
  it('runs the configured entry point with exactly --version', async () => {
    const tree = worktree(() => ({
      actions: [{ stdout: 'fake-claude 9.9.9 (contract fixture)\n' }],
      exit: 0
    }));

    // `diagnose()` sets no working directory, so the fixture is met on the
    // process's own — which is what the scenario file has to sit in.
    const previous = process.cwd();
    process.chdir(tree.path);
    try {
      const startedAt = Date.now();
      const diagnostic = await fakeClaudeAdapter().diagnose();

      // The fixture reads stdin to EOF like any CLI would, and is given no
      // prompt. It gets there at once only because `run()` closed the child's
      // stdin; inheriting the parent's used to sit here for the full 30-second
      // diagnostics timeout before failing with nothing to show for it.
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      expect(diagnostic.tool).toBe('claude');
      expect(diagnostic.status).toBe('ok');
      expect(diagnostic.version).toBe('fake-claude 9.9.9 (contract fixture)');
      // The fixture, resolved from the configured path — not from PATH, and not
      // from any Claude Code this machine may have installed.
      expect(diagnostic.executablePath).toBe(FAKE_CLAUDE_CLI);
      expect(tree.invocation().argv).toEqual(['--version']);
      // Read to EOF, and empty: a probe carries no prompt.
      expect(tree.invocation().stdin).toBe('');
      expect(tree.invocation().stdinBytes).toBe(0);
    } finally {
      process.chdir(previous);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 21. stdin on a one-shot run                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A child that reads stdin to the end before doing anything, then says how much
 * it got. Plenty of real CLIs behave this way even when they expect nothing —
 * which is what makes "does the child's stdin ever end?" a contract question
 * rather than a curiosity.
 */
const STDIN_PROBE = String.raw`
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  process.stderr.write("probe: reached EOF\n");
  process.stdout.write("STDIN-EOF " + Buffer.byteLength(data, "utf8") + "\n");
  process.stdout.write(JSON.stringify(data) + "\n");
  process.exit(0);
});
`;

describe('stdin on a one-shot run', () => {
  const runner = new ExecaProcessRunner();

  it('gives a buffered run with no input an immediate EOF', async () => {
    const startedAt = Date.now();
    const result = await runner.run(process.execPath, ['-e', STDIN_PROBE], {
      timeoutMs: 20_000
    });

    // The child only prints after its stdin has ended, so getting here at all
    // is the proof. Finishing in well under the timeout is the proof that the
    // end came immediately rather than from the run being torn down.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('STDIN-EOF 0');
    expect(JSON.parse(lines[1] ?? '""')).toBe('');
  });

  it('gives a streaming run with no input the same immediate EOF', async () => {
    const lines: string[] = [];
    const diagnostics: string[] = [];

    const startedAt = Date.now();
    const result = await runner.run(process.execPath, ['-e', STDIN_PROBE], {
      timeoutMs: 20_000,
      onLine: (line) => lines.push(line),
      onStderrLine: (line) => diagnostics.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    // The marker arrived on stdout and nowhere else; the streams stayed apart.
    expect(lines[0]).toBe('STDIN-EOF 0');
    expect(lines.join(' ')).not.toContain('reached EOF');
    expect(diagnostics).toEqual(['probe: reached EOF']);
    expect(result.stderr).toContain('reached EOF');
    expect(result.stdout).not.toContain('reached EOF');
  });

  it('writes the whole input, then ends stdin', async () => {
    // Multi-line, multi-byte, and full of characters a shell would act on.
    const input = [
      'Ünicode ✓ 中文 — first line',
      'second; echo chained && whoami',
      '"double" and \'single\' quotes',
      'trailing tab\tand spaces   ',
      ''
    ].join('\n');

    const startedAt = Date.now();
    const result = await runner.run(process.execPath, ['-e', STDIN_PROBE], {
      timeoutMs: 20_000,
      input
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const lines = result.stdout.split('\n');
    // The byte count is the child's own, measured after the read completed.
    expect(lines[0]).toBe(`STDIN-EOF ${Buffer.byteLength(input, 'utf8')}`);
    expect(JSON.parse(lines[1] ?? '""')).toBe(input);

    // And it travelled on stdin alone: the label that gets logged is argv only.
    expect(result.command).not.toContain('whoami');
    expect(result.command).not.toContain('中文');
  });
});
