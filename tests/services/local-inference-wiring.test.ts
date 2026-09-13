import { afterEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../src/main/container';
import {
  LlamaCppLocalInference,
  type LocalInferenceProcessRunner
} from '../../src/main/adapters/local-inference/llama-cpp-local-inference';
import {
  ExecaProcessRunner,
  type ManagedProcess,
  type ManagedProcessOptions,
  type ProcessResult,
  type ProcessRunOptions
} from '../../src/main/adapters/process/process-runner';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { LOCAL_INFERENCE_HOST } from '../../src/shared/domain/local-inference';
import { RecordingConfirmationService } from '../helpers/fakes';
import { isAlive, waitForExit } from '../helpers/fake-claude';
import {
  FAKE_LOCAL_INFERENCE_RUNTIME,
  FakeLocalInferenceRuntime,
  freePort
} from '../helpers/fake-local-inference';

class ObservingRunner extends ExecaProcessRunner implements LocalInferenceProcessRunner {
  readonly runs: { file: string; args: readonly string[] }[] = [];
  readonly launches: { file: string; args: readonly string[]; options?: ManagedProcessOptions }[] = [];

  override async run(
    file: string,
    args: readonly string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult> {
    this.runs.push({ file, args: [...args] });
    return super.run(file, args, options);
  }

  override launch(
    file: string,
    args: readonly string[],
    options?: ManagedProcessOptions
  ): ManagedProcess {
    this.launches.push({ file, args: [...args], options });
    return super.launch(file, args, options);
  }
}

const open: { app: Application; runtime: FakeLocalInferenceRuntime }[] = [];

afterEach(async () => {
  for (const item of open.splice(0)) {
    await item.app.localInference.stop().catch(() => undefined);
    item.app.close();
    await item.runtime.cleanup();
  }
});

describe('composition-root local inference wiring', () => {
  it('probes, explicitly starts, reads passively, checks once, and explicitly stops the fake runtime', async () => {
    const runtime = new FakeLocalInferenceRuntime().scenario({ health: 'ok', spawnDescendant: true });
    const port = await freePort();
    const runner = new ObservingRunner();
    const app = buildApplication({
      paths: { dataDir: runtime.path, documentsDir: runtime.path },
      databaseFile: ':memory:',
      events: new InMemoryEventPublisher(),
      confirmation: new RecordingConfirmationService(false),
      processRunner: runner,
      localInferenceProcessRunner: runner,
      localInferenceProviderFactory: (config) =>
        new LlamaCppLocalInference(runner, { ...config, workingDirectory: runtime.path })
    });
    open.push({ app, runtime });
    app.settings.update({
      localInference: {
        ...app.settings.get().localInference,
        enabled: true,
        executable: { kind: 'explicit_path', path: FAKE_LOCAL_INFERENCE_RUNTIME },
        model: { id: 'wired-model', source: { kind: 'runtime_id', runtimeModelId: 'wired-source' } },
        fixedArguments: ['--threads', '2'],
        port,
        contextLimitTokens: 8192,
        startupTimeoutMs: 20_000,
        healthTimeoutMs: 5_000,
        inferenceTimeoutMs: 20_000,
        shutdownTimeoutMs: 10_000,
        requestDefaults: {
          maxOutputTokens: 321,
          chatTemplateParameters: { enable_thinking: false, custom_flag: 'wired-value' }
        }
      }
    });

    expect(app.localInference.state()).toEqual({ kind: 'stopped' });
    expect(runtime.ran()).toBe(false);

    const capabilities = await app.localInference.capabilities();
    expect(capabilities.available).toBe(true);
    expect(capabilities.providerId).toBe('local-llama-cpp');
    expect(runner.runs).toHaveLength(1);

    const started = await app.localInference.start();
    expect(started).toEqual({ kind: 'healthy', runtimeInstanceId: expect.any(String) });
    const requestsAfterStart = runtime.requests().length;
    expect(app.localInference.state().kind).toBe('healthy');
    expect(runtime.requests()).toHaveLength(requestsAfterStart);
    expect((await app.localInference.health()).kind).toBe('healthy');
    expect(runtime.requests()).toHaveLength(requestsAfterStart + 1);

    // One manual smoke-test inference, after explicit start and before stop.
    // The fake runtime's completion is distinctive so the recorded request and
    // the returned response cannot be confused with any other fixture reply.
    runtime.scenario({
      health: 'ok',
      spawnDescendant: true,
      completionText: 'Wired completion text.',
      responseId: 'chatcmpl-wired-1'
    });
    const outcome = await app.localInference.runTestInference('Say something wired.');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('expected a completed outcome');
    expect(outcome.response.completion).toBe('Wired completion text.');
    expect(outcome.response.providerId).toBe('local-llama-cpp');
    expect(outcome.response.modelId).toBe('wired-model');
    expect(outcome.response.finishReason).toEqual({ kind: 'stop' });
    expect(outcome.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(app.localInference.state().kind).toBe('healthy');

    const completionRequests = runtime.completionRequests();
    expect(completionRequests).toHaveLength(1);
    const completionBody = JSON.parse(completionRequests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(completionBody).toMatchObject({
      model: 'wired-model',
      stream: false,
      n: 1,
      max_tokens: 321,
      chat_template_kwargs: { enable_thinking: false, custom_flag: 'wired-value' },
      messages: [{ role: 'user', content: 'Say something wired.' }]
    });

    const evidence = runtime.evidence();
    expect(evidence.argv).toEqual([
      '--threads',
      '2',
      '--model',
      'wired-source',
      '--alias',
      'wired-model',
      '--host',
      LOCAL_INFERENCE_HOST,
      '--port',
      String(port),
      '--ctx-size',
      '8192'
    ]);
    expect(runner.launches).toHaveLength(1);
    expect(runner.launches[0]?.file).toBe(process.execPath);
    expect(runner.launches[0]?.args[0]).toBe(FAKE_LOCAL_INFERENCE_RUNTIME);
    expect(runner.launches[0]?.options?.cwd).toBe(runtime.path);
    expect(evidence.envTokenShapedNames).toEqual([]);

    expect(await app.localInference.stop()).toEqual({ kind: 'stopped' });
    expect(await waitForExit(evidence.pid)).toBe(true);
    expect(evidence.descendantPid).not.toBeNull();
    expect(await waitForExit(evidence.descendantPid as number)).toBe(true);
    expect(isAlive(evidence.pid)).toBe(false);
  });
});
