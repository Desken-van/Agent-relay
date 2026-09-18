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

  describe('list_files pagination across the full implement() pipeline at specific tight budgets', () => {
    // preflightOrnithPrompt's own minRollingFeedbackBytes gate (>= 1024 bytes of
    // rolling budget must remain) means maxToolResultBytes can mathematically never
    // go below floor((1024 - ROLLING_HISTORY_OVERHEAD_BYTES(256)) / 2) = 384 bytes
    // from any call that returns ok:true — verified empirically below. 256 and 300
    // are therefore not reachable from a passing preflight call at all; 384 stands in
    // as the tightest budget preflight can actually hand to a live run. The mechanism
    // itself (listFiles / searchText packing, the resultTextFor invariant guard) is
    // separately tested directly at exactly 256/300/16/etc in
    // tests/adapters/ornith-worktree-tools.test.ts, where the budget is supplied
    // directly rather than derived from preflight.
    // chars values are recalibrated whenever ORNITH_PROTOCOL_INSTRUCTIONS' fixed
    // byte length changes (most recently: the read-only-timeout-recovery rule),
    // since that text is part of the same authoritative/fixed prompt budget this
    // filler trades off against. Recompute empirically (binary-search
    // `preflightOrnithPrompt` for the `chars` that yields each target budget)
    // rather than hand-deriving the offset.
    const budgetCases: { label: string; chars: number; expectedBudget: number }[] = [
      { label: '384 bytes (the true minimum achievable from a passing preflight call)', chars: 123_721, expectedBudget: 384 },
      { label: '407 bytes (just under the old, now-removed 409-byte fallback stub size)', chars: 123_675, expectedBudget: 407 },
      { label: '408 bytes (right at the old fallback stub size)', chars: 123_673, expectedBudget: 408 },
      { label: '471 bytes ("408+": comfortably normal)', chars: 123_547, expectedBudget: 471 }
    ];

    for (const { label, chars, expectedBudget } of budgetCases) {
      it(`pages a 150-file listing to completion with no gaps or duplicates at ${label}`, async () => {
        const bigLease = { contextLimitTokens: 131_072, maxOutputTokens: 1_024 };
        const oversizedSpecification: TaskSpecification = {
          ...specification,
          implementationPrompt: `Implement the approved scope. ${'x'.repeat(chars)}`
        };

        // Sanity-check the harness is actually exercising the claimed budget before
        // trusting anything downstream.
        const preflight = preflightOrnithPrompt({
          specification: oversizedSpecification,
          ruleEvidence: null,
          acceptedPlanReviewAddenda: null,
          correctionFindings: null,
          round: 1,
          maxRounds: 3,
          lease: bigLease
        });
        expect(preflight.ok).toBe(true);
        if (!preflight.ok) return;
        expect(preflight.budget.maxToolResultBytes).toBe(expectedBudget);

        // Short names so a normal page can hold at least one entry even at the
        // tightest budget under test (384 bytes): this exercises ordinary packing,
        // not the separate fail-closed path for a single oversized entry.
        for (let index = 0; index < 150; index += 1) {
          writeFileSync(join(worktree, `f${String(index).padStart(3, '0')}.ts`), 'export {};\n', 'utf8');
        }

        const requests: LocalInferenceRequest[] = [];
        const seenFiles = new Set<string>();
        const leaseService: OrnithInferenceLeaseService = {
          acquireOrnithLease: async () => lease(bigLease),
          recheckOrnithLease: async () => true,
          inferForOrnith: async (_lease, request) => {
            requests.push(request);
            const promptText = request.messages.map((message) => message.content).join('\n');
            for (const match of promptText.matchAll(/"(f\d{3}\.ts)"/g)) seenFiles.add(match[1]!);
            if (requests.length === 1) {
              return completed(request, JSON.stringify({ version: 1, action: 'list_files', prefix: '', limit: 200 }));
            }
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
          specification: oversizedSpecification,
          lease: lease(bigLease)
        });

        expect(result.assessment.disposition).toBe('pass');
        expect(requests.length).toBeGreaterThan(1);
        const allPromptText = requests.map((request) => request.messages.map((message) => message.content).join('\n')).join('\n---\n');
        // The removed generic stub's own wording must never appear: proof the
        // now-fail-closed/denied oversized-entry path was never hit here (these files
        // are short) and that the old metadata-erasing fallback is not reachable via
        // this route either.
        expect(allPromptText).not.toContain('request a smaller page or read chunk');
        // All 150 files were actually seen across the run's prompts — no gaps.
        expect(seenFiles.size).toBe(150);
      });
    }

    it('fails the whole run closed, with no files changed, rather than silently completing an incomplete enumeration', async () => {
      const bigLease = { contextLimitTokens: 131_072, maxOutputTokens: 1_024 };
      const oversizedSpecification: TaskSpecification = {
        ...specification,
        implementationPrompt: `Implement the approved scope. ${'x'.repeat(123_721)}` // -> 384-byte budget
      };
      const preflight = preflightOrnithPrompt({
        specification: oversizedSpecification,
        ruleEvidence: null,
        acceptedPlanReviewAddenda: null,
        correctionFindings: null,
        round: 1,
        maxRounds: 3,
        lease: bigLease
      });
      expect(preflight.ok).toBe(true);
      if (!preflight.ok) return;
      expect(preflight.budget.maxToolResultBytes).toBe(384);

      // A single legal, existing path whose own JSON representation alone exceeds the
      // 384-byte budget. `prefix` set to its exact name means the very first
      // list_files call resolves to just this one entry, regardless of what else
      // exists in the manifest or how it sorts alphabetically. 130 multi-byte (3
      // UTF-8 bytes each) characters keep the actual filesystem path short (well
      // under Windows' ~260-character MAX_PATH) while still exceeding the byte
      // budget once JSON-encoded: 130 real characters is a legal, if unusual, file
      // name, not a path-length attack.
      const oversizedName = '文'.repeat(130);
      writeFileSync(join(worktree, oversizedName), 'export {};\n', 'utf8');

      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(bigLease),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) =>
          completed(request, JSON.stringify({ version: 1, action: 'list_files', prefix: oversizedName, limit: 200 }))
      };

      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        specification: oversizedSpecification,
        lease: lease(bigLease)
      });

      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.reasonCodes).toContain('limit_result_exceeded');
      // Denied, not silently degraded to an incomplete "success": no file was created,
      // read, or modified — the run stopped before claiming anything about the
      // repository it could not actually back up.
      expect(result.ornithAudit.changedFiles).toBe(0);
      expect(result.ornithAudit.readBytes).toBe(0);
    });

    it('marks a byte-budget-truncated search_text result truncated instead of silently collapsing it to the generic stub', async () => {
      const bigLease = { contextLimitTokens: 131_072, maxOutputTokens: 1_024 };
      const oversizedSpecification: TaskSpecification = {
        ...specification,
        implementationPrompt: `Implement the approved scope. ${'x'.repeat(123_721)}` // -> 384-byte budget
      };
      for (let index = 0; index < 40; index += 1) {
        writeFileSync(join(worktree, `s${String(index).padStart(3, '0')}.txt`), 'needle appears here\n', 'utf8');
      }

      const requests: LocalInferenceRequest[] = [];
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(bigLease),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          requests.push(request);
          return completed(
            request,
            requests.length === 1
              ? JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 40 })
              : JSON.stringify({ version: 1, action: 'finish', summary: 'Saw a truncated search result.' })
          );
        }
      };

      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        specification: oversizedSpecification,
        lease: lease(bigLease)
      });

      expect(result.assessment.disposition).toBe('pass');
      expect(requests).toHaveLength(2);
      const secondPrompt = requests[1]!.messages.map((message) => message.content).join('\n');
      expect(secondPrompt).toContain('PRIOR TOOL RESULTS');
      // Real, honest partial data reached the model: some matches, explicitly marked
      // truncated — never the old metadata-free generic stub.
      expect(secondPrompt).toContain('"truncated":true');
      expect(secondPrompt).toMatch(/"matches":\[\{"path":"s\d{3}\.txt"/);
      expect(secondPrompt).not.toContain('request a smaller page or read chunk');
    });

    it('fails a search_text-driven run closed when every real match is individually oversized, instead of a dead-end empty result', async () => {
      const bigLease = { contextLimitTokens: 131_072, maxOutputTokens: 1_024 };
      const oversizedSpecification: TaskSpecification = {
        ...specification,
        implementationPrompt: `Implement the approved scope. ${'x'.repeat(123_721)}` // -> 384-byte budget
      };
      // Multi-byte (3 UTF-8 bytes each) names: short enough in UTF-16 code units to
      // stay well under Windows' MAX_PATH, long enough in UTF-8 bytes that every
      // {path,line} match entry alone exceeds the 384-byte budget.
      for (let index = 0; index < 3; index += 1) {
        writeFileSync(join(worktree, `${'文'.repeat(120)}${index}.txt`), 'needle appears here\n', 'utf8');
      }

      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(bigLease),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          return completed(
            request,
            JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 40 })
          );
        }
      };

      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        specification: oversizedSpecification,
        lease: lease(bigLease)
      });

      // The action is denied on its first attempt: not a loop, not a partial
      // "success" — an honest, immediate failure once it is clear nothing found can
      // be represented within budget.
      expect(calls).toBe(1);
      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.reasonCodes).toContain('limit_result_exceeded');
      expect(result.ornithAudit.changedFiles).toBe(0);
    });
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

  it('terminates once the cumulative read budget is exhausted and its one recovery attempt is also denied', async () => {
    const content = 'x'.repeat(ORNITH_LIMITS.maxFileBytes);
    writeFileSync(join(worktree, 'large.txt'), content, 'utf8');
    let calls = 0;
    // 4 reads exhaust the 4MB cumulative budget exactly. The 5th is denied and
    // gets the one bounded `limit_read_bytes_exceeded` recovery attempt; the
    // 6th (a distinct offset, so not caught by the identical-action guard) is
    // denied again with none left, ending the run.
    const actions = Array.from({ length: 6 }, (_unused, offset) => JSON.stringify({
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
    expect(calls).toBe(6);
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

  describe('read-only timeout classification and bounded recovery', () => {
    const originalSearchTimeoutMs = ORNITH_LIMITS.searchTimeoutMs;
    const originalMaxRecoveryAttempts = ORNITH_LIMITS.maxReadOnlyRecoveryAttempts;

    afterEach(() => {
      (ORNITH_LIMITS as { searchTimeoutMs: number }).searchTimeoutMs = originalSearchTimeoutMs;
      (ORNITH_LIMITS as { maxReadOnlyRecoveryAttempts: number }).maxReadOnlyRecoveryAttempts = originalMaxRecoveryAttempts;
    });

    it('feeds a read-only timeout back as recoverable and finishes once the model pivots to a different action', async () => {
      // 1ms is far below the real cost of even a single `git rev-parse` spawn,
      // so the very first search_text call's own checkout-identity check times
      // out deterministically and honestly — no fake hang is required, since
      // real git subprocess latency is exactly the cost this fix exists to
      // bound. Only searchText's own timeout window shrinks: the loop's
      // separate pre-dispatch identity check uses gitTimeoutMs (unaffected),
      // and `finish` never touches the filesystem at all.
      (ORNITH_LIMITS as { searchTimeoutMs: number }).searchTimeoutMs = 1;
      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          if (calls === 1) {
            return completed(request, JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 }));
          }
          return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'Pivoted away from the timed-out search.' }));
        }
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(calls).toBe(2);
      expect(result.assessment.disposition).toBe('pass');
      expect(result.ornithAudit.outcomes[0]).toMatchObject({ action: 'search_text', ok: false, code: 'timeout' });
    });

    it('exhausts the read-only recovery budget and ends the run classified as configuration, not security', async () => {
      (ORNITH_LIMITS as { searchTimeoutMs: number }).searchTimeoutMs = 1;
      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        // A distinct query every turn so the pre-dispatch identical-action
        // guard never intervenes — this exercises the recovery BUDGET running
        // out, not the separate identical-repeat guard.
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          return completed(request, JSON.stringify({ version: 1, action: 'search_text', query: `needle-${calls}`, caseSensitive: false, limit: 10 }));
        }
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      // One initial attempt plus `maxReadOnlyRecoveryAttempts` recoveries, then terminal.
      expect(calls).toBe(1 + ORNITH_LIMITS.maxReadOnlyRecoveryAttempts);
      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.publishBlock).toBe('configuration');
      expect(result.assessment.reasonCodes).toContain('timeout');
      expect(result.finalMessage).toContain('search_text');
      expect(result.finalMessage).toContain('timeout');
      expect(result.ornithAudit.changedFiles).toBe(0);
    });

    it('rejects an identical repeated search after a failure without re-invoking the tool', async () => {
      (ORNITH_LIMITS as { searchTimeoutMs: number }).searchTimeoutMs = 1;
      const repeated = JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 });
      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          if (calls <= 2) return completed(request, repeated);
          return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'Done after the identical repeat was refused.' }));
        }
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(calls).toBe(3);
      expect(result.assessment.disposition).toBe('pass');
      // Turn 1: real dispatch, timed out (carries a code). Turn 2: identical
      // repeat, skipped without dispatch (no code — nothing actually ran).
      expect(result.ornithAudit.outcomes[0]).toMatchObject({ action: 'search_text', ok: false, code: 'timeout' });
      expect(result.ornithAudit.outcomes[1]).toMatchObject({ action: 'search_text', ok: false });
      expect(result.ornithAudit.outcomes[1]?.code).toBeUndefined();
    });

    it('classifies a resource-limit denial as configuration with an exact, specific message', async () => {
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) =>
          completed(request, JSON.stringify({ version: 1, action: 'read_file', path: 'does-not-exist.txt', offset: 0, limit: 64 }))
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.publishBlock).toBe('configuration');
      expect(result.assessment.reasonCodes).toContain('file_not_found');
      expect(result.finalMessage).toContain('read_file');
      expect(result.finalMessage).toContain('file_not_found');
      expect(result.finalMessage).not.toContain('unsafe or over-limit');
    });

    it('classifies a credential-shaped read denial as security with an exact, specific message', async () => {
      writeFileSync(join(worktree, 'secret.txt'), 'ghp_1234567890abcdef1234567890abcd\n', 'utf8');
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) =>
          completed(request, JSON.stringify({ version: 1, action: 'read_file', path: 'secret.txt', offset: 0, limit: 64 }))
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.publishBlock).toBe('security');
      expect(result.assessment.reasonCodes).toContain('disallowed_action');
      expect(result.finalMessage).toContain('read_file');
      expect(result.finalMessage).toContain('disallowed_action');
    });
  });

  describe('specification scope and read-budget recovery', () => {
    it('reads and edits the one file the specification scoped, with zero list_files/search_text calls', async () => {
      mkdirSync(join(worktree, 'docs'), { recursive: true });
      const scopedContent = 'Manual test checklist\n';
      writeFileSync(join(worktree, 'docs', 'manual-test.md'), scopedContent, 'utf8');
      // Plenty of other repository files a repo-wide search/list would otherwise touch.
      for (let index = 0; index < 30; index += 1) {
        writeFileSync(join(worktree, `unrelated-${String(index).padStart(2, '0')}.ts`), 'export {};\n', 'utf8');
      }
      const sha256 = createHash('sha256').update(scopedContent, 'utf8').digest('hex');

      const requests: LocalInferenceRequest[] = [];
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          requests.push(request);
          if (requests.length === 1) {
            return completed(request, JSON.stringify({ version: 1, action: 'read_file', path: 'docs/manual-test.md', offset: 0, limit: 4096 }));
          }
          if (requests.length === 2) {
            return completed(request, JSON.stringify({
              version: 1, action: 'replace_text', path: 'docs/manual-test.md', sha256,
              replacements: [{ oldText: 'checklist', newText: 'checklist (updated)' }]
            }));
          }
          return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'Updated the scoped checklist.' }));
        }
      };

      const events: AgentProgressEvent[] = [];
      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        specification: { ...specification, scopedFilePaths: ['docs/manual-test.md'] },
        onProgress: (event) => events.push(event)
      });

      expect(result.assessment.disposition).toBe('pass');
      expect(result.ornithAudit.changedFiles).toBe(1);
      expect(result.ornithAudit.outcomes.map((o) => o.action)).toEqual(['read_file', 'replace_text']);
      expect(readFileSync(join(worktree, 'docs', 'manual-test.md'), 'utf8')).toContain('checklist (updated)');
      // Confirming scope is visible progress, not a silent stall before the first turn.
      expect(events.some((event) => event.text.includes('Confirming specification scope'))).toBe(true);
      const firstPrompt = requests[0]!.messages.map((message) => message.content).join('\n');
      expect(firstPrompt).toContain('=== SCOPE ===');
      expect(firstPrompt).toContain('docs/manual-test.md');
    });

    it('emits a diagnostic note and falls back to unrestricted discovery when declared scope does not exist', async () => {
      writeFileSync(join(worktree, 'real.txt'), 'needle here\n', 'utf8');
      const events: AgentProgressEvent[] = [];
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) =>
          completed(request, JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 }))
      };

      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        specification: { ...specification, scopedFilePaths: ['docs/does-not-exist.md'] },
        onProgress: (event) => events.push(event)
      });

      expect(events.some((event) => event.text.includes('could not be confirmed'))).toBe(true);
      // Falls back to unrestricted: the search still finds the real file.
      expect(result.ornithAudit.outcomes[0]).toMatchObject({ action: 'search_text', ok: true });
    });

    /**
     * Builds a repository of `count` same-size tracked files (each exactly at
     * `ORNITH_LIMITS.maxReadBytes`, so `search_text` reads every byte of every
     * one of them and none is skipped for being individually oversized) whose
     * total exactly equals the whole cumulative read budget, leaving nothing
     * remaining — including for the tiny pre-existing `fixture.txt` from
     * `beforeEach`, which a search_text `continue`-past-oversized-candidates
     * scan would otherwise still find room for. Reproduces the real observed
     * run (a broad search that ate the whole budget, followed by a later
     * search this account could no longer fit at all).
     */
    function writeBudgetExhaustingFiles(): { fileBytes: number; count: number; remainingAfterFirstSearch: number } {
      const fileBytes = ORNITH_LIMITS.maxReadBytes; // exactly at the per-file cap, not over it
      const count = ORNITH_LIMITS.maxCumulativeReadBytes / fileBytes; // exact division: 64
      for (let index = 0; index < count; index += 1) {
        const content = index === 0
          ? `needle\n${'a'.repeat(fileBytes - 7)}`
          : 'a'.repeat(fileBytes);
        writeFileSync(join(worktree, `f${String(index).padStart(3, '0')}.txt`), content, 'utf8');
      }
      return {
        fileBytes,
        count,
        remainingAfterFirstSearch: ORNITH_LIMITS.maxCumulativeReadBytes - count * fileBytes
      };
    }

    it('feeds a real read-budget denial back once, then completes once the model pivots to a valid mutation', async () => {
      const { fileBytes, remainingAfterFirstSearch } = writeBudgetExhaustingFiles();
      expect(remainingAfterFirstSearch).toBeLessThan(fileBytes); // a further broad search cannot fit even one file
      const broadSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 });
      const differentSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'other-term', caseSensitive: false, limit: 10 });
      let calls = 0;
      const events: AgentProgressEvent[] = [];
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          if (calls === 1) return completed(request, broadSearch); // consumes almost the whole budget
          if (calls === 2) return completed(request, broadSearch); // identical repeat: rejected, not dispatched
          if (calls === 3) return completed(request, differentSearch); // over budget: denied, zero progress
          if (calls === 4) return completed(request, JSON.stringify({ version: 1, action: 'create_file', path: 'result.md', content: 'Found it.' }));
          if (calls === 5) return completed(request, JSON.stringify({ version: 1, action: 'run_verification' }));
          return completed(request, JSON.stringify({ version: 1, action: 'finish', summary: 'Pivoted after the read-budget denial.' }));
        }
      };

      const result = await new OrnithImplementationService().implement({
        ...baseRequest(leaseService, new AbortController().signal),
        runVerification: async () => ({ passed: true, summary: 'passed' }),
        onProgress: (event) => events.push(event)
      });

      expect(calls).toBe(6);
      expect(result.assessment.disposition).toBe('pass');
      expect(result.ornithAudit.changedFiles).toBe(1);
      expect(readFileSync(join(worktree, 'result.md'), 'utf8')).toBe('Found it.');
      // The denial was fed back as recoverable, not as a terminal stop.
      expect(events.some((event) => event.text.includes('one recovery attempt offered'))).toBe(true);
      expect(events.some((event) => event.text.includes('the run stopped'))).toBe(false);
    });

    it('does not redispatch a repeated read-budget denial and ends in a bounded terminal failure with zero mutation', async () => {
      writeBudgetExhaustingFiles();
      const broadSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 });
      const differentSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'other-term', caseSensitive: false, limit: 10 });
      let dispatchedDifferentSearch = 0;
      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          if (calls === 1) return completed(request, broadSearch);
          if (calls === 2) return completed(request, broadSearch); // duplicate: not dispatched
          // Every remaining turn repeats the SAME over-budget request: the
          // identical-action guard must intercept every one after the first.
          return completed(request, differentSearch);
        }
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      dispatchedDifferentSearch = result.ornithAudit.outcomes.filter(
        (o) => o.action === 'search_text' && o.code === 'limit_read_bytes_exceeded'
      ).length;
      expect(dispatchedDifferentSearch).toBe(1); // denied exactly once for real; every repeat after was intercepted
      expect(calls).toBe(5); // 1 real + 1 duplicate + 1 real denial + 1 duplicate + 1 no-progress terminal
      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.reasonCodes).toContain('no_progress_loop');
      expect(result.ornithAudit.changedFiles).toBe(0);
    });

    it('fails closed as configuration, not security, when the model cannot safely continue after its one recovery attempt', async () => {
      writeBudgetExhaustingFiles();
      const broadSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'needle', caseSensitive: false, limit: 10 });
      const differentSearch = JSON.stringify({ version: 1, action: 'search_text', query: 'other-term', caseSensitive: false, limit: 10 });
      let calls = 0;
      const leaseService: OrnithInferenceLeaseService = {
        acquireOrnithLease: async () => lease(),
        recheckOrnithLease: async () => true,
        inferForOrnith: async (_lease, request) => {
          calls += 1;
          if (calls === 1) return completed(request, broadSearch);
          if (calls === 2) return completed(request, broadSearch);
          if (calls === 3) return completed(request, differentSearch); // denied, recovered once
          return completed(request, JSON.stringify({ version: 1, action: 'blocked', reason: 'Cannot safely proceed without more context.' }));
        }
      };

      const result = await new OrnithImplementationService().implement(
        baseRequest(leaseService, new AbortController().signal)
      );

      expect(result.assessment.disposition).toBe('fail');
      expect(result.assessment.publishBlock).toBe('configuration');
      expect(result.assessment.reasonCodes).toContain('blocked');
      expect(result.ornithAudit.changedFiles).toBe(0);
    });
  });
});
