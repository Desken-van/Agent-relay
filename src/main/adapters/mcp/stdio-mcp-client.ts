/**
 * A deliberately small MCP client over Agent Relay's existing process boundary.
 *
 * The official SDK owns its own child-process launcher. Using that launcher here
 * would bypass the no-shell, scrubbed-environment, bounded-output and tree-kill
 * guarantees already proved for every other external process in Agent Relay.
 * This adapter therefore implements only the stdio methods INT-A needs:
 * initialize, notifications/initialized, tools/list and tools/call.
 *
 * One process serves one discovery or call and is closed afterwards. Provider
 * workflow state belongs to the provider and may be durable; process lifetime
 * is not treated as session identity.
 */

import { isAbsolute } from 'node:path';
import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpServerIdentity,
  ExternalMcpTool,
  ExternalMcpToolAnnotations
} from '../../ports';
import type {
  InteractiveProcessRunner,
  InteractiveSessionController,
  ProcessResult
} from '../process/process-runner';

const JSONRPC = '2.0';
const PROTOCOL_VERSION = '2024-11-05';
const MAX_TOOLS = 128;
const MAX_LIST_PAGES = 16;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BLOCKS = 128;

type JsonObject = Record<string, unknown>;

interface SessionResult {
  readonly discovery: ExternalMcpDiscovery;
  readonly call: ExternalMcpCallResult | null;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRelayError('PARSE_FAILED', `The MCP server returned an invalid ${label}.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentRelayError('PARSE_FAILED', `The MCP server returned an invalid ${label}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  return value === undefined ? null : string(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new AgentRelayError('PARSE_FAILED', `The MCP server returned an invalid ${label}.`);
  }
  return value;
}

function parseMessage(line: string): JsonObject {
  try {
    return object(JSON.parse(line), 'JSON-RPC message');
  } catch (error) {
    if (error instanceof AgentRelayError) throw error;
    throw new AgentRelayError('PARSE_FAILED', 'The MCP server returned malformed JSON.', {
      cause: error
    });
  }
}

function annotations(value: unknown): ExternalMcpToolAnnotations {
  const source = value === undefined ? {} : object(value, 'tool annotations');
  return {
    readOnly: optionalBoolean(source.readOnlyHint, 'readOnlyHint annotation'),
    destructive: optionalBoolean(source.destructiveHint, 'destructiveHint annotation'),
    idempotent: optionalBoolean(source.idempotentHint, 'idempotentHint annotation'),
    openWorld: optionalBoolean(source.openWorldHint, 'openWorldHint annotation')
  };
}

function parseTool(value: unknown): ExternalMcpTool {
  const source = object(value, 'tool descriptor');
  const inputSchema = object(source.inputSchema, 'tool input schema');
  if (inputSchema.type !== 'object') {
    throw new AgentRelayError('PARSE_FAILED', 'An MCP tool input schema is not an object schema.');
  }
  return {
    name: string(source.name, 'tool name'),
    title: optionalString(source.title, 'tool title'),
    description: optionalString(source.description, 'tool description'),
    inputSchema,
    annotations: annotations(source.annotations)
  };
}

function validateConfig(config: ExternalMcpServerConfig): void {
  if (config.id.trim().length === 0) {
    throw new AgentRelayError('VALIDATION_FAILED', 'An MCP server id is required.');
  }
  if (!isAbsolute(config.executablePath)) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The MCP executable path must be absolute; implicit PATH discovery is not allowed.'
    );
  }
  if (!config.enabled) {
    throw new AgentRelayError('VALIDATION_FAILED', `MCP server "${config.id}" is disabled.`);
  }
  if (config.cwd !== undefined && !isAbsolute(config.cwd)) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP working directory must be absolute.');
  }
  const allowed = new Set(config.allowedTools);
  if (allowed.size !== config.allowedTools.length || [...allowed].some((name) => name.length === 0)) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP tool allowlist contains a duplicate or empty name.');
  }
  if (allowed.size > MAX_TOOLS) {
    throw new AgentRelayError('VALIDATION_FAILED', `At most ${MAX_TOOLS} MCP tools may be allowed.`);
  }
  for (const [label, value] of [
    ['timeoutMs', config.timeoutMs],
    ['maxMessageBytes', config.maxMessageBytes],
    ['maxContentBytes', config.maxContentBytes],
    ['maxContentBlocks', config.maxContentBlocks]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentRelayError('VALIDATION_FAILED', `${label} must be a positive safe integer.`);
    }
  }
  if (config.timeoutMs > MAX_TIMEOUT_MS) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP timeout may not exceed 30 minutes.');
  }
  if (config.maxMessageBytes > MAX_MESSAGE_BYTES) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP message limit may not exceed 2 MiB.');
  }
  if (config.maxContentBytes > MAX_CONTENT_BYTES) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP content limit may not exceed 2 MiB.');
  }
  if (config.maxContentBlocks > MAX_CONTENT_BLOCKS) {
    throw new AgentRelayError('VALIDATION_FAILED', `At most ${MAX_CONTENT_BLOCKS} content blocks may be accepted.`);
  }
}

