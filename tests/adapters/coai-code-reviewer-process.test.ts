/**
 * The code reviewer against a REAL MCP process, over the real stdio transport.
 *
 * Agent Relay owns this fake server; nothing here talks to a vendor, a model or
 * a sibling repository, and no provider quota is spent. What it proves that the
 * unit tests cannot: the capability boundary is enforced by the transport that
 * actually spawns a process, so a server whose `tools/list` is not exactly the
 * audited profile is refused before any tool is called.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoaiCodeReviewer } from '../../src/main/adapters/mcp/coai-code-reviewer';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_PLAN_PROFILE,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import { StdioMcpClient } from '../../src/main/adapters/mcp/stdio-mcp-client';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import type { ExternalCodeReviewSubject, ExternalMcpServerConfig } from '../../src/main/ports';

let directory: string;
let serverScript: string;

const client = new StdioMcpClient(new ExecaProcessRunner());

const subject: ExternalCodeReviewSubject = {
  worktreePath: 'C:\\work\\task-1',
  branch: 'agent/task-1',
  baseRef: 'main',
  headCommit: 'a'.repeat(40),
  subjectSha256: 'b'.repeat(64)
};

/**
 * @param mode
 * Which tool list the fake advertises. `twelve` is the audited profile; the others
 * are the shapes that must fail closed.
 */
