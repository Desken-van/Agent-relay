import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase, type SqliteDatabase } from '../../src/main/db/sqlite';
import { MIGRATIONS } from '../../src/main/db/migrations';

let db: SqliteDatabase;

/** Mirrors `runMigrations`'s own transaction wrapping, scoped to a version ceiling. */
function applyMigrationsUpTo(target: SqliteDatabase, maxVersion: number): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const record = target.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > maxVersion) continue;
    const apply = target.transaction(() => {
      migration.up(target);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
  }
}

function applyMigration(target: SqliteDatabase, version: number): void {
  const migration = MIGRATIONS.find((m) => m.version === version);
  if (!migration) throw new Error(`No migration ${version}.`);
  const record = target.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );
  const apply = target.transaction(() => {
    migration.up(target);
    record.run(migration.version, migration.name, new Date().toISOString());
  });
  apply();
}

/** A fully populated version-11 database: one row in every table migration 12 touches or depends on. */
function seedV11Fixture(target: SqliteDatabase): void {
  const now = '2026-01-01T00:00:00.000Z';
  target.exec(`
    INSERT INTO projects (id, name, local_path, project_type, default_branch, github_owner, github_repo, github_visibility, created_at, updated_at)
    VALUES ('proj-1', 'Demo', 'C:\\repo', 'existing', 'main', 'acme', 'demo', 'private', '${now}', '${now}');

    INSERT INTO tasks (id, project_id, title, original_request, status, current_round, max_rounds,
      codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch, specification_json,
      specification_approved_at, last_review_json, last_error, codex_model, claude_model,
      implementation_provider, review_provider, provider_revision, implementation_thread_id, created_at, updated_at)
    VALUES ('task-1', 'proj-1', 'Task one', 'Do the thing', 'READY_FOR_REVIEW', 1, 3,
      'codex-thread-1', 'claude-session-1', 'C:\\worktrees\\task-1', 'agent-relay/task-1', 'main', '{}',
      '${now}', NULL, NULL, NULL, NULL,
      'claude', 'codex', 1, NULL, '${now}', '${now}');

    INSERT INTO task_provider_changes (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
    VALUES ('task-1', 1, 'claude', 'claude', 'codex', 'codex', '${now}');

    INSERT INTO runs (id, task_id, agent, run_type, status, round, started_at, finished_at, final_message, structured_result, error_message)
    VALUES ('run-1', 'task-1', 'claude', 'implementation', 'succeeded', 1, '${now}', '${now}', 'Done', '{}', NULL);

    INSERT INTO run_events (id, run_id, timestamp, type, payload)
    VALUES ('evt-1', 'run-1', '${now}', 'log', '{"text":"hello"}');

    INSERT INTO approvals (id, task_id, action, status, details, requested_at, resolved_at)
    VALUES ('appr-1', 'task-1', 'commit', 'pending', '{}', '${now}', NULL);
  `);
  // A second task so the continuation's FK targets both resolve.
  target.exec(`
    INSERT INTO tasks (id, project_id, title, original_request, status, current_round, max_rounds,
      codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch, specification_json,
      specification_approved_at, last_review_json, last_error, codex_model, claude_model,
      implementation_provider, review_provider, provider_revision, implementation_thread_id, created_at, updated_at)
    VALUES ('task-2', 'proj-1', 'Task two', 'Continue', 'READY_FOR_IMPLEMENTATION', 0, 3,
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      'codex', 'codex', 0, NULL, '${now}', '${now}');

    INSERT INTO task_continuations (id, source_task_id, continuation_task_id, entry_action,
      inherited_verification_run_id, inherited_implementation_run_id, inherited_review_run_id, created_at)
    VALUES ('cont-1', 'task-1', 'task-2', 'review', 'run-1', 'run-1', 'run-1', '${now}');
  `);
}

beforeEach(() => {
  db = createSqliteDatabase(':memory:');
  // Mirror `runMigrations`: rebuilds execute with FK cascades suspended and
  // validate referential integrity before committing.
  db.pragma('foreign_keys = OFF');
  db.pragma('synchronous = NORMAL');
});

afterEach(() => {
  db.close();
});

