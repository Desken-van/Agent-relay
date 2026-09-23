import { describe, expect, it } from 'vitest';
import {
  parsePlanRevisionAddressed,
  planCorrectionNextStep,
  revisionAddressesProblem
} from '../../src/shared/domain/plan-correction';
import type { PlanReviewGate, PlanReviewGateIdentity } from '../../src/shared/domain/plan-review';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
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

describe('planCorrectionNextStep: an attempt that cannot count is replaced first', () => {
  const withRecovery = (
    status: PlanReviewGate['status'],
    recovery: 'refused_before_dispatch' | 'foreign_session' | null
  ) =>
    planCorrectionNextStep({
      gate: { status, decisionsJson: null },
      identity: 'current',
      correctionForGate: null,
      used: 0,
      max: 3,
      recovery
    });

  it.each(['prepared', 'opening', 'reviewing', 'failed', 'proceeded', 'changes_requested'] as const)(
    'is recover_review for a %s gate that cannot count, ahead of reconcile and of every reading of the status',
    (status) => {
      expect(withRecovery(status, 'foreign_session')).toBe('recover_review');
      expect(withRecovery(status, 'refused_before_dispatch')).toBe('recover_review');
    }
  );

  it('is not recovery for a gate of an EARLIER specification: the retry would be refused, so the ordinary path applies', () => {
    const obsolete = (
      status: PlanReviewGate['status'],
      correction: 'completed' | null
    ) =>
      planCorrectionNextStep({
        gate: { status, decisionsJson: null },
        identity: 'obsolete',
        correctionForGate: correction === null ? null : { status: correction },
        used: 0,
        max: 3,
        recovery: 'foreign_session'
      });

    // Never reconciled either: what the provider says about that session is about another review.
    expect(obsolete('reviewing', null)).toBe('none');
    expect(obsolete('opening', null)).toBe('none');
    expect(obsolete('reviewing', 'completed')).toBe('run_review');
    // Unknown identity is still not judged.
    expect(
      planCorrectionNextStep({ gate: { status: 'reviewing', decisionsJson: null }, identity: 'unknown', correctionForGate: null, used: 0, max: 3, recovery: 'foreign_session' })
    ).toBe('none');
  });

  it('changes nothing for a gate with no recovery, so a stuck call is still reconciled and a prepared gate still reviewed', () => {
    expect(withRecovery('reviewing', null)).toBe('reconcile');
    expect(withRecovery('prepared', null)).toBe('run_review');
    expect(withRecovery('proceeded', null)).toBe('clean');
  });
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

  it('refuses a field that changed without being tied to an accepted finding, even when every finding is covered', () => {
    const rewritten = makeSpecification({ summary: 'Two', constraints: ['Keep A', 'Dropped the safety rule'] });
    expect(
      revisionAddressesProblem({
        accepted: [{ finding: 0 }],
        addressed: [{ finding: 0, field: 'summary', change: 'x' }],
        current,
        revised: rewritten
      })
    ).toMatch(/changed "constraints" without tying the change to an accepted finding/);
    // Claiming both fields is what makes the same revision acceptable.
    expect(
      revisionAddressesProblem({
        accepted: [{ finding: 0 }],
        addressed: [
          { finding: 0, field: 'summary', change: 'x' },
          { finding: 0, field: 'constraints', change: 'y' }
        ],
        current,
        revised: rewritten
      })
    ).toBeNull();
  });

  describe('one entry per (accepted finding, changed field) pair', () => {
    const before = makeSpecification({
      acceptanceCriteria: ['The section exists.'],
      constraints: ['Do not change the existing sections.'],
      implementationPrompt: 'Add the section.'
    });
    // One accepted finding whose correction needs a new constraint AND a new instruction.
    const after = makeSpecification({
      acceptanceCriteria: ['The section exists.'],
      constraints: ['Do not change the existing sections.', 'Use only synthetic fixtures.'],
      implementationPrompt: 'Add the section, using only synthetic fixtures.'
    });

    it('reproduces the reported refusal: one entry per finding leaves the second changed field untied', () => {
      expect(
        revisionAddressesProblem({
          accepted: [{ finding: 0 }],
          addressed: [{ finding: 0, field: 'implementationPrompt', change: 'Named the fixtures.' }],
          current: before,
          revised: after
        })
      ).toBe('Codex changed "constraints" without tying the change to an accepted finding.');
    });

    it('accepts the same finding repeated once per field it changed, across several findings', () => {
      const wider = makeSpecification({
        ...after,
        acceptanceCriteria: ['The section exists.', 'Only synthetic fixtures are used.']
      });
      expect(
        revisionAddressesProblem({
          accepted: [{ finding: 0 }, { finding: 3 }],
          addressed: [
            { finding: 0, field: 'constraints', change: 'Added the fixture constraint.' },
            { finding: 0, field: 'implementationPrompt', change: 'Told the implementer.' },
            { finding: 0, field: 'acceptanceCriteria', change: 'Made it checkable.' },
            // One edit serving two findings: the field is named once per finding.
            { finding: 3, field: 'implementationPrompt', change: 'The same instruction covers it.' }
          ],
          current: before,
          revised: wider
        })
      ).toBeNull();
    });

    it.each<[string, Partial<TaskSpecification>]>([
      ['title', { title: 'A rewritten title' }],
      ['scopedFilePaths', { scopedFilePaths: ['docs/manual-test.md'] }],
      ['assumptions', { assumptions: ['A new assumption nobody asked for.'] }]
    ])(
      'still refuses an unrelated change to "%s" when every finding is covered by repeated pairs',
      (field, change) => {
        expect(
          revisionAddressesProblem({
            accepted: [{ finding: 0 }],
            addressed: [
              { finding: 0, field: 'constraints', change: 'Added the fixture constraint.' },
              { finding: 0, field: 'implementationPrompt', change: 'Told the implementer.' }
            ],
            current: before,
            revised: makeSpecification({ ...after, ...change })
          })
        ).toBe(`Codex changed "${field}" without tying the change to an accepted finding.`);
      }
    );
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