function validateToolSet(tools: readonly ExternalMcpTool[], allowedNames: readonly string[]): void {
  const actual = tools.map((tool) => tool.name);
  const unique = new Set(actual);
  if (unique.size !== actual.length) {
    throw new AgentRelayError('PARSE_FAILED', 'The MCP server advertised a duplicate tool name.');
  }
  const allowed = new Set(allowedNames);
  const unexpected = actual.filter((name) => !allowed.has(name));
  const missing = allowedNames.filter((name) => !unique.has(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The MCP server tool list does not match the configured allowlist.',
      {
        remediation: 'Review the server update and explicitly update the allowlist before using it.',
        details: `unexpected=${unexpected.join(',') || '-'} missing=${missing.join(',') || '-'}`
      }
    );
  }
}

function request(id: number, method: string, params: JsonObject): string {
  try {
    return JSON.stringify({ jsonrpc: JSONRPC, id, method, params });
  } catch (error) {
    throw new AgentRelayError('VALIDATION_FAILED', `The MCP ${method} request is not JSON-serializable.`, {
      cause: error
    });
  }
}

function notification(method: string): string {
  return JSON.stringify({ jsonrpc: JSONRPC, method });
}

function writeMessage(
  controller: InteractiveSessionController,
  message: string,
  maxMessageBytes: number
): void {
  if (Buffer.byteLength(message, 'utf8') > maxMessageBytes) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The MCP request exceeded its message byte limit.');
  }
  controller.writeLine(message);
}

function responseResult(message: JsonObject, expectedId: number): JsonObject {
  if (message.jsonrpc !== JSONRPC || message.id !== expectedId) {
    throw new AgentRelayError('PARSE_FAILED', 'The MCP server answered an unexpected request id.');
  }
  if (message.error !== undefined) {
    const error = object(message.error, 'JSON-RPC error');
    const detail = typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'Unknown MCP error.';
    throw new AgentRelayError('TOOL_FAILED', `The MCP server refused the protocol request: ${detail}`);
  }
  return object(message.result, 'JSON-RPC result');
}

function processFailure(result: ProcessResult): never {
  if (result.timedOut) {
    throw new AgentRelayError('TIMEOUT', 'The MCP server did not answer before the configured timeout.');
  }
  if (result.cancelled) {
    throw new AgentRelayError('CANCELLED', 'The MCP request was cancelled.');
  }
  throw new AgentRelayError('TOOL_FAILED', 'The MCP server process ended before the request completed.', {
    details: result.stderr || `exitCode=${result.exitCode ?? 'unknown'}`
  });
}

export class StdioMcpClient implements ExternalMcpClient {
  constructor(private readonly runner: InteractiveProcessRunner) {}

  discover(config: ExternalMcpServerConfig, signal?: AbortSignal): Promise<ExternalMcpDiscovery> {
    return this.run(config, null, {}, signal).then((result) => result.discovery);
  }

