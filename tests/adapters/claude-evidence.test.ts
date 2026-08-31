/**
 * Evidence collected from Claude Code's stream.
 *
 * In `--print` mode a refused tool call is silent: the model works around it,
 * the CLI still exits 0, and the result envelope still says "success". The only
 * way to tell a round in which the tests ran from one in which they were
 * blocked is to record what was attempted and what came back.
 *
 * These tests pin that record down. They are deliberately paranoid about the
 * two ways it could lie: attributing a result to the wrong call, and inferring
 * an outcome the stream never stated.
 *
 * Nothing here changes whether a round passes. A denial fails the round today
 * and must keep failing it — asserted at the bottom of this file.
 */

import { describe, expect, it } from 'vitest';
import {
  consumeLine,
  createStreamState,
  finalizeState,
  type StreamState
} from '../../src/main/adapters/claude/stream-parser';

/** Feed newline-delimited JSON through the parser the way the adapter does. */
function feed(lines: readonly unknown[]): StreamState {
  const state = createStreamState();
  for (const line of lines) {
    consumeLine(typeof line === 'string' ? line : JSON.stringify(line), state);
  }
  return state;
}

const toolUse = (id: string | null, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', ...(id === null ? {} : { id }), name, input }]
  }
});

const toolResult = (id: string | null, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        ...(id === null ? {} : { tool_use_id: id }),
        content: 'output text',
        ...extra
      }
    ]
  }
});

const resultEnvelope = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  result: 'done',
  ...extra
});

/* -------------------------------------------------------------------------- */
/* Correlation by tool_use id                                                  */
/* -------------------------------------------------------------------------- */

describe('tool call correlation', () => {
  it('matches a result to the call that precedes it', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1')])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseId: 't1',
      tool: 'Bash',
      command: 'npm test',
      resultReceived: true
    });
  });

  it('matches a result that arrives before its call', () => {
    // The CLI interleaves messages; a result can be flushed ahead of the call it
    // belongs to. Dropping it would understate what actually ran.
    const { evidence } = finalizeState(
      feed([toolResult('t1', { is_error: false }), toolUse('t1', 'Bash', { command: 'npm test' })])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseId: 't1',
      tool: 'Bash',
      command: 'npm test',
      resultReceived: true,
      isError: false
    });
  });

  it('does not count a re-delivered tool use twice', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1')
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
  });

  it('keeps the first outcome when a result is re-delivered', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: true }),
        toolResult('t1')
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]?.isError).toBe(true);
  });

  it('keeps two calls of the same command apart', () => {
    // Identity is the id, never the command. A retry of a failing command must
    // not be folded into the attempt that failed.
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: true }),
        toolUse('t2', 'Bash', { command: 'npm test' }),
        toolResult('t2', { is_error: false })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(2);
    expect(evidence.toolExecutions.map((entry) => entry.isError)).toEqual([true, false]);
  });

  it('never matches on a missing id', () => {
    // Two unidentified entries look alike, and pairing them would invent a fact.
    const { evidence } = finalizeState(
      feed([toolUse(null, 'Bash', { command: 'npm test' }), toolResult(null, { is_error: true })])
    );

    expect(evidence.toolExecutions).toHaveLength(2);
    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseId: null,
      command: 'npm test',
      resultReceived: false
    });
    expect(evidence.toolExecutions[1]).toMatchObject({ toolUseId: null, resultReceived: true });
  });

  it('keeps a result whose call never arrived', () => {
    const { evidence } = finalizeState(feed([toolResult('orphan', { is_error: true })]));

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseId: 'orphan',
      toolUseSeen: false,
      resultReceived: true,
      isError: true,
      command: null
    });
    // It was never seen as a call, so it is not an unfinished one.
    expect(evidence.incompleteToolUseCount).toBe(0);
    expect(evidence.orphanToolResultCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Outcome flags                                                               */
/* -------------------------------------------------------------------------- */

describe('tool result outcomes', () => {
  it('records an explicit failure', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1', { is_error: true })])
    );

    expect(evidence.toolExecutions[0]?.isError).toBe(true);
  });

  it('records an explicit success', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1', { is_error: false })])
    );

    expect(evidence.toolExecutions[0]?.isError).toBe(false);
  });

  it('leaves the outcome unknown when the stream does not state it', () => {
    // Absent is not success. Treating it as success is how a round with no
    // evidence of a passing test suite would read as a clean one.
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1')])
    );

    expect(evidence.toolExecutions[0]?.resultReceived).toBe(true);
    expect(evidence.toolExecutions[0]?.isError).toBeNull();
  });

  it('does not read failure out of the output text', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'Error: 0 failing\nPermission denied (in the fixture output)'
              }
            ]
          }
        }
      ])
    );

    expect(evidence.toolExecutions[0]?.isError).toBeNull();
  });

  it('leaves an unfinished call visible', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolUse('t2', 'Read', { file_path: 'src/app.ts' }),
        toolResult('t2')
      ])
    );

    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseId: 't1',
      resultReceived: false,
      isError: null
    });
    expect(evidence.incompleteToolUseCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Denials                                                                     */
/* -------------------------------------------------------------------------- */

describe('permission denials', () => {
  it('takes the command from the denial event itself', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          tool_input: { command: 'npm test' },
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      tool: 'Bash',
      toolUseId: 't1',
      command: 'npm test',
      source: 'stream'
    });
  });

  it('recovers the command from the call the denial names', () => {
    const { denials } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test -- --watch=false' }),
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials[0]?.command).toBe('npm test -- --watch=false');
  });

  it('reports no command rather than guessing one from the reason', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          decision_reason: 'Claude requested permission to run `npm test`'
        }
      ])
    );

    expect(denials[0]?.command).toBeNull();
    expect(denials[0]?.reason).toContain('npm test');
  });

  it('marks a denial that only the result envelope reported', () => {
    const { denials } = finalizeState(
      feed([
        resultEnvelope({
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'npm test' } }
          ]
        })
      ])
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ source: 'result', command: 'npm test', toolUseId: 't9' });
  });

  it('still reports one denial when both the event and the envelope carry it', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          tool_input: { command: 'npm test' },
          decision_reason: 'requires approval'
        },
        resultEnvelope({
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }]
        })
      ])
    );

    expect(denials).toHaveLength(1);
    // Still one denial, but the record remembers that both halves reported it.
    expect(denials[0]?.source).toBe('both');
    expect(denials[0]?.command).toBe('npm test');
  });
});

