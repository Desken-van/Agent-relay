/**
 * The probe contract.
 *
 * The point of these is negative: a probe is *named*, and the vocabulary is
 * closed. Nothing that reaches this layer can describe work — only select it —
 * and every number a caller supplies has both a floor and a ceiling.
 */

import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_PROBE_IDS,
  DIAGNOSTIC_RESULT_VERSION,
  connectionHealthResultSchema,
  diagnosticOptionsSchema,
  diagnosticProbeIdSchema,
  diagnosticProvedSomething,
  diagnosticResultSchema,
  parseDiagnosticResult,
  resolveDiagnosticLimits,
  schemaSummaryResultSchema,
  type ConnectionHealthResult,
  type OperationDiagnosticRun,
  type SchemaSummaryResult
} from '../../src/shared/domain/operations-diagnostics';

const health: ConnectionHealthResult = {
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
  fileSizeBytes: 8192,
  fileModifiedAt: '2026-09-03T10:00:00.000Z',
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:00:00.100Z',
  durationMs: 100,
  warnings: []
};

const summary: SchemaSummaryResult = {
  version: DIAGNOSTIC_RESULT_VERSION,
  probeId: 'schema_summary',
  targetId: 'target-1',
  environment: 'local',
  adapterType: 'local_sqlite',
  tables: [
    {
      name: 'invoices',
      columns: [{ name: 'id', declaredType: 'INTEGER', nullable: false, primaryKey: true }],
      omittedColumns: 0
    }
  ],
  omittedTables: 0,
  omittedColumns: 0,
  truncated: false,
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:00:00.050Z',
  durationMs: 50,
  warnings: []
};

describe('the probe vocabulary', () => {
  it('is a closed enum of exactly two ids', () => {
    expect(DIAGNOSTIC_PROBE_IDS).toEqual(['connection_health', 'schema_summary']);
    for (const id of DIAGNOSTIC_PROBE_IDS) {
      expect(diagnosticProbeIdSchema.parse(id)).toBe(id);
    }
  });

  it('cannot be handed a statement, a command or a path', () => {
    // The whole reason a probe is an identifier: there is no shape here that a
    // query could arrive in, however it were spelled.
    for (const attempt of [
      'SELECT * FROM users',
      'select 1',
      'connection_health; DROP TABLE invoices',
      'PRAGMA writable_schema = ON',
      'ATTACH DATABASE "/etc/passwd" AS x',
      '../../etc/passwd',
      'node -e "process.exit(1)"',
      'connection_health ',
      'CONNECTION_HEALTH',
      ''
    ]) {
      expect(diagnosticProbeIdSchema.safeParse(attempt).success).toBe(false);
    }
  });
});

