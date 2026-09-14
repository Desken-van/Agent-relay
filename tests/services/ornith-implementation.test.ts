import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { OrnithImplementationService } from '../../src/main/services/ornith-implementation';
import type { OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import { AgentRelayError } from '../../src/shared/domain/errors';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceOutcome,
  type LocalInferenceRequest
} from '../../src/shared/domain/local-inference';
import { ORNITH_LIMITS } from '../../src/shared/domain/ornith';
import type { TaskSpecification } from '../../src/shared/schemas/codex';

const runner = new ExecaProcessRunner();
const locatedGit = locateExecutable('git');
if (!locatedGit) throw new Error('Git is required by the Ornith implementation suite.');
const gitPath = locatedGit.path;
const roots: string[] = [];

let root: string;
let repository: string;
let worktreesRoot: string;
let worktree: string;

const specification: TaskSpecification = {
  title: 'Fixture',
  summary: 'Exercise the bounded Ornith loop.',
  acceptanceCriteria: ['The loop remains bounded.'],
  constraints: [],
  assumptions: [],
  suggestedTests: [],
  implementationPrompt: 'Use only the structured tool protocol.'
};

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(gitPath, args, {
    cwd,
    timeoutMs: 20_000,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true'
    }
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

function lease(overrides: Partial<OrnithHealthyLease> = {}): OrnithHealthyLease {
  return {
    providerId: 'llama.cpp',
    modelId: 'ornith-fixture',
    runtimeInstanceId: 'runtime-fixture',
    contextLimitTokens: 32_768,
    maxOutputTokens: 1_024,
    release: () => undefined,
    onIndependentStop: () => undefined,
    ...overrides
  };
}

function completed(request: LocalInferenceRequest, completion: string): LocalInferenceOutcome {
  return {
    kind: 'completed',
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    response: {
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: request.requestId,
      providerId: 'llama.cpp',
      modelId: 'ornith-fixture',
      runtimeVersion: 'fixture-1',
      runtimeInstanceId: 'runtime-fixture',
      durationMs: 1,
      completion,
      promptTokens: null,
      completionTokens: null,
      runtimeResponseId: null,
      finishReason: { kind: 'stop' }
    }
  };
}

function baseRequest(leaseService: OrnithInferenceLeaseService, signal: AbortSignal, loopDeadlineMs = 60_000) {
  return {
    worktreePath: worktree,
    worktreesRoot,
    repositoryPath: repository,
    branchName: 'task',
    specification,
    ruleEvidence: null,
    acceptedPlanReviewAddenda: null,
    correctionFindings: null,
    runType: 'implementation' as const,
    round: 1,
    maxRounds: 3,
    loopDeadlineMs,
    signal,
    onProgress: () => undefined,
    runVerification: async () => ({ passed: true, summary: 'passed' }),
    lease: lease(),
    leaseService,
    gitExecutablePath: gitPath,
    runner
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-ornith-loop-'));
  roots.push(root);
  repository = join(root, 'repository');
  worktreesRoot = join(root, 'worktrees');
  worktree = join(worktreesRoot, 'task');
  mkdirSync(repository, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Ornith Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'fixture.txt'), 'fixture\n', 'utf8');
  await git(repository, ['add', '--', 'fixture.txt']);
  await git(repository, ['commit', '-m', 'fixture']);
  await git(repository, ['worktree', 'add', '-b', 'task', worktree, 'HEAD']);
});

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('OrnithImplementationService limits and cancellation', () => {
  it('refuses a prompt that cannot fit the retained runtime context before inference', async () => {
    let calls = 0;
    const constrainedLease = lease({ contextLimitTokens: 4_096, maxOutputTokens: 4_096 });
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => constrainedLease,
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'not reached' }));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      lease: constrainedLease
    });

    expect(calls).toBe(0);
    expect(result.assessment.reasonCodes).toContain('limit_context_exceeded');
    expect(result.finalMessage).toContain('4096-token runtime');
    expect(result.finalMessage).toContain('restart the runtime');
    expect(result.providerFailure).toBeNull();
  });

  it('bounds a large read result to the retained context and lowers per-turn output tokens', async () => {
    writeFileSync(join(worktree, 'large-context.txt'), 'x'.repeat(24_000), 'utf8');
    const sha256 = createHash('sha256').update(readFileSync(join(worktree, 'large-context.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'read_file', path: 'large-context.txt', offset: 0, limit: 65_536 },
      { version: 1, action: 'finish', summary: `Read a bounded chunk with hash ${sha256.slice(0, 8)}.` }
    ];
    const boundedLease = lease({ contextLimitTokens: 16_384, maxOutputTokens: 8_192 });
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => boundedLease,
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      lease: boundedLease
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.maxOutputTokens).toBe(1_024);
      const bytes = request.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
        0
      );
      expect(bytes).toBeLessThanOrEqual(16_384 - 1_024 - ORNITH_LIMITS.contextSafetyTokens);
    }
    const secondPrompt = requests[1]!.messages.map((message) => message.content).join('');
    expect(secondPrompt).toContain('"path":"large-context.txt"');
    expect(secondPrompt).not.toContain('x'.repeat(10_000));
  }, 60_000);

  it('preserves a bounded provider failure reason and dispatch outcome', async () => {
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => ({
        kind: 'failed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: request.requestId,
        reason: 'The runtime rejected the inference request with HTTP 500.',
        dispatchOutcome: 'rejected'
      })
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.finalMessage).toContain('HTTP 500');
    expect(result.finalMessage).toContain('(rejected)');
    expect(result.providerFailure).toEqual({
      kind: 'failed',
      reason: 'The runtime rejected the inference request with HTTP 500.',
      dispatchOutcome: 'rejected'
    });
  });

  it('completes a healthy bounded read, edit, diff, verification and finish flow', async () => {
    const sha256 = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'list_files', prefix: '', limit: 20 },
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4096 },
      { version: 1, action: 'replace_text', path: 'fixture.txt', sha256, replacements: [{ oldText: 'fixture', newText: 'ornith' }] },
      { version: 1, action: 'git_diff', paths: ['fixture.txt'] },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'finish', summary: 'Updated the fixture through bounded tools.' }
    ];
    let calls = 0;
    let verifications = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => completed(request, JSON.stringify(actions[calls++]!))
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      runVerification: async () => {
        verifications += 1;
        return { passed: true, summary: 'passed' };
      }
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(result.ornithAudit.actions).toBe(5);
    expect(calls).toBe(6);
    expect(verifications).toBe(1);
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('ornith');
  }, 60_000);

  it('refuses unsafe prompt sources before the first inference', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'not reached' }));
      }
    };
    const safe = baseRequest(leaseService, new AbortController().signal);
    const unsafe = [
      { ...safe, specification: { ...specification, summary: 'path=C:\\Users\\operator\\secret.txt' } },
      { ...safe, specification: { ...specification, constraints: ['token=ghp_abcdefghijklmnopqrstuvwxyz1234567890'] } },
      { ...safe, acceptedPlanReviewAddenda: 'source:/home/operator/private.log' },
      { ...safe, acceptedPlanReviewAddenda: 'api_key=sk-abcdefghijklmnopqrstuv' },
      { ...safe, ruleEvidence: '[\\\\server\\share\\rules.txt]' },
      { ...safe, ruleEvidence: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      { ...safe, correctionFindings: 'log=/var/tmp/raw.log' }
    ];

    for (const request of unsafe) {
      const result = await new OrnithImplementationService().implement(request);
      expect(result.assessment.reasonCodes).toContain('disallowed_action');
    }
    expect(calls).toBe(0);
  });

  it('does not retry malformed output or execute a following action', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, calls === 1 ? 'not-json' : JSON.stringify({ version: 1, action: 'create_file', path: 'bad.txt', content: 'bad' }));
      }
    };

    const result = await new OrnithImplementationService().implement(baseRequest(leaseService, new AbortController().signal));

    expect(result.assessment.reasonCodes).toContain('malformed_output');
    expect(calls).toBe(1);
    expect(() => readFileSync(join(worktree, 'bad.txt'), 'utf8')).toThrow();
  });

  it('terminates immediately when the cumulative read budget is exhausted', async () => {
    const content = 'x'.repeat(ORNITH_LIMITS.maxFileBytes);
    writeFileSync(join(worktree, 'large.txt'), content, 'utf8');
    let calls = 0;
    const actions = Array.from({ length: 5 }, () => JSON.stringify({
      version: 1,
      action: 'read_file',
      path: 'large.txt',
      offset: 0,
      limit: 1
    }));
    actions.push(JSON.stringify({ version: 1, action: 'finish', summary: 'must not be reached' }));
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => completed(request, actions[calls++]!)
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.reasonCodes).toContain('limit_read_bytes_exceeded');
    expect(result.ornithAudit.readBytes).toBe(ORNITH_LIMITS.maxCumulativeReadBytes);
    expect(calls).toBe(5);
  }, 60_000);

  it('maps the whole-loop deadline during inference to limit_deadline_exceeded', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request, signal) => {
        calls += 1;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return {
          kind: 'cancelled',
          version: LOCAL_INFERENCE_CONTRACT_VERSION,
          requestId: request.requestId,
          reason: 'cancelled',
          dispatchOutcome: 'unknown'
        };
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal, 3_000)
    );

    expect(result.assessment.reasonCodes).toContain('limit_deadline_exceeded');
    expect(calls).toBe(1);
  });

  it('discards a completed action returned after the whole-loop deadline', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        // Deliberately ignore the signal to model a provider that resolves a
        // completed response after its caller's absolute deadline.
        await new Promise((resolve) => setTimeout(resolve, 3_500));
        return completed(request, JSON.stringify({
          version: 1,
          action: 'create_file',
          path: 'late.txt',
          content: 'must not be written'
        }));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal, 3_000)
    );

    expect(result.assessment.reasonCodes).toContain('limit_deadline_exceeded');
    expect(calls).toBe(1);
    expect(() => readFileSync(join(worktree, 'late.txt'), 'utf8')).toThrow();
  });

  it('preserves task cancellation during an in-flight inference', async () => {
    const controller = new AbortController();
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request, signal) => {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return {
          kind: 'cancelled',
          version: LOCAL_INFERENCE_CONTRACT_VERSION,
          requestId: request.requestId,
          reason: 'cancelled',
          dispatchOutcome: 'unknown'
        };
      }
    };
    const pending = new OrnithImplementationService().implement(baseRequest(leaseService, controller.signal));
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('discards a completed nonterminal action and runs zero tool calls when the runtime dies between inference and dispatch', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      // The retained runtime is reported gone the moment this exact parsed
      // action is about to be accepted — simulating an unexpected exit
      // landing in the window between a valid completion and its dispatch.
      recheckOrnithLease: async () => false,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, JSON.stringify({
          version: 1,
          action: 'create_file',
          path: 'must-not-be-written.txt',
          content: 'must never land on disk'
        }));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('fail');
    expect(result.assessment.reasonCodes).toContain('runtime_unhealthy');
    expect(result.ornithAudit.actions).toBe(0);
    expect(calls).toBe(1);
    expect(() => readFileSync(join(worktree, 'must-not-be-written.txt'), 'utf8')).toThrow();
  });

  it('discards a `finish` completion and never persists its summary when the runtime dies before it is accepted', async () => {
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => false,
      inferForOrnith: async (_lease, request) =>
        completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'must never be persisted' }))
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('fail');
    expect(result.assessment.reasonCodes).toContain('runtime_unhealthy');
    expect(result.finalMessage).not.toContain('must never be persisted');
  });

  it('rejects a `finish` summary containing an absolute machine path and never persists the offending text', async () => {
    const cases = [
      'Wrote output to C:\\Windows\\Temp\\out.txt as requested',
      'path=C:/Users/nick/secret.txt was updated',
      'See \\\\fileserver\\share\\notes.txt for details',
      'config: /etc/agent-relay/secrets.env was NOT touched',
      '{"path":"C:\\\\Users\\\\op\\\\file.txt"} was the result',
      'See \\\\?\\C:\\Users\\op\\file.txt for the extended-length form'
    ];

    for (const summary of cases) {
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) =>
          completed(request, JSON.stringify({ version: 1, action: 'finish', summary }))
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.reasonCodes).toContain('disallowed_action');
      expect(result.finalMessage).not.toBe(summary);
      expect(JSON.stringify(result)).not.toContain('secret.txt');
      expect(JSON.stringify(result)).not.toContain('notes.txt');
      expect(JSON.stringify(result)).not.toContain('out.txt');
    }
  });

  it('never emits an absolute machine path in a tool-use progress event or audit summary across a full run', async () => {
    const sha256 = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'list_files', prefix: '', limit: 20 },
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4096 },
      { version: 1, action: 'create_file', path: 'nested/new.txt', content: 'hello\n' },
      { version: 1, action: 'replace_text', path: 'fixture.txt', sha256, replacements: [{ oldText: 'fixture', newText: 'ornith' }] },
      { version: 1, action: 'git_diff', paths: ['fixture.txt'] },
      { version: 1, action: 'finish', summary: 'Updated the fixture and added a nested file.' }
    ];
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => completed(request, JSON.stringify(actions[calls++]!))
    };
    const events: unknown[] = [];

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      onProgress: (event) => events.push(event)
    });

    expect(result.assessment.disposition).toBe('pass');
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(worktree.replace(/\\/g, '\\\\'));
    expect(serializedEvents.toLowerCase()).not.toMatch(/[a-z]:[\\/]/);
    expect(serializedEvents).not.toMatch(/\\\\[^\\/\s"]+[\\/]/);
  }, 60_000);

  it('preserves task cancellation while the per-turn lease recheck is in flight', async () => {
    const controller = new AbortController();
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async (_lease, signal) => {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return false;
      },
      inferForOrnith: async (_lease, request) =>
        completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'must not be reached' }))
    };
    const pending = new OrnithImplementationService().implement(baseRequest(leaseService, controller.signal));
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('preserves task cancellation while the checkout-identity check is in flight', async () => {
    const controller = new AbortController();
    let inferenceCalls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        inferenceCalls += 1;
        return completed(request, JSON.stringify({ version: 1, action: 'git_status' }));
      }
    };
    // Every turn opens with a checkout-identity check, itself built from Git
    // calls through the injected runner — a runner that never returns until
    // cancelled models cancellation landing there, before inference is ever
    // reached this turn.
    const hangingRunner = {
      run: (_file: string, _args: readonly string[], options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new AgentRelayError('CANCELLED', 'cancelled')), { once: true });
        })
    };

    const pending = new OrnithImplementationService().implement({
      ...baseRequest(leaseService, controller.signal),
      runner: hangingRunner
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(inferenceCalls).toBe(0);
  });

  it('preserves task cancellation while run_verification is in flight', async () => {
    const controller = new AbortController();
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) =>
        completed(request, JSON.stringify({ version: 1, action: 'run_verification' }))
    };

    const pending = new OrnithImplementationService().implement({
      ...baseRequest(leaseService, controller.signal),
      runVerification: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AgentRelayError('CANCELLED', 'cancelled')), { once: true });
        })
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
