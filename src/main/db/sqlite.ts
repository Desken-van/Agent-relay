/**
 * A thin, synchronous SQLite facade over Node's built-in `node:sqlite`.
 *
 * ## Why not a native module
 *
 * Agent Relay is a Windows-first desktop app that must start on an ordinary
 * developer machine. A native SQLite binding (`better-sqlite3`) has to match
 * Electron's ABI, and when no prebuilt binary exists for the Electron version in
 * use, installation falls back to compiling from source — which needs Visual
 * Studio Build Tools and a Python with `distutils`. That is a large, silent
 * prerequisite for "npm install", and it fails on Python 3.12+.
 *
 * `node:sqlite` is real SQLite compiled into the runtime itself. It works in
 * Electron and in the Vitest runtime with no rebuild step, no toolchain, and no
 * postinstall. The trade-off is that the module is still marked experimental
 * upstream (see docs/architecture.md, "Known limitations").
 *
 * ## Why a facade
 *
 * `node:sqlite` rejects a bound object containing keys the statement does not
 * mention ("Unknown named parameter"). Repositories here legitimately pass whole
 * domain objects to statements that touch a subset of their columns, so this
 * layer narrows the object to the parameters the SQL actually declares. It also
 * supplies the `transaction()` and `pragma()` helpers the repositories use.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type BindValue = string | number | bigint | null | Uint8Array;
export type BindObject = Record<string, BindValue>;
export type BindArgs = readonly (BindValue | BindObject)[];

export interface RunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...args: BindArgs): RunResult;
  get(...args: BindArgs): unknown;
  all(...args: BindArgs): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  /**
   * `pragma('journal_mode = WAL')` applies a setting;
   * `pragma('foreign_keys', { simple: true })` reads one.
   */
  pragma(statement: string, options?: { simple?: boolean }): unknown;
  transaction<A extends readonly unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

/**
 * Collect the named parameters a statement declares.
 *
 * String literals are blanked first so an `@` inside quoted text cannot be
 * mistaken for a parameter. SQLite accepts `@name`, `$name` and `:name`.
 */
export function namedParametersOf(sql: string): Set<string> {
  const withoutStringLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");
  const names = new Set<string>();
  const pattern = /[@$:]([A-Za-z_][A-Za-z0-9_]*)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutStringLiterals)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function isBindObject(value: unknown): value is BindObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

/** Narrow a bound object to the parameters the statement actually declares. */
function narrow(args: BindArgs, declared: Set<string>): BindValue[] {
  if (args.length === 1 && isBindObject(args[0])) {
    const source = args[0];
    const filtered: BindObject = {};
    for (const name of declared) {
      if (Object.prototype.hasOwnProperty.call(source, name)) {
        const value = source[name];
        // `undefined` is not a SQLite value; treat a missing field as NULL so a
        // partially-populated object behaves the way the repositories expect.
        filtered[name] = value === undefined ? null : value;
      }
    }
    return [filtered as unknown as BindValue];
  }

  return args.map((arg) => (arg === undefined ? null : (arg as BindValue)));
}

class NodeSqliteStatement implements PreparedStatement {
  private readonly declared: Set<string>;

  constructor(
    private readonly statement: StatementSync,
    sql: string
  ) {
    this.declared = namedParametersOf(sql);
  }

  run(...args: BindArgs): RunResult {
    return this.statement.run(...(narrow(args, this.declared) as never[]));
  }

  get(...args: BindArgs): unknown {
    return this.statement.get(...(narrow(args, this.declared) as never[]));
  }

  all(...args: BindArgs): unknown[] {
    return this.statement.all(...(narrow(args, this.declared) as never[])) as unknown[];
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  /** Nesting depth, so an inner transaction uses a SAVEPOINT rather than BEGIN. */
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): PreparedStatement {
    return new NodeSqliteStatement(this.db.prepare(sql), sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(statement: string, options?: { simple?: boolean }): unknown {
    if (statement.includes('=')) {
      this.db.exec(`PRAGMA ${statement}`);
      return undefined;
    }

    const row = this.db.prepare(`PRAGMA ${statement}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (options?.simple) {
      const values = Object.values(row);
      return values.length > 0 ? values[0] : undefined;
    }
    return row;
  }

  transaction<A extends readonly unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      const nested = this.depth > 0;
      const savepoint = `agent_relay_sp_${this.depth}`;

      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.depth += 1;

      try {
        fn(...args);
        this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      } catch (error) {
        try {
          this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          // The rollback itself failing must not mask the original error.
        }
        throw error;
      } finally {
        this.depth -= 1;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteDatabase(file: string): SqliteDatabase {
  return new NodeSqliteDatabase(new DatabaseSync(file));
}
