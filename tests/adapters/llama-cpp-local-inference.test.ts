/**
 * `LlamaCppLocalInference` against controlled process and HTTP doubles.
 *
 * These prove the parts that are about *shape*: the argv the adapter would hand
 * to the operating system, the exact JSON it puts on the wire, and how it reads
 * an answer back. The process boundary itself — a real child that has to die, a
 * real socket that can hang — is covered by the process-contract suite, which
 * cannot make these assertions cheaply and should not have to.
 *
 * No real llama.cpp, no model, and no network beyond a stubbed `fetch`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LlamaCppLocalInference,
  type FetchLike,
  type LocalInferenceProcessRunner
} from '../../src/main/adapters/local-inference/llama-cpp-local-inference';
import type {
  ManagedProcess,
  ManagedProcessExit,
  ManagedProcessOptions,
  ManagedProcessStopResult,
  ProcessResult
} from '../../src/main/adapters/process/process-runner';
import { AgentRelayError } from '../../src/shared/domain/errors';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceRequest
} from '../../src/shared/domain/local-inference';
import { ORNITH_ACTION_JSON_SCHEMA } from '../../src/shared/domain/ornith';
import { FAKE_LOCAL_INFERENCE_RUNTIME } from '../helpers/fake-local-inference';

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

const CLEAN_EXIT: ManagedProcessExit = {
  exitCode: 0,
  signal: null,
  spawnFailed: false,
  errorCode: null
};

class StubManagedProcess implements ManagedProcess {
  readonly pid = 4242;
  readonly exited: Promise<ManagedProcessExit>;
  stopCalls = 0;
  /** How many kills actually ran. Two callers joining one attempt leaves this at 1. */
  attempts = 0;
  stopResult: ManagedProcessStopResult | null = null;
  /**
   * When set, a cleanup blocks here until a test releases it.
   *
   * The only way to make the window between "the provider let go of the handle"
   * and "the provider recorded that it is still accountable" observable, and
   * therefore the only way to assert on it deterministically rather than by
   * racing a real kill.
   */
  stopGate: Promise<void> | null = null;

  private settle!: (exit: ManagedProcessExit) => void;
  private done = false;
  private stopping: Promise<ManagedProcessStopResult> | null = null;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  running(): boolean {
    return !this.done;
  }

  output(): { stdout: string; stderr: string } {
    return { stdout: '', stderr: '' };
  }

  /**
   * Mirrors the real `ManagedProcess`: a caller arriving while an attempt is in
   * flight JOINS it instead of starting a second kill, and only a confirmed
   * stop is remembered — an unconfirmed one is released so a later explicit
   * stop can try again.
   */
  stop(): Promise<ManagedProcessStopResult> {
    this.stopCalls += 1;
    this.stopping ??= this.attempt().then((result) => {
      if (result.kind !== 'stopped') this.stopping = null;
      return result;
    });
    return this.stopping;
  }

  private async attempt(): Promise<ManagedProcessStopResult> {
    this.attempts += 1;
    if (this.stopGate !== null) await this.stopGate;
    if (this.stopResult !== null) return this.stopResult;
    this.end(CLEAN_EXIT);
    return { kind: 'stopped', exit: await this.exited };
  }

  end(exit: ManagedProcessExit): void {
    if (this.done) return;
    this.done = true;
    this.settle(exit);
  }
}

interface RecordedLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ManagedProcessOptions | undefined;
}

class StubRunner implements LocalInferenceProcessRunner {
  readonly runs: { file: string; args: readonly string[] }[] = [];
  readonly launches: RecordedLaunch[] = [];
  readonly processes: StubManagedProcess[] = [];
  versionOverride: Partial<ProcessResult> = {};

  async run(file: string, args: readonly string[]): Promise<ProcessResult> {
    this.runs.push({ file, args: [...args] });
    return {
      command: 'stub',
      exitCode: 0,
      stdout: '',
      stderr: 'version: 4321 (stub)',
      timedOut: false,
      cancelled: false,
      durationMs: 1,
      failed: false,
      ...this.versionOverride
    };
  }

  launch(file: string, args: readonly string[], options?: ManagedProcessOptions): ManagedProcess {
    this.launches.push({ file, args: [...args], options });
    const child = new StubManagedProcess();
    this.processes.push(child);
    return child;
  }
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler): { calls: FetchCall[]; fetchImpl: FetchLike } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    }
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const HEALTHY: Handler = () => json({ status: 'ok' });

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
    ...overrides
  };
}

/* -------------------------------------------------------------------------- */
/* Provider construction                                                       */
/* -------------------------------------------------------------------------- */

const PORT = 45_678;

function configFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    providerId: 'local-stub',
    executable: { kind: 'explicit_path', path: FAKE_LOCAL_INFERENCE_RUNTIME },
    model: { id: 'ornith-8b', source: { kind: 'runtime_id', runtimeModelId: 'ornith-8b-q4' } },
    port: PORT,
    fixedArguments: ['--threads', '2'],
    contextLimitTokens: 4096,
    maxOutputTokens: 256,
    maxPromptBytes: 1_000,
    maxRequestBytes: 2_000,
    maxResponseBytes: 2_000,
    maxCompletionBytes: 1_000,
    maxProcessOutputBytes: 8_000,
    startupTimeoutMs: 5_000,
    healthTimeoutMs: 1_000,
    inferenceTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): LocalInferenceRequest {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    requestId: 'req-1',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  } as unknown as LocalInferenceRequest;
}

interface Harness {
  readonly provider: LlamaCppLocalInference;
  readonly runner: StubRunner;
  readonly calls: FetchCall[];
}

