import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  PlanCorrection,
  PlanCorrectionStatus,
  SpecificationVersion,
  SpecificationVersionOrigin
} from '../../../shared/domain/plan-correction';
import type { Clock, PlanCorrectionRepository } from '../../ports';
import type { Db } from '../database';

interface CorrectionRow {
  id: string;
  task_id: string;
  source_gate_id: string;
  round: number;
  from_specification_sha256: string;
  accepted_json: string;
  status: PlanCorrectionStatus;
  attempts: number;
  to_specification_sha256: string | null;
  to_version: number | null;
  last_error: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  task_id: string;
  version: number;
  specification_sha256: string;
  specification_json: string;
  origin: SpecificationVersionOrigin;
  source_correction_id: string | null;
  created_at: string;
}

const CORRECTION_COLUMNS = `id, task_id, source_gate_id, round, from_specification_sha256,
                            accepted_json, status, attempts, to_specification_sha256,
                            to_version, last_error, revision, created_at, updated_at`;
const VERSION_COLUMNS = `id, task_id, version, specification_sha256, specification_json,
                         origin, source_correction_id, created_at`;

function toCorrection(row: CorrectionRow): PlanCorrection {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceGateId: row.source_gate_id,
    round: row.round,
    fromSpecificationSha256: row.from_specification_sha256,
    acceptedJson: row.accepted_json,
    status: row.status,
    attempts: row.attempts,
    toSpecificationSha256: row.to_specification_sha256,
    toVersion: row.to_version,
    lastError: row.last_error,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toVersion(row: VersionRow): SpecificationVersion {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    specificationSha256: row.specification_sha256,
    specificationJson: row.specification_json,
    origin: row.origin,
    sourceCorrectionId: row.source_correction_id,
    createdAt: row.created_at
  };
}

