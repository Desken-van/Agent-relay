/**
 * The round policy, as the application actually runs it.
 *
 * These go through the real orchestrator, the real repositories and the real
 * state machine — only the Claude process itself is faked, by handing the
 * adapter the evidence a given stream would have produced.
 *
 * The case that matters most is the one that used to be wrong: six auxiliary
 * commands refused, the tests run and passed anyway, and the round reported as
 * a failure with a message claiming the tests might have been skipped. That is
 * the last test in the first block, and it is now a warning on a successful
 * round.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readClaudeAssessment,
  type ClaudeRoundAssessmentRecord
} from '../../src/shared/domain/claude-assessment';
import type { ClaudePermissionDenial } from '../../src/main/ports';
import { createHarness, type Harness } from '../helpers/harness';
import { passingToolExecution, passingVerificationEvidence } from '../helpers/fakes';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function denial(overrides: Partial<ClaudePermissionDenial> = {}): ClaudePermissionDenial {
  return {
    tool: 'Bash',
    toolUseId: 'denied-1',
    reason: 'This command requires approval',
    command: 'npm run coverage',
    commandTruncated: false,
    toolUseSequence: 1,
    source: 'stream',
    ...overrides
  };
}

/** Drive one implementation round and return the task plus its run. */
async function implement(): Promise<{ taskId: string; run: ReturnType<Harness['runs']['listByTask']>[number] }> {
  const project = harness.createProject();
  const created = harness.createTask(project.id);

  await harness.orchestrator.generateSpecification(created.id);
  harness.orchestrator.approveSpecification(created.id);
  await harness.orchestrator.sendToClaude(created.id);

  const run = harness.runs.findLatestByType(created.id, 'implementation');
  if (!run) throw new Error('no implementation run was recorded');
  return { taskId: created.id, run };
}

function assessmentOf(structuredResult: string | null): ClaudeRoundAssessmentRecord {
  const result = readClaudeAssessment(structuredResult);
  if (!result.ok) throw new Error(`expected a readable assessment, got ${result.absence}`);
  return result.assessment;
}

function warningEvents(runId: string): { text: string; data: Record<string, unknown> | null }[] {
  return harness.runEvents
    .listByRun(runId)
    .filter((event) => event.type === 'warning')
    .map((event) => {
      const parsed = JSON.parse(event.payload) as { text?: string; data?: Record<string, unknown> };
      return { text: parsed.text ?? '', data: parsed.data ?? null };
    });
}

/* -------------------------------------------------------------------------- */
/* Rounds that may go to review                                                */
/* -------------------------------------------------------------------------- */