  call(
    config: ExternalMcpServerConfig,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<ExternalMcpCallResult> {
    if (!config.allowedTools.includes(tool)) {
      return Promise.reject(
        new AgentRelayError('VALIDATION_FAILED', `MCP tool "${tool}" is not in the configured allowlist.`)
      );
    }
    return this.run(config, tool, args, signal).then((result) => {
      if (result.call === null) {
        throw new AgentRelayError('INTERNAL', 'The MCP call completed without a result.');
      }
      return result.call;
    });
  }

  private async run(
    config: ExternalMcpServerConfig,
    callName: string | null,
    callArgs: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<SessionResult> {
    validateConfig(config);
    let protocolError: unknown = null;
    let completed: SessionResult | null = null;
    let identity: ExternalMcpServerIdentity | null = null;
    let tools: ExternalMcpTool[] = [];
    let nextId = 1;
    let expectedId = 1;
    let phase: 'initialize' | 'list' | 'call' = 'initialize';
    let pages = 0;

    const sendList = (controller: InteractiveSessionController, cursor?: string): void => {
      phase = 'list';
      expectedId = ++nextId;
      writeMessage(
        controller,
        request(expectedId, 'tools/list', cursor ? { cursor } : {}),
        config.maxMessageBytes
      );
    };

    const result = await this.runner.runInteractive(config.executablePath, config.args, {
      cwd: config.cwd,
      timeoutMs: config.timeoutMs,
      signal,
      maxOutputBytes: config.maxMessageBytes * 4,
      maxInputMessages: 32,
      maxInputBytes: config.maxMessageBytes * 2,
      onStart: (controller) => {
        writeMessage(
          controller,
          request(1, 'initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'agent-relay', version: '0.1.0' }
          }),
          config.maxMessageBytes
        );
      },
      onStdoutLine: (line, controller) => {
        try {
          if (Buffer.byteLength(line, 'utf8') > config.maxMessageBytes) {
            throw new AgentRelayError('PARSE_FAILED', 'An MCP protocol message exceeded its byte limit.');
          }
          const parsed = parseMessage(line);
          if (parsed.method !== undefined) {
            // Notifications are allowed; server-to-client requests are not,
            // because this client advertises no capabilities for them.
            if (parsed.id !== undefined) {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP server sent an unsupported request.');
            }
            return;
          }

          const payload = responseResult(parsed, expectedId);
          if (phase === 'initialize') {
            const serverInfo = object(payload.serverInfo, 'server identity');
            const capabilities = object(payload.capabilities, 'server capabilities');
            if (
              typeof capabilities.tools !== 'object' ||
              capabilities.tools === null ||
              Array.isArray(capabilities.tools)
            ) {
              throw new AgentRelayError('VALIDATION_FAILED', 'The MCP server did not advertise tool capability.');
            }
            identity = {
              name: string(serverInfo.name, 'server name'),
              version: string(serverInfo.version, 'server version'),
              protocolVersion: string(payload.protocolVersion, 'protocol version')
            };
            if (identity.protocolVersion !== PROTOCOL_VERSION) {
              throw new AgentRelayError(
                'VALIDATION_FAILED',
                `The MCP server negotiated unsupported protocol version "${identity.protocolVersion}".`
              );
            }
            writeMessage(
              controller,
              notification('notifications/initialized'),
              config.maxMessageBytes
            );
            sendList(controller);
            return;
          }

          if (phase === 'list') {
            pages += 1;
            if (pages > MAX_LIST_PAGES) {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP tool list exceeded its page limit.');
            }
            if (!Array.isArray(payload.tools)) {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP tool list is not an array.');
            }
            tools = [...tools, ...payload.tools.map(parseTool)];
            if (tools.length > MAX_TOOLS) {
              throw new AgentRelayError('PARSE_FAILED', `The MCP server advertised more than ${MAX_TOOLS} tools.`);
            }
            if (payload.nextCursor !== undefined && typeof payload.nextCursor !== 'string') {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP tool-list cursor is not a string.');
            }
            const cursor = optionalString(payload.nextCursor, 'tool-list cursor');
            if (cursor !== null) {
              sendList(controller, cursor);
              return;
            }
            validateToolSet(tools, config.allowedTools);
            if (identity === null) {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP server identity was lost during initialization.');
            }
            const discovery = { server: identity, tools } satisfies ExternalMcpDiscovery;
            if (callName === null) {
              completed = { discovery, call: null };
              controller.closeInput();
              return;
            }
            phase = 'call';
            expectedId = ++nextId;
            writeMessage(
              controller,
              request(expectedId, 'tools/call', { name: callName, arguments: callArgs }),
              config.maxMessageBytes
            );
            return;
          }

          const blocks = payload.content;
          if (!Array.isArray(blocks) || blocks.length > config.maxContentBlocks) {
            throw new AgentRelayError('PARSE_FAILED', 'The MCP tool result has an invalid number of content blocks.');
          }
          const content = blocks.map((block) => {
            const item = object(block, 'tool result content block');
            if (item.type !== 'text' || typeof item.text !== 'string') {
              throw new AgentRelayError('PARSE_FAILED', 'Only text MCP tool results are accepted in INT-A.');
            }
            return item.text;
          });
          if (Buffer.byteLength(content.join(''), 'utf8') > config.maxContentBytes) {
            throw new AgentRelayError('PARSE_FAILED', 'The MCP tool result exceeded its content byte limit.');
          }
          if (payload.isError !== undefined && typeof payload.isError !== 'boolean') {
            throw new AgentRelayError('PARSE_FAILED', 'The MCP tool result has an invalid isError flag.');
          }
          const selected = tools.find((tool) => tool.name === callName);
          if (identity === null || selected === undefined) {
            throw new AgentRelayError('PARSE_FAILED', 'The MCP call result did not match a discovered tool.');
          }
          completed = {
            discovery: { server: identity, tools },
            call: {
              server: identity,
              tool: selected,
              isError: payload.isError === true,
              content
            }
          };
          controller.closeInput();
        } catch (error) {
          protocolError = error;
          throw error;
        }
      }
    });

    if (protocolError !== null) throw protocolError;
    if (result.failed || result.exitCode !== 0) processFailure(result);
    if (completed !== null) return completed;
    processFailure(result);
  }
}
