/**
 * The single place in Agent Relay where a child process is created.
 *
 * Two invariants hold here and are relied upon everywhere else:
 *
 *  1. **No shell.** `execa` is called with an executable and an *array* of
 *     arguments, and `shell` is never enabled. A prompt containing `&& rm -rf /`
 *     is one argv entry, not two commands — there is no string for an attacker
 *     to break out of.
 *  2. **No inherited credentials.** The child's environment is scrubbed of
 *     token-shaped variables. `gh`, `codex` and `claude` each read their own
 *     credential store, so they never need one passed in.
 *
 * Output is redacted before it is returned, because callers persist it.
 */

import { execa, type Options, type ResultPromise } from 'execa';
import { AgentRelayError } from '../../../shared/domain/errors';
import { redactSecrets, scrubEnvironment } from '../../../shared/util/redact';

export type OutputStream = 'stdout' | 'stderr';

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Extra environment entries merged on top of the scrubbed parent env. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Credential-shaped environment variables this specific tool is allowed to
   * inherit (e.g. `GH_TOKEN` for `gh`). Everything else token-shaped is dropped,
   * so tools cannot see each other's secrets.
   */
  readonly passthroughEnvNames?: readonly string[];
  /** Text written to stdin, then closed. */
  readonly input?: string;
  /** Cap on retained stdout/stderr. Excess is dropped, not buffered. */
  readonly maxOutputBytes?: number;
  /** When set, output is streamed line-by-line as it arrives. */
  readonly onLine?: (line: string) => void;
  /** Allow resolving executables from the app's own `node_modules/.bin`. */
  readonly preferLocal?: boolean;
}

export interface ProcessResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly failed: boolean;
}

export interface ProcessRunner {
  run(
    file: string,
    args: readonly string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;

/** Accumulates text up to a byte budget, then silently drops the remainder. */
class BoundedBuffer {
  private parts: string[] = [];
  private size = 0;
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    if (this.size >= this.limit) {
      this.dropped += text.length;
      return;
    }
    const room = this.limit - this.size;
    if (text.length <= room) {
      this.parts.push(text);
      this.size += text.length;
    } else {
      this.parts.push(text.slice(0, room));
      this.size = this.limit;
      this.dropped += text.length - room;
    }
  }

  toString(): string {
    const body = this.parts.join('');
    return this.dropped > 0 ? `${body}\n…[${this.dropped} more characters omitted]` : body;
  }
}

export class ExecaProcessRunner implements ProcessRunner {
  async run(
    file: string,
    args: readonly string[],
    options: ProcessRunOptions = {}
  ): Promise<ProcessResult> {
    if (typeof file !== 'string' || file.trim().length === 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'An executable path is required.');
    }
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'Process arguments must all be strings; refusing to spawn.'
        );
      }
    }

    const startedAt = Date.now();
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const execaOptions: Options = {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cancelSignal: options.signal,
      // Kill the whole tree; agent CLIs spawn helpers of their own.
      forceKillAfterDelay: 5_000,
      env: {
        ...scrubEnvironment(process.env, options.passthroughEnvNames ?? []),
        ...(options.env ?? {})
      },
      extendEnv: false,
      // Never, under any circumstance, interpret the command as a shell string.
      shell: false,
      windowsHide: true,
      preferLocal: options.preferLocal ?? false,
      reject: false,
      stripFinalNewline: true,
      ...(options.input === undefined ? {} : { input: options.input })
    };

    const commandLabel = `${file} ${args.join(' ')}`.trim();

    if (options.onLine) {
      return this.runStreaming(file, args, execaOptions, {
        maxBytes,
        onLine: options.onLine,
        startedAt,
        commandLabel
      });
    }

    return this.runBuffered(file, args, execaOptions, { maxBytes, startedAt, commandLabel });
  }

  private async runBuffered(
    file: string,
    args: readonly string[],
    execaOptions: Options,
    ctx: { maxBytes: number; startedAt: number; commandLabel: string }
  ): Promise<ProcessResult> {
    try {
      const result = await execa(file, [...args], {
        ...execaOptions,
        maxBuffer: ctx.maxBytes
      });

      return {
        command: ctx.commandLabel,
        exitCode: result.exitCode ?? null,
        stdout: redactSecrets(asText(result.stdout)),
        stderr: redactSecrets(asText(result.stderr)),
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.isCanceled),
        durationMs: Date.now() - ctx.startedAt,
        failed: Boolean(result.failed)
      };
    } catch (error) {
      return toFailureResult(error, ctx);
    }
  }

  private async runStreaming(
    file: string,
    args: readonly string[],
    execaOptions: Options,
    ctx: { maxBytes: number; onLine: (line: string) => void; startedAt: number; commandLabel: string }
  ): Promise<ProcessResult> {
    const combined = new BoundedBuffer(ctx.maxBytes);
    let subprocess: ResultPromise | undefined;

    try {
      subprocess = execa(file, [...args], {
        ...execaOptions,
        all: true,
        buffer: false
      });

      for await (const rawLine of subprocess.iterable({ from: 'all' })) {
        const line = redactSecrets(String(rawLine));
        combined.push(`${line}\n`);
        ctx.onLine(line);
      }

      const result = await subprocess;
      const text = combined.toString();

      return {
        command: ctx.commandLabel,
        exitCode: result.exitCode ?? null,
        stdout: text,
        stderr: '',
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.isCanceled),
        durationMs: Date.now() - ctx.startedAt,
        failed: Boolean(result.failed)
      };
    } catch (error) {
      const failure = toFailureResult(error, ctx);
      // Preserve whatever we managed to stream before the failure.
      return { ...failure, stdout: combined.toString() || failure.stdout };
    }
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('\n');
  return String(value);
}

interface ExecaFailure {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
  all?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  shortMessage?: string;
  message?: string;
}

function toFailureResult(
  error: unknown,
  ctx: { startedAt: number; commandLabel: string }
): ProcessResult {
  const failure = (error ?? {}) as ExecaFailure;
  const message = failure.shortMessage ?? failure.message ?? String(error);

  return {
    command: ctx.commandLabel,
    exitCode: failure.exitCode ?? null,
    stdout: redactSecrets(asText(failure.stdout ?? failure.all)),
    stderr: redactSecrets(asText(failure.stderr) || redactSecrets(message)),
    timedOut: Boolean(failure.timedOut),
    cancelled: Boolean(failure.isCanceled),
    durationMs: Date.now() - ctx.startedAt,
    failed: true
  };
}

/** Convenience: run and throw a domain error unless the exit code is 0. */
export async function runOrThrow(
  runner: ProcessRunner,
  file: string,
  args: readonly string[],
  options: ProcessRunOptions & { errorCode?: AgentRelayError['code']; what?: string } = {}
): Promise<ProcessResult> {
  const result = await runner.run(file, args, options);

  if (result.cancelled) {
    throw new AgentRelayError('CANCELLED', `${options.what ?? result.command} was cancelled.`);
  }
  if (result.timedOut) {
    throw new AgentRelayError('TIMEOUT', `${options.what ?? result.command} timed out.`, {
      remediation: 'Increase the process timeout in Settings, or narrow the task.'
    });
  }
  if (result.exitCode !== 0) {
    throw new AgentRelayError(
      options.errorCode ?? 'TOOL_FAILED',
      `${options.what ?? result.command} failed (exit code ${result.exitCode ?? 'unknown'}).`,
      { details: (result.stderr || result.stdout).slice(0, 2000) }
    );
  }

  return result;
}
