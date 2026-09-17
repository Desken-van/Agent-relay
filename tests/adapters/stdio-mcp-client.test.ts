import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      'import { writeFileSync } from "node:fs";',
      'const mode = process.argv[2] ?? "normal";',
      // `unsupported-schema` mode: argv[3] names the construct, argv[4] is a
      // marker file this script writes if — and only if — a `tools/call` for
      // `gamma` is ever received. Its absence after a test is the proof that
      // nothing was dispatched, not merely that the call rejected locally.
      'const construct = process.argv[3];',
      'const marker = process.argv[4];',
      'const gammaSchema = {',
      // Genuinely SUPPORTED by the real validator — not merely tolerated,
      // actually evaluated: each has a paired good/bad-argument test below.
      '  pattern: { type: "object", properties: { value: { type: "string", pattern: "^[a-z]+$" } } },',
      '  oneOf: { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } } },',
      '  ref: { type: "object", properties: { value: { $ref: "#/definitions/thing" } }, definitions: { thing: { type: "string" } } },',
      '  "additionalProperties-schema": { type: "object", properties: {}, additionalProperties: { type: "string" } },',
      // The idiomatic recursive form $dynamicRef/$dynamicAnchor exist for —
      // an "extensible list" whose element schema re-anchors at the outermost
      // dynamic scope. `value` may nest arbitrarily many empty arrays, but a
      // non-array leaf fails.
      '  "dynamic-ref": { type: "object", properties: { value: {',
      '    $id: "nested-list", $dynamicAnchor: "items", type: "array", items: { $dynamicRef: "#items" }',
      '  } } },',
      '  "false-property": { type: "object", properties: { value: false } },',
      '  "true-property": { type: "object", properties: { value: true } },',
      '  "false-items": { type: "object", properties: { value: { type: "array", items: false } } },',
      '  "astral-minLength": { type: "object", properties: { value: { type: "string", minLength: 2 } } },',
      '  "astral-maxLength": { type: "object", properties: { value: { type: "string", maxLength: 1 } } },',
      '  "own-property-required": { type: "object", required: ["constructor", "toString"], properties: {',
      '    constructor: { type: "string" }, toString: { type: "string" }',
      '  } },',
      // A bare `type` UNION at the property level — the specific pattern
      // `strictTypes` (part of Ajv\'s `strict: true` default bundle) refuses
      // to compile without `allowUnionTypes: true`, which this build
      // deliberately does not set — see `strictTypes: false` in
      // stdio-mcp-client.ts. An "optional nullable string" is common enough
      // that refusing it would be a real compatibility cost for no safety
      // gain, so this proves it genuinely compiles and validates.
      '  "type-union": { type: "object", properties: { value: { type: ["string", "null"] } } },',
      // Ajv core ships with NO format implementations at all; under
      // `strict: true` an unregistered format name is a COMPILE-time error,
      // not a silent no-op — so this construct proves ajv-formats is wired
      // in, not merely that `format` is tolerated as an inert annotation.
      '  "format-email": { type: "object", properties: { value: { type: "string", format: "email" } } },',
      '  supported: { type: "object", minProperties: 1, properties: {',
      '    value: { type: "number", minimum: 0, maximum: 10 },',
      '    tags: { type: "array", items: { type: "string" }, uniqueItems: true }',
      '  } },',
      // Genuinely REJECTED — the real validator refuses to COMPILE these, so
      // no argument, good or bad, ever reaches a call.
      '  "unknown-type": { type: "object", properties: { value: { type: "frobnicator" } } },',
      '  "unknown-keyword": { type: "object", properties: { value: { type: "string", frobnicate: true } } },',
      '  "malformed-additionalProperties": { type: "object", properties: {}, additionalProperties: "yes" },',
      '  "tuple-items": { type: "object", properties: { value: { type: "array", items: [{ type: "string" }, { type: "number" }] } } },',
      '  "malformed-required": { type: "object", required: "value", properties: { value: { type: "string" } } },',
      '  "duplicate-required": { type: "object", required: ["value", "value"], properties: { value: { type: "string" } } },',
      '  "malformed-enum": { type: "object", properties: { value: { enum: "fast" } } },',
      '  "malformed-limits": { type: "object", properties: { value: { type: "string", minLength: "3" } } },',
      '  "malformed-uniqueItems": { type: "object", properties: { tags: { type: "array", uniqueItems: "yes" } } },',
      '  "multipleOf-zero": { type: "object", properties: { value: { type: "number", multipleOf: 0 } } },',
      '  "negative-minLength": { type: "object", properties: { value: { type: "string", minLength: -1 } } },',
      '  "fractional-minItems": { type: "object", properties: { tags: { type: "array", minItems: 1.5 } } },',
      '  "negative-minProperties": { type: "object", minProperties: -1 }',
      '}[construct];',
      'const gamma = { name: "gamma", inputSchema: gammaSchema };',
      'const alpha = {',
      '  name: "alpha", title: "Alpha", description: "Reads a value",',
      '  inputSchema: { type: "object", properties: {',
      '    value: { type: "string" },',
      '    mode: { enum: ["fast", "slow"] },',
      '    tags: { type: "array", items: { type: "string" } },',
      '    nested: { type: "object", properties: { count: { type: "integer" } } }',
      '  } },',
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
      '      if (mode === "unexpected-broken-extra") { result(message.id, { tools: [alpha, beta, { name: "rogue", inputSchema: { type: "object", properties: { value: { type: "string", frobnicate: true } } } }] }); continue; }',
      '      if (mode === "missing") { result(message.id, { tools: [alpha] }); continue; }',
      '      if (mode === "duplicate") { result(message.id, { tools: [alpha, alpha, beta] }); continue; }',
      '      if (mode === "invalid-tool") { result(message.id, { tools: [{ ...alpha, title: 42 }, beta] }); continue; }',
      '      if (mode === "unsupported-schema") { result(message.id, { tools: [gamma] }); continue; }',
      '      result(message.id, { tools: [alpha, beta] });',
      '      continue;',
      '    }',
      '    if (message.method === "tools/call") {',
      '      if (mode === "unsupported-schema") {',
      '        writeFileSync(marker, "dispatched");',
      '        result(message.id, { content: [{ type: "text", text: JSON.stringify({ received: message.params.arguments }) }], isError: false });',
      '        continue;',
      '      }',
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

  it('calls an allowed tool with every declared shape filled in, and preserves it', async () => {
    const result = await client.call(config(), 'alpha', {
      value: 'hello',
      mode: 'fast',
      tags: ['a', 'b'],
      nested: { count: 3 }
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0] ?? '{}')).toEqual({
      received: { value: 'hello', mode: 'fast', tags: ['a', 'b'], nested: { count: 3 } }
    });
  });

  /**
   * `validateToolContract` used to check only `required` and
   * `additionalProperties` — a call whose VALUE contradicted the schema's own
   * declared type, enum, array item type or nested property type sailed
   * through unexamined, because neither of those two checks says anything
   * about it. Each case below fails on a schema the shallow check would have
   * accepted outright, and each is refused before the process's stdin is
   * ever written to — see `bounds outbound tool arguments`'s sibling tests
   * for the general "before dispatch" property; this block is about the
   * SHAPE of what stops it.
   */
  it.each([
    ['a type that contradicts the schema', { value: 42 }],
    ['a value outside a declared enum', { mode: 'medium' }],
    ['an array item of the wrong type', { tags: [1, 2] }],
    ['a nested property of the wrong type', { nested: { count: 'three' } }]
  ] as const)('rejects %s before any call reaches the server', async (_what, args) => {
    await expect(client.call(config(), 'alpha', args)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
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

  it('fails closed when the server is missing a required tool', async () => {
    await expect(client.discover(config('missing'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
  });

  it('tolerates an extra tool beyond what was required, rather than refusing the whole server', async () => {
    // 'unexpected' advertises alpha, beta AND a third tool ('rogue') nobody
    // asked for. Required-subset validation is satisfied by alpha+beta alone,
    // so discovery succeeds — a server growing an unrelated capability must
    // not break every integration that never asked for it.
    const discovery = await client.discover(config('unexpected'));
    expect(discovery.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta', 'rogue']);
  });

  it('dispatches a required tool normally even when an unrelated, non-required tool has a schema this client cannot compile', async () => {
    // 'unexpected-broken-extra' advertises alpha+beta (both required, both
    // genuinely valid) plus 'rogue' — nobody's required set — whose schema
    // uses the same unknown keyword the "unknown-keyword" compile-failure
    // case above is refused for. assertSchemaCompiles only iterates
    // config.allowedTools, so rogue's uncompilable schema must never be
    // reached, and alpha must dispatch exactly as if rogue did not exist.
    const response = await client.call(config('unexpected-broken-extra'), 'alpha', { value: 'x' });
    expect(response.isError).toBe(false);
  });

  it('never allows the extra tool to actually be called, tolerated or not', async () => {
    // Required-subset discovery succeeding does not widen what may be
    // invoked: the local allowlist check is unconditional and independent of
    // anything the server additionally advertised.
    await expect(client.call(config('unexpected'), 'rogue', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
  });

  it('rejects duplicate advertised tools even when the required tools are all present', async () => {
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

  /**
   * `validateToolContract` now compiles the discovered schema with a real,
   * maintained JSON Schema 2020-12 validator (Ajv, strict mode) instead of a
   * hand-written subset. The consequence cuts both ways, and both directions
   * are tested here:
   *
   * - A schema this build previously only DETECTED and refused —
   *   `$ref`/`oneOf`/`pattern`/a schema-valued `additionalProperties`/a
   *   correctly-scoped `$dynamicRef` — is now genuinely EVALUATED: a call
   *   that satisfies it dispatches, one that violates it does not. See the
   *   "genuinely supported" block below.
   * - A schema this build cannot compile at all — an unknown keyword
   *   (strict mode), a structurally invalid limit, a malformed `required`
   *   — still refuses before any call reaches the server, whatever
   *   arguments would have been sent. See the `it.each` immediately below.
   *
   * Every rejection is proven not merely by the promise rejecting locally
   * but by the fake server's own `tools/call` marker file staying absent,
   * which only a real dispatch would have created.
   */
  it.each([
    ['an unknown type keyword', 'unknown-type'],
    ['an unrecognised keyword this client has never heard of', 'unknown-keyword'],
    ['a malformed (non-boolean, non-schema) additionalProperties', 'malformed-additionalProperties'],
    ['a tuple-form (prefix) items array — 2020-12 requires prefixItems for tuples', 'tuple-items'],
    ['a non-array "required"', 'malformed-required'],
    ['duplicate entries in "required"', 'duplicate-required'],
    ['a non-array "enum"', 'malformed-enum'],
    ['a non-numeric "minLength"', 'malformed-limits'],
    ['a non-boolean "uniqueItems"', 'malformed-uniqueItems'],
    ['multipleOf: 0', 'multipleOf-zero'],
    ['a negative minLength', 'negative-minLength'],
    ['a fractional minItems', 'fractional-minItems'],
    ['a negative minProperties', 'negative-minProperties']
  ] as const)('refuses to dispatch a required tool whose schema fails to compile (%s), before any call reaches the server', async (_what, construct) => {
    const marker = join(directory, `dispatched-${construct}.marker`);
    const unsupportedConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', construct, marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(unsupportedConfig, 'gamma', { value: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('gives a compile-failure refusal a generic, actionable remediation with no provider-supplied text', async () => {
    const marker = join(directory, 'dispatched-remediation-check.marker');
    const unsupportedConfig = config('unsupported-schema-remediation', {
      args: [serverScript, 'unsupported-schema', 'unknown-keyword', marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(unsupportedConfig, 'gamma', { value: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      remediation: expect.stringContaining('2020-12')
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('still calls a required tool once every construct its schema uses is one this client evaluates', async () => {
    // The negative control for the block above: `gamma` with a FULLY
    // supported schema (numeric and string ranges, minProperties, uniqueItems
    // — none of them on the unsupported list) dispatches normally.
    const marker = join(directory, 'dispatched-supported.marker');
    const supportedConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'supported', marker],
      allowedTools: ['gamma']
    });

    const result = await client.call(supportedConfig, 'gamma', {
      value: 5,
      tags: ['a', 'b']
    });

    expect(result.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * Genuinely SUPPORTED constructs — Ajv compiles these and evaluates them
   * correctly, so whether a call dispatches now depends on whether its
   * arguments actually satisfy the schema, not on the construct's mere
   * presence. Each case sends both a conforming and a violating argument set
   * against the SAME schema, proving real evaluation rather than either
   * blanket rejection or blanket tolerance.
   */
  it.each([
    ['a regex pattern constraint', 'pattern', { value: 'abc' }, { value: 'ABC' }],
    ['a oneOf composition', 'oneOf', { value: 'x' }, { value: true }],
    ['a $ref to a local definition', 'ref', { value: 'x' }, { value: 5 }],
    [
      'a schema-valued additionalProperties',
      'additionalProperties-schema',
      { extra: 'x' },
      { extra: 5 }
    ],
    ['a bare type union', 'type-union', { value: null }, { value: 5 }],
    ['an email format annotation', 'format-email', { value: 'a@b.com' }, { value: 'not-an-email' }]
  ] as const)('genuinely evaluates a required tool whose schema uses %s, dispatching only when the argument conforms', async (_what, construct, good, bad) => {
    const goodMarker = join(directory, `dispatched-${construct}-good.marker`);
    const goodConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', construct, goodMarker],
      allowedTools: ['gamma']
    });
    const result = await client.call(goodConfig, 'gamma', good);
    expect(result.isError).toBe(false);
    expect(existsSync(goodMarker)).toBe(true);

    const badMarker = join(directory, `dispatched-${construct}-bad.marker`);
    const badConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', construct, badMarker],
      allowedTools: ['gamma']
    });
    await expect(client.call(badConfig, 'gamma', bad)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(badMarker)).toBe(false);
  });

  it('genuinely evaluates the idiomatic recursive $dynamicRef/$dynamicAnchor pattern', async () => {
    // The "extensible list" pattern 2020-12 defines $dynamicRef for: `value`
    // may nest arbitrarily many empty arrays, but a non-array leaf violates
    // the recursively re-anchored item schema.
    const goodMarker = join(directory, 'dispatched-dynamic-ref-good.marker');
    const goodConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'dynamic-ref', goodMarker],
      allowedTools: ['gamma']
    });
    const nested = await client.call(goodConfig, 'gamma', { value: [[]] });
    expect(nested.isError).toBe(false);
    expect(existsSync(goodMarker)).toBe(true);

    const badMarker = join(directory, 'dispatched-dynamic-ref-bad.marker');
    const badConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'dynamic-ref', badMarker],
      allowedTools: ['gamma']
    });
    await expect(client.call(badConfig, 'gamma', { value: [1] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(badMarker)).toBe(false);
  });

  /**
   * JSON Schema `minLength`/`maxLength` count UNICODE CODE POINTS, not
   * JavaScript's UTF-16 code units. A single astral character (an emoji
   * outside the Basic Multilingual Plane) is ONE code point but TWO UTF-16
   * units — `"\u{1F600}".length === 2` in JavaScript. A validator using that
   * raw `.length` would wrongly accept it against `minLength: 2` and wrongly
   * refuse it against `maxLength: 1`; the real validator does neither.
   */
  it('counts an astral character as one Unicode code point, not two UTF-16 units, under minLength', async () => {
    const marker = join(directory, 'dispatched-astral-minLength.marker');
    const astralConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'astral-minLength', marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(astralConfig, 'gamma', { value: '\u{1F600}' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('counts an astral character as one Unicode code point, not two UTF-16 units, under maxLength', async () => {
    const marker = join(directory, 'dispatched-astral-maxLength.marker');
    const astralConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'astral-maxLength', marker],
      allowedTools: ['gamma']
    });

    const result = await client.call(astralConfig, 'gamma', { value: '\u{1F600}' });
    expect(result.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * `required` must be checked by OWN-property semantics, never anything
   * that could resolve through the prototype chain. `{}` inherits
   * `constructor` (a function) and `toString` (a function) from
   * `Object.prototype` — a validator fooled by that inheritance would treat
   * an empty object as already satisfying `required: ["constructor",
   * "toString"]`, which is wrong: neither is this object's OWN property.
   */
  it('refuses to dispatch when required properties named "constructor"/"toString" are only inherited, not own', async () => {
    const marker = join(directory, 'dispatched-own-property-required-missing.marker');
    const ownPropertyConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'own-property-required', marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(ownPropertyConfig, 'gamma', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('dispatches when "constructor"/"toString" are sent as genuine own properties', async () => {
    const marker = join(directory, 'dispatched-own-property-required-present.marker');
    const ownPropertyConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'own-property-required', marker],
      allowedTools: ['gamma']
    });

    const result = await client.call(ownPropertyConfig, 'gamma', {
      constructor: 'a string, not the real constructor',
      toString: 'a string, not the real toString'
    });
    expect(result.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A boolean subschema (`true`/`false`) is SUPPORTED, not refused — it is a
   * complete JSON Schema on its own. These cases prove `false` under a
   * property forbids that property outright, and `true` allows anything.
   */
  it('refuses to dispatch when a present property is forbidden by a false subschema, before any call reaches the server', async () => {
    const marker = join(directory, 'dispatched-false-property.marker');
    const falsePropertyConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'false-property', marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(falsePropertyConfig, 'gamma', { value: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('dispatches when the false-subschema property is simply not sent, and when a true subschema allows anything', async () => {
    const omittedMarker = join(directory, 'dispatched-false-property-omitted.marker');
    const omittedConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'false-property', omittedMarker],
      allowedTools: ['gamma']
    });
    const omitted = await client.call(omittedConfig, 'gamma', {});
    expect(omitted.isError).toBe(false);
    expect(existsSync(omittedMarker)).toBe(true);

    const trueMarker = join(directory, 'dispatched-true-property.marker');
    const trueConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'true-property', trueMarker],
      allowedTools: ['gamma']
    });
    const anything = await client.call(trueConfig, 'gamma', { value: { anything: 'goes' } });
    expect(anything.isError).toBe(false);
    expect(existsSync(trueMarker)).toBe(true);
  });

  it('refuses to dispatch a non-empty array where items is the false subschema, but allows an empty one', async () => {
    const marker = join(directory, 'dispatched-false-items.marker');
    const falseItemsConfig = config('unsupported-schema', {
      args: [serverScript, 'unsupported-schema', 'false-items', marker],
      allowedTools: ['gamma']
    });

    await expect(client.call(falseItemsConfig, 'gamma', { value: ['a'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });
    expect(existsSync(marker)).toBe(false);

    const empty = await client.call(falseItemsConfig, 'gamma', { value: [] });
    expect(empty.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});
