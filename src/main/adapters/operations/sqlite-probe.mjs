/**
 * The read-only SQLite probe, as a separate process.
 *
 * ## Why a process and not a function
 *
 * `node:sqlite` is synchronous. A query against a large or damaged file blocks
 * the thread that issued it, and no `Promise.race`, `AbortSignal` or timer can
 * take that thread back — the timeout would only be noticed once the query had
 * already finished. Pretending otherwise would put a bound in the type signature
 * that does not exist at runtime.
 *
 * Running the work in a child process makes the bound real: the parent's
 * existing process boundary kills it, and the operating system reclaims it
 * whether or not it was willing to stop. Everything the parent already enforces
 * — no shell, scrubbed environment, bounded output, stdout separate from
 * stderr, tree kill on timeout or cancellation — applies unchanged.
 *
 * ## Contract
 *
 * * One JSON request on **stdin**, read to EOF. There is no argv input, so no
 *   caller can put anything on this process's command line.
 * * Exactly one JSON line on **stdout**: the versioned response envelope.
 * * **stderr** is diagnostics only, and is never part of the protocol.
 * * The request names a *probe id*, never a statement. Every query this file can
 *   issue is written out below; none is assembled from input, and every one of
 *   them reads schema metadata only — no statement here can name a user table,
 *   so no user row is read and none is counted.
 *
 * ## Read-only
 *
 * The connection is opened with `readOnly: true`, so SQLite refuses writes at
 * the file level and creates no `-wal` or `-shm` alongside it. `query_only` is
 * then set as well, and its value is read back and reported rather than assumed.
 * `ATTACH`, `VACUUM`, extensions and every writable pragma are simply never
 * issued, and could not be: there is no path by which a statement reaches here.
 */

import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PROTOCOL = 'agent-relay.operations.probe';
const PROTOCOL_VERSION = 1;
const RESULT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Fixed statements                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every query this process can run.
 *
 * Nothing is concatenated, interpolated or built from the request. The only
 * parameters anywhere are a table name that came out of the database's own
 * schema and a row limit computed from the caller's bounds, and both are bound
 * rather than spliced.
 *
 * Every `FROM` here names `sqlite_schema` or `pragma_table_info(?)`. Both are
 * **schema metadata**: the list of objects in the file, and the columns a table
 * declares. No statement in this file can reach a user table, so no user row is
 * ever read — and no user row is ever counted either. The two `COUNT(*)`s below
 * count schema entries, which is a different thing from counting data.
 *
 * The two listing statements carry `LIMIT ?`. That matters more than slicing
 * the array afterwards would: a bound applied in JavaScript still lets SQLite
 * materialise the whole schema first, so a file with a hundred thousand tables
 * would be fully loaded into this process before a single row was discarded.
 * With the limit in the statement, it never is.
 */
