import { AgentRelayError } from '../../../shared/domain/errors';
import {
  DIAGNOSTIC_RUN_VERSION,
  type OperationDiagnosticRun
} from '../../../shared/domain/operations-diagnostics';
import type {
  DiagnosticOutcome,
  NewDiagnosticRun,
  OperationDiagnosticRepository
} from '../../ports';
import type { Db } from '../database';
import { toOperationDiagnosticRun, type OperationDiagnosticRunRow } from '../rows';

const COLUMNS = `id, target_id, probe_id, status, started_at, finished_at,
                 structured_result, failure_kind, error_message, version`;

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;

/**
 * Reject an outcome that does not match one of the two terminal shapes.
 *
 * The union already says this, but a union is a promise to the compiler. This
 * is the same promise made to a caller that came in through `as never`, a JSON
 * payload, or a future refactor that widened the type without noticing.
 */
function assertOutcomeShape(outcome: DiagnosticOutcome): void {
  const loose = outcome as {
    status: string;
    result?: unknown;
    failureKind?: unknown;
    errorMessage?: unknown;
  };

  if (loose.status === 'succeeded') {
    if (loose.result === undefined || loose.result === null) {
      throw new AgentRelayError(
        'INTERNAL',
        'A succeeded diagnostic run must carry the result the probe returned.'
      );
    }
    if (loose.failureKind != null || loose.errorMessage != null) {
      throw new AgentRelayError(
        'INTERNAL',
        'A succeeded diagnostic run may not carry a failure kind or an error message.'
      );
    }
    return;
  }

  if (loose.status === 'failed') {
    if (loose.result != null) {
      throw new AgentRelayError(
        'INTERNAL',
        'A failed diagnostic run may not carry a result.'
      );
    }
    if (loose.failureKind == null) {
      throw new AgentRelayError('INTERNAL', 'A failed diagnostic run must say how it failed.');
    }
    if (typeof loose.errorMessage !== 'string' || loose.errorMessage.trim().length === 0) {
      throw new AgentRelayError(
        'INTERNAL',
        'A failed diagnostic run must carry a non-empty message.'
      );
    }
    return;
  }

  throw new AgentRelayError('INTERNAL', 'A diagnostic run can only be closed as succeeded or failed.');
}

/**
 * Storage for diagnostic runs.
 *
 * A run is written as `running` before the probe starts and closed exactly once
 * afterwards, the same shape the agent runs use — which is what lets startup
 * reconciliation find the ones an abrupt exit left behind.
 */
export class SqliteOperationDiagnosticRepository implements OperationDiagnosticRepository {
  constructor(private readonly db: Db) {}

  listByTarget(targetId: string, limit = DEFAULT_HISTORY_LIMIT): OperationDiagnosticRun[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_HISTORY_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM operation_diagnostic_runs
          WHERE target_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(targetId, bounded) as OperationDiagnosticRunRow[];
    return rows.map(toOperationDiagnosticRun);
  }

  findById(id: string): OperationDiagnosticRun | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM operation_diagnostic_runs WHERE id = ?`)
      .get(id) as OperationDiagnosticRunRow | undefined;
    return row ? toOperationDiagnosticRun(row) : null;
  }

  /** Ordered so two callers always see the same sequence; recovery must be reproducible. */
  listRunning(): OperationDiagnosticRun[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM operation_diagnostic_runs
          WHERE status = 'running'
          ORDER BY started_at ASC, rowid ASC`
      )
      .all() as OperationDiagnosticRunRow[];
    return rows.map(toOperationDiagnosticRun);
  }

  findRunningForTarget(targetId: string): OperationDiagnosticRun | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM operation_diagnostic_runs
          WHERE target_id = ? AND status = 'running'
          ORDER BY started_at ASC, rowid ASC
          LIMIT 1`
      )
      .get(targetId) as OperationDiagnosticRunRow | undefined;
    return row ? toOperationDiagnosticRun(row) : null;
  }

  countByTarget(targetId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM operation_diagnostic_runs WHERE target_id = ?')
      .get(targetId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  start(run: NewDiagnosticRun): OperationDiagnosticRun {
    this.db
      .prepare(
        `INSERT INTO operation_diagnostic_runs
           (id, target_id, probe_id, status, started_at, finished_at,
            structured_result, failure_kind, error_message, version)
         VALUES (@id, @targetId, @probeId, 'running', @startedAt, NULL, NULL, NULL, NULL, @version)`
      )
      .run({ ...run, version: DIAGNOSTIC_RUN_VERSION });

    const created = this.findById(run.id);
    if (!created) {
      throw new AgentRelayError('INTERNAL', 'The diagnostic run disappeared immediately after insert.');
    }
    return created;
  }

  /**
   * Close a run, exactly once.
   *
   * Three guards, and the order is deliberate.
   *
   * **A result belongs to a success, and a success must have one.** The table
   * enforces both, so a failure cannot be recorded with a leftover result
   * attached and a success cannot be recorded with nothing to show for it.
   *
   * **A result must be about *this* run.** A probe answers a question; a stored
   * answer that names a different target or a different probe is not the answer
   * to the question this row asked, however well-formed it looks. The service
   * checks the same thing against the live request — this is the floor under
   * that, so nothing can reach the table by another route.
   *
   * **A terminal run stays terminal.** The `UPDATE` matches only a row still
   * marked `running`, and a zero-row update is reported rather than passed off
   * as success. Without that, a second `finish` — a retry, a race, a caller that
   * lost track — could turn a recorded success into a failure, or overwrite the
   * evidence of one, and the audit trail would quietly change underneath.
   */
  finish(id: string, outcome: DiagnosticOutcome): OperationDiagnosticRun {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No diagnostic run with id ${id}.`);
    }

    // Checked at runtime, not only in the type. A caller that reached for
    // `as never` to get past the union would otherwise write a row shape the
    // table is about to reject anyway — better to say what is wrong here than
    // to surface a constraint error from three layers down.
    assertOutcomeShape(outcome);

    if (outcome.status === 'succeeded') {
      if (outcome.result.targetId !== existing.targetId) {
        throw new AgentRelayError(
          'INTERNAL',
          'The probe result names a different target than the run it would be stored against.'
        );
      }
      if (outcome.result.probeId !== existing.probeId) {
        throw new AgentRelayError(
          'INTERNAL',
          'The probe result names a different probe than the run it would be stored against.'
        );
      }
    }

    const changed = this.db
      .prepare(
        `UPDATE operation_diagnostic_runs
            SET status = @status,
                finished_at = @finishedAt,
                structured_result = @structuredResult,
                failure_kind = @failureKind,
                error_message = @errorMessage
          WHERE id = @id AND status = 'running'`
      )
      .run({
        id,
        status: outcome.status,
        finishedAt: outcome.finishedAt,
        structuredResult: outcome.status === 'succeeded' ? JSON.stringify(outcome.result) : null,
        failureKind: outcome.status === 'failed' ? outcome.failureKind : null,
        errorMessage: outcome.status === 'failed' ? outcome.errorMessage : null
      });

    if (Number(changed.changes) === 0) {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'That diagnostic run has already finished and cannot be closed again.',
        { details: `run ${id} is ${existing.status}` }
      );
    }

    const updated = this.findById(id);
    if (!updated) {
      throw new AgentRelayError('INTERNAL', 'The diagnostic run disappeared during update.');
    }
    return updated;
  }
}
