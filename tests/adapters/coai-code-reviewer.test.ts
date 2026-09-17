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
  COAI_CODE_REVIEW_TOOLS,
  COAI_PLAN_PROFILE,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import type {
  ExternalCodeReviewSubject,
  ExternalCodeRoundIdentity,
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpTool
} from '../../src/main/ports';

/** A fixed, valid-shaped contract fingerprint — its value is never asserted on here. */
const FINGERPRINT = 'f'.repeat(64);

const config: ExternalMcpServerConfig = {
  id: 'coai-code-review',
  enabled: true,
  executablePath: 'C:\\tools\\coai-mcp.exe',
  args: ['--stdio'],
  allowedTools: COAI_CODE_REVIEW_TOOLS,
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

const locator: ExternalCodeRoundIdentity = {
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
  /** What `tools/list` reports. The twelve-tool profile unless a test says otherwise. */
  tools: readonly string[] = COAI_ADDRESSABLE_PROFILE;
  discoveryError: Error | null = null;
  callError: Error | null = null;

  async discover(): Promise<ExternalMcpDiscovery> {
    if (this.discoveryError) throw this.discoveryError;

    return {
      server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' },
      tools: this.tools.map(tool),
      contractFingerprint: FINGERPRINT
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
    contractFingerprint: FINGERPRINT,
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

  it('refuses to be built on a local declaration that is not exactly its three tools', () => {
    expect(() => new CoaiCodeReviewer(new FakeMcpClient(), config)).not.toThrow();

    // This is a LOCAL construction-time sanity check, independent of what a
    // real server advertises. The plan-only nine tools are not this adapter's
    // three, so a config declaring them locally is still refused here.
    expect(
      () => new CoaiCodeReviewer(new FakeMcpClient(), { ...config, allowedTools: COAI_PLAN_PROFILE })
    ).toThrow(/exactly its three tools/i);
    expect(
      () =>
        new CoaiCodeReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_CODE_REVIEW_TOOLS, 'something_new']
        })
    ).toThrow(/exactly its three tools/i);
    expect(
      () =>
        new CoaiCodeReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_CODE_REVIEW_TOOLS.slice(0, 2), 'run_round']
        })
    ).toThrow(/exactly its three tools/i);
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

  it('reports the plan-only server as unsupported, naming what is missing', async () => {
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
    // COAI_CODE_REVIEW_TOOLS; nothing the server sent is echoed, so a server
    // that advertised a tool called `C:\\evil\\path` could not put it here.
    const client = new FakeMcpClient();
    client.discoveryError = new McpToolProfileMismatchError(
      'VALIDATION_FAILED',
      'The MCP server does not advertise every tool this request requires.',
      {
        missing: [...COAI_CODE_REVIEW_TOOLS],
        unexpectedCount: 1,
        duplicated: false,
        server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' }
      }
    );

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    for (const name of COAI_CODE_REVIEW_TOOLS) expect(answer.reason).toContain(name);
    expect(answer.reason).toMatch(/It does not advertise/i);
  });

  it('reports a self-contradictory tool list distinctly from a missing tool', async () => {
    const client = new FakeMcpClient();
    client.discoveryError = new McpToolProfileMismatchError(
      'PARSE_FAILED',
      'The MCP server advertised a duplicate tool name.',
      {
        missing: [],
        unexpectedCount: 0,
        duplicated: true,
        server: { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' }
      }
    );

    const answer = await new CoaiCodeReviewer(client, config).availability();

    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/duplicate tool name/i);
  });

  // ---------- beginRound reserves and nothing else ----------

  it('reserves with the caller\u2019s durable token and dispatches nothing', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('reserve_round', reservation));

    const got = await new CoaiCodeReviewer(client, config).beginRound(subject, 'local-round-7');

    expect(got).toEqual({ ...locator, contractFingerprint: FINGERPRINT });
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
    ).resolves.toEqual({ ...locator, contractFingerprint: FINGERPRINT });
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

// ---------------------------------------------------------------------------
// A read-back that contradicts itself
// ---------------------------------------------------------------------------

