/**
 * Read-only diagnostic probes.
 *
 * A probe is named, never described. The renderer, the IPC layer and any future
 * model output can select one of the identifiers below and nothing else — there
 * is no channel, field or schema anywhere in this application through which a
 * SQL statement, a command or a file path to execute can reach an adapter. What
 * each probe runs is fixed in production code.
 *
 * Two probes exist in Phase 7C-A, and both answer questions *about* a database
 * rather than questions *of* it:
 *
 *  * `connection_health` — can this be opened read-only, and what does the file
 *    itself look like;
 *  * `schema_summary` — which user tables and columns exist, and of what type.
 *
 * **No row of a user table is read, and none is counted.** Every statement a
 * probe can issue reads schema metadata — `sqlite_schema` and
 * `pragma_table_info` — and none of them can name a user table. Counting schema
 * entries is how the omission numbers stay honest, and it is a different thing
 * from counting data.
 *
 * Neither probe returns a default value, a `CREATE` statement, an index or a
 * trigger body — all of which can quote real data. Everything they do return is
 * bounded, by SQLite itself where it could otherwise grow, and every result
 * carries the version of the shape it was produced in.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

export const DIAGNOSTIC_PROBE_IDS = ['connection_health', 'schema_summary'] as const;
export type DiagnosticProbeId = (typeof DIAGNOSTIC_PROBE_IDS)[number];

export const diagnosticProbeIdSchema = z.enum(DIAGNOSTIC_PROBE_IDS);

export const DIAGNOSTIC_RESULT_VERSION = 1;

/**
 * Ceiling on an identity field. Generous, because these are ids this application
 * generated; a value longer than this is a sign something else produced it.
 */
export const IDENTITY_MAX_LENGTH = 200;

/** Human-readable descriptions, for the UI that arrives in Phase 7C-B. */
export const DIAGNOSTIC_PROBE_DESCRIPTIONS: Readonly<Record<DiagnosticProbeId, string>> = {
  connection_health: 'Open the database read-only and report what the file and the driver say.',
  schema_summary: 'List user tables and their columns. Reads no rows from any of them.'
};

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

export interface Limit {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Every bound a diagnostic run obeys, with the range a caller may choose from.
 *
 * A caller may pick a value inside the range; it cannot pick one outside it, and
 * there is no value meaning "no limit". That asymmetry is deliberate: an
 * operator tightening a bound is making a run safer, while loosening one past
 * the maximum would make an unbounded read possible from the outside.
 *
 * Out of range is a refusal, not a clamp — see {@link resolveDiagnosticLimits},
 * which is where every caller's options are parsed regardless of the door they
 * came in through.
 */
export const DIAGNOSTIC_LIMITS = {
  /** Wall-clock ceiling on the probe process. */
  timeoutMs: { default: 15_000, min: 1_000, max: 60_000 },
  /** Bytes of probe output retained. */
  maxOutputBytes: { default: 256_000, min: 8_000, max: 1_000_000 },
  maxTables: { default: 100, min: 1, max: 500 },
  maxColumnsPerTable: { default: 50, min: 1, max: 200 },
  maxTotalColumns: { default: 1_000, min: 1, max: 5_000 },
  /** Longest identifier or message kept, in characters. */
  maxStringLength: { default: 200, min: 16, max: 1_000 }
} as const satisfies Record<string, Limit>;

const bounded = (limit: Limit) => z.number().int().min(limit.min).max(limit.max);

/**
 * What a caller may ask for. Every field is optional; an omitted one takes the
 * default, and an out-of-range one is a validation failure rather than a clamp
 * — silently substituting a different bound would tell the operator their
 * request was honoured when it was not.
 */
export const diagnosticOptionsSchema = z
  .object({
    timeoutMs: bounded(DIAGNOSTIC_LIMITS.timeoutMs).optional(),
    maxOutputBytes: bounded(DIAGNOSTIC_LIMITS.maxOutputBytes).optional(),
    maxTables: bounded(DIAGNOSTIC_LIMITS.maxTables).optional(),
    maxColumnsPerTable: bounded(DIAGNOSTIC_LIMITS.maxColumnsPerTable).optional(),
    maxTotalColumns: bounded(DIAGNOSTIC_LIMITS.maxTotalColumns).optional(),
    maxStringLength: bounded(DIAGNOSTIC_LIMITS.maxStringLength).optional()
  })
  .strict();

export type DiagnosticOptionsInput = z.infer<typeof diagnosticOptionsSchema>;

export interface DiagnosticLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxTables: number;
  readonly maxColumnsPerTable: number;
  readonly maxTotalColumns: number;
  readonly maxStringLength: number;
}

