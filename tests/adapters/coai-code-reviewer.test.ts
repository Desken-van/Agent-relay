/**
 * The Coai code-review adapter: which tools it may call, and what it refuses.
 *
 * A fake transport, deliberately. What is under test is the ADAPTER's contract —
 * that `beginRound` reserves and never dispatches, that a round is addressed by
 * its locator and never described by its subject, and that every uncertain
 * answer becomes `unknown` rather than a licence to run again. A real process
 * would make the ordering non-deterministic while proving none of that; the
 * process boundary is exercised separately, against a real fake server.
 */

import { describe, expect, it } from 'vitest';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { CoaiCodeReviewer } from '../../src/main/adapters/mcp/coai-code-reviewer';
import { McpToolProfileMismatchError } from '../../src/main/adapters/mcp/stdio-mcp-client';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_ADDRESSABLE_TOOLS,
  COAI_PLAN_PROFILE,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import type {
  ExternalCodeReviewSubject,
  ExternalCodeRoundLocator,
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpTool
} from '../../src/main/ports';

const config: ExternalMcpServerConfig = {
  id: 'coai-code-review',
  enabled: true,
  executablePath: 'C:\\tools\\coai-mcp.exe',
  args: ['--stdio'],
  allowedTools: COAI_ADDRESSABLE_PROFILE,
  timeoutMs: 30_000,
  maxMessageBytes: 100_000,
  maxContentBytes: 100_000,
  maxContentBlocks: 4
};

const subject: ExternalCodeReviewSubject = {
  worktreePath: 'C:\\work\\task-1',
  branch: 'agent/task-1',
  baseRef: 'main',
  headCommit: 'a'.repeat(40),
  subjectSha256: 'b'.repeat(64)
};

const locator: ExternalCodeRoundLocator = {
  providerId: COAI_PROVIDER_ID,
  sessionId: 'session-1',
  roundId: 'round-1'
};

function tool(name: string): ExternalMcpTool {
  return {
    name,
    title: null,
    description: null,
    inputSchema: { type: 'object' },
    annotations: { readOnly: null, destructive: null, idempotent: null, openWorld: null }
  };
}

class FakeMcpClient implements ExternalMcpClient {
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
  responses: ExternalMcpCallResult[] = [];
  /** What `tools/list` reports. The ten-tool profile unless a test says otherwise. */
  tools: readonly string[] = COAI_ADDRESSABLE_PROFILE;
  discoveryError: Error | null = null;
  callError: Error | null = null;

  async discover(): Promise<ExternalMcpDiscovery> {
    if (this.discoveryError) throw this.discoveryError;

    return {
      server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' },
      tools: this.tools.map(tool)
    };
  }

  async call(
    _config: ExternalMcpServerConfig,
    name: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<ExternalMcpCallResult> {
    this.calls.push({ tool: name, args });
    if (this.callError) throw this.callError;
    const response = this.responses.shift();
    if (!response) throw new Error('no fake response');

    return response;
  }

  get toolsCalled(): string[] {
    return this.calls.map((call) => call.tool);
  }
}

function result(
  name: string,
  value: unknown,
  overrides: Partial<ExternalMcpCallResult> = {}
): ExternalMcpCallResult {
  return {
    server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' },
    tool: tool(name),
    isError: false,
    content: [JSON.stringify(value)],
    ...overrides
  };
}

/** A reservation that attests the subject it was asked about. */
const reservation = {
  locator,
  attestation: {
    repoIdentity: 'c:/work/task-1/.git',
    baseRef: subject.baseRef,
    baseSha: 'c'.repeat(40),
    headSha: subject.headCommit,
    treeSha: 'd'.repeat(40),
    subjectHash: subject.subjectSha256
  },
  state: 'not_started',
  alreadyReserved: false,
  instruction: 'store this locator before calling run_round'
};

/** The same reservation with one field of the attestation moved. */
function attesting(overrides: Record<string, unknown>) {
  return { ...reservation, attestation: { ...reservation.attestation, ...overrides } };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'major',
    category: 'reliability',
    gating: true,
    title: 'the retry is ambiguous',
    body: 'a lost response may repeat work',
    fix: 'persist the intent before calling out',
    file: 'src/service.ts',
    line: 42,
    provider: 'codex',
    role: 'SecurityReliability',
    ...overrides
  };
}