describe('limits', () => {
  it('has a default, a floor and a ceiling for every bound', () => {
    for (const [name, limit] of Object.entries(DIAGNOSTIC_LIMITS)) {
      expect(limit.min, name).toBeGreaterThan(0);
      expect(limit.max, name).toBeGreaterThanOrEqual(limit.min);
      expect(limit.default, name).toBeGreaterThanOrEqual(limit.min);
      expect(limit.default, name).toBeLessThanOrEqual(limit.max);
    }
  });

  it('fills in the defaults when nothing is asked for', () => {
    expect(resolveDiagnosticLimits()).toEqual({
      timeoutMs: DIAGNOSTIC_LIMITS.timeoutMs.default,
      maxOutputBytes: DIAGNOSTIC_LIMITS.maxOutputBytes.default,
      maxTables: DIAGNOSTIC_LIMITS.maxTables.default,
      maxColumnsPerTable: DIAGNOSTIC_LIMITS.maxColumnsPerTable.default,
      maxTotalColumns: DIAGNOSTIC_LIMITS.maxTotalColumns.default,
      maxStringLength: DIAGNOSTIC_LIMITS.maxStringLength.default
    });
  });

  it('lets a caller choose a tighter bound', () => {
    const limits = resolveDiagnosticLimits({ maxTables: 5, timeoutMs: 2_000 });
    expect(limits.maxTables).toBe(5);
    expect(limits.timeoutMs).toBe(2_000);
    // Untouched bounds keep their defaults.
    expect(limits.maxColumnsPerTable).toBe(DIAGNOSTIC_LIMITS.maxColumnsPerTable.default);
  });

  it('refuses a bound outside the permitted range rather than clamping it', () => {
    // Substituting a different number silently would tell the operator their
    // request was honoured when it was not.
    expect(diagnosticOptionsSchema.safeParse({ maxTables: 0 }).success).toBe(false);
    expect(diagnosticOptionsSchema.safeParse({ maxTables: 100_000 }).success).toBe(false);
    expect(diagnosticOptionsSchema.safeParse({ timeoutMs: 10 }).success).toBe(false);
    expect(diagnosticOptionsSchema.safeParse({ timeoutMs: 60 * 60_000 }).success).toBe(false);
    expect(diagnosticOptionsSchema.safeParse({ maxOutputBytes: 1 }).success).toBe(false);
    expect(diagnosticOptionsSchema.safeParse({ maxStringLength: 1 }).success).toBe(false);
  });

  it('offers no way to switch a bound off', () => {
    for (const off of [{ maxTables: null }, { timeoutMs: Infinity }, { maxTables: -1 }, { unlimited: true }]) {
      expect(diagnosticOptionsSchema.safeParse(off).success).toBe(false);
    }
  });

  it('refuses an out-of-range value when called directly, rather than clamping it', () => {
    // This used to assert the opposite — that a direct call clamped to the
    // maximum — which contradicted the documented contract one paragraph up.
    // Clamping is the more dangerous half: an operator who asked for a million
    // tables and silently got 500 reads the result as complete.
    expect(() => resolveDiagnosticLimits({ maxTables: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(() => resolveDiagnosticLimits({ maxTables: 0 })).toThrow();
    expect(() => resolveDiagnosticLimits({ timeoutMs: 1 })).toThrow();

    // And a legal value survives exactly, with the rest taking their defaults.
    expect(resolveDiagnosticLimits({ maxTables: DIAGNOSTIC_LIMITS.maxTables.max })).toEqual({
      ...resolveDiagnosticLimits(),
      maxTables: DIAGNOSTIC_LIMITS.maxTables.max
    });
  });

  it('parses its input through the same schema the IPC layer uses', () => {
    // One answer to "is this a legal request?", whichever door it came through.
    for (const bad of [
      { maxTables: 1.5 },
      { maxTables: Infinity },
      { maxTables: -Infinity },
      { maxTables: Number.NaN },
      { maxTables: null },
      { unlimited: true },
      { maxtables: 5 }
    ]) {
      expect(() => resolveDiagnosticLimits(bad as never), JSON.stringify(bad)).toThrow();
      expect(diagnosticOptionsSchema.safeParse(bad).success).toBe(false);
    }

    expect(resolveDiagnosticLimits()).toEqual(resolveDiagnosticLimits({}));
    expect(resolveDiagnosticLimits(undefined)).toEqual(resolveDiagnosticLimits({}));
  });

  it('keeps a chosen value exactly, at either end of its range', () => {
    for (const [name, limit] of Object.entries(DIAGNOSTIC_LIMITS)) {
      const atMin = resolveDiagnosticLimits({ [name]: limit.min } as never);
      const atMax = resolveDiagnosticLimits({ [name]: limit.max } as never);
      expect(atMin[name as keyof typeof atMin], name).toBe(limit.min);
      expect(atMax[name as keyof typeof atMax], name).toBe(limit.max);
      expect(() => resolveDiagnosticLimits({ [name]: limit.min - 1 } as never), name).toThrow();
      expect(() => resolveDiagnosticLimits({ [name]: limit.max + 1 } as never), name).toThrow();
    }
  });
});

describe('a probe result', () => {
  it('accepts each shape it declares', () => {
    expect(connectionHealthResultSchema.parse(health).probeId).toBe('connection_health');
    expect(schemaSummaryResultSchema.parse(summary).probeId).toBe('schema_summary');
    expect(diagnosticResultSchema.parse(health)).toEqual(health);
    expect(diagnosticResultSchema.parse(summary)).toEqual(summary);
  });

  it('carries a version, and fails closed on any other', () => {
    expect(() => diagnosticResultSchema.parse({ ...health, version: 2 })).toThrow();
    expect(() => parseDiagnosticResult(JSON.stringify({ ...summary, version: 99 }))).toThrow();
    expect(() => parseDiagnosticResult(JSON.stringify({ ...health, probeId: 'row_dump' }))).toThrow();
    expect(() => parseDiagnosticResult('not json')).toThrow();
  });

  it('has nowhere to put a row, a count or a SQL definition', () => {
    // Every one of these would be a way for real data to travel out of a
    // database the probe is forbidden to read from.
    for (const extra of [
      { rows: [{ id: 1 }] },
      { rowCount: 42 },
      { sql: 'CREATE TABLE invoices (...)' },
      { sample: 'ACME Ltd' },
      { triggers: ['audit_trg'] }
    ]) {
      expect(() => diagnosticResultSchema.parse({ ...summary, ...extra })).toThrow();
      expect(() => diagnosticResultSchema.parse({ ...health, ...extra })).toThrow();
    }

    // And a column carries a declared type, never a default value.
    expect(() =>
      diagnosticResultSchema.parse({
        ...summary,
        tables: [
          {
            name: 'invoices',
            columns: [
              { name: 'id', declaredType: 'INTEGER', nullable: false, primaryKey: true, defaultValue: 'ACME' }
            ],
            omittedColumns: 0
          }
        ]
      })
    ).toThrow();
  });

  it('is bounded in every direction it can grow', () => {
    const long = 'x'.repeat(DIAGNOSTIC_LIMITS.maxStringLength.max + 1);
    expect(() => diagnosticResultSchema.parse({ ...summary, targetId: long })).toThrow();
    expect(() =>
      diagnosticResultSchema.parse({
        ...summary,
        tables: Array.from({ length: DIAGNOSTIC_LIMITS.maxTables.max + 1 }, (_unused, index) => ({
          name: `t${index}`,
          columns: [],
          omittedColumns: 0
        }))
      })
    ).toThrow();
    expect(() =>
      diagnosticResultSchema.parse({
        ...summary,
        tables: [
          {
            name: 'wide',
            columns: Array.from(
              { length: DIAGNOSTIC_LIMITS.maxColumnsPerTable.max + 1 },
              (_unused, index) => ({
                name: `c${index}`,
                declaredType: 'TEXT',
                nullable: true,
                primaryKey: false
              })
            ),
            omittedColumns: 0
          }
        ]
      })
    ).toThrow();
    expect(() =>
      diagnosticResultSchema.parse({ ...health, warnings: Array.from({ length: 40 }, () => 'w') })
    ).toThrow();
  });
});

describe('what a stored run claims', () => {
  const base: OperationDiagnosticRun = {
    id: 'run-1',
    targetId: 'target-1',
    probeId: 'connection_health',
    status: 'succeeded',
    startedAt: health.startedAt,
    finishedAt: health.finishedAt,
    result: health,
    failureKind: null,
    errorMessage: null,
    version: 1
  };

  it('proves something only when it succeeded and brought a result back', () => {
    expect(diagnosticProvedSomething(base)).toBe(true);
    expect(diagnosticProvedSomething({ ...base, status: 'failed', result: null })).toBe(false);
    expect(diagnosticProvedSomething({ ...base, status: 'running', result: null })).toBe(false);
    // The case that matters: a row calling itself a success with nothing to show
    // for it is not evidence of anything.
    expect(diagnosticProvedSomething({ ...base, result: null })).toBe(false);
  });
});
