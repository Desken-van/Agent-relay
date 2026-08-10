import type { RunEvent, RunEventType } from '../../../shared/domain/models';
import type { RunEventRepository } from '../../ports';
import type { Db } from '../database';
import { toRunEvent, type RunEventRow } from '../rows';

const COLUMNS = 'id, run_id, timestamp, type, payload';

/**
 * Append-only log of everything an agent emitted during a run.
 *
 * Ordering uses SQLite's implicit `rowid` rather than the timestamp: agents can
 * emit several events inside the same millisecond, and insertion order is the
 * only ordering that is actually true.
 */
export class SqliteRunEventRepository implements RunEventRepository {
  constructor(private readonly db: Db) {}

  append(event: {
    id: string;
    runId: string;
    type: RunEventType;
    payload: string;
    timestamp: string;
  }): RunEvent {
    this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, timestamp, type, payload)
         VALUES (@id, @runId, @timestamp, @type, @payload)`
      )
      .run(event);

    return {
      id: event.id,
      runId: event.runId,
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload
    };
  }

  listByRun(runId: string, options?: { afterId?: string; limit?: number }): RunEvent[] {
    const limit = options?.limit ?? 2000;

    if (options?.afterId) {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM run_events
            WHERE run_id = ?
              AND rowid > (SELECT rowid FROM run_events WHERE id = ?)
            ORDER BY rowid ASC
            LIMIT ?`
        )
        .all(runId, options.afterId, limit) as RunEventRow[];
      return rows.map(toRunEvent);
    }

    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM run_events WHERE run_id = ? ORDER BY rowid ASC LIMIT ?`)
      .all(runId, limit) as RunEventRow[];
    return rows.map(toRunEvent);
  }

  storedBytes(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS total FROM run_events WHERE run_id = ?')
      .get(runId) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  deleteByRun(runId: string): void {
    this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
  }
}
