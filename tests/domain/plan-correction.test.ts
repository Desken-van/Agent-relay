import { describe, expect, it } from 'vitest';
import {
  parsePlanRevisionAddressed,
  planCorrectionNextStep,
  revisionAddressesProblem
} from '../../src/shared/domain/plan-correction';
import type { PlanReviewGate, PlanReviewGateIdentity } from '../../src/shared/domain/plan-review';
import { makeSpecification } from '../helpers/fakes';

const ACCEPTED = JSON.stringify([{ finding: 0, action: 'accept', reason: 'Valid.' }]);
const REJECTED = JSON.stringify([{ finding: 0, action: 'reject', reason: 'Wrong.' }]);

const step = (
  status: PlanReviewGate['status'],
  decisionsJson: string | null,
  identity: PlanReviewGateIdentity = 'current',
  extra: { correction?: 'completed' | 'failed' | 'running' | null; used?: number; max?: number } = {}
) =>
  planCorrectionNextStep({
    gate: { status, decisionsJson },
    identity,
    correctionForGate: extra.correction ? { status: extra.correction } : null,
    used: extra.used ?? 0,
    max: extra.max ?? 3
  });

describe('planCorrectionNextStep: derived from durable state only', () => {
  it('has nothing to do without a gate, or when the identity cannot be judged', () => {
    expect(planCorrectionNextStep({ gate: null, identity: 'no_gate', correctionForGate: null, used: 0, max: 3 })).toBe('none');
    expect(step('changes_requested', REJECTED, 'unknown')).toBe('none');
    expect(step('changes_requested', REJECTED, 'no_gate')).toBe('none');
  });

  it('never repeats a dispatched external call: an unknown outcome is reconciled first', () => {
    for (const status of ['opening', 'reviewing', 'resolving', 'failed'] as const) {
      expect(step(status, null)).toBe('reconcile');
    }
  });

  it('waits for decisions while a round is awaiting them', () => {
    expect(step('awaiting_resolve', null)).toBe('decide');
  });

  it('revises whenever the current gate accepted something, whatever its status says — never "clean"', () => {
    expect(step('changes_requested', ACCEPTED)).toBe('revise');
    expect(step('proceeded', ACCEPTED)).toBe('revise');
    expect(step('interrupted', ACCEPTED)).toBe('revise');
    // A failed earlier attempt for this gate is retried, not skipped.
    expect(step('changes_requested', ACCEPTED, 'current', { correction: 'failed' })).toBe('revise');
  });

  it('stops at the budget instead of revising once the permitted corrections have run', () => {
    expect(step('changes_requested', ACCEPTED, 'current', { used: 3, max: 3 })).toBe('round_limit');
    expect(step('changes_requested', ACCEPTED, 'current', { used: 2, max: 3 })).toBe('revise');
  });

  it('is clean only when the current gate proceeded with nothing accepted', () => {
    expect(step('proceeded', REJECTED)).toBe('clean');
    expect(step('proceeded', '[]')).toBe('clean');
  });

  it('runs the next review for a settled round with nothing accepted, and the first for a prepared gate', () => {
    expect(step('changes_requested', REJECTED)).toBe('run_next_review');
    expect(step('interrupted', REJECTED)).toBe('run_next_review');
    expect(step('prepared', null)).toBe('run_review');
  });

  it('reviews the revised specification only when a completed correction sits behind an obsolete gate', () => {
    expect(step('changes_requested', ACCEPTED, 'obsolete', { correction: 'completed' })).toBe('run_review');
    expect(step('changes_requested', ACCEPTED, 'obsolete', { correction: 'failed' })).toBe('none');
    expect(step('changes_requested', ACCEPTED, 'obsolete')).toBe('none');
  });
});

describe('revisionAddressesProblem', () => {
  const current = makeSpecification({ summary: 'One', constraints: ['Keep A'] });
  const revised = makeSpecification({ summary: 'Two', constraints: ['Keep A'] });
  const accepted = [{ finding: 0 }, { finding: 3 }];

  it('accepts a revision that accounts for every accepted finding in a field that changed', () => {
    expect(
      revisionAddressesProblem({
        accepted,
        addressed: [
          { finding: 0, field: 'summary', change: 'x' },
          { finding: 3, field: 'summary', change: 'y' }
        ],
        current,
        revised
      })
    ).toBeNull();
  });

  it('names the accepted findings that were never mentioned', () => {
    expect(
      revisionAddressesProblem({ accepted, addressed: [{ finding: 0, field: 'summary', change: 'x' }], current, revised })
    ).toMatch(/did not say where it addressed accepted finding 3\./);
    expect(revisionAddressesProblem({ accepted, addressed: [], current, revised })).toMatch(
      /accepted findings 0, 3\./
    );
  });

  it('refuses a claim about a field that did not change', () => {
    expect(
      revisionAddressesProblem({
        accepted: [{ finding: 0 }],
        addressed: [{ finding: 0, field: 'constraints', change: 'x' }],
        current,
        revised
      })
    ).toMatch(/"constraints", but that field is unchanged/);
  });

  it('refuses a claim about a finding that was not accepted', () => {
    expect(
      revisionAddressesProblem({
        accepted: [{ finding: 0 }],
        addressed: [
          { finding: 0, field: 'summary', change: 'x' },
          { finding: 9, field: 'summary', change: 'y' }
        ],
        current,
        revised
      })
    ).toMatch(/finding 9, which was not one of the accepted findings/);
  });
});

describe('parsePlanRevisionAddressed', () => {
  it('reads a stored claim, and treats anything absent or unreadable as none', () => {
    expect(parsePlanRevisionAddressed(JSON.stringify([{ finding: 1, field: 'summary', change: 'x' }]))).toEqual([
      { finding: 1, field: 'summary', change: 'x' }
    ]);
    expect(parsePlanRevisionAddressed(null)).toEqual([]);
    expect(parsePlanRevisionAddressed('not json')).toEqual([]);
    expect(parsePlanRevisionAddressed('{"a":1}')).toEqual([]);
    expect(
      parsePlanRevisionAddressed(JSON.stringify([{ finding: 1, field: 'nonsense', change: 'x' }, { finding: 2 }]))
    ).toEqual([]);
  });
});
