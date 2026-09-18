import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgressEvent, AgentRunContext, CodexSpecificationRequest } from '../../src/main/ports';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { CodexSdkAdapter } from '../../src/main/adapters/codex/codex-adapter';
import {
  MAX_STDERR_DIAGNOSTIC_CHARS,
  MAX_TERMINAL_ERROR_CHARS,
  formatTerminalError,
  isAuthenticationFailure,
  parseCodexTerminalError,
  preferTerminalError,
  scrubHomeDirectory,
  splitProcessExit,
  terminalEventMessage
} from '../../src/main/adapters/codex/terminal-error';
import { makeSpecification } from '../helpers/fakes';

const sdk = vi.hoisted(() => ({ events: [] as unknown[], throwAfter: null as Error | null, delayMs: 0 }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return this.thread();
    }
    resumeThread() {
      return this.thread();
    }
    thread() {
      return {
        id: 'thread-spec',
        runStreamed: async () => ({
          events: (async function* () {
            for (const event of sdk.events) yield event;
            // The SDK reports a non-zero exit by throwing once stdout has ended.
            if (sdk.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, sdk.delayMs));
            if (sdk.throwAfter) throw sdk.throwAfter;
          })()
        })
      };
    }
  }
}));

const runner: ProcessRunner = {
  run: async () => {
    throw new Error('unexpected process');
  }
};

const request: CodexSpecificationRequest = {
  projectPath: process.cwd(),
  taskTitle: 'Document the manual test',
  originalRequest: 'Update docs/manual-test.md',
  threadId: null,
  model: null
};

function context(
  events: AgentProgressEvent[],
  options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (event: AgentProgressEvent) => void } = {}
): AgentRunContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 5_000,
    onProgress: (event) => {
      options.onProgress?.(event);
      events.push(event);
    }
  };
}

/** What the CLI really emitted for the failed run: the API's error body, pretty-printed, as a string. */
const INVALID_SCHEMA_MESSAGE =
  "Invalid schema for response_format 'codex_output_schema': In context=(), 'required' is required to be " +
  "supplied and to be an array including every key in properties. Missing 'scopedFilePaths'.";
const INVALID_SCHEMA_EVENT_TEXT = JSON.stringify(
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'invalid_json_schema',
      message: INVALID_SCHEMA_MESSAGE,
      param: 'text.format.schema'
    },
    status: 400
  },
  null,
  2
);

const CACHE_WARNING =
  'ERROR codex_models_manager::manager: failed to load models cache: missing field `supports_parallel_tool_calls` at line 101 column 5';
const HOME = homedir();
const API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';

/** The SDK's process-exit error: everything on stderr, unrelated warnings first. */
function noisyStderr(): string {
  const plugin = 'WARN codex_core_plugins::manifest: ignoring hooks: expected a string, string array, object, or object array; found object';
  return [
    'Reading prompt from stdin...',
    `2026-09-18T22:34:14.689083Z ${CACHE_WARNING}`,
    `2026-09-18T22:34:15.607367Z  ${plugin}`,
    `2026-09-18T22:34:15.627309Z  ${plugin}`,
    `2026-09-18T22:34:15.640001Z  WARN codex_core::config: reading ${HOME}\\.codex\\config.toml`,
    `2026-09-18T22:34:15.650001Z  WARN codex_core::auth: OPENAI_API_KEY=${API_KEY}`
  ].join('\n');
}

const processExit = (stderr: string, code = 1): Error =>
  new Error(`Codex Exec exited with code ${code}: ${stderr}`);

const started = [
  { type: 'thread.started', thread_id: 'thread-spec' },
  { type: 'turn.started' }
];
const structuredFailure = [
  { type: 'error', message: INVALID_SCHEMA_EVENT_TEXT },
  { type: 'turn.failed', error: { message: INVALID_SCHEMA_EVENT_TEXT } }
];
const completed = {
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 }
};

