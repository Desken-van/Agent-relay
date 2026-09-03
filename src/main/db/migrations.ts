/**
 * Schema migrations.
 *
 * Migrations are forward-only and idempotent at the version level: each one runs
 * exactly once, inside a transaction, and is recorded in `schema_migrations`.
 * Adding a column later means appending a new entry here — never editing an
 * existing one, because a user's database may already have applied it.
 */

import type { SqliteDatabase } from './sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: SqliteDatabase): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL,
          local_path         TEXT NOT NULL UNIQUE,
          project_type       TEXT NOT NULL CHECK (project_type IN ('existing','new')),
          default_branch     TEXT NOT NULL,
          github_owner       TEXT,
          github_repo        TEXT,
          github_visibility  TEXT NOT NULL CHECK (github_visibility IN ('private','public')),
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id                        TEXT PRIMARY KEY,
          project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title                     TEXT NOT NULL,
          original_request          TEXT NOT NULL,
          status                    TEXT NOT NULL,
          current_round             INTEGER NOT NULL DEFAULT 0,
          max_rounds                INTEGER NOT NULL DEFAULT 3,
          codex_thread_id           TEXT,
          claude_session_id         TEXT,
          worktree_path             TEXT,
          branch_name               TEXT,
          base_branch               TEXT,
          specification_json        TEXT,
          specification_approved_at TEXT,
          last_review_json          TEXT,
          last_error                TEXT,
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        );
        CREATE INDEX idx_tasks_project ON tasks(project_id, created_at DESC);

        CREATE TABLE runs (
          id                TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent             TEXT NOT NULL CHECK (agent IN ('codex','claude','system')),
          run_type          TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
          round             INTEGER NOT NULL DEFAULT 0,
          started_at        TEXT NOT NULL,
          finished_at       TEXT,
          final_message     TEXT,
          structured_result TEXT,
          error_message     TEXT
        );
        CREATE INDEX idx_runs_task ON runs(task_id, started_at);

        CREATE TABLE run_events (
          id        TEXT PRIMARY KEY,
          run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL,
          type      TEXT NOT NULL,
          payload   TEXT NOT NULL
        );
        CREATE INDEX idx_run_events_run ON run_events(run_id);

        CREATE TABLE approvals (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          action       TEXT NOT NULL CHECK (action IN ('commit','push','create_repository','create_pull_request')),
          status       TEXT NOT NULL CHECK (status IN ('pending','granted','denied')),
          details      TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          resolved_at  TEXT
        );
        CREATE INDEX idx_approvals_task ON approvals(task_id);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'task-model-selection',
    up(db) {
      // Both nullable, and deliberately without a backfill: NULL means "no
      // override, let the tool pick", which is exactly the behaviour every task
      // created before this migration already had. Two separate statements
      // because SQLite's ALTER TABLE takes one column at a time.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN codex_model TEXT;
        ALTER TABLE tasks ADD COLUMN claude_model TEXT;
      `);
    }
  },
  {
    version: 3,
    name: 'operations-targets',
    up(db) {
      // The Operations registry. Separate tables rather than columns on an
      // existing one: a target is not a project and a diagnostic is not a run,
      // and folding them together would make every task query carry rows it has
      // no business seeing.
      //
      // Two things are deliberately absent from `operation_targets`: any column
      // that could hold a secret, and any column naming an adapter module or
      // executable. `adapter_type` is checked against the enum the code knows,
      // so a hand-edited row cannot name an implementation to load.
      db.exec(`
        CREATE TABLE operation_targets (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          environment    TEXT NOT NULL CHECK (environment IN ('local','staging','production')),
          adapter_type   TEXT NOT NULL CHECK (adapter_type IN ('local_sqlite')),
          -- Pinned to the one version this build writes and reads. Accepting
          -- any version at or above 1 would let in a row from a future build
          -- that this one cannot understand, which is the opposite of failing
          -- closed.
          config_version INTEGER NOT NULL CHECK (config_version = 1),
          config_json    TEXT NOT NULL,
          credential_ref TEXT,
          enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          -- One registration per name within an environment. The same file may
          -- legitimately be registered twice under different names (a read-only
          -- copy, say), so the path is not unique; the label an operator reads is.
          UNIQUE (environment, name),
          -- A local SQLite file is opened by path and has no account to name.
          CHECK (adapter_type <> 'local_sqlite' OR credential_ref IS NULL)
        );
        CREATE INDEX idx_operation_targets_env ON operation_targets(environment, name);

        CREATE TABLE operation_diagnostic_runs (
          id                TEXT PRIMARY KEY,
          -- RESTRICT, not CASCADE: a diagnostic run is an audit record of what
          -- was looked at and when. Deleting a target must not quietly erase the
          -- history of it; the registry refuses such a delete and says why.
          target_id         TEXT NOT NULL REFERENCES operation_targets(id) ON DELETE RESTRICT,
          probe_id          TEXT NOT NULL CHECK (probe_id IN ('connection_health','schema_summary')),
          status            TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
          started_at        TEXT NOT NULL,
          finished_at       TEXT,
          structured_result TEXT,
          failure_kind      TEXT CHECK (failure_kind IN ('error','timeout','cancelled','malformed')),
          error_message     TEXT,
          version           INTEGER NOT NULL CHECK (version = 1),
          -- A run may take exactly three shapes, and every column is pinned in
          -- each of them. Stating it as one constraint rather than several
          -- narrow ones is deliberate: the combinations that are wrong are the
          -- ones nobody thought to forbid — a failure still carrying the result
          -- of an earlier attempt, a success with an error message beside it, a
          -- running row with a verdict already filled in. A half-written row
          -- cannot survive a crash looking whole.
          CHECK (
            (status = 'running'
              AND finished_at       IS NULL
              AND structured_result IS NULL
              AND failure_kind      IS NULL
              AND error_message     IS NULL)
            OR
            (status = 'succeeded'
              AND finished_at       IS NOT NULL
              AND structured_result IS NOT NULL
              AND failure_kind      IS NULL
              AND error_message     IS NULL)
            OR
            (status = 'failed'
              AND finished_at       IS NOT NULL
              AND structured_result IS NULL
              AND failure_kind      IS NOT NULL
              -- Present *and* saying something. A blank message is the same
              -- silence as no message at all, and an operator reading the audit
              -- trail later has no way to tell one from the other.
              AND error_message     IS NOT NULL
              AND trim(error_message) <> '')
          )
        );
        CREATE INDEX idx_operation_diagnostics_target
          ON operation_diagnostic_runs(target_id, started_at DESC);
        -- Serves "what is still running?", in a stable order, for startup
        -- reconciliation.
        CREATE INDEX idx_operation_diagnostics_running
          ON operation_diagnostic_runs(status, started_at)
          WHERE status = 'running';
        -- At most one diagnostic in flight per target, enforced by the database
        -- rather than only by the service that usually checks first. The service
        -- pre-check stays, because it produces a message an operator can act on;
        -- this is what holds when two writers race, or when a row is inserted by
        -- something that never asked.
        CREATE UNIQUE INDEX idx_operation_diagnostics_one_running
          ON operation_diagnostic_runs(target_id)
          WHERE status = 'running';
      `);
    }
  }
];

export function runMigrations(db: SqliteDatabase): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    count += 1;
  }

  return count;
}
