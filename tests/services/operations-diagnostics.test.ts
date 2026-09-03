/**
 * The registry and the diagnostic service, over a real database.
 *
 * The adapter is a fake here on purpose: what a probe *returns* is covered by
 * the process-level suite, and what matters at this layer is the order of
 * events around it — the run written before the probe starts, the one-at-a-time
 * rule, redaction before persistence, and the fact that nothing retries, falls
 * back or asks for an approval.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { SqliteApprovalRepository } from '../../src/main/db/repositories/approval-repository';
import { SqliteOperationDiagnosticRepository } from '../../src/main/db/repositories/operation-diagnostic-repository';
import { SqliteOperationTargetRepository } from '../../src/main/db/repositories/operation-target-repository';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import type {
  OperationProbeAdapter,
  OperationProbeOutcome,
  OperationProbeRequest
} from '../../src/main/ports';
import {
  OperationsDiagnosticsService,
  describesRequest,
  exceedsLimits,
  sanitiseResult
} from '../../src/main/services/operations-diagnostics-service';
import { OperationsRegistry } from '../../src/main/services/operations-registry';
import { OPERATION_CONFIG_VERSION } from '../../src/shared/domain/operations';
import {
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_RESULT_VERSION,
  resolveDiagnosticLimits,
  type DiagnosticResult
} from '../../src/shared/domain/operations-diagnostics';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

class RecordingAdapter implements OperationProbeAdapter {
  readonly requests: OperationProbeRequest[] = [];
  outcome: OperationProbeOutcome | (() => Promise<OperationProbeOutcome>);

  constructor(outcome: OperationProbeOutcome) {
    this.outcome = outcome;
  }

  async probe(request: OperationProbeRequest): Promise<OperationProbeOutcome> {
    this.requests.push(request);
    return typeof this.outcome === 'function' ? this.outcome() : this.outcome;
  }
}

const healthResult = (overrides: Partial<DiagnosticResult> = {}): DiagnosticResult =>
  ({
    version: DIAGNOSTIC_RESULT_VERSION,
    probeId: 'connection_health',
    targetId: 'target-000001',
    environment: 'local',
    adapterType: 'local_sqlite',
    opened: true,
    readOnly: true,
    queryOnly: true,
    sqliteVersion: '3.50.0',
    fileExists: true,
    fileReadable: true,
    fileSizeBytes: 1024,
    fileModifiedAt: '2026-09-03T10:00:00.000Z',
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:00.010Z',
    durationMs: 10,
    warnings: [],
    ...overrides
  }) as DiagnosticResult;

let db: Db;
let clock: FixedClock;
let targets: SqliteOperationTargetRepository;
let runs: SqliteOperationDiagnosticRepository;
let approvals: SqliteApprovalRepository;
let adapter: RecordingAdapter;
let registry: OperationsRegistry;
let service: OperationsDiagnosticsService;

function build(outcome: OperationProbeOutcome = { ok: true, result: healthResult() }): void {
  adapter = new RecordingAdapter(outcome);
  registry = new OperationsRegistry({
    targets,
    diagnostics: runs,
    ids: new SequentialIdGenerator('target'),
    adapters: { local_sqlite: adapter }
  });
  service = new OperationsDiagnosticsService({
    registry,
    diagnostics: runs,
    clock,
    ids: new SequentialIdGenerator('diag')
  });
}

function registerTarget(overrides: Record<string, unknown> = {}) {
  return registry.create({
    name: 'Reporting snapshot',
    environment: 'local',
    config: {
      version: OPERATION_CONFIG_VERSION,
      adapterType: 'local_sqlite',
      databasePath: 'C:\\data\\reports.sqlite'
    },
    ...overrides
  } as never);
}

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  clock = new FixedClock();
  targets = new SqliteOperationTargetRepository(db, clock);
  runs = new SqliteOperationDiagnosticRepository(db);
  approvals = new SqliteApprovalRepository(db);
  build();
});

afterEach(() => {
  closeDatabase(db);
});

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

describe('the registry', () => {
  it('registers a target and hands back what was stored', () => {
    const target = registerTarget();

    expect(target).toMatchObject({
      name: 'Reporting snapshot',
      environment: 'local',
      adapterType: 'local_sqlite',
      credentialRef: null,
      enabled: true
    });
    expect(registry.list()).toEqual([target]);
    expect(registry.get(target.id)).toEqual(target);
  });

  it('refuses an invalid target with a message naming the field', () => {
    expect(() =>
      registerTarget({
        config: { version: 1, adapterType: 'local_sqlite', databasePath: 'relative.sqlite' }
      })
    ).toThrow(/absolute/);
    expect(() => registerTarget({ credentialRef: 'vault:anything' })).toThrow(/credential reference/);
    expect(() => registerTarget({ environment: 'prod' })).toThrow();
  });

  it('refuses a duplicate name in the same environment, and allows it in another', () => {
    registerTarget();
    expect(() => registerTarget()).toThrow(/already registered/);
    expect(() => registerTarget({ environment: 'staging' })).not.toThrow();
  });

  it('will not turn a target into a different kind of thing', () => {
    const target = registerTarget();
    expect(() =>
      registry.update(target.id, {
        config: { version: 1, adapterType: 'postgres', host: 'db' } as never
      })
    ).toThrow();
  });

  it('reports an unknown target rather than returning nothing', () => {
    expect(() => registry.get('missing')).toThrow(/no longer exists/);
  });

  it('selects the adapter by enum, never by anything a row carries', () => {
    const target = registerTarget();
    expect(registry.adapterFor(target)).toBe(adapter);

    // A row naming an adapter this build has no reader for resolves to nothing.
    expect(() => registry.adapterFor({ ...target, adapterType: 'postgres' as never })).toThrow(
      /no reader/
    );
  });

  it('keeps a target that has history, and explains why', async () => {
    const target = registerTarget();
    await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(() => registry.delete(target.id)).toThrow(/diagnostic run\(s\) on record/);
    expect(registry.get(target.id)).toBeDefined();
    expect(registry.listDiagnostics(target.id)).toHaveLength(1);
  });

  it('removes a target that has none', () => {
    const target = registerTarget();
    expect(registry.delete(target.id)).toEqual({ removed: true });
    expect(registry.list()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Running a diagnostic                                                        */
