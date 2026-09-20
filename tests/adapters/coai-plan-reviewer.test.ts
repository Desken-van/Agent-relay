import { describe, expect, it } from 'vitest';
import { CoaiPlanReviewer, COAI_TOOL_ALLOWLIST } from '../../src/main/adapters/mcp/coai-plan-reviewer';
import { COAI_PLAN_REVIEW_TOOLS } from '../../src/main/adapters/mcp/coai-profiles';
import { AgentRelayError, PlanReviewNotDispatchedError } from '../../src/shared/domain/errors';
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpTool
} from '../../src/main/ports';

const config: ExternalMcpServerConfig = {
  id: 'coai',
  enabled: true,
  executablePath: 'C:\\tools\\coai-mcp.exe',
  args: ['--stdio'],
  allowedTools: COAI_TOOL_ALLOWLIST,
  timeoutMs: 30_000,
  maxMessageBytes: 100_000,
  maxContentBytes: 100_000,
  maxContentBlocks: 4
};

/** A fixed, valid-shaped contract fingerprint — its value is never asserted on here. */
const FINGERPRINT = 'f'.repeat(64);

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

  async discover(): Promise<ExternalMcpDiscovery> {
    return {
      server: { name: 'coai-mcp', version: '1.0', protocolVersion: '2024-11-05' },
      tools: [],
      contractFingerprint: FINGERPRINT
    };
  }

  async call(
    _config: ExternalMcpServerConfig,
    name: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<ExternalMcpCallResult> {
    this.calls.push({ tool: name, args });
    const response = this.responses.shift();
    if (!response) throw new Error('no fake response');
    return response;
  }
}

function result(name: string, value: unknown, overrides: Partial<ExternalMcpCallResult> = {}): ExternalMcpCallResult {
  return {
    server: { name: 'coai-mcp', version: '1.2.3', protocolVersion: '2024-11-05' },
    tool: tool(name),
    isError: false,
    content: [JSON.stringify(value)],
    contractFingerprint: FINGERPRINT,
    ...overrides
  };
}