async function failure(events: AgentProgressEvent[], options?: Parameters<typeof context>[1]): Promise<Error & { code?: string }> {
  return new CodexSdkAdapter(runner)
    .createSpecification(request, context(events, options))
    .then(
      () => {
        throw new Error('expected createSpecification to reject');
      },
      (error: Error & { code?: string }) => error
    );
}

beforeEach(() => {
  sdk.events = [];
  sdk.throwAfter = null;
  sdk.delayMs = 0;
});

describe('Codex failure selection: structured terminal error versus process stderr', () => {
  beforeEach(() => {
    sdk.events = [...started, ...structuredFailure];
    sdk.throwAfter = processExit(noisyStderr());
  });

  it('reports the invalid_json_schema cause, not the stderr warning that came first', async () => {
    const error = await failure([]);

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toMatch(/^Codex failed: \[invalid_json_schema\] /);
    expect(error.message).toContain('invalid_json_schema');
    expect(error.message).toContain('scopedFilePaths');
    expect(error.message).toContain('param text.format.schema');
    expect(error.message).toContain('HTTP 400');
    // None of the process noise leaks into what the user is told.
    expect(error.message).not.toContain('models cache');
    expect(error.message).not.toContain('supports_parallel_tool_calls');
    expect(error.message).not.toContain('Reading prompt');
    expect(error.message).not.toContain('Codex Exec exited');
  });

  it('keeps the earlier stderr warning in the run event log as diagnostic evidence', async () => {
    const events: AgentProgressEvent[] = [];
    await failure(events);

    const stderr = events.find((event) => event.type === 'stderr');
    expect(stderr).toBeDefined();
    expect(stderr?.text).toContain('failed to load models cache: missing field `supports_parallel_tool_calls`');
    expect(stderr?.text).toContain('not the failure cause');
    expect(stderr?.data).toEqual({ exit: 'code 1' });

    // The provider's own error events are still in the log, untouched by the choice.
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0]?.text).toContain('invalid_json_schema');
  });

  it('never stores credentials or the home directory, in the error or in the diagnostic', async () => {
    const events: AgentProgressEvent[] = [];
    const error = await failure(events);
    const stored = JSON.stringify([error.message, events]);

    expect(stored).not.toContain(API_KEY);
    expect(stored).not.toContain(HOME);
    expect(stored).not.toContain(HOME.replaceAll('\\', '\\\\'));
    const stderr = events.find((event) => event.type === 'stderr');
    expect(stderr?.text).toContain('OPENAI_API_KEY=[redacted]');
    expect(stderr?.text).toContain('~');
  });

  it('bounds both the message and the stored stderr, however much the provider prints', async () => {
    const events: AgentProgressEvent[] = [];
    sdk.throwAfter = processExit(`${noisyStderr()}\n${'x'.repeat(50_000)}`);
    sdk.events = [
      ...started,
      { type: 'error', message: JSON.stringify({ error: { code: 'too_long', message: 'y'.repeat(50_000) } }) }
    ];

    const error = await failure(events);

    expect(error.message.length).toBeLessThanOrEqual('Codex failed: '.length + MAX_TERMINAL_ERROR_CHARS + 1);
    const stderr = events.find((event) => event.type === 'stderr');
    expect(stderr?.text.length).toBeLessThan(MAX_STDERR_DIAGNOSTIC_CHARS + 500);
  });

  it('still fails with the provider error if recording the diagnostic throws', async () => {
    const error = await failure([], {
      onProgress: (event) => {
        if (event.type === 'stderr') throw new Error('event store unavailable');
      }
    });

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('invalid_json_schema');
    expect(error.message).not.toContain('event store unavailable');
  });

  it('lets a stop or timeout outrank the provider error', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure([], { signal: controller.signal });
    expect(error.code).toBe('CANCELLED');
  });

  it('does not use process noise to classify a structured failure as an authentication problem', async () => {
    sdk.throwAfter = processExit(`${noisyStderr()}\nunauthorized 401 authentication`);
    expect((await failure([])).code).toBe('TOOL_FAILED');
  });

  it('classifies a structured 401 from the provider as an authentication failure', async () => {
    sdk.events = [
      ...started,
      { type: 'error', message: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided.' }, status: 401 }) }
    ];
    const error = await failure([]);
    expect(error.code).toBe('TOOL_UNAUTHENTICATED');
  });

  it('names the cause when the stream ends cleanly after the structured error, with no process throw', async () => {
    sdk.throwAfter = null;
    const error = await failure([]);
    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('invalid_json_schema');
    expect(error.message).toContain('scopedFilePaths');
  });

  it('keeps the structured cause when a generic turn.failed follows it', async () => {
    sdk.events = [
      ...started,
      { type: 'error', message: INVALID_SCHEMA_EVENT_TEXT },
      { type: 'turn.failed', error: { message: 'turn failed' } }
    ];
    const error = await failure([]);
    expect(error.message).toContain('invalid_json_schema');
    expect(error.message).not.toContain('turn failed');
  });

  it('keeps the coded cause when the turn.failed that follows carries only a status', async () => {
    sdk.events = [
      ...started,
      { type: 'error', message: INVALID_SCHEMA_EVENT_TEXT },
      { type: 'turn.failed', error: { message: JSON.stringify({ message: 'turn failed', status: 500 }) } }
    ];
    const error = await failure([]);
    expect(error.message).toContain('invalid_json_schema');
    expect(error.message).not.toContain('turn failed');
  });

  it('lets a later structured report replace an earlier bare one', async () => {
    sdk.events = [
      ...started,
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'turn.failed', error: { message: INVALID_SCHEMA_EVENT_TEXT } }
    ];
    expect((await failure([])).message).toContain('invalid_json_schema');
  });

  it('scrubs the home directory from the raw error events kept in the log', async () => {
    const events: AgentProgressEvent[] = [];
    sdk.events = [...started, { type: 'error', message: `cannot read ${HOME}\\.codex\\config.toml` }];
    await failure(events);
    expect(events.find((event) => event.type === 'error')?.text).toBe('cannot read ~\\.codex\\config.toml');
  });

  it('reports a plain-text terminal message as it is', async () => {
    sdk.events = [...started, { type: 'turn.failed', error: { message: 'stream disconnected before completion' } }];
    const error = await failure([]);
    expect(error.message).toBe('Codex failed: stream disconnected before completion');
  });
});