function harness(handler: Handler, overrides: Record<string, unknown> = {}): Harness {
  const runner = new StubRunner();
  const { calls, fetchImpl } = stubFetch(handler);
  // A monotonic fake clock: durations are real numbers without a real wait.
  let clock = 1_000;
  const provider = new LlamaCppLocalInference(runner, configFor(overrides), {
    fetch: fetchImpl,
    now: () => (clock += 5)
  });
  return { provider, runner, calls };
}

/** A provider that has been started against a health endpoint that answers. */
async function started(handler: Handler, overrides: Record<string, unknown> = {}): Promise<Harness> {
  const built = harness(
    (url, init) => (url.endsWith('/health') ? json({ status: 'ok' }) : handler(url, init)),
    overrides
  );
  const state = await built.provider.start();
  expect(state.kind).toBe('healthy');
  return built;
}

function posts(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => call.url.endsWith('/v1/chat/completions'));
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

describe('local inference capabilities', () => {
  it('reports the contract, the model id and an unverified inference', async () => {
    const { provider, runner } = harness(HEALTHY);
    const capabilities = await provider.capabilities();

    expect(capabilities.protocol).toBe('agent-relay.local-inference');
    expect(capabilities.contractVersion).toBe(1);
    expect(capabilities.modelId).toBe('ornith-8b');
    expect(capabilities.available).toBe(true);
    expect(capabilities.runtimeVersion).toBe('version: 4321 (stub)');
    expect(capabilities.supportsStreaming).toBe(false);
    expect(capabilities.supportsChatTemplateParameters).toBe(true);
    // The whole point: a banner is not evidence about inference.
    expect(capabilities.inferenceVerified).toBe(false);

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.args.at(-1)).toBe('--version');
    // Discovery and the version probe start no server.
    expect(runner.launches).toHaveLength(0);
  });

  it('reports no runtime version when the probe fails, without claiming unavailable', async () => {
    const { provider, runner } = harness(HEALTHY);
    runner.versionOverride = { exitCode: 1, stderr: 'boom' };

    const capabilities = await provider.capabilities();
    expect(capabilities.available).toBe(true);
    expect(capabilities.runtimeVersion).toBeNull();
  });

  it('becomes unavailable when a configured executable is absent', async () => {
    const missing =
      process.platform === 'win32' ? 'C:\\nowhere\\llama-server.exe' : '/nowhere/llama-server';
    const { provider, runner } = harness(HEALTHY, {
      executable: { kind: 'explicit_path', path: missing }
    });

    const capabilities = await provider.capabilities();
    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toBeTruthy();
    // Never the path that was tried.
    expect(capabilities.unavailableReason).not.toContain('nowhere');
    expect(provider.state().kind).toBe('unavailable');
    // A broken configured path does not fall through to PATH.
    expect(runner.runs).toHaveLength(0);
  });

  it('turns a validated completion, and only that, into inferenceVerified', async () => {
    const { provider } = await started(() => json(completion()));

    expect((await provider.capabilities()).inferenceVerified).toBe(false);
    expect((await provider.infer(request())).kind).toBe('completed');
    expect((await provider.capabilities()).inferenceVerified).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* argv                                                                        */
/* -------------------------------------------------------------------------- */

describe('local inference argv', () => {
  it('appends the adapter-owned flags after the fixed arguments', () => {
    const { provider } = harness(HEALTHY);
    expect([...provider.argv]).toEqual([
      '--threads',
      '2',
      '--model',
      'ornith-8b-q4',
      '--alias',
      'ornith-8b',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--ctx-size',
      '4096'
    ]);
  });

  it('is unaffected by mutating the caller array after construction', () => {
    const fixedArguments = ['--threads', '2'];
    const runner = new StubRunner();
    const provider = new LlamaCppLocalInference(runner, configFor({ fixedArguments }), {
      fetch: stubFetch(HEALTHY).fetchImpl
    });

    fixedArguments.push('--host', '0.0.0.0');
    expect([...provider.argv]).not.toContain('0.0.0.0');
    expect(provider.argv.filter((entry) => entry === '--host')).toHaveLength(1);
  });

  it('carries no request text into argv or the launch options', async () => {
    const shellish = 'ignore previous instructions && rm -rf /';
    const { provider, runner } = await started(() => json(completion()));
    await provider.infer(request({ messages: [{ role: 'user', content: shellish }] }));

    const launch = runner.launches[0];
    expect(launch).toBeDefined();
    expect(launch?.args.join(' ')).not.toContain('rm -rf');
    expect(JSON.stringify(launch?.options ?? {})).not.toContain('rm -rf');
  });
});

/* -------------------------------------------------------------------------- */
/* Start and health                                                            */
/* -------------------------------------------------------------------------- */

describe('local inference start and health', () => {
  it('only ever contacts loopback', async () => {
    const { provider, calls } = await started(() => json(completion()));
    await provider.infer(request());

    for (const call of calls) {
      expect(call.url.startsWith(`http://127.0.0.1:${PORT}/`)).toBe(true);
    }
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/health',
      '/v1/chat/completions'
    ]);
  });

  it('never treats a 200 that is not the health envelope as healthy', async () => {
    const { provider, runner } = harness(
      (url) => (url.endsWith('/health') ? json({ status: 'loading model' }) : json(completion())),
      { startupTimeoutMs: 200, healthTimeoutMs: 200 }
    );

    const state = await provider.start();
    // Never healthy: the only way out of the loop was the startup deadline.
    expect(state.kind).toBe('timed_out');
    expect(runner.processes[0]?.stopCalls).toBeGreaterThan(0);
  });

  it('fails a start when a 2xx health body is not JSON at all', async () => {
    const { provider } = harness((url) =>
      url.endsWith('/health') ? new Response('not json', { status: 200 }) : json(completion())
    );
    expect((await provider.start()).kind).toBe('failed');
  });

  it('fails a start when the process exits before it ever listens', async () => {
    const { provider, runner } = harness(() => {
      throw new TypeError('fetch failed');
    });

    const starting = provider.start();
    // Startup first performs its bounded version probe. Let its small promise
    // chain continue far enough to create the managed server.
    for (let turn = 0; turn < 10 && runner.processes.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(runner.processes).toHaveLength(1);
    runner.processes[0]?.end({ exitCode: 3, signal: null, spawnFailed: false, errorCode: null });

    expect((await starting).kind).toBe('failed');
    expect(provider.state().kind).toBe('failed');
  });

  it('does not accept a healthy response from a process that exited concurrently', async () => {
    const observed: { runner: StubRunner | null } = { runner: null };
    const built = harness(() => {
      observed.runner?.processes[0]?.end({
        exitCode: 4,
        signal: null,
        spawnFailed: false,
        errorCode: null
      });
      return json({ status: 'ok' });
    });
    observed.runner = built.runner;

    expect((await built.provider.start()).kind).toBe('failed');
  });

  it('requires one successful bounded version probe before launching the server', async () => {
    const { provider, runner, calls } = harness(HEALTHY);
    runner.versionOverride = { exitCode: 2, failed: true };

    expect((await provider.start()).kind).toBe('failed');
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.args.at(-1)).toBe('--version');
    expect(runner.launches).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses a second start while one runtime is up, launching nothing', async () => {
    const { provider, runner } = await started(() => json(completion()));
    await expect(provider.start()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(runner.launches).toHaveLength(1);
  });

  it('refuses a health check outside healthy, sending nothing', async () => {
    const { provider, calls } = harness(HEALTHY);
    await expect(provider.health()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(calls).toHaveLength(0);
  });

  it('fails and stops the runtime when an explicit health check is malformed', async () => {
    let checks = 0;
    const { provider, runner } = harness((url) => {
      if (!url.endsWith('/health')) return json(completion());
      checks += 1;
      return checks === 1 ? json({ status: 'ok' }) : new Response('{', { status: 200 });
    });

    expect((await provider.start()).kind).toBe('healthy');
    expect((await provider.health()).kind).toBe('failed');
    expect(runner.processes[0]?.stopCalls).toBeGreaterThan(0);
  });

  it('stays healthy when an explicit health check answers correctly', async () => {
    const { provider } = await started(() => json(completion()));
    expect((await provider.health()).kind).toBe('healthy');
  });
});

/* -------------------------------------------------------------------------- */
/* Inference request                                                           */
/* -------------------------------------------------------------------------- */

describe('local inference request', () => {
  it('sends exactly one non-streaming chat completion with the stable model id', async () => {
    const { provider, calls } = await started(() => json(completion()));
    await provider.infer(request());

    const post = posts(calls)[0];
    expect(post?.init.method).toBe('POST');
    const body = JSON.parse(String(post?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'ornith-8b',
      stream: false,
      n: 1,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }]
    });
    // Never the machine-local model source.
    expect(JSON.stringify(body)).not.toContain('ornith-8b-q4');
    expect('chat_template_kwargs' in body).toBe(false);
    expect('response_format' in body).toBe(false);
  });

  it('lowers but never raises the configured output cap', async () => {
    const { provider, calls } = await started(() => json(completion()));
    await provider.infer(request({ maxOutputTokens: 4 }));
    await provider.infer(request({ requestId: 'req-2', maxOutputTokens: 100_000 }));

    const sent = posts(calls);
    expect(JSON.parse(String(sent[0]?.init.body)).max_tokens).toBe(4);
    expect(JSON.parse(String(sent[1]?.init.body)).max_tokens).toBe(256);
  });

  it('passes chat template parameters through, false included', async () => {
    const { provider, calls } = await started(() => json(completion()));
    await provider.infer(
      request({ chatTemplateParameters: { enable_thinking: false, preserve_thinking: true } })
    );

    expect(JSON.parse(String(posts(calls)[0]?.init.body)).chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: true
    });
  });

  it('maps the closed Ornith profile to a strict runtime-owned JSON schema', async () => {
    const { provider, calls } = await started(() => json(completion()), { maxRequestBytes: 50_000 });
    await provider.infer(request({ structuredOutput: 'ornith_action_v1' }));

    expect(JSON.parse(String(posts(calls)[0]?.init.body)).response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'ornith_action_v1',
        strict: true,
        schema: ORNITH_ACTION_JSON_SCHEMA
      }
    });
  });

  it('omits chat_template_kwargs when the configured default is empty', async () => {
    const { provider, calls } = await started(() => json(completion()), {
      defaultChatTemplateParameters: {}
    });
    await provider.infer(request());

    expect('chat_template_kwargs' in JSON.parse(String(posts(calls)[0]?.init.body))).toBe(false);
  });

  it('applies the configured default only when the request supplies none, false and zero intact', async () => {
    const { provider, calls } = await started(() => json(completion()), {
      defaultChatTemplateParameters: { enable_thinking: false, preserve_thinking: false, budget: 0 }
    });
    await provider.infer(request());

    expect(JSON.parse(String(posts(calls)[0]?.init.body)).chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
      budget: 0
    });
  });

  it('lets a request-supplied map override the configured default entirely', async () => {
    const { provider, calls } = await started(() => json(completion()), {
      defaultChatTemplateParameters: { enable_thinking: false }
    });
    await provider.infer(request({ chatTemplateParameters: { style: 'concise' } }));

    expect(JSON.parse(String(posts(calls)[0]?.init.body)).chat_template_kwargs).toEqual({
      style: 'concise'
    });
  });

  it('refuses an invalid request before dispatching or moving state', async () => {
    const { provider, calls } = await started(() => json(completion()));
    const before = calls.length;

    await expect(provider.infer(request({ messages: [] }))).rejects.toBeInstanceOf(AgentRelayError);
    expect(calls).toHaveLength(before);
    expect(provider.state().kind).toBe('healthy');
  });

  it('refuses to dispatch a prompt over the byte limit', async () => {
    const { provider, calls } = await started(() => json(completion()));
    const before = calls.length;

    const outcome = await provider.infer(
      request({ messages: [{ role: 'user', content: 'p'.repeat(1_500) }] })
    );
    expect(outcome).toMatchObject({ kind: 'failed', dispatchOutcome: 'not_dispatched' });
    expect(calls).toHaveLength(before);
    // Nothing was sent, so the runtime is untouched and still usable.
    expect(provider.state().kind).toBe('healthy');
  });

  it('refuses inference unless healthy, sending nothing', async () => {
    const { provider, calls } = harness(HEALTHY);
    await expect(provider.infer(request())).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Inference response                                                          */
/* -------------------------------------------------------------------------- */

describe('local inference response', () => {
  it('returns the request identity, the stable model id and a duration', async () => {
    const { provider } = await started(() => json(completion()));
    const outcome = await provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response).toMatchObject({
      version: 1,
      requestId: 'req-1',
      providerId: 'local-stub',
      modelId: 'ornith-8b',
      completion: 'hello',
      promptTokens: 5,
      completionTokens: 2,
      runtimeResponseId: 'chatcmpl-1',
      finishReason: { kind: 'stop' }
    });
    expect(outcome.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.response.runtimeInstanceId).toMatch(/^rt[0-9a-f]+$/);
  });

  it('returns null token counts and an explicit unknown finish reason when absent', async () => {
    const { provider } = await started(() =>
      json({ choices: [{ message: { role: 'assistant', content: 'hi' } }] })
    );
    const outcome = await provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.promptTokens).toBeNull();
    expect(outcome.response.completionTokens).toBeNull();
    expect(outcome.response.runtimeResponseId).toBeNull();
    // Not zero, and emphatically not `stop`.
    expect(outcome.response.finishReason).toEqual({ kind: 'unknown' });
  });

  it('reports an unrecognised finish reason as other rather than stop', async () => {
    const { provider } = await started(() =>
      json({
        choices: [
          { message: { role: 'assistant', content: 'hi' }, finish_reason: 'abort_from_runtime' }
        ]
      })
    );
    const outcome = await provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.finishReason).toEqual({ kind: 'other', reason: 'abort_from_runtime' });
  });

  it('tolerates additional llama.cpp fields', async () => {
    const { provider } = await started(() =>
      json(completion({ timings: { predicted_ms: 3 }, slot_id: 0 }))
    );
    expect((await provider.infer(request())).kind).toBe('completed');
  });

  it('redacts credential-shaped completion text', async () => {
    const { provider } = await started(() =>
      json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 here'
            }
          }
        ]
      })
    );
    const outcome = await provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.completion).not.toContain('ghp_');
    expect(outcome.response.completion).toContain('[redacted]');
  });

  const rejections: readonly { name: string; response: Handler; dispatch: string }[] = [
    { name: 'a non-2xx answer', response: () => json({ error: 'nope' }, 500), dispatch: 'rejected' },
    {
      name: 'malformed JSON',
      response: () => new Response('{"choices": [', { status: 200 }),
      dispatch: 'unknown'
    },
    { name: 'no usable choice', response: () => json({ choices: [] }), dispatch: 'unknown' },
    {
      name: 'two choices',
      response: () =>
        json({
          choices: [
            { message: { role: 'assistant', content: 'a' } },
            { message: { role: 'assistant', content: 'b' } }
          ]
        }),
      dispatch: 'unknown'
    },
    {
      name: 'a missing content field',
      response: () => json({ choices: [{ message: { role: 'assistant' } }] }),
      dispatch: 'unknown'
    },
    {
      name: 'an invalid token count',
      response: () =>
        json({
          choices: [{ message: { role: 'assistant', content: 'a' } }],
          usage: { prompt_tokens: -1 }
        }),
      dispatch: 'unknown'
    },
    {
      name: 'an unsafe runtime model identity',
      response: () =>
        json({
          model: 'unsafe\u001b[31m-model',
          choices: [{ message: { role: 'assistant', content: 'a' } }]
        }),
      dispatch: 'unknown'
    },
    {
      name: 'a body over the response limit',
      response: () =>
        json({
          choices: [{ message: { role: 'assistant', content: 'a' } }],
          pad: 'p'.repeat(4_000)
        }),
      dispatch: 'unknown'
    },
    {
      name: 'a completion over the completion limit',
      response: () =>
        json({ choices: [{ message: { role: 'assistant', content: 'c'.repeat(1_500) } }] }),
      dispatch: 'unknown'
    }
  ];

  for (const rejection of rejections) {
    it(`reports ${rejection.name} as a failure carrying no completion`, async () => {
      const { provider, calls, runner } = await started(rejection.response);
      const outcome = await provider.infer(request());

      expect(outcome.kind).toBe('failed');
      expect(outcome).not.toHaveProperty('response');
      if (outcome.kind === 'completed') return;
      expect(outcome.dispatchOutcome).toBe(rejection.dispatch);
      expect(outcome.requestId).toBe('req-1');

      // Exactly one POST, and the runtime is taken down rather than reused.
      expect(posts(calls)).toHaveLength(1);
      expect(runner.processes[0]?.stopCalls).toBeGreaterThan(0);
      expect(['failed', 'cancelled', 'timed_out']).toContain(provider.state().kind);
    });
  }

  it('never retries, and never restarts, after an unknown dispatch outcome', async () => {
    const { provider, calls } = await started(() => {
      throw new TypeError('connection reset');
    });
    const outcome = await provider.infer(request());

    expect(outcome.kind).not.toBe('completed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(posts(calls)).toHaveLength(1);

    // A second attempt is refused outright rather than quietly restarting.
    await expect(provider.infer(request({ requestId: 'req-2' }))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION'
    });
    expect(posts(calls)).toHaveLength(1);
  });

  it('does not accept a completion from a process that exited concurrently', async () => {
    const observed: { runner: StubRunner | null } = { runner: null };
    const built = harness((url) => {
      if (url.endsWith('/health')) return json({ status: 'ok' });
      observed.runner?.processes[0]?.end({
        exitCode: 8,
        signal: null,
        spawnFailed: false,
        errorCode: null
      });
      return json(completion());
    });
    observed.runner = built.runner;
    expect((await built.provider.start()).kind).toBe('healthy');

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */
/* Stop                                                                        */
/* -------------------------------------------------------------------------- */

describe('local inference stop', () => {
  it('is idempotent and starts nothing on repetition', async () => {
    const { provider, runner, calls } = await started(() => json(completion()));
    const before = calls.length;

    expect((await provider.stop()).kind).toBe('stopped');
    expect((await provider.stop()).kind).toBe('stopped');
    expect((await provider.stop()).kind).toBe('stopped');

    expect(runner.launches).toHaveLength(1);
    expect(runner.processes[0]?.stopCalls).toBe(1);
    expect(calls).toHaveLength(before);
  });

  it('shares one cleanup between concurrent callers', async () => {
    const { provider, runner } = await started(() => json(completion()));
    const [first, second] = await Promise.all([provider.stop(), provider.stop()]);

    expect(first?.kind).toBe('stopped');
    expect(second?.kind).toBe('stopped');
    expect(runner.processes[0]?.stopCalls).toBe(1);
  });

  it('reports failed rather than stopped when cleanup cannot be confirmed', async () => {
    const { provider, runner } = await started(() => json(completion()));
    const managed = runner.processes[0];
    expect(managed).toBeDefined();
    if (managed === undefined) return;
    managed.stopResult = {
      kind: 'unconfirmed',
      reason: 'The fake process did not confirm exit.'
    };

    const state = await provider.stop();
    expect(state.kind).toBe('failed');
    expect(managed.stopCalls).toBe(1);
  });

  it('is safe from a state that never had a runtime', async () => {
    const { provider, runner } = harness(HEALTHY);
    expect((await provider.stop()).kind).toBe('stopped');
    expect(runner.launches).toHaveLength(0);
  });

  it('can be started again after an explicit stop', async () => {
    const { provider, runner } = await started(() => json(completion()));
    await provider.stop();
    expect((await provider.start()).kind).toBe('healthy');
    expect(runner.launches).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* An unconfirmed stop does not release the runtime                            */
/* -------------------------------------------------------------------------- */

describe('local inference: a runtime that could not be confirmed stopped', () => {
  const UNCONFIRMED: ManagedProcessStopResult = {
    kind: 'unconfirmed',
    reason: 'The runtime process did not exit within 2000ms of being terminated.'
  };

  /**
   * The defect this closes: the handle was dropped as soon as `stop()` returned,
   * even when it returned `unconfirmed`. The state became `failed`, from which
   * `start` is legal, so the next start launched a second runtime while the
   * first was still alive and still holding the port.
   *
   * These assert on the things that make that real — how many processes were
   * launched, how many times each was asked to stop, and whether the first one
   * is still running — rather than on the name of a state.
   */
  it('keeps the process and refuses to start a second one beside it', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;
    first.stopResult = UNCONFIRMED;

    const state = await built.provider.stop();
    expect(state.kind).toBe('failed');

    // The evidence, not the label: that process is still running.
    expect(first.running()).toBe(true);
    expect(first.stopCalls).toBe(1);

    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });

    // Nothing was launched beside it, and nothing was asked of it twice.
    expect(built.runner.launches).toHaveLength(1);
    expect(built.runner.processes).toHaveLength(1);
    expect(first.running()).toBe(true);
  });

  it('does not call a repeated stop successful just because the handle was dropped', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;
    first.stopResult = UNCONFIRMED;

    expect((await built.provider.stop()).kind).toBe('failed');
    const again = await built.provider.stop();

    // "We lost the reference" is not "it ended".
    expect(again.kind).toBe('failed');
    expect(again.kind).not.toBe('stopped');
    // And the retry went to THAT process, not to nothing.
    expect(first.stopCalls).toBe(2);
    expect(first.running()).toBe(true);
  });

  it('lets a start through again once a later stop confirms the runtime ended', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;
    first.stopResult = UNCONFIRMED;
    expect((await built.provider.stop()).kind).toBe('failed');

    // The process finally goes away, and the next stop can prove it.
    first.stopResult = null;
    const confirmed = await built.provider.stop();

    expect(confirmed.kind).toBe('stopped');
    expect(first.running()).toBe(false);

    const restarted = await built.provider.start();
    expect(restarted.kind).toBe('healthy');
    expect(built.runner.launches).toHaveLength(2);
  });

  it('keeps the process when a health failure cleans up unconfirmed', async () => {
    // `settle` is the other place the handle used to be dropped unconditionally.
    let healthy = true;
    const built = harness((url) =>
      url.endsWith('/health')
        ? healthy
          ? json({ status: 'ok' })
          : json({ status: 'loading model' })
        : json(completion())
    );
    expect((await built.provider.start()).kind).toBe('healthy');
    const first = built.runner.processes[0]!;
    first.stopResult = UNCONFIRMED;
    healthy = false;

    const state = await built.provider.health();

    expect(state.kind).toBe('failed');
    expect(first.running()).toBe(true);
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
    expect(built.runner.launches).toHaveLength(1);
  });

  it('keeps ownership when the parent exits and the tree cleanup is unconfirmed', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;
    first.stopResult = UNCONFIRMED;

    // The parent ends on its own. That says nothing about its descendants, so
    // the cleanup that follows is what decides — and it could not confirm.
    first.end(CLEAN_EXIT);
    for (let i = 0; i < 200 && built.provider.state().kind !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(built.provider.state().kind).toBe('failed');
    expect(first.stopCalls).toBeGreaterThanOrEqual(1);
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
    expect(built.runner.launches).toHaveLength(1);
  });

  it('keeps an unretired process stoppable after executable discovery fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-relay-unretired-'));
    const executable = join(directory, 'runtime.mjs');
    writeFileSync(executable, 'setInterval(() => {}, 1000);', 'utf8');

    try {
      const built = harness(HEALTHY, {
        executable: { kind: 'explicit_path', path: executable }
      });
      expect((await built.provider.start()).kind).toBe('healthy');
      const first = built.runner.processes[0]!;
      first.stopResult = UNCONFIRMED;
      expect((await built.provider.stop()).kind).toBe('failed');

      // Discovery now fails, but it must not overwrite the lifecycle evidence
      // for the process the provider still owns.
      rmSync(executable, { force: true });
      const capabilities = await built.provider.capabilities();
      expect(capabilities.available).toBe(false);
      expect(built.provider.state().kind).toBe('failed');

      // A later stop still reaches that exact process and can retire it.
      first.stopResult = null;
      expect((await built.provider.stop()).kind).toBe('stopped');
      expect(first.stopCalls).toBe(2);
      expect(first.running()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves the ordinary lifecycle untouched, with no repeated inference', async () => {
    const built = await started(() => json(completion()));

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('completed');
    const posts = built.calls.filter((call) => call.init.method === 'POST');
    expect(posts).toHaveLength(1);

    expect((await built.provider.stop()).kind).toBe('stopped');
    expect(built.runner.processes[0]!.running()).toBe(false);

    const restarted = await built.provider.start();
    expect(restarted.kind).toBe('healthy');
    expect(built.runner.launches).toHaveLength(2);

    // Still exactly one POST: restarting never replays a request.
    expect(built.calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    expect((await built.provider.stop()).kind).toBe('stopped');
  });

  it('shares one cleanup between concurrent stops', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;

    const [one, two] = await Promise.all([built.provider.stop(), built.provider.stop()]);

    expect(one.kind).toBe('stopped');
    expect(two.kind).toBe('stopped');
    // One cleanup, not two kills.
    expect(first.stopCalls).toBe(1);
    expect(built.runner.launches).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* An explicit stop that arrives during an automatic cleanup                   */
/* -------------------------------------------------------------------------- */

describe('local inference: a stop that races an automatic cleanup', () => {
  const UNCONFIRMED_RESULT: ManagedProcessStopResult = {
    kind: 'unconfirmed',
    reason: 'The runtime process did not exit within 2000ms of being terminated.'
  };

  /** A cleanup a test can hold open for as long as it likes. */
  function gate(): { readonly promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /** Let queued microtasks and one macrotask turn run. */
  async function turn(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Whether `promise` is still unsettled after a turn. */
  async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await turn();
    return !settled;
  }

  /** Healthy on demand, then reporting a runtime that is only loading. */
  function harnessWithFailingHealth(): {
    built: Harness;
    fail: () => void;
    recover: () => void;
  } {
    let healthy = true;
    const built = harness((url) =>
      url.endsWith('/health')
        ? healthy
          ? json({ status: 'ok' })
          : json({ status: 'loading model' })
        : json(completion())
    );
    return {
      built,
      fail: () => {
        healthy = false;
      },
      recover: () => {
        healthy = true;
      }
    };
  }

  /**
   * The defect: `settle` took the handle, set `this.managed` to null, and only
   * recorded the process as still-owned AFTER awaiting the cleanup. In between,
   * the process was referenced by nothing — so an explicit stop arriving in that
   * window found nothing to stop, answered `stopped`, and the next start
   * launched a second runtime while the first was still alive.
   */
  it('never answers stopped while the cleanup it joined is still running', async () => {
    const held = gate();
    const { built, fail } = harnessWithFailingHealth();
    expect((await built.provider.start()).kind).toBe('healthy');
    const first = built.runner.processes[0]!;
    first.stopGate = held.promise;
    first.stopResult = UNCONFIRMED_RESULT;
    fail();

    // The automatic cleanup begins and blocks inside the process's stop().
    const automatic = built.provider.health();
    await turn();
    expect(first.attempts).toBe(1);

    // The explicit stop arrives in exactly the window the defect opened.
    const explicit = built.provider.stop();

    // It must not answer anything yet: the outcome is genuinely not known.
    expect(await stillWaiting(explicit)).toBe(true);

    held.release();
    const [, stopState] = await Promise.all([automatic, explicit]);

    // Not `stopped` — the cleanup could not confirm the process ended.
    expect(stopState.kind).toBe('failed');
    expect(stopState.kind).not.toBe('stopped');

    // One kill, joined by both callers, against the SAME process.
    expect(first.attempts).toBe(1);
    expect(first.stopCalls).toBe(2);
    expect(first.running()).toBe(true);

    // And the runtime is still accounted for, so nothing starts beside it.
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
    expect(built.runner.launches).toHaveLength(1);
    expect(built.runner.processes).toHaveLength(1);
  });

  it('still allows a further explicit stop after the joined attempt was unconfirmed', async () => {
    const held = gate();
    const { built, fail } = harnessWithFailingHealth();
    expect((await built.provider.start()).kind).toBe('healthy');
    const first = built.runner.processes[0]!;
    first.stopGate = held.promise;
    first.stopResult = UNCONFIRMED_RESULT;
    fail();

    const automatic = built.provider.health();
    await turn();
    const explicit = built.provider.stop();
    held.release();
    await Promise.all([automatic, explicit]);

    // The process finally goes away, and a further stop can prove it.
    first.stopGate = null;
    first.stopResult = null;
    const retry = await built.provider.stop();

    expect(retry.kind).toBe('stopped');
    expect(first.attempts).toBe(2);
    expect(first.running()).toBe(false);
  });

  it('releases the runtime only when the joined cleanup confirms it ended', async () => {
    const held = gate();
    const { built, fail, recover } = harnessWithFailingHealth();
    expect((await built.provider.start()).kind).toBe('healthy');
    const first = built.runner.processes[0]!;
    first.stopGate = held.promise;
    fail();

    const automatic = built.provider.health();
    await turn();
    const explicit = built.provider.stop();
    expect(await stillWaiting(explicit)).toBe(true);

    held.release();
    const [, stopState] = await Promise.all([automatic, explicit]);

    expect(stopState.kind).toBe('stopped');
    expect(first.attempts).toBe(1);
    expect(first.running()).toBe(false);

    // Confirmed is the only thing that opens the way for a new runtime.
    recover();
    const restarted = await built.provider.start();
    expect(restarted.kind).toBe('healthy');
    expect(built.runner.launches).toHaveLength(2);
  });

  it('does not let a late exit from the old runtime disturb the new one', async () => {
    const built = await started(HEALTHY);
    const first = built.runner.processes[0]!;
    // A confirmed stop whose process happens to settle its exit later — the
    // shape that leaves an old watcher callback still queued.
    first.stopResult = { kind: 'stopped', exit: CLEAN_EXIT };

    expect((await built.provider.stop()).kind).toBe('stopped');
    expect((await built.provider.start()).kind).toBe('healthy');
    const second = built.runner.processes[1]!;

    // Now the previous process finally ends. Its watcher belongs to a runtime
    // that is gone, and must not move the state or the ownership of this one.
    first.end(CLEAN_EXIT);
    await turn();
    await turn();

    expect(built.provider.state().kind).toBe('healthy');
    expect(second.running()).toBe(true);
    expect(built.runner.launches).toHaveLength(2);
    // No automatic restart was introduced by any of this.
    expect(built.runner.processes).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* An inference whose cleanup could not be confirmed                           */
/* -------------------------------------------------------------------------- */

/**
 * A POST that answers only by being aborted.
 *
 * The health endpoint still answers normally, so a provider can reach `healthy`
 * and then hang on exactly one request — which is what a deadline and a
 * cancellation both need in order to be told apart from a slow success.
 */
const HANGING_POST: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

describe('local inference: an inference whose cleanup could not be confirmed', () => {
  const UNCONFIRMED: ManagedProcessStopResult = {
    kind: 'unconfirmed',
    reason: 'The runtime process did not exit within 2000ms of being terminated.'
  };

  /**
   * The defect these close: the state was downgraded to `failed` when the tree
   * could not be confirmed gone, but the *outcome* handed to the caller still
   * said `timed_out` or `cancelled`. Those words mean the operation is over,
   * and an operation whose runtime may still be executing the prompt is not
   * over — so a caller reading only the outcome would have believed a cleanup
   * that never happened.
   */
  it('reports failed rather than timed_out, and refuses to start again', async () => {
    const built = await started(HANGING_POST, { inferenceTimeoutMs: 80 });
    const managed = built.runner.processes[0]!;
    managed.stopResult = UNCONFIRMED;

    const outcome = await built.provider.infer(request());

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    // The request's disposition is untouched: still ambiguous, still not a
    // licence to send a second one.
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(outcome.requestId).toBe('req-1');
    expect(outcome.reason).toContain('did not exit');
    // Outcome and state agree.
    expect(built.provider.state().kind).toBe('failed');

    expect(posts(built.calls)).toHaveLength(1);
    expect(managed.running()).toBe(true);
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
    expect(built.runner.launches).toHaveLength(1);
  });

  it('reports failed rather than cancelled, and refuses to start again', async () => {
    const built = await started(HANGING_POST, { inferenceTimeoutMs: 30_000 });
    const managed = built.runner.processes[0]!;
    managed.stopResult = UNCONFIRMED;

    const controller = new AbortController();
    const inferring = built.provider.infer(request(), controller.signal);
    for (let attempt = 0; attempt < 50 && posts(built.calls).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(posts(built.calls)).toHaveLength(1);
    controller.abort();

    const outcome = await inferring;
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(built.provider.state().kind).toBe('failed');

    expect(posts(built.calls)).toHaveLength(1);
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('still reports a confirmed timeout as timed_out when the tree does go away', async () => {
    // The other half of the claim: the downgrade is about the cleanup, not a
    // blanket rewrite of every non-success into `failed`.
    const built = await started(HANGING_POST, { inferenceTimeoutMs: 80 });
    const outcome = await built.provider.infer(request());

    expect(outcome.kind).toBe('timed_out');
    expect(built.provider.state().kind).toBe('timed_out');
    expect(built.runner.processes[0]?.running()).toBe(false);
  });

  it('waits for an explicit stop and reports failed when its cleanup is unconfirmed', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const built = await started(HANGING_POST, { inferenceTimeoutMs: 30_000 });
    const managed = built.runner.processes[0]!;
    managed.stopGate = held;
    managed.stopResult = UNCONFIRMED;

    const inferring = built.provider.infer(request());
    for (let attempt = 0; attempt < 50 && posts(built.calls).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const stopping = built.provider.stop();

    let inferenceSettled = false;
    void inferring.then(() => {
      inferenceSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inferenceSettled).toBe(false);

    release();
    const [stopState, outcome] = await Promise.all([stopping, inferring]);
    expect(stopState.kind).toBe('failed');
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(managed.attempts).toBe(1);
    expect(managed.running()).toBe(true);
  });

  it('waits for an explicit stop before reporting a confirmed cancellation', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const built = await started(HANGING_POST, { inferenceTimeoutMs: 30_000 });
    const managed = built.runner.processes[0]!;
    managed.stopGate = held;

    const inferring = built.provider.infer(request());
    for (let attempt = 0; attempt < 50 && posts(built.calls).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const stopping = built.provider.stop();

    let inferenceSettled = false;
    void inferring.then(() => {
      inferenceSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inferenceSettled).toBe(false);

    release();
    const [stopState, outcome] = await Promise.all([stopping, inferring]);
    expect(stopState.kind).toBe('stopped');
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(managed.attempts).toBe(1);
    expect(managed.running()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime identity outlives a failed capability probe                         */
/* -------------------------------------------------------------------------- */

describe('local inference runtime version', () => {
  /**
   * The defect this closes: `capabilities()` wrote its probe result over the
   * version the running instance had already established, so one failed
   * `--version` run — a file replaced by an upgrade, a machine briefly out of
   * handles — made the next completed response report `runtimeVersion: null`
   * for a runtime whose version was known.
   */
  it('survives a later capability probe that fails', async () => {
    const built = await started(() => json(completion()));
    built.runner.versionOverride = { exitCode: 1, stderr: 'boom' };

    const capabilities = await built.provider.capabilities();
    expect(capabilities.available).toBe(true);
    // The process being described is the one that is running.
    expect(capabilities.runtimeVersion).toBe('version: 4321 (stub)');

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.runtimeVersion).toBe('version: 4321 (stub)');
  });

  it('is forgotten once the runtime it belonged to is stopped', async () => {
    const built = await started(() => json(completion()));
    await built.provider.stop();
    built.runner.versionOverride = { exitCode: 1, stderr: 'boom' };

    // Nothing is running, so there is no established version to report.
    expect((await built.provider.capabilities()).runtimeVersion).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Command shims are never launched                                            */
/* -------------------------------------------------------------------------- */

describe('local inference executables', () => {
  const shims = [
    'C:\\tools\\llama-server.cmd',
    'C:\\tools\\llama-server.bat',
    'C:\\tools\\llama-server.ps1',
    'C:\\tools\\llama-server.vbs',
    '/usr/local/bin/llama-server.sh'
  ];

  /**
   * The defect these close: `launchFor` only rewrites JavaScript entry points,
   * so a `.cmd` reached `execa` unchanged. `findOnPath` honours `PATHEXT` and
   * will happily return one — an npm-style shim earlier on PATH than any real
   * binary is entirely ordinary — and running it means running `cmd.exe`, which
   * is the single thing this application refuses to do.
   */
  for (const shim of shims) {
    it(`refuses ${shim} as a configured executable, before anything runs`, () => {
      const runner = new StubRunner();
      expect(
        () =>
          new LlamaCppLocalInference(
            runner,
            configFor({ executable: { kind: 'explicit_path', path: shim } }),
            { fetch: stubFetch(HEALTHY).fetchImpl }
          )
      ).toThrow();
      expect(runner.runs).toHaveLength(0);
      expect(runner.launches).toHaveLength(0);
    });
  }

  // PATHEXT discovery is the only way a shim is ever *returned* by the locator,
  // and that is a Windows behaviour. The configured-path refusal above is the
  // portable half.
  it.runIf(process.platform === 'win32')(
    'refuses a discovered command shim without probing or launching it',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agent-relay-shim-'));
      const originalPath = process.env.PATH;
      try {
        writeFileSync(join(directory, 'llama-server.cmd'), '@echo off\r\n', 'utf8');
        process.env.PATH = `${directory}${delimiter}${originalPath ?? ''}`;

        const { provider, runner, calls } = harness(HEALTHY, {
          executable: { kind: 'discovered', command: 'llama-server' }
        });

        const capabilities = await provider.capabilities();
        expect(capabilities.available).toBe(false);
        expect(capabilities.unavailableReason).toContain('command shim');
        expect(provider.state().kind).toBe('unavailable');

        expect((await provider.start()).kind).toBe('unavailable');

        // Never probed, never launched, never contacted.
        expect(runner.runs).toHaveLength(0);
        expect(runner.launches).toHaveLength(0);
        expect(calls).toHaveLength(0);
      } finally {
        process.env.PATH = originalPath;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