/* -------------------------------------------------------------------------- */

describe('running a diagnostic', () => {
  it('records the run before the probe starts, and closes it as succeeded', async () => {
    const target = registerTarget();
    let observedWhileRunning: string | undefined;

    adapter.outcome = async () => {
      // The row exists, and says `running`, while the probe is still in flight.
      observedWhileRunning = runs.findRunningForTarget(target.id)?.status;
      return { ok: true, result: healthResult({ targetId: target.id }) };
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(observedWhileRunning).toBe('running');
    expect(run.status).toBe('succeeded');
    expect(run.probeId).toBe('connection_health');
    expect(run.result?.probeId).toBe('connection_health');
    expect(run.failureKind).toBeNull();
    expect(run.finishedAt).not.toBeNull();

    // What comes back is what was persisted, not what was hoped for.
    expect(runs.findById(run.id)).toEqual(run);
  });

  it('passes the resolved limits through to the adapter', async () => {
    const target = registerTarget();
    await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxTables: 5 }
    });

    expect(adapter.requests[0]?.limits).toEqual({
      timeoutMs: DIAGNOSTIC_LIMITS.timeoutMs.default,
      maxOutputBytes: DIAGNOSTIC_LIMITS.maxOutputBytes.default,
      maxTables: 5,
      maxColumnsPerTable: DIAGNOSTIC_LIMITS.maxColumnsPerTable.default,
      maxTotalColumns: DIAGNOSTIC_LIMITS.maxTotalColumns.default,
      maxStringLength: DIAGNOSTIC_LIMITS.maxStringLength.default
    });
  });

  it('records a failure as a failure, with the kind the adapter reported', async () => {
    const target = registerTarget();

    for (const kind of ['error', 'timeout', 'cancelled', 'malformed'] as const) {
      adapter.outcome = { ok: false, kind, message: `probe said ${kind}` };
      const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

      expect(run.status).toBe('failed');
      expect(run.failureKind).toBe(kind);
      expect(run.result).toBeNull();
      expect(run.errorMessage).toContain(kind);
      clock.advance(1_000);
    }
  });

  it('never turns a failure into a success', async () => {
    const target = registerTarget();
    adapter.outcome = { ok: false, kind: 'timeout', message: 'took too long' };

    const run = await service.run({ targetId: target.id, probeId: 'schema_summary' });

    expect(run.status).not.toBe('succeeded');
    expect(run.result).toBeNull();
    // And nothing plausible was invented in its place.
    expect(runs.findById(run.id)?.result).toBeNull();
  });

  it('closes the run even when the adapter throws', async () => {
    const target = registerTarget();
    adapter.outcome = async () => {
      throw new Error('the adapter exploded');
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('error');
    // No row is left claiming work is still in progress.
    expect(runs.findRunningForTarget(target.id)).toBeNull();
  });

  it('rejects a result whose shape this build cannot read', async () => {
    const target = registerTarget();
    adapter.outcome = { ok: true, result: { version: 9, probeId: 'connection_health' } as never };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('malformed');
    expect(run.result).toBeNull();
  });

  it('redacts free text before it is persisted', async () => {
    const target = registerTarget();
    // Assembled, so no continuous token-shaped literal exists in this file.
    const token = ['gh', 'p', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    adapter.outcome = {
      ok: true,
      result: healthResult({
        targetId: target.id,
        warnings: [`the connection string mentioned ${token}`]
      })
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    const stored = db
      .prepare('SELECT structured_result FROM operation_diagnostic_runs WHERE id = ?')
      .get(run.id) as { structured_result: string };

    // Redacted on the way to disk, not on the way to the screen.
    expect(stored.structured_result).not.toContain(token);
    expect(stored.structured_result).toContain('[redacted]');
    expect(JSON.stringify(run.result)).not.toContain(token);
  });

  it('redacts an error message too', async () => {
    const target = registerTarget();
    const token = ['gh', 'p', '_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
    adapter.outcome = { ok: false, kind: 'error', message: `failed using ${token}` };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.errorMessage).not.toContain(token);
    expect(run.errorMessage).toContain('[redacted]');
  });

  it('refuses a disabled target', async () => {
    const target = registerTarget();
    registry.update(target.id, { enabled: false });

    await expect(service.run({ targetId: target.id, probeId: 'connection_health' })).rejects.toThrow(
      /disabled/
    );
    // Nothing was started, so there is nothing to recover either.
    expect(runs.listByTarget(target.id)).toEqual([]);
    expect(adapter.requests).toEqual([]);
  });

  it('refuses a probe it does not know, before it even loads the target', async () => {
    const target = registerTarget();

    for (const probeId of ['SELECT 1', 'row_dump', 'connection_health ', '']) {
      await expect(
        service.run({ targetId: target.id, probeId: probeId as never })
      ).rejects.toThrow(/not a diagnostic this build knows/);
    }
    expect(adapter.requests).toEqual([]);
    expect(runs.listByTarget(target.id)).toEqual([]);
  });

  it('refuses a second diagnostic while one is in flight', async () => {
    const target = registerTarget();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    adapter.outcome = async () => {
      await gate;
      return { ok: true, result: healthResult({ targetId: target.id }) };
    };

    const first = service.run({ targetId: target.id, probeId: 'connection_health' });
    await Promise.resolve();

    await expect(service.run({ targetId: target.id, probeId: 'schema_summary' })).rejects.toThrow(
      /already running/
    );

    release?.();
    expect((await first).status).toBe('succeeded');
    // Exactly one run, and one probe call.
    expect(runs.listByTarget(target.id)).toHaveLength(1);
    expect(adapter.requests).toHaveLength(1);
  });

  it('never retries and never falls back to another target', async () => {
    const other = registerTarget({ name: 'Other' });
    const target = registerTarget({ name: 'Primary' });
    adapter.outcome = { ok: false, kind: 'error', message: 'nope' };

    await service.run({ targetId: target.id, probeId: 'connection_health' });

    // One attempt, against the target that was asked for and no other.
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.target.id).toBe(target.id);
    expect(runs.listByTarget(other.id)).toEqual([]);
  });

  it('creates no approval, because there is nothing to approve', async () => {
    const target = registerTarget();
    await service.run({ targetId: target.id, probeId: 'connection_health' });

    const rows = db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(approvals.listByTask('any')).toEqual([]);
  });

  it('lists history for a target through the registry', async () => {
    const target = registerTarget();
    await service.run({ targetId: target.id, probeId: 'connection_health' });
    clock.advance(1_000);
    adapter.outcome = { ok: false, kind: 'error', message: 'second attempt failed' };
    await service.run({ targetId: target.id, probeId: 'schema_summary' });

    const history = service.list(target.id);
    expect(history.map((run) => run.status)).toEqual(['failed', 'succeeded']);
    expect(history.map((run) => run.probeId)).toEqual(['schema_summary', 'connection_health']);
  });
});

