import { AgentRelayError } from '../../../shared/domain/errors';
import type { Approval, ApprovalAction, ApprovalStatus } from '../../../shared/domain/models';
import type { ApprovalRepository } from '../../ports';
import type { Db } from '../database';
import { toApproval, type ApprovalRow } from '../rows';

const COLUMNS = 'id, task_id, action, status, details, requested_at, resolved_at';

/**
 * The audit trail for every action that can touch a remote or write a commit.
 *
 * A row is written *before* the user is asked, and updated with their answer.
 * That ordering matters: if the application crashes mid-dialog, the record shows
 * an unresolved request rather than nothing at all.
 */
export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Db) {}

  listByTask(taskId: string): Approval[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE task_id = ? ORDER BY requested_at ASC, rowid ASC`)
      .all(taskId) as ApprovalRow[];
    return rows.map(toApproval);
  }

  findById(id: string): Approval | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).get(id) as
      | ApprovalRow
      | undefined;
    return row ? toApproval(row) : null;
  }

  create(approval: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, action, status, details, requested_at, resolved_at)
         VALUES (@id, @taskId, @action, @status, @details, @requestedAt, @resolvedAt)`
      )
      .run(approval);
    return approval;
  }

  resolve(id: string, status: Exclude<ApprovalStatus, 'pending'>, resolvedAt: string): Approval {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No approval with id ${id}.`);
    }
    if (existing.status !== 'pending') {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `Approval ${id} has already been resolved as "${existing.status}".`
      );
    }

    this.db
      .prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolvedAt, id);

    return { ...existing, status, resolvedAt };
  }

  findGranted(taskId: string, action: ApprovalAction): Approval | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM approvals
          WHERE task_id = ? AND action = ? AND status = 'granted'
          ORDER BY resolved_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(taskId, action) as ApprovalRow | undefined;
    return row ? toApproval(row) : null;
  }
}
