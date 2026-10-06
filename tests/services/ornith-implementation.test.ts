import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { OrnithImplementationService } from '../../src/main/services/ornith-implementation';
import type { AgentProgressEvent, OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
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
      expect(request.messages[0]).toMatchObject({
        role: 'system',
        content: expect.stringContaining('Every reply you send MUST be exactly one JSON object')
      });
      expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1);
      expect(request.responseFormat).toMatchObject({
        type: 'json_schema',
        name: 'ornith_action_v1_recovery'
      });
      expect(request.chatTemplateParameters).toEqual({ enable_thinking: false });
      expect(request.responseFormat?.schema).toMatchObject({ $schema: expect.any(String) });
      const bytes = request.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
        0
      );
      expect(bytes).toBeLessThanOrEqual(16_384 - 1_024 - ORNITH_LIMITS.contextSafetyTokens);
    }
    const secondPrompt = requests[1]!.messages.map((message) => message.content).join('');
    expect(secondPrompt).toContain('"path":"large-context.txt"');
    expect(secondPrompt).toContain('x'.repeat(512));
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

  it('does not allow verification before a changed snapshot or twice for the same snapshot', async () => {
    const sha256 = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'run_verification' },
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256,
        replacements: [{ oldText: 'fixture', newText: 'ornith' }]
      },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'finish', summary: 'Updated and verified the changed fixture.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    let verifications = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      runVerification: async () => {
        verifications += 1;
        return { passed: true, summary: 'passed' };
      }
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(verifications).toBe(1);
    expect(result.ornithAudit.outcomes.filter((outcome) => outcome.code === 'verification_not_ready')).toHaveLength(2);
    expect(JSON.stringify(requests[0]!.responseFormat?.schema)).not.toContain('run_verification');
    expect(JSON.stringify(requests[2]!.responseFormat?.schema)).toContain('run_verification');
    expect(JSON.stringify(requests[3]!.responseFormat?.schema)).not.toContain('run_verification');
    expect(requests.every((request) => request.temperature === 0)).toBe(true);
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

  it('redacts the exact bound checkout roots without weakening rejection of other absolute paths', async () => {
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify({
          version: 1,
          action: 'finish',
          summary: 'Used only repository-relative tools.'
        }));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      specification: {
        ...specification,
        implementationPrompt: `Work in ${repository} and never expose ${worktree}.`
      },
      acceptedPlanReviewAddenda: `The dirty source checkout ${repository} was not copied.`
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('[repository-root]');
    expect(prompt).toContain('[worktree-root]');
    expect(prompt).not.toContain(repository);
    expect(prompt).not.toContain(worktree);

    let unsafeCalls = 0;
    const unsafeResult = await new OrnithImplementationService().implement({
      ...baseRequest({
        ...leaseService,
        inferForOrnith: async (_lease, request) => {
          unsafeCalls += 1;
          return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'not reached' }));
        }
      }, new AbortController().signal),
      specification: {
        ...specification,
        implementationPrompt: 'Read C:\\Users\\someone-else\\private.txt.'
      }
    });
    expect(unsafeResult.assessment.reasonCodes).toContain('disallowed_action');
    expect(unsafeCalls).toBe(0);
  });

  it('returns recoverable tool feedback for duplicate reads and continues the same run', async () => {
    const actions = [
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4 },
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 4 },
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 8 },
      { version: 1, action: 'finish', summary: 'Read the file without repeating repository I/O.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const events: AgentProgressEvent[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      onProgress: (event) => events.push(event)
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(result.ornithAudit.readBytes).toBe(Buffer.byteLength(readFileSync(join(worktree, 'fixture.txt'), 'utf8'), 'utf8') * 2);
    expect(result.ornithAudit.outcomes).toContainEqual(expect.objectContaining({
      action: 'read_file', ok: false, code: 'duplicate_action'
    }));
    const finalPrompt = requests.at(-1)!.messages.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('duplicate_action');
    expect(requests[2]!.responseFormat?.name).toBe('ornith_action_v1_recovery');
    expect(JSON.stringify(requests[2]!.responseFormat?.schema)).toContain('"const":"read_file"');
    expect(events.some((event) => event.type === 'tool_use' && event.text.includes('duplicate_action'))).toBe(true);
  });

  it('remembers EOF so repeated zero-byte reads are denied without repository I/O', async () => {
    const actions = [
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 8, limit: 100 },
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 8, limit: 100 },
      { version: 1, action: 'finish', summary: 'Confirmed the bounded file end once.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    expect(result.ornithAudit.readBytes).toBe(
      Buffer.byteLength(readFileSync(join(worktree, 'fixture.txt'), 'utf8'), 'utf8')
    );
    expect(result.ornithAudit.outcomes).toContainEqual(expect.objectContaining({
      action: 'read_file', ok: false, code: 'duplicate_action'
    }));
    expect(JSON.stringify(requests[2]!.responseFormat?.schema)).toContain('"const":"read_file"');
  });

  it('does not execute the same successful read-only action twice without an intervening write', async () => {
    const actions = [
      { version: 1, action: 'list_files', prefix: '', limit: 20 },
      { version: 1, action: 'list_files', prefix: '', limit: 20 },
      { version: 1, action: 'finish', summary: 'Reused the first manifest page.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    expect(result.ornithAudit.outcomes).toContainEqual(expect.objectContaining({
      action: 'list_files', ok: false, code: 'duplicate_action'
    }));
    expect(requests[2]!.responseFormat?.name).toBe('ornith_action_v1_recovery');
    expect(JSON.stringify(requests[2]!.responseFormat?.schema)).toContain('"const":"list_files"');
  });

  it('lets Ornith recover from a missing read target instead of terminating the run', async () => {
    const actions = [
      { version: 1, action: 'read_file', path: 'missing.txt', offset: 0, limit: 100 },
      { version: 1, action: 'finish', summary: 'Recovered from the missing optional file.' }
    ];
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => completed(request, JSON.stringify(actions[calls++]!))
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    expect(calls).toBe(2);
    expect(result.ornithAudit.outcomes).toContainEqual(expect.objectContaining({
      action: 'read_file', ok: false, code: 'file_not_found'
    }));
  });

  it('keeps replace_text available and recovers with the trusted current hash after a stale attempt', async () => {
    const currentSha = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'read_file', path: 'fixture.txt', offset: 0, limit: 100 },
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256: '0'.repeat(64),
        replacements: [{ oldText: 'fixture', newText: 'ornith' }]
      },
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256: currentSha,
        replacements: [{ oldText: 'fixture', newText: 'ornith' }]
      },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'finish', summary: 'Recovered with the corrected hash.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    const recoveryPrompt = requests[2]!.messages.map((message) => message.content).join('\n');
    expect(recoveryPrompt).toContain(`Use the exact current SHA-256 ${currentSha}.`);
    expect(recoveryPrompt).toContain('Do not delete and recreate an existing file');
    expect(JSON.stringify(requests[2]!.responseFormat?.schema)).toContain('replace_text');
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('ornith');
  });

  it('treats create_file on an existing path as recoverable and directs the model to replace_text', async () => {
    const currentSha = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'create_file', path: 'fixture.txt', content: 'unsafe overwrite' },
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256: currentSha,
        replacements: [{ oldText: 'fixture', newText: 'recovered' }]
      },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'finish', summary: 'Recovered without recreating the file.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    expect(result.ornithAudit.outcomes).toContainEqual(expect.objectContaining({
      action: 'create_file', ok: false, code: 'file_exists'
    }));
    const recoveryPrompt = requests[1]!.messages.map((message) => message.content).join('\n');
    expect(recoveryPrompt).toContain('Edit it with replace_text');
    expect(JSON.stringify(requests[1]!.responseFormat?.schema)).not.toContain('create_file');
    expect(JSON.stringify(requests[1]!.responseFormat?.schema)).toContain('replace_text');
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('recovered');
  });

  it('repairs a bounded malformed completion without executing it', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, calls === 1
          ? 'not-json'
          : JSON.stringify({ version: 1, action: 'finish', summary: 'Recovered with a valid action.' }));
      }
    };

    const result = await new OrnithImplementationService().implement(baseRequest(leaseService, new AbortController().signal));

    expect(result.assessment.disposition).toBe('pass');
    expect(calls).toBe(2);
    expect(() => readFileSync(join(worktree, 'bad.txt'), 'utf8')).toThrow();
  });

  it('cools down a known malformed action and resets the retry streak after valid progress', async () => {
    const malformedList = JSON.stringify({
      version: 1,
      action: 'list_files',
      prefix: '../outside',
      limit: 20
    });
    const completions = [
      malformedList,
      malformedList,
      malformedList,
      JSON.stringify({ version: 1, action: 'git_status' }),
      malformedList,
      JSON.stringify({ version: 1, action: 'finish', summary: 'Recovered after valid progress.' })
    ];
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, completions[requests.length - 1]!);
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('pass');
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(requests[1]!.responseFormat?.schema)).not.toContain('list_files');
    expect(JSON.stringify(requests[4]!.responseFormat?.schema)).not.toContain('list_files');
  });

  it('stops after the fixed malformed-completion retry budget without executing anything', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, 'not-json');
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.reasonCodes).toContain('malformed_output');
    expect(calls).toBe(ORNITH_LIMITS.maxMalformedRetries + 1);
    expect(result.ornithAudit.actions).toBe(0);
    expect(() => readFileSync(join(worktree, 'bad.txt'), 'utf8')).toThrow();
  });

  it('terminates immediately when the cumulative read budget is exhausted', async () => {
    const content = 'x'.repeat(ORNITH_LIMITS.maxFileBytes);
    writeFileSync(join(worktree, 'large.txt'), content, 'utf8');
    let calls = 0;
    const actions = Array.from({ length: 5 }, (_, offset) => JSON.stringify({
      version: 1,
      action: 'read_file',
      path: 'large.txt',
      offset,
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

  it('rejects a blocked narrative disguised as a successful `finish` action', async () => {
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => completed(request, JSON.stringify({
        version: 1,
        action: 'finish',
        summary: 'I cannot complete this task because the required file is unavailable.'
      }))
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(result.assessment.disposition).toBe('fail');
    expect(result.assessment.reasonCodes).toContain('blocked');
    expect(result.finalMessage).toBe('Ornith reported that it could not continue.');
  });

  it('does not accept a correction report until that run actually mutates the repository', async () => {
    const currentSha = createHash('sha256').update(readFileSync(join(worktree, 'fixture.txt'))).digest('hex');
    const actions = [
      { version: 1, action: 'finish', summary: 'Claimed the correction was complete without editing.' },
      {
        version: 1,
        action: 'replace_text',
        path: 'fixture.txt',
        sha256: currentSha,
        replacements: [{ oldText: 'fixture', newText: 'corrected' }]
      },
      { version: 1, action: 'run_verification' },
      { version: 1, action: 'finish', summary: 'Corrected and verified the fixture.' }
    ];
    const requests: LocalInferenceRequest[] = [];
    const events: AgentProgressEvent[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(request, JSON.stringify(actions[requests.length - 1]!));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      runType: 'correction',
      correctionFindings: 'Replace fixture with corrected.',
      onProgress: (event) => events.push(event)
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(JSON.stringify(requests[1]!.responseFormat?.schema)).not.toContain('"const":"finish"');
    expect(events.some((event) => event.type === 'tool_use' && event.text.includes('made no changes'))).toBe(true);
    expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toContain('corrected');
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