describe('Codex failure: credentials the provider or the process echoes', () => {
  const BEARER = 'Bearer abcdefghijklmnop123456789';
  const GITHUB = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

  it('removes them from the user-facing error, the raw error events and the stderr diagnostic', async () => {
    const events: AgentProgressEvent[] = [];
    const echoed = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: `Incorrect key ${API_KEY} sent as Authorization: ${BEARER}`,
        param: `header ${GITHUB}`
      },
      status: 400
    });
    sdk.events = [...started, { type: 'error', message: echoed }, { type: 'turn.failed', error: { message: echoed } }];
    sdk.throwAfter = processExit(`${noisyStderr()}\nAuthorization: ${BEARER}\nGITHUB_TOKEN=${GITHUB}`);

    const error = await failure(events);
    const stored = JSON.stringify([error.message, error.details, error.remediation, events]);

    for (const secret of [API_KEY, BEARER, 'abcdefghijklmnop123456789', GITHUB]) {
      expect(stored).not.toContain(secret);
    }
    expect(error.message).toContain('[redacted]');
    expect(events.find((event) => event.type === 'stderr')?.text).toContain('GITHUB_TOKEN=[redacted]');
  });

  it('removes them from a stderr-only fallback as well', async () => {
    const events: AgentProgressEvent[] = [];
    sdk.events = [...started];
    sdk.throwAfter = processExit(`Authorization: ${BEARER}\nGITHUB_TOKEN=${GITHUB}`);

    const error = await failure(events);

    expect(JSON.stringify([error.message, events])).not.toContain(GITHUB);
    expect(JSON.stringify([error.message, events])).not.toContain('abcdefghijklmnop123456789');
  });
});

