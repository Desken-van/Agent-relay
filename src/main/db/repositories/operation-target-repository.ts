import { AgentRelayError } from '../../../shared/domain/errors';
import { canonicalConfigJson, type OperationTarget } from '../../../shared/domain/operations';
import type { NewOperationTarget, OperationTargetRepository, StoredTargetPatch } from '../../ports';
import type { Clock } from '../../ports';
import type { Db } from '../database';
import { toOperationTarget, type OperationTargetRow } from '../rows';

const COLUMNS = `id, name, environment, adapter_type, config_version, config_json,
                 credential_ref, enabled, created_at, updated_at`;

/**
 * Storage for operational targets.
 *
 * The config is written through {@link canonicalConfigJson} rather than
 * `JSON.stringify` of whatever object arrived, so one configuration has exactly
 * one spelling on disk. `config_version` is stored as its own column as well as
 * inside the JSON: the column is what an index or a future migration can reason
 * about without parsing every row.
 */
export class SqliteOperationTargetRepository implements OperationTargetRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  list(): OperationTarget[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM operation_targets
          ORDER BY environment ASC, name ASC, rowid ASC`
      )
      .all() as OperationTargetRow[];
    return rows.map(toOperationTarget);
  }

  findById(id: string): OperationTarget | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM operation_targets WHERE id = ?`).get(id) as
      | OperationTargetRow
      | undefined;
    return row ? toOperationTarget(row) : null;
  }

  create(target: NewOperationTarget): OperationTarget {
    const now = this.clock.nowIso();

    this.db
      .prepare(
        `INSERT INTO operation_targets
           (id, name, environment, adapter_type, config_version, config_json,
            credential_ref, enabled, created_at, updated_at)
         VALUES (@id, @name, @environment, @adapterType, @configVersion, @configJson,
                 @credentialRef, @enabled, @createdAt, @updatedAt)`
      )
      .run({
        id: target.id,
        name: target.name,
        environment: target.environment,
        adapterType: target.adapterType,
        configVersion: target.config.version,
        configJson: canonicalConfigJson(target.config),
        credentialRef: target.credentialRef,
        enabled: target.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now
      });

    const created = this.findById(target.id);
    if (!created) {
      throw new AgentRelayError('INTERNAL', 'The target disappeared immediately after insert.');
    }
    return created;
  }

  /**
   * Apply a patch.
   *
   * `id` and `adapter_type` are not writable here at all — not merely absent
   * from the patch type. A diagnostic run references a target by id and was
   * produced by one kind of adapter; letting either move would leave an audit
   * row describing something that no longer exists.
   */
  update(id: string, patch: StoredTargetPatch): OperationTarget {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No operational target with id ${id}.`);
    }

    const next: OperationTarget = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.environment === undefined ? {} : { environment: patch.environment }),
      ...(patch.config === undefined ? {} : { config: patch.config }),
      ...(patch.credentialRef === undefined ? {} : { credentialRef: patch.credentialRef }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled })
    };

    this.db
      .prepare(
        `UPDATE operation_targets
            SET name = @name,
                environment = @environment,
                config_version = @configVersion,
                config_json = @configJson,
                credential_ref = @credentialRef,
                enabled = @enabled,
                updated_at = @updatedAt
          WHERE id = @id`
      )
      .run({
        id,
        name: next.name,
        environment: next.environment,
        configVersion: next.config.version,
        configJson: canonicalConfigJson(next.config),
        credentialRef: next.credentialRef,
        enabled: next.enabled ? 1 : 0,
        updatedAt: this.clock.nowIso()
      });

    const updated = this.findById(id);
    if (!updated) {
      throw new AgentRelayError('INTERNAL', 'The target disappeared during update.');
    }
    return updated;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM operation_targets WHERE id = ?').run(id);
  }
}