/* -------------------------------------------------------------------------- */
/* Stream completeness                                                         */
/* -------------------------------------------------------------------------- */

describe('stream completeness', () => {
  it('reports a stream that ended without a result envelope', () => {
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command: 'npm test' })]));

    expect(evidence.resultEnvelopeSeen).toBe(false);
  });

  it('reports a stream that carried one', () => {
    const { evidence } = finalizeState(feed([resultEnvelope()]));

    expect(evidence.resultEnvelopeSeen).toBe(true);
  });

  it('counts lines it could not read', () => {
    const { evidence } = finalizeState(
      feed(['npm warn: something', '{not json at all', '   ', resultEnvelope()])
    );

    // The blank line is not a line the CLI tried to say anything with.
    expect(evidence.malformedLineCount).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction and volume                                                        */
/* -------------------------------------------------------------------------- */

describe('what the evidence is allowed to hold', () => {
  // Synthetic, shaped like the real thing so the patterns fire. Never a live key.
  const FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

  it('redacts a secret in a recorded command', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: `gh auth login --with-token ${FAKE_TOKEN}` })])
    );

    const [execution] = evidence.toolExecutions;
    expect(execution?.command).not.toContain(FAKE_TOKEN);
    expect(execution?.command).toContain('[redacted]');
    expect(execution?.summary).not.toContain(FAKE_TOKEN);
  });

  it('redacts a secret in a denial reason and command', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_input: { command: `curl -H "Authorization: Bearer ${FAKE_TOKEN}" https://x` },
          decision_reason: `blocked: GITHUB_TOKEN=${FAKE_TOKEN}`
        }
      ])
    );

    expect(denials[0]?.reason).not.toContain(FAKE_TOKEN);
    expect(denials[0]?.command).not.toContain(FAKE_TOKEN);
  });

  it('keeps tool output out of the evidence', () => {
    const secretish = 'line after line of build output that belongs on the timeline only';
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { content: secretish, is_error: false })
      ])
    );

    expect(JSON.stringify(evidence)).not.toContain(secretish);
  });

  it('bounds a very long command', () => {
    const command = 'echo ' + 'x'.repeat(5000);
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    expect(evidence.toolExecutions[0]?.command?.length).toBeLessThanOrEqual(520);
  });
});

