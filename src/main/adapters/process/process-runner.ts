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

/* -------------------------------------------------------------------------- */
/* Interactive (line-oriented duplex) execution                                */
/* -------------------------------------------------------------------------- */

/**
 * The only thing a session callback may do to the child.
 *
 * Deliberately two methods. A caller cannot reach the subprocess, its streams,
 * its pid, or anything else that would let it sidestep the limits below.
 */
export interface InteractiveSessionController {
  /** Write one NDJSON record. The newline is added here. */
  writeLine(line: string): void;
  /** Close stdin. Idempotent; further writes are refused. */
  closeInput(): void;
}

export interface InteractiveRunOptions extends ProcessRunOptions {
  /** Called once the child is up, to send the opening message(s). */
  onStart?(controller: InteractiveSessionController): void | Promise<void>;
  /** One stdout line, already redacted. Reply by writing the next line. */
  onStdoutLine(line: string, controller: InteractiveSessionController): void | Promise<void>;
  /** Stderr, kept separate so a diagnostic can never be parsed as a response. */
  onStderrLine?(line: string): void;
  /** Hard ceiling on messages written to stdin. */
  readonly maxInputMessages?: number;
  /** Hard ceiling on total stdin bytes. */
  readonly maxInputBytes?: number;
}

/**
 * A process you can talk to line by line.
 *
 * Split from {@link ProcessRunner} on purpose: only the Codex model catalogue
 * needs a duplex conversation, and every other adapter should keep depending on
 * the narrower "run once, collect output" contract. Both are implemented by
 * `ExecaProcessRunner`, so there is still exactly one place in the application
 * that creates a child process.
 */