describe('migration 12 (ornith-provider)', () => {
  it('preserves every dependent row and enables ornith after migrating a populated v11 database', () => {
    applyMigrationsUpTo(db, 11);
    // Insert AFTER the FK-carrying tables exist (task_continuations was added
    // in migration 10) but the seed above already assumes that; re-run it
    // once schema is at v11.
    seedV11Fixture(db);

    const before = {
      tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number },
      runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number },
      runEvents: db.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number },
      approvals: db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number },
      providerChanges: db.prepare('SELECT COUNT(*) AS n FROM task_provider_changes').get() as { n: number },
      continuations: db.prepare('SELECT COUNT(*) AS n FROM task_continuations').get() as { n: number }
    };
    expect(before.tasks.n).toBe(2);
    expect(before.runs.n).toBe(1);
    expect(before.runEvents.n).toBe(1);
    expect(before.approvals.n).toBe(1);
    expect(before.providerChanges.n).toBe(1);
    expect(before.continuations.n).toBe(1);

    applyMigration(db, 12);
    db.pragma('foreign_keys = ON');

    // Every dependent row survived, unchanged in count.
    expect((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM task_provider_changes').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM task_continuations').get() as { n: number }).n).toBe(1);

    const task1 = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as Record<string, unknown>;
    expect(task1.implementation_provider).toBe('claude');
    expect(task1.review_provider).toBe('codex');
    expect(task1.codex_thread_id).toBe('codex-thread-1');
    expect(task1.claude_session_id).toBe('claude-session-1');

    // No dangling references anywhere in the database.
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations).toEqual([]);

    // Ornith round-trips as an implementation/correction run agent and as a
    // task's implementation provider.
    db.prepare(
      `UPDATE tasks SET implementation_provider = 'ornith' WHERE id = 'task-2'`
    ).run();
    db.prepare(
      `INSERT INTO runs (id, task_id, agent, run_type, status, round, started_at)
       VALUES ('run-ornith-1', 'task-2', 'ornith', 'implementation', 'succeeded', 1, '2026-01-02T00:00:00.000Z')`
    ).run();
    const roundTripped = db.prepare('SELECT implementation_provider FROM tasks WHERE id = ?').get('task-2') as {
      implementation_provider: string;
    };
    expect(roundTripped.implementation_provider).toBe('ornith');

    // Ornith is rejected as a review provider.
    expect(() =>
      db.prepare(`UPDATE tasks SET review_provider = 'ornith' WHERE id = 'task-2'`).run()
    ).toThrow();

    // Ornith is rejected as the agent for a non-implementation/correction run.
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, task_id, agent, run_type, status, round, started_at)
           VALUES ('run-ornith-2', 'task-2', 'ornith', 'review', 'succeeded', 1, '2026-01-02T00:00:00.000Z')`
        )
        .run()
    ).toThrow();

    // task_provider_changes rejects an ornith review value too.
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_provider_changes (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
           VALUES ('task-2', 1, 'codex', 'ornith', 'codex', 'ornith', '2026-01-02T00:00:00.000Z')`
        )
        .run()
    ).toThrow();

    // ...but accepts ornith as the implementation side.
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_provider_changes (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
           VALUES ('task-2', 2, 'codex', 'ornith', 'codex', 'codex', '2026-01-02T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow();
  });

  it('rolls back entirely, leaving the original v11 database usable, when the rebuild would violate a new constraint', () => {
    applyMigrationsUpTo(db, 11);
    seedV11Fixture(db);

    // A row migration 12's own rebuild cannot accept: a v11 database has no
    // CHECK on `task_provider_changes.review`, so a value migration 12 will
    // refuse (`'ornith'`) can exist there before the upgrade — simulating
    // data corruption or a future build's data reaching this migration.
    db.prepare(
      `INSERT INTO task_provider_changes (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
       VALUES ('task-1', 2, 'claude', 'claude', 'codex', 'ornith', '2026-01-01T00:00:00.000Z')`
    ).run();

    expect(() => applyMigration(db, 12)).toThrow();

    // Interrupted migration: the transaction rolled back, so the ORIGINAL
    // v11 schema and every row in it remain exactly as they were.
    const migrated = db.prepare('SELECT version FROM schema_migrations WHERE version = 12').get();
    expect(migrated).toBeUndefined();

    const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(2);
    const providerChanges = db.prepare('SELECT COUNT(*) AS n FROM task_provider_changes').get() as { n: number };
    expect(providerChanges.n).toBe(2);

    // The v11 shape (no CHECK on task_provider_changes.review) is still in
    // force — proof the rebuild never committed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_provider_changes (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
           VALUES ('task-1', 3, 'claude', 'claude', 'codex', 'still-unconstrained', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow();

    // The task row inserted before the failed migration is still readable.
    const task1 = db.prepare('SELECT implementation_provider, review_provider FROM tasks WHERE id = ?').get('task-1') as
      Record<string, unknown>;
    expect(task1.implementation_provider).toBe('claude');
    expect(task1.review_provider).toBe('codex');
  });
});