describe('Coai plan reviewer adapter', () => {
  it('uses fixed open arguments and preserves the durable session identity', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', {
      sessionId: 'abc123', stage: 'PlanReview', awaitingResolve: false, planProceeded: false
    }));
    const reviewer = new CoaiPlanReviewer(client, config);

    await expect(reviewer.open({ repositoryPath: 'C:\\repo', branch: 'agent/task' })).resolves.toMatchObject({
      sessionId: 'abc123', stage: 'PlanReview', serverName: 'coai-mcp', serverVersion: '1.2.3'
    });
    expect(client.calls).toEqual([
      { tool: 'open', args: { repoPath: 'C:\\repo', branch: 'agent/task' } }
    ]);
  });

  it('normalises the documented plan verdict and finding enums', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('review_plan', {
      verdict: 'REVISE', gatingCount: 5, threshold: 0, reviewers: 'all 2 reviewers answered',
      instruction: 'resolve first',
      findings: [
        { severity: 'Major', category: 'Architecture', file: null, line: null,
          title: 'Missing boundary', why: 'The plan omits it.', fix: 'Add it.', providers: ['codex'] },
        { severity: 'Major', category: 'Clarity', file: null, line: null,
          title: 'Unclear ownership', why: 'The plan leaves it ambiguous.', fix: 'Name the owner.', providers: ['codex'] },
        { severity: 'Major', category: 'Completeness', file: null, line: null,
          title: 'Missing rollback', why: 'The plan omits it.', fix: 'Add it.', providers: ['codex'] },
        { severity: 'Major', category: 'Consistency', file: null, line: null,
          title: 'Conflicting rules', why: 'Two requirements disagree.', fix: 'Choose one rule.', providers: ['codex'] },
        { severity: 'Major', category: 'Feasibility', file: null, line: null,
          title: 'Unavailable primitive', why: 'The platform cannot provide it.', fix: 'Use the supported primitive.', providers: ['codex'] }
      ]
    }));
    const reviewer = new CoaiPlanReviewer(client, config);

    const answer = await reviewer.reviewPlan(
      { repositoryPath: 'C:\\repo', branch: 'agent/task' },
      'exact plan'
    );
    expect(answer.verdict).toBe('revise');
    expect(answer.findings.map((finding) => finding.category)).toEqual([
      'architecture',
      'clarity',
      'completeness',
      'consistency',
      'feasibility'
    ]);
    expect(answer.findings[0]).toMatchObject({ severity: 'major', file: '', line: 0 });
    expect(client.calls[0]).toEqual({
      tool: 'review_plan',
      args: { repoPath: 'C:\\repo', branch: 'agent/task', planText: 'exact plan' }
    });
  });

  it('serialises only validated decisions for resolve', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('resolve', {
      stage: 'CodeReview', awaitingResolve: false, recordedDecisions: 1, instruction: 'continue'
    }));
    const reviewer = new CoaiPlanReviewer(client, config);
    await reviewer.resolve(
      { repositoryPath: 'C:\\repo', branch: 'agent/task' },
      [{ finding: 0, action: 'accept', reason: '' }]
    );
    expect(client.calls[0]?.tool).toBe('resolve');
    expect(JSON.parse(String(client.calls[0]?.args.decisions))).toEqual([
      { finding: 0, action: 'accept', reason: '' }
    ]);
  });

  it('refuses a reasonless rejection before it reaches MCP', async () => {
    const client = new FakeMcpClient();
    const reviewer = new CoaiPlanReviewer(client, config);
    await expect(
      reviewer.resolve(
        { repositoryPath: 'C:\\repo', branch: 'agent/task' },
        [{ finding: 0, action: 'reject', reason: '' }]
      )
    ).rejects.toThrow(/reason/i);
    expect(client.calls).toHaveLength(0);
  });

  it('treats an error encoded in successful MCP text as a refusal', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', { error: 'no session budget' }));
    await expect(
      new CoaiPlanReviewer(client, config).open({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });

  it('does not merge ambiguous result blocks', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', {}, { content: ['{}', '{}'] }));
    await expect(
      new CoaiPlanReviewer(client, config).open({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('preserves MCP isError separately from a provider refusal', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', {}, { isError: true }));
    await expect(
      new CoaiPlanReviewer(client, config).open({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });

  /* ---------------------------------------------------------------------- */
  /* status: the only tool the recovery is allowed to call                    */
  /* ---------------------------------------------------------------------- */

  const statusValue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId: 'abc123',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    rounds: [],
    ...overrides
  });

  it('asks for status with the repository and branch and nothing else', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', statusValue()));
    await new CoaiPlanReviewer(client, config).status({
      repositoryPath: 'C:\\repo',
      branch: 'agent/task'
    });

    expect(client.calls).toEqual([
      { tool: 'status', args: { repoPath: 'C:\\repo', branch: 'agent/task' } }
    ]);
  });

  it('reports the documented absent-session refusal as typed positive evidence', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', {
      error: 'no session for this repo+branch — call open first'
    }));

    await expect(
      new CoaiPlanReviewer(client, config).status({
        repositoryPath: 'C:\\repo',
        branch: 'agent/task'
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Coai has no session for this repository and branch.'
    });
    expect(client.calls).toEqual([
      { tool: 'status', args: { repoPath: 'C:\\repo', branch: 'agent/task' } }
    ]);
  });

  it('does not mistake any other status refusal for an absent session', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', { error: 'no session budget' }));

    await expect(
      new CoaiPlanReviewer(client, config).status({
        repositoryPath: 'C:\\repo',
        branch: 'agent/task'
      })
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });

  it('counts running, done and interrupted plan rounds apart', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', statusValue({
      stage: 'PlanReview',
      rounds: [
        { stage: 'PlanReview', status: 'done', verdict: 'revise' },
        { stage: 'PlanReview', status: 'interrupted' },
        { stage: 'PlanReview', status: 'running' },
        { stage: 'CodeReview', status: 'done' }
      ]
    })));

    const answer = await new CoaiPlanReviewer(client, config).status({
      repositoryPath: 'C:\\repo',
      branch: 'agent/task'
    });

    // Four rounds recorded, three of them PlanReview, and each state kept as
    // itself: an interrupted round is never added to the completed ones.
    expect(answer.planRounds).toEqual({ total: 3, running: 1, done: 1, interrupted: 1 });
    expect(answer.sessionId).toBe('abc123');
  });

  it('reads the informational fields of a round without demanding them', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', statusValue({
      rounds: [{ stage: 'PlanReview', status: 'done', verdict: 'proceed', gatingCount: 0, note: 'x' }],
      openedAt: '2026-09-06T00:00:00.000Z'
    })));

    const answer = await new CoaiPlanReviewer(client, config).status({
      repositoryPath: 'C:\\repo',
      branch: 'agent/task'
    });

    expect(answer.planRounds).toEqual({ total: 1, running: 0, done: 1, interrupted: 0 });
  });

  it('rejects a status answer with no session identity rather than inventing one', async () => {
    const client = new FakeMcpClient();
    const value = statusValue();
    delete value.sessionId;
    client.responses.push(result('status', value));

    await expect(
      new CoaiPlanReviewer(client, config).status({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('rejects a status answer with no rounds rather than reading it as none', async () => {
    const client = new FakeMcpClient();
    const value = statusValue();
    delete value.rounds;
    client.responses.push(result('status', value));

    // The dangerous default: an absent `rounds` silently becoming `[]` would
    // assert that no non-idempotent round has ever run, which is the one thing
    // this evidence exists to establish.
    await expect(
      new CoaiPlanReviewer(client, config).status({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('rejects a round state it does not know how to classify', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', statusValue({
      rounds: [{ stage: 'PlanReview', status: 'queued' }]
    })));

    await expect(
      new CoaiPlanReviewer(client, config).status({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('rejects a status answer whose shape is not an object at all', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('status', ['PlanReview']));

    await expect(
      new CoaiPlanReviewer(client, config).status({ repositoryPath: 'C:\\repo', branch: 'agent/task' })
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('accepts exactly its own four tools locally, and nothing between them', () => {
    // This is a LOCAL construction-time sanity check, independent of anything
    // a real server advertises — that is negotiated per call by the transport's
    // required-subset check (see stdio-mcp-client.ts).
    expect(
      () => new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: COAI_PLAN_REVIEW_TOOLS })
    ).not.toThrow();

    // A subset is refused: this adapter would be permitted to call a tool it
    // is missing from its own declared local allowlist.
    expect(
      () => new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: ['open', 'review_plan'] })
    ).toThrow(/exactly its four tools/i);
    // A superset is refused too: this adapter should never be handed permission
    // to call a tool it was never written to use.
    expect(
      () =>
        new CoaiPlanReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_PLAN_REVIEW_TOOLS, 'reserve_round']
        })
    ).toThrow(/exactly its four tools/i);
    // Four names with a duplicate standing in for a missing one is still not
    // the four required tools, however the counts line up.
    expect(
      () =>
        new CoaiPlanReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_PLAN_REVIEW_TOOLS.slice(0, 3), 'open']
        })
    ).toThrow(/exactly its four tools/i);
  });
});

