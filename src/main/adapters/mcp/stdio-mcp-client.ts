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
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
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
import { computeCoaiContractFingerprint } from './coai-profiles';
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

/**
 * The server does not satisfy what THIS request requires.
 *
 * `config.allowedTools` on a request is a REQUIRED and exclusively-callable
 * set, not a declaration of the server's entire shape. A server is free to
 * advertise any number of tools beyond it — a legacy tool nobody removed yet,
 * a brand new one this build has never heard of, an entirely different
 * integration's capability — and none of that is treated as a mismatch here.
 * Those extra tools are simply never named in a `tools/call` this client
 * sends: `StdioMcpClient.call`'s own allowlist check is unconditional and
 * unaffected by anything the server additionally advertises. That is what
 * lets one compatible capability keep working when the server grows an
 * unrelated one, instead of every integration talking to that server being
 * refused over a change nothing here actually depends on.
 *
 * What IS still refused, unconditionally, because neither is something a
 * caller could safely route around: the server failing to advertise every
 * required name (this specific request cannot be served — refused with
 * `VALIDATION_FAILED`), and the server advertising the same name twice
 * (`tools/list` contradicting itself, which makes nothing in the response
 * trustworthy, not only the tools this request happens to need — refused
 * with `PARSE_FAILED`).
 *
 * A distinct TYPE rather than a code plus a string, because a caller that
 * wants to say something useful about this has to be able to recognise it
 * without reading `details` — and `details` is not safe to read. The same
 * field carries a process's raw stderr for a failed spawn, which can hold an
 * absolute path, an argv or whatever the server chose to print.
 */
export class McpToolProfileMismatchError extends AgentRelayError {
  /**
   * Which required tools the server did not advertise.
   *
   * Taken from the REQUIRED set, which this application supplied, so every
   * string here originates locally. Nothing the server sent is copied into it.
   */
  readonly missing: readonly string[];

  /**
   * How many tools beyond the required set the server also advertised.
   *
   * Informational only — never a reason this is thrown, and never the names:
   * those are the server's own text and belong nowhere near a message an
   * operator is shown. Zero missing tools always means no error at all, so
   * this count is only ever seen alongside a real failure (missing tools, or
   * a duplicate) — it is context for that failure, not an independent one.
   */
  readonly unexpectedCount: number;

  /** The server advertised one name twice. */
  readonly duplicated: boolean;

  /**
   * The server's identity, resolved during `initialize` — strictly before
   * `tools/list` runs, so it is always known by the time this error is built.
   *
   * A mismatch is not a spawn failure: the server answered, and a caller
   * reporting the mismatch (Settings diagnostics, for one) is entitled to say
   * which server it was talking to even though the profile did not match.
   */
  readonly server: ExternalMcpServerIdentity;

  constructor(
    code: 'PARSE_FAILED' | 'VALIDATION_FAILED',
    message: string,
    facts: {
      missing: readonly string[];
      unexpectedCount: number;
      duplicated: boolean;
      server: ExternalMcpServerIdentity;
    }
  ) {
    super(code, message, {
      remediation: 'Review the server update and confirm this request’s required tools before using it.',
      // Safe by construction: local names and a count. It is still not what a
      // caller should render — `missing` is the field for that.
      details: `missing=${facts.missing.join(',') || '-'} unexpected=${facts.unexpectedCount}`
    });
    this.name = 'McpToolProfileMismatchError';
    this.missing = facts.missing;
    this.unexpectedCount = facts.unexpectedCount;
    this.duplicated = facts.duplicated;
    this.server = facts.server;
  }
}

/**
 * Required-subset validation: every name in `requiredNames` must be present
 * and the list must be internally consistent (no duplicate). Tools beyond
 * `requiredNames` are counted for information only and never fail this check
 * — see {@link McpToolProfileMismatchError} for why.
 */
function validateToolSet(
  tools: readonly ExternalMcpTool[],
  requiredNames: readonly string[],
  server: ExternalMcpServerIdentity
): void {
  const actual = tools.map((tool) => tool.name);
  const unique = new Set(actual);
  const unexpectedCount = actual.filter((name) => !requiredNames.includes(name)).length;
  const missing = requiredNames.filter((name) => !unique.has(name));
  if (unique.size !== actual.length) {
    throw new McpToolProfileMismatchError(
      'PARSE_FAILED',
      'The MCP server advertised a duplicate tool name.',
      { missing, unexpectedCount, duplicated: true, server }
    );
  }
  if (missing.length > 0) {
    throw new McpToolProfileMismatchError(
      'VALIDATION_FAILED',
      'The MCP server does not advertise every tool this request requires.',
      { missing, unexpectedCount, duplicated: false, server }
    );
  }
}