const SQL = {
  sqliteVersion: 'SELECT sqlite_version() AS v',
  queryOnly: 'PRAGMA query_only',
  // Forces the file header to be read, which is the only way to tell an actual
  // database from a file that merely has the right name: `DatabaseSync` opens
  // lazily, so a text file opens perfectly well and only fails once something
  // touches the schema. Returns an integer and no user data whatsoever.
  schemaVersion: 'PRAGMA schema_version',
  // One number: how many user tables the schema declares. Read so the result
  // can say honestly how many were left out, without listing them.
  tableCount:
    "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  userTables:
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name ASC LIMIT ?",
  // One number: how many columns this table declares. Counts schema entries,
  // never rows of the table itself.
  columnCount: 'SELECT COUNT(*) AS n FROM pragma_table_info(?)',
  // The table-valued form of `PRAGMA table_info`, so the table name is a bound
  // parameter instead of part of the statement text.
  tableInfo: 'SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid ASC LIMIT ?'
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function respond(payload) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: PROTOCOL_VERSION, ...payload })}\n`);
}

function fail(kind, message) {
  respond({ outcome: 'error', kind, message: String(message).slice(0, 500) });
  process.exit(0);
}

/**
 * Clamp a string to the request's limit, marking that it was cut.
 *
 * For **foreign** text only: a table name, a column name, a declared type, a
 * driver version, a warning. Identity fields — the target id, its environment
 * and its adapter type — are echoed back exactly as they arrived, because the
 * caller compares them against what it asked for. A truncated identity would
 * fail that comparison and turn a perfectly good probe into a mismatch.
 */
function bound(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function fileFacts(path) {
  try {
    const stats = statSync(path);
    return {
      fileExists: stats.isFile(),
      fileReadable: true,
      fileSizeBytes: stats.isFile() ? Number(stats.size) : null,
      fileModifiedAt: stats.mtime.toISOString()
    };
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    return {
      fileExists: code !== 'ENOENT',
      fileReadable: false,
      fileSizeBytes: null,
      fileModifiedAt: null
    };
  }
}

/** Open read-only, turn on `query_only`, and report what the connection said. */
function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    // Prove the file really is a database before reporting it as opened.
    db.prepare(SQL.schemaVersion).get();
  } catch (error) {
    try {
      db.close();
    } catch {
      // Nothing useful to add; the open already failed.
    }
    throw error;
  }
  const row = db.prepare(SQL.queryOnly).get();
  const queryOnly = Boolean(row && Object.values(row)[0]);
  return { db, queryOnly };
}

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

function connectionHealth(request, startedAt, startedMs) {
  const { target, limits } = request;
  const max = limits.maxStringLength;
  const warnings = [];
  const facts = fileFacts(request.databasePath);

  let opened = false;
  let queryOnly = false;
  let sqliteVersion = null;

  if (facts.fileExists && facts.fileReadable) {
    let db;
    try {
      const connection = openReadOnly(request.databasePath);
      db = connection.db;
      opened = true;
      queryOnly = connection.queryOnly;
      const row = db.prepare(SQL.sqliteVersion).get();
      sqliteVersion = row ? bound(row.v, max) : null;
      if (!queryOnly) warnings.push('The connection did not report query_only.');
    } catch (error) {
      warnings.push(bound(`Could not open the database: ${error?.message ?? error}`, max));
    } finally {
      // Closed on every outcome, including the ones that threw.
      if (db) {
        try {
          db.close();
        } catch {
          warnings.push('The connection did not close cleanly.');
        }
      }
    }
  } else if (!facts.fileExists) {
    warnings.push('No file exists at the configured path.');
  } else {
    warnings.push('The file exists but could not be read.');
  }

  const finishedAt = new Date().toISOString();
  return {
    version: RESULT_VERSION,
    probeId: 'connection_health',
    // Echoed exactly, never bounded: the caller checks these against the
    // request it made.
    targetId: target.id,
    environment: target.environment,
    adapterType: target.adapterType,
    opened,
    // How *this* process opened the connection: `DatabaseSync(..., { readOnly:
    // true })`. SQLite does not hand a flag back, so this is a statement about
    // the call that was made, and it is true only when that call succeeded.
    // `queryOnly` below is the one value actually read back out of SQLite.
    readOnly: opened,
    queryOnly,
    sqliteVersion,
    ...facts,
    fileModifiedAt: facts.fileModifiedAt === null ? null : bound(facts.fileModifiedAt, max),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - startedMs) / 1e6)),
    warnings: warnings.slice(0, 32).map((warning) => bound(warning, max))
  };
}

