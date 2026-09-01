/**
 * The decision matrix.
 *
 * Every case here is a round that already "succeeded" as far as the CLI was
 * concerned — exit 0, envelope says success — and the question is whether the
 * evidence actually supports that. The recurring shape of a bug in this area is
 * an ambiguity rounded towards the tidy answer, so most of these assert that a
 * gap in the telemetry fails rather than passes.
 *
 * Nothing here touches a run status or a task transition: the policy is not
 * wired to the orchestrator in this phase.
 */

import { describe, expect, it } from 'vitest';
import {
  assessClaudeRound,
  type VerificationPolicyConfig
} from '../../src/main/services/claude-round-policy';
import type {
  ClaudePermissionDenial,
  ClaudeStreamEvidence,
  ClaudeToolExecution
} from '../../src/main/ports';

const CONFIG: VerificationPolicyConfig = {
  allowedTools: ['Bash(npm test *)', 'PowerShell(npm test *)'],
  verificationTools: ['Bash(npm test *)', 'PowerShell(npm test *)']
};

let nextSequence = 1;

function execution(overrides: Partial<ClaudeToolExecution> = {}): ClaudeToolExecution {
  const sequence = nextSequence++;
  return {
    toolUseId: `t${sequence}`,
    toolUseSequence: sequence,
    tool: 'Bash',
    command: 'npm test',
    commandTruncated: false,
    summary: 'Bash: npm test',
    toolUseSeen: true,
    resultReceived: true,
    isError: false,
    resultConflict: false,
    ...overrides
  };
}

function denial(overrides: Partial<ClaudePermissionDenial> = {}): ClaudePermissionDenial {
  return {
    tool: 'Bash',
    toolUseId: 't1',
    reason: 'requires approval',
    command: 'npm test',
    commandTruncated: false,
    toolUseSequence: 1,
    source: 'stream',
    ...overrides
  };
}

function evidence(
  toolExecutions: readonly ClaudeToolExecution[],
  overrides: Partial<ClaudeStreamEvidence> = {}
): ClaudeStreamEvidence {
  return {
    toolExecutions,
    resultEnvelopeSeen: true,
    resultEnvelopeIsError: false,
    resultEnvelopeConflict: false,
    malformedLineCount: 0,
    incompleteToolUseCount: toolExecutions.filter(
      (entry) => entry.toolUseSeen && !entry.resultReceived
    ).length,
    orphanToolResultCount: toolExecutions.filter((entry) => !entry.toolUseSeen).length,
    ...overrides
  };
}

const assess = (
  toolExecutions: readonly ClaudeToolExecution[],
  denials: readonly ClaudePermissionDenial[] = [],
  evidenceOverrides: Partial<ClaudeStreamEvidence> = {},
  config: VerificationPolicyConfig = CONFIG,
  cliReportedError = false
) =>
  assessClaudeRound(
    {
      evidence: evidence(toolExecutions, evidenceOverrides),
      permissionDenials: denials,
      isError: cliReportedError
    },
    config
  );

function reset(): void {
  nextSequence = 1;
}

/* -------------------------------------------------------------------------- */
/* The clean case, and the near misses                                         */
/* -------------------------------------------------------------------------- */

describe('a round that verified its work', () => {
  it('passes when the tests ran, passed, and nothing was refused', () => {
    reset();
    const result = assess([execution()]);

    expect(result).toMatchObject({
      disposition: 'pass',
      verificationStatus: 'passed',
      publishBlock: 'none'
    });
    expect(result.reasonCodes).toContain('verification_passed');
  });

  it('warns when an auxiliary command was refused', () => {
    reset();
    const result = assess(
      [execution()],
      [denial({ command: 'npm run coverage', toolUseSequence: 5, toolUseId: 'aux' })]
    );

    expect(result.disposition).toBe('warn');
    expect(result.verificationStatus).toBe('passed');
    expect(result.classifiedDenials[0]?.category).toBe('auxiliary');
    // Nothing that mattered was blocked, so publishing is not held up.
    expect(result.publishBlock).toBe('none');
  });

  it('fails when the record of what ran has a gap in it', () => {
    // The verification itself is fine. The round is not: a call whose result
    // never arrived means the account of what this round did is incomplete,
    // and an incomplete account is not something to publish on.
    reset();
    const verified = execution();
    const unrelated = execution({ tool: 'Read', command: null, resultReceived: false });

    const result = assess([verified, unrelated]);

    expect(result.disposition).toBe('fail');
    expect(result.verificationStatus).toBe('passed');
    expect(result.reasonCodes).toContain('telemetry_incomplete');
    expect(result.publishBlock).toBe('telemetry');
  });

  it('fails on a result that belongs to no call', () => {
    reset();
    const orphan: ClaudeToolExecution = {
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
    };

    const result = assess([execution(), orphan]);

    expect(result.disposition).toBe('fail');
    expect(result.publishBlock).toBe('telemetry');
  });

  it('fails when any call had two results that disagreed', () => {
    reset();
    const verified = execution();
    const contradicted = execution({
      tool: 'Bash',
      command: 'npm run build',
      isError: null,
      resultConflict: true
    });

    const result = assess([verified, contradicted]);

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('telemetry_incomplete');
    expect(result.publishBlock).toBe('telemetry');
  });
});

