import { describe, expect, it } from 'vitest';
import { CoaiPlanReviewer, COAI_TOOL_ALLOWLIST } from '../../src/main/adapters/mcp/coai-plan-reviewer';
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

  it('refuses a partial or expanded tool allowlist at construction', () => {
    expect(
      () => new CoaiPlanReviewer(new FakeMcpClient(), { ...config, allowedTools: ['open', 'review_plan'] })
    ).toThrow(/seven-tool allowlist/i);
  });
});

