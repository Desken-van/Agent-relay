/**
 * Integration coverage for Ornith's place in the Orchestrator's provider
 * routing — the part `tests/services/ornith-implementation.test.ts` (the loop
 * itself) and `tests/domain/ornith.test.ts` (schemas) cannot see: that
 * `implementationProvider: 'ornith'` actually reaches {@link runOrnith} for
 * both implementation and correction rounds, that a review never can (it is
 * typed `claude | codex` end to end, DB included), that an unavailable Ornith
 * wiring fails closed with `TOOL_MISSING` rather than silently running Claude
 * or Codex instead, and that a stopped local runtime is refused before any
 * worktree or round is created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_ASSESSMENT_VERSION } from '../../src/shared/domain/claude-assessment';
import { AgentRelayError } from '../../src/shared/domain/errors';
import type { OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import type {
  OrnithImplementationRequest,
  OrnithImplementationResult,
  OrnithImplementationService
} from '../../src/main/services/ornith-implementation';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import { createHarness, type Harness } from '../helpers/harness';
import { makeReview } from '../helpers/fakes';

/** Never actually invoked: `runOrnith` only checks this dependency is present before delegating to the (faked) Ornith service. */
const unusedProcessRunner: ProcessRunner = {
  run: async () => {
    throw new Error('The process runner is not exercised by routing tests.');
  }
};

const passingVerification: VerificationExecutor = {
  identity: async () => 'a'.repeat(64),
  execute: async () => ({
    command: 'npm run verify',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    failed: false,
    timedOut: false,
    cancelled: false,
    durationMs: 1
  })
};

function fakeLease(overrides: Partial<OrnithHealthyLease> = {}): OrnithHealthyLease {
  return {
    runtimeInstanceId: 'runtime-1',
    providerId: 'local-llama-cpp',
    modelId: 'test-model',
    contextLimitTokens: 32_768,
    maxOutputTokens: 1_024,
    release: () => undefined,
    onIndependentStop: () => undefined,
    ...overrides
  };
}

function healthyLeaseService(overrides: Partial<OrnithInferenceLeaseService> = {}): OrnithInferenceLeaseService {
  return {
    acquireOrnithLease: async () => fakeLease(),
    recheckOrnithLease: async () => true,
    inferForOrnith: async () => {
      throw new Error('inferForOrnith is not exercised by routing tests.');
    },
    ...overrides
  };
}

/** A successful, no-verification-block Ornith result — reaches READY_FOR_REVIEW cleanly. */
function passingResult(finalMessage = 'Ornith finished.'): OrnithImplementationResult {
  return {
    sessionId: null,
    finalMessage,
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: 'pass',
      verificationStatus: 'passed',
      publishBlock: 'none',
      reasonCodes: [],
      verification: null,
      denials: []
    },
    ornithAudit: { turns: 1, actions: 1, readBytes: 0, validationReadBytes: 0, writeBytes: 0, changedFiles: 1, verifications: 0, outcomes: [] }
  };
}

function providerFailureResult(): OrnithImplementationResult {
  return {
    sessionId: null,
    finalMessage: 'The local runtime failed (rejected): The runtime rejected the inference request with HTTP 500.',
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: 'fail',
      verificationStatus: 'not_run',
      publishBlock: 'configuration',
      reasonCodes: ['runtime_unavailable'],
      verification: null,
      denials: []
    },
    providerFailure: {
      kind: 'failed',
      reason: 'The runtime rejected the inference request with HTTP 500.',
      dispatchOutcome: 'rejected'
    },
    ornithAudit: { turns: 1, actions: 0, readBytes: 0, validationReadBytes: 0, writeBytes: 0, changedFiles: 0, verifications: 0, outcomes: [] }
  };
}

/**
 * What `OrnithImplementationService.implement()` now returns for a read-only
 * `search_text` timeout once its recovery budget is exhausted (see
 * `ornith-implementation.ts`'s `ORNITH_DENIAL_PUBLISH_BLOCK` map and the
 * `!toolResult.ok` branch) — `configuration`, not `security`, and a message
 * naming the action and the exact denial code rather than a generic
 * "unsafe or over-limit" sentence.
 */
