/**
 * The Operations tables, against a real SQLite database.
 *
 * Migration 3 is the first one added since the registry existed, so these cover
 * both a fresh database and one that already has migrations 1 and 2 applied —
 * the upgrade path an existing user actually takes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { SqliteOperationDiagnosticRepository } from '../../src/main/db/repositories/operation-diagnostic-repository';
import { SqliteOperationTargetRepository } from '../../src/main/db/repositories/operation-target-repository';
import {
  toOperationDiagnosticRun,
  toOperationTarget,
  type OperationDiagnosticRunRow,
  type OperationTargetRow
} from '../../src/main/db/rows';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import { FixedClock } from '../../src/main/infra/clock';
import {
  OPERATION_CONFIG_VERSION,
  type OperationTargetConfig
} from '../../src/shared/domain/operations';
import {
  DIAGNOSTIC_RESULT_VERSION,
  type DiagnosticResult
} from '../../src/shared/domain/operations-diagnostics';
import type { NewOperationTarget } from '../../src/main/ports';

const config = (databasePath = 'C:\\data\\reports.sqlite'): OperationTargetConfig => ({
  version: OPERATION_CONFIG_VERSION,
  adapterType: 'local_sqlite',
  databasePath
});

const target = (overrides: Partial<NewOperationTarget> = {}): NewOperationTarget => ({
  id: 'target-1',
  name: 'Reporting snapshot',
  environment: 'local',
  adapterType: 'local_sqlite',
  config: config(),
  credentialRef: null,
  enabled: true,
  ...overrides
});

const result: DiagnosticResult = {
  version: DIAGNOSTIC_RESULT_VERSION,
  probeId: 'connection_health',
  targetId: 'target-1',
  environment: 'local',
  adapterType: 'local_sqlite',
  opened: true,
  readOnly: true,
  queryOnly: true,
  sqliteVersion: '3.50.0',
  fileExists: true,
  fileReadable: true,
  fileSizeBytes: 4096,
  fileModifiedAt: '2026-09-03T10:00:00.000Z',
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:00:00.010Z',
  durationMs: 10,
  warnings: []
};

const summaryResultFor = (targetId: string): DiagnosticResult => ({
  version: DIAGNOSTIC_RESULT_VERSION,
  probeId: 'schema_summary',
  targetId,
  environment: 'local',
  adapterType: 'local_sqlite',
  tables: [],
  omittedTables: 0,
  omittedColumns: 0,
  truncated: false,
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:00:00.010Z',
  durationMs: 10,
  warnings: []
});

let db: Db;
let clock: FixedClock;
let targets: SqliteOperationTargetRepository;
let diagnostics: SqliteOperationDiagnosticRepository;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  clock = new FixedClock();
  targets = new SqliteOperationTargetRepository(db, clock);
  diagnostics = new SqliteOperationDiagnosticRepository(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe('migration', () => {
  it('creates the Operations tables on a fresh database', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const found = names.map((row) => row.name);

    expect(found).toContain('operation_targets');
    expect(found).toContain('operation_diagnostic_runs');
    // The development workflow's tables are untouched.
    expect(found).toContain('tasks');
    expect(found).toContain('runs');
  });

  it('is forward-only: earlier migrations are not rewritten', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(MIGRATIONS[0]?.name).toBe('initial-schema');
    expect(MIGRATIONS[1]?.name).toBe('task-model-selection');
    expect(MIGRATIONS[2]?.name).toBe('operations-targets');
  });

  it('upgrades a database that already has migrations 1 and 2', () => {
    // The path an existing installation takes: apply the first two only, close,
    // reopen, and let the third arrive on its own.
    const directory = mkdtempSync(join(tmpdir(), 'agent-relay-upgrade-'));
    const file = join(directory, 'agent-relay.sqlite');

    try {
      const older = createSqliteDatabase(file);
      older.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 2)) {
        migration.up(older);
        older
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
      }
      older
        .prepare(
          `INSERT INTO projects (id, name, local_path, project_type, default_branch,
                                 github_owner, github_repo, github_visibility, created_at, updated_at)
           VALUES ('p1','existing','C:\\repo','existing','main',NULL,NULL,'private','t','t')`
        )
        .run();
      older.close();

      const upgraded = openDatabase({ file });
      try {
        const applied = upgraded
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as { version: number }[];
        expect(applied.map((row) => row.version)).toEqual([1, 2, 3]);

        // The pre-existing row survived the upgrade untouched.
        const project = upgraded.prepare('SELECT name FROM projects WHERE id = ?').get('p1');
        expect(project).toEqual({ name: 'existing' });

        // And the new tables are usable straight away.
        new SqliteOperationTargetRepository(upgraded, clock).create(target());
        expect(new SqliteOperationTargetRepository(upgraded, clock).list()).toHaveLength(1);
      } finally {
        closeDatabase(upgraded);
      }

      // Running again applies nothing.
      const again = openDatabase({ file });
      try {
        expect(runMigrations(again)).toBe(0);
      } finally {
        closeDatabase(again);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the target repository', () => {
  it('round-trips a target', () => {
    const created = targets.create(target());

    expect(created).toMatchObject({
      id: 'target-1',
      name: 'Reporting snapshot',
      environment: 'local',
      adapterType: 'local_sqlite',
      credentialRef: null,
      enabled: true
    });
    expect(created.config).toEqual(config());
    expect(created.createdAt).toBe(clock.nowIso());
    expect(targets.findById('target-1')).toEqual(created);
    expect(targets.list()).toEqual([created]);
  });

  it('returns null rather than throwing for an unknown id', () => {
    expect(targets.findById('nope')).toBeNull();
  });

  it('updates the mutable fields and leaves identity alone', () => {
    const created = targets.create(target());
    clock.advance(60_000);

    const updated = targets.update(created.id, {
      name: 'Renamed',
      enabled: false,
      config: config('/var/lib/other.sqlite')
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.config.databasePath).toBe('/var/lib/other.sqlite');
    expect(updated.id).toBe(created.id);
    expect(updated.adapterType).toBe('local_sqlite');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it('stores the config in its canonical spelling', () => {
    targets.create(target());
    const row = db.prepare('SELECT config_json, config_version FROM operation_targets').get();
    expect(row).toEqual({
      config_json: '{"version":1,"adapterType":"local_sqlite","databasePath":"C:\\\\data\\\\reports.sqlite"}',
      config_version: 1
    });
  });

  it('refuses two targets with the same name in one environment', () => {
    targets.create(target());
    expect(() => targets.create(target({ id: 'target-2' }))).toThrow();

    // The same name in a different environment is a different thing.
    expect(() => targets.create(target({ id: 'target-3', environment: 'staging' }))).not.toThrow();
  });

  it('refuses an adapter type the schema does not know', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_targets
             (id, name, environment, adapter_type, config_version, config_json,
              credential_ref, enabled, created_at, updated_at)
           VALUES ('x','x','local','postgres',1,'{}',NULL,1,'t','t')`
        )
        .run()
    ).toThrow();
  });

  it('refuses an environment the schema does not know', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_targets
             (id, name, environment, adapter_type, config_version, config_json,
              credential_ref, enabled, created_at, updated_at)
           VALUES ('x','x','prod','local_sqlite',1,'{}',NULL,1,'t','t')`
        )
        .run()
    ).toThrow();
  });

  it('refuses a credential reference on a local SQLite target, at the database level too', () => {
    // Not only in the domain schema: a hand-edited row cannot get one in either.
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_targets
             (id, name, environment, adapter_type, config_version, config_json,
              credential_ref, enabled, created_at, updated_at)
           VALUES ('x','x','local','local_sqlite',1,'{}','vault:secret',1,'t','t')`
        )
        .run()
    ).toThrow();
  });

  it('stores no credential value anywhere in the row', () => {
    targets.create(target());
    const raw = JSON.stringify(
      db.prepare('SELECT * FROM operation_targets').all()
    );

    // There is no column for one, so this is a statement about the shape rather
    // than about redaction: nothing password-, token- or URL-shaped can be here.
    expect(raw).not.toMatch(/password|secret|token|apikey|connection_string/i);
    expect(raw).not.toMatch(/:\/\/[^/"]*:[^/"]*@/);
  });

  it('fails closed when a row carries a config this build cannot read', () => {
    targets.create(target());
    db.prepare("UPDATE operation_targets SET config_json = '{\"version\":9,\"adapterType\":\"local_sqlite\",\"databasePath\":\"/x\"}'").run();

    expect(() => targets.findById('target-1')).toThrow();
  });
});

describe('the diagnostic repository', () => {
  beforeEach(() => {
    targets.create(target());
  });

  it('opens a run as running, with no result', () => {
    const run = diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });

    expect(run).toMatchObject({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      status: 'running',
      finishedAt: null,
      result: null,
      failureKind: null,
      errorMessage: null,
      version: 1
    });
  });

  it('closes a run as succeeded, carrying the probe result', () => {
    diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });
    clock.advance(1_000);

    const finished = diagnostics.finish('diag-1', {
      status: 'succeeded',
      finishedAt: clock.nowIso(),
      result
    });

    expect(finished.status).toBe('succeeded');
    expect(finished.finishedAt).toBe(clock.nowIso());
    expect(finished.result).toEqual(result);
    expect(finished.failureKind).toBeNull();
  });

  it('closes a run as failed, carrying the kind and no result', () => {
    diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'schema_summary',
      startedAt: clock.nowIso()
    });

    const finished = diagnostics.finish('diag-1', {
      status: 'failed',
      finishedAt: clock.nowIso(),
      failureKind: 'timeout',
      errorMessage: 'The probe did not finish in time.'
    });

    expect(finished.status).toBe('failed');
    expect(finished.result).toBeNull();
    expect(finished.failureKind).toBe('timeout');
  });

  it('refuses to record a success with nothing to show for it', () => {
    diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });

    expect(() =>
      diagnostics.finish('diag-1', { status: 'succeeded', finishedAt: clock.nowIso() } as never)
    ).toThrow(/must carry the result/);
  });

  it('will not let a row claim to be finished without an end time', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_diagnostic_runs
             (id, target_id, probe_id, status, started_at, finished_at,
              structured_result, failure_kind, error_message, version)
           VALUES ('bad','target-1','connection_health','failed','t',NULL,NULL,'error','x',1)`
        )
        .run()
    ).toThrow();
  });

  it('will not let a failed row carry a result', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_diagnostic_runs
             (id, target_id, probe_id, status, started_at, finished_at,
              structured_result, failure_kind, error_message, version)
           VALUES ('bad','target-1','connection_health','failed','t','t','{}','error','x',1)`
        )
        .run()
    ).toThrow();
  });

  it('refuses a probe id outside the enum', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO operation_diagnostic_runs
             (id, target_id, probe_id, status, started_at, finished_at,
              structured_result, failure_kind, error_message, version)
           VALUES ('bad','target-1','SELECT * FROM users','running','t',NULL,NULL,NULL,NULL,1)`
        )
        .run()
    ).toThrow();
  });

  it('refuses a run for a target that does not exist', () => {
    expect(() =>
      diagnostics.start({
        id: 'diag-x',
        targetId: 'no-such-target',
        probeId: 'connection_health',
        startedAt: clock.nowIso()
      })
    ).toThrow();
  });

  it('finds running runs, globally and per target', () => {
    targets.create(target({ id: 'target-2', name: 'Second' }));
    diagnostics.start({ id: 'a', targetId: 'target-1', probeId: 'connection_health', startedAt: clock.nowIso() });
    clock.advance(10);
    diagnostics.start({ id: 'b', targetId: 'target-2', probeId: 'schema_summary', startedAt: clock.nowIso() });

    expect(diagnostics.listRunning().map((run) => run.id)).toEqual(['a', 'b']);
    expect(diagnostics.findRunningForTarget('target-1')?.id).toBe('a');

    diagnostics.finish('a', { status: 'failed', finishedAt: clock.nowIso(), failureKind: 'error', errorMessage: 'the probe failed' });
    expect(diagnostics.listRunning().map((run) => run.id)).toEqual(['b']);
    expect(diagnostics.findRunningForTarget('target-1')).toBeNull();
  });

  it('lists history newest first, and counts it', () => {
    for (const id of ['a', 'b', 'c']) {
      diagnostics.start({ id, targetId: 'target-1', probeId: 'connection_health', startedAt: clock.nowIso() });
      diagnostics.finish(id, { status: 'failed', finishedAt: clock.nowIso(), failureKind: 'error', errorMessage: 'the probe failed' });
      clock.advance(1_000);
    }

    expect(diagnostics.listByTarget('target-1').map((run) => run.id)).toEqual(['c', 'b', 'a']);
    expect(diagnostics.listByTarget('target-1', 2).map((run) => run.id)).toEqual(['c', 'b']);
    expect(diagnostics.countByTarget('target-1')).toBe(3);
    expect(diagnostics.countByTarget('target-2')).toBe(0);
  });

  it('keeps the audit trail when a delete is attempted', () => {
    // The foreign key is RESTRICT, so history is never quietly erased. The
    // registry refuses the delete first and explains why; this is the floor
    // underneath that.
    diagnostics.start({ id: 'a', targetId: 'target-1', probeId: 'connection_health', startedAt: clock.nowIso() });
    diagnostics.finish('a', { status: 'failed', finishedAt: clock.nowIso(), failureKind: 'error', errorMessage: 'the probe failed' });

    expect(() => targets.delete('target-1')).toThrow();
    expect(targets.findById('target-1')).not.toBeNull();
    expect(diagnostics.countByTarget('target-1')).toBe(1);
  });

  it('allows a target with no history to be removed', () => {
    targets.delete('target-1');
    expect(targets.findById('target-1')).toBeNull();
  });

  it('survives close and reopen on disk', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-relay-ops-'));
    const file = join(directory, 'agent-relay.sqlite');

    try {
      const first = openDatabase({ file });
      const firstTargets = new SqliteOperationTargetRepository(first, clock);
      const firstDiagnostics = new SqliteOperationDiagnosticRepository(first);
      firstTargets.create(target());
      // The probe id on the run and the probe id inside the result have to
      // agree — the repository refuses the pair otherwise, and a fixture that
      // ignored that would be exercising something the code does not allow.
      firstDiagnostics.start({
        id: 'diag-1',
        targetId: 'target-1',
        probeId: 'connection_health',
        startedAt: clock.nowIso()
      });
      firstDiagnostics.finish('diag-1', {
        status: 'succeeded',
        finishedAt: clock.nowIso(),
        result
      });
      closeDatabase(first);

      const second = openDatabase({ file });
      try {
        const reread = new SqliteOperationTargetRepository(second, clock).findById('target-1');
        expect(reread?.config).toEqual(config());

        const history = new SqliteOperationDiagnosticRepository(second).listByTarget('target-1');
        expect(history).toHaveLength(1);
        expect(history[0]?.probeId).toBe('connection_health');
        expect(history[0]?.result).toEqual(result);
      } finally {
        closeDatabase(second);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A run is closed exactly once                                                */