describe('a round_status answer that contradicts itself', () => {
  /**
   * The defect this closes: `review` used to be optional on ONE object shared
   * by every state, so a payload could say `not_started` and carry a finished
   * review at the same time — and the `not_started` branch never looked at it.
   * That produced the single answer which licenses a re-dispatch, for a round
   * the provider had just said it had completed.
   *
   * The schema is now a discriminated union, so the contradiction cannot even
   * be represented: `review` exists only on `completed`.
   */
  it('refuses a not_started that also carries a completed review', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', {
        locator,
        state: 'not_started',
        instruction: 'reserved, never run',
        // The locator agrees, so nothing else in the method would have caught it.
        review: completed()
      })
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    // Ambiguous, and therefore not evidence that nothing ran.
    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.reason).toBeTruthy();
    // Read-only throughout: a contradiction is never a reason to dispatch.
    expect(client.toolsCalled).toEqual(['round_status']);
  });

  it.each(['running', 'failed', 'unknown'])(
    'refuses a %s that also carries a review',
    async (state) => {
      const client = new FakeMcpClient();
      client.responses.push(
        result('round_status', {
          locator,
          state,
          instruction: 'contradictory',
          review: completed()
        })
      );

      const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

      expect(status.kind).toBe('unknown');
      expect(client.toolsCalled).toEqual(['round_status']);
    }
  );

  it('leaves the two coherent answers working exactly as before', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', { locator, state: 'not_started', instruction: 'reserved' })
    );
    client.responses.push(
      result('round_status', {
        locator,
        state: 'completed',
        instruction: 'done',
        review: completed()
      })
    );
    const reviewer = new CoaiCodeReviewer(client, config);

    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('not_started');

    const finished = await reviewer.roundStatus(locator, subject);
    expect(finished.kind).toBe('completed');
    expect(finished.kind === 'completed' && finished.round.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What a server may put in its own identity
// ---------------------------------------------------------------------------

describe('the MCP server identity a round would store', () => {
  /**
   * `serverInfo` comes from the INITIALIZE handshake, not from the tool result,
   * so the credential scan that runs over a payload never saw it — and it was
   * written to the durable round regardless. A token in a finding refused the
   * whole round; the same token in a "version" was stored and shown.
   */
  const ESCAPE = String.fromCharCode(27);

  function withServer(name: string, version: string) {
    return { server: { name, version, protocolVersion: '2024-11-05' } };
  }

  const unsafe = [
    { what: 'a credential-shaped name', name: 'coai-mcp ghp_A1b2C3d4E5f6G7h8I9j0', version: '0.19.0' },
    { what: 'a credential-shaped version', name: 'coai-mcp', version: '0.19.0+sk-ant-A1b2C3d4E5f6G7h8' },
    { what: 'an authorization header', name: 'coai Bearer A1b2C3d4E5f6G7h8I9j0', version: '1.0' },
    { what: 'an escape sequence', name: 'coai' + ESCAPE + '[31m', version: '1.0' },
    { what: 'an over-long version', name: 'coai-mcp', version: 'v'.repeat(201) }
  ];

  it.each(unsafe)('refuses to build a round when the server reports $what', async (
    { name, version }
  ) => {
    const client = new FakeMcpClient();
    client.responses.push(result('run_round', completed(), withServer(name, version)));

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toThrow(/was not accepted/i);
  });

  it('never repeats the offending identity in its refusal', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('run_round', completed(), withServer('coai-mcp ghp_A1b2C3d4E5f6G7h8I9j0', '0.19.0'))
    );

    const error = await new CoaiCodeReviewer(client, config)
      .reviewCode(locator, subject, 'scope')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentRelayError);
    // The message is itself stored, so it names the field and the problem only.
    expect(String(error)).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0');
    expect(String(error)).toMatch(/credential-shaped/i);
  });

  it('answers unknown on read-back rather than throwing out of it', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result(
        'round_status',
        { locator, state: 'completed', instruction: 'done', review: completed() },
        withServer('coai-mcp ghp_A1b2C3d4E5f6G7h8I9j0', '0.19.0')
      )
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    // `roundStatus` always answers. An answer that cannot be stored is exactly
    // the ambiguity `unknown` exists to express.
    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.reason).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0');
  });

  it('carries an ordinary identity through untouched', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('run_round', completed(), withServer('coai-mcp', '0.19.0')));

    const round = await new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope');

    expect(round.serverName).toBe('coai-mcp');
    expect(round.serverVersion).toBe('0.19.0');
  });
});

// ---------------------------------------------------------------------------
// Reviewer prose on a completed round
// ---------------------------------------------------------------------------