function timeoutToolDenialResult(): OrnithImplementationResult {
  return {
    sessionId: null,
    finalMessage: 'Agent Relay stopped the Ornith "search_text" action (timeout): The repository operation timed out.',
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: 'fail',
      verificationStatus: 'not_run',
      publishBlock: 'configuration',
      reasonCodes: ['timeout'],
      verification: null,
      denials: []
    },
    ornithAudit: { turns: 4, actions: 4, readBytes: 0, validationReadBytes: 0, writeBytes: 0, changedFiles: 0, verifications: 0, outcomes: [] }
  };
}

function fakeOrnithService(
  implement: (request: OrnithImplementationRequest) => Promise<OrnithImplementationResult>
): OrnithImplementationService {
  return { implement: vi.fn(implement) } as unknown as OrnithImplementationService;
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.dispose();
  harness = null;
});

describe('Orchestrator: Ornith provider routing', () => {
  it('routes an implementation round to Ornith, acquiring and releasing the lease, when implementationProvider is "ornith"', async () => {
    const calls: OrnithImplementationRequest[] = [];
    const ornith = fakeOrnithService(async (request) => {
      calls.push(request);
      return passingResult();
    });
    let released = false;
    const ornithLease = healthyLeaseService({
      acquireOrnithLease: async () => fakeLease({ release: () => { released = true; } })
    });
    harness = createHarness({ ornith, ornithLease, processRunner: unusedProcessRunner });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    const completed = await harness.orchestrator.sendToClaude(task.id);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runType).toBe('implementation');
    expect(released).toBe(true);
    expect(completed.status).toBe('READY_FOR_REVIEW');
    // Claude/Codex must never be silently invoked for an Ornith-routed task.
    expect(harness.claude.calls).toHaveLength(0);
  });

  it('routes a correction round to Ornith after Codex requests changes', async () => {
    const runTypes: string[] = [];
    const ornith = fakeOrnithService(async (request) => {
      runTypes.push(request.runType);
      return passingResult();
    });
    harness = createHarness({
      ornith,
      ornithLease: healthyLeaseService(),
      processRunner: unusedProcessRunner,
      verification: passingVerification
    });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);

    await harness.orchestrator.runVerification(task.id);
    harness.codex.reviewQueue.push(makeReview({ verdict: 'changes_requested', summary: 'Needs one more pass.' }));
    const reviewed = await harness.orchestrator.reviewWithCodex(task.id);
    expect(reviewed.status).toBe('CHANGES_REQUESTED');

    await harness.orchestrator.sendCorrections(task.id);

    expect(runTypes).toEqual(['implementation', 'correction']);
  });

  it('never routes a review to Ornith: reviewProvider stays claude/codex even when implementationProvider is ornith', async () => {
    const ornith = fakeOrnithService(async () => passingResult());
    harness = createHarness({ ornith, ornithLease: healthyLeaseService(), processRunner: unusedProcessRunner });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith', reviewProvider: 'codex' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);

    await harness.orchestrator.reviewWithCodex(task.id);

    // reviewWithCodex's own dispatch (`task.reviewProvider === 'claude' ? claude : codex`)
    // has no Ornith branch to fall into; this proves it actually ran Codex,
    // not merely that the type system forbids anything else.
    expect(harness.codex.reviewCalls).toHaveLength(1);
    expect(harness.claude.calls).toHaveLength(0);
  });

  it('the database itself refuses "ornith" as a reviewProvider, independent of the TypeScript type', () => {
    harness = createHarness();
    const project = harness.createProject();

    expect(() =>
      harness!.tasks.create({
        id: harness!.ids.next(),
        projectId: project.id,
        title: 'Invalid review provider',
        originalRequest: 'x',
        status: 'DRAFT',
        currentRound: 0,
        maxRounds: 3,
        codexThreadId: null,
        claudeSessionId: null,
        codexModel: null,
        claudeModel: null,
        worktreePath: null,
        branchName: null,
        baseBranch: null,
        specificationJson: null,
        specificationApprovedAt: null,
        lastReviewJson: null,
        lastError: null,
        reviewProvider: 'ornith' as any
      })
    ).toThrow();
  });

  it('fails closed with TOOL_MISSING instead of silently running Claude or Codex when Ornith is selected but not wired', async () => {
    harness = createHarness(); // no ornith / ornithLease
    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'TOOL_MISSING' });

    expect(harness.claude.calls).toHaveLength(0);
    expect(harness.git.createdWorktrees).toHaveLength(0);
    const after = harness.tasks.findById(task.id);
    expect(after?.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('refuses to start when the local runtime is not Healthy, before any worktree or round is created', async () => {
    const ornith = fakeOrnithService(async () => passingResult());
    const ornithLease = healthyLeaseService({
      acquireOrnithLease: async () => {
        throw new AgentRelayError('VALIDATION_FAILED', 'The local runtime is not Healthy.');
      }
    });
    harness = createHarness({ ornith, ornithLease, processRunner: unusedProcessRunner });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(harness.git.createdWorktrees).toHaveLength(0);
    const after = harness.tasks.findById(task.id);
    expect(after?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(after?.worktreePath).toBeNull();
    expect(after?.currentRound).toBe(0);
  });

  it('refuses an undersized retained context before creating a worktree or consuming a round', async () => {
    const ornith = fakeOrnithService(async () => passingResult());
    const ornithLease = healthyLeaseService({
      acquireOrnithLease: async () => fakeLease({
        contextLimitTokens: 1_024,
        maxOutputTokens: 1_024
      })
    });
    harness = createHarness({ ornith, ornithLease, processRunner: unusedProcessRunner });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    });

    expect(ornith.implement).not.toHaveBeenCalled();
    expect(harness.git.createdWorktrees).toHaveLength(0);
    expect(harness.tasks.findById(task.id)).toMatchObject({
      status: 'READY_FOR_IMPLEMENTATION',
      currentRound: 0,
      worktreePath: null
    });
  });

  it('does not consume a round or claim files were saved when Ornith fails before mutating', async () => {
    const ornith = fakeOrnithService(async () => providerFailureResult());
    harness = createHarness({
      ornith,
      ornithLease: healthyLeaseService(),
      processRunner: unusedProcessRunner
    });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    const after = await harness.orchestrator.sendToClaude(task.id);

    expect(after).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 0 });
    expect(after.lastError).toContain('stopped before changing any files');
    expect(after.lastError).toContain('HTTP 500');
    expect(after.lastError).not.toContain('Changes were saved');
    const run = harness.runs.listByTask(task.id).find((candidate) => candidate.agent === 'ornith');
    expect(run?.status).toBe('failed');
    expect(run?.structuredResult).toContain('"dispatchOutcome":"rejected"');
  });

  it('does not consume a round and reports a correctly classified message for a read-only tool timeout', async () => {
    const ornith = fakeOrnithService(async () => timeoutToolDenialResult());
    harness = createHarness({
      ornith,
      ornithLease: healthyLeaseService(),
      processRunner: unusedProcessRunner
    });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    const after = await harness.orchestrator.sendToClaude(task.id);

    // A read-only timeout before any mutation must not consume a round, must
    // not be reported as a security refusal, and must not tell the user a
    // generic "unsafe or over-limit" story instead of the real cause.
    expect(after).toMatchObject({ status: 'READY_FOR_IMPLEMENTATION', currentRound: 0 });
    expect(after.lastError).toContain('stopped before changing any files');
    expect(after.lastError).toContain('search_text');
    expect(after.lastError).toContain('timeout');
    expect(after.lastError).not.toContain('unsafe or over-limit');
    const run = harness.runs.listByTask(task.id).find((candidate) => candidate.agent === 'ornith');
    expect(run?.status).toBe('failed');
    expect(run?.structuredResult).toContain('"publishBlock":"configuration"');
  });

  it('keeps the prior review-round count when a correction fails before mutating', async () => {
    let attempt = 0;
    const ornith = fakeOrnithService(async () => {
      attempt += 1;
      return attempt === 1 ? passingResult() : providerFailureResult();
    });
    harness = createHarness({
      ornith,
      ornithLease: healthyLeaseService(),
      processRunner: unusedProcessRunner,
      verification: passingVerification
    });

    const project = harness.createProject();
    const task = harness.createTask(project.id, { implementationProvider: 'ornith' });
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);
    await harness.orchestrator.runVerification(task.id);
    harness.codex.reviewQueue.push(makeReview({
      verdict: 'changes_requested',
      summary: 'Needs a correction.'
    }));
    const reviewed = await harness.orchestrator.reviewWithCodex(task.id);
    expect(reviewed.currentRound).toBe(1);

    const after = await harness.orchestrator.sendCorrections(task.id);

    expect(after).toMatchObject({ status: 'CHANGES_REQUESTED', currentRound: 1 });
    expect(after.lastError).toContain('stopped before changing any files');
  });
});
