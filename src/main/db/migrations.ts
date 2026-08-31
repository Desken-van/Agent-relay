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