describe('Codex failure: races and ordering', () => {
  beforeEach(() => {
    sdk.events = [...started, ...structuredFailure];
    sdk.throwAfter = processExit(noisyStderr());
  });

  it('reports a timeout, not the provider error, when the deadline expires first', async () => {
    sdk.delayMs = 80;
    const events: AgentProgressEvent[] = [];

    const error = await failure(events, { timeoutMs: 20 });

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).not.toContain('invalid_json_schema');
    // Nothing is recorded for a failure the user is not told about.
    expect(events.some((event) => event.type === 'stderr')).toBe(false);
  });

  it('reports a stop that lands while the structured failure is streaming as a cancellation', async () => {
    const controller = new AbortController();
    const events: AgentProgressEvent[] = [];

    const error = await failure(events, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === 'error') controller.abort();
      }
    });

    expect(error.code).toBe('CANCELLED');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
  });

  it('still fails a completed turn whose process then exits non-zero, with the process fallback', async () => {
    const events: AgentProgressEvent[] = [];
    sdk.events = [
      ...started,
      { type: 'item.completed', item: { id: 'w', type: 'error', message: `non-fatal: ${CACHE_WARNING}` } },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: JSON.stringify(makeSpecification()) } },
      completed
    ];

    const error = await failure(events);

    // No structured terminal error exists (an error ITEM is a warning, not a terminal event),
    // so the existing fallback applies and the run is not reported as a success.
    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message.startsWith('Codex failed: Codex Exec exited with code 1: Reading prompt')).toBe(true);
    expect(events.find((event) => event.type === 'stderr')?.text).toContain('supports_parallel_tool_calls');
  });

  it('records a diagnostic once per failure, after the raw error events', async () => {
    const events: AgentProgressEvent[] = [];
    await failure(events);

    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'stderr')).toHaveLength(1);
    expect(types.lastIndexOf('error')).toBeLessThan(types.indexOf('stderr'));
  });
});

describe('Codex failure without a structured terminal error', () => {
  it('keeps the existing stderr/process-exit fallback', async () => {
    const events: AgentProgressEvent[] = [];
    sdk.events = [...started];
    sdk.throwAfter = processExit(noisyStderr());

    const error = await failure(events);

    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message.startsWith('Codex failed: Codex Exec exited with code 1: Reading prompt from stdin...')).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual('Codex failed: '.length + 500);
    expect(error.message).toContain('failed to load models cache');
    // The bounded fallback is safe too, and the full stderr is still kept in the log.
    expect(error.message).not.toContain(HOME);
    expect(events.find((event) => event.type === 'stderr')?.text).toContain('OPENAI_API_KEY=[redacted]');
  });

  it('still classifies a stderr-only authentication failure as unauthenticated', async () => {
    sdk.events = [...started];
    sdk.throwAfter = processExit('Reading prompt from stdin...\nunauthorized: not logged in');
    expect((await failure([])).code).toBe('TOOL_UNAUTHENTICATED');
  });

  it('reports a stream that ends before the turn completes', async () => {
    sdk.events = [...started];
    const error = await failure([]);
    expect(error.message).toBe('Codex failed: The stream ended before the turn completed.');
  });
});

describe('Codex runs that succeed despite warnings', () => {
  it('does not fail a completed run whose stream carried a non-fatal error item', async () => {
    const events: AgentProgressEvent[] = [];
    const spec = makeSpecification({ scopedFilePaths: ['docs/manual-test.md'] });
    sdk.events = [
      ...started,
      { type: 'item.completed', item: { id: 'w', type: 'error', message: `failed to load models cache: ${CACHE_WARNING}` } },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: JSON.stringify(spec) } },
      completed
    ];

    const result = await new CodexSdkAdapter(runner).createSpecification(request, context(events));

    expect(result.specification.scopedFilePaths).toEqual(['docs/manual-test.md']);
    expect(events.some((event) => event.type === 'stderr')).toBe(false);
  });

  it('normalizes a specification the model returned without scopedFilePaths', async () => {
    const { scopedFilePaths: _omitted, ...legacyShape } = makeSpecification();
    sdk.events = [
      ...started,
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: JSON.stringify(legacyShape) } },
      completed
    ];

    const result = await new CodexSdkAdapter(runner).createSpecification(request, context([]));

    expect(result.specification.scopedFilePaths).toEqual([]);
  });
});

