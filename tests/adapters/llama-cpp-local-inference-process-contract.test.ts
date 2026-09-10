/**
 * `LlamaCppLocalInference` against a real child process and real loopback HTTP.
 *
 * The neighbouring suite gives the provider a stubbed runner and a stubbed
 * `fetch`. That proves the adapter builds the right argv and reads the right
 * JSON, and nothing at all about the boundary those stand for: a process that
 * has to actually die, a descendant that has to die with it, a socket that can
 * hang until a deadline fires, a body that arrives too large, and a stderr
 * channel that must never be mistaken for an answer.
 *
 * So these run `node tests/fixtures/fake-local-inference-runtime.mjs` — the real
 * `ExecaProcessRunner`, a real process, a real port — and assert on what the
 * provider publicly returns and on what the child publicly recorded about how it
 * was started. No private field is read, the fixture is addressed by path, and
 * no real llama.cpp, model, download, credential or non-loopback network is
 * involved.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  LlamaCppLocalInference,
  LocalInferenceProcessRunner
} from '../../src/main/adapters/local-inference/llama-cpp-local-inference';
import {
  ExecaProcessRunner,
  type ManagedProcess,
  type ManagedProcessExit,
  type ManagedProcessOptions,
  type ManagedProcessStopResult,
  type ProcessResult
} from '../../src/main/adapters/process/process-runner';
import type { LocalInferenceRequest } from '../../src/shared/domain/local-inference';
import { isAlive, waitForExit } from '../helpers/fake-claude';
import {
  fakeInferenceRequest,
  fakeLocalInferenceProvider,
  FakeLocalInferenceRuntime,
  freePort,
  type FakeRuntimeScenario
} from '../helpers/fake-local-inference';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The real runner, with a note of every server it was asked to start.
 *
 * Subclassed rather than replaced: the spawn, the pipes and the tree kill are
 * all still `ExecaProcessRunner`'s. What is added is a handle on the managed
 * process, which is the only way to observe the retained stdout and stderr —
 * the provider deliberately does not expose them.
 */
class ObservingRunner extends ExecaProcessRunner implements LocalInferenceProcessRunner {
  readonly starts: { file: string; args: readonly string[] }[] = [];
  readonly launched: ManagedProcess[] = [];

  override launch(
    file: string,
    args: readonly string[],
    options?: ManagedProcessOptions
  ): ManagedProcess {
    this.starts.push({ file, args: [...args] });
    const managed = super.launch(file, args, options);
    this.launched.push(managed);
    return managed;
  }
}

interface Harness {
  readonly runtime: FakeLocalInferenceRuntime;
  readonly provider: LlamaCppLocalInference;
  readonly runner: ObservingRunner;
  readonly port: number;
}

const open: Harness[] = [];

async function harness(
  scenario: FakeRuntimeScenario,
  overrides: Record<string, unknown> = {}
): Promise<Harness> {
  const runtime = new FakeLocalInferenceRuntime();
  runtime.scenario(scenario);
  const port = await freePort();
  const runner = new ObservingRunner();
  const provider = fakeLocalInferenceProvider(runtime, port, overrides, {}, runner);
  const built = { runtime, provider, runner, port };
  open.push(built);
  return built;
}

afterEach(async () => {
  for (const built of open.splice(0)) {
    // Never left to the operating system: every test must end with no process.
    await built.provider.stop().catch(() => undefined);
    built.runtime.cleanup();
  }
});

function request(overrides: Record<string, unknown> = {}): LocalInferenceRequest {
  return fakeInferenceRequest(overrides);
}