function schemaSummary(request, startedAt, startedMs) {
  const { target, limits } = request;
  const max = limits.maxStringLength;
  const warnings = [];

  const facts = fileFacts(request.databasePath);
  if (!facts.fileExists) fail('error', 'No file exists at the configured path.');
  if (!facts.fileReadable) fail('error', 'The file exists but could not be read.');

  let db;
  let queryOnly = false;
  try {
    const connection = openReadOnly(request.databasePath);
    db = connection.db;
    queryOnly = connection.queryOnly;
  } catch (error) {
    fail('error', `Could not open the database read-only: ${error?.message ?? error}`);
  }
  if (!queryOnly) warnings.push('The connection did not report query_only.');

  try {
    // How many there are, then at most `maxTables` of them. The count is a
    // single number out of the schema; the listing is bounded by SQLite
    // itself, so nothing beyond the limit is ever built in this process.
    const totalTables = Number(db.prepare(SQL.tableCount).get().n);
    const names = db
      .prepare(SQL.userTables)
      .all(limits.maxTables)
      .map((row) => String(row.name));
    const omittedTables = Math.max(0, totalTables - names.length);

    const info = db.prepare(SQL.tableInfo);
    const columnCount = db.prepare(SQL.columnCount);
    const tables = [];
    let totalColumns = 0;
    let omittedColumns = 0;

    for (const name of names) {
      // Same shape again: count first, then list at most what fits. Counting
      // is what lets a table whose columns were all dropped still say how
      // many it had — reporting `omittedColumns: 0` there would leave
      // `truncated` false on a result that was demonstrably truncated.
      const declared = Number(columnCount.get(name).n);
      const room = Math.max(
        0,
        Math.min(limits.maxColumnsPerTable, limits.maxTotalColumns - totalColumns)
      );

      // No room means no listing query at all, so not one column row is
      // materialised for a table the budget cannot afford.
      const rows = room === 0 ? [] : info.all(name, room);
      const columns = rows.map((row) => ({
        name: bound(row.name, max),
        // The declared type, verbatim. Never `dflt_value`, which can hold a
        // literal taken from the data this probe may not read.
        declaredType: bound(row.type ?? '', max),
        nullable: Number(row.notnull) === 0,
        primaryKey: Number(row.pk) > 0
      }));

      totalColumns += columns.length;
      const omitted = Math.max(0, declared - columns.length);
      omittedColumns += omitted;
      tables.push({ name: bound(name, max), columns, omittedColumns: omitted });
    }

    const finishedAt = new Date().toISOString();
    return {
      version: RESULT_VERSION,
      probeId: 'schema_summary',
      // Echoed exactly; see `connection_health`.
      targetId: target.id,
      environment: target.environment,
      adapterType: target.adapterType,
      tables,
      omittedTables,
      omittedColumns,
      truncated: omittedTables > 0 || omittedColumns > 0,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - startedMs) / 1e6)),
      warnings: warnings.slice(0, 32).map((warning) => bound(warning, max))
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Nothing useful left to say; the process is about to end anyway.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

const startedMs = process.hrtime.bigint();
const startedAt = new Date().toISOString();

let request;
try {
  request = JSON.parse(await readStdin());
} catch {
  fail('malformed', 'The probe request was not valid JSON.');
}

if (!request || request.protocol !== PROTOCOL || request.version !== PROTOCOL_VERSION) {
  fail('malformed', 'The probe request did not carry the expected protocol envelope.');
}
if (typeof request.databasePath !== 'string' || request.databasePath.length === 0) {
  fail('malformed', 'The probe request carried no database path.');
}
if (!request.limits || typeof request.limits.maxStringLength !== 'number') {
  fail('malformed', 'The probe request carried no limits.');
}

try {
  if (request.probeId === 'connection_health') {
    respond({ outcome: 'ok', result: connectionHealth(request, startedAt, startedMs) });
  } else if (request.probeId === 'schema_summary') {
    respond({ outcome: 'ok', result: schemaSummary(request, startedAt, startedMs) });
  } else {
    // Unreachable from the application, which validates against the enum before
    // spawning. Present because a process that can be started must still answer
    // for itself rather than exiting silently.
    fail('malformed', 'Unknown probe id.');
  }
} catch (error) {
  fail('error', error?.message ?? String(error));
}

process.exit(0);
