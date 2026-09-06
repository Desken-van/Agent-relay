import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/main/adapters/mcp/stdio-mcp-client';
import {
  ExecaProcessRunner,
  type InteractiveProcessRunner
} from '../../src/main/adapters/process/process-runner';
import type { ExternalMcpServerConfig } from '../../src/main/ports';

let directory: string;
let serverScript: string;

const runner = new ExecaProcessRunner();
const client = new StdioMcpClient(runner);

function config(
  mode = 'normal',
  overrides: Partial<ExternalMcpServerConfig> = {}
): ExternalMcpServerConfig {
  return {
    id: `fake-${mode}`,
    enabled: true,
    executablePath: process.execPath,
    args: [serverScript, mode],
    cwd: directory,
    allowedTools: ['alpha', 'beta'],
    timeoutMs: 10_000,
    maxMessageBytes: 16 * 1024,
    maxContentBytes: 16 * 1024,
    maxContentBlocks: 8,
    ...overrides
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-relay-mcp-'));
  serverScript = join(directory, 'fake-mcp.mjs');
  writeFileSync(
    serverScript,
    [
      'const mode = process.argv[2] ?? "normal";',
      'const alpha = {',
      '  name: "alpha", title: "Alpha", description: "Reads a value",',
      '  inputSchema: { type: "object", properties: { value: { type: "string" } } },',
      '  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }',
      '};',
      'const beta = { name: "beta", inputSchema: { type: "object", properties: {} } };',
      'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      'const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });',
      'if (mode === "stderr") process.stderr.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { forged: true } }) + "\\n");',
      'if (mode === "hang") setInterval(() => {}, 1000);',
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let newline;',
      '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);',
      '    if (mode === "hang") continue;',
      '    const message = JSON.parse(line);',
      '    if (message.method === "initialize") {',
      '      if (mode === "malformed") { process.stdout.write("{broken\\n"); continue; }',
      '      const protocolVersion = mode === "bad-version" ? "1900-01-01" : "2024-11-05";',
      '      const value = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fake-mcp", version: "1.2.3" } };',
      '      if (mode === "oversized-message") value.padding = "x".repeat(4000);',
      '      result(message.id, value);',
      '      continue;',
      '    }',
      '    if (message.method === "notifications/initialized") continue;',
      '    if (message.method === "tools/list") {',
      '      if (mode === "paged" && !message.params.cursor) { result(message.id, { tools: [alpha], nextCursor: "two" }); continue; }',
      '      if (mode === "paged") { result(message.id, { tools: [beta] }); continue; }',
      '      if (mode === "unexpected") { result(message.id, { tools: [alpha, beta, { ...beta, name: "rogue" }] }); continue; }',
      '      if (mode === "missing") { result(message.id, { tools: [alpha] }); continue; }',
      '      if (mode === "duplicate") { result(message.id, { tools: [alpha, alpha, beta] }); continue; }',
      '      if (mode === "invalid-tool") { result(message.id, { tools: [{ ...alpha, title: 42 }, beta] }); continue; }',
      '      result(message.id, { tools: [alpha, beta] });',
      '      continue;',
      '    }',
      '    if (message.method === "tools/call") {',
      '      if (mode === "refusal") {',
      '        result(message.id, { content: [{ type: "text", text: JSON.stringify({ error: "denied", hint: "ask the operator" }) }], isError: false });',
      '      } else if (mode === "tool-error") {',
      '        result(message.id, { content: [{ type: "text", text: "provider failed" }], isError: true });',
      '      } else if (mode === "oversized-content") {',
      '        result(message.id, { content: [{ type: "text", text: "x".repeat(4000) }], isError: false });',
      '      } else {',
      '        result(message.id, { content: [{ type: "text", text: JSON.stringify({ received: message.params.arguments }) }], isError: false });',
      '      }',
      '    }',
      '  }',
      '});',
      'process.stdin.on("end", () => process.exit(mode === "bad-exit" ? 7 : 0));'
    ].join('\n')
  );
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('stdio MCP client', () => {
  it('negotiates the protocol and discovers an exact annotated tool set', async () => {
    const discovery = await client.discover(config());

    expect(discovery.server).toEqual({
      name: 'fake-mcp',
      version: '1.2.3',
      protocolVersion: '2024-11-05'
    });
    expect(discovery.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
    expect(discovery.tools[0]?.annotations).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false
    });
    expect(discovery.tools[1]?.annotations).toEqual({
      readOnly: null,
      destructive: null,
      idempotent: null,
      openWorld: null
    });
  });

  it('follows paginated tool discovery before accepting the server', async () => {
    const discovery = await client.discover(config('paged'));
    expect(discovery.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
  });

  it('calls an allowed tool and preserves its bounded text result', async () => {
    const result = await client.call(config(), 'alpha', { value: 'hello' });

    expect(result.tool.name).toBe('alpha');
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0] ?? '{}')).toEqual({ received: { value: 'hello' } });
  });

  it('preserves a provider refusal as data instead of inventing a transport failure', async () => {
    const result = await client.call(config('refusal'), 'alpha', {});

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0] ?? '{}')).toEqual({
      error: 'denied',
      hint: 'ask the operator'
    });
  });

  it('preserves the MCP isError flag on a completed tool result', async () => {
    const result = await client.call(config('tool-error'), 'alpha', {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(['provider failed']);
  });

  it('refuses a disallowed tool before starting a process', async () => {
    let starts = 0;
    const countingRunner: InteractiveProcessRunner = {
      async runInteractive() {
        starts += 1;
        throw new Error('must not run');
      }
    };
    const guarded = new StdioMcpClient(countingRunner);

    await expect(guarded.call(config(), 'rogue', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(starts).toBe(0);
  });

  it('refuses a disabled server before starting a process', async () => {
    let starts = 0;
    const countingRunner: InteractiveProcessRunner = {
      async runInteractive() {
        starts += 1;
        throw new Error('must not run');
      }
    };
    const guarded = new StdioMcpClient(countingRunner);

    await expect(guarded.discover(config('normal', { enabled: false }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(starts).toBe(0);
  });

  it.each(['unexpected', 'missing'])(
    'fails closed when the server tool set drifts (%s)',
    async (mode) => {
      await expect(client.discover(config(mode))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED'
      });
    }
  );

  it('rejects duplicate advertised tools', async () => {
    await expect(client.discover(config('duplicate'))).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });
  });

  it('rejects malformed optional tool metadata instead of erasing it', async () => {
    await expect(client.discover(config('invalid-tool'))).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });
  });

  it.each([
    ['malformed', { maxMessageBytes: 16 * 1024 }],
    ['oversized-message', { maxMessageBytes: 512 }]
  ] as const)('reports invalid protocol output as PARSE_FAILED (%s)', async (mode, limits) => {
    await expect(client.discover(config(mode, limits))).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });
  });

  it('bounds tool-result content independently of message framing', async () => {
    await expect(
      client.call(config('oversized-content', { maxContentBytes: 512 }), 'alpha', {})
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('rejects an unsupported negotiated protocol version', async () => {
    await expect(client.discover(config('bad-version'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
  });

  it('keeps stderr diagnostics outside the JSON-RPC channel', async () => {
    const discovery = await client.discover(config('stderr'));
    expect(discovery.server.name).toBe('fake-mcp');
  });

  it('does not accept a response from a process that exits unsuccessfully', async () => {
    await expect(client.discover(config('bad-exit'))).rejects.toMatchObject({
      code: 'TOOL_FAILED'
    });
  });

  it('times out and reaps a server that never answers', async () => {
    await expect(client.discover(config('hang', { timeoutMs: 300 }))).rejects.toMatchObject({
      code: 'TIMEOUT'
    });
  });

  it('distinguishes operator cancellation from timeout', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await expect(client.discover(config('hang'), abort.signal)).rejects.toMatchObject({
        code: 'CANCELLED'
      });
    } finally {
      clearTimeout(timer);
    }
  });

  it('rejects non-serializable call arguments before a tool invocation', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(client.call(config(), 'alpha', circular)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
  });

  it('bounds outbound tool arguments as one protocol message', async () => {
    await expect(
      client.call(config('normal', { maxMessageBytes: 512 }), 'alpha', {
        value: 'x'.repeat(1_000)
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