describe('rounds that reach the reviewer', () => {
  it('passes a round that verified its work and was refused nothing', async () => {
    const { taskId, run } = await implement();

    expect(run.status).toBe('succeeded');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_FOR_REVIEW');
    expect(assessmentOf(run.structuredResult)).toMatchObject({
      version: 1,
      disposition: 'pass',
      verificationStatus: 'passed',
      publishBlock: 'none'
    });
    expect(warningEvents(run.id)).toHaveLength(0);
  });

  it('warns, but succeeds, when auxiliary commands were refused', async () => {
    harness.claude.permissionDenials = [
      denial({ toolUseId: 'a', command: 'npm run coverage', toolUseSequence: 2 })
    ];

    const { taskId, run } = await implement();

    expect(run.status).toBe('succeeded');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_FOR_REVIEW');
    expect(assessmentOf(run.structuredResult)).toMatchObject({
      disposition: 'warn',
      verificationStatus: 'passed',
      publishBlock: 'none'
    });

    const [warning] = warningEvents(run.id);
    expect(warning?.text).toContain('denied by Claude permissions');
    expect(warning?.text).toContain('npm test');
  });

  /**
   * The Phase 3 regression.
   *
   * Six auxiliary refusals, one allowed `npm test` that ran and passed, a clean
   * exit and a success envelope. This used to be reported as a failed round
   * whose message said the tests may have been skipped — while the evidence
   * showed, in the same stream, that they had run and passed.
   */
  it('does not fail a round whose tests demonstrably ran', async () => {
    const auxiliary = [
      'git status --short',
      'npm run lint',
      'npm run typecheck',
      'node --version',
      'npm ls --depth=0',
      'npm run build'
    ];

    harness.claude.permissionDenials = auxiliary.map((command, index) =>
      denial({ toolUseId: `aux-${index}`, command, toolUseSequence: index + 2 })
    );
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ command: 'npm test -- --run' })]
    });

    const { taskId, run } = await implement();

    expect(run.status).toBe('succeeded');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_FOR_REVIEW');

    const assessment = assessmentOf(run.structuredResult);
    expect(assessment.disposition).toBe('warn');
    expect(assessment.verificationStatus).toBe('passed');
    expect(assessment.publishBlock).toBe('none');
    expect(assessment.denials).toHaveLength(6);
    expect(assessment.denials.every((entry) => entry.category === 'auxiliary')).toBe(true);
    expect(assessment.verification?.command).toBe('npm test -- --run');

    const [warning] = warningEvents(run.id);
    expect(warning?.text).toContain('6 commands were denied');
    expect(warning?.text).not.toContain('may have been skipped');
    expect(run.finalMessage ?? '').not.toContain('may have been skipped');
    expect(run.errorMessage).toBeNull();
  });

  it('warns and blocks publishing when verification ran and failed', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ isError: true })]
    });

    const { taskId, run } = await implement();

    expect(run.status).toBe('succeeded');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_FOR_REVIEW');
    expect(assessmentOf(run.structuredResult)).toMatchObject({
      disposition: 'warn',
      verificationStatus: 'failed',
      publishBlock: 'verification'
    });

    const [warning] = warningEvents(run.id);
    expect(warning?.text).toContain('Verification ran but failed');
    expect(warning?.text).toContain('publishing remains blocked');
  });

  it('accepts a denied verification command that was retried and passed', async () => {
    harness.claude.permissionDenials = [
      denial({ toolUseId: 'first', command: 'npm test', toolUseSequence: 1 })
    ];
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ toolUseId: 'retry', toolUseSequence: 2 })]
    });

    const { run } = await implement();

    expect(run.status).toBe('succeeded');
    const assessment = assessmentOf(run.structuredResult);
    expect(assessment).toMatchObject({ disposition: 'warn', verificationStatus: 'passed' });
    expect(assessment.denials[0]).toMatchObject({ category: 'verification', resolved: true });
    expect(warningEvents(run.id)[0]?.text).toContain('initially denied');
  });

  it('reports a retried verification that failed as failed', async () => {
    harness.claude.permissionDenials = [
      denial({ toolUseId: 'first', command: 'npm test', toolUseSequence: 1 })
    ];
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ toolUseId: 'retry', toolUseSequence: 2, isError: true })]
    });

    const { run } = await implement();

    expect(run.status).toBe('succeeded');
    const assessment = assessmentOf(run.structuredResult);
    expect(assessment).toMatchObject({
      disposition: 'warn',
      verificationStatus: 'failed',
      publishBlock: 'verification'
    });

    // `resolved` means the denied command ran again, not that it worked. The
    // timeline says "retried" for exactly this reason: the same flag is set
    // here, on a round whose checks failed.
    expect(assessment.denials[0]).toMatchObject({ category: 'verification', resolved: true });
    expect(warningEvents(run.id)[0]?.text).toContain('The latest result is failed');
    expect(warningEvents(run.id)[0]?.text).not.toContain('retried successfully');
  });
});

/* -------------------------------------------------------------------------- */
/* Rounds that do not                                                          */
/* -------------------------------------------------------------------------- */

