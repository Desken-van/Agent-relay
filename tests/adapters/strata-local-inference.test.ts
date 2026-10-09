/**
 * The local-inference adapter running a Strata runtime, against a fake Strata checkout built from the
 * repository's fake runtime: its `serve/server.py` is the fake server (run by Node standing in for Strata's
 * Python), its engine prints a version, and its model config is written per test. Real process, real
 * sockets, real tree kill — the same harness as the llama.cpp process contract, so what differs is only what
 * Strata changes: how it is launched, what its config must say before a launch, what its health must say
 * before it counts as ready, and what the request carries.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner, type ManagedProcess, type ManagedProcessOptions } from '../../src/main/adapters/process/process-runner';
import {
  LlamaCppLocalInference,
  type LocalInferenceProcessRunner
} from '../../src/main/adapters/local-inference/llama-cpp-local-inference';
import {
  judgeStrataHealth,
  readStrataEngineConfig,
  STRATA_ORNITH_FORMAT_MESSAGE,
  strataPrefixFields,
  strataRuntimeArgv
} from '../../src/main/adapters/local-inference/strata-runtime';
import { parseLocalInferenceConfig, type LocalInferenceConfig } from '../../src/shared/domain/local-inference';
import {
  FAKE_LOCAL_INFERENCE_RUNTIME,
  fakeInferenceRequest,
  fakeLocalInferenceConfig,
  FakeLocalInferenceRuntime,
  freePort,
  type FakeRuntimeScenario
} from '../helpers/fake-local-inference';
import { waitForExit } from '../helpers/fake-claude';

const MODEL = 'qwen-strata-test';
const ENGINE_VERSION = 'strata 0.1.41 (fake)';

class ObservingRunner extends ExecaProcessRunner implements LocalInferenceProcessRunner {
  readonly starts: { file: string; args: readonly string[] }[] = [];
  /** One-shot runs: the `--version` probe. */
  readonly runs: { file: string; args: readonly string[] }[] = [];

  override run(...call: Parameters<ExecaProcessRunner['run']>): ReturnType<ExecaProcessRunner['run']> {
    this.runs.push({ file: call[0], args: [...call[1]] });
    return super.run(...call);
  }

  override launch(file: string, args: readonly string[], options?: ManagedProcessOptions): ManagedProcess {
    this.starts.push({ file, args: [...args] });
    return super.launch(file, args, options);
  }
}

interface StrataCheckout {
  readonly serverScript: string;
  readonly engineConfig: string;
  readonly engine: string;
}

/** A fake Strata checkout inside the fake runtime's own directory (its working directory and scenario home). */
function strataCheckout(runtime: FakeLocalInferenceRuntime, config: Record<string, unknown> = {}): StrataCheckout {
  mkdirSync(join(runtime.path, 'serve'), { recursive: true });
  mkdirSync(join(runtime.path, 'engine'), { recursive: true });
  const serverScript = join(runtime.path, 'serve', 'server.py');
  // Node runs a file of unknown extension as CommonJS: this "server.py" is the fake runtime, started with the
  // argv Strata's server would get.
  writeFileSync(serverScript, `import(${JSON.stringify(pathToFileURL(FAKE_LOCAL_INFERENCE_RUNTIME).href)});\n`);
  const engine = join(runtime.path, 'engine', 'strata.mjs');
  writeFileSync(engine, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${ENGINE_VERSION}\n`)});\n`);
  chmodSync(engine, 0o755);
  const engineConfig = join(runtime.path, 'strata-test.json');
  writeFileSync(engineConfig, JSON.stringify({
    exe: engine,
    args: ['--pack', '/packs/x', '--max-context', '32768', '--kv', 'int8'],
    model_name: MODEL,
    port: 18190,
    gpu: 0,
    ...config
  }));
  return { serverScript, engineConfig, engine };
}

