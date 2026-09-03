/**
 * The local SQLite probe adapter.
 *
 * It runs no SQL itself. It writes a typed request to a fixed child process,
 * reads one versioned line back, and validates it — which is the whole of its
 * job. The statements live in `sqlite-probe.mjs` and cannot be reached from
 * anywhere else; there is no field on the request that carries one.
 *
 * The child is what makes the timeout real. `node:sqlite` is synchronous, so a
 * long query cannot be abandoned from the thread that issued it; killing a
 * separate process can be, and is, done by the same boundary the Claude adapter
 * uses — no shell, scrubbed environment, bounded output, stdout kept apart from
 * stderr, tree kill on timeout or cancellation.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentRelayError } from '../../../shared/domain/errors';
import { diagnosticResultSchema } from '../../../shared/domain/operations-diagnostics';
import { redactSecrets } from '../../../shared/util/redact';
import type { OperationProbeAdapter, OperationProbeOutcome, OperationProbeRequest } from '../../ports';
import { launchFor } from '../process/executable-locator';
import type { ProcessRunner } from '../process/process-runner';

const PROTOCOL = 'agent-relay.operations.probe';
const PROTOCOL_VERSION = 1;

/** The probe script's file name; the same in the source tree and in a build. */
export const SQLITE_PROBE_FILENAME = 'sqlite-probe.mjs';

/**
 * Where the probe script lives, relative to this module.
 *
 * In development and under Vitest this module is its own file, so the script is
 * its neighbour in the source tree. In a packaged build the main process is one
 * bundle in `out/main`, and `electron.vite.config.ts` copies the script in
 * beside it — so the same "next to me" lookup answers correctly in both, and
 * there is no environment check anywhere.
 */
export function sqliteProbeEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), SQLITE_PROBE_FILENAME);
}

/** The versioned envelope the child writes on stdout, and nothing else. */
const probeResponseSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      protocol: z.literal(PROTOCOL),
      version: z.literal(PROTOCOL_VERSION),
      outcome: z.literal('ok'),
      result: diagnosticResultSchema
    })
    .strict(),
  z
    .object({
      protocol: z.literal(PROTOCOL),
      version: z.literal(PROTOCOL_VERSION),
      outcome: z.literal('error'),
      kind: z.enum(['error', 'timeout', 'cancelled', 'malformed']),
      message: z.string().max(2000)
    })
    .strict()
]);

export interface LocalSqliteAdapterOptions {
  /** Overridden only by tests that need a deliberately broken entry point. */
  readonly probeEntryPath?: string;
}

export class LocalSqliteProbeAdapter implements OperationProbeAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: LocalSqliteAdapterOptions = {}
  ) {}

  async probe(request: OperationProbeRequest): Promise<OperationProbeOutcome> {
    const { target, probeId, limits } = request;

    if (target.config.adapterType !== 'local_sqlite') {
      // Unreachable through the registry, which selects this adapter by the same
      // enum. Kept because an adapter that can be constructed directly must
      // still refuse work it cannot do rather than guess.
      return {
        ok: false,
        kind: 'error',
        message: `The local SQLite adapter cannot probe a ${target.adapterType} target.`
      };
    }

    const entry = this.options.probeEntryPath ?? sqliteProbeEntryPath();
    if (!existsSync(entry)) {
      throw new AgentRelayError('INTERNAL', 'The SQLite probe script is missing from this build.', {
        details: entry,
        remediation: 'Reinstall or rebuild Agent Relay; the diagnostics helper was not packaged.'
      });
    }

    // A JavaScript entry point, run through the current runtime — never a shell,
    // and never a command assembled from anything the caller supplied.
    const launch = launchFor(entry);

    const payload = JSON.stringify({
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      probeId,
      databasePath: target.config.databasePath,
      target: { id: target.id, environment: target.environment, adapterType: target.adapterType },
      limits
    });

    // The script and nothing else: the probe takes no arguments at all.
    const result = await this.runner.run(launch.file, [...launch.prefixArgs], {
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      env: launch.env,
      // The request travels on stdin. Nothing about the target reaches argv, so
      // a path is never a command-line token and never lands in a log line.
      input: payload,
      ...(request.signal ? { signal: request.signal } : {})
    });

    if (result.cancelled) {
      return { ok: false, kind: 'cancelled', message: 'The diagnostic was stopped before it finished.' };
    }
    if (result.timedOut) {
      return {
        ok: false,
        kind: 'timeout',
        message: `The probe did not finish within ${Math.round(limits.timeoutMs / 1000)}s and was stopped.`
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        kind: 'error',
        message: redactSecrets(
          `The probe process exited with code ${result.exitCode ?? 'unknown'}. ${result.stderr}`.trim()
        ).slice(0, 2000)
      };
    }

    return this.readResponse(result.stdout);
  }

  /**
   * Turn the child's stdout into an outcome.
   *
   * The contract is **exactly one non-empty line**, and anything else is
   * `malformed`. Not "the last thing that looked like JSON", which is what this
   * did: with that rule, a probe that printed a warning first, or emitted two
   * envelopes, or appended anything after its answer, still produced a result —
   * so a process that had partly gone wrong could still be believed. A single
   * line is the only shape in which the answer is unambiguous.
   *
   * Only stdout is considered. `stderr` is diagnostics, and a JSON-shaped line
   * printed there must not be able to stand in for a result. `malformed` is kept
   * distinct from `error` because "the probe said something this build cannot
   * read" and "the probe said it failed" call for different responses.
   */
  private readResponse(stdout: string): OperationProbeOutcome {
    const lines = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (lines.length === 0) {
      return { ok: false, kind: 'malformed', message: 'The probe produced no response envelope.' };
    }
    if (lines.length > 1) {
      return {
        ok: false,
        kind: 'malformed',
        message: `The probe wrote ${lines.length} lines to stdout; the protocol is exactly one.`
      };
    }

    const line = lines[0] as string;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, kind: 'malformed', message: 'The probe response was not valid JSON.' };
    }

    const response = probeResponseSchema.safeParse(parsed);
    if (!response.success) {
      return {
        ok: false,
        kind: 'malformed',
        message: 'The probe response did not match the expected shape for this version.'
      };
    }

    if (response.data.outcome === 'error') {
      return {
        ok: false,
        kind: response.data.kind,
        message: redactSecrets(response.data.message).slice(0, 2000)
      };
    }

    return { ok: true, result: response.data.result };
  }
}