/* -------------------------------------------------------------------------- */
/* The invariant this phase must not move                                      */
/* -------------------------------------------------------------------------- */

describe('fail-closed behaviour is unchanged', () => {
  it('fails the round on a denial the envelope calls a success', () => {
    const finalized = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          tool_input: { command: 'npm test' },
          decision_reason: 'requires approval'
        },
        resultEnvelope()
      ])
    );

    expect(finalized.isError).toBe(true);
  });

  it('fails the round on a denial even with no result envelope', () => {
    const finalized = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(finalized.isError).toBe(true);
  });

  it('leaves a clean round passing, whatever the evidence says', () => {
    // Incomplete telemetry is not a verdict. Only this phase's existing rules
    // decide the outcome, so a stream with gaps still succeeds.
    const finalized = finalizeState(
      feed([
        'a line that is not json',
        toolUse('t1', 'Bash', { command: 'npm test' }),
        resultEnvelope()
      ])
    );

    expect(finalized.isError).toBe(false);
    expect(finalized.evidence.malformedLineCount).toBe(1);
    expect(finalized.evidence.incompleteToolUseCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The three shapes a record can have                                          */
/* -------------------------------------------------------------------------- */

describe('tool execution shape', () => {
  it('marks a completed call', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1')])
    );

    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseSeen: true,
      resultReceived: true
    });
    expect(evidence.incompleteToolUseCount).toBe(0);
    expect(evidence.orphanToolResultCount).toBe(0);
  });

  it('marks a call still waiting for its result', () => {
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command: 'npm test' })]));

    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseSeen: true,
      resultReceived: false
    });
    expect(evidence.incompleteToolUseCount).toBe(1);
    expect(evidence.orphanToolResultCount).toBe(0);
  });

  it('marks a result that belongs to no call', () => {
    const { evidence } = finalizeState(feed([toolResult('t1')]));

    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseSeen: false,
      resultReceived: true
    });
    expect(evidence.incompleteToolUseCount).toBe(0);
    expect(evidence.orphanToolResultCount).toBe(1);
  });

  it('counts the three shapes independently in one stream', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('done', 'Bash', { command: 'npm test' }),
        toolResult('done'),
        toolUse('open', 'Bash', { command: 'npm run build' }),
        toolResult('stray')
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(3);
    expect(evidence.incompleteToolUseCount).toBe(1);
    expect(evidence.orphanToolResultCount).toBe(1);
  });

  it('stops calling an entry an orphan once its call arrives', () => {
    const { evidence } = finalizeState(
      feed([toolResult('t1'), toolUse('t1', 'Bash', { command: 'npm test' })])
    );

    expect(evidence.toolExecutions[0]).toMatchObject({
      toolUseSeen: true,
      resultReceived: true,
      command: 'npm test'
    });
    expect(evidence.orphanToolResultCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Anonymous entries                                                           */
/* -------------------------------------------------------------------------- */

describe('entries the CLI gave no id', () => {
  it('keeps two anonymous calls apart', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse(null, 'Bash', { command: 'npm test' }),
        toolUse(null, 'Bash', { command: 'npm run build' })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(2);
    expect(evidence.toolExecutions.map((entry) => entry.command)).toEqual([
      'npm test',
      'npm run build'
    ]);
    expect(evidence.incompleteToolUseCount).toBe(2);
  });

  it('never attaches an anonymous result to an anonymous call', () => {
    const { evidence } = finalizeState(
      feed([toolUse(null, 'Bash', { command: 'npm test' }), toolResult(null, { is_error: false })])
    );

    expect(evidence.toolExecutions).toHaveLength(2);
    // The call is still open, and the result is still unattributable.
    expect(evidence.incompleteToolUseCount).toBe(1);
    expect(evidence.orphanToolResultCount).toBe(1);
  });

  it('does not let an anonymous entry absorb an identified one', () => {
    const { evidence } = finalizeState(
      feed([toolResult(null, { is_error: true }), toolUse('t1', 'Bash', { command: 'npm test' })])
    );

    expect(evidence.toolExecutions).toHaveLength(2);
    expect(evidence.toolExecutions[1]).toMatchObject({
      toolUseId: 't1',
      toolUseSeen: true,
      resultReceived: false
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Contradictory results                                                       */
/* -------------------------------------------------------------------------- */

describe('repeated results for one call', () => {
  it('fills in an outcome the first result withheld', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1'),
        toolResult('t1', { is_error: true })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({ isError: true, resultConflict: false });
  });

  it('treats the same answer twice as one answer', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: false }),
        toolResult('t1', { is_error: false })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({ isError: false, resultConflict: false });
  });

  it('does not let a later silent result erase a stated outcome', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: true }),
        toolResult('t1')
      ])
    );

    expect(evidence.toolExecutions[0]).toMatchObject({ isError: true, resultConflict: false });
  });

  it('flags two results that contradict each other', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: false }),
        toolResult('t1', { is_error: true })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    // Back to "unknown", so a caller that never reads the flag still cannot
    // mistake the contradiction for a pass.
    expect(evidence.toolExecutions[0]).toMatchObject({ isError: null, resultConflict: true });
  });

  it('flags the contradiction in either order', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: true }),
        toolResult('t1', { is_error: false })
      ])
    );

    expect(evidence.toolExecutions[0]).toMatchObject({ isError: null, resultConflict: true });
  });

  it('does not let a third result settle a contradiction', () => {
    const { evidence } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'npm test' }),
        toolResult('t1', { is_error: true }),
        toolResult('t1', { is_error: false }),
        toolResult('t1', { is_error: false })
      ])
    );

    expect(evidence.toolExecutions).toHaveLength(1);
    expect(evidence.toolExecutions[0]).toMatchObject({ isError: null, resultConflict: true });
  });

  it('leaves an uncontradicted call unflagged', () => {
    const { evidence } = finalizeState(
      feed([toolUse('t1', 'Bash', { command: 'npm test' }), toolResult('t1', { is_error: true })])
    );

    expect(evidence.toolExecutions[0]?.resultConflict).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Truncation is never silent                                                  */
/* -------------------------------------------------------------------------- */

describe('command truncation', () => {
  it('does not call a missing command truncated', () => {
    const { evidence } = finalizeState(feed([toolUse('t1', 'Read', { file_path: 'src/app.ts' })]));

    expect(evidence.toolExecutions[0]).toMatchObject({
      command: null,
      commandTruncated: false
    });
  });

  it('keeps a command that fits, whole', () => {
    const command = 'npm test -- --reporter=dot';
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    expect(evidence.toolExecutions[0]).toMatchObject({ command, commandTruncated: false });
  });

  it('says so when a command was cut', () => {
    const command = 'npm test -- ' + 'x'.repeat(2000);
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    const [execution] = evidence.toolExecutions;
    expect(execution?.commandTruncated).toBe(true);
    expect(execution?.command?.startsWith('npm test -- ')).toBe(true);
    // The full text is kept nowhere, which is what makes the flag load-bearing.
    expect(JSON.stringify(evidence)).not.toContain(command);
  });

  it('carries the flag onto a denial', () => {
    const command = 'npm test -- ' + 'y'.repeat(2000);
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_input: { command },
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials[0]?.commandTruncated).toBe(true);
    expect(JSON.stringify(denials)).not.toContain(command);
  });

  it('leaves a denial with no command unflagged', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials[0]).toMatchObject({ command: null, commandTruncated: false });
  });

  it('inherits the flag from the call a denial names', () => {
    const command = 'npm test -- ' + 'z'.repeat(2000);
    const { denials } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command }),
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials[0]?.commandTruncated).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* One denial, two reports                                                     */
/* -------------------------------------------------------------------------- */