describe('provider prose a completed round would store', () => {
  const ESCAPE = String.fromCharCode(27);
  const BELL = String.fromCharCode(7);
  const NEWLINE = String.fromCharCode(10);

  const unsafe = [
    {
      what: 'an escape sequence in the reviewer summary',
      field: 'reviewers',
      value: 'all 3' + ESCAPE + '[2J answered'
    },
    {
      what: 'a bell character in the instruction',
      field: 'instruction',
      value: 'resolve' + BELL + ' every finding'
    },
    {
      what: 'a credential in the reviewer summary',
      field: 'reviewers',
      value: 'answered with GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0'
    },
    {
      what: 'a credential in the instruction',
      field: 'instruction',
      value: 'export API_KEY=sk-ant-A1b2C3d4E5f6G7h8'
    }
  ];

  it.each(unsafe)('refuses a run_round answer carrying $what', async ({ field, value }) => {
    const client = new FakeMcpClient();
    client.responses.push(result('run_round', completed({ [field]: value })));

    await expect(
      new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope')
    ).rejects.toThrow(/was not accepted/i);
  });

  it.each(unsafe)('turns a completed read-back carrying $what into unknown', async ({
    field,
    value
  }) => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', {
        locator,
        state: 'completed',
        instruction: 'done',
        review: completed({ [field]: value })
      })
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.reason).not.toContain(value);
  });

  it('names the field and the problem, never the value', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('run_round', completed({ reviewers: 'all 3' + ESCAPE + '[2J answered' }))
    );

    const error = await new CoaiCodeReviewer(client, config)
      .reviewCode(locator, subject, 'scope')
      .catch((reason: unknown) => reason);

    // The control-character rule belongs to THIS check: the payload scan looks
    // for credential shapes and would have passed an escape sequence straight
    // through to storage.
    expect(String(error)).toMatch(/reviewer summary is carrying control characters/i);
    expect(String(error)).not.toContain(ESCAPE);
  });

  it('leaves a credential in prose to the payload scan, which refuses it first', async () => {
    // Two layers, and this says which one fires. The result-wide scan runs
    // inside `parse`, before a round is built at all, so a credential never
    // reaches the per-field check — and both refuse the round either way.
    const client = new FakeMcpClient();
    client.responses.push(
      result(
        'run_round',
        completed({ reviewers: 'answered with GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0' })
      )
    );

    const error = await new CoaiCodeReviewer(client, config)
      .reviewCode(locator, subject, 'scope')
      .catch((reason: unknown) => reason);

    expect(String(error)).toMatch(/credential-shaped text/i);
    expect(String(error)).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0');
  });

  it('leaves ordinary prose alone, wrapping included', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result(
        'run_round',
        completed({
          reviewers: 'all 3 reviewers answered',
          instruction: 'resolve every finding' + NEWLINE + 'then run the gate again'
        })
      )
    );

    const round = await new CoaiCodeReviewer(client, config).reviewCode(locator, subject, 'scope');

    expect(round.reviewers).toBe('all 3 reviewers answered');
    // A newline is prose, not a control character to refuse.
    expect(round.instruction).toContain(NEWLINE);
  });
});

// ---------------------------------------------------------------------------
// What a read-back reason may contain
// ---------------------------------------------------------------------------