function completed(overrides: Record<string, unknown> = {}) {
  return {
    locator,
    reviewedSubjectSha256: subject.subjectSha256,
    verdict: 'revise',
    gatingCount: 1,
    threshold: 0,
    reviewers: 'all 3 reviewers answered',
    findings: [finding()],
    instruction: 'resolve every finding',
    tokensIn: 100,
    tokensOut: 20,
    ...overrides
  };
}

describe('the Coai code reviewer adapter', () => {
  // ---------- the capability boundary ----------

  it('refuses to be built on anything but the exact addressable profile', () => {
    expect(() => new CoaiCodeReviewer(new FakeMcpClient(), config)).not.toThrow();

    // The legacy server. It has `review_code`, and that is exactly the tool this
    // adapter must never fall back to.
    expect(
      () => new CoaiCodeReviewer(new FakeMcpClient(), { ...config, allowedTools: COAI_PLAN_PROFILE })
    ).toThrow(/ten-tool profile/i);
    expect(
      () =>
        new CoaiCodeReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_ADDRESSABLE_PROFILE, 'something_new']
        })
    ).toThrow(/ten-tool profile/i);
    expect(
      () =>
        new CoaiCodeReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_ADDRESSABLE_PROFILE.slice(0, 9), 'run_round']
        })
    ).toThrow(/ten-tool profile/i);
  });

  it('never claims to read uncommitted work, and files rounds under one identity', () => {
    const reviewer = new CoaiCodeReviewer(new FakeMcpClient(), config);

    // The provider reviews a commit in a worktree it pins to a SHA. Saying so is
    // what makes a dirty subject a refusal instead of a verdict about other code.
    expect(reviewer.readsUncommittedWorktreeState).toBe(false);
    expect(reviewer.providerId).toBe(COAI_PROVIDER_ID);
  });

  // ---------- availability is read-only ----------

  it('answers availability from discovery alone, calling no tool', async () => {
    const client = new FakeMcpClient();

    await expect(new CoaiCodeReviewer(client, config).availability()).resolves.toEqual({
      available: true,
      reason: null
    });
    expect(client.toolsCalled).toEqual([]);
  });

  it('reports the legacy server as unsupported, naming what is missing', async () => {
    const client = new FakeMcpClient();
    client.tools = COAI_PLAN_PROFILE;

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/addressable code review is not supported/i);
    expect(answer.reason).toMatch(/reserve_round/);
    expect(answer.reason).toMatch(/run_round/);
    expect(answer.reason).toMatch(/round_status/);
    // Read-only to the last: an unavailable provider is discovered, never probed.
    expect(client.toolsCalled).toEqual([]);
  });

  it('repeats nothing from a failed spawn, not even through details', async () => {
    // The transport puts a failed process's raw STDERR into `details`. An
    // earlier version of this adapter appended that field to the reason for any
    // discovery failure, so a spawn failure carried the executable, the argv and
    // whatever the server printed into a stored, operator-visible string.
    // Redaction hides credential shapes; it does not hide a path.
    const client = new FakeMcpClient();
    client.discoveryError = new AgentRelayError(
      'TOOL_FAILED',
      'The MCP server process ended before the request completed.',
      {
        details:
          'C:\\Program Files\\coai\\coai-mcp.exe --stdio --data-dir C:\\Users\\someone\\AppData\\coai\n' +
          'panic: cannot open D:\\secrets\\vault.json\n' +
          'GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0'
      }
    );

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    for (const leak of [
      'C:\\Program Files',
      'coai-mcp.exe',
      '--stdio',
      '--data-dir',
      'AppData',
      'D:\\secrets',
      'vault.json',
      'ghp_A1b2C3d4E5f6G7h8I9j0',
      'GH_TOKEN'
    ]) {
      expect(answer.reason, leak).not.toContain(leak);
    }
    // What it DOES say: that discovery failed, and the closed-set code — enough
    // to look the detail up in the log, which is where it belongs.
    expect(answer.reason).toMatch(/could not be discovered/i);
    expect(answer.reason).toContain('TOOL_FAILED');
    expect(answer.reason!.length).toBeLessThanOrEqual(2_100);
  });

  it('repeats nothing from a plain error either', async () => {
    const client = new FakeMcpClient();
    client.discoveryError = new Error(
      'ENOENT: no such file or directory, spawn C:\\tools\\coai\\coai-mcp.exe'
    );

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    expect(answer.reason).not.toContain('C:\\tools');
    expect(answer.reason).not.toContain('coai-mcp.exe');
    expect(answer.reason).not.toContain('ENOENT');
    expect(answer.reason).toMatch(/could not be discovered/i);
  });

  it('names the missing tools from its OWN constant, never from the server', async () => {
    // The mismatch is recognised by type. The names come from
    // COAI_ADDRESSABLE_TOOLS; nothing the server sent is echoed, so a server
    // that advertised a tool called `C:\\evil\\path` could not put it here.
    const client = new FakeMcpClient();
    client.discoveryError = new McpToolProfileMismatchError(
      'VALIDATION_FAILED',
      'The MCP server tool list does not match the configured allowlist.',
      { missing: [...COAI_ADDRESSABLE_TOOLS], unexpectedCount: 1, duplicated: false }
    );

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    for (const name of COAI_ADDRESSABLE_TOOLS) expect(answer.reason).toContain(name);
    expect(answer.reason).toMatch(/does not advertise the audited profile/i);
  });

  // ---------- beginRound reserves and nothing else ----------

  it('reserves with the caller\u2019s durable token and dispatches nothing', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('reserve_round', reservation));

    const got = await new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7');

    expect(got).toEqual(locator);
    // ONE tool, and it is the one that spends nothing.
    expect(client.toolsCalled).toEqual(['reserve_round']);
    expect(client.calls[0]!.args).toEqual({
      repoPath: subject.worktreePath,
      branch: subject.branch,
      baseRef: subject.baseRef,
      subjectSha256: subject.subjectSha256,
      clientToken: 'local-round-7'
    });
  });

  it('sends the same token for one local round and different tokens for two', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('reserve_round', reservation));
    client.responses.push(result('reserve_round', reservation));
    client.responses.push(
      result('reserve_round', { ...reservation, locator: { ...locator, roundId: 'round-2' } })
    );
    const reviewer = new CoaiCodeReviewer(client, config);

    // The same local round, reserved twice — a retry after a lost answer.
    await reviewer.beginRound(subject, 'local-round-7');
    await reviewer.beginRound(subject, 'local-round-7');
    // A SECOND local round over the same subject. Everything a subject hash can
    // express is identical; only the local round id differs.
    await reviewer.beginRound(subject, 'local-round-8');

    const tokens = client.calls.map((call) => call.args.clientToken);
    expect(tokens).toEqual(['local-round-7', 'local-round-7', 'local-round-8']);
    expect(client.toolsCalled).toEqual(['reserve_round', 'reserve_round', 'reserve_round']);
  });

  it('refuses a locator issued under another provider identity', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('reserve_round', {
        ...reservation,
        locator: { ...locator, providerId: 'somebody-else' }
      })
    );

    await expect(
      new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  // ---------- reviewCode runs exactly the reserved round ----------

  it('runs the stored locator once, and never falls back to review_code', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('run_round', completed()));

    const round = await new CoaiCodeReviewer(client, config).reviewCode(
      locator,
      subject,
      'the scope'
    );

    expect(client.toolsCalled).toEqual(['run_round']);
    expect(client.calls[0]!.args).toEqual({
      providerId: locator.providerId,
      sessionId: locator.sessionId,
      roundId: locator.roundId,
      planText: 'the scope'
    });
    // Everything the durable round records, carried through unchanged.
    expect(round.locator).toEqual(locator);
    expect(round.reviewedSubjectSha256).toBe(subject.subjectSha256);
    expect(round.verdict).toBe('revise');
    expect(round.gatingCount).toBe(1);
    expect(round.threshold).toBe(0);
    expect(round.reviewers).toBe('all 3 reviewers answered');
    expect(round.findings).toHaveLength(1);
    expect(round.findings[0]!.provider).toBe('codex');
    expect(round.serverName).toBe('coai-mcp');
    expect(round.serverVersion).toBe('0.19.0');
    expect(round.tokensIn).toBe(100);
  });

  it('records unreported usage as unknown rather than zero', async () => {
    const client = new FakeMcpClient();
    const { tokensIn: _in, tokensOut: _out, ...without } = completed();
    client.responses.push(result('run_round', without));

    const round = await new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope');

    expect(round.tokensIn).toBeNull();
    expect(round.tokensOut).toBeNull();
  });

  it('refuses an answer that echoes a different locator', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('run_round', completed({ locator: { ...locator, roundId: 'round-99' } }))
    );

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('refuses an answer with no attestation at all', async () => {
    const client = new FakeMcpClient();
    const { reviewedSubjectSha256: _gone, ...without } = completed();
    client.responses.push(result('run_round', without));

    // A reviewer that cannot say which snapshot it read has produced a verdict
    // about unnamed code. Defaulting the field to null here would move the
    // refusal out of sight rather than removing the danger.
    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('refuses a finding whose location escapes the repository', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('run_round', completed({ findings: [finding({ file: '../../etc/passwd' })] }))
    );

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('refuses credential-shaped reviewer prose instead of storing it', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result(
        'run_round',
        completed({
          findings: [
            finding({ body: 'the token ghp_A1b2C3d4E5f6G7h8I9j0 is committed in plain text' })
          ]
        })
      )
    );

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  // ---------- the four failure shapes stay apart ----------

  it('tells a tool error, a refusal, malformed output and a transport failure apart', async () => {
    const reviewer = () => new CoaiCodeReviewer(client, config);
    let client = new FakeMcpClient();

    // 1. MCP said the tool failed.
    client.responses.push(result('run_round', {}, { isError: true }));
    await expect(reviewer().reviewCode(locator, subject, 's')).rejects.toMatchObject({
      code: 'TOOL_FAILED'
    });

    // 2. The server refused, as DATA. Not a parse failure, and the sentence survives.
    client = new FakeMcpClient();
    client.responses.push(result('run_round', { error: 'no plan round reached proceed' }));
    await expect(reviewer().reviewCode(locator, subject, 's')).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: expect.stringContaining('no plan round reached proceed')
    });

    // 3. Output that is not JSON at all.
    client = new FakeMcpClient();
    client.responses.push(result('run_round', null, { content: ['{broken'] }));
    await expect(reviewer().reviewCode(locator, subject, 's')).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });

    // 4. More blocks than the one document the contract allows.
    client = new FakeMcpClient();
    client.responses.push(result('run_round', completed(), { content: ['{}', '{}'] }));
    await expect(reviewer().reviewCode(locator, subject, 's')).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });

    // 5. The process itself failed — a timeout, a spawn error, a killed child.
    client = new FakeMcpClient();
    client.callError = new Error('the MCP call timed out');
    await expect(reviewer().reviewCode(locator, subject, 's')).rejects.toThrow(/timed out/);
  });

  it('refuses an oversized finding list rather than truncating it', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('run_round', completed({ findings: Array.from({ length: 513 }, () => finding()) }))
    );

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  // ---------- roundStatus reads, and never guesses ----------

  it('reads one locator back and starts nothing', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', {
        locator,
        state: 'completed',
        instruction: 'finished',
        review: completed()
      })
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    expect(client.toolsCalled).toEqual(['round_status']);
    expect(client.calls[0]!.args).toEqual({
      providerId: locator.providerId,
      sessionId: locator.sessionId,
      roundId: locator.roundId
    });
    expect(status.kind).toBe('completed');
    expect(status.kind === 'completed' && status.round.findings).toHaveLength(1);
    expect(status.kind === 'completed' && status.round.reviewedSubjectSha256).toBe(
      subject.subjectSha256
    );
  });

  it('maps running and not_started exactly as the provider states them', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('round_status', { locator, state: 'running', instruction: '' }));
    client.responses.push(
      result('round_status', { locator, state: 'not_started', instruction: 'reserved, never run' })
    );
    const reviewer = new CoaiCodeReviewer(client, config);

    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('running');
    // The one answer that says nothing was consumed, and it comes only from the
    // provider saying so about a round it holds.
    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('not_started');
  });

  it('never turns an uncertain answer into not_started', async () => {
    const cases: { name: string; arrange: (client: FakeMcpClient) => void }[] = [
      {
        name: 'the provider has no record',
        arrange: (client) =>
          void client.responses.push(
            result('round_status', { locator, state: 'unknown', instruction: 'no such round' })
          )
      },
      {
        name: 'the round was dispatched and ended without an answer',
        arrange: (client) =>
          void client.responses.push(
            result('round_status', { locator, state: 'failed', instruction: 'it is spent' })
          )
      },
      {
        name: 'completed with no result attached',
        arrange: (client) =>
          void client.responses.push(
            result('round_status', { locator, state: 'completed', instruction: 'done' })
          )
      },
      {
        name: 'the answer is about another round',
        arrange: (client) =>
          void client.responses.push(
            result('round_status', {
              locator: { ...locator, roundId: 'round-99' },
              state: 'completed',
              instruction: 'done',
              review: completed()
            })
          )
      },
      {
        name: 'the transport failed',
        arrange: (client) => {
          client.callError = new Error('the MCP call timed out');
        }
      },
      {
        name: 'the server refused as data',
        arrange: (client) =>
          void client.responses.push(result('round_status', { error: 'session is gone' }))
      },
      {
        name: 'the output will not parse',
        arrange: (client) =>
          void client.responses.push(result('round_status', null, { content: ['{broken'] }))
      }
    ];

    for (const { name, arrange } of cases) {
      const client = new FakeMcpClient();
      arrange(client);
      const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

      expect(status.kind, name).toBe('unknown');
      expect(status.kind === 'unknown' && status.reason, name).toBeTruthy();
    }
  });

  it('does not ask about a round that belongs to another provider', async () => {
    const client = new FakeMcpClient();

    const status = await new CoaiCodeReviewer(client, config).roundStatus(
      { ...locator, providerId: 'somebody-else' },
      subject
    );

    expect(status.kind).toBe('unknown');
    // Not even a call: this build cannot read another provider's namespace, and
    // asking would invite an answer it could not check.
    expect(client.toolsCalled).toEqual([]);
  });

  it('redacts and bounds whatever a failed read-back says', async () => {
    const client = new FakeMcpClient();
    client.callError = new Error(`api_key = "AKIA1234567890ABCDEF" ${'x'.repeat(9_000)}`);

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    expect(status.kind).toBe('unknown');
    const reason = status.kind === 'unknown' ? (status.reason ?? '') : '';
    expect(reason).not.toContain('AKIA1234567890ABCDEF');
    expect(reason.length).toBeLessThanOrEqual(2_100);
  });

  it('passes cancellation through to the transport', async () => {
    const controller = new AbortController();
    const client = new FakeMcpClient();
    client.callError = new Error('aborted');
    controller.abort();

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope', controller.signal)
    ).rejects.toThrow(/aborted/);
  });
});