function config(mode: string, overrides: Partial<ExternalMcpServerConfig> = {}): ExternalMcpServerConfig {
  return {
    id: `fake-coai-${mode}`,
    enabled: true,
    executablePath: process.execPath,
    args: [serverScript, mode],
    cwd: directory,
    allowedTools: COAI_ADDRESSABLE_PROFILE,
    timeoutMs: 15_000,
    maxMessageBytes: 256 * 1024,
    maxContentBytes: 256 * 1024,
    maxContentBlocks: 8,
    ...overrides
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-relay-coai-'));
  serverScript = join(directory, 'fake-coai-mcp.mjs');
  const twelve = JSON.stringify([...COAI_ADDRESSABLE_PROFILE]);
  const nine = JSON.stringify([...COAI_PLAN_PROFILE]);
  writeFileSync(
    serverScript,
    [
      'const mode = process.argv[2] ?? "twelve";',
      `const TWELVE = ${twelve};`,
      `const NINE = ${nine};`,
      'const names = () => {',
      '  if (mode === "plan-only") return NINE;',
      '  if (mode === "extra") return [...TWELVE, "something_new"];',
      '  if (mode === "missing") return TWELVE.filter((n) => n !== "round_status");',
      '  if (mode === "duplicate") return [...TWELVE.slice(0, 11), "run_round"];',
      '  return TWELVE;',
      '};',
      'const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");',
      'const ok = (id, value) => send({ jsonrpc: "2.0", id, result: value });',
      'const text = (id, value) => ok(id, { content: [{ type: "text", text: JSON.stringify(value) }] });',
      `const LOCATOR = { providerId: ${JSON.stringify(COAI_PROVIDER_ID)}, sessionId: "s-1", roundId: "r-1" };`,
      'const REVIEW = {',
      '  locator: LOCATOR,',
      `  reviewedSubjectSha256: ${JSON.stringify(subject.subjectSha256)},`,
      '  verdict: "revise", gatingCount: 1, threshold: 0,',
      '  reviewers: "all 3 reviewers answered",',
      '  findings: [{ severity: "major", category: "reliability", gating: true,',
      '    title: "the retry is ambiguous", body: "a lost response may repeat work",',
      '    fix: "persist the intent", file: "src/app.ts", line: 7,',
      '    provider: "codex", role: "SecurityReliability" }],',
      '  instruction: "resolve every finding", tokensIn: 11, tokensOut: 22',
      '};',
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let newline;',
      '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);',
      '    if (line.trim().length === 0) continue;',
      '    const message = JSON.parse(line);',
      '    if (message.method === "initialize") {',
      '      ok(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } },',
      '        serverInfo: { name: "fake-coai-mcp", version: "0.19.0" } });',
      '      continue;',
      '    }',
      '    if (message.method === "tools/list") {',
      '      ok(message.id, { tools: names().map((name) => ({ name, inputSchema: { type: "object" } })) });',
      '      continue;',
      '    }',
      '    if (message.method === "tools/call") {',
      '      const tool = message.params?.name;',
      '      const args = message.params?.arguments ?? {};',
      '      if (tool === "reserve_round") {',
      '        text(message.id, { locator: LOCATOR,',
      '          attestation: { repoIdentity: "c:/x/.git", baseRef: args.baseRef ?? "", baseSha: "c".repeat(40),',
      '            headSha: "a".repeat(40), treeSha: "d".repeat(40), subjectHash: args.subjectSha256 ?? "" },',
      '          state: "not_started", alreadyReserved: false, instruction: "reserved: " + args.clientToken });',
      '        continue;',
      '      }',
      '      if (tool === "run_round") { text(message.id, REVIEW); continue; }',
      '      if (tool === "round_status") {',
      '        text(message.id, { locator: LOCATOR, state: "completed", instruction: "done", review: REVIEW });',
      '        continue;',
      '      }',
      '      text(message.id, { error: "this fake serves only the addressable round tools" });',
      '      continue;',
      '    }',
      '    if (message.id !== undefined) ok(message.id, {});',
      '  }',
      '});'
    ].join('\n'),
    'utf8'
  );
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the Coai code reviewer over a real MCP process', () => {
  it('accepts a server that advertises exactly the audited twelve-tool profile', async () => {
    const reviewer = new CoaiCodeReviewer(client, config('twelve'));

    await expect(reviewer.availability()).resolves.toEqual({ available: true, reason: null });
  });

  it('refuses the plan-only nine-tool server, naming the tools it lacks', async () => {
    const answer = await new CoaiCodeReviewer(client, config('plan-only')).availability();

    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/addressable code review is not supported/i);
    // Over the REAL transport the mismatch arrives as a message plus `details`
    // holding the compared names. Reading only the message dropped them, so the
    // refusal named nothing an operator could act on. All three, explicitly.
    expect(answer.reason).toContain('reserve_round');
    expect(answer.reason).toContain('run_round');
    expect(answer.reason).toContain('round_status');
    // And still nothing that would leak the process it tried to talk to.
    expect(answer.reason).not.toContain(process.execPath);
    expect(answer.reason).not.toContain(serverScript);
  });

  it.each([
    ['an unknown extra tool', 'extra'],
    ['a missing required tool', 'missing'],
    ['a duplicate standing in for a missing one', 'duplicate']
  ])('fails closed on %s', async (_name, mode) => {
    const answer = await new CoaiCodeReviewer(client, config(mode)).availability();

    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/addressable code review is not supported/i);
  });

  it('reserves, runs and reads back over the real transport', async () => {
    const reviewer = new CoaiCodeReviewer(client, config('twelve'));

    const locator = await reviewer.beginRound(subject, 'local-round-7');
    expect(locator).toEqual({ providerId: COAI_PROVIDER_ID, sessionId: 's-1', roundId: 'r-1' });

    const round = await reviewer.reviewCode(locator, subject, 'the scope this change implements');
    expect(round.verdict).toBe('revise');
    expect(round.findings).toHaveLength(1);
    expect(round.reviewedSubjectSha256).toBe(subject.subjectSha256);
    expect(round.serverName).toBe('fake-coai-mcp');
    expect(round.serverVersion).toBe('0.19.0');

    const status = await reviewer.roundStatus(locator, subject);
    expect(status.kind).toBe('completed');
    expect(status.kind === 'completed' && status.round.findings).toHaveLength(1);
  });

  it('carries the caller\u2019s durable token to the server, unchanged', async () => {
    // The fake echoes the token it was sent into its instruction, which is the
    // only way to see from here what actually crossed the process boundary.
    const reviewer = new CoaiCodeReviewer(client, config('ten'));
    const seen: string[] = [];
    const spy = {
      discover: client.discover.bind(client),
      call: async (
        cfg: ExternalMcpServerConfig,
        tool: string,
        args: Readonly<Record<string, unknown>>,
        signal?: AbortSignal
      ) => {
        const answer = await client.call(cfg, tool, args, signal);
        if (tool === 'reserve_round') seen.push(JSON.parse(answer.content[0]!).instruction);

        return answer;
      }
    };

    await new CoaiCodeReviewer(spy, config('ten')).beginRound(subject, 'local-round-42');
    await reviewer.availability();

    expect(seen).toEqual(['reserved: local-round-42']);
  });
});
