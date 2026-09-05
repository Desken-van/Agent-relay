import type { TaskRuleEvidenceBinding } from '../../../shared/domain/plan-review';
import type { TaskRuleEvidenceRepository } from '../../ports';
import type { Db } from '../database';

interface BindingRow {
  task_id: string;
  snapshot_sha256: string;
  snapshot_json: string;
  bound_at: string;
}

function toBinding(row: BindingRow): TaskRuleEvidenceBinding {
  return {
    taskId: row.task_id,
    snapshotSha256: row.snapshot_sha256,
    snapshotJson: row.snapshot_json,
    boundAt: row.bound_at
  };
}

export class SqliteTaskRuleEvidenceRepository implements TaskRuleEvidenceRepository {
  constructor(private readonly db: Db) {}

  findByTask(taskId: string): TaskRuleEvidenceBinding | null {
    const row = this.db
      .prepare(
        `SELECT task_id, snapshot_sha256, snapshot_json, bound_at
           FROM task_rule_evidence
          WHERE task_id = ?`
      )
      .get(taskId) as BindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  create(binding: TaskRuleEvidenceBinding): TaskRuleEvidenceBinding {
    this.db
      .prepare(
        `INSERT INTO task_rule_evidence (task_id, snapshot_sha256, snapshot_json, bound_at)
         VALUES (@taskId, @snapshotSha256, @snapshotJson, @boundAt)`
      )
      .run(binding);
    return binding;
  }
}