/** Poll until `predicate` holds, or give up. Returns whether it held. */
async function waitUntil(predicate: () => boolean, withinMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Both pids the fixture recorded, asserted to exist first. */
function pids(built: Harness): { parent: number; descendant: number } {
  const evidence = built.runtime.evidence();
  expect(evidence.descendantPid).not.toBeNull();
  return { parent: evidence.pid, descendant: evidence.descendantPid as number };
}

async function expectTreeGone(built: Harness): Promise<void> {
  const { parent, descendant } = pids(built);
  expect(await waitForExit(parent)).toBe(true);
  expect(await waitForExit(descendant)).toBe(true);
}

/* -------------------------------------------------------------------------- */
/* The happy path, end to end                                                  */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: the whole path', () => {
  it('discovers, probes, starts, checks health, infers once and stops', async () => {
    const built = await harness({ health: 'ok', completion: 'ok', completionText: 'Hello there.' });

    // Discovery and the version probe: they prove a file runs, and nothing more.
    const capabilities = await built.provider.capabilities();
    expect(capabilities.available).toBe(true);
    expect(capabilities.executableSource).toBe('configured');
    expect(capabilities.runtimeVersion).toBe('version: 9999 (fake-local-inference)');
    expect(capabilities.inferenceVerified).toBe(false);
    expect(built.runtime.ran()).toBe(false);
    expect(built.runner.starts).toHaveLength(0);

    expect((await built.provider.start()).kind).toBe('healthy');
    expect((await built.provider.health()).kind).toBe('healthy');

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.completion).toBe('Hello there.');
    expect(outcome.response.requestId).toBe('req-1');
    expect(outcome.response.modelId).toBe('fake-model');
    expect(outcome.response.promptTokens).toBe(11);
    expect(outcome.response.completionTokens).toBe(7);
    expect(outcome.response.finishReason).toEqual({ kind: 'stop' });
    expect(outcome.response.durationMs).toBeGreaterThanOrEqual(0);

    // Only now is inference proved.
    expect((await built.provider.capabilities()).inferenceVerified).toBe(true);

    const evidence = built.runtime.evidence();
    expect(evidence.argv).toContain('--alias');
    expect(evidence.argv).toContain('fake-model');
    expect(evidence.argv).toContain('127.0.0.1');
    expect(evidence.argv).toContain(String(built.port));
    expect(evidence.argv).toContain('--ctx-size');
    // The scrubbed environment reached the child.
    expect(evidence.envTokenShapedNames).toEqual([]);
    // Exactly one health request during startup is not asserted — the poll may
    // legitimately run twice — but exactly one completion request is.
    expect(built.runtime.completionRequests()).toHaveLength(1);

    const parent = evidence.pid;
    expect((await built.provider.stop()).kind).toBe('stopped');
    expect(await waitForExit(parent)).toBe(true);
  });

  it('keeps the prompt out of argv and puts it only in the request body', async () => {
    const prompt = 'delete everything && rm -rf / ; echo $(whoami) `id` | tee /tmp/x';
    const built = await harness({ health: 'ok', completion: 'ok' });
    await built.provider.start();
    await built.provider.infer(request({ messages: [{ role: 'user', content: prompt }] }));

    const evidence = built.runtime.evidence();
    expect(evidence.argv.join(' ')).not.toContain('rm -rf');
    expect(evidence.argv.join(' ')).not.toContain('whoami');

    const posts = built.runtime.completionRequests();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]?.body ?? '{}') as Record<string, unknown>;
    // Literal data, byte for byte: a shell metacharacter is a character here.
    expect(JSON.stringify(body.messages)).toContain('rm -rf');
    expect(body.stream).toBe(false);
    expect(body.n).toBe(1);
    expect(body.model).toBe('fake-model');
  });

  it('carries Ornith-style chat template parameters through unchanged', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    await built.provider.start();
    await built.provider.infer(
      request({ chatTemplateParameters: { enable_thinking: false, preserve_thinking: true } })
    );

    const body = JSON.parse(built.runtime.completionRequests()[0]?.body ?? '{}');
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: true
    });
  });

  it('reports omitted usage as null and an omitted finish reason as unknown', async () => {
    const built = await harness({
      health: 'ok',
      completion: 'ok',
      omitUsage: true,
      omitFinishReason: true
    });
    await built.provider.start();
    const outcome = await built.provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.promptTokens).toBeNull();
    expect(outcome.response.completionTokens).toBeNull();
    expect(outcome.response.finishReason).toEqual({ kind: 'unknown' });
  });
});

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: startup', () => {
  it('fails when the runtime process exits instead of listening', async () => {
    const built = await harness(
      { startupExit: 5, spawnDescendant: true },
      { startupTimeoutMs: 8_000 }
    );

    const state = await built.provider.start();
    expect(state.kind).toBe('failed');
    expect(built.runtime.ran()).toBe(true);
    await expectTreeGone(built);
  });

  it('times out on its own budget while each health request is bounded separately', async () => {
    // The server binds and then never answers. Each attempt can only be ended by
    // the health deadline; the loop can only be ended by the startup deadline.
    const built = await harness(
      { health: 'hang', spawnDescendant: true },
      { startupTimeoutMs: 5_000, healthTimeoutMs: 750 }
    );

    const started = Date.now();
    const state = await built.provider.start();
    const elapsed = Date.now() - started;

    expect(state.kind).toBe('timed_out');
    // Longer than one health request, and nothing like unbounded.
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(30_000);
    // More than one attempt reached the server, so no single hanging request
    // was allowed to consume the whole startup budget.
    expect(built.runtime.requests().length).toBeGreaterThan(1);
    await expectTreeGone(built);
  });

  it('waits out a slow start and then becomes healthy', async () => {
    const built = await harness({ startupDelayMs: 600, health: 'ok', completion: 'ok' });
    expect((await built.provider.start()).kind).toBe('healthy');
  });

  it('never becomes healthy on a 2xx that is not the health envelope', async () => {
    const built = await harness({ health: 'malformed' }, { startupTimeoutMs: 4_000 });
    const state = await built.provider.start();
    expect(state.kind).toBe('failed');
    expect(await waitForExit(built.runtime.evidence().pid)).toBe(true);
  });

  it('keeps polling a loading runtime rather than calling it healthy', async () => {
    const built = await harness(
      { health: 'loading' },
      { startupTimeoutMs: 2_500, healthTimeoutMs: 500 }
    );
    expect((await built.provider.start()).kind).toBe('timed_out');
    // It really did keep asking rather than giving up on the first answer.
    expect(built.runtime.requests().length).toBeGreaterThan(1);
  });

  it('cancels a startup without calling it a timeout', async () => {
    const built = await harness(
      { health: 'hang', spawnDescendant: true },
      { startupTimeoutMs: 20_000, healthTimeoutMs: 5_000 }
    );

    const controller = new AbortController();
    const starting = built.provider.start(controller.signal);
    expect(await waitUntil(() => built.runtime.ran())).toBe(true);
    controller.abort();

    const state = await starting;
    expect(state.kind).toBe('cancelled');
    await expectTreeGone(built);
  });

  it('refuses a start while one is already healthy, without launching another', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    await built.provider.start();
    await expect(built.provider.start()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(built.runner.starts).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit health                                                            */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: explicit health', () => {
  it('bounds one health check independently and cleans up the runtime tree', async () => {
    const built = await harness(
      { health: 'ok', completion: 'ok', spawnDescendant: true },
      { healthTimeoutMs: 600, startupTimeoutMs: 10_000 }
    );
    expect((await built.provider.start()).kind).toBe('healthy');

    built.runtime.scenario({ health: 'hang' });
    const checkedAt = Date.now();
    const state = await built.provider.health();

    expect(state.kind).toBe('timed_out');
    expect(Date.now() - checkedAt).toBeGreaterThanOrEqual(500);
    expect(Date.now() - checkedAt).toBeLessThan(5_000);
    await expectTreeGone(built);
  });
});