/**
 * Fill an options object out to a complete set of limits, or refuse it.
 *
 * The input is parsed here, through the same schema the IPC layer uses, so
 * there is exactly one answer to "is this a legal request?" no matter which
 * door it came through. A value outside its range **throws**; it is not
 * quietly moved to the nearest legal one.
 *
 * That distinction is the whole point. Clamping tells an operator their request
 * was honoured when a different one was carried out — and the direction that
 * matters is not the obvious one: someone asking for 10 000 tables and silently
 * getting 500 reads the result as complete. Refusing costs a round trip;
 * clamping costs the truth of the answer.
 *
 * Throws a `ZodError`. Callers that face a user turn it into a
 * `VALIDATION_FAILED` domain error.
 */
export function resolveDiagnosticLimits(options: DiagnosticOptionsInput = {}): DiagnosticLimits {
  const chosen = diagnosticOptionsSchema.parse(options ?? {});

  // No arithmetic: a value that reached this point is already inside its range,
  // an integer, finite, and named by a field the schema declares.
  const pick = (value: number | undefined, limit: Limit): number =>
    value === undefined ? limit.default : value;

  return {
    timeoutMs: pick(chosen.timeoutMs, DIAGNOSTIC_LIMITS.timeoutMs),
    maxOutputBytes: pick(chosen.maxOutputBytes, DIAGNOSTIC_LIMITS.maxOutputBytes),
    maxTables: pick(chosen.maxTables, DIAGNOSTIC_LIMITS.maxTables),
    maxColumnsPerTable: pick(chosen.maxColumnsPerTable, DIAGNOSTIC_LIMITS.maxColumnsPerTable),
    maxTotalColumns: pick(chosen.maxTotalColumns, DIAGNOSTIC_LIMITS.maxTotalColumns),
    maxStringLength: pick(chosen.maxStringLength, DIAGNOSTIC_LIMITS.maxStringLength)
  };
}

/* -------------------------------------------------------------------------- */
/* Probe results                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Foreign text: a table name, a column name, a declared type, a warning.
 *
 * This is the kind of value the run's `maxStringLength` applies to, and the kind
 * a probe may shorten to fit. The ceiling here is the absolute maximum any run
 * could have chosen; the run's own, tighter bound is re-checked by the service.
 */
const boundedString = z.string().max(DIAGNOSTIC_LIMITS.maxStringLength.max);

/**
 * Protocol identity: the target id, its environment, its adapter type.
 *
 * Deliberately a different type from {@link boundedString}. These are echoed
 * back so the caller can check the answer belongs to the question it asked, and
 * a value that is *shortened* to fit would fail that check while looking
 * healthy. So the ceiling here rejects rather than truncates, and nothing in the
 * probe trims them.
 */
const identityString = z.string().min(1).max(IDENTITY_MAX_LENGTH);

const warnings = z.array(boundedString).max(32);

/**
 * What `connection_health` may report.
 *
 * Metadata about the *file* and the *driver*, and nothing from inside the
 * database.
 *
 * Two fields that look alike and are not:
 *
 *  * `readOnly` says **how the probe opened the connection** —
 *    `DatabaseSync(path, { readOnly: true })`. SQLite hands no such flag back,
 *    so this is a statement about the call that was made, reported by the
 *    trusted process that made it, and true only when that call succeeded.
 *  * `queryOnly` is the one value genuinely **read back out of SQLite**:
 *    `PRAGMA query_only` is set and then queried, and whatever it answers is
 *    what appears here.
 *
 * Neither is asserted by the service after the fact.
 */