export interface InteractiveProcessRunner {
  runInteractive(
    file: string,
    args: readonly string[],
    options: InteractiveRunOptions
  ): Promise<ProcessResult>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_MAX_INPUT_MESSAGES = 100;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;

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

/**
 * Reject anything that is not a plain executable path plus string arguments.
 * Shared by every execution path so none of them can be laxer than another.
 */
function assertSpawnable(file: string, args: readonly string[]): void {
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
}

/**
 * The security posture, in one place.
 *
 * Buffered, streaming and interactive execution all go through this. Copying
 * these flags into three call sites is how two of them eventually drift, and
 * `shell: false` is not a setting anyone should be able to lose by accident.
 */
function baseExecaOptions(options: ProcessRunOptions): Options {
  return {
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
    stripFinalNewline: true
  };
}

/**
 * What the caller is told the command was.
 *
 * Argv only — stdin never appears here, because prompts and JSON-RPC payloads
 * are exactly the model-authored text that must not end up in a log line.
 */
function commandLabelFor(file: string, args: readonly string[]): string {
  return `${file} ${args.join(' ')}`.trim();
}

export class ExecaProcessRunner implements ProcessRunner, InteractiveProcessRunner {
  async run(
    file: string,
    args: readonly string[],
    options: ProcessRunOptions = {}
  ): Promise<ProcessResult> {
    assertSpawnable(file, args);

    const startedAt = Date.now();
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const execaOptions: Options = {
      ...baseExecaOptions(options),
      ...(options.input === undefined ? {} : { input: options.input })
    };

    const commandLabel = commandLabelFor(file, args);

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

  /**
   * Run a child you can hold a line-by-line conversation with.
   *
   * The child stays alive with stdin open until the caller closes it, which is
   * the whole reason this exists: a protocol that answers a request only while
   * stdin is still open cannot be driven by `run({ input })`, where execa writes
   * the payload and immediately signals EOF.
   *
   * Everything that makes `run` safe applies unchanged — same options builder,
   * same scrubbed environment, same redaction, same bounded output, same tree
   * kill. What is added is bounded *input*, and a controller narrow enough that
   * a callback cannot reach the process itself.
   */
  async runInteractive(
    file: string,
    args: readonly string[],
    options: InteractiveRunOptions
  ): Promise<ProcessResult> {
    assertSpawnable(file, args);

    const startedAt = Date.now();
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxMessages = options.maxInputMessages ?? DEFAULT_MAX_INPUT_MESSAGES;
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    const commandLabel = commandLabelFor(file, args);
    const ctx = { maxBytes, startedAt, commandLabel };

    const stdoutBuffer = new BoundedBuffer(maxBytes);
    const stderrBuffer = new BoundedBuffer(maxBytes);

    const subprocess = execa(file, [...args], {
      ...baseExecaOptions(options),
      buffer: false
    });

    let inputClosed = false;
    let sessionOver = false;
    let messages = 0;
    let inputBytes = 0;

    const controller: InteractiveSessionController = {
      writeLine(line: string): void {
        // A controller that outlived its session would be writing into a
        // process nobody is reading from any more.
        if (sessionOver) {
          throw new AgentRelayError(
            'VALIDATION_FAILED',
            'This interactive session has ended; its controller can no longer be used.'
          );
        }
        if (inputClosed) {
          throw new AgentRelayError('VALIDATION_FAILED', 'stdin is already closed.');
        }
        if (typeof line !== 'string') {
          throw new AgentRelayError('VALIDATION_FAILED', 'Only strings can be written.');
        }
        // One record per line is the entire framing contract; an embedded
        // newline would silently split one message into two.
        if (/[\r\n]/.test(line)) {
          throw new AgentRelayError(
            'VALIDATION_FAILED',
            'A written line may not contain a carriage return or newline.'
          );
        }

        messages += 1;
        inputBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (messages > maxMessages) {
          throw new AgentRelayError(
            'VALIDATION_FAILED',
            `This session may write at most ${maxMessages} messages.`
          );
        }
        if (inputBytes > maxInputBytes) {
          throw new AgentRelayError(
            'VALIDATION_FAILED',
            `This session may write at most ${maxInputBytes} bytes to stdin.`
          );
        }

        subprocess.stdin?.write(`${line}\n`);
      },

      closeInput(): void {
        if (inputClosed) return;
        inputClosed = true;
        subprocess.stdin?.end();
      }
    };

    /** Close stdin and kill the tree. Safe to call more than once. */
    const terminate = (): void => {
      if (!inputClosed) {
        inputClosed = true;
        subprocess.stdin?.end();
      }
      // `forceKillAfterDelay` escalates to the whole tree if it ignores this.
      subprocess.kill();
    };

    // stderr is drained in parallel and never offered to the line handler:
    // a warning on stderr must not be mistaken for a protocol response.
    const drainStderr = (async () => {
      try {
        for await (const raw of subprocess.iterable({ from: 'stderr' })) {
          const line = redactSecrets(String(raw));
          stderrBuffer.push(`${line}\n`);
          options.onStderrLine?.(line);
        }
      } catch {
        // The process ending mid-read is normal; the exit path reports it.
      }
    })();

    try {
      await options.onStart?.(controller);

      let callbackError: unknown = null;

      for await (const raw of subprocess.iterable({ from: 'stdout' })) {
        const line = redactSecrets(String(raw));
        stdoutBuffer.push(`${line}\n`);

        try {
          await options.onStdoutLine(line, controller);
        } catch (error) {
          // Kill *before* unwinding the iterator. Letting the throw escape the
          // loop first makes execa's cleanup wait on a child that is still
          // running, which turns an instant failure into a full timeout.
          callbackError = error;
          terminate();
          break;
        }
      }

      if (callbackError !== null) throw callbackError;

      const result = await subprocess;
      await drainStderr;

      return {
        command: commandLabel,
        exitCode: result.exitCode ?? null,
        stdout: stdoutBuffer.toString(),
        stderr: stderrBuffer.toString(),
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.isCanceled),
        durationMs: Date.now() - startedAt,
        failed: Boolean(result.failed)
      };
    } catch (error) {
      // Includes a throw from the caller's own callback. Whatever the cause,
      // the child must not outlive this function — and must not be left to the
      // timeout, which would stall an immediate failure for the full duration.
      terminate();
      const failure = toFailureResult(error, ctx);
      return {
        ...failure,
        stdout: stdoutBuffer.toString() || failure.stdout,
        stderr: stderrBuffer.toString() || failure.stderr
      };
    } finally {
      sessionOver = true;
      terminate();
      // Give the stderr reader a moment to finish, but never wait on it: it
      // only ends when the child does, and the child may already be gone.
      await Promise.race([
        drainStderr.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 250))
      ]);
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