describe('what a read-back reason may contain', () => {
  const ESCAPE = String.fromCharCode(27);

  /**
   * A wholly fictional path, argv and token. Nothing here exists; the string
   * exists to be refused, and every fragment of it is asserted absent below.
   */
  const HOSTILE =
    'died at C:/Users/someone/AppData/coai/coai-mcp.exe --stdio' + ESCAPE + '[31m';

  const leaks = ['C:/Users/someone', 'coai-mcp.exe', '--stdio', 'AppData', ESCAPE];

  /**
   * Deliberately WITHOUT a credential shape.
   *
   * A payload carrying one is refused wholesale by the result scan, long before
   * a state branch is reached — which is correct, and is covered separately. It
   * would also make these tests prove nothing about the branch they name, since
   * the answer would come from the scan either way.
   */

  it.each(['failed', 'unknown'])(
    'repeats nothing from a %s round_status instruction',
    async (state) => {
      const client = new FakeMcpClient();
      client.responses.push(result('round_status', { locator, state, instruction: HOSTILE }));

      const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

      expect(status.kind).toBe('unknown');
      const reason = status.kind === 'unknown' ? (status.reason ?? '') : '';
      for (const leak of leaks) expect(reason, leak).not.toContain(leak);
      // It still says which kind of nothing this is.
      expect(reason).toMatch(/not repeated here|no usable record/i);
    }
  );

  it('refuses the whole payload when the instruction is credential-shaped', async () => {
    // The scan runs over the parsed result before any state branch, so this
    // never reaches the `failed` case at all.
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', {
        locator,
        state: 'failed',
        instruction: 'died with GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0'
      })
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    expect(status.kind).toBe('unknown');
    const reason = status.kind === 'unknown' ? (status.reason ?? '') : '';
    expect(reason).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0');
    expect(reason).toContain('could not be read back (PARSE_FAILED)');
  });

  it('repeats nothing from a server refusal returned as data', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('round_status', { error: HOSTILE }));

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    expect(status.kind).toBe('unknown');
    const reason = status.kind === 'unknown' ? (status.reason ?? '') : '';
    for (const leak of leaks) expect(reason, leak).not.toContain(leak);
    // The closed-set code survives, because this application owns it.
    expect(reason).toMatch(/could not be read back \(TOOL_FAILED\)/);
  });

  it('still maps the coherent states exactly as before', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', { locator, state: 'running', instruction: HOSTILE })
    );
    client.responses.push(
      result('round_status', { locator, state: 'not_started', instruction: HOSTILE })
    );
    client.responses.push(
      result('round_status', {
        locator,
        state: 'completed',
        instruction: HOSTILE,
        review: completed()
      })
    );
    const reviewer = new CoaiCodeReviewer(client, config);

    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('running');
    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('not_started');
    // A hostile envelope `instruction` does not spoil a coherent completion:
    // the instruction that gets STORED is the review's own, and that one is
    // checked. The envelope's copy is simply never read.
    expect((await reviewer.roundStatus(locator, subject)).kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Locator components are opaque identifiers, not free text
// ---------------------------------------------------------------------------

describe('the locator a reservation hands back', () => {
  /**
   * `sessionId` and `roundId` used to be bounded only by length, and they are
   * written straight to the durable round and shown wherever its provider
   * identity is. A server could therefore name its own session with an escape
   * sequence, a path or a token and have it persisted verbatim.
   */
  const ESCAPE = String.fromCharCode(27);
  const BELL = String.fromCharCode(7);

  const hostile = [
    { what: 'an escape sequence in the session id', field: 'sessionId', value: 'session' + ESCAPE + '[31m' },
    { what: 'a control character in the round id', field: 'roundId', value: 'round' + BELL + '1' },
    { what: 'a path in the session id', field: 'sessionId', value: 'C:/Users/someone/AppData/coai' },
    { what: 'an argv fragment in the round id', field: 'roundId', value: '--data-dir /tmp/x' },
    { what: 'a credential-shaped session id', field: 'sessionId', value: 'ghp_A1b2C3d4E5f6G7h8I9j0' },
    { what: 'a credential-shaped round id', field: 'roundId', value: 'sk-ant-A1b2C3d4E5f6G7h8' }
  ];

  it.each(hostile)('refuses a reservation carrying $what, and dispatches nothing', async ({
    field,
    value
  }) => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('reserve_round', { ...reservation, locator: { ...locator, [field]: value } })
    );

    const failure = await new CoaiCodeReviewer(client, config)
      .beginRound(subject, 'local-round-7')
      .catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(AgentRelayError);
    expect((failure as AgentRelayError).code).toBe('PARSE_FAILED');
    // The refusal repeats nothing the server sent.
    expect(String(failure)).not.toContain(value);
    // Reserved and no more: run_round is never reached.
    expect(client.toolsCalled).toEqual(['reserve_round']);
  });

  it('still accepts the identifier shapes a real server actually produces', async () => {
    const realistic = [
      '9f2c1e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      'a3f5c9e1b7d2a4f6',
      'coai:session:2026-09-09',
      'round_42.retry-3',
      '7'
    ];

    for (const id of realistic) {
      const client = new FakeMcpClient();
      client.responses.push(
        result('reserve_round', {
          ...reservation,
          locator: { ...locator, sessionId: id, roundId: id }
        })
      );

      const answer = await new CoaiCodeReviewer(client, config).beginRound(
        subject,
        'local-round-7'
      );

      // Carried through exactly: nothing is normalised or stripped, because a
      // locator edited on the way in no longer names the provider's round.
      expect(answer.sessionId, id).toBe(id);
      expect(answer.roundId, id).toBe(id);
    }
  });

  it('refuses the same shapes on a completed read-back, not only on reserving', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('round_status', {
        locator: { ...locator, sessionId: 'session' + ESCAPE + '[31m' },
        state: 'completed',
        instruction: 'done',
        review: completed()
      })
    );

    const status = await new CoaiCodeReviewer(client, config).roundStatus(locator, subject);

    // The schema refuses the payload, and a parse failure is `unknown`.
    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.reason).not.toContain(ESCAPE);
  });
});