/* -------------------------------------------------------------------------- */
/* Inference                                                                   */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: inference', () => {
  it('refuses to infer before a start, launching nothing and sending nothing', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    await expect(built.provider.infer(request())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION'
    });
    expect(built.runner.starts).toHaveLength(0);
    expect(built.runtime.ran()).toBe(false);
  });

  it('reports a malformed completion as a failure with one POST and no retry', async () => {
    const built = await harness({
      health: 'ok',
      completion: 'malformed',
      spawnDescendant: true
    });
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(built.runtime.completionRequests()).toHaveLength(1);

    // Not restarted, not retried: the next attempt is refused outright.
    await expect(built.provider.infer(request({ requestId: 'req-2' }))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION'
    });
    expect(built.runtime.completionRequests()).toHaveLength(1);
    await expectTreeGone(built);
  });

  it('reports a non-2xx answer as rejected rather than unknown', async () => {
    const built = await harness({ health: 'ok', completion: 'non2xx' });
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('rejected');
  });

  it('refuses a response over the raw byte limit without partial success', async () => {
    const built = await harness(
      { health: 'ok', completion: 'huge_body', hugeBytes: 200_000 },
      { maxResponseBytes: 20_000, maxCompletionBytes: 10_000 }
    );
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('failed');
    expect(outcome).not.toHaveProperty('response');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
  });

  it('refuses a completion over the completion byte limit without partial success', async () => {
    const built = await harness(
      { health: 'ok', completion: 'huge_completion', hugeBytes: 30_000 },
      { maxResponseBytes: 200_000, maxCompletionBytes: 5_000 }
    );
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('failed');
    expect(outcome).not.toHaveProperty('response');
  });

  it('times out an inference on its own budget and takes the tree with it', async () => {
    const built = await harness(
      { health: 'ok', completion: 'hang', spawnDescendant: true },
      { inferenceTimeoutMs: 700 }
    );
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).toBe('timed_out');
    if (outcome.kind === 'completed') return;
    // Dispatched, and the answer is unknown. It is never a retryable state.
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(built.provider.state().kind).toBe('timed_out');
    expect(built.runtime.completionRequests()).toHaveLength(1);
    await expectTreeGone(built);
  });

  it('cancels an inference distinctly from timing it out', async () => {
    const built = await harness(
      { health: 'ok', completion: 'hang', spawnDescendant: true },
      { inferenceTimeoutMs: 30_000 }
    );
    await built.provider.start();

    const controller = new AbortController();
    const inferring = built.provider.infer(request(), controller.signal);
    expect(await waitUntil(() => built.runtime.completionRequests().length === 1)).toBe(true);
    controller.abort();

    const outcome = await inferring;
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(built.runtime.completionRequests()).toHaveLength(1);
    await expectTreeGone(built);
  });

  it('reports a runtime that dies mid-request as a failure, not a completion', async () => {
    const built = await harness({
      health: 'ok',
      completion: 'crash',
      crashExit: 9,
      spawnDescendant: true
    });
    await built.provider.start();

    const outcome = await built.provider.infer(request());
    expect(outcome.kind).not.toBe('completed');
    if (outcome.kind === 'completed') return;
    expect(outcome.dispatchOutcome).toBe('unknown');
    await expectTreeGone(built);
  });

  it.runIf(process.platform === 'win32')(
    'does not claim cleanup after a crashed parent leaves a detached descendant',
    async () => {
      const built = await harness({
        health: 'ok',
        completion: 'crash',
        crashExit: 9,
        spawnDescendant: true,
        detachedDescendant: true
      });
      await built.provider.start();
      const { descendant } = pids(built);

      try {
        const outcome = await built.provider.infer(request());
        expect(outcome.kind).toBe('failed');
        if (outcome.kind === 'completed') return;
        expect(outcome.dispatchOutcome).toBe('unknown');
        expect(outcome.reason).toMatch(/could not be confirmed terminated/i);
        expect(isAlive(descendant)).toBe(true);
        expect(built.provider.state().kind).toBe('failed');
        await expect(built.provider.start()).rejects.toMatchObject({ code: 'BUSY' });
      } finally {
        // This fixture deliberately creates the orphan that taskkill /T cannot
        // find once its parent is gone. Clean that exact synthetic pid here.
        if (isAlive(descendant)) process.kill(descendant, 'SIGKILL');
        expect(await waitForExit(descendant)).toBe(true);
      }
    }
  );

  it('does not leave the state healthy when the runtime exits on its own', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    await built.provider.start();
    expect(built.provider.state().kind).toBe('healthy');

    // Kill the tree behind the provider's back, the way a crash would.
    await built.runner.launched[0]?.stop();
    expect(await waitUntil(() => built.provider.state().kind === 'failed')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Process output                                                              */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: retained output', () => {
  it('keeps stdout and stderr separate, bounded and redacted', async () => {
    const built = await harness(
      {
        health: 'ok',
        completion: 'ok',
        noisyStdoutBytes: 60_000,
        noisyStderrBytes: 60_000,
        stderrSecret: 'ghp_abcdefghijklmnopqrstuvwxyz0123'
      },
      { maxProcessOutputBytes: 4_000 }
    );
    expect((await built.provider.start()).kind).toBe('healthy');

    const managed = built.runner.launched[0];
    expect(managed).toBeDefined();
    // Let the drains catch up with what the child has already written.
    expect(
      await waitUntil(() => (managed?.output().stdout.length ?? 0) > 1_000)
    ).toBe(true);

    const output = managed?.output() ?? { stdout: '', stderr: '' };
    // Bounded: the budget plus the omission marker, never the whole 60 KB.
    expect(output.stdout.length).toBeLessThan(6_000);
    expect(output.stderr.length).toBeLessThan(6_000);
    expect(output.stdout).toContain('more bytes omitted');
    expect(output.stderr).toContain('more bytes omitted');
    // Separate: each stream kept only its own character.
    expect(output.stdout).not.toContain('eee');
    expect(output.stderr).not.toContain('ooo');
    // Redacted before retention.
    expect(output.stderr).not.toContain('ghp_');

    // And none of it was ever read as an answer: the inference still works.
    expect((await built.provider.infer(request())).kind).toBe('completed');
  });

  it('keeps process output out of the lifecycle state', async () => {
    const built = await harness({ startupExit: 5, noisyStderrBytes: 4_000 }, { startupTimeoutMs: 8_000 });
    const state = await built.provider.start();

    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') return;
    expect(state.reason).not.toContain('eee');
    expect(state.reason.length).toBeLessThanOrEqual(500);
  });
});