function strataConfig(runtime: FakeLocalInferenceRuntime, port: number, checkout: StrataCheckout, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fakeLocalInferenceConfig(runtime, port, {
    providerId: 'local-strata',
    adapterKind: 'strata',
    strata: { serverScript: checkout.serverScript, engineConfig: checkout.engineConfig },
    // Node stands in for the Python of Strata's own .venv.
    executable: { kind: 'explicit_path', path: process.execPath },
    model: { id: MODEL, source: { kind: 'runtime_id', runtimeModelId: MODEL } },
    fixedArguments: [],
    workingDirectory: runtime.path,
    ...overrides
  });
}

const ready = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok', max_context: 32768, model: MODEL, images: false, api_key: false, loaded: true, service: 'strata', ...extra
});

interface Harness {
  readonly runtime: FakeLocalInferenceRuntime;
  readonly provider: LlamaCppLocalInference;
  readonly runner: ObservingRunner;
  readonly port: number;
  readonly checkout: StrataCheckout;
}

const open: Harness[] = [];

async function harness(scenario: FakeRuntimeScenario, config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Promise<Harness> {
  const runtime = new FakeLocalInferenceRuntime();
  runtime.scenario(scenario);
  const checkout = strataCheckout(runtime, config);
  const port = await freePort();
  const runner = new ObservingRunner();
  const provider = new LlamaCppLocalInference(runner, strataConfig(runtime, port, checkout, overrides));
  const built = { runtime, provider, runner, port, checkout };
  open.push(built);
  return built;
}

afterEach(async () => {
  for (const built of open.splice(0)) {
    await built.provider.stop().catch(() => undefined);
    await built.runtime.cleanup();
  }
});

describe('a Strata runtime: launch and identity', () => {
  it('launches its server script under the named interpreter with the model config, loopback host and owned port', async () => {
    const built = await harness({ healthBodies: [ready()] });
    const capabilities = await built.provider.capabilities();
    expect(capabilities).toMatchObject({ available: true, providerId: 'local-strata', modelId: MODEL, runtimeVersion: ENGINE_VERSION });

    expect((await built.provider.start()).kind).toBe('healthy');
    expect(built.runner.starts).toHaveLength(1);
    expect(built.runner.starts[0]!.file).toBe(process.execPath);
    expect(built.runner.starts[0]!.args).toEqual([
      built.checkout.serverScript, '--engine', 'strata', '--config', built.checkout.engineConfig,
      '--host', '127.0.0.1', '--port', String(built.port)
    ]);
    // No llama.cpp argv of any kind.
    expect(built.runner.starts[0]!.args).not.toContain('--alias');
    expect(built.runner.starts[0]!.args).not.toContain('--ctx-size');
  });

  it('is not ready while its server says "ok" but the model is not loaded, and becomes ready once it is', async () => {
    const built = await harness({ healthBodies: [ready({ loaded: false }), ready({ loaded: false }), ready({ loaded: false }), ready()] });
    expect((await built.provider.start()).kind).toBe('healthy');
    expect(built.runtime.requests().filter((r) => r.path === '/health').length).toBeGreaterThanOrEqual(4);
  });

  it('stays unready, then times out, while the model never loads', async () => {
    const built = await harness({ healthBodies: [ready({ loaded: false })] }, {}, { startupTimeoutMs: 1_500 });
    const state = await built.provider.start();
    expect(state).toMatchObject({ kind: 'timed_out' });
  });

  it.each([
    ['another model', ready({ model: 'some-other-model' }), 'different model'],
    ['less context than the profile needs', ready({ max_context: 2048 }), 'less context'],
    ['another service on the port', ready({ service: 'llama.cpp' }), 'not a Strata server'],
    ['no service at all', ready({ service: undefined }), 'not a Strata server'],
    ['a null service', ready({ service: null }), 'not a Strata server'],
    ['a service that is not a string', ready({ service: ['strata'] }), 'not a Strata server'],
    ['a service named differently', ready({ service: 'Strata' }), 'not a Strata server']
  ])('refuses at once a server that reports %s, without polling it out', async (_label, body, reason) => {
    const built = await harness({ healthBodies: [body] }, {}, { startupTimeoutMs: 15_000 });
    const startedAt = Date.now();
    const state = await built.provider.start();
    expect(state.kind).toBe('failed');
    expect('reason' in state ? state.reason : '').toContain(reason);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe('a Strata runtime: its model config is checked before anything is launched', () => {
  it.each([
    ['MCP tools (mcp_servers)', { mcp_servers: { files: { command: 'x' } } }, 'MCP tools'],
    ['MCP tools (mcpServers)', { mcpServers: { files: { command: 'x' } } }, 'MCP tools'],
    ['an API key', { api_key: 'secret-value' }, 'API key'],
    ['another host', { host: '0.0.0.0' }, 'listens beyond'],
    ['lazy loading', { lazy_load: true }, 'loads the model lazily'],
    ['idle unloading', { idle_unload_s: 300 }, 'unloads the model when idle'],
    ['another model', { model_name: 'not-this-one' }, 'different model'],
    ['too little engine context', { args: ['--max-context', '2048'] }, 'smaller than'],
    ['no engine context', { args: ['--kv', 'int8'] }, '--max-context'],
    ['a relative engine path', { exe: 'engine/strata' }, 'absolute path'],
    ['a missing engine', { exe: '/nonexistent/strata-engine' }, 'not present']
  ])('refuses a config with %s', async (_label, config, reason) => {
    const built = await harness({ healthBodies: [ready()] }, config);
    const capabilities = await built.provider.capabilities();
    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toContain(reason);
    const state = await built.provider.start();
    expect(state.kind).toBe('failed');
    expect('reason' in state ? state.reason : '').toContain(reason);
    // Never launched, never contacted.
    expect(built.runner.starts).toHaveLength(0);
    expect(built.runtime.ran()).toBe(false);
  });

  it.each([
    ['a shell command string', 'echo audit-marker'],
    ['a command and arguments', ['echo', 'audit-marker']]
  ])('refuses a before_load hook given as %s, before any version probe or launch', async (_label, beforeLoad) => {
    // Strata's server runs it before every engine load — after an idle unload, and after the engine died —
    // a string through a shell. That is a command outside Agent Relay's tools, so the config is refused.
    const built = await harness({ healthBodies: [ready()] }, { before_load: beforeLoad });
    const capabilities = await built.provider.capabilities();
    expect(capabilities.available).toBe(false);
    const state = await built.provider.start();
    expect(state.kind).toBe('failed');
    const reason = 'reason' in state ? state.reason : '';
    expect(reason).toContain('runs a command before the model loads ("before_load")');
    for (const told of [reason, capabilities.unavailableReason ?? '']) {
      expect(told).not.toContain('audit-marker');
      expect(told).not.toContain('echo');
      expect(told).not.toContain(built.runtime.path);
    }
    expect(built.runner.runs).toHaveLength(0);
    expect(built.runner.starts).toHaveLength(0);
    expect(built.runtime.ran()).toBe(false);
  });

  it('still starts an ordinary config: the engine probed once, the server launched', async () => {
    const built = await harness({ healthBodies: [ready()] });
    expect((await built.provider.start()).kind).toBe('healthy');
    expect(built.runner.runs).toHaveLength(1);
    expect(built.runner.runs[0]!.args.at(-1)).toBe('--version');
    expect([built.runner.runs[0]!.file, ...built.runner.runs[0]!.args]).toContain(built.checkout.engine);
    expect(built.runner.starts).toHaveLength(1);
  });

  it('never names a path or a value from the file in a refusal', async () => {
    const built = await harness({ healthBodies: [ready()] }, { api_key: 'sk-very-secret-key' });
    const state = await built.provider.start();
    const reason = 'reason' in state ? state.reason : '';
    expect(reason).not.toContain('sk-very-secret-key');
    expect(reason).not.toContain(built.runtime.path);
  });
});

describe('a Strata runtime: inference', () => {
  it('sends an Ornith action request WITHOUT a response format, so the raw text reaches Relay\'s own one-action parser', async () => {
    const built = await harness({ healthBodies: [ready()], completionText: '{"version":1,"action":"git_status"}' });
    await built.provider.start();
    const outcome = await built.provider.infer(fakeInferenceRequest({
      structuredOutput: 'ornith_action_v1',
      chatTemplateParameters: { enable_thinking: false }
    }));
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.providerId).toBe('local-strata');
    expect(outcome.response.completion).toBe('{"version":1,"action":"git_status"}');
    const body = JSON.parse(built.runtime.completionRequests()[0]!.body) as { messages: { role: string; content: string }[] };
    expect(body).not.toHaveProperty('response_format');
    expect(body).toMatchObject({ stream: false, n: 1, model: MODEL, chat_template_kwargs: { enable_thinking: false } });
    // The output format is stated in a fixed system message of its own, ahead of the request's messages.
    expect(body.messages[0]).toEqual(STRATA_ORNITH_FORMAT_MESSAGE);
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'Say something short.' }]);
  });

  it('sends a request that is not an Ornith action exactly as given: no format message, no response format', async () => {
    const built = await harness({ healthBodies: [ready()], completionText: 'Hello.' });
    await built.provider.start();
    await built.provider.infer(fakeInferenceRequest());
    const body = JSON.parse(built.runtime.completionRequests()[0]!.body) as { messages: unknown[] };
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say something short.' }]);
  });

  it('marks the request\'s stable prefix for Strata\'s cache, shifted past the format message, the text unchanged', async () => {
    const built = await harness({ healthBodies: [ready()], completionText: '{"version":1,"action":"git_status"}' });
    await built.provider.start();
    const content = 'SPECIFICATION AND PROTOCOL\n\nturn 1 [git_status]: clean';
    await built.provider.infer(fakeInferenceRequest({
      structuredOutput: 'ornith_action_v1',
      messages: [{ role: 'user', content }],
      stablePrefix: { message: 0, chars: 28 }
    }));
    const body = JSON.parse(built.runtime.completionRequests()[0]!.body) as Record<string, unknown>;
    // Message 0 of the request is message 1 on the wire, behind the format message.
    expect(body.strata_prefix).toEqual({ message: 1, chars: 28 });
    // Not "strata_checkpoint": false, with which the engine ignores the pin.
    expect(body).not.toHaveProperty('strata_checkpoint');
    expect(body.messages).toEqual([STRATA_ORNITH_FORMAT_MESSAGE, { role: 'user', content }]);
    expect(body).not.toHaveProperty('stablePrefix');
  });

  it('sends no cache fields without a stable prefix', async () => {
    const built = await harness({ healthBodies: [ready()], completionText: '{"version":1,"action":"git_status"}' });
    await built.provider.start();
    await built.provider.infer(fakeInferenceRequest({ structuredOutput: 'ornith_action_v1' }));
    const body = JSON.parse(built.runtime.completionRequests()[0]!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('strata_prefix');
    expect(body).not.toHaveProperty('strata_checkpoint');
  });

  it('counts the format message toward the prompt byte limit', async () => {
    const built = await harness({ healthBodies: [ready()] }, {}, { maxPromptBytes: 300 });
    await built.provider.start();
    const content = 'x'.repeat(300 - Buffer.byteLength(STRATA_ORNITH_FORMAT_MESSAGE.content) + 1);
    const outcome = await built.provider.infer(fakeInferenceRequest({ structuredOutput: 'ornith_action_v1', messages: [{ role: 'user', content }] }));
    expect(outcome).toMatchObject({ kind: 'failed', dispatchOutcome: 'not_dispatched' });
    expect(built.runtime.completionRequests()).toHaveLength(0);
  });

  it('cancels an inference by ending the runtime tree, and never reports it as completed', async () => {
    const built = await harness({ healthBodies: [ready()], completion: 'hang', spawnDescendant: true });
    await built.provider.start();
    const evidence = built.runtime.evidence();
    const controller = new AbortController();
    const pending = built.provider.infer(fakeInferenceRequest(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const outcome = await pending;
    expect(outcome.kind).toBe('cancelled');
    expect(await waitForExit(evidence.pid)).toBe(true);
    expect(await waitForExit(evidence.descendantPid as number)).toBe(true);
  });

  it('times out a hanging inference within its bound', async () => {
    const built = await harness({ healthBodies: [ready()], completion: 'hang' }, {}, { inferenceTimeoutMs: 800 });
    await built.provider.start();
    const startedAt = Date.now();
    const outcome = await built.provider.infer(fakeInferenceRequest());
    expect(outcome.kind).toBe('timed_out');
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  });

  it('reports a refused request (prompt beyond the context, HTTP 400) as a failure, not a completion', async () => {
    const built = await harness({ healthBodies: [ready()], completion: 'non2xx' });
    await built.provider.start();
    const outcome = await built.provider.infer(fakeInferenceRequest());
    expect(outcome.kind).toBe('failed');
  });
});

describe('a Strata runtime: ownership', () => {
  it('stops its whole process tree — the server and what it started — and only that', async () => {
    const built = await harness({ healthBodies: [ready()], spawnDescendant: true });
    await built.provider.start();
    const evidence = built.runtime.evidence();
    expect((await built.provider.stop()).kind).toBe('stopped');
    expect(await waitForExit(evidence.pid)).toBe(true);
    expect(await waitForExit(evidence.descendantPid as number)).toBe(true);
  });
});

describe('the Strata pieces on their own', () => {
  const config = (overrides: Record<string, unknown> = {}): LocalInferenceConfig => parseLocalInferenceConfig({
    version: 1, providerId: 'local-strata', adapterKind: 'strata',
    strata: { serverScript: '/opt/strata/serve/server.py', engineConfig: '/opt/strata/strata-x.json' },
    executable: { kind: 'explicit_path', path: '/opt/strata/.venv/bin/python' },
    model: { id: MODEL, source: { kind: 'runtime_id', runtimeModelId: MODEL } },
    port: 18190, fixedArguments: [], contextLimitTokens: 32768, maxOutputTokens: 1024,
    maxPromptBytes: 64_000, maxRequestBytes: 128_000, maxResponseBytes: 256_000, maxCompletionBytes: 32_000, maxProcessOutputBytes: 16_000,
    startupTimeoutMs: 20_000, healthTimeoutMs: 5_000, inferenceTimeoutMs: 20_000, shutdownTimeoutMs: 10_000,
    ...overrides
  });

  it('maps a stable prefix to Strata\'s fields: message index past what the adapter put in front, length in code points', () => {
    const wire = [STRATA_ORNITH_FORMAT_MESSAGE, { role: 'user' as const, content: 'ab\u{1F600}cd' }];
    // 'ab' plus one emoji: four UTF-16 code units, three characters to Strata.
    expect(strataPrefixFields({ message: 0, chars: 4 }, wire, 1)).toEqual({
      strata_prefix: { message: 1, chars: 3 }
    });
    expect(strataPrefixFields({ message: 1, chars: 2 }, wire, 0)).toEqual({
      strata_prefix: { message: 1, chars: 2 }
    });
    expect(strataPrefixFields(undefined, wire, 1)).toEqual({});
    expect(strataPrefixFields({ message: 1, chars: 2 }, wire, 1)).toEqual({});
  });

  it('builds the server argv from the profile alone', () => {
    expect(strataRuntimeArgv(config())).toEqual([
      '/opt/strata/serve/server.py', '--engine', 'strata', '--config', '/opt/strata/strata-x.json', '--host', '127.0.0.1', '--port', '18190'
    ]);
  });

  it('judges health on loaded, model, context and service, never on "ok" alone', () => {
    const base = { status: 'ok', loaded: true, model: MODEL, max_context: 32768, service: 'strata' };
    expect(judgeStrataHealth(base, config())).toEqual({ kind: 'ok' });
    expect(judgeStrataHealth({ ...base, loaded: false }, config()).kind).toBe('not_ready');
    expect(judgeStrataHealth({ status: 'ok', service: 'strata' }, config()).kind).toBe('not_ready');
    expect(judgeStrataHealth({ ...base, status: 'loading' }, config()).kind).toBe('not_ready');
    expect(judgeStrataHealth({ ...base, model: 'x' }, config()).kind).toBe('malformed');
    expect(judgeStrataHealth({ ...base, max_context: 4096 }, config()).kind).toBe('malformed');
    expect(judgeStrataHealth({ ...base, service: 'llama.cpp' }, config()).kind).toBe('malformed');
  });

  it('requires exactly service "strata": absent, null, another type or another name is not this runtime', () => {
    const { service: _service, ...unnamed } = { status: 'ok', loaded: true, model: MODEL, max_context: 32768, service: 'strata' };
    const identity = { kind: 'malformed', reason: 'The runtime on the configured port is not a Strata server.' };
    expect(judgeStrataHealth(unnamed, config())).toEqual(identity);
    for (const service of [null, 1, true, ['strata'], { name: 'strata' }, '', 'Strata', 'strata ', 'llama.cpp']) {
      expect(judgeStrataHealth({ ...unnamed, service }, config())).toEqual(identity);
    }
    // Identity is judged before readiness, so a body without it never reads as "still loading".
    expect(judgeStrataHealth({ status: 'ok', loaded: false }, config())).toEqual(identity);
    expect(judgeStrataHealth({ ...unnamed, service: 'strata' }, config())).toEqual({ kind: 'ok' });
  });

  it('refuses a missing or oversized model config', () => {
    expect(readStrataEngineConfig(config())).toMatchObject({ ok: false, reason: expect.stringContaining('not present') });
  });

  it('refuses any before_load that Strata would run, and only that', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-config-'));
    try {
      const engineConfig = join(dir, 'strata-x.json');
      const read = (extra: Record<string, unknown>) => {
        writeFileSync(engineConfig, JSON.stringify({ exe: '/usr/bin/true', model_name: MODEL, args: ['--max-context', '32768'], ...extra }));
        return readStrataEngineConfig(config({ strata: { serverScript: '/opt/strata/serve/server.py', engineConfig } }));
      };
      expect(read({})).toMatchObject({ ok: true });
      for (const beforeLoad of ['echo audit-marker', ' ', ['echo', 'audit-marker'], [''], { cmd: 'x' }, 1, true]) {
        const verdict = read({ before_load: beforeLoad });
        expect(verdict).toEqual({ ok: false, reason: 'The Strata model config is refused: it runs a command before the model loads ("before_load").' });
      }
      // Strata reads it as `cfg.get("before_load") or None`: an empty value runs nothing.
      for (const beforeLoad of [null, '', [], false, 0]) {
        expect(read({ before_load: beforeLoad })).toMatchObject({ ok: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the profile shape rules: an interpreter by explicit path, a model name, no fixed arguments, Strata paths only for Strata', () => {
    expect(() => config({ executable: { kind: 'discovered', command: 'llama-server' } })).toThrow(/explicit path/);
    expect(() => config({ model: { id: MODEL, source: { kind: 'path', path: '/m.gguf' } } })).toThrow(/model name/);
    expect(() => config({ fixedArguments: ['--x'] })).toThrow(/no fixed arguments/);
    expect(() => config({ strata: undefined })).toThrow(/server script and model config/);
    expect(() => config({ adapterKind: 'llama_cpp', providerId: 'local-llama-cpp' })).toThrow(/Only a Strata runtime/);
    // A configuration without a kind is llama.cpp's, as before this field existed.
    const legacy = config({ adapterKind: undefined, strata: undefined, executable: { kind: 'discovered', command: 'llama-server' } });
    expect(legacy.adapterKind).toBe('llama_cpp');
  });
});
