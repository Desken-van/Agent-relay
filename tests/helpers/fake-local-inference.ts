/**
 * Scaffolding for driving `LlamaCppLocalInference` against a real child process.
 *
 * Everything here is about the boundary, not the logic: a throwaway working
 * directory that doubles as the fake runtime's scenario store, a provider
 * pointed explicitly at the fixture (never at a llama.cpp the developer happens
 * to have installed), an OS-assigned port so two suites cannot collide, and a
 * way to ask the operating system whether a process is actually gone.
 */

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlamaCppLocalInference,
  type LlamaCppLocalInferenceOptions,
  type LocalInferenceProcessRunner
} from '../../src/main/adapters/local-inference/llama-cpp-local-inference';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceRequest
} from '../../src/shared/domain/local-inference';

/**
 * The fake runtime, addressed by path.
 *
 * Passed as an explicit executable, which short-circuits discovery entirely:
 * PATH and the well-known Windows locations are never consulted, so the suite
 * behaves the same on a machine with llama.cpp installed and one without.
 */
export const FAKE_LOCAL_INFERENCE_RUNTIME = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'fake-local-inference-runtime.mjs'
);

const SCENARIO_FILE = 'fake-local-inference-scenario.json';
const EVIDENCE_FILE = 'fake-local-inference-evidence.json';

export interface FakeRuntimeScenario {
  /** `--version` behaviour. */
  readonly versionLine?: string;
  readonly versionStream?: 'stdout' | 'stderr';
  readonly versionExit?: number;

  /** Startup behaviour. */
  readonly startupDelayMs?: number;
  readonly startupExit?: number;
  readonly spawnDescendant?: boolean;
  /** On Windows, let the descendant survive if its parent crashes first. */
  readonly detachedDescendant?: boolean;
  /** The descendant installs no-op handlers for SIGTERM/SIGINT/SIGHUP. */
  readonly descendantIgnoresTermination?: boolean;
  /** Bytes of `o`-lines on stdout and `e`-lines on stderr, so they stay apart. */
  readonly noisyStdoutBytes?: number;
  readonly noisyStderrBytes?: number;
  /** A credential-shaped line printed to stderr. Never a real credential. */
  readonly stderrSecret?: string;

  /** `GET /health` behaviour. */
  readonly health?: 'ok' | 'loading' | 'malformed' | 'not_object' | 'non2xx' | 'hang' | 'huge';
  readonly healthDelayMs?: number;

  /** `POST /v1/chat/completions` behaviour. */
  readonly completion?:
    | 'ok'
    | 'hang'
    | 'crash'
    | 'malformed'
    | 'no_choices'
    | 'bad_usage'
    | 'non2xx'
    | 'huge_body'
    | 'huge_completion';
  readonly completionDelayMs?: number;
  readonly completionText?: string;
  /** Answers successive completion requests in order (the last entry repeats once exhausted); overrides `completionText` when present. */
  readonly completionTextSequence?: readonly string[];
  readonly responseId?: string;
  readonly finishReason?: string;
  readonly omitFinishReason?: boolean;
  readonly omitUsage?: boolean;
  readonly hugeBytes?: number;
  readonly crashExit?: number;
}

export interface FakeRuntimeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface FakeRuntimeEvidence {
  readonly pid: number;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly descendantPid: number | null;
  readonly envTokenShapedNames: readonly string[];
  readonly requests: readonly FakeRuntimeRequest[];
}

/**
 * A temporary directory standing in for the runtime's working directory.
 *
 * It is both the `cwd` the provider is asked to use and the only place the fake
 * looks for its instructions, so a run that started somewhere else cannot find a
 * scenario at all — which is how the working-directory claim is tested.
 */
