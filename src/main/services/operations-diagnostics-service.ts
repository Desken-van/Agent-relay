/**
 * Running a read-only diagnostic.
 *
 * The order matters, and it is the order below:
 *
 *   1. resolve the target and validate the probe id against the enum;
 *   2. refuse a disabled target;
 *   3. refuse a second concurrent diagnostic for the same target;
 *   4. write the run as `running` *before* anything is spawned;
 *   5. run the adapter chosen by the registry from the adapter enum;
 *   6. validate the returned shape against its version;
 *   7. redact and bound it;
 *   8. close the run as `succeeded` or `failed`;
 *   9. return what was persisted, not what was hoped for.
 *
 * Step 4 is what makes an interrupted diagnostic visible: if the application
 * dies mid-probe, the row saying so is on disk, and startup reconciliation finds
 * it. Step 9 is what keeps the caller honest — a caller that renders the
 * in-memory object rather than the stored one can show a success that was never
 * written.
 *
 * Nothing here retries, and nothing here falls back to another target. A probe
 * that failed is a fact about that target; running a different one would answer
 * a question nobody asked. No approval is involved either, because there is no
 * mutation to approve: the whole surface is read-only.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type { OperationTarget } from '../../shared/domain/operations';
import {
  DIAGNOSTIC_RESULT_VERSION,
  diagnosticProbeIdSchema,
  diagnosticResultSchema,
  resolveDiagnosticLimits,
  type DiagnosticLimits,
  type DiagnosticOptionsInput,
  type DiagnosticProbeId,
  type DiagnosticResult,
  type OperationDiagnosticRun
} from '../../shared/domain/operations-diagnostics';
import { redactSecrets } from '../../shared/util/redact';
import type { Clock, IdGenerator, OperationDiagnosticRepository } from '../ports';
import type { OperationsRegistry } from './operations-registry';

const MAX_ERROR_MESSAGE = 1000;

/**
 * What a failure says when the thing that failed said nothing.
 *
 * Fixed strings, quoting nothing: whatever came back was empty, and inventing
 * detail from an adjacent value would put words in the probe's mouth. A stored
 * failure with a blank message is refused by the repository and by the table,
 * so a run that produced one would be left open — the fallback is what keeps
 * the row closable.
 */
const EMPTY_FAILURE_MESSAGE = 'The probe reported a failure but gave no reason.';
const EMPTY_THROW_MESSAGE = 'The probe adapter failed without a message.';

export interface OperationsDiagnosticsDeps {
  readonly registry: OperationsRegistry;
  readonly diagnostics: OperationDiagnosticRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface RunDiagnosticInput {
  readonly targetId: string;
  readonly probeId: DiagnosticProbeId;
  readonly options?: DiagnosticOptionsInput;
  readonly signal?: AbortSignal;
}

export class OperationsDiagnosticsService {
  constructor(private readonly deps: OperationsDiagnosticsDeps) {}

  async run(input: RunDiagnosticInput): Promise<OperationDiagnosticRun> {
    const probe = diagnosticProbeIdSchema.safeParse(input.probeId);
    if (!probe.success) {
      // The enum is the whole vocabulary. Anything else — including something
      // that looks like SQL — is refused here, before a target is even loaded.
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'That is not a diagnostic this build knows how to run.'
      );
    }

    // Everything the caller supplied is checked before anything is looked up,
    // started or spawned. A bound outside its range is refused rather than
    // moved to the nearest legal value: a run that quietly used different
    // limits would report a complete answer to a question nobody asked.
    let limits;
    try {
      limits = resolveDiagnosticLimits(input.options);
    } catch {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'One of the diagnostic limits is outside the range this build allows.',
        {
          remediation:
            'Choose a whole number within the documented range for each limit, or omit it to take the default.'
        }
      );
    }

    const target = this.deps.registry.get(input.targetId);

    if (!target.enabled) {
      throw new AgentRelayError('VALIDATION_FAILED', `The target "${target.name}" is disabled.`, {
        remediation: 'Enable it first if you want to inspect it.'
      });
    }