describe('the reservation is checked before anything is dispatched', () => {
  it('refuses an attestation that describes another subject, and runs nothing', async () => {
    const cases: { field: string; reservation: unknown }[] = [
      { field: 'baseRef', reservation: attesting({ baseRef: 'release/2.0' }) },
      { field: 'headSha', reservation: attesting({ headSha: '9'.repeat(40) }) },
      { field: 'subjectHash', reservation: attesting({ subjectHash: '9'.repeat(64) }) }
    ];

    for (const { field, reservation: answer } of cases) {
      const client = new FakeMcpClient();
      client.responses.push(result('reserve_round', answer));

      await expect(
        new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7'),
        field
      ).rejects.toMatchObject({ code: 'PARSE_FAILED' });

      // The whole point of checking here: the reservation costs nothing, so a
      // disagreement is a refusal rather than a spent round.
      expect(client.toolsCalled, field).toEqual(['reserve_round']);
      expect(client.toolsCalled, field).not.toContain('run_round');
    }
  });

  it('refuses a reservation that is not a round which has yet to run', async () => {
    for (const state of ['running', 'completed', 'failed', 'unknown']) {
      const client = new FakeMcpClient();
      client.responses.push(result('reserve_round', { ...reservation, state }));

      await expect(
        new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7'),
        state
      ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
      // `running` and `completed` are emphatically not evidence that nothing
      // ran, and neither licenses a dispatch under this locator.
      expect(client.toolsCalled, state).toEqual(['reserve_round']);
    }
  });

  it('accepts a resumed reservation of the same subject', async () => {
    const client = new FakeMcpClient();
    // The caller lost the first answer and is retrying with the token it kept.
    // The provider hands back the round it already holds, and it still attests
    // this subject — which is exactly what makes the resume safe.
    client.responses.push(
      result('reserve_round', { ...reservation, alreadyReserved: true })
    );

    await expect(
      new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7')
    ).resolves.toEqual(locator);
  });

  it('refuses a resumed reservation held against other code', async () => {
    const client = new FakeMcpClient();
    // The same token, and a round the provider reserved for a different
    // snapshot. This is the case the echoed subject hash exists to catch.
    client.responses.push(
      result('reserve_round', {
        ...attesting({ subjectHash: '9'.repeat(64) }),
        alreadyReserved: true
      })
    );

    await expect(
      new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7')
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    expect(client.toolsCalled).not.toContain('run_round');
  });
});
