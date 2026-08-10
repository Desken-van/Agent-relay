/**
 * SQLite connection management.
 *
 * Access is synchronous, which is what we want in the main process: every
 * repository call is a short, indexed statement, and synchronous access removes
 * a whole class of interleaving bugs from the orchestrator.
 *
 * WAL mode is enabled so a long-running agent run writing events cannot block a
 * read from an IPC handler serving the UI.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSqliteDatabase, type SqliteDatabase } from './sqlite';
import { runMigrations } from './migrations';

export type Db = SqliteDatabase;

export interface OpenDatabaseOptions {
  /** Absolute file path, or `:memory:` for tests. */
  readonly file: string;
}

export function openDatabase({ file }: OpenDatabaseOptions): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = createSqliteDatabase(file);

  // Durability + concurrency defaults. WAL is a no-op for an in-memory database.
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Fail fast rather than hanging the UI if another connection holds a lock.
  db.pragma('busy_timeout = 5000');

  runMigrations(db);

  return db;
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    // Closing twice is not an error worth surfacing.
  }
}
