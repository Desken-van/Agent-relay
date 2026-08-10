import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/shared/domain/errors';
import {
  allowedEvents,
  assertPublishable,
  canTransition,
  decideReviewOutcome,
  isBusy,
  isTerminal,
  STATUS_LABELS,
  TASK_STATUSES,
  TRANSITIONS,
  transition,
  WORKFLOW_EVENTS,
  type TaskStatus,
  type WorkflowEvent
} from '../../src/shared/domain/workflow';

describe('workflow state machine', () => {
  it('exposes a label for every status', () => {
    for (const status of TASK_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it('has an entry in the transition table for every status', () => {
    for (const status of TASK_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
    }
  });

  it('only ever transitions to a declared status', () => {
    for (const status of TASK_STATUSES) {
      for (const target of Object.values(TRANSITIONS[status])) {
        expect(TASK_STATUSES).toContain(target);
      }
    }
  });

  it('only uses declared event names', () => {
    for (const status of TASK_STATUSES) {
      for (const event of Object.keys(TRANSITIONS[status])) {
        expect(WORKFLOW_EVENTS).toContain(event as WorkflowEvent);
      }
    }
  });

  describe('the happy path', () => {
    it('walks DRAFT -> COMPLETED through the expected states', () => {
      let status: TaskStatus = 'DRAFT';

      status = transition(status, 'specification_started');
      expect(status).toBe('SPECIFYING');

      status = transition(status, 'specification_completed');
      expect(status).toBe('READY_FOR_IMPLEMENTATION');

      status = transition(status, 'implementation_started');
      expect(status).toBe('IMPLEMENTING');

      status = transition(status, 'implementation_completed');
      expect(status).toBe('READY_FOR_REVIEW');

      status = transition(status, 'review_started');
      expect(status).toBe('REVIEWING');

      status = transition(status, 'review_approved');
      expect(status).toBe('APPROVED');

      status = transition(status, 'publish_approved');
      expect(status).toBe('READY_TO_PUBLISH');

      status = transition(status, 'publish_started');
      expect(status).toBe('PUBLISHING');

      status = transition(status, 'publish_completed');
      expect(status).toBe('COMPLETED');
    });

    it('routes a correction round back through IMPLEMENTING', () => {
      let status: TaskStatus = 'REVIEWING';
      status = transition(status, 'review_changes_requested');
      expect(status).toBe('CHANGES_REQUESTED');

      status = transition(status, 'corrections_sent');
      expect(status).toBe('IMPLEMENTING');

      status = transition(status, 'implementation_completed');
      expect(status).toBe('READY_FOR_REVIEW');
    });
  });

  describe('invalid transitions', () => {
    it('rejects an event that is not legal for the current status', () => {
      expect(() => transition('DRAFT', 'review_approved')).toThrow(InvalidTransitionError);
      expect(() => transition('DRAFT', 'implementation_started')).toThrow(InvalidTransitionError);
      expect(() => transition('APPROVED', 'specification_started')).toThrow(InvalidTransitionError);
      expect(() => transition('READY_FOR_REVIEW', 'corrections_sent')).toThrow(
        InvalidTransitionError
      );
    });

    it('makes terminal states genuinely terminal', () => {
      for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
        expect(isTerminal(status)).toBe(true);
        expect(allowedEvents(status)).toHaveLength(0);
        for (const event of WORKFLOW_EVENTS) {
          expect(canTransition(status, event)).toBe(false);
          expect(() => transition(status, event)).toThrow(InvalidTransitionError);
        }
      }
    });

    it('carries the offending status and event in the error message', () => {
      try {
        transition('DRAFT', 'publish_completed');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTransitionError);
        expect((error as InvalidTransitionError).message).toContain('DRAFT');
        expect((error as InvalidTransitionError).message).toContain('publish_completed');
      }
    });

    it('lets every non-terminal state be cancelled', () => {
      for (const status of TASK_STATUSES) {
        if (isTerminal(status)) continue;
        expect(transition(status, 'cancelled')).toBe('CANCELLED');
      }
    });
  });

  describe('busy states', () => {
    it('marks exactly the states where an agent process can be live', () => {
      expect(isBusy('SPECIFYING')).toBe(true);
      expect(isBusy('IMPLEMENTING')).toBe(true);
      expect(isBusy('REVIEWING')).toBe(true);
      expect(isBusy('PUBLISHING')).toBe(true);

      expect(isBusy('DRAFT')).toBe(false);
      expect(isBusy('READY_FOR_REVIEW')).toBe(false);
      expect(isBusy('APPROVED')).toBe(false);
      expect(isBusy('COMPLETED')).toBe(false);
    });

    it('allows every busy state to recover to a retryable state', () => {
      expect(transition('SPECIFYING', 'specification_aborted')).toBe('DRAFT');
      expect(transition('IMPLEMENTING', 'implementation_aborted')).toBe('READY_FOR_IMPLEMENTATION');
      expect(transition('IMPLEMENTING', 'correction_aborted')).toBe('CHANGES_REQUESTED');
      expect(transition('REVIEWING', 'review_aborted')).toBe('READY_FOR_REVIEW');
      expect(transition('PUBLISHING', 'publish_aborted')).toBe('READY_TO_PUBLISH');
    });
  });

  describe('decideReviewOutcome — the loop terminator', () => {
    it('ends the loop when Codex approves', () => {
      const decision = decideReviewOutcome('approved', 1, 3);
      expect(decision.event).toBe('review_approved');
      expect(decision.canContinue).toBe(false);
      expect(decision.haltReason).toBeUndefined();
    });

    it('ends the loop when Codex blocks', () => {
      const decision = decideReviewOutcome('blocked', 1, 3);
      expect(decision.event).toBe('review_blocked');
      expect(decision.canContinue).toBe(false);
    });

    it('allows another round while the budget lasts', () => {
      for (let round = 1; round < 3; round += 1) {
        const decision = decideReviewOutcome('changes_requested', round, 3);
        expect(decision.canContinue).toBe(true);
        expect(decision.haltReason).toBeUndefined();
      }
    });

    it('halts once the budget is spent, and says why', () => {
      const decision = decideReviewOutcome('changes_requested', 3, 3);
      expect(decision.event).toBe('review_changes_requested');
      expect(decision.canContinue).toBe(false);
      expect(decision.haltReason).toContain('3/3');
    });

    it('halts if the round counter has somehow overshot the budget', () => {
      expect(decideReviewOutcome('changes_requested', 9, 3).canContinue).toBe(false);
    });

    it('never continues with a single-round budget', () => {
      expect(decideReviewOutcome('changes_requested', 1, 1).canContinue).toBe(false);
    });
  });

  describe('assertPublishable', () => {
    it('refuses without a granted approval, whatever the status', () => {
      for (const status of TASK_STATUSES) {
        expect(() => assertPublishable(status, false, 'push')).toThrow(InvalidTransitionError);
      }
    });

    it('refuses from a status that is not publish-ready even with approval', () => {
      expect(() => assertPublishable('APPROVED', true, 'push')).toThrow(InvalidTransitionError);
      expect(() => assertPublishable('DRAFT', true, 'commit')).toThrow(InvalidTransitionError);
      expect(() => assertPublishable('COMPLETED', true, 'commit')).toThrow(InvalidTransitionError);
    });

    it('permits it only from READY_TO_PUBLISH or PUBLISHING with approval', () => {
      expect(() => assertPublishable('READY_TO_PUBLISH', true, 'push')).not.toThrow();
      expect(() => assertPublishable('PUBLISHING', true, 'push')).not.toThrow();
    });
  });
});
