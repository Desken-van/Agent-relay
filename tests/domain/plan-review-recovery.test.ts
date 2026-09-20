/**
 * Which gates a provider session can speak for, and which reviews must be replaced.
 *
 * Pure functions over rows: the correction loop, the approval rule, the backend's own
 * refusals and the screen all read these, so they are checked here once, against every
 * status, rather than through each caller.
 */

import { describe, expect, it } from 'vitest';
import {
  PLAN_REVIEW_STATUSES,
  planReviewRecovery,
  planReviewRecoveryMessage,
  planReviewSessionIsForeign,
  planReviewSessionOwner,
  type PlanReviewGate
} from '../../src/shared/domain/plan-review';
import { statusLabel } from '../../src/shared/domain/workflow';

type Row = Pick<PlanReviewGate, 'id' | 'sessionId' | 'status' | 'failureKind' | 'reconciledAt' | 'supersededBy'>;

const row = (overrides: Partial<Row> & { id: string }): Row => ({
  sessionId: null,
  status: 'prepared',
  failureKind: null,
  reconciledAt: null,
  supersededBy: null,
  ...overrides
});

describe('which gate a session belongs to', () => {
  // listByTask order: newest first.
  const gates = [row({ id: 'c', sessionId: 'S1' }), row({ id: 'b', sessionId: 'S2' }), row({ id: 'a', sessionId: 'S1' })];

  it('is the FIRST gate that recorded it — the last match in newest-first order', () => {
    expect(planReviewSessionOwner(gates, 'S1')?.id).toBe('a');
    expect(planReviewSessionOwner(gates, 'S2')?.id).toBe('b');
    expect(planReviewSessionOwner(gates, 'S9')).toBeNull();
  });

  it('makes a later gate that holds the same session foreign, and the first gate its owner', () => {
    expect(planReviewSessionIsForeign(gates[0]!, gates)).toBe(true);
    expect(planReviewSessionIsForeign(gates[2]!, gates)).toBe(false);
    expect(planReviewSessionIsForeign(gates[1]!, gates)).toBe(false);
  });

  it('never makes a gate with no session foreign', () => {
    expect(planReviewSessionIsForeign(row({ id: 'x' }), [...gates, row({ id: 'x' })])).toBe(false);
  });
});

describe('when a review must be replaced under a fresh identity', () => {
  const owner = row({ id: 'first', sessionId: 'S1', status: 'proceeded' });

  it('is never for a gate that is not there, or that was already replaced', () => {
    expect(planReviewRecovery(null, [owner])).toBeNull();
    expect(planReviewRecovery(row({ id: 'g', status: 'prepared', failureKind: 'not_dispatched', supersededBy: 'h' }), [owner])).toBeNull();
  });

  it.each(['prepared', 'opening', 'reviewing', 'failed'] as const)(
    'is a refusal before dispatch for a %s gate marked so, and foreign for one marked foreign or holding another gate’s session',
    (status) => {
      expect(planReviewRecovery(row({ id: 'g', status, failureKind: 'not_dispatched' }), [owner])).toBe('refused_before_dispatch');
      expect(planReviewRecovery(row({ id: 'g', status, failureKind: 'foreign_session' }), [owner])).toBe('foreign_session');
      // Structurally foreign — no marker yet, the old build's state.
      expect(planReviewRecovery(row({ id: 'g', status, sessionId: 'S1' }), [row({ id: 'g', status, sessionId: 'S1' }), owner])).toBe(
        'foreign_session'
      );
    }
  );

  it('is NOT for a gate whose call is unknown on a session of its own: that is reconciled, never repeated', () => {
    const own = row({ id: 'g', status: 'reviewing', sessionId: 'S2' });
    expect(planReviewRecovery(own, [own, owner])).toBeNull();
    expect(planReviewRecovery(row({ id: 'g', status: 'opening' }), [owner])).toBeNull();
  });

  it.each(['proceeded', 'changes_requested', 'interrupted'] as const)(
    'is for a %s gate only when its settlement was READ BACK from a session that is not its own',
    (status) => {
      const shared = (extra: Partial<Row>) => row({ id: 'g', status, sessionId: 'S1', ...extra });
      // Read back from another gate's session: not evidence.
      expect(planReviewRecovery(shared({ reconciledAt: '2026-09-20T00:00:00.000Z' }), [shared({}), owner])).toBe('foreign_session');
      // Driven from here (the answers to its own calls): attributed by the call, not by the session.
      expect(planReviewRecovery(shared({ reconciledAt: null }), [shared({}), owner])).toBeNull();
      // Marked foreign by a reconciliation: always.
      expect(planReviewRecovery(shared({ failureKind: 'foreign_session' }), [owner])).toBe('foreign_session');
      // Its own session, read back: fine.
      expect(
        planReviewRecovery(row({ id: 'g', status, sessionId: 'S3', reconciledAt: '2026-09-20T00:00:00.000Z' }), [row({ id: 'g', sessionId: 'S3' }), owner])
      ).toBeNull();
    }
  );

  it.each(['awaiting_resolve', 'resolving'] as const)(
    'is never for a %s gate: its round is its own, returned directly by the call that made it',
    (status) => {
      expect(planReviewRecovery(row({ id: 'g', status, sessionId: 'S1' }), [row({ id: 'g', status, sessionId: 'S1' }), owner])).toBeNull();
    }
  );

  it('has an answer for every status, so a new one cannot slip past unclassified', () => {
    for (const status of PLAN_REVIEW_STATUSES) {
      expect(() => planReviewRecovery(row({ id: 'g', status }), [owner])).not.toThrow();
    }
  });

  it('describes each reason in words that name the safe next step and never quote the provider', () => {
    for (const reason of ['refused_before_dispatch', 'foreign_session'] as const) {
      const message = planReviewRecoveryMessage(reason);
      expect(message).toMatch(/fresh review session/);
      expect(message).toMatch(/nothing is repeated/);
      expect(message).not.toMatch(/Coai/);
    }
  });
});

describe('what the task’s status is called', () => {
  it('does not call an unapproved specification ready for implementation', () => {
    expect(statusLabel({ status: 'READY_FOR_IMPLEMENTATION', specificationApprovedAt: null })).toBe('Specification awaiting approval');
    expect(statusLabel({ status: 'READY_FOR_IMPLEMENTATION', specificationApprovedAt: '2026-09-20T00:00:00.000Z' })).toBe(
      'Ready for implementation'
    );
  });

  it('leaves every other status, and a caller that does not know the approval, as it was', () => {
    expect(statusLabel({ status: 'READY_FOR_IMPLEMENTATION' })).toBe('Ready for implementation');
    expect(statusLabel({ status: 'DRAFT', specificationApprovedAt: null })).toBe('Draft');
    expect(statusLabel({ status: 'IMPLEMENTING', specificationApprovedAt: null })).toBe('Implementing');
  });
});