export class FakeLocalInferenceRuntime {
  readonly path: string;

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'agent-relay-fake-local-inference-'));
  }

  /** Replace the scenario. The fixture re-reads it on every request. */
  scenario(scenario: FakeRuntimeScenario): this {
    writeFileSync(join(this.path, SCENARIO_FILE), JSON.stringify(scenario), 'utf8');
    return this;
  }

  /** What the child publicly recorded. Throws when it never ran. */
  evidence(): FakeRuntimeEvidence {
    return JSON.parse(readFileSync(join(this.path, EVIDENCE_FILE), 'utf8')) as FakeRuntimeEvidence;
  }

  ran(): boolean {
    return existsSync(join(this.path, EVIDENCE_FILE));
  }

  /** Every request the runtime received, in order. */
  requests(): readonly FakeRuntimeRequest[] {
    return this.ran() ? this.evidence().requests : [];
  }

  completionRequests(): readonly FakeRuntimeRequest[] {
    return this.requests().filter((request) => request.path === '/v1/chat/completions');
  }

  async cleanup(): Promise<void> {
    // Windows can keep a just-exited process's working directory busy for a
    // handful of scheduler turns while its pipe handles finish closing. The
    // runtime tree is already PID-confirmed dead; bounded retries make fixture
    // cleanup deterministic under the full parallel suite without hiding a
    // live-process leak.
    // Do not use rmSync retries here. A synchronous retry loop blocks the same
    // event loop that Execa's final pipe-close callbacks need, which can turn a
    // harmless Windows handle-release delay into a deterministic EBUSY under a
    // loaded parallel suite. Yield between bounded retries instead.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await rm(this.path, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

/**
 * A port the operating system says is free, right now.
 *
 * Inherently a small race — nothing stops something else taking it between the
 * close and the runtime's bind — but it is the only way to run this suite on a
 * developer machine and a CI box without a hard-coded port that will one day
 * collide with whatever else is listening.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('The operating system did not assign a port.')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface FakeProviderConfigOverrides {
  readonly [key: string]: unknown;
}

/**
 * A valid version-1 configuration pointed at the fixture.
 *
 * The model source is a runtime identifier rather than a path, because there is
 * no model on disk and there must never need to be: nothing in this suite loads
 * weights, downloads anything, or depends on a machine-local llama.cpp install.
 */
export function fakeLocalInferenceConfig(
  runtime: FakeLocalInferenceRuntime,
  port: number,
  overrides: FakeProviderConfigOverrides = {}
): Record<string, unknown> {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    providerId: 'local-fake',
    executable: { kind: 'explicit_path', path: FAKE_LOCAL_INFERENCE_RUNTIME },
    model: { id: 'fake-model', source: { kind: 'runtime_id', runtimeModelId: 'fake-model' } },
    workingDirectory: runtime.path,
    port,
    fixedArguments: ['--threads', '1'],
    contextLimitTokens: 4096,
    maxOutputTokens: 256,
    maxPromptBytes: 64_000,
    maxRequestBytes: 128_000,
    maxResponseBytes: 256_000,
    maxCompletionBytes: 32_000,
    maxProcessOutputBytes: 16_000,
    // Generous by default so a slow machine does not turn a correctness test
    // into a flake. The tests that are *about* a deadline override them.
    startupTimeoutMs: 20_000,
    healthTimeoutMs: 5_000,
    inferenceTimeoutMs: 20_000,
    shutdownTimeoutMs: 10_000,
    ...overrides
  };
}

export function fakeLocalInferenceProvider(
  runtime: FakeLocalInferenceRuntime,
  port: number,
  overrides: FakeProviderConfigOverrides = {},
  options: LlamaCppLocalInferenceOptions = {},
  runner: LocalInferenceProcessRunner = new ExecaProcessRunner()
): LlamaCppLocalInference {
  return new LlamaCppLocalInference(
    runner,
    fakeLocalInferenceConfig(runtime, port, overrides),
    options
  );
}

/**
 * A minimal valid request; `overrides` shape the interesting cases.
 *
 * Typed as the contract but built from a loose record on purpose: several tests
 * need to hand the provider something the schema must refuse, and a helper that
 * could only express valid requests could not write those.
 */
export function fakeInferenceRequest(
  overrides: Record<string, unknown> = {}
): LocalInferenceRequest {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    requestId: 'req-1',
    messages: [{ role: 'user', content: 'Say something short.' }],
    ...overrides
  } as unknown as LocalInferenceRequest;
}
