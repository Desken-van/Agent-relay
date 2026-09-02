import { AgentRelayError } from '../../../shared/domain/errors';
import type { Task } from '../../../shared/domain/models';
import { BUSY_STATUSES } from '../../../shared/domain/workflow';
import type { Clock, NewTask, TaskPatch, TaskRepository } from '../../ports';
import type { Db } from '../database';
import { toTask, type TaskRow } from '../rows';

const COLUMNS = `id, project_id, title, original_request, status, current_round, max_rounds,
                 codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch,
                 specification_json, specification_approved_at, last_review_json, last_error,
                 codex_model, claude_model, created_at, updated_at`;

/**
 * Persistence for tasks.
 *
 * Note that `codex_thread_id` and `claude_session_id` live here rather than in
 * volatile memory: resuming a conversation after the application restarts is a
 * core requirement, and the only durable handle we have on either agent is its
 * id string.
 */
export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  listByProject(projectId: string): Task[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as TaskRow[];
    return rows.map(toTask);
  }

  /**
   * Every task in a busy status, across all projects.
   *
   * The statuses come from the workflow module rather than being spelled out
   * here, so a new busy status cannot be added to the machine and forgotten by
   * the code that has to recover from a crash.
   *
   * Ordered by id so the result is stable: reconciliation must not depend on
   * whatever order the storage engine happens to return.
   */
  listBusy(): Task[] {
    const placeholders = BUSY_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks WHERE status IN (${placeholders}) ORDER BY id ASC`)
      .all(...BUSY_STATUSES) as TaskRow[];
    return rows.map(toTask);
  }

  findById(id: string): Task | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : null;
  }

  create(task: NewTask): Task {
    const now = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, original_request, status, current_round,
                            max_rounds, codex_thread_id, claude_session_id, worktree_path,
                            branch_name, base_branch, specification_json, specification_approved_at,
                            last_review_json, last_error, codex_model, claude_model, created_at, updated_at)
         VALUES (@id, @projectId, @title, @originalRequest, @status, @currentRound,
                 @maxRounds, @codexThreadId, @claudeSessionId, @worktreePath,
                 @branchName, @baseBranch, @specificationJson, @specificationApprovedAt,
                 @lastReviewJson, @lastError, @codexModel, @claudeModel, @createdAt, @updatedAt)`
      )
      .run({ ...task, createdAt: now, updatedAt: now });

    const created = this.findById(task.id);
    if (!created) throw new AgentRelayError('INTERNAL', 'Task disappeared immediately after insert.');
    return created;
  }

  update(id: string, patch: TaskPatch): Task {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No task with id ${id}.`);
    }

    const next: Task = { ...existing, ...patch, updatedAt: this.clock.nowIso() };

    this.db
      .prepare(
        `UPDATE tasks
            SET title = @title,
                original_request = @originalRequest,
                status = @status,
                current_round = @currentRound,
                max_rounds = @maxRounds,
                codex_thread_id = @codexThreadId,
                claude_session_id = @claudeSessionId,
                worktree_path = @worktreePath,
                branch_name = @branchName,
                base_branch = @baseBranch,
                specification_json = @specificationJson,
                specification_approved_at = @specificationApprovedAt,
                last_review_json = @lastReviewJson,
                last_error = @lastError,
                codex_model = @codexModel,
                claude_model = @claudeModel,
                updated_at = @updatedAt
          WHERE id = @id`
      )
      .run(next);

    return next;
  }

  /**
   * Every task that currently owns a worktree. Used to guarantee two tasks never
   * point at the same directory, which would let two Claude sessions stomp on
   * each other's edits.
   */
  listActiveWorktreePaths(): { taskId: string; worktreePath: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, worktree_path
           FROM tasks
          WHERE worktree_path IS NOT NULL
            AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`
      )
      .all() as { id: string; worktree_path: string }[];
    return rows.map((row) => ({ taskId: row.id, worktreePath: row.worktree_path }));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }
}
