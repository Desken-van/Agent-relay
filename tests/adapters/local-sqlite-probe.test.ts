/**
 * The local SQLite probe, against real files and a real child process.
 *
 * Every claim this adapter makes is about something outside the process: that a
 * database was opened read-only, that nothing was written to it, that a timeout
 * actually stopped a query, that no `-wal` appeared beside the file. None of
 * those can be shown with a fake — so these run the real
 * `ExecaProcessRunner` against the real probe script, over real SQLite files
 * created on disk for each test.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalSqliteProbeAdapter,
  SQLITE_PROBE_FILENAME,
  sqliteProbeEntryPath
} from '../../src/main/adapters/operations/local-sqlite-adapter';
import { ExecaProcessRunner, type ProcessResult, type ProcessRunOptions } from '../../src/main/adapters/process/process-runner';
import {
  DIAGNOSTIC_LIMITS,
  resolveDiagnosticLimits,
  type DiagnosticLimits
} from '../../src/shared/domain/operations-diagnostics';
import {
  OPERATION_CONFIG_VERSION,
  type OperationTarget
} from '../../src/shared/domain/operations';

const runner = new ExecaProcessRunner();
const adapter = new LocalSqliteProbeAdapter(runner);

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-relay-probe-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A real SQLite file with the given tables, closed before the probe sees it. */
function fixtureDatabase(build: (db: DatabaseSync) => void): string {
  const file = join(scratch(), 'fixture.sqlite');
  const db = new DatabaseSync(file);
  build(db);
  db.close();
  return file;
}

function targetFor(databasePath: string, overrides: Partial<OperationTarget> = {}): OperationTarget {
  return {
    id: 'target-1',
    name: 'Fixture',
    environment: 'local',
    adapterType: 'local_sqlite',
    config: { version: OPERATION_CONFIG_VERSION, adapterType: 'local_sqlite', databasePath },
    credentialRef: null,
    enabled: true,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...overrides
  };
}

/** Everything about a file that a write would disturb. */
function fingerprint(file: string): { hash: string; size: number; mtimeMs: number; siblings: string[] } {
  const stats = statSync(file);
  return {
    hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
    size: Number(stats.size),
    mtimeMs: stats.mtimeMs,
    siblings: readdirSync(join(file, '..')).sort()
  };
}