describe('Coai plan reviewer adapter: proving a session fresh and telling a refusal from a lost answer', () => {
  const subject = { repositoryPath: 'C:\repo', branch: 'a'.repeat(40) };
  const session = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'abc123',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    ...overrides
  });

  it('reports what the opened session already holds, counting only plan rounds by state', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('open', session({
        rounds: [
          { stage: 'PlanReview', status: 'done' },
          { stage: 'PlanReview', status: 'running' },
          { stage: 'PlanReview', status: 'interrupted' },
          { stage: 'CodeReview', status: 'done' }
        ]
      }))
    );

    const opened = await new CoaiPlanReviewer(client, config).open(subject);

    expect(opened.planRounds).toEqual({ total: 3, running: 1, done: 1, interrupted: 1 });
  });

  it('reports an empty session as empty — and a session that did not say as NOT KNOWN, never as none', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', session({ rounds: [] })), result('open', session()));
    const reviewer = new CoaiPlanReviewer(client, config);

    expect((await reviewer.open(subject)).planRounds).toEqual({ total: 0, running: 0, done: 0, interrupted: 0 });
    expect((await reviewer.open(subject)).planRounds).toBeNull();
  });

  it('opens with the subject it was given — a commit id is as good as a branch name — and nothing else', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('open', session({ rounds: [] })));

    await new CoaiPlanReviewer(client, config).open(subject);

    expect(client.calls).toEqual([{ tool: 'open', args: { repoPath: 'C:\repo', branch: subject.branch } }]);
  });

  it.each([
    ['the plan stage is over for this session (stage: CodeReview); open a new session for a new plan', 'plan_stage_over'],
    ['no session for this repo+branch — call open first', 'no_session']
  ] as const)('types the provider’s documented refusal "%s" as one that came before any round', async (words, reason) => {
    const client = new FakeMcpClient();
    client.responses.push(result('review_plan', { error: words }));

    const failure = await new CoaiPlanReviewer(client, config).reviewPlan(subject, 'plan').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlanReviewNotDispatchedError);
    expect(failure).toMatchObject({ reason, code: 'TOOL_FAILED' });
    // The provider's own sentence is what a person is shown.
    expect((failure as Error).message).toContain(words);
  });

  it.each([
    ['a refusal in words this build has not audited', result('review_plan', { error: 'reviewer budget exhausted' })],
    ['an MCP tool error', result('review_plan', {}, { isError: true })],
    ['malformed text', result('review_plan', {}, { content: ['not json'] })]
  ])('leaves %s as an ordinary failure, because it is not proof that nothing ran', async (_name, response) => {
    const client = new FakeMcpClient();
    client.responses.push(response);

    const failure = await new CoaiPlanReviewer(client, config).reviewPlan(subject, 'plan').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRelayError);
    expect(failure).not.toBeInstanceOf(PlanReviewNotDispatchedError);
  });

  it('does not type a transport failure or a timeout, which reach the caller exactly as they were thrown', async () => {
    const timeout = new AgentRelayError('TIMEOUT', 'The Coai call timed out.');
    const client = new FakeMcpClient();
    client.call = async () => {
      throw timeout;
    };

    const failure = await new CoaiPlanReviewer(client, config).reviewPlan(subject, 'plan').catch((error: unknown) => error);

    expect(failure).toBe(timeout);
    expect(failure).not.toBeInstanceOf(PlanReviewNotDispatchedError);
  });

  it('types a subject the provider cannot resolve — a pruned commit — as a refusal before anything existed', async () => {
    const client = new FakeMcpClient();
    const words = `git rev-parse: cannot resolve '${subject.branch}': fatal: Needed a single revision`;
    client.responses.push(result('open', { error: words }), result('review_plan', { error: words }));
    const reviewer = new CoaiPlanReviewer(client, config);

    const opened = await reviewer.open(subject).catch((error: unknown) => error);
    const reviewed = await reviewer.reviewPlan(subject, 'plan').catch((error: unknown) => error);

    for (const failure of [opened, reviewed]) {
      expect(failure).toBeInstanceOf(PlanReviewNotDispatchedError);
      expect(failure).toMatchObject({ reason: 'unresolvable_subject', code: 'TOOL_FAILED' });
      expect((failure as Error).message).toContain(words);
    }
  });

  it('does not type other refusals of open — only the documented unresolvable-ref sentence', async () => {
    const client = new FakeMcpClient();
    client.responses.push(
      result('open', { error: 'no session budget' }),
      result('open', { error: 'git rev-parse: something else entirely' }),
      result('open', {}, { isError: true })
    );
    const reviewer = new CoaiPlanReviewer(client, config);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failure = await reviewer.open(subject).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentRelayError);
      expect(failure).not.toBeInstanceOf(PlanReviewNotDispatchedError);
    }
  });

  it('reads a long round history in full rather than failing on it', async () => {
    const client = new FakeMcpClient();
    const rounds = Array.from({ length: 200 }, (_, index) => ({
      stage: index % 2 === 0 ? 'PlanReview' : 'CodeReview',
      status: 'done'
    }));
    client.responses.push(result('open', session({ rounds })), result('status', { sessionId: 'abc123', stage: 'CodeReview', awaitingResolve: false, planProceeded: true, rounds }));
    const reviewer = new CoaiPlanReviewer(client, config);

    expect((await reviewer.open(subject)).planRounds).toEqual({ total: 100, running: 0, done: 100, interrupted: 0 });
    expect((await reviewer.status(subject)).planRounds).toEqual({ total: 100, running: 0, done: 100, interrupted: 0 });
  });

  it('types the refusal only for review_plan: the same words from any other tool stay ordinary', async () => {
    const client = new FakeMcpClient();
    client.responses.push(result('resolve', { error: 'the plan stage is over for this session (stage: CodeReview); open a new session for a new plan' }));

    const failure = await new CoaiPlanReviewer(client, config).resolve(subject, []).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRelayError);
    expect(failure).not.toBeInstanceOf(PlanReviewNotDispatchedError);
  });
});