/* -------------------------------------------------------------------------- */

describe('closing a diagnostic run', () => {
  beforeEach(() => {
    targets.create(target());
    diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });
  });

  it('refuses a second close, and leaves the first untouched', () => {
    const closed = diagnostics.finish('diag-1', {
      status: 'succeeded',
      finishedAt: clock.nowIso(),
      result
    });
    clock.advance(60_000);

    // A retry, a race, a caller that lost track — none of them may rewrite a
    // terminal row.
    expect(() =>
      diagnostics.finish('diag-1', {
        status: 'failed',
        finishedAt: clock.nowIso(),
        failureKind: 'timeout',
        errorMessage: 'a late timeout'
      })
    ).toThrow(/already finished/);

    expect(diagnostics.findById('diag-1')).toEqual(closed);
  });

  it('will not turn a recorded failure into a success', () => {
    const closed = diagnostics.finish('diag-1', {
      status: 'failed',
      finishedAt: clock.nowIso(),
      failureKind: 'error',
      errorMessage: 'the file was missing'
    });

    expect(() =>
      diagnostics.finish('diag-1', { status: 'succeeded', finishedAt: clock.nowIso(), result })
    ).toThrow(/already finished/);

    const after = diagnostics.findById('diag-1');
    expect(after).toEqual(closed);
    expect(after?.result).toBeNull();
    expect(after?.errorMessage).toBe('the file was missing');
  });

  it('leaves every stored field byte-for-byte as it was', () => {
    diagnostics.finish('diag-1', { status: 'succeeded', finishedAt: clock.nowIso(), result });
    const before = db.prepare('SELECT * FROM operation_diagnostic_runs WHERE id = ?').get('diag-1');

    expect(() =>
      diagnostics.finish('diag-1', {
        status: 'failed',
        finishedAt: '2027-01-01T00:00:00.000Z',
        failureKind: 'cancelled',
        errorMessage: 'overwritten'
      })
    ).toThrow();

    expect(db.prepare('SELECT * FROM operation_diagnostic_runs WHERE id = ?').get('diag-1')).toEqual(
      before
    );
  });

  it('refuses a result that names a different target', () => {
    expect(() =>
      diagnostics.finish('diag-1', {
        status: 'succeeded',
        finishedAt: clock.nowIso(),
        result: { ...result, targetId: 'some-other-target' }
      })
    ).toThrow(/different target/);

    // Still running: nothing was written, so the run can still be closed properly.
    expect(diagnostics.findById('diag-1')?.status).toBe('running');
  });

  it('refuses a result that names a different probe', () => {
    expect(() =>
      diagnostics.finish('diag-1', {
        status: 'succeeded',
        finishedAt: clock.nowIso(),
        result: { ...summaryResultFor('target-1') }
      })
    ).toThrow(/different probe/);

    expect(diagnostics.findById('diag-1')?.status).toBe('running');
  });

  it('reports an unknown run rather than silently doing nothing', () => {
    expect(() =>
      diagnostics.finish('no-such-run', {
        status: 'failed',
        finishedAt: clock.nowIso(),
        failureKind: 'error',
        errorMessage: 'never stored'
      })
    ).toThrow(/No diagnostic run/);
  });
});