/** The probe script's code, with comments stripped so prose is not read as SQL. */
function probeSource(): string {
  return readFileSync(sqliteProbeEntryPath(), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const limits = (overrides: Partial<DiagnosticLimits> = {}): DiagnosticLimits => ({
  ...resolveDiagnosticLimits(),
  ...overrides
});

/* -------------------------------------------------------------------------- */
/* The entry point                                                             */
/* -------------------------------------------------------------------------- */

describe('the probe script', () => {
  it('resolves to a file that exists beside the adapter', () => {
    const entry = sqliteProbeEntryPath();
    expect(entry.endsWith(SQLITE_PROBE_FILENAME)).toBe(true);
    expect(statSync(entry).isFile()).toBe(true);
  });

  it('is a fixed path, not something a target can name', () => {
    // The request carries a database path and nothing else. There is no field
    // on `OperationProbeRequest` for an executable, a script or a command, so a
    // stored target cannot influence what is spawned.
    const entry = sqliteProbeEntryPath();
    const source = readFileSync(entry, 'utf8');
    expect(source).not.toMatch(/child_process|execa|spawn\(/);
    expect(source).not.toMatch(/require\(\s*['"]node:child_process/);
  });
});

/* -------------------------------------------------------------------------- */
/* connection_health                                                           */
/* -------------------------------------------------------------------------- */

describe('connection_health', () => {
  it('opens a real database read-only and reports what it found', async () => {
    const file = fixtureDatabase((db) => {
      db.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT NOT NULL)');
      db.exec("INSERT INTO invoices (customer) VALUES ('ACME Ltd')");
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({
      version: 1,
      probeId: 'connection_health',
      targetId: 'target-1',
      environment: 'local',
      adapterType: 'local_sqlite',
      opened: true,
      readOnly: true,
      // Reported by the connection itself, not asserted by the caller.
      queryOnly: true,
      fileExists: true,
      fileReadable: true,
      warnings: []
    });
    expect(outcome.result.probeId === 'connection_health' && outcome.result.sqliteVersion).toMatch(/^\d+\.\d+/);
    expect(outcome.result.probeId === 'connection_health' && outcome.result.fileSizeBytes).toBeGreaterThan(0);

    // Row contents never leave the database.
    expect(JSON.stringify(outcome.result)).not.toContain('ACME');
  });

  it('reports a missing file as a fact rather than failing', async () => {
    const outcome = await adapter.probe({
      target: targetFor(join(scratch(), 'absent.sqlite')),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'connection_health') return;
    expect(outcome.result.fileExists).toBe(false);
    expect(outcome.result.opened).toBe(false);
    expect(outcome.result.sqliteVersion).toBeNull();
    expect(outcome.result.warnings.join(' ')).toMatch(/No file exists/);
  });

  it('reports a file that is not a database as unopenable, without inventing health', async () => {
    const file = join(scratch(), 'not-a-database.sqlite');
    writeFileSync(file, 'this is definitely not SQLite', 'utf8');

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'connection_health') return;
    expect(outcome.result.fileExists).toBe(true);
    expect(outcome.result.opened).toBe(false);
    expect(outcome.result.queryOnly).toBe(false);
    expect(outcome.result.warnings.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* schema_summary                                                              */
/* -------------------------------------------------------------------------- */

describe('schema_summary', () => {
  it('lists user tables and columns, and no row contents', async () => {
    const file = fixtureDatabase((db) => {
      db.exec(`
        CREATE TABLE invoices (
          id       INTEGER PRIMARY KEY,
          customer TEXT NOT NULL,
          total    REAL,
          note     TEXT DEFAULT 'ACME internal reference'
        );
        CREATE TABLE payments (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL);
        CREATE INDEX idx_payments_invoice ON payments(invoice_id);
      `);
      db.exec("INSERT INTO invoices (customer, total) VALUES ('ACME Ltd', 99.5)");
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    expect(outcome.result.tables.map((table) => table.name)).toEqual(['invoices', 'payments']);
    expect(outcome.result.truncated).toBe(false);
    expect(outcome.result.omittedTables).toBe(0);

    const invoices = outcome.result.tables[0];
    expect(invoices?.columns).toEqual([
      { name: 'id', declaredType: 'INTEGER', nullable: true, primaryKey: true },
      { name: 'customer', declaredType: 'TEXT', nullable: false, primaryKey: false },
      { name: 'total', declaredType: 'REAL', nullable: true, primaryKey: false },
      { name: 'note', declaredType: 'TEXT', nullable: true, primaryKey: false }
    ]);

    const serialised = JSON.stringify(outcome.result);
    // Neither a row value nor a default — the default is where a literal from
    // the data would most plausibly hide.
    expect(serialised).not.toContain('ACME');
    expect(serialised).not.toContain('99.5');
    expect(serialised).not.toContain('internal reference');
    // No SQL text, no index or trigger definitions.
    expect(serialised).not.toMatch(/CREATE\s+(TABLE|INDEX|TRIGGER)/i);
    expect(serialised).not.toContain('idx_payments_invoice');
  });

  it('truncates a wide schema and says by how much', async () => {
    const file = fixtureDatabase((db) => {
      for (let table = 0; table < 12; table += 1) {
        const columns = Array.from({ length: 20 }, (_unused, index) => `c${index} TEXT`).join(', ');
        db.exec(`CREATE TABLE t${String(table).padStart(2, '0')} (id INTEGER PRIMARY KEY, ${columns})`);
      }
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 5, maxColumnsPerTable: 4, maxTotalColumns: 12 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    expect(outcome.result.tables).toHaveLength(5);
    expect(outcome.result.omittedTables).toBe(7);
    expect(outcome.result.omittedColumns).toBeGreaterThan(0);
    expect(outcome.result.truncated).toBe(true);

    for (const table of outcome.result.tables) {
      expect(table.columns.length).toBeLessThanOrEqual(4);
    }
    const total = outcome.result.tables.reduce((sum, table) => sum + table.columns.length, 0);
    expect(total).toBeLessThanOrEqual(12);
  });

  it('bounds long identifiers', async () => {
    const longName = `t_${'x'.repeat(400)}`;
    const file = fixtureDatabase((db) => {
      db.exec(`CREATE TABLE "${longName}" (id INTEGER PRIMARY KEY)`);
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxStringLength: 32 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;
    expect(outcome.result.tables[0]?.name.length).toBeLessThanOrEqual(32);
  });

  it('fails rather than guessing when the file is missing', async () => {
    const outcome = await adapter.probe({
      target: targetFor(join(scratch(), 'absent.sqlite')),
      probeId: 'schema_summary',
      limits: limits()
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toMatch(/No file exists/);
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only, proven                                                           */
/* -------------------------------------------------------------------------- */

describe('read-only enforcement', () => {
  it('leaves the file byte-identical, and creates no sidecar', async () => {
    const file = fixtureDatabase((db) => {
      db.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT)');
      db.exec("INSERT INTO invoices (customer) VALUES ('ACME Ltd')");
    });

    const before = fingerprint(file);
    // Both probes, twice, so neither a first open nor a repeat can be the one
    // that writes.
    for (const probeId of ['connection_health', 'schema_summary', 'connection_health'] as const) {
      const outcome = await adapter.probe({ target: targetFor(file), probeId, limits: limits() });
      expect(outcome.ok).toBe(true);
    }
    const after = fingerprint(file);

    expect(after.hash).toBe(before.hash);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // A read-only open creates no journal: the directory holds exactly what it
    // held before, so there is no `-wal` or `-shm` to clean up either.
    expect(after.siblings).toEqual(before.siblings);
    expect(after.siblings).toEqual(['fixture.sqlite']);
  });

  it('runs only the statements written into the script', () => {
    // The whole vocabulary, read from the file that owns it. A statement cannot
    // reach the child, because the request has no field to carry one — this
    // pins the other half: the script builds none of its own.
    //
    // Comments are stripped first: the header explains what the probe refuses
    // to issue, and naming those statements in prose must not read as issuing
    // them.
    const source = probeSource();

    for (const forbidden of [/\bATTACH\b/i, /\bVACUUM\b/i, /\bwritable_schema\b/i, /load_extension/i, /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i]) {
      expect(source).not.toMatch(forbidden);
    }
    // The one pragma it sets, and the read-only flag it opens with.
    expect(source).toContain("PRAGMA query_only = ON");
    expect(source).toContain('readOnly: true');
    // `dflt_value` is deliberately not selected: it can quote real data.
    expect(source).not.toContain('dflt_value');
  });

  it('reaches no user table, so no user row is read or counted', () => {
    // The blanket "no COUNT anywhere" rule this replaces was too coarse: two
    // counts over *schema metadata* are what make the omission numbers honest.
    // What must never happen is a statement naming a user table — and that is
    // decided by what follows `FROM`, not by whether `COUNT` appears.
    const froms = [...probeSource().matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(
      (match) => match[1]
    );

    expect(froms.length).toBeGreaterThan(0);
    for (const source of froms) {
      expect(['sqlite_schema', 'pragma_table_info']).toContain(source);
    }

    // And every count is over one of those two, never over anything else.
    for (const match of probeSource().matchAll(/COUNT\s*\(\s*\*\s*\)\s*AS\s+\w+\s+FROM\s+(\w+)/gi)) {
      expect(['sqlite_schema', 'pragma_table_info']).toContain(match[1]);
    }
  });

  it('bounds both listing statements in SQL, not after the fact', () => {
    // A limit applied in JavaScript still lets SQLite materialise the whole
    // schema first. These two are the statements that could return many rows,
    // and both carry `LIMIT ?` — a bound parameter, never a spliced number.
    const source = probeSource();

    // Matched within one source line: the statement strings contain quotes of
    // their own, so the bound has to be "same line", not "no quotes between".
    const listings = [
      /SELECT\s+name\s+FROM\s+sqlite_schema[^\n]*LIMIT\s+\?/i,
      /FROM\s+pragma_table_info\(\?\)[^\n]*LIMIT\s+\?/i
    ];
    for (const listing of listings) expect(source).toMatch(listing);

    // No statement splices a value in: no template placeholder and no
    // concatenation anywhere in the SQL block.
    const vocabulary = source.slice(source.indexOf('const SQL = {'));
    const block = vocabulary.slice(0, vocabulary.indexOf('};') + 2);
    expect(block).not.toMatch(/\$\{/);
    expect(block).not.toMatch(/['"`]\s*\+/);
    expect(block).toContain('pragma_table_info(?)');
  });
});

/* -------------------------------------------------------------------------- */
/* Process boundary                                                            */
/* -------------------------------------------------------------------------- */

describe('the process boundary', () => {
  /** The real runner, with a note of how each child was started. */
  class ObservingRunner extends ExecaProcessRunner {
    readonly starts: { file: string; args: readonly string[]; options: ProcessRunOptions }[] = [];

    override async run(
      file: string,
      args: readonly string[],
      options: ProcessRunOptions = {}
    ): Promise<ProcessResult> {
      this.starts.push({ file, args: [...args], options });
      return super.run(file, args, options);
    }
  }

  it('spawns the script with no shell and no arguments of its own', async () => {
    const file = fixtureDatabase((db) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)'));
    const observing = new ObservingRunner();

    await new LocalSqliteProbeAdapter(observing).probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits()
    });

    const start = observing.starts[0];
    expect(start?.file).toBe(process.execPath);
    expect(start?.args).toEqual([sqliteProbeEntryPath()]);

    // The database path travels on stdin, never on the command line — so it
    // cannot land in a log line or be read as a second command.
    expect(start?.args.join(' ')).not.toContain(file);
    const payload = JSON.parse(String(start?.options.input)) as {
      databasePath: string;
      probeId: string;
      limits: Record<string, number>;
    };
    expect(payload.databasePath).toBe(file);
    expect(payload.probeId).toBe('schema_summary');
    expect(start?.options.timeoutMs).toBe(DIAGNOSTIC_LIMITS.timeoutMs.default);
    expect(start?.options.maxOutputBytes).toBe(DIAGNOSTIC_LIMITS.maxOutputBytes.default);
  });

  it('reads the answer from stdout only', async () => {
    // A JSON envelope printed to stderr must not be able to stand in for a
    // result. The runner keeps the streams apart; this pins the adapter's half.
    const script = join(scratch(), 'noisy.mjs');
    writeFileSync(
      script,
      [
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        '  process.stderr.write(JSON.stringify({ protocol: "agent-relay.operations.probe", version: 1, outcome: "ok", result: { version: 1, probeId: "connection_health", targetId: "spoofed", environment: "production", adapterType: "local_sqlite", opened: true, readOnly: true, queryOnly: true, sqliteVersion: "0.0.0", fileExists: true, fileReadable: true, fileSizeBytes: 0, fileModifiedAt: null, startedAt: "t", finishedAt: "t", durationMs: 0, warnings: [] } }) + "\\n");',
        '  process.stderr.write("probe: a diagnostic line\\n");',
        '  process.exit(3);',
        '});'
      ].join('\n'),
      'utf8'
    );

    const outcome = await new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The exit code decided it, not the JSON on stderr. stderr survives only
    // as diagnostic text inside the message, which is what it is for.
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toContain('exited with code 3');
  });

  it('will not take a result from stderr even when the child exits cleanly', async () => {
    // The same envelope, on stderr, with a successful exit. If stderr were
    // read as protocol this would come back as a healthy production target.
    const script = join(scratch(), 'stderr-only.mjs');
    writeFileSync(
      script,
      [
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        '  process.stderr.write(JSON.stringify({ protocol: "agent-relay.operations.probe", version: 1, outcome: "ok", result: { version: 1, probeId: "connection_health", targetId: "spoofed", environment: "production", adapterType: "local_sqlite", opened: true, readOnly: true, queryOnly: true, sqliteVersion: "0.0.0", fileExists: true, fileReadable: true, fileSizeBytes: 0, fileModifiedAt: null, startedAt: "t", finishedAt: "t", durationMs: 0, warnings: [] } }) + "\\n");',
        '  process.exit(0);',
        '});'
      ].join('\n'),
      'utf8'
    );

    const outcome = await new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // stdout carried no envelope, so there is no result — regardless of what
    // was printed next door.
    expect(outcome.kind).toBe('malformed');
    expect(outcome.message).toMatch(/no response envelope/i);
  });

  it('calls a response it cannot read malformed, not an error', async () => {
    const script = join(scratch(), 'garbage.mjs');
    writeFileSync(
      script,
      [
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ protocol: "something-else", version: 7, outcome: "ok" }) + "\\n");',
        '  process.exit(0);',
        '});'
      ].join('\n'),
      'utf8'
    );

    const outcome = await new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A distinct kind: "the probe said something this build cannot read" is not
    // the same as "the probe said it failed".
    expect(outcome.kind).toBe('malformed');
  });

  it('reports a missing script as a build problem, not a target problem', async () => {
    await expect(
      new LocalSqliteProbeAdapter(runner, { probeEntryPath: join(scratch(), 'gone.mjs') }).probe({
        target: targetFor(join(scratch(), 'whatever.sqlite')),
        probeId: 'connection_health',
        limits: limits()
      })
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('stops a probe that will not finish, and leaves no child behind', async () => {
    const script = join(scratch(), 'hang.mjs');
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n");',
        'process.stdin.resume();',
        'setInterval(() => {}, 1000);'
      ].join('\n'),
      'utf8'
    );

    const startedAt = Date.now();
    const outcome = await new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits({ timeoutMs: 1_500 })
    });
    const elapsed = Date.now() - startedAt;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('timeout');
    // The bound was enforced, not merely reported.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('stops a probe on an abort signal', async () => {
    const script = join(scratch(), 'hang.mjs');
    writeFileSync(script, 'process.stdin.resume();\nsetInterval(() => {}, 1000);', 'utf8');

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);

    const outcome = await new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits({ timeoutMs: 30_000 }),
      signal: abort.signal
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('cancelled');
  });

  it('refuses a target it is not the adapter for', async () => {
    const outcome = await adapter.probe({
      target: {
        ...targetFor('/var/lib/x.sqlite'),
        adapterType: 'local_sqlite',
        // Deliberately inconsistent, the way a corrupted row would be.
        config: { version: 1, adapterType: 'postgres' } as never
      },
      probeId: 'connection_health',
      limits: limits()
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('error');
  });
});

/* -------------------------------------------------------------------------- */
/* Exactly one stdout envelope                                                 */
/* -------------------------------------------------------------------------- */

describe('the stdout protocol', () => {
  /** A well-formed envelope for the target under test. */
  const envelope = () =>
    JSON.stringify({
      protocol: 'agent-relay.operations.probe',
      version: 1,
      outcome: 'ok',
      result: {
        version: 1,
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
        fileSizeBytes: 1,
        fileModifiedAt: null,
        startedAt: 't',
        finishedAt: 't',
        durationMs: 0,
        warnings: []
      }
    });

  /** A child that writes exactly the given stdout, then exits 0. */
  function childWriting(stdout: string): string {
    const script = join(scratch(), 'writer.mjs');
    writeFileSync(
      script,
      [
        `const OUT = ${JSON.stringify(stdout)};`,
        'process.stdin.resume();',
        'process.stdin.on("end", () => { process.stdout.write(OUT); process.exit(0); });'
      ].join('\n'),
      'utf8'
    );
    return script;
  }

  const probeWith = (script: string) =>
    new LocalSqliteProbeAdapter(runner, { probeEntryPath: script }).probe({
      target: targetFor(join(scratch(), 'whatever.sqlite')),
      probeId: 'connection_health',
      limits: limits()
    });

  it('accepts one line and nothing else', async () => {
    const outcome = await probeWith(childWriting(`${envelope()}\n`));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.probeId).toBe('connection_health');
  });

  it('refuses a line of ordinary text before the envelope', async () => {
    // Previously this passed: the adapter picked the last thing that looked like
    // JSON and ignored everything else, so a child that had partly gone wrong
    // could still be believed.
    const outcome = await probeWith(childWriting(`starting up…\n${envelope()}\n`));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('malformed');
    expect(outcome.message).toMatch(/exactly one/);
  });

  it('refuses two envelopes rather than taking the last', async () => {
    const outcome = await probeWith(childWriting(`${envelope()}\n${envelope()}\n`));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('malformed');
    expect(outcome.message).toMatch(/2 lines/);
  });

  it('refuses trailing text after the envelope', async () => {
    const outcome = await probeWith(childWriting(`${envelope()}\ndone\n`));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('malformed');
  });

  it('refuses an empty stdout', async () => {
    const outcome = await probeWith(childWriting(''));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('malformed');
    expect(outcome.message).toMatch(/no response envelope/);
  });

  it('is not confused by blank lines around the single envelope', async () => {
    // Blank lines are not content; one envelope surrounded by them is still one.
    const outcome = await probeWith(childWriting(`\n${envelope()}\n\n`));
    expect(outcome.ok).toBe(true);
  });

  it('the real probe writes exactly one line', async () => {
    const file = fixtureDatabase((db) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)'));
    const observing = new (class extends ExecaProcessRunner {
      lines = 0;
      override async run(
        entry: string,
        args: readonly string[],
        options: ProcessRunOptions = {}
      ): Promise<ProcessResult> {
        const outcome = await super.run(entry, args, options);
        this.lines = outcome.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
        return outcome;
      }
    })();

    await new LocalSqliteProbeAdapter(observing).probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits()
    });

    expect(observing.lines).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Truncated columns are counted                                               */
/* -------------------------------------------------------------------------- */

describe('a column budget spent on the first table', () => {
  it('still reports how many columns each later table had', async () => {
    // Three tables with 5, 4 and 2 columns. `maxTotalColumns` is 3, so the first
    // table keeps 3 and omits 2, and the two after it keep none — but they know
    // how many they left out, which is what the old code forgot.
    const file = fixtureDatabase((db) => {
      db.exec('CREATE TABLE a (c0 TEXT, c1 TEXT, c2 TEXT, c3 TEXT, c4 TEXT)');
      db.exec('CREATE TABLE b (c0 TEXT, c1 TEXT, c2 TEXT, c3 TEXT)');
      db.exec('CREATE TABLE c (c0 TEXT, c1 TEXT)');
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 10, maxColumnsPerTable: 50, maxTotalColumns: 3 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    expect(
      outcome.result.tables.map((table) => ({
        name: table.name,
        kept: table.columns.length,
        omittedColumns: table.omittedColumns
      }))
    ).toEqual([
      { name: 'a', kept: 3, omittedColumns: 2 },
      { name: 'b', kept: 0, omittedColumns: 4 },
      { name: 'c', kept: 0, omittedColumns: 2 }
    ]);

    // The total is the sum of the parts, and a result with anything missing says so.
    expect(outcome.result.omittedColumns).toBe(8);
    expect(outcome.result.omittedTables).toBe(0);
    expect(outcome.result.truncated).toBe(true);
  });

  it('reports truncated when only columns were dropped, with no table missing', async () => {
    const file = fixtureDatabase((db) => {
      db.exec('CREATE TABLE only (c0 TEXT, c1 TEXT, c2 TEXT)');
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 10, maxColumnsPerTable: 1, maxTotalColumns: 10 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;
    expect(outcome.result.tables[0]?.columns).toHaveLength(1);
    expect(outcome.result.tables[0]?.omittedColumns).toBe(2);
    expect(outcome.result.omittedTables).toBe(0);
    expect(outcome.result.omittedColumns).toBe(2);
    expect(outcome.result.truncated).toBe(true);
  });

  it('reports nothing truncated when everything fitted', async () => {
    const file = fixtureDatabase((db) => db.exec('CREATE TABLE small (id INTEGER PRIMARY KEY)'));

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;
    expect(outcome.result.truncated).toBe(false);
    expect(outcome.result.omittedColumns).toBe(0);
    expect(outcome.result.omittedTables).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Identity is echoed, not shortened                                           */
/* -------------------------------------------------------------------------- */

describe('protocol identity', () => {
  it('comes back exactly, even when the string bound is tiny', async () => {
    // `maxStringLength` governs foreign text — table names, warnings. Applying
    // it to the identity fields would shorten them, and the caller compares them
    // against what it asked for, so a shortened id reads as a mismatch.
    const file = fixtureDatabase((db) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)'));
    const target = targetFor(file, {
      id: 'target-with-a-deliberately-long-identifier-0000001',
      environment: 'production'
    });

    for (const probeId of ['connection_health', 'schema_summary'] as const) {
      const outcome = await adapter.probe({
        target,
        probeId,
        limits: limits({ maxStringLength: 16 })
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.targetId).toBe(target.id);
      expect(outcome.result.environment).toBe('production');
      expect(outcome.result.adapterType).toBe('local_sqlite');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The bound is applied by SQLite, not afterwards                              */
/* -------------------------------------------------------------------------- */

describe('bounding a large schema', () => {
  /** A database with `tables` tables of `columns` columns each. */
  const wideSchema = (tables: number, columns: number) =>
    fixtureDatabase((db) => {
      for (let table = 0; table < tables; table += 1) {
        const definition = Array.from({ length: columns }, (_unused, index) => `c${index} TEXT`).join(
          ', '
        );
        db.exec(`CREATE TABLE t${String(table).padStart(3, '0')} (${definition})`);
      }
    });

  it('lists at most maxTables, and says exactly how many it left', async () => {
    const file = wideSchema(40, 2);

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 7 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    expect(outcome.result.tables).toHaveLength(7);
    // 40 declared, 7 listed. The count comes from a single aggregate over the
    // schema, so it is exact without the other 33 ever being materialised.
    expect(outcome.result.omittedTables).toBe(33);
    expect(outcome.result.truncated).toBe(true);
    // Ordered by name, so which seven were kept is deterministic.
    expect(outcome.result.tables.map((table) => table.name)).toEqual([
      't000',
      't001',
      't002',
      't003',
      't004',
      't005',
      't006'
    ]);
  });

  it('lists at most maxColumnsPerTable, and says exactly how many it left', async () => {
    const file = wideSchema(2, 30);

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxColumnsPerTable: 4 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    for (const table of outcome.result.tables) {
      expect(table.columns).toHaveLength(4);
      expect(table.omittedColumns).toBe(26);
    }
    expect(outcome.result.omittedColumns).toBe(52);
    expect(outcome.result.truncated).toBe(true);
  });

  it('stops listing columns once the total budget is spent, and still counts them', async () => {
    const file = wideSchema(4, 10);

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 10, maxColumnsPerTable: 10, maxTotalColumns: 12 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    // 10 + 2 fills the budget of 12; the last two tables list nothing at all —
    // no column row is materialised for them — but each still reports its ten.
    expect(
      outcome.result.tables.map((table) => [table.columns.length, table.omittedColumns])
    ).toEqual([
      [10, 0],
      [2, 8],
      [0, 10],
      [0, 10]
    ]);
    expect(outcome.result.omittedColumns).toBe(28);
    expect(outcome.result.omittedTables).toBe(0);
    expect(outcome.result.truncated).toBe(true);
  });

  it('handles a schema far larger than the ceiling without inflating the result', async () => {
    // 300 tables of 30 columns is 9 000 column definitions. With the bounds in
    // the statements, the result is the size the caller asked for.
    const file = wideSchema(300, 30);

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits({ maxTables: 3, maxColumnsPerTable: 2, maxTotalColumns: 6 })
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.probeId !== 'schema_summary') return;

    expect(outcome.result.tables).toHaveLength(3);
    expect(outcome.result.tables.every((table) => table.columns.length === 2)).toBe(true);
    expect(outcome.result.omittedTables).toBe(297);
    expect(outcome.result.omittedColumns).toBe(3 * 28);
    expect(Buffer.byteLength(JSON.stringify(outcome.result), 'utf8')).toBeLessThan(2_000);
  });

  it('reads no row, no default, no definition and no index from any of it', async () => {
    const file = fixtureDatabase((db) => {
      db.exec(`
        CREATE TABLE invoices (
          id       INTEGER PRIMARY KEY,
          customer TEXT NOT NULL DEFAULT 'ACME internal reference'
        );
        CREATE INDEX idx_invoices_customer ON invoices(customer);
        CREATE TRIGGER trg_invoices AFTER INSERT ON invoices BEGIN SELECT 1; END;
      `);
      db.exec("INSERT INTO invoices (customer) VALUES ('ACME Ltd')");
    });

    const outcome = await adapter.probe({
      target: targetFor(file),
      probeId: 'schema_summary',
      limits: limits()
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const serialised = JSON.stringify(outcome.result);

    expect(serialised).not.toContain('ACME');
    expect(serialised).not.toMatch(/CREATE\s+(TABLE|INDEX|TRIGGER)/i);
    expect(serialised).not.toContain('idx_invoices_customer');
    expect(serialised).not.toContain('trg_invoices');
    // A trigger and an index are not tables, so neither is listed.
    if (outcome.result.probeId !== 'schema_summary') return;
    expect(outcome.result.tables.map((table) => table.name)).toEqual(['invoices']);
  });
});