export class SqlitePlanCorrectionRepository implements PlanCorrectionRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  listByTask(taskId: string): PlanCorrection[] {
    return (
      this.db
        .prepare(`SELECT ${CORRECTION_COLUMNS} FROM plan_review_corrections WHERE task_id = ? ORDER BY round ASC`)
        .all(taskId) as CorrectionRow[]
    ).map(toCorrection);
  }

  findBySourceGate(gateId: string): PlanCorrection | null {
    const row = this.db
      .prepare(`SELECT ${CORRECTION_COLUMNS} FROM plan_review_corrections WHERE source_gate_id = ?`)
      .get(gateId) as CorrectionRow | undefined;
    return row ? toCorrection(row) : null;
  }

  listVersions(taskId: string): SpecificationVersion[] {
    return (
      this.db
        .prepare(`SELECT ${VERSION_COLUMNS} FROM task_specification_versions WHERE task_id = ? ORDER BY version ASC`)
        .all(taskId) as VersionRow[]
    ).map(toVersion);
  }

  private latestVersion(taskId: string): VersionRow | undefined {
    return this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM task_specification_versions
          WHERE task_id = ? ORDER BY version DESC LIMIT 1`
      )
      .get(taskId) as VersionRow | undefined;
  }

  begin(input: Parameters<PlanCorrectionRepository['begin']>[0]): PlanCorrection {
    // `transaction()` returns nothing, so the outcome leaves through a variable.
    let outcome: PlanCorrection | null = null;
    const apply = this.db.transaction((): void => {
      const now = this.clock.nowIso();
      const existing = this.findBySourceGate(input.sourceGateId);
      if (existing !== null) {
        // A completed correction is history; it is handed back untouched so the
        // caller can see there is nothing left to do rather than run Codex again.
        if (existing.status === 'completed') {
          outcome = existing;
          return;
        }
        this.db
          .prepare(
            `UPDATE plan_review_corrections
                SET status = 'running', attempts = attempts + 1, last_error = NULL,
                    revision = revision + 1, updated_at = @now
              WHERE id = @id`
          )
          .run({ id: existing.id, now });
        outcome = this.findBySourceGate(input.sourceGateId);
        return;
      }

      // The text that was reviewed is recorded before anything changes it. It is
      // skipped only when it already IS the task's newest version: content equal
      // to an OLDER version still gets its own row, because history is linear.
      const latest = this.latestVersion(input.taskId);
      if (latest === undefined || latest.specification_sha256 !== input.fromSpecificationSha256) {
        this.db
          .prepare(
            `INSERT INTO task_specification_versions
               (id, task_id, version, specification_sha256, specification_json, origin,
                source_correction_id, created_at)
             VALUES (@id, @taskId, @version, @sha, @json, 'generated', NULL, @now)`
          )
          .run({
            id: input.versionId,
            taskId: input.taskId,
            version: (latest?.version ?? 0) + 1,
            sha: input.fromSpecificationSha256,
            json: input.currentSpecificationJson,
            now
          });
      }

      const round =
        (this.db
          .prepare('SELECT COUNT(*) AS n FROM plan_review_corrections WHERE task_id = ?')
          .get(input.taskId) as { n: number }).n + 1;
      this.db
        .prepare(
          `INSERT INTO plan_review_corrections
             (id, task_id, source_gate_id, round, from_specification_sha256, accepted_json,
              status, attempts, to_specification_sha256, to_version, last_error, revision,
              created_at, updated_at)
           VALUES (@id, @taskId, @sourceGateId, @round, @from, @accepted,
                   'running', 1, NULL, NULL, NULL, 0, @now, @now)`
        )
        .run({
          id: input.id,
          taskId: input.taskId,
          sourceGateId: input.sourceGateId,
          round,
          from: input.fromSpecificationSha256,
          accepted: input.acceptedJson,
          now
        });
      outcome = this.findBySourceGate(input.sourceGateId);
    });
    apply();
    const opened = outcome as PlanCorrection | null;
    if (opened === null) {
      throw new AgentRelayError('INTERNAL', 'The plan correction could not be read back after it was opened.');
    }
    return opened;
  }

  fail(id: string, message: string): PlanCorrection {
    this.db
      .prepare(
        `UPDATE plan_review_corrections
            SET status = 'failed', last_error = @message, revision = revision + 1, updated_at = @now
          WHERE id = @id AND status = 'running'`
      )
      .run({ id, message, now: this.clock.nowIso() });
    const row = this.db
      .prepare(`SELECT ${CORRECTION_COLUMNS} FROM plan_review_corrections WHERE id = ?`)
      .get(id) as CorrectionRow | undefined;
    if (row === undefined) throw new AgentRelayError('NOT_FOUND', `No plan correction with id ${id}.`);
    return toCorrection(row);
  }

  complete(
    input: Parameters<PlanCorrectionRepository['complete']>[0]
  ): { correction: PlanCorrection; version: SpecificationVersion } {
    let outcome: { correction: PlanCorrection; version: SpecificationVersion } | null = null;
    const apply = this.db.transaction((): void => {
      const now = this.clock.nowIso();
      const row = this.db
        .prepare(`SELECT ${CORRECTION_COLUMNS} FROM plan_review_corrections WHERE id = ?`)
        .get(input.correctionId) as CorrectionRow | undefined;
      if (row === undefined) {
        throw new AgentRelayError('NOT_FOUND', `No plan correction with id ${input.correctionId}.`);
      }
      if (row.status !== 'running') {
        throw new AgentRelayError(
          'INVALID_TRANSITION',
          `A correction that is "${row.status}" cannot be completed.`
        );
      }

      // Compare-and-swap on the specification text itself: the task has no
      // revision of its own for this, and the text is exactly what the revision
      // was computed from. Anything that changed it meanwhile (a regeneration, a
      // second window) makes this revision describe a document that is gone.
      const swapped = this.db
        .prepare(
          `UPDATE tasks
              SET specification_json = @next, specification_approved_at = NULL, updated_at = @now
            WHERE id = @taskId AND specification_json = @expected`
        )
        .run({
          taskId: row.task_id,
          next: input.newSpecificationJson,
          expected: input.expectedSpecificationJson,
          now
        });
      if (Number(swapped.changes) !== 1) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The specification changed while the correction was running, so the revision was not applied.',
          { remediation: 'Reload the plan review and start the correction again from the current specification.' }
        );
      }

      const latest = this.latestVersion(row.task_id);
      const version = (latest?.version ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO task_specification_versions
             (id, task_id, version, specification_sha256, specification_json, origin,
              source_correction_id, created_at)
           VALUES (@id, @taskId, @version, @sha, @json, 'plan_correction', @correctionId, @now)`
        )
        .run({
          id: input.versionId,
          taskId: row.task_id,
          version,
          sha: input.newSpecificationSha256,
          json: input.newSpecificationJson,
          correctionId: row.id,
          now
        });
      this.db
        .prepare(
          `UPDATE plan_review_corrections
              SET status = 'completed', to_specification_sha256 = @sha, to_version = @version,
                  last_error = NULL, revision = revision + 1, updated_at = @now
            WHERE id = @id`
        )
        .run({ id: row.id, sha: input.newSpecificationSha256, version, now });

      const updated = this.db
        .prepare(`SELECT ${CORRECTION_COLUMNS} FROM plan_review_corrections WHERE id = ?`)
        .get(row.id) as CorrectionRow;
      const created = this.db
        .prepare(`SELECT ${VERSION_COLUMNS} FROM task_specification_versions WHERE id = ?`)
        .get(input.versionId) as VersionRow;
      outcome = { correction: toCorrection(updated), version: toVersion(created) };
    });
    apply();
    const completed = outcome as { correction: PlanCorrection; version: SpecificationVersion } | null;
    if (completed === null) {
      throw new AgentRelayError('INTERNAL', 'The plan correction could not be read back after it was completed.');
    }
    return completed;
  }
}