describe('parseCodexTerminalError', () => {
  it('reads the nested provider error the CLI emitted', () => {
    expect(parseCodexTerminalError(INVALID_SCHEMA_EVENT_TEXT)).toEqual({
      message: INVALID_SCHEMA_MESSAGE,
      code: 'invalid_json_schema',
      type: 'invalid_request_error',
      param: 'text.format.schema',
      status: 400
    });
  });

  it('reads a flat document and a document whose error is a string', () => {
    expect(parseCodexTerminalError('{"message":"boom","code":"E1","status":500}')).toEqual({
      message: 'boom',
      code: 'E1',
      type: undefined,
      param: undefined,
      status: 500
    });
    expect(parseCodexTerminalError('{"type":"error","error":"just text"}').message).toBe('just text');
  });

  it('does not mistake the event discriminator for the error type', () => {
    expect(parseCodexTerminalError('{"type":"error","message":"boom"}').type).toBeUndefined();
    expect(parseCodexTerminalError('{"type":"rate_limit","message":"slow down"}').type).toBe('rate_limit');
  });

  it('unwraps one level of a JSON document carried inside the message', () => {
    const wrapped = JSON.stringify({ message: JSON.stringify({ error: { code: 'inner', message: 'inner message' } }) });
    expect(parseCodexTerminalError(wrapped)).toMatchObject({ message: 'inner message', code: 'inner' });
  });

  it('keeps the raw text when there is no usable message, and never yields "undefined"', () => {
    for (const raw of ['{"type":"error","status":500}', '{"error":{"code":"x"}}', '{"a":', 'plain text', '[1,2]', '{}']) {
      const parsed = parseCodexTerminalError(raw);
      expect(parsed.message).toBe(raw.trim());
      expect(formatTerminalError(parsed)).not.toContain('undefined');
    }
  });

  it('reads the message of either event shape, or nothing', () => {
    expect(terminalEventMessage({ type: 'error', message: 'top' })).toBe('top');
    expect(terminalEventMessage({ type: 'turn.failed', error: { message: 'nested' } })).toBe('nested');
    expect(JSON.parse(terminalEventMessage({ type: 'error', error: { code: 'c' } }) ?? '')).toEqual({ code: 'c' });
    expect(terminalEventMessage({ type: 'error' })).toBeNull();
    expect(terminalEventMessage(null)).toBeNull();
  });
});

describe('preferTerminalError', () => {
  const structured = { message: 'm', code: 'c' };
  const bare = { message: 'turn failed' };

  it('does not let a bare message replace a classified one', () => {
    expect(preferTerminalError(structured, bare)).toBe(structured);
  });

  it('does not let a status-only or type-only report replace a coded one', () => {
    expect(preferTerminalError(structured, { message: 'turn failed', status: 500 })).toBe(structured);
    expect(preferTerminalError(structured, { message: 'turn failed', type: 'server_error', status: 500 })).toBe(structured);
  });

  it('keeps an earlier classified report over a bare one, even without a code', () => {
    const typed = { message: 'm', type: 't', status: 400 };
    expect(preferTerminalError(typed, bare)).toBe(typed);
  });

  it('otherwise takes the later report', () => {
    expect(preferTerminalError(null, bare)).toBe(bare);
    expect(preferTerminalError(bare, structured)).toBe(structured);
    expect(preferTerminalError(bare, { message: 'later' })).toEqual({ message: 'later' });
    expect(preferTerminalError(structured, { message: 'later', code: 'other' })).toEqual({ message: 'later', code: 'other' });
    expect(preferTerminalError({ message: 'a', status: 500 }, { message: 'b', type: 'x' })).toEqual({ message: 'b', type: 'x' });
  });
});