describe('rounds sent back for another attempt', () => {
  const recoverable = 'READY_FOR_IMPLEMENTATION';

  it('fails when verification was denied and never re-ran', async () => {
    harness.claude.permissionDenials = [
      denial({ command: 'npm test', toolUseSequence: 1 })
    ];
    harness.claude.evidence = passingVerificationEvidence({ toolExecutions: [] });

    const { taskId, run } = await implement();

    expect(run.status).toBe('failed');
    expect(harness.tasks.findById(taskId)?.status).toBe(recoverable);
    expect(run.errorMessage).toContain('Verification was denied');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('verification');
  });

  it('fails when a later different command ran instead of the denied one', async () => {
    harness.claude.permissionDenials = [
      denial({ command: 'npm test', toolUseSequence: 1 })
    ];
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [
        passingToolExecution({ toolUseId: 'other', toolUseSequence: 2, command: 'npm run build' })
      ]
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).verificationStatus).toBe('not_run');
  });

  it('fails on a security-critical refusal even though the tests passed', async () => {
    harness.claude.permissionDenials = [
      denial({ toolUseId: 'push', command: 'git push origin main', toolUseSequence: 3 })
    ];

    const { taskId, run } = await implement();

    expect(run.status).toBe('failed');
    expect(harness.tasks.findById(taskId)?.status).toBe(recoverable);
    expect(run.errorMessage).toContain('security-critical command was blocked');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('security');
  });

  it('fails on a refusal it cannot classify', async () => {
    harness.claude.permissionDenials = [
      denial({ toolUseId: 'huh', command: null, toolUseSequence: 3 })
    ];

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('could not be identified');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('telemetry');
  });

  it('fails when no verification command ran at all', async () => {
    harness.claude.evidence = passingVerificationEvidence({ toolExecutions: [] });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('No verification command ran');
    expect(assessmentOf(run.structuredResult).verificationStatus).toBe('not_run');
  });

  it('fails when the stream ended without a final envelope', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      resultEnvelopeSeen: false,
      resultEnvelopeIsError: null
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('without a usable final result');
  });

  it('fails when part of the stream could not be read', async () => {
    harness.claude.evidence = passingVerificationEvidence({ malformedLineCount: 2 });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('could not be read');
  });

  it('fails when two results for the verification call disagreed', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ isError: null, resultConflict: true })]
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).verificationStatus).toBe('unknown');
  });

  it('fails when the envelope itself reported an error', async () => {
    harness.claude.evidence = passingVerificationEvidence({ resultEnvelopeIsError: true });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('did not complete successfully');
  });

  it('fails when two envelopes disagreed', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      resultEnvelopeIsError: null,
      resultEnvelopeConflict: true
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('telemetry');
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe('an unusable configuration', () => {
  /**
   * Write a settings value the repository itself would reject.
   *
   * The repository validates, so this cannot happen through the normal path —
   * which is exactly why the orchestrator checks again. A row could arrive from
   * a hand edit, an older build, or a bug, and none of those may be allowed to
   * start a round that can never be judged.
   */
  const forceSetting = (key: string, value: unknown): void => {
    harness.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, JSON.stringify(value));
  };

  it('refuses to start Claude at all, and records no run', async () => {
    forceSetting('claudeVerificationTools', []);

    const project = harness.createProject();
    const created = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);

    await expect(harness.orchestrator.sendToClaude(created.id)).rejects.toThrow(
      /verification rules are not usable/i
    );

    // No process, and nothing that could be mistaken for an attempt.
    expect(harness.claude.calls).toHaveLength(0);
    expect(harness.runs.findLatestByType(created.id, 'implementation')).toBeNull();
    // Recoverable: the task can be retried once Settings are fixed.
    expect(harness.tasks.findById(created.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('refuses when a verification rule was never pre-approved', async () => {
    forceSetting('claudeAllowedTools', ['Bash(npm run lint *)']);
    forceSetting('claudeVerificationTools', ['Bash(npm test *)']);

    const project = harness.createProject();
    const created = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);

    // The headline names the problem; the specifics live in , so the
    // user is told which rule to change rather than just that something is wrong.
    const error = await harness.orchestrator.sendToClaude(created.id).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/verification rules are not usable/i);
    expect((error as { details?: string }).details).toMatch(/not in the pre-approved list/i);
    expect((error as { remediation?: string }).remediation).toMatch(/Settings/);
    expect(harness.claude.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Correction rounds                                                           */
/* -------------------------------------------------------------------------- */

describe('correction rounds', () => {
  it('judges the new round on its own evidence, not the previous one', async () => {
    // First round: an auxiliary refusal, so it carries a warning.
    harness.claude.permissionDenials = [denial({ toolUseSequence: 2 })];
    const { taskId } = await implement();

    harness.codex.reviewQueue = [
      {
        verdict: 'changes_requested',
        summary: 'Needs work.',
        findings: [],
        followUpPrompt: 'Fix it.',
        suggestedTests: []
      }
    ];
    await harness.orchestrator.reviewWithCodex(taskId);

    // Second round: nothing refused, and a clean stream.
    harness.claude.permissionDenials = [];
    harness.claude.evidence = passingVerificationEvidence();
    await harness.orchestrator.sendCorrections(taskId);

    const correction = harness.runs.findLatestByType(taskId, 'correction');
    const assessment = assessmentOf(correction?.structuredResult ?? null);

    expect(assessment.disposition).toBe('pass');
    expect(assessment.denials).toHaveLength(0);
    expect(warningEvents(correction?.id ?? '')).toHaveLength(0);

    // The earlier warning is still on its own run: history is not rewritten.
    const implementation = harness.runs.findLatestByType(taskId, 'implementation');
    expect(warningEvents(implementation?.id ?? '')).toHaveLength(1);
  });

  it('resumes the same session and model as before', async () => {
    harness.claude.permissionDenials = [];
    const { taskId } = await implement();

    harness.codex.reviewQueue = [
      {
        verdict: 'changes_requested',
        summary: 'Needs work.',
        findings: [],
        followUpPrompt: 'Fix it.',
        suggestedTests: []
      }
    ];
    await harness.orchestrator.reviewWithCodex(taskId);
    await harness.orchestrator.sendCorrections(taskId);

    const [, second] = harness.claude.calls;
    expect(second?.sessionId).toBe('claude-session-1');
  });
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

describe('what survives a restart', () => {
  it('keeps the assessment and the warning in the database', async () => {
    harness.claude.permissionDenials = [denial({ toolUseSequence: 2 })];
    const { taskId, run } = await implement();

    // Re-read through the repositories, as a fresh window would.
    const reloadedRun = harness.runs.findById(run.id);
    const reloadedTask = harness.tasks.findById(taskId);

    expect(reloadedTask?.status).toBe('READY_FOR_REVIEW');
    expect(reloadedRun?.status).toBe('succeeded');
    expect(assessmentOf(reloadedRun?.structuredResult ?? null)).toMatchObject({
      version: 1,
      disposition: 'warn'
    });

    const warnings = warningEvents(run.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data?.['verificationStatus']).toBe('passed');
    expect(Array.isArray(warnings[0]?.data?.['denials'])).toBe(true);
  });

  it('keeps the diagnostic fields alongside the verdict', async () => {
    const { run } = await implement();
    const stored = JSON.parse(run.structuredResult ?? '{}') as Record<string, unknown>;

    expect(stored['sessionId']).toBe('claude-session-1');
    expect(stored['numTurns']).toBe(3);
    expect(stored['cliReportedError']).toBe(false);
    expect(stored['evidence']).toMatchObject({ resultEnvelopeSeen: true, malformedLineCount: 0 });
  });

  it('stores no raw tool output in the assessment', async () => {
    harness.claude.permissionDenials = [
      denial({ reason: 'This command requires approval', command: 'npm run coverage' })
    ];
    const { run } = await implement();

    const assessment = assessmentOf(run.structuredResult);
    const serialised = JSON.stringify(assessment);

    expect(serialised).not.toContain('output text');
    expect(serialised.length).toBeLessThan(20_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing is created before the configuration is checked                      */
/* -------------------------------------------------------------------------- */

describe('an unusable configuration, before anything exists', () => {
  const forceSetting = (key: string, value: unknown): void => {
    harness.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, JSON.stringify(value));
  };

  it('creates no branch or worktree', async () => {
    forceSetting('claudeVerificationTools', []);

    const project = harness.createProject();
    const created = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);

    await expect(harness.orchestrator.sendToClaude(created.id)).rejects.toThrow(
      /verification rules are not usable/i
    );

    // The whole point of checking first: a round that cannot legally start must
    // not leave a branch and a directory behind for someone to clean up.
    expect(harness.git.createdWorktrees).toEqual([]);
    expect(harness.tasks.findById(created.id)?.worktreePath).toBeNull();
    expect(harness.tasks.findById(created.id)?.branchName).toBeNull();
    expect(harness.runs.listByTask(created.id).filter((run) => run.agent === 'claude')).toEqual([]);
    expect(harness.claude.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* One reading of Settings                                                     */
/* -------------------------------------------------------------------------- */

describe('Settings edited while the worktree is being prepared', () => {
  it('runs and judges the round against the same rules', async () => {
    // Preparing a worktree is slow enough for a user to save Settings during
    // it. Whatever wins, the CLI and the policy have to agree — a round argued
    // against rules the process never had is worse than either version alone.
    const originalCreate = harness.git.createWorktree.bind(harness.git);
    harness.git.createWorktree = async (request) => {
      harness.settings.update({
        claudeAllowedTools: ['Bash(npm run verify *)'],
        claudeVerificationTools: ['Bash(npm run verify *)']
      });
      return originalCreate(request);
    };

    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [passingToolExecution({ command: 'npm run verify' })]
    });

    const { run } = await implement();

    // The adapter was given the rules that were current at spawn time…
    expect(harness.claude.calls[0]?.allowedTools).toEqual(['Bash(npm run verify *)']);
    // …and the round was judged against the same ones, so `npm run verify`
    // counts as verification rather than being an unrecognised command.
    const assessment = assessmentOf(run.structuredResult);
    expect(assessment.verificationStatus).toBe('passed');
    expect(assessment.verification?.matchedRule).toBe('Bash(npm run verify *)');
    expect(run.status).toBe('succeeded');
  });

  it('does not judge a round against rules the process never had', async () => {
    // The mirror image: Settings widen mid-preparation, and the command Claude
    // ran was only ever verification under the *old* rules. It must not be
    // credited under the new ones by accident.
    const originalCreate = harness.git.createWorktree.bind(harness.git);
    harness.git.createWorktree = async (request) => {
      harness.settings.update({
        claudeAllowedTools: ['Bash(npm run verify *)'],
        claudeVerificationTools: ['Bash(npm run verify *)']
      });
      return originalCreate(request);
    };

    // Claude runs `npm test`, which is no longer a verification rule.
    const { run } = await implement();

    expect(harness.claude.calls[0]?.allowedTools).toEqual(['Bash(npm run verify *)']);
    expect(assessmentOf(run.structuredResult).verificationStatus).toBe('not_run');
    expect(run.status).toBe('failed');
  });
});

/* -------------------------------------------------------------------------- */
/* A CLI error is part of the verdict                                          */
/* -------------------------------------------------------------------------- */

describe('an error the CLI raised', () => {
  it('fails the round even when the envelope and the tests were happy', async () => {
    // The parser sets `isError` from an `error` event. The envelope can still
    // close with `is_error: false`, and the tests can genuinely have passed —
    // and the round is still not one to publish, because the two halves of the
    // stream disagree about whether it completed.
    harness.claude.isError = true;
    harness.claude.evidence = passingVerificationEvidence({ resultEnvelopeIsError: false });

    const { taskId, run } = await implement();

    expect(run.status).toBe('failed');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_FOR_IMPLEMENTATION');

    const assessment = assessmentOf(run.structuredResult);
    expect(assessment.verificationStatus).toBe('passed');
    expect(assessment.disposition).toBe('fail');
    expect(assessment.publishBlock).toBe('telemetry');
    expect(assessment.reasonCodes).toContain('cli_error');
    expect(assessment.reasonCodes).toContain('telemetry_conflict');
    expect(run.errorMessage).toContain('contradict each other');
  });
});

/* -------------------------------------------------------------------------- */
/* Gaps in the record                                                          */
/* -------------------------------------------------------------------------- */

describe('an incomplete record of what ran', () => {
  it('fails on a call that never got a result', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [
        passingToolExecution(),
        passingToolExecution({
          toolUseId: 'open',
          toolUseSequence: 2,
          tool: 'Read',
          command: null,
          resultReceived: false,
          isError: null
        })
      ],
      incompleteToolUseCount: 1
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('telemetry');
    expect(run.errorMessage).toContain('incomplete');
  });

  it('fails on a result that belongs to no call', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [
        passingToolExecution(),
        {
          toolUseId: 'stray',
          toolUseSequence: null,
          tool: 'unknown tool',
          command: null,
          commandTruncated: false,
          summary: 'result without a matching tool use',
          toolUseSeen: false,
          resultReceived: true,
          isError: false,
          resultConflict: false
        }
      ],
      orphanToolResultCount: 1
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('telemetry');
  });

  it('fails when a call had two results that disagreed', async () => {
    harness.claude.evidence = passingVerificationEvidence({
      toolExecutions: [
        passingToolExecution(),
        passingToolExecution({
          toolUseId: 'contradicted',
          toolUseSequence: 2,
          command: 'npm run build',
          isError: null,
          resultConflict: true
        })
      ]
    });

    const { run } = await implement();

    expect(run.status).toBe('failed');
    expect(assessmentOf(run.structuredResult).publishBlock).toBe('telemetry');
  });
});
