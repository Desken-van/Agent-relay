import { describe, expect, it } from 'vitest';
import { CoaiPlanReviewer, COAI_TOOL_ALLOWLIST } from '../../src/main/adapters/mcp/coai-plan-reviewer';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_PLAN_PROFILE
} from '../../src/main/adapters/mcp/coai-profiles';
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
    return { server: { name: 'coai-mcp', version: '1.0', protocolVersion: '2024-11-05' }, tools: [] };
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
      verdict: 'REVISE', gatingCount: 1, threshold: 0, reviewers: 'all 2 reviewers answered',
      instruction: 'resolve first',
      findings: [{ severity: 'Major', category: 'Architecture', file: null, line: null,
        title: 'Missing rollback', why: 'The plan omits it.', fix: 'Add it.', providers: ['codex'] }]
    }));
    const reviewer = new CoaiPlanReviewer(client, config);

    const answer = await reviewer.reviewPlan(
      { repositoryPath: 'C:\\repo', branch: 'agent/task' },
      'exact plan'
    );
    expect(answer.verdict).toBe('revise');
    expect(answer.findings[0]).toMatchObject({ severity: 'major', category: 'architecture', file: '', line: 0 });
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

  it('accepts either audited profile and refuses everything between them', () => {
    // The plan tools are identical in both, and a deployment running the newer
    // server should not have to run a second one to keep the plan gate working.
    expect(
      () => new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: COAI_PLAN_PROFILE })
    ).not.toThrow();
    expect(
      () =>
        new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: COAI_ADDRESSABLE_PROFILE })
    ).not.toThrow();

    // A subset is not a profile, and neither is a superset: a server that grew a
    // tool nobody here has read may have changed its others too, and the two are
    // indistinguishable from this side.
    expect(
      () => new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: ['open', 'review_plan'] })
    ).toThrow(/audited profiles/i);
    expect(
      () =>
        new CoaiPlanReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_PLAN_PROFILE, 'something_new']
        })
    ).toThrow(/audited profiles/i);
    // Twelve names with a duplicate standing in for a missing one is still not
    // the twelve-tool profile, however the counts line up.
    expect(
      () =>
        new CoaiPlanReviewer(new FakeMcpClient(), {
          ...config,
          allowedTools: [...COAI_ADDRESSABLE_PROFILE.slice(0, 11), 'run_round']
        })
    ).toThrow(/audited profiles/i);
  });
});
