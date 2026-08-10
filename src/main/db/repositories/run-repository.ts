import { AgentRelayError } from '../../../shared/domain/errors';
import type { Run, RunStatus, RunType } from '../../../shared/domain/models';
import type { NewRun, RunRepository } from '../../ports';
import type { Db } from '../database';
import { toRun, type RunRow } from '../rows';

const COLUMNS = `id, task_id, agent, run_type, status, round, started_at, finished_at,
                 final_message, structured_result, error_message`;

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Db) {}

  listByTask(taskId: string): Run[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC`)
      .all(taskId) as RunRow[];
    return rows.map(toRun);
  }

  findById(id: string): Run | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return row ? toRun(row) : null;
  }

  create(run: NewRun): Run {
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent, run_type, status, round, started_at,
                           finished_at, final_message, structured_result, error_message)
         VALUES (@id, @taskId, @agent, @runType, @status, @round, @startedAt, NULL, NULL, NULL, NULL)`
      )
      .run(run);

    const created = this.findById(run.id);
    if (!created) throw new AgentRelayError('INTERNAL', 'Run disappeared immediately after insert.');
    return created;
  }

  finish(
    id: string,
    outcome: {
      status: RunStatus;
      finishedAt: string;
      finalMessage?: string | null;
      structuredResult?: string | null;
      errorMessage?: string | null;
    }
  ): Run {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No run with id ${id}.`);
    }

    const next: Run = {
      ...existing,
      status: outcome.status,
      finishedAt: outcome.finishedAt,
      finalMessage: outcome.finalMessage ?? existing.finalMessage,
      structuredResult: outcome.structuredResult ?? existing.structuredResult,
      errorMessage: outcome.errorMessage ?? existing.errorMessage
    };

    this.db
      .prepare(
        `UPDATE runs
            SET status = @status,
                finished_at = @finishedAt,
                final_message = @finalMessage,
                structured_result = @structuredResult,
                error_message = @errorMessage
          WHERE id = @id`
      )
      .run(next);

    return next;
  }

  findLatestByType(taskId: string, runType: RunType): Run | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM runs
          WHERE task_id = ? AND run_type = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(taskId, runType) as RunRow | undefined;
    return row ? toRun(row) : null;
  }
}