    const inFlight = this.deps.diagnostics.findRunningForTarget(target.id);
    if (inFlight) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A diagnostic is already running against this target.',
        { remediation: 'Wait for it to finish, then try again.' }
      );
    }

    const adapter = this.deps.registry.adapterFor(target);

    const started = this.deps.diagnostics.start({
      id: this.deps.ids.next(),
      targetId: target.id,
      probeId: probe.data,
      startedAt: this.deps.clock.nowIso()
    });

    let outcome;
    try {
      outcome = await adapter.probe({
        target,
        probeId: probe.data,
        limits,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      // An adapter is not supposed to reject, but a thrown error must still
      // close the run: a row left `running` would claim work is in progress that
      // has already stopped.
      return this.deps.diagnostics.finish(started.id, {
        status: 'failed',
        finishedAt: this.deps.clock.nowIso(),
        failureKind: 'error',
        errorMessage: safeMessage(error, EMPTY_THROW_MESSAGE)
      });
    }

    if (!outcome.ok) {
      return this.deps.diagnostics.finish(started.id, {
        status: 'failed',
        finishedAt: this.deps.clock.nowIso(),
        // Preserved as the adapter reported it: a timeout and a malformed answer
        // are both "we learned nothing", but not for the same reason.
        failureKind: outcome.kind,
        errorMessage: safeMessage(outcome.message, EMPTY_FAILURE_MESSAGE)
      });
    }

    const validated = diagnosticResultSchema.safeParse(outcome.result);
    if (!validated.success) {
      return this.malformed(started.id, 'The probe returned a result this build cannot read.');
    }

    // The answer has to be the answer to the question that was asked. An
    // adapter is trusted to run a probe, not trusted to say which probe it
    // ran: a result naming a different target, environment, adapter or probe
    // would be filed against this run as though it described it.
    if (!describesRequest(validated.data, target, probe.data)) {
      return this.malformed(
        started.id,
        'The probe returned a result for a different request. Nothing was recorded.'
      );
    }

    // Redaction first, because the object that gets measured must be the
    // object that gets stored — and redaction can change a string's length.
    const sanitised = sanitiseResult(validated.data);

    // Then the bounds, re-checked here rather than taken on trust. The child
    // process applies them too, but it is the thing being bounded; a limit
    // enforced only by the code it constrains is not a limit.
    const breach = exceedsLimits(sanitised, limits);
    if (breach) {
      // Deliberately not trimmed down to fit. Silently storing a smaller
      // version would record a partial answer as a whole one, and the counts
      // inside it would then be wrong about what was left out.
      return this.malformed(started.id, `The probe returned more than the run allowed (${breach}).`);
    }

    return this.deps.diagnostics.finish(started.id, {
      status: 'succeeded',
      finishedAt: this.deps.clock.nowIso(),
      result: sanitised
    });
  }

  /** Close a run as having proved nothing, with a message that quotes no input. */
  private malformed(runId: string, message: string): OperationDiagnosticRun {
    return this.deps.diagnostics.finish(runId, {
      status: 'failed',
      finishedAt: this.deps.clock.nowIso(),
      failureKind: 'malformed',
      errorMessage: message
    });
  }

  list(targetId: string, limit?: number): OperationDiagnosticRun[] {
    return this.deps.registry.listDiagnostics(targetId, limit);
  }
}

/**
 * Does this result describe the request that was made?
 *
 * Compared exactly, never normalised or truncated. The probe echoes these four
 * fields back untouched for this purpose — they are protocol identity, not
 * foreign data, which is why the string bound that applies to table names and
 * warnings deliberately does not apply to them.
 *
 * The version is checked here as well as by the schema. The schema pins it to a
 * literal, so this is belt and braces — but a version is the one field whose
 * meaning is "you may not assume anything about the rest of me", and it is
 * worth stating rather than inheriting.
 */
export function describesRequest(
  result: DiagnosticResult,
  target: OperationTarget,
  probeId: DiagnosticProbeId
): boolean {
  return (
    result.version === DIAGNOSTIC_RESULT_VERSION &&
    result.probeId === probeId &&
    result.targetId === target.id &&
    result.environment === target.environment &&
    result.adapterType === target.adapterType
  );
}

/**
 * The first bound this result breaks, or null.
 *
 * Named rather than boolean so the stored message can say which ceiling was
 * crossed without repeating any of the offending content. Every check is
 * against the limits *this run* resolved, not against the schema's absolute
 * maxima: a caller who asked for at most five tables has to get at most five.
 */
export function exceedsLimits(result: DiagnosticResult, limits: DiagnosticLimits): string | null {
  const tooLong = (value: string | null): boolean =>
    value !== null && value.length > limits.maxStringLength;

  if (result.warnings.some(tooLong)) return 'a warning was longer than allowed';

  if (result.probeId === 'connection_health') {
    if (tooLong(result.sqliteVersion)) return 'the reported version was longer than allowed';
  } else {
    if (result.tables.length > limits.maxTables) return 'too many tables';

    let totalColumns = 0;
    for (const table of result.tables) {
      if (tooLong(table.name)) return 'a table name was longer than allowed';
      if (table.columns.length > limits.maxColumnsPerTable) return 'too many columns in one table';
      totalColumns += table.columns.length;
      for (const column of table.columns) {
        if (tooLong(column.name)) return 'a column name was longer than allowed';
        if (tooLong(column.declaredType)) return 'a declared type was longer than allowed';
      }
    }
    if (totalColumns > limits.maxTotalColumns) return 'too many columns in total';
  }

  // Last, because it is a statement about the finished object: what will
  // actually be written to the database, in the bytes it will occupy.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxOutputBytes) {
    return 'the result was larger than allowed';
  }

  return null;
}

/**
 * Redact every free-text field before the result is persisted.
 *
 * Identifiers and warnings come out of somebody else's database and somebody
 * else's error messages. Neither is supposed to contain a credential, and the
 * probe reads no row — but "supposed to" is not a guarantee, and this is the
 * last point before the value is written to disk and shown in a UI.
 */
export function sanitiseResult(result: DiagnosticResult): DiagnosticResult {
  const clean = (value: string): string => redactSecrets(value);

  if (result.probeId === 'connection_health') {
    return {
      ...result,
      sqliteVersion: result.sqliteVersion === null ? null : clean(result.sqliteVersion),
      warnings: result.warnings.map(clean)
    };
  }

  return {
    ...result,
    tables: result.tables.map((table) => ({
      ...table,
      name: clean(table.name),
      columns: table.columns.map((column) => ({
        ...column,
        name: clean(column.name),
        declaredType: clean(column.declaredType)
      }))
    })),
    warnings: result.warnings.map(clean)
  };
}

/**
 * Turn anything into a message that is safe, bounded and never blank.
 *
 * The order matters: convert to text, redact, *then* bound. Redacting after the
 * cut could leave half a secret; bounding before it would measure the wrong
 * string. The emptiness check comes last, because a message of a thousand
 * spaces followed by a sentence is blank once it has been cut.
 */
function safeMessage(value: unknown, fallback: string): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  const bounded = redactSecrets(text).slice(0, MAX_ERROR_MESSAGE);
  return bounded.trim().length === 0 ? fallback : bounded;
}