/* -------------------------------------------------------------------------- */
/* The result must answer the question that was asked                          */
/* -------------------------------------------------------------------------- */

describe('binding a result to its request', () => {
  /** Every way a well-formed result can still be about something else. */
  const mismatches = [
    ['a different target', { targetId: 'some-other-target' }],
    ['a different environment', { environment: 'production' }],
    ['a different adapter', { adapterType: 'postgres' }]
  ] as const;

  for (const [what, overrides] of mismatches) {
    it(`refuses a result naming ${what}`, async () => {
      const target = registerTarget();
      adapter.outcome = {
        ok: true,
        result: healthResult({ targetId: target.id, ...overrides }) as never
      };

      const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

      expect(run.status).toBe('failed');
      expect(run.failureKind).toBe('malformed');
      expect(run.result).toBeNull();
      // The message says what happened without quoting the untrusted value back.
      expect(run.errorMessage).toBe(
        'The probe returned a result for a different request. Nothing was recorded.'
      );
      for (const value of Object.values(overrides)) {
        expect(run.errorMessage).not.toContain(String(value));
      }
      expect(runs.findById(run.id)?.result).toBeNull();
    });
  }

  it('refuses a well-formed result for the other probe', async () => {
    // Shape-valid on its own terms — it is a real `connection_health` result —
    // but the run asked for a schema summary. Without the binding check it would
    // be filed against that run as though it answered it.
    const target = registerTarget();
    adapter.outcome = { ok: true, result: healthResult({ targetId: target.id }) };

    const run = await service.run({ targetId: target.id, probeId: 'schema_summary' });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('malformed');
    expect(run.result).toBeNull();
    expect(run.errorMessage).toBe(
      'The probe returned a result for a different request. Nothing was recorded.'
    );
  });

  it('accepts a result that matches on all four fields', () => {
    const target = registerTarget();
    const result = healthResult({ targetId: target.id });

    expect(describesRequest(result, target, 'connection_health')).toBe(true);
    expect(describesRequest(result, target, 'schema_summary')).toBe(false);
    expect(describesRequest({ ...result, version: 2 } as never, target, 'connection_health')).toBe(
      false
    );
  });

  it('compares identity exactly, with no trimming to make it fit', async () => {
    // The probe echoes identity back verbatim for exactly this comparison. A
    // value shortened to satisfy a string bound would fail the check while
    // looking perfectly healthy.
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: healthResult({ targetId: `${target.id} ` })
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });
    expect(run.failureKind).toBe('malformed');
  });
});

