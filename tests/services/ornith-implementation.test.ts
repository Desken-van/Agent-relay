import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import {
  normalizeOrnithPromptInput,
  OrnithImplementationService,
  preflightOrnithPrompt
} from '../../src/main/services/ornith-implementation';
import type { AgentProgressEvent, OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import { AgentRelayError } from '../../src/shared/domain/errors';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceFinishReason,
  type LocalInferenceOutcome,
  type LocalInferenceRequest
} from '../../src/shared/domain/local-inference';
import { containsAbsoluteMachinePath, ORNITH_LIMITS } from '../../src/shared/domain/ornith';
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

function completed(
  request: LocalInferenceRequest,
  completion: string,
  finishReason: LocalInferenceFinishReason = { kind: 'stop' }
): LocalInferenceOutcome {
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
      finishReason
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
  it('leaves degenerate drive and UNC host roots untouched so unknown paths still fail closed', () => {
    const promptInput = {
      specification: {
        ...specification,
        summary: 'Inspect H:/unrelated/secret.txt and \\\\server\\other\\secret.txt.'
      },
      ruleEvidence: null,
      acceptedPlanReviewAddenda: null,
      correctionFindings: null,
      round: 1,
      maxRounds: 3,
      lease: lease()
    };

    const normalized = normalizeOrnithPromptInput(promptInput, ['H:/', '\\\\server\\']);

    expect(normalized.specification.summary).toBe(promptInput.specification.summary);
    expect(containsAbsoluteMachinePath(normalized.specification.summary)).toBe(true);
  });

  it('normalizes bound-root descendants without consuming sibling or unrelated absolute paths', () => {
    const promptInput = {
      specification: {
        ...specification,
        summary:
          'Read h:/AGENT-RELAY\\src/a.ts, but never H:/Agent-relay-secret/file.txt or C:/outside/file.txt.'
      },
      ruleEvidence: null,
      acceptedPlanReviewAddenda: null,
      correctionFindings: null,
      round: 1,
      maxRounds: 3,
      lease: lease()
    };

    const normalized = normalizeOrnithPromptInput(promptInput, ['H:\\Agent-relay']);

    expect(normalized.specification.summary).toContain('[bound task worktree]\\src/a.ts');
    expect(normalized.specification.summary).toContain('H:/Agent-relay-secret/file.txt');
    expect(normalized.specification.summary).toContain('C:/outside/file.txt');
    expect(containsAbsoluteMachinePath(normalized.specification.summary)).toBe(true);
  });

  it('uses the normalized bound-root text for prompt preflight sizing', () => {
    const repeatedRoot = `${repository.replaceAll('\\', '/')}/a/very/long/relative/path`;
    const promptInput = {
      specification: {
        ...specification,
        implementationPrompt: Array.from({ length: 20 }, () => repeatedRoot).join(' ')
      },
      ruleEvidence: null,
      acceptedPlanReviewAddenda: null,
      correctionFindings: null,
      round: 1,
      maxRounds: 3,
      lease: lease({ contextLimitTokens: 32_768, maxOutputTokens: 1_024 })
    };

    const normalizedInput = normalizeOrnithPromptInput(promptInput, [repository]);
    let distinguishingLimit: number | null = null;
    for (let contextLimitTokens = 4_096; contextLimitTokens <= 32_768; contextLimitTokens += 64) {
      const candidateLease = lease({ contextLimitTokens, maxOutputTokens: 1_024 });
      const raw = preflightOrnithPrompt({ ...promptInput, lease: candidateLease });
      const normalized = preflightOrnithPrompt({ ...normalizedInput, lease: candidateLease });
      if (!raw.ok && normalized.ok) {
        distinguishingLimit = contextLimitTokens;
        break;
      }
    }

    expect(distinguishingLimit).not.toBeNull();
    expect(normalizedInput.specification.implementationPrompt).not.toContain(repository);
  });

  it('reserves rolling feedback space when authoritative prompt content is large', () => {
    const checked = preflightOrnithPrompt({
      specification: {
        ...specification,
        implementationPrompt: `Implement the approved scope. ${'x'.repeat(20_000)}`
      },
      ruleEvidence: null,
      acceptedPlanReviewAddenda: null,
      correctionFindings: null,
      round: 1,
      maxRounds: 3,
      lease: lease()
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.budget.maxToolResultBytes).toBeGreaterThanOrEqual(256);
    expect(checked.budget.maxToolResultBytes).toBeLessThan(10_000);
  });

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
    const expectedOutputTokens = Math.min(
      ORNITH_LIMITS.maxTurnOutputTokens,
      Math.floor((16_384 - ORNITH_LIMITS.contextSafetyTokens) / 4)
    );
    for (const request of requests) {
      expect(request.structuredOutput).toBe('ornith_action_v1');
      expect(request.maxOutputTokens).toBe(expectedOutputTokens);
      const bytes = request.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
        0
      );
      expect(bytes).toBeLessThanOrEqual(16_384 - expectedOutputTokens - ORNITH_LIMITS.contextSafetyTokens);
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

  it('replaces only the already-bound project and worktree roots while preserving ordinary slash prose', async () => {
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        return completed(
          request,
          JSON.stringify({ version: 1, action: 'finish', summary: 'The bounded task is complete.' })
        );
      }
    };
    const repositoryForward = repository.replaceAll('\\', '/');
    const worktreeForward = worktree.replaceAll('\\', '/');

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      specification: {
        ...specification,
        constraints: [`Work only in ${repositoryForward}.`],
        implementationPrompt:
          `Use ${worktreeForward}/src as the task checkout and derive progress as floor(sum / count).`
      }
    });

    expect(result.assessment.disposition).toBe('pass');
    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('[bound task worktree]');
    expect(prompt).toContain('floor(sum / count)');
    expect(prompt).not.toContain(repository);
    expect(prompt).not.toContain(repositoryForward);
    expect(prompt).not.toContain(worktree);
    expect(prompt).not.toContain(worktreeForward);
  });

  it('lets a model page a large directory listing to completion via nextCursor under a tight tool-result budget', async () => {
    // Regression test for the reported failure: a monolithic specification leaves so
    // little room per tool result that a 200+ entry list_files result used to collapse
    // entirely to a generic "request a smaller page or read chunk" stub with no files
    // and no nextCursor — leaving a model with nothing to act on but repeating the
    // identical request, which the no-progress guard then (correctly) stopped. With
    // list_files now packing its own response to fit the budget, the model receives a
    // real, usable page and a real nextCursor on every turn instead.
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(
        join(worktree, `roadmap-long-file-name-${String(index).padStart(3, '0')}.tsx`),
        'export {};\n',
        'utf8'
      );
    }
    const requests: LocalInferenceRequest[] = [];
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        requests.push(request);
        if (requests.length === 1) {
          return completed(request, JSON.stringify({ version: 1, action: 'list_files', prefix: '', limit: 200 }));
        }
        // Simulate a model that actually reads nextCursor from its own prior prompt
        // (as the sharpened protocol instructions now spell out) rather than one that
        // repeats the same request or has to guess.
        const promptText = request.messages.map((message) => message.content).join('\n');
        const cursorMatches = [...promptText.matchAll(/"nextCursor":\s*(\d+|null)/g)];
        const lastCursor = cursorMatches.at(-1)?.[1] ?? null;
        if (lastCursor !== null && lastCursor !== 'null') {
          return completed(
            request,
            JSON.stringify({ version: 1, action: 'list_files', prefix: '', limit: 200, cursor: Number(lastCursor) })
          );
        }
        return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'Paged through the listing.' }));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      specification: {
        ...specification,
        implementationPrompt: `Implement the approved scope. ${'x'.repeat(22_000)}`
      }
    });

    expect(result.assessment.disposition).toBe('pass');
    // The tight budget (a few KB per tool result against a 200+ entry listing) means a
    // single page cannot hold everything, so completing requires more than one round —
    // proof the model kept receiving real, actionable pages rather than an immediate
    // generic stub.
    expect(requests.length).toBeGreaterThan(2);
    const secondPrompt = requests[1]!.messages.map((message) => message.content).join('\n');
    expect(secondPrompt).toContain('PRIOR TOOL RESULTS');
    expect(secondPrompt).toContain('roadmap-long-file-name-000.tsx');
    expect(secondPrompt).not.toContain('request a smaller page or read chunk');
  });

  it('preflight refuses before any inference call when the prompt fits but leaves too little room to page tool results usefully', async () => {
    // Reproduces the reported real-run condition mechanically: a large, monolithic
    // specification (comparable to the "durable hierarchical project roadmaps" task)
    // against a context limit generous enough that the prompt itself fits, but leaves
    // only a few hundred bytes per tool result — nowhere near enough to page a
    // directory listing usefully. This must be refused before the first inference call,
    // with guidance toward decomposing the specification, not toward the single "raise
    // the context limit" remediation that would only defer the same failure to a
    // larger specification.
    const largeSpecification: TaskSpecification = {
      title: 'Implement durable hierarchical project roadmaps',
      summary: 'x'.repeat(2_000),
      acceptanceCriteria: Array.from({ length: 20 }, (_, i) => `Criterion ${i}: ${'y'.repeat(150)}`),
      constraints: Array.from({ length: 10 }, (_, i) => `Constraint ${i}: ${'z'.repeat(150)}`),
      assumptions: Array.from({ length: 5 }, (_, i) => `Assumption ${i}`),
      suggestedTests: Array.from({ length: 10 }, (_, i) => `Test ${i}: ${'w'.repeat(100)}`),
      implementationPrompt: 'q'.repeat(15_000)
    };
    const tightLease = lease({ contextLimitTokens: 32_768, maxOutputTokens: 4_096 });

    const preflight = preflightOrnithPrompt({
      specification: largeSpecification,
      ruleEvidence: null,
      acceptedPlanReviewAddenda: null,
      correctionFindings: null,
      round: 1,
      maxRounds: 3,
      lease: tightLease
    });
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.kind).toBe('tool_result_budget_too_small');
    expect(preflight.reason).toMatch(/split the specification|smaller.*sub-task/i);

    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => tightLease,
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'not reached' }));
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      specification: largeSpecification,
      lease: tightLease
    });

    expect(calls).toBe(0);
    expect(result.assessment.reasonCodes).toContain('limit_context_exceeded');
    expect(result.assessment.disposition).toBe('fail');
    expect(result.finalMessage).toMatch(/split the specification|smaller.*sub-task/i);
  });

  it('warns once and then stops an identical read-only action loop without dispatching duplicates', async () => {
    let calls = 0;
    const events: AgentProgressEvent[] = [];
    const repeated = JSON.stringify({ version: 1, action: 'list_files', prefix: '', limit: 20 });
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, repeated);
      }
    };

    const result = await new OrnithImplementationService().implement({
      ...baseRequest(leaseService, new AbortController().signal),
      onProgress: (event) => events.push(event)
    });

    expect(calls).toBe(3);
    expect(result.assessment.reasonCodes).toContain('no_progress_loop');
    expect(result.ornithAudit.actions).toBe(3);
    expect(result.ornithAudit.outcomes).toHaveLength(3);
    expect(events.some((event) => event.text.includes('Skipped duplicate'))).toBe(true);
    expect(events.some((event) => event.text.includes('loop stopped'))).toBe(true);
  });

  it('does not reread an identical file chunk while the model ignores its result', async () => {
    writeFileSync(join(worktree, 'repeat.txt'), 'repeat me', 'utf8');
    let calls = 0;
    const repeated = JSON.stringify({
      version: 1,
      action: 'read_file',
      path: 'repeat.txt',
      offset: 0,
      limit: 64
    });
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(request, repeated);
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(calls).toBe(3);
    expect(result.assessment.reasonCodes).toContain('no_progress_loop');
    expect(result.ornithAudit.actions).toBe(3);
    expect(result.ornithAudit.readBytes).toBe(Buffer.byteLength('repeat me'));
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

  it('reports an output-token truncation distinctly from arbitrary malformed output', async () => {
    let calls = 0;
    const leaseService: OrnithInferenceLeaseService = {
      acquireOrnithLease: async () => lease(),
      recheckOrnithLease: async () => true,
      inferForOrnith: async (_lease, request) => {
        calls += 1;
        return completed(
          request,
          '{"version":1,"action":"create_file","path":"large.ts","content":"unfinished',
          { kind: 'length' }
        );
      }
    };

    const result = await new OrnithImplementationService().implement(
      baseRequest(leaseService, new AbortController().signal)
    );

    expect(calls).toBe(1);
    expect(result.assessment.reasonCodes).toContain('limit_output_exceeded');
    expect(result.finalMessage).toContain('1024-token output limit');
    expect(result.finalMessage).toContain('Default max output tokens');
    expect(() => readFileSync(join(worktree, 'large.ts'), 'utf8')).toThrow();
  });

  it('terminates immediately when the cumulative read budget is exhausted', async () => {
    const content = 'x'.repeat(ORNITH_LIMITS.maxFileBytes);
    writeFileSync(join(worktree, 'large.txt'), content, 'utf8');
    let calls = 0;
    const actions = Array.from({ length: 5 }, (_unused, offset) => JSON.stringify({
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