describe('a denial reported twice', () => {
  const streamDenial = (extra = {}) => ({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 't1',
    decision_reason: 'requires approval',
    ...extra
  });

  it('records both sources without duplicating the denial', () => {
    const { denials } = finalizeState(
      feed([
        streamDenial({ tool_input: { command: 'npm test' } }),
        resultEnvelope({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] })
      ])
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]?.source).toBe('both');
  });

  it('takes the command from whichever source had one', () => {
    const { denials } = finalizeState(
      feed([
        streamDenial(),
        resultEnvelope({
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }
          ]
        })
      ])
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ source: 'both', command: 'npm test' });
  });

  it('does not overwrite a command the first report already had', () => {
    const { denials } = finalizeState(
      feed([
        streamDenial({ tool_input: { command: 'npm test' } }),
        resultEnvelope({
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'something else' } }
          ]
        })
      ])
    );

    expect(denials[0]?.command).toBe('npm test');
  });

  it('leaves a single-source denial saying so', () => {
    const { denials } = finalizeState(feed([streamDenial(), resultEnvelope()]));

    expect(denials[0]?.source).toBe('stream');
  });

  it('keeps two genuinely different denials apart', () => {
    const { denials } = finalizeState(
      feed([
        streamDenial(),
        streamDenial({ tool_use_id: 't2', tool_name: 'PowerShell' }),
        resultEnvelope()
      ])
    );

    expect(denials).toHaveLength(2);
    expect(denials.map((denial) => denial.source)).toEqual(['stream', 'stream']);
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction survives the length budget                                        */
/* -------------------------------------------------------------------------- */

describe('secrets and the truncation boundary', () => {
  // Synthetic, shaped like the real thing so the patterns fire, and assembled
  // from pieces so no token-shaped literal exists in this file.
  const FAKE_TOKEN = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';

  it('redacts a secret that sits before the cut', () => {
    const command = 'gh auth login --with-token ' + FAKE_TOKEN;
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    const [execution] = evidence.toolExecutions;
    expect(execution?.command).toContain('[redacted]');
    expect(execution?.command).not.toContain(FAKE_TOKEN);
    expect(execution?.commandTruncated).toBe(false);
  });

  it('keeps a secret past the cut out of the evidence entirely', () => {
    // Redaction runs before truncation, so a token beyond the budget is already
    // gone rather than being sliced into a fragment the patterns would miss.
    const command = 'echo ' + 'p'.repeat(900) + ' && gh auth login --with-token ' + FAKE_TOKEN;
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).not.toContain(FAKE_TOKEN.slice(0, 20));
    expect(evidence.toolExecutions[0]?.commandTruncated).toBe(true);
  });

  it('keeps a secret out of the summary as well as the command', () => {
    const command = 'gh auth login --with-token ' + FAKE_TOKEN + ' ' + 'q'.repeat(400);
    const { evidence } = finalizeState(feed([toolUse('t1', 'Bash', { command })]));

    expect(evidence.toolExecutions[0]?.summary).not.toContain(FAKE_TOKEN);
    expect(evidence.toolExecutions[0]?.summary).not.toContain(FAKE_TOKEN.slice(0, 20));
  });

  it('redacts a denial that only the result envelope reported', () => {
    const { denials } = finalizeState(
      feed([
        resultEnvelope({
          permission_denials: [
            {
              tool_name: 'Bash',
              tool_use_id: 't1',
              tool_input: { command: 'curl -H "Authorization: Bearer ' + FAKE_TOKEN + '" https://x' },
              decision_reason: 'blocked while GITHUB_TOKEN=' + FAKE_TOKEN + ' was set'
            }
          ]
        })
      ])
    );

    expect(denials[0]?.source).toBe('result');
    expect(denials[0]?.reason).not.toContain(FAKE_TOKEN);
    expect(denials[0]?.command).not.toContain(FAKE_TOKEN);
  });

  it('redacts a command the envelope contributed to an existing denial', () => {
    const { denials } = finalizeState(
      feed([
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          decision_reason: 'requires approval'
        },
        resultEnvelope({
          permission_denials: [
            {
              tool_name: 'Bash',
              tool_use_id: 't1',
              tool_input: { command: 'gh auth login --with-token ' + FAKE_TOKEN }
            }
          ]
        })
      ])
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]?.source).toBe('both');
    expect(denials[0]?.command).toContain('[redacted]');
    expect(denials[0]?.command).not.toContain(FAKE_TOKEN);
  });

  it('redacts a command a denial borrowed from an earlier call', () => {
    const { denials } = finalizeState(
      feed([
        toolUse('t1', 'Bash', { command: 'gh auth login --with-token ' + FAKE_TOKEN }),
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't1',
          decision_reason: 'requires approval'
        }
      ])
    );

    expect(denials[0]?.command).not.toContain(FAKE_TOKEN);
  });
});