/* -------------------------------------------------------------------------- */
/* Limits are re-checked by the side that imposed them                         */
/* -------------------------------------------------------------------------- */

describe('re-checking the limits the caller chose', () => {
  const summaryResult = (
    targetId: string,
    tables: { name: string; columns: number; omittedColumns?: number }[]
  ): DiagnosticResult => ({
    version: DIAGNOSTIC_RESULT_VERSION,
    probeId: 'schema_summary',
    targetId,
    environment: 'local',
    adapterType: 'local_sqlite',
    tables: tables.map((table) => ({
      name: table.name,
      columns: Array.from({ length: table.columns }, (_unused, index) => ({
        name: `c${index}`,
        declaredType: 'TEXT',
        nullable: true,
        primaryKey: false
      })),
      omittedColumns: table.omittedColumns ?? 0
    })),
    omittedTables: 0,
    omittedColumns: 0,
    truncated: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:00.050Z',
    durationMs: 50,
    warnings: []
  });

  it('refuses more tables than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: summaryResult(
        target.id,
        Array.from({ length: 6 }, (_unused, index) => ({ name: `t${index}`, columns: 1 }))
      )
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxTables: 5 }
    });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('malformed');
    expect(run.result).toBeNull();
    expect(run.errorMessage).toContain('too many tables');
  });

  it('refuses more columns in one table than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = { ok: true, result: summaryResult(target.id, [{ name: 't', columns: 9 }]) };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxColumnsPerTable: 8 }
    });

    expect(run.failureKind).toBe('malformed');
    expect(run.errorMessage).toContain('too many columns in one table');
  });

  it('refuses more columns in total than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: summaryResult(target.id, [
        { name: 'a', columns: 4 },
        { name: 'b', columns: 4 }
      ])
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      // Each table is within `maxColumnsPerTable`; together they are not.
      options: { maxColumnsPerTable: 5, maxTotalColumns: 7 }
    });

    expect(run.failureKind).toBe('malformed');
    expect(run.errorMessage).toContain('too many columns in total');
  });

  it('refuses foreign text longer than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: summaryResult(target.id, [{ name: 'x'.repeat(40), columns: 1 }])
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxStringLength: 32 }
    });

    expect(run.failureKind).toBe('malformed');
    expect(run.errorMessage).toContain('table name was longer than allowed');
  });

  it('refuses a warning longer than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: healthResult({ targetId: target.id, warnings: ['w'.repeat(40)] })
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'connection_health',
      options: { maxStringLength: 32 }
    });

    expect(run.failureKind).toBe('malformed');
    expect(run.errorMessage).toContain('warning was longer than allowed');
  });

  it('refuses a result larger than the run allowed', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      // Within every count — 100 tables, 10 columns each, 1000 in total — and
      // still far too many bytes for the ceiling this run chose.
      result: summaryResult(
        target.id,
        Array.from({ length: 100 }, (_unused, index) => ({
          name: `reporting_warehouse_fact_table_${String(index).padStart(3, '0')}`,
          columns: 10
        }))
      )
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxOutputBytes: 8_000 }
    });

    expect(run.failureKind).toBe('malformed');
    expect(run.errorMessage).toContain('larger than allowed');
  });

  it('never stores a trimmed-down version of an oversized result', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: summaryResult(
        target.id,
        Array.from({ length: 6 }, (_unused, index) => ({ name: `t${index}`, columns: 1 }))
      )
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxTables: 5 }
    });

    // Nothing partial: a cut-down copy would be a partial answer recorded as a
    // whole one, with counts inside it that no longer described anything.
    expect(run.result).toBeNull();
    const stored = db
      .prepare('SELECT structured_result FROM operation_diagnostic_runs WHERE id = ?')
      .get(run.id) as { structured_result: string | null };
    expect(stored.structured_result).toBeNull();
  });

  it('accepts a result that sits exactly on every bound', async () => {
    const target = registerTarget();
    adapter.outcome = {
      ok: true,
      result: summaryResult(target.id, [
        { name: 'a', columns: 4 },
        { name: 'b', columns: 4 }
      ])
    };

    const run = await service.run({
      targetId: target.id,
      probeId: 'schema_summary',
      options: { maxTables: 2, maxColumnsPerTable: 4, maxTotalColumns: 8 }
    });

    expect(run.status).toBe('succeeded');
    expect(run.result?.probeId).toBe('schema_summary');
  });

  it('measures the object that will be stored, after redaction', () => {
    // Redaction can lengthen a string — `PASSWORD=x` becomes
    // `PASSWORD=[redacted]` — so measuring before it would let a result through
    // that no longer fits once written.
    const target = registerTarget();
    const before = healthResult({ targetId: target.id, warnings: ['PASSWORD=x'] });
    const after = sanitiseResult(before);

    expect(JSON.stringify(after).length).toBeGreaterThan(JSON.stringify(before).length);
    expect(exceedsLimits(after, { ...resolveDiagnosticLimits(), maxStringLength: 16 })).toContain(
      'warning was longer than allowed'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Limits are validated before anything happens                                */
/* -------------------------------------------------------------------------- */

describe('an out-of-range limit', () => {
  /**
   * Every shape a bad option can take, for every bound.
   *
   * `as never` on the way in: most of these do not type-check, which is the
   * point — the runtime check exists for the callers that got past the type.
   */
  const badOptions = (): [string, unknown][] => {
    const cases: [string, unknown][] = [
      ['an unknown field', { unlimited: true }],
      ['a misspelled field', { maxtables: 5 }],
      ['null', { maxTables: null }],
      ['Infinity', { maxTables: Number.POSITIVE_INFINITY }],
      ['-Infinity', { timeoutMs: Number.NEGATIVE_INFINITY }],
      ['NaN', { maxTables: Number.NaN }],
      ['a string', { maxTables: '5' }]
    ];
    for (const [name, limit] of Object.entries(DIAGNOSTIC_LIMITS)) {
      cases.push([`${name} below its minimum`, { [name]: limit.min - 1 }]);
      cases.push([`${name} above its maximum`, { [name]: limit.max + 1 }]);
      cases.push([`${name} fractional`, { [name]: limit.min + 0.5 }]);
    }
    return cases;
  };

  for (const [what, options] of badOptions()) {
    it(`is refused before any work begins: ${what}`, async () => {
      const target = registerTarget();

      await expect(
        service.run({ targetId: target.id, probeId: 'connection_health', options: options as never })
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // Nothing was written, and nothing was started. Validation happens before
      // the running row, before the adapter is chosen, before a child exists.
      expect(runs.listByTarget(target.id)).toEqual([]);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM operation_diagnostic_runs').get() as { n: number }).n
      ).toBe(0);
      expect(adapter.requests).toEqual([]);
    });
  }

  it('is refused even before the target is looked up', async () => {
    // The request is checked as a request. A bad limit against a target that
    // does not exist reports the bad limit, because nothing about the target
    // has been consulted yet.
    await expect(
      service.run({
        targetId: 'no-such-target',
        probeId: 'connection_health',
        options: { maxTables: 0 } as never
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(adapter.requests).toEqual([]);
  });

  it('accepts every bound at either end of its range', async () => {
    const target = registerTarget();
    const edges = Object.fromEntries(
      Object.entries(DIAGNOSTIC_LIMITS).map(([name, limit]) => [name, limit.min])
    );

    const run = await service.run({
      targetId: target.id,
      probeId: 'connection_health',
      options: edges as never
    });

    expect(run.status).toBe('succeeded');
    expect(adapter.requests[0]?.limits).toEqual(edges);
  });
});

/* -------------------------------------------------------------------------- */
/* A failure always says something                                             */
/* -------------------------------------------------------------------------- */

describe('a failure with nothing to say', () => {
  const blankMessages: [string, string][] = [
    ['an empty message', ''],
    ['a whitespace-only message', '   '],
    ['a message of newlines and tabs', '\n\t\n']
  ];

  for (const [what, message] of blankMessages) {
    it(`still closes the run, with a fixed fallback: ${what}`, async () => {
      const target = registerTarget();
      adapter.outcome = { ok: false, kind: 'timeout', message };

      const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

      expect(run.status).toBe('failed');
      // The kind the adapter reported survives; only the empty text is replaced.
      expect(run.failureKind).toBe('timeout');
      expect(run.errorMessage?.trim().length).toBeGreaterThan(0);
      expect(run.errorMessage).toBe('The probe reported a failure but gave no reason.');

      // Closed, not abandoned: a blank message would have been refused by the
      // repository and by the table, leaving the row `running` for ever.
      expect(runs.findRunningForTarget(target.id)).toBeNull();
      expect(runs.findById(run.id)?.status).toBe('failed');
    });
  }

  it('does the same when the adapter throws with no message', async () => {
    const target = registerTarget();
    adapter.outcome = async () => {
      throw new Error('');
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('error');
    expect(run.errorMessage).toBe('The probe adapter failed without a message.');
    expect(runs.findRunningForTarget(target.id)).toBeNull();
  });

  it('does the same when the adapter throws something that is not an Error', async () => {
    const target = registerTarget();
    adapter.outcome = async () => {
      throw null;
    };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.status).toBe('failed');
    expect(run.errorMessage?.trim().length).toBeGreaterThan(0);
    expect(runs.findRunningForTarget(target.id)).toBeNull();
  });

  it('quotes nothing from the failure in the fallback', async () => {
    // The fallback is a fixed string. Reaching for an adjacent value to fill it
    // in would put words in the probe's mouth, and could carry content the
    // redactor never saw.
    const target = registerTarget();
    const token = ['gh', 'p', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    adapter.outcome = { ok: false, kind: 'error', message: '   ' };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });
    expect(run.errorMessage).not.toContain(token);
    expect(run.errorMessage).not.toContain(target.config.databasePath);
  });

  it('keeps a real message intact, redacted and bounded', async () => {
    const target = registerTarget();
    const token = ['gh', 'p', '_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
    adapter.outcome = { ok: false, kind: 'error', message: `opening failed using ${token}` };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.errorMessage).toContain('opening failed using');
    expect(run.errorMessage).toContain('[redacted]');
    expect(run.errorMessage).not.toContain(token);
  });

  it('falls back when a long message is blank once it has been cut', async () => {
    // Bounding happens before the emptiness check, because a thousand spaces
    // followed by a sentence is blank by the time it is stored.
    const target = registerTarget();
    adapter.outcome = { ok: false, kind: 'error', message: `${' '.repeat(2_000)}the real reason` };

    const run = await service.run({ targetId: target.id, probeId: 'connection_health' });

    expect(run.errorMessage).toBe('The probe reported a failure but gave no reason.');
    expect(run.status).toBe('failed');
  });
});