/* -------------------------------------------------------------------------- */
/* Denials                                                                     */
/* -------------------------------------------------------------------------- */

describe('denied verification', () => {
  it('fails when the tests were refused and never retried', () => {
    reset();
    const result = assess([], [denial()]);

    expect(result.disposition).toBe('fail');
    expect(result.classifiedDenials[0]?.category).toBe('verification');
    expect(result.unresolvedDenials).toHaveLength(1);
    expect(result.reasonCodes).toContain('verification_denial_unresolved');
    expect(result.publishBlock).toBe('verification');
  });

  it('accepts a later passing run of the same rule as a resolution', () => {
    reset();
    const blocked = denial({ toolUseSequence: 1 });
    // Sequence 2: the retry, which ran and passed.
    nextSequence = 2;
    const retry = execution();

    const result = assess([retry], [blocked]);

    expect(result.disposition).toBe('warn');
    expect(result.verificationStatus).toBe('passed');
    expect(result.resolvedVerificationDenials).toHaveLength(1);
    expect(result.resolvedVerificationDenials[0]?.resolvedBySequence).toBe(2);
    expect(result.unresolvedDenials).toHaveLength(0);
    expect(result.publishBlock).toBe('none');
  });

  it('treats a later failing run as proof the check happened, not that it passed', () => {
    reset();
    const blocked = denial({ toolUseSequence: 1 });
    nextSequence = 2;
    const retry = execution({ isError: true });

    const result = assess([retry], [blocked]);

    expect(result.disposition).toBe('warn');
    expect(result.verificationStatus).toBe('failed');
    expect(result.resolvedVerificationDenials).toHaveLength(1);
    expect(result.publishBlock).toBe('verification');
  });

  it('does not let a later different command resolve the denial', () => {
    reset();
    const blocked = denial({ toolUseSequence: 1 });
    nextSequence = 2;
    const other = execution({ command: 'npm run build' });

    const result = assess([other], [blocked]);

    expect(result.disposition).toBe('fail');
    expect(result.unresolvedDenials).toHaveLength(1);
    expect(result.reasonCodes).toContain('verification_denial_unresolved');
  });

  it('does not let a mere higher sequence resolve the denial', () => {
    reset();
    const blocked = denial({ toolUseSequence: 1 });
    nextSequence = 9;
    // Right command, but the same rule was never matched: a different shell.
    const other = execution({ tool: 'PowerShell', command: 'npm run build' });

    const result = assess([other], [blocked]);

    expect(result.disposition).toBe('fail');
    expect(result.unresolvedDenials).toHaveLength(1);
  });

  it('does not accept an unfinished retry', () => {
    reset();
    const blocked = denial({ toolUseSequence: 1 });
    nextSequence = 2;
    const retry = execution({ resultReceived: false, isError: null });

    const result = assess([retry], [blocked]);

    expect(result.disposition).toBe('fail');
    expect(result.resolvedVerificationDenials).toHaveLength(0);
  });

  it('fails on a security denial even when the tests passed', () => {
    reset();
    const verified = execution();
    const result = assess(
      [verified],
      [denial({ command: 'git push origin main', toolUseSequence: 5, toolUseId: 'push' })]
    );

    expect(result.disposition).toBe('fail');
    expect(result.verificationStatus).toBe('passed');
    expect(result.classifiedDenials[0]?.category).toBe('security');
    expect(result.publishBlock).toBe('security');
  });

  it('fails on an unclassifiable denial even when the tests passed', () => {
    reset();
    const verified = execution();
    const result = assess(
      [verified],
      [denial({ command: null, commandTruncated: false, toolUseSequence: 5, toolUseId: 'huh' })]
    );

    expect(result.disposition).toBe('fail');
    expect(result.classifiedDenials[0]?.category).toBe('unknown');
    expect(result.publishBlock).toBe('telemetry');
  });

  it('cannot classify a denial with no link to an invocation', () => {
    reset();
    const result = assess([execution()], [denial({ toolUseSequence: null, toolUseId: null })]);

    expect(result.classifiedDenials[0]?.category).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('cannot classify a denial whose command was truncated', () => {
    reset();
    const result = assess(
      [execution()],
      [denial({ command: 'npm test -- --very-long', commandTruncated: true, toolUseSequence: 5 })]
    );

    expect(result.classifiedDenials[0]?.category).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('calls a chained command with a denied segment a security denial', () => {
    reset();
    const result = assess(
      [execution()],
      [denial({ command: 'npm test; git push', toolUseSequence: 5, toolUseId: 'chain' })]
    );

    expect(result.classifiedDenials[0]?.category).toBe('security');
    expect(result.publishBlock).toBe('security');
    expect(result.disposition).toBe('fail');
  });

  it('calls a chained command with nothing forbidden in it unknown', () => {
    reset();
    const result = assess(
      [execution()],
      [denial({ command: 'npm test; git status', toolUseSequence: 5, toolUseId: 'chain' })]
    );

    expect(result.classifiedDenials[0]?.category).toBe('unknown');
    expect(result.publishBlock).toBe('telemetry');
    expect(result.disposition).toBe('fail');
  });
});

/* -------------------------------------------------------------------------- */
/* Which attempt is authoritative                                              */
/* -------------------------------------------------------------------------- */

describe('the latest verification attempt', () => {
  it('reads a failure followed by a pass as passed', () => {
    reset();
    const first = execution({ isError: true });
    const second = execution({ isError: false });

    // Handed to the policy in the order the results arrived, which is backwards.
    const result = assess([second, first]);

    expect(result.verificationStatus).toBe('passed');
    expect(result.verificationSequence).toBe(2);
  });

  it('reads a pass followed by a failure as failed', () => {
    reset();
    const first = execution({ isError: false });
    const second = execution({ isError: true });

    const result = assess([second, first]);

    expect(result.verificationStatus).toBe('failed');
    expect(result.verificationSequence).toBe(2);
    expect(result.disposition).toBe('warn');
    expect(result.publishBlock).toBe('verification');
  });

  it('fails when nothing matching a verification rule ran', () => {
    reset();
    const result = assess([execution({ command: 'npm run build' })]);

    expect(result.verificationStatus).toBe('not_run');
    expect(result.disposition).toBe('fail');
    expect(result.publishBlock).toBe('verification');
  });

  it('cannot tell what happened when the last attempt never finished', () => {
    reset();
    const result = assess([execution({ resultReceived: false, isError: null })]);

    expect(result.verificationStatus).toBe('unknown');
    expect(result.disposition).toBe('fail');
    expect(result.publishBlock).toBe('telemetry');
  });

  it('cannot tell what happened when two results contradicted each other', () => {
    reset();
    const result = assess([execution({ isError: null, resultConflict: true })]);

    expect(result.verificationStatus).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('cannot tell what happened when the last attempt reported no outcome', () => {
    reset();
    const result = assess([execution({ isError: null })]);

    expect(result.verificationStatus).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('will not read a truncated command as a verification run', () => {
    reset();
    const result = assess([execution({ command: 'npm test -- --x', commandTruncated: true })]);

    // It might have been the test run, or something else entirely. Either way
    // the answer is not "verified".
    expect(result.verificationStatus).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('discards an otherwise good attempt when a later shell call is unreadable', () => {
    reset();
    const verified = execution();
    const opaque = execution({ command: 'npm test -- --x', commandTruncated: true });

    const result = assess([verified, opaque]);

    expect(result.verificationStatus).toBe('unknown');
    expect(result.disposition).toBe('fail');
  });

  it('ignores an unreadable call that came before the authoritative attempt', () => {
    reset();
    const opaque = execution({ command: 'npm test -- --x', commandTruncated: true });
    const verified = execution();

    const result = assess([opaque, verified]);

    expect(result.verificationStatus).toBe('passed');
  });

  it('does not count an orphan result as a verification attempt', () => {
    reset();
    const orphan: ClaudeToolExecution = {
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
    };

    const result = assess([orphan]);

    expect(result.verificationStatus).toBe('not_run');
    expect(result.disposition).toBe('fail');
  });

  it('does not care about the order entries sit in the array', () => {
    reset();
    const first = execution({ isError: true });
    const second = execution({ isError: false });

    expect(assess([first, second]).verificationStatus).toBe(
      assess([second, first]).verificationStatus
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The stream envelope                                                         */
/* -------------------------------------------------------------------------- */

describe('stream integrity', () => {
  it('fails when the stream ended without a final envelope', () => {
    reset();
    const result = assess([execution()], [], { resultEnvelopeSeen: false });

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('envelope_missing');
    expect(result.publishBlock).toBe('telemetry');
  });

  it('fails when the envelope reported an error', () => {
    reset();
    const result = assess([execution()], [], { resultEnvelopeIsError: true });

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('envelope_error');
  });

  it('fails when two envelopes disagreed', () => {
    reset();
    const result = assess([execution()], [], {
      resultEnvelopeIsError: null,
      resultEnvelopeConflict: true
    });

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('envelope_conflict');
  });

  it('fails when the CLI raised an error, whatever the envelope said', () => {
    // The exact shape the parser produces for an `error` event followed by a
    // success envelope. Believing the cheerful half is how a crashed round
    // reads as a clean one.
    reset();
    const result = assess([execution()], [], { resultEnvelopeIsError: false }, CONFIG, true);

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('cli_error');
    expect(result.reasonCodes).toContain('telemetry_conflict');
    expect(result.publishBlock).toBe('telemetry');
    // The verification really did pass; it is the round that cannot be trusted.
    expect(result.verificationStatus).toBe('passed');
  });

  it('fails on a CLI error even when the envelope agreed', () => {
    reset();
    const result = assess([execution()], [], { resultEnvelopeIsError: true }, CONFIG, true);

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('cli_error');
    expect(result.reasonCodes).not.toContain('telemetry_conflict');
  });

  it('fails when any line of the stream was unreadable', () => {
    reset();
    const result = assess([execution()], [], { malformedLineCount: 1 });

    expect(result.disposition).toBe('fail');
    expect(result.reasonCodes).toContain('stream_malformed');
    expect(result.publishBlock).toBe('telemetry');
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe('configuration', () => {
  it('fails when no verification rules are configured', () => {
    reset();
    const result = assess([execution()], [], {}, { ...CONFIG, verificationTools: [] });

    expect(result.disposition).toBe('fail');
    expect(result.publishBlock).toBe('configuration');
    expect(result.reasonCodes).toEqual(['configuration_invalid']);
    expect(result.configurationProblems[0]?.code).toBe('empty');
  });

  it('fails when a verification rule was never allowed', () => {
    reset();
    const result = assess(
      [execution()],
      [],
      {},
      { allowedTools: ['Bash(npm run lint *)'], verificationTools: ['Bash(npm test *)'] }
    );

    expect(result.disposition).toBe('fail');
    expect(result.publishBlock).toBe('configuration');
    expect(result.configurationProblems[0]?.code).toBe('not_allowed');
  });

  it('says nothing about verification when the configuration is unusable', () => {
    reset();
    const result = assess([execution()], [], {}, { ...CONFIG, verificationTools: ['Bash(*)'] });

    expect(result.verificationStatus).toBe('unknown');
    expect(result.classifiedDenials).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-cutting                                                               */
/* -------------------------------------------------------------------------- */

describe('matching across shells and rounds', () => {
  it('accepts npm.cmd as a verification run', () => {
    reset();
    const result = assess([execution({ command: 'npm.cmd test -- --dot' })]);

    expect(result.verificationStatus).toBe('passed');
    expect(result.disposition).toBe('pass');
  });

  it('does not accept a PowerShell run against a Bash-only rule', () => {
    reset();
    const result = assess([execution({ tool: 'PowerShell' })], [], {}, {
      allowedTools: ['Bash(npm test *)'],
      verificationTools: ['Bash(npm test *)']
    });

    expect(result.verificationStatus).toBe('not_run');
    expect(result.disposition).toBe('fail');
  });

  it('judges two resumed rounds independently', () => {
    // Each parser numbers from 1, so a sequence only means something inside the
    // round it came from. Two assessments, no shared state.
    reset();
    const firstRound = assess([execution({ isError: true })]);
    reset();
    const secondRound = assess([execution({ isError: false })]);

    expect(firstRound.verificationStatus).toBe('failed');
    expect(secondRound.verificationStatus).toBe('passed');
    expect(secondRound.verificationSequence).toBe(1);
  });

  it('is deterministic', () => {
    reset();
    const once = assess([execution()], [denial({ toolUseSequence: 5, command: 'npm run docs' })]);
    reset();
    const twice = assess([execution()], [denial({ toolUseSequence: 5, command: 'npm run docs' })]);

    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