export const connectionHealthResultSchema = z
  .object({
    version: z.literal(DIAGNOSTIC_RESULT_VERSION),
    probeId: z.literal('connection_health'),
    targetId: identityString,
    environment: identityString,
    adapterType: identityString,
    /** The connection was opened at all. */
    opened: z.boolean(),
    /** The probe passed SQLite's read-only flag, and the open succeeded. */
    readOnly: z.boolean(),
    /** `PRAGMA query_only`, set and then queried. SQLite's own answer. */
    queryOnly: z.boolean(),
    sqliteVersion: boundedString.nullable(),
    fileExists: z.boolean(),
    fileReadable: z.boolean(),
    fileSizeBytes: z.number().int().min(0).nullable(),
    fileModifiedAt: boundedString.nullable(),
    startedAt: boundedString,
    finishedAt: boundedString,
    durationMs: z.number().int().min(0),
    warnings
  })
  .strict();

export type ConnectionHealthResult = z.infer<typeof connectionHealthResultSchema>;

export const schemaColumnSchema = z
  .object({
    name: boundedString,
    /** The declared type, verbatim. Never a default value. */
    declaredType: boundedString,
    nullable: z.boolean(),
    primaryKey: z.boolean()
  })
  .strict();

export const schemaTableSchema = z
  .object({
    name: boundedString,
    columns: z.array(schemaColumnSchema).max(DIAGNOSTIC_LIMITS.maxColumnsPerTable.max),
    /** Columns this table has that were not listed, because of the bound. */
    omittedColumns: z.number().int().min(0)
  })
  .strict();

/**
 * What `schema_summary` may report.
 *
 * Names, declared types and two flags. There is no field here for a default
 * value, a `CHECK` expression, an index definition or a trigger body — every one
 * of which can embed a literal from the data the probe is forbidden to read.
 * `truncated` is separate from the two counts so "there was more" survives even
 * if a count is ever wrong.
 */
export const schemaSummaryResultSchema = z
  .object({
    version: z.literal(DIAGNOSTIC_RESULT_VERSION),
    probeId: z.literal('schema_summary'),
    targetId: identityString,
    environment: identityString,
    adapterType: identityString,
    tables: z.array(schemaTableSchema).max(DIAGNOSTIC_LIMITS.maxTables.max),
    omittedTables: z.number().int().min(0),
    omittedColumns: z.number().int().min(0),
    truncated: z.boolean(),
    startedAt: boundedString,
    finishedAt: boundedString,
    durationMs: z.number().int().min(0),
    warnings
  })
  .strict();

export type SchemaSummaryResult = z.infer<typeof schemaSummaryResultSchema>;

export const diagnosticResultSchema = z.discriminatedUnion('probeId', [
  connectionHealthResultSchema,
  schemaSummaryResultSchema
]);

export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;

/** Parse a stored result, failing closed on an unknown probe or version. */
export function parseDiagnosticResult(json: string): DiagnosticResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The stored diagnostic result is not valid JSON.');
  }
  return diagnosticResultSchema.parse(parsed);
}

/* -------------------------------------------------------------------------- */
/* The persisted run                                                           */
/* -------------------------------------------------------------------------- */

export const DIAGNOSTIC_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type DiagnosticRunStatus = (typeof DIAGNOSTIC_RUN_STATUSES)[number];

/**
 * How a run that did not succeed ended.
 *
 * Kept apart from the status so `failed` never has to stand for four different
 * stories. A probe that timed out proved nothing; a probe that returned a shape
 * this build cannot read proved nothing either, but for a different reason, and
 * an operator deciding what to do next needs to know which.
 */
export const DIAGNOSTIC_FAILURE_KINDS = ['error', 'timeout', 'cancelled', 'malformed'] as const;
export type DiagnosticFailureKind = (typeof DIAGNOSTIC_FAILURE_KINDS)[number];

export interface OperationDiagnosticRun {
  readonly id: string;
  readonly targetId: string;
  readonly probeId: DiagnosticProbeId;
  readonly status: DiagnosticRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /**
   * The probe's own result, or null.
   *
   * Null on every path that is not a success, and never filled in with a
   * plausible-looking placeholder: a run with no result is a run that proved
   * nothing, and that has to stay visible.
   */
  readonly result: DiagnosticResult | null;
  readonly failureKind: DiagnosticFailureKind | null;
  readonly errorMessage: string | null;
  /** Shape version of this row, for the same fail-closed reason as the config. */
  readonly version: number;
}

export const DIAGNOSTIC_RUN_VERSION = 1;

/** True when the run reached a conclusion the operator can act on. */
export function diagnosticProvedSomething(run: OperationDiagnosticRun): boolean {
  return run.status === 'succeeded' && run.result !== null;
}