/* -------------------------------------------------------------------------- */
/* One running diagnostic per target, enforced by the database                 */
/* -------------------------------------------------------------------------- */

describe('concurrent diagnostics', () => {
  beforeEach(() => {
    targets.create(target());
    targets.create(target({ id: 'target-2', name: 'Second' }));
  });

  it('refuses a second running run for the same target', () => {
    diagnostics.start({
      id: 'a',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });

    // The service checks first and produces a readable message; this is the
    // invariant underneath, which holds for a writer that never asked.
    expect(() =>
      diagnostics.start({
        id: 'b',
        targetId: 'target-1',
        probeId: 'schema_summary',
        startedAt: clock.nowIso()
      })
    ).toThrow();

    expect(diagnostics.listByTarget('target-1')).toHaveLength(1);
  });

  it('allows a second running run against a different target', () => {
    diagnostics.start({
      id: 'a',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });
    expect(() =>
      diagnostics.start({
        id: 'b',
        targetId: 'target-2',
        probeId: 'connection_health',
        startedAt: clock.nowIso()
      })
    ).not.toThrow();

    expect(diagnostics.listRunning().map((run) => run.id)).toEqual(['a', 'b']);
  });

  it('allows a new run once the previous one has finished', () => {
    diagnostics.start({
      id: 'a',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });
    diagnostics.finish('a', { status: 'failed', finishedAt: clock.nowIso(), failureKind: 'error', errorMessage: 'the probe failed' });
    clock.advance(1_000);

    // The index is partial — only `running` rows take part — so history never
    // blocks the next attempt.
    expect(() =>
      diagnostics.start({
        id: 'b',
        targetId: 'target-1',
        probeId: 'connection_health',
        startedAt: clock.nowIso()
      })
    ).not.toThrow();
    expect(diagnostics.listByTarget('target-1')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Row mappers fail closed                                                     */
/* -------------------------------------------------------------------------- */

describe('reading a row this build cannot vouch for', () => {
  const targetRow = (overrides: Partial<OperationTargetRow> = {}): OperationTargetRow => ({
    id: 'target-1',
    name: 'Reporting snapshot',
    environment: 'local',
    adapter_type: 'local_sqlite',
    config_version: 1,
    config_json: '{"version":1,"adapterType":"local_sqlite","databasePath":"C:\\\\data\\\\r.sqlite"}',
    credential_ref: null,
    enabled: 1,
    created_at: 't',
    updated_at: 't',
    ...overrides
  });

  const runRow = (overrides: Partial<OperationDiagnosticRunRow> = {}): OperationDiagnosticRunRow => ({
    id: 'diag-1',
    target_id: 'target-1',
    probe_id: 'connection_health',
    status: 'running',
    started_at: 't',
    finished_at: null,
    structured_result: null,
    failure_kind: null,
    error_message: null,
    version: 1,
    ...overrides
  });

  it('maps a consistent target row', () => {
    expect(toOperationTarget(targetRow())).toMatchObject({
      id: 'target-1',
      environment: 'local',
      adapterType: 'local_sqlite'
    });
  });

  it('refuses a target row whose column and JSON disagree about the version', () => {
    // The constraint makes this unreachable through SQL — which is exactly why
    // the mapper is tested directly. A restored file, a hand edit or a future
    // schema change must not be able to slip past the read boundary.
    expect(() => toOperationTarget(targetRow({ config_version: 2 }))).toThrow(
      /disagrees with itself about its configuration version/
    );
  });

  it('refuses a target row whose column and JSON disagree about the adapter', () => {
    expect(() =>
      toOperationTarget(
        targetRow({
          config_json: '{"version":1,"adapterType":"postgres","host":"db"}'
        })
      )
    ).toThrow();
  });

  it('refuses a target row naming an unknown environment', () => {
    expect(() => toOperationTarget(targetRow({ environment: 'prod' }))).toThrow(
      /unknown environment/
    );
  });

  it('refuses a target row whose config version this build does not know', () => {
    expect(() =>
      toOperationTarget(
        targetRow({
          config_version: 9,
          config_json: '{"version":9,"adapterType":"local_sqlite","databasePath":"/x"}'
        })
      )
    ).toThrow();
  });

  it('maps a consistent diagnostic row', () => {
    expect(toOperationDiagnosticRun(runRow())).toMatchObject({
      id: 'diag-1',
      probeId: 'connection_health',
      status: 'running',
      version: 1
    });
  });

  it('refuses a diagnostic row written in another version', () => {
    expect(() => toOperationDiagnosticRun(runRow({ version: 2 }))).toThrow(
      /shape this build cannot read/
    );
    expect(() => toOperationDiagnosticRun(runRow({ version: 0 }))).toThrow();
  });

  it('refuses a diagnostic row naming an unknown probe, status or failure kind', () => {
    expect(() => toOperationDiagnosticRun(runRow({ probe_id: 'row_dump' }))).toThrow(
      /unknown probe/
    );
    expect(() => toOperationDiagnosticRun(runRow({ status: 'pending' }))).toThrow(/unknown status/);
    expect(() =>
      toOperationDiagnosticRun(
        runRow({ status: 'failed', finished_at: 't', failure_kind: 'exploded' })
      )
    ).toThrow(/unknown failure kind/);
  });
});

/* -------------------------------------------------------------------------- */
/* A durable run has exactly three permitted shapes                            */
/* -------------------------------------------------------------------------- */

describe('the three shapes a stored run may take', () => {
  /** Insert a row directly, bypassing the repository, to test the table itself. */
  const insert = (row: Partial<OperationDiagnosticRunRow>) =>
    db
      .prepare(
        `INSERT INTO operation_diagnostic_runs
           (id, target_id, probe_id, status, started_at, finished_at,
            structured_result, failure_kind, error_message, version)
         VALUES (@id, @target_id, @probe_id, @status, @started_at, @finished_at,
                 @structured_result, @failure_kind, @error_message, @version)`
      )
      .run({
        id: 'r1',
        target_id: 'target-1',
        probe_id: 'connection_health',
        status: 'running',
        started_at: 't0',
        finished_at: null,
        structured_result: null,
        failure_kind: null,
        error_message: null,
        version: 1,
        ...row
      });

  beforeEach(() => {
    targets.create(target());
  });

  it('accepts each of the three, and nothing between them', () => {
    insert({ id: 'a', status: 'running' });
    insert({
      id: 'b',
      status: 'succeeded',
      finished_at: 't1',
      structured_result: JSON.stringify(result)
    });
    insert({
      id: 'c',
      status: 'failed',
      finished_at: 't1',
      failure_kind: 'timeout',
      error_message: 'took too long'
    });

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM operation_diagnostic_runs').get() as { n: number }).n
    ).toBe(3);
  });

  /** Every combination the table must refuse, and why it is wrong. */
  const forbidden: [string, Partial<OperationDiagnosticRunRow>][] = [
    ['running with an end time', { finished_at: 't1' }],
    ['running with a result', { structured_result: '{}' }],
    ['running with a failure kind', { failure_kind: 'error' }],
    ['running with an error message', { error_message: 'why' }],
    ['succeeded with no end time', { status: 'succeeded', structured_result: '{}' }],
    ['succeeded with no result', { status: 'succeeded', finished_at: 't1' }],
    [
      'succeeded with a failure kind',
      { status: 'succeeded', finished_at: 't1', structured_result: '{}', failure_kind: 'error' }
    ],
    [
      'succeeded with an error message',
      { status: 'succeeded', finished_at: 't1', structured_result: '{}', error_message: 'why' }
    ],
    [
      'failed with no end time',
      { status: 'failed', failure_kind: 'error', error_message: 'why' }
    ],
    ['failed with no failure kind', { status: 'failed', finished_at: 't1', error_message: 'why' }],
    ['failed with no message', { status: 'failed', finished_at: 't1', failure_kind: 'error' }],
    [
      'failed with an empty message',
      { status: 'failed', finished_at: 't1', failure_kind: 'error', error_message: '' }
    ],
    [
      'failed with a whitespace-only message',
      { status: 'failed', finished_at: 't1', failure_kind: 'error', error_message: '   ' }
    ],
    [
      'failed carrying a result',
      {
        status: 'failed',
        finished_at: 't1',
        failure_kind: 'error',
        error_message: 'why',
        structured_result: '{}'
      }
    ]
  ];

  for (const [what, row] of forbidden) {
    it(`refuses ${what}`, () => {
      expect(() => insert(row)).toThrow();
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM operation_diagnostic_runs').get() as { n: number }).n
      ).toBe(0);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The runtime boundary, for callers that got past the type                    */
/* -------------------------------------------------------------------------- */

describe('closing a run with an outcome the union forbids', () => {
  beforeEach(() => {
    targets.create(target());
    diagnostics.start({
      id: 'diag-1',
      targetId: 'target-1',
      probeId: 'connection_health',
      startedAt: clock.nowIso()
    });
  });

  /** Each of these needs `as never` to be written at all — which is the point. */
  const rejected: [string, unknown, RegExp][] = [
    [
      'a success with no result',
      { status: 'succeeded', finishedAt: 't1' },
      /must carry the result/
    ],
    [
      'a success carrying a failure kind',
      { status: 'succeeded', finishedAt: 't1', result, failureKind: 'error' },
      /may not carry a failure kind/
    ],
    [
      'a success carrying an error message',
      { status: 'succeeded', finishedAt: 't1', result, errorMessage: 'why' },
      /may not carry a failure kind or an error message/
    ],
    [
      'a failure carrying a result',
      { status: 'failed', finishedAt: 't1', failureKind: 'error', errorMessage: 'why', result },
      /may not carry a result/
    ],
    [
      'a failure that does not say how',
      { status: 'failed', finishedAt: 't1', errorMessage: 'why' },
      /must say how it failed/
    ],
    [
      'a failure with no message',
      { status: 'failed', finishedAt: 't1', failureKind: 'error' },
      /non-empty message/
    ],
    [
      'a failure with a blank message',
      { status: 'failed', finishedAt: 't1', failureKind: 'error', errorMessage: '   ' },
      /non-empty message/
    ],
    [
      'a status that is not terminal',
      { status: 'running', finishedAt: 't1' },
      /succeeded or failed/
    ]
  ];

  for (const [what, outcome, message] of rejected) {
    it(`refuses ${what}, before the UPDATE`, () => {
      expect(() => diagnostics.finish('diag-1', outcome as never)).toThrow(message);
      // Nothing was written: the run is still open and still closeable.
      expect(diagnostics.findById('diag-1')?.status).toBe('running');
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The mapper rejection matrix                                                 */
/* -------------------------------------------------------------------------- */

describe('mapping a diagnostic row', () => {
  const row = (overrides: Partial<OperationDiagnosticRunRow> = {}): OperationDiagnosticRunRow => ({
    id: 'diag-1',
    target_id: 'target-1',
    probe_id: 'connection_health',
    status: 'running',
    started_at: 't0',
    finished_at: null,
    structured_result: null,
    failure_kind: null,
    error_message: null,
    version: 1,
    ...overrides
  });

  const succeeded = (overrides: Partial<OperationDiagnosticRunRow> = {}) =>
    row({
      status: 'succeeded',
      finished_at: 't1',
      structured_result: JSON.stringify(result),
      ...overrides
    });

  const failed = (overrides: Partial<OperationDiagnosticRunRow> = {}) =>
    row({
      status: 'failed',
      finished_at: 't1',
      failure_kind: 'timeout',
      error_message: 'took too long',
      ...overrides
    });

  it('maps one valid row of each status', () => {
    expect(toOperationDiagnosticRun(row())).toMatchObject({ status: 'running', result: null });
    expect(toOperationDiagnosticRun(succeeded())).toMatchObject({
      status: 'succeeded',
      failureKind: null,
      errorMessage: null
    });
    expect(toOperationDiagnosticRun(succeeded()).result).toEqual(result);
    expect(toOperationDiagnosticRun(failed())).toMatchObject({
      status: 'failed',
      result: null,
      failureKind: 'timeout',
      errorMessage: 'took too long'
    });
  });

  /**
   * Unreachable through SQL — which is exactly why the mapper is tested
   * directly. A restored file, a hand edit or a future schema change must not be
   * able to hand a half-plausible object to the rest of the application.
   */
  const rejected: [string, OperationDiagnosticRunRow, RegExp][] = [
    ['running with a failure kind', row({ failure_kind: 'error' }), /already has a failure kind/],
    ['running with an error message', row({ error_message: 'why' }), /already has an error message/],
    [
      'running with a result',
      row({ structured_result: JSON.stringify(result) }),
      /already has a result/
    ],
    ['running with an end time', row({ finished_at: 't1' }), /has an end time/],
    [
      'succeeded with no result',
      row({ status: 'succeeded', finished_at: 't1' }),
      /succeeded but carries no result/
    ],
    ['succeeded with a failure kind', succeeded({ failure_kind: 'error' }), /carries a failure kind/],
    [
      'succeeded with an error message',
      succeeded({ error_message: 'why' }),
      /carries an error message/
    ],
    ['failed with no failure kind', failed({ failure_kind: null }), /does not say how/],
    ['failed with no error message', failed({ error_message: null }), /carries no usable message/],
    ['failed with an empty error message', failed({ error_message: '' }), /carries no usable message/],
    [
      'failed with a whitespace-only error message',
      failed({ error_message: '   ' }),
      /carries no usable message/
    ],
    [
      'failed carrying a result',
      failed({ structured_result: JSON.stringify(result) }),
      /failed but carries a result/
    ],
    ['finished with no end time', succeeded({ finished_at: null }), /has no end time/],
    [
      'a result for a different target',
      succeeded({ structured_result: JSON.stringify({ ...result, targetId: 'elsewhere' }) }),
      /different target than the run holding it/
    ],
    [
      'a result for a different probe',
      succeeded({
        probe_id: 'schema_summary',
        structured_result: JSON.stringify(result)
      }),
      /different probe than the run holding it/
    ]
  ];

  for (const [what, candidate, message] of rejected) {
    it(`refuses ${what}`, () => {
      expect(() => toOperationDiagnosticRun(candidate)).toThrow(message);
    });
  }
});