/* -------------------------------------------------------------------------- */
/* Stop and cleanup                                                            */
/* -------------------------------------------------------------------------- */

describe('local inference process contract: stop', () => {
  it('removes the parent and its descendant', async () => {
    const built = await harness({ health: 'ok', completion: 'ok', spawnDescendant: true });
    await built.provider.start();

    expect((await built.provider.stop()).kind).toBe('stopped');
    await expectTreeGone(built);
  });

  /**
   * `stopped` is a claim about the tree, and it is made only once the tree is
   * gone — not once the parent's exit has been observed.
   *
   * The descendant here refuses the polite signal, so on POSIX the parent exits
   * on `SIGTERM` while its child carries on; a supervisor that reads the
   * parent's exit as proof returns `stopped` with a process still running.
   *
   * The parent is checked at the instant `stop()` answered. The descendant is
   * given a 250 ms grace, because on Windows the whole cleanup is one
   * `taskkill /F` and `TerminateProcess` is not synchronous — the pid can
   * outlive the call that killed it by a few scheduler turns. That grace is far
   * too short to hide the defect: the descendant this fixture spawns never
   * exits on its own, so under a parent-only cleanup it is alive for the rest of
   * the suite, not for a quarter of a second.
   */
  it('does not answer stopped while a descendant that ignores SIGTERM is alive', async () => {
    const built = await harness({
      health: 'ok',
      completion: 'ok',
      spawnDescendant: true,
      descendantIgnoresTermination: true
    });
    await built.provider.start();
    const { parent, descendant } = pids(built);
    expect(isAlive(descendant)).toBe(true);

    const state = await built.provider.stop();

    expect(state.kind).toBe('stopped');
    expect(isAlive(parent)).toBe(false);
    expect(isAlive(descendant)).toBe(false);
  });

  it('keeps tree cleanup inside the configured shutdown budget', async () => {
    // Small, but not smaller than a tree kill honestly costs: on Windows the
    // whole cleanup is one `taskkill /T /F`, and the budget is what bounds it.
    // Squeezing it below that does not test the bound, it tests the machine.
    const built = await harness(
      { health: 'ok', completion: 'ok', spawnDescendant: true },
      { shutdownTimeoutMs: 4_000 }
    );
    await built.provider.start();

    const startedAt = Date.now();
    expect((await built.provider.stop()).kind).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    await expectTreeGone(built);
  });

  it('is idempotent: two concurrent stops and three repeated ones', async () => {
    const built = await harness({ health: 'ok', completion: 'ok', spawnDescendant: true });
    await built.provider.start();

    const [first, second] = await Promise.all([built.provider.stop(), built.provider.stop()]);
    expect(first?.kind).toBe('stopped');
    expect(second?.kind).toBe('stopped');

    expect((await built.provider.stop()).kind).toBe('stopped');
    expect((await built.provider.stop()).kind).toBe('stopped');

    // No second process was ever launched, and no HTTP request followed.
    expect(built.runner.starts).toHaveLength(1);
    expect(built.runtime.completionRequests()).toHaveLength(0);
    await expectTreeGone(built);
  });

  it('stops a runtime that is mid-inference, and the inference cannot report success', async () => {
    const built = await harness(
      { health: 'ok', completion: 'hang', spawnDescendant: true },
      { inferenceTimeoutMs: 30_000 }
    );
    await built.provider.start();

    const inferring = built.provider.infer(request());
    expect(await waitUntil(() => built.runtime.completionRequests().length === 1)).toBe(true);

    const stopped = await built.provider.stop();
    const outcome = await inferring;

    expect(stopped.kind).toBe('stopped');
    expect(outcome.kind).not.toBe('completed');
    expect(built.provider.state().kind).toBe('stopped');
    await expectTreeGone(built);
  });

  it('is safe before anything was ever started', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    expect((await built.provider.stop()).kind).toBe('stopped');
    expect(built.runner.starts).toHaveLength(0);
    expect(built.runtime.ran()).toBe(false);
  });

  it('allows an explicit restart afterwards', async () => {
    const built = await harness({ health: 'ok', completion: 'ok' });
    await built.provider.start();
    await built.provider.stop();
    expect((await built.provider.start()).kind).toBe('healthy');
    expect(built.runner.starts).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The configured address is not negotiable                                    */
/* -------------------------------------------------------------------------- */

/**
 * A runtime handle that stays up without owning a port.
 *
 * These tests are about the HTTP boundary, not the process one: the two servers
 * below are real, listening on real loopback ports, and one of them has to BE
 * the configured runtime address. A launched fixture would fight it for that
 * port, so the process is the only stubbed thing here.
 */
class AliveProcess implements ManagedProcess {
  readonly pid = 9_101;
  readonly exited: Promise<ManagedProcessExit>;
  private settle!: (exit: ManagedProcessExit) => void;
  private done = false;

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

  async stop(): Promise<ManagedProcessStopResult> {
    if (!this.done) {
      this.done = true;
      this.settle({ exitCode: 0, signal: null, spawnFailed: false, errorCode: null });
    }
    return { kind: 'stopped', exit: await this.exited };
  }
}

class AliveRunner implements LocalInferenceProcessRunner {
  readonly launches: number[] = [];

  async run(): Promise<ProcessResult> {
    return {
      command: 'stub',
      exitCode: 0,
      stdout: '',
      stderr: 'version: 4321 (stub)',
      timedOut: false,
      cancelled: false,
      durationMs: 1,
      failed: false
    };
  }

  launch(): ManagedProcess {
    this.launches.push(this.launches.length);
    return new AliveProcess();
  }
}

/** Everything a loopback server was actually asked for. */
interface Seen {
  readonly method: string;
  readonly url: string;
  readonly bytes: number;
}

interface Loopback {
  readonly port: number;
  readonly seen: Seen[];
  close(): Promise<void>;
}

/** A real server on a real loopback port, recording every byte it receives. */
async function loopback(
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => void
): Promise<Loopback> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', bytes: Buffer.byteLength(body) });
      handle(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');

  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

function ok(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const COMPLETION = {
  id: 'chatcmpl-elsewhere',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'answered elsewhere' }, finish_reason: 'stop' }
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2 }
};

describe('local inference process contract: the configured address is not negotiable', () => {
  const servers: Loopback[] = [];
  const runtimes: FakeLocalInferenceRuntime[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const runtime of runtimes.splice(0)) runtime.cleanup();
  });

  /** Server B: the address the provider was never configured to talk to. */
  async function elsewhere(): Promise<Loopback> {
    const server = await loopback((_req, res) => ok(res, COMPLETION));
    servers.push(server);
    return server;
  }

  function providerOn(
    port: number,
    runner: AliveRunner,
    overrides: Record<string, unknown> = {}
  ): LlamaCppLocalInference {
    const runtime = new FakeLocalInferenceRuntime();
    runtimes.push(runtime);
    return fakeLocalInferenceProvider(runtime, port, overrides, {}, runner);
  }

  it('refuses a redirected inference, and the second server receives nothing', async () => {
    const second = await elsewhere();
    const first = await loopback((req, res) => {
      if (req.url === '/health') return ok(res, { status: 'ok' });
      // A POST is accepted and answered with a redirect to another loopback
      // address. Following it would hand the whole prompt to a server this
      // provider was never pointed at.
      res.writeHead(307, {
        location: `http://127.0.0.1:${second.port}/v1/chat/completions`
      });
      res.end();
    });
    servers.push(first);

    const runner = new AliveRunner();
    const provider = providerOn(first.port, runner);
    // Deliberately the real global fetch: `redirect: 'error'` is a property of
    // the actual HTTP client, and a stub would prove nothing about it.
    expect((await provider.start()).kind).toBe('healthy');

    const outcome = await provider.infer(request());

    // The prompt never left for the other address.
    expect(second.seen).toHaveLength(0);
    expect(second.seen.reduce((total, one) => total + one.bytes, 0)).toBe(0);

    // And no completion was manufactured from a server that was never asked.
    expect(outcome.kind).not.toBe('completed');
    if (outcome.kind === 'completed') return;
    // Honest about what is not known: the first server DID receive the POST —
    // it had to, to answer 3xx — so refusing the redirect is not evidence that
    // nothing was processed.
    expect(outcome.dispatchOutcome).toBe('unknown');
    expect(outcome.dispatchOutcome).not.toBe('not_dispatched');

    // Exactly one POST, and no retry anywhere.
    const posts = first.seen.filter((one) => one.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(runner.launches).toHaveLength(1);

    await provider.stop();
  });

  it('refuses a redirected health check rather than believing another server', async () => {
    const second = await elsewhere();
    const first = await loopback((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${second.port}/health` });
      res.end();
    });
    servers.push(first);

    // A short budget: the point is that a redirect never counts as healthy, not
    // how long the provider is willing to keep asking.
    const provider = providerOn(first.port, new AliveRunner(), { startupTimeoutMs: 1_500 });

    // Startup polls health until its budget runs out; a redirect is never a
    // healthy answer, whatever the address behind it would have said.
    const state = await provider.start();

    expect(state.kind).not.toBe('healthy');
    expect(second.seen).toHaveLength(0);
    await provider.stop();
  });

  it('leaves an ordinary loopback runtime working exactly as before', async () => {
    const first = await loopback((req, res) => {
      if (req.url === '/health') return ok(res, { status: 'ok' });
      return ok(res, COMPLETION);
    });
    servers.push(first);

    const provider = providerOn(first.port, new AliveRunner());
    expect((await provider.start()).kind).toBe('healthy');

    const outcome = await provider.infer(request());

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.completion).toBe('answered elsewhere');
    await provider.stop();
  });
});
