/**
 * Reading a persisted verdict.
 *
 * This is the only part of the assessment that runs in the renderer, and it
 * runs against rows the current build did not necessarily write: older runs,
 * newer runs, and rows a person has edited by hand. Opening a task must never
 * be the thing that crashes, so every failure mode here is a value, not a throw.
 */

import { describe, expect, it } from 'vitest';
import {
  assessmentPublishRefusal,
  CLAUDE_ASSESSMENT_VERSION,
  readClaudeAssessment,
  type ClaudeRoundAssessmentRecord
} from '../../src/shared/domain/claude-assessment';

const RECORD: ClaudeRoundAssessmentRecord = {
  version: CLAUDE_ASSESSMENT_VERSION,
  disposition: 'warn',
  verificationStatus: 'passed',
  publishBlock: 'none',
  reasonCodes: ['verification_passed', 'auxiliary_denial'],
  verification: {
    tool: 'Bash',
    command: 'npm test',
    matchedRule: 'Bash(npm test *)',
    toolUseSequence: 2
  },
  denials: [
    {
      category: 'auxiliary',
      tool: 'Bash',
      command: 'npm run coverage',
      commandTruncated: false,
      reason: 'This command requires approval',
      resolved: false
    }
  ]
};

const wrapped = (assessment: unknown) =>
  JSON.stringify({ numTurns: 4, sessionId: 's-1', assessment });

/* -------------------------------------------------------------------------- */

describe('reading a record', () => {
  it('reads one nested in a structured result', () => {
    const result = readClaudeAssessment(wrapped(RECORD));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assessment).toEqual(RECORD);
  });

  it('reads a bare record', () => {
    const result = readClaudeAssessment(JSON.stringify(RECORD));

    expect(result.ok).toBe(true);
  });

  it('round-trips without losing anything', () => {
    const first = readClaudeAssessment(wrapped(RECORD));
    if (!first.ok) throw new Error('expected a readable record');

    const second = readClaudeAssessment(JSON.stringify(first.assessment));
    expect(second.ok && second.assessment).toEqual(RECORD);
  });
});

describe('reading something else', () => {
  it('reports an absence for a run with no structured result', () => {
    expect(readClaudeAssessment(null)).toEqual({ ok: false, absence: 'absent' });
    expect(readClaudeAssessment('   ')).toEqual({ ok: false, absence: 'absent' });
  });

  it('reports an absence for a structured result from an older build', () => {
    // What the orchestrator used to write. Nothing is wrong with it; it simply
    // is not an assessment, and calling that corruption would be alarming noise.
    const older = JSON.stringify({ numTurns: 3, sessionId: 'claude-session-1' });

    expect(readClaudeAssessment(older)).toEqual({ ok: false, absence: 'absent' });
  });

  it('reports an absence for a specification run’s structured result', () => {
    const specification = JSON.stringify({ title: 'Add a health endpoint', findings: [] });

    expect(readClaudeAssessment(specification)).toEqual({ ok: false, absence: 'absent' });
  });

  it('reports malformed for text that is not JSON', () => {
    expect(readClaudeAssessment('{ not json')).toEqual({ ok: false, absence: 'malformed' });
  });

  it('reports malformed for JSON that is not an object', () => {
    expect(readClaudeAssessment('[1, 2, 3]')).toEqual({ ok: false, absence: 'malformed' });
    expect(readClaudeAssessment('"hello"')).toEqual({ ok: false, absence: 'malformed' });
  });

  it('reports malformed for a record with the wrong shape', () => {
    const broken = wrapped({ ...RECORD, disposition: 'probably fine' });

    expect(readClaudeAssessment(broken)).toEqual({ ok: false, absence: 'malformed' });
  });

  it('reports malformed for a record missing its denials', () => {
    const broken = wrapped({ ...RECORD, denials: undefined });

    expect(readClaudeAssessment(broken)).toEqual({ ok: false, absence: 'malformed' });
  });

  it('reports an unsupported version rather than guessing at it', () => {
    const future = wrapped({ ...RECORD, version: 2 });

    expect(readClaudeAssessment(future)).toEqual({
      ok: false,
      absence: 'unsupported_version'
    });
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '{', 'null', '0', '[]', '{"assessment":null}', '{"version":"one"}']) {
      expect(() => readClaudeAssessment(input)).not.toThrow();
    }
  });
});

describe('what a record permits', () => {
  it('allows publishing when nothing blocks it', () => {
    expect(assessmentPublishRefusal(readClaudeAssessment(wrapped(RECORD)))).toEqual({
      blocked: false
    });
  });

  it('refuses on every block kind', () => {
    for (const block of ['verification', 'security', 'telemetry', 'configuration'] as const) {
      const result = readClaudeAssessment(wrapped({ ...RECORD, publishBlock: block }));

      expect(assessmentPublishRefusal(result)).toEqual({ blocked: true, code: block });
    }
  });

  it('refuses when there is no record to read', () => {
    // Fail-closed: an absence is not permission. A round that predates this
    // proved nothing about itself, and neither does one nobody can parse.
    for (const input of [null, '{ not json', wrapped({ ...RECORD, version: 99 })]) {
      expect(assessmentPublishRefusal(readClaudeAssessment(input)).blocked).toBe(true);
    }
  });
});