/**
 * A fresh, isolated Ajv instance per call — never a shared module-level
 * singleton. Ajv caches a compiled schema by its `$id`, and reusing one
 * instance across many unrelated tool schemas (across repeated calls, in a
 * long-lived process) would let one server's `$id` collide with another's,
 * or a recompiled schema silently reuse a stale cached validator. A fresh
 * instance costs microseconds against a call that already spawns a whole
 * child process, and removes that entire class of cross-call state.
 *
 * `strict: true` is the whole reason this file uses Ajv: it makes Ajv itself
 * refuse to compile a schema that uses a keyword outside the target draft's
 * vocabulary, or a keyword with a structurally invalid value (`multipleOf:
 * 0`, `minItems: -1`, duplicate `required` entries, and everything else the
 * 2020-12 meta-schema itself constrains) — the exact fail-open gap a
 * hand-written subset validator has to enumerate keyword by keyword, and can
 * therefore always miss the next one nobody thought to add. `validateSchema`
 * (Ajv's default `true`) is what makes an explicit, unsupported `$schema`
 * dialect fail to compile too: Ajv2020 only knows the 2020-12 meta-schema, so
 * a tool declaring any other one fails to resolve it and never compiles.
 *
 * `strictTypes: false` is a deliberate, narrow carve-out from `strict`'s
 * default bundle, made after running the official JSON Schema Test Suite
 * (draft2020-12) against this exact configuration: with `strictTypes` at
 * its default, Ajv additionally refuses to compile a bare `type` UNION
 * (`type: ["string", "null"]`, needing `allowUnionTypes`) and any schema
 * that uses `properties`/`items`/etc. WITHOUT a redundant, co-located
 * `type: "object"`/`type: "array"` — both exceedingly common, fully valid,
 * unambiguous JSON Schema patterns that the test suite itself uses
 * throughout, not malformed or unevaluable ones. Disabling `strictTypes`
 * cost 6% of that suite's cases (mostly the deep, annotation-dependent
 * `unevaluatedProperties`/`unevaluatedItems`/`$dynamicRef` scoping rules,
 * not something a tool's argument schema plausibly needs) while gaining
 * ~51 percentage points back on schemas that were being refused for no
 * safety reason. Every OTHER strict sub-check stays on: an unrecognised
 * keyword, `required` naming an undeclared property, and every other
 * malformed construct this build's own tests exercise are still refused.
 *
 * `addFormats` registers the standard `format` vocabulary (`email`, `uri`,
 * `date-time`, `uuid`, and the rest) so a tool schema that uses one of these
 * ordinary, extremely common annotations compiles instead of being refused
 * outright: under `strict: true`, Ajv treats an UNREGISTERED format name as
 * a compile-time error, not a silent no-op, and Ajv's own core ships with no
 * format implementations at all. Without this, any required tool whose
 * schema used `format` would make the whole operation unusable. Applied
 * fresh to each new instance, same as every other Ajv option here.
 */
function schemaValidator(): Ajv2020 {
  return addFormats(new Ajv2020({ strict: true, strictTypes: false }));
}

/**
 * Bounded, safe description of an Ajv compile-time failure.
 *
 * Deliberately generic and NEVER includes the thrown error's own message:
 * Ajv's compile errors are built from the SERVER's own schema (an unknown
 * keyword's name, an invalid limit's value, a `$ref` target) and are exactly
 * the kind of provider-supplied text this module's every other error
 * already refuses to repeat.
 */
function unsafeToCompile(toolName: string): string {
  return `The MCP tool "${toolName}"'s schema could not be safely compiled by this build's JSON Schema validator, so it was refused before any call was made.`;
}

/**
 * Generic on purpose, unlike `unsafeToCompile`'s message: it names no
 * keyword, value or `$ref` from the server's own schema, so it carries none
 * of the provider-supplied text that function's doc comment explains must
 * stay out of a thrown error.
 */
const UNSAFE_TO_COMPILE_REMEDIATION =
  'Inspect the server tool schema for a construct outside the 2020-12 JSON Schema vocabulary, an unresolved $ref, or a structurally invalid keyword value.';

/**
 * Bounded, safe description of the FIRST Ajv validation failure.
 *
 * Built only from `instancePath` (a path into the ARGUMENTS this client
 * itself constructed — property names this build's own adapter code chose,
 * never anything the server sent) and `keyword` (one of a small, fixed JSON
 * Schema vocabulary, e.g. "type"/"required"/"minLength"). Everything else
 * Ajv puts on an error — `message`, `params`, `schemaPath` — can embed a
 * value the SCHEMA declared (an enum member, a numeric limit, a pattern's
 * source text), which is exactly the provider-supplied text this function
 * exists to keep out of a thrown error.
 */
function describeValidationFailure(toolName: string, errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  const where = first === undefined || first.instancePath === '' ? 'its argument' : `its argument${first.instancePath}`;
  const of = first === undefined ? '' : ` its "${first.keyword}" constraint`;
  return `The MCP tool "${toolName}" refused: ${where} does not satisfy${of} the schema now advertises.`;
}