describe('formatTerminalError', () => {
  it('leads with the code and carries the parameter and status', () => {
    expect(formatTerminalError(parseCodexTerminalError(INVALID_SCHEMA_EVENT_TEXT))).toBe(
      `[invalid_json_schema] ${INVALID_SCHEMA_MESSAGE} (param text.format.schema, HTTP 400)`
    );
  });

  it('falls back to the type when there is no code, and to the bare message when there is neither', () => {
    expect(formatTerminalError({ message: 'm', type: 't' })).toBe('[t] m');
    expect(formatTerminalError({ message: 'm' })).toBe('m');
  });

  it('redacts credentials the provider echoes', () => {
    expect(formatTerminalError({ message: `bad key ${API_KEY}` })).not.toContain(API_KEY);
  });
});

describe('isAuthenticationFailure', () => {
  it('trusts the provider status and code only', () => {
    expect(isAuthenticationFailure({ message: 'm', status: 401 })).toBe(true);
    expect(isAuthenticationFailure({ message: 'm', code: 'invalid_api_key' })).toBe(true);
    expect(isAuthenticationFailure({ message: 'unauthorized 401', status: 400, code: 'invalid_json_schema' })).toBe(false);
    // The error type is not the provider's status or code, so it does not send the user to `codex login`.
    expect(isAuthenticationFailure({ message: 'm', type: 'authentication_error', status: 400 })).toBe(false);
    expect(isAuthenticationFailure({ message: 'm', type: 'authentication_error', code: 'invalid_request' })).toBe(false);
  });
});

describe('scrubHomeDirectory', () => {
  it('replaces a Windows home directory in every spelling', () => {
    const home = 'C:\\Users\\alice';
    expect(scrubHomeDirectory('C:\\Users\\alice\\.codex\\x.json', home)).toBe('~\\.codex\\x.json');
    expect(scrubHomeDirectory('c:/users/alice/.codex/x.json', home)).toBe('~/.codex/x.json');
    expect(scrubHomeDirectory('"C:\\\\Users\\\\alice\\\\.codex"', home)).toBe('"~\\\\.codex"');
  });

  it('replaces a POSIX home directory and leaves other text alone', () => {
    expect(scrubHomeDirectory('read /home/alice/.codex/config.toml', '/home/alice')).toBe('read ~/.codex/config.toml');
    expect(scrubHomeDirectory('nothing here', '/home/alice')).toBe('nothing here');
  });

  it('does not eat the front of a longer name that merely starts with the home directory', () => {
    expect(scrubHomeDirectory('/home/alicebob/x and /home/alice/x', '/home/alice')).toBe('/home/alicebob/x and ~/x');
    expect(scrubHomeDirectory('C:\\Users\\alice2\\x', 'C:\\Users\\alice')).toBe('C:\\Users\\alice2\\x');
  });

  it('does nothing for a degenerate home directory', () => {
    expect(scrubHomeDirectory('/etc/passwd', '/')).toBe('/etc/passwd');
    expect(scrubHomeDirectory('/etc/passwd', '')).toBe('/etc/passwd');
  });
});

describe('splitProcessExit', () => {
  it('separates the exit description from the stderr it carries', () => {
    expect(splitProcessExit('Codex Exec exited with code 1: a\nb')).toEqual({ exit: 'code 1', stderr: 'a\nb' });
    expect(splitProcessExit('Codex Exec exited with signal SIGTERM: ')).toEqual({ exit: 'signal SIGTERM', stderr: '' });
  });

  it('ignores any other error', () => {
    expect(splitProcessExit('spawn codex ENOENT')).toBeNull();
  });
});
