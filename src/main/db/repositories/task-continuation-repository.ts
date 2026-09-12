import { AgentRelayError } from '../../../shared/domain/errors';
import type { Clock } from '../../ports';
import type { NewTaskContinuation, TaskContinuationRepository } from '../../ports';
import type { Db } from '../database';
import {
  toContinuationClaim,
  toTaskContinuation,
  type ContinuationClaimRow,
  type TaskContinuationRow
} from '../rows';

const COLUMNS = `id, source_task_id, continuation_task_id, entry_action,
                 inherited_verification_run_id, inherited_implementation_run_id,
                 inherited_review_run_id, created_at`;
const CLAIM_COLUMNS = `source_task_id, claim_id, worktree_path, state,
                       continuation_task_id, validated_identity, effective_entry_action,
                       created_at, updated_at`;

export class SqliteTaskContinuationRepository implements TaskContinuationRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  findBySource(sourceTaskId: string) {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM task_continuations WHERE source_task_id = ?`)
      .get(sourceTaskId) as TaskContinuationRow | undefined;
    return row ? toTaskContinuation(row) : null;
  }

  findByContinuation(continuationTaskId: string) {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM task_continuations WHERE continuation_task_id = ?`)
      .get(continuationTaskId) as TaskContinuationRow | undefined;
    return row ? toTaskContinuation(row) : null;
  }

  create(link: NewTaskContinuation) {
    const now = this.clock.nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO task_continuations (
             id, source_task_id, continuation_task_id, entry_action,
             inherited_verification_run_id, inherited_implementation_run_id,
             inherited_review_run_id, created_at)
           VALUES (
             @id, @sourceTaskId, @continuationTaskId, @entryAction,
             @inheritedVerificationRunId, @inheritedImplementationRunId,
             @inheritedReviewRunId, @createdAt)`
        )
        .run({ ...link, createdAt: now });
    } catch (error) {
      // The UNIQUE constraints on source_task_id and continuation_task_id are
      // the final arbiter under a race. A caller that loses one must not
      // surface a raw SQLite message; it re-reads via findBySource instead.
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A continuation for this task already exists.',
        { cause: error }
      );
    }
    return { ...link, createdAt: now };
  }

  findClaimBySource(sourceTaskId: string) {
    const row = this.db.prepare(
      `SELECT ${CLAIM_COLUMNS} FROM task_continuation_claims WHERE source_task_id = ?`
    ).get(sourceTaskId) as ContinuationClaimRow | undefined;
    return row ? toContinuationClaim(row) : null;
  }

  findClaimByContinuation(continuationTaskId: string) {
    const row = this.db.prepare(
      `SELECT ${CLAIM_COLUMNS} FROM task_continuation_claims WHERE continuation_task_id = ?`
    ).get(continuationTaskId) as ContinuationClaimRow | undefined;
    return row ? toContinuationClaim(row) : null;
  }

  listClaims() {
    const rows = this.db.prepare(
      `SELECT ${CLAIM_COLUMNS} FROM task_continuation_claims ORDER BY source_task_id`
    ).all() as ContinuationClaimRow[];
    return rows.map(toContinuationClaim);
  }

  acquireClaim(input: { sourceTaskId: string; claimId: string; worktreePath: string }) {
    const now = this.clock.nowIso();
    try {
      this.db.prepare(
        `INSERT INTO task_continuation_claims (
           source_task_id, claim_id, worktree_path, state, continuation_task_id,
           validated_identity, effective_entry_action, created_at, updated_at)
         VALUES (?, ?, ?, 'creating', NULL, NULL, NULL, ?, ?)`
      ).run(input.sourceTaskId, input.claimId, input.worktreePath, now, now);
    } catch (error) {
      throw new AgentRelayError('BUSY', 'This worktree already has a continuation creation in progress.', {
        cause: error
      });
    }
    const claim = this.findClaimBySource(input.sourceTaskId);
    if (!claim) throw new AgentRelayError('INTERNAL', 'Continuation claim disappeared after creation.');
    return claim;
  }

  bindClaim(input: {
    sourceTaskId: string;
    claimId: string;
    continuationTaskId: string;
    validatedIdentity: string;
    effectiveEntryAction: NewTaskContinuation['entryAction'];
  }) {
    const changed = this.db.prepare(
      `UPDATE task_continuation_claims
          SET state = 'awaiting_first_action', continuation_task_id = ?,
              validated_identity = ?, effective_entry_action = ?, updated_at = ?
        WHERE source_task_id = ? AND claim_id = ? AND state = 'creating'`
    ).run(
      input.continuationTaskId,
      input.validatedIdentity,
      input.effectiveEntryAction,
      this.clock.nowIso(),
      input.sourceTaskId,
      input.claimId
    );
    if (changed.changes !== 1) {
      throw new AgentRelayError('BUSY', 'The continuation creation lease changed before it could be committed.');
    }
    const claim = this.findClaimBySource(input.sourceTaskId);
    if (!claim) throw new AgentRelayError('INTERNAL', 'Continuation claim disappeared after binding.');
    return claim;
  }

  retargetClaimToVerification(sourceTaskId: string, claimId: string, validatedIdentity: string) {
    const changed = this.db.prepare(
      `UPDATE task_continuation_claims
          SET effective_entry_action = 'verification', validated_identity = ?, updated_at = ?
        WHERE source_task_id = ? AND claim_id = ? AND state = 'awaiting_first_action'`
    ).run(validatedIdentity, this.clock.nowIso(), sourceTaskId, claimId);
    if (changed.changes !== 1) throw new AgentRelayError('BUSY', 'The continuation lease is no longer current.');
    const claim = this.findClaimBySource(sourceTaskId);
    if (!claim) throw new AgentRelayError('INTERNAL', 'Continuation claim disappeared after retargeting.');
    return claim;
  }

  releaseClaim(sourceTaskId: string, claimId: string): void {
    this.db.prepare(
      `DELETE FROM task_continuation_claims WHERE source_task_id = ? AND claim_id = ?`
    ).run(sourceTaskId, claimId);
  }

  deleteClaim(sourceTaskId: string): void {
    this.db.prepare('DELETE FROM task_continuation_claims WHERE source_task_id = ?').run(sourceTaskId);
  }
}