/**
 * Compile-only check: can this client's validator evaluate the tool's schema
 * at all? Used for every REQUIRED tool before any of them is dispatched —
 * see the call site — not only the one about to be called this instant, so
 * a sibling required tool's unsupported schema is caught before a call to a
 * DIFFERENT tool spends a non-idempotent side effect the caller cannot undo.
 */
function assertSchemaCompiles(tool: ExternalMcpTool): void {
  try {
    schemaValidator().compile(tool.inputSchema);
  } catch {
    throw new AgentRelayError('VALIDATION_FAILED', unsafeToCompile(tool.name), {
      remediation: UNSAFE_TO_COMPILE_REMEDIATION
    });
  }
}

/**
 * Does the discovered tool's own advertised schema accept the call this
 * client is about to send — and can this client evaluate that schema at all?
 *
 * A tool being present by NAME (validated above) says nothing about whether
 * its signature is still the one this call was written against — a provider
 * update can add a new required parameter, start rejecting one this build has
 * always sent, tighten a property's type, add an `enum`/`const` constraint,
 * or restructure a nested object or array — without renaming or removing the
 * tool at all. Checked here, against the schema from the SAME discovery this
 * call already paid for, before the non-idempotent `tools/call` is ever sent:
 * a contract violation caught here cost nothing external, the same property
 * `validateToolSet` already has for a missing tool.
 *
 * Compilation runs FIRST and unconditionally — before any argument is even
 * looked at — because a schema this client cannot evaluate is refused
 * regardless of what this particular call happens to send. Skipping that
 * check whenever the call's own arguments happened to satisfy validation
 * would still dispatch against a contract nobody actually verified.
 */
function validateToolContract(tool: ExternalMcpTool, args: Readonly<Record<string, unknown>>): void {
  let validate;
  try {
    validate = schemaValidator().compile(tool.inputSchema);
  } catch {
    throw new AgentRelayError('VALIDATION_FAILED', unsafeToCompile(tool.name), {
      remediation: UNSAFE_TO_COMPILE_REMEDIATION
    });
  }
  if (!validate(args)) {
    throw new AgentRelayError('VALIDATION_FAILED', describeValidationFailure(tool.name, validate.errors));
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
            if (identity === null) {
              throw new AgentRelayError('PARSE_FAILED', 'The MCP server identity was lost during initialization.');
            }
            validateToolSet(tools, config.allowedTools, identity);
            // Every REQUIRED tool's schema must compile — not only the one
            // this particular call is about to invoke. Checking just the
            // target would let a sibling required tool's unsupported schema
            // go unnoticed until the call that finally reaches it, by which
            // point an earlier, DIFFERENT tool in the same operation may
            // already have spent a non-idempotent side effect this client
            // cannot undo.
            for (const name of config.allowedTools) {
              const requiredTool = tools.find((tool) => tool.name === name);
              // Always found: `validateToolSet` above already proved every
              // required name is present among `tools`.
              if (requiredTool !== undefined) assertSchemaCompiles(requiredTool);
            }
            // Scoped to exactly `config.allowedTools` — the caller's own
            // required subset — never the server's full advertised list, so a
            // tool nothing here calls can never move this value. Computed once
            // per session, from the SAME discovery `validateToolSet` just
            // proved, so it is never a separate probe's guess at the contract.
            const contractFingerprint = computeCoaiContractFingerprint({
              protocolVersion: identity.protocolVersion,
              serverName: identity.name,
              serverVersion: identity.version,
              tools,
              requiredToolNames: config.allowedTools
            });
            const discovery = { server: identity, tools, contractFingerprint } satisfies ExternalMcpDiscovery;
            if (callName === null) {
              completed = { discovery, call: null };
              controller.closeInput();
              return;
            }
            // The tool is known present (validateToolSet already required it),
            // so its descriptor is always found here.
            const target = tools.find((tool) => tool.name === callName);
            if (target === undefined) {
              throw new AgentRelayError('INTERNAL', 'The MCP tool to call was not found among discovered tools.');
            }
            validateToolContract(target, callArgs);
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
          // Recomputed rather than threaded through from the `list` phase: a
          // pure, local, deterministic function of `identity`/`tools`/
          // `config.allowedTools`, all still exactly what they were when the
          // list phase first computed it — never a second probe.
          const contractFingerprint = computeCoaiContractFingerprint({
            protocolVersion: identity.protocolVersion,
            serverName: identity.name,
            serverVersion: identity.version,
            tools,
            requiredToolNames: config.allowedTools
          });
          completed = {
            discovery: { server: identity, tools, contractFingerprint },
            call: {
              server: identity,
              tool: selected,
              isError: payload.isError === true,
              content,
              contractFingerprint
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
