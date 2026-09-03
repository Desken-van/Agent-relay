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
  /**
   * When set, **stdout** is streamed line-by-line as it arrives.
   *
   * stdout only. A caller that streams is parsing a protocol, and stderr is
   * where a CLI puts warnings, progress bars and crash traces — text that
   * happens to be adjacent, not part of the protocol.
   */
  readonly onLine?: (line: string) => void;
  /** Diagnostics from stderr, kept out of {@link onLine}. Streaming runs only. */
  readonly onStderrLine?: (line: string) => void;
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
/**
 * How long a failing path will wait for the stderr reader before giving up.
 *
 * That reader only ends when the child does, and on a failure path the child
 * may already be gone — so this is a courtesy, never a dependency.
 */
const STDERR_GRACE_MS = 250;

/**
 * The longest prefix of `text` that fits in `limit` UTF-8 bytes.
 *
 * Iterated by code point, so the cut never lands inside a multi-byte character
 * or between the halves of a surrogate pair. Splitting one would turn a
 * truncated line into mojibake — and, worse, into a string that no longer
 * matches the pattern that would have redacted it.
 */
function sliceToByteLimit(text: string, limit: number): string {
  if (limit <= 0) return '';

  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * Accumulates text up to a byte budget, then silently drops the remainder.
 *
 * The budget is counted in **UTF-8 bytes**, because that is what the option is
 * called and what the memory actually costs. Counting JavaScript characters
 * instead let a stream of three-byte characters retain three times the agreed
 * ceiling — the exact case where a bound is supposed to hold.
 *
 * What is retained is always a **contiguous prefix** of what was pushed. That
 * is what makes the "…[n more bytes omitted]" note true: it says everything
 * after this point is missing, so nothing after this point may reappear. The
 * buffer therefore seals itself the moment it drops its first byte, rather than
 * comparing size against the limit on each push. Those are not the same test:
 * a three-byte character that does not fit in two bytes of remaining room is
 * dropped whole, leaving the buffer under its limit and — before the seal —
 * willing to accept the next short line, which then appeared in the output
 * after data that had already been discarded.
 */
class BoundedBuffer {
  private parts: string[] = [];
  private size = 0;
  private dropped = 0;
  private sealed = false;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');

    if (this.sealed) {
      this.dropped += bytes;
      return;
    }

    const room = this.limit - this.size;
    if (bytes <= room) {
      this.parts.push(text);
      this.size += bytes;
      return;
    }

    // The first loss. Keep as much of this chunk as fits — cut on a code point,
    // never inside one — and refuse everything from here on.
    const kept = sliceToByteLimit(text, room);
    const keptBytes = Buffer.byteLength(kept, 'utf8');
    if (keptBytes > 0) {
      this.parts.push(kept);
      this.size += keptBytes;
    }
    this.dropped += bytes - keptBytes;
    this.sealed = true;
  }

  toString(): string {
    const body = this.parts.join('');
    return this.dropped > 0 ? `${body}\n…[${this.dropped} more bytes omitted]` : body;
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
  /**
   * Run a child once and collect what it produced.
   *
   * **`run` is one-shot, and its child's stdin always ends.** With `input`, the
   * text is written in full and stdin is then closed; without it, stdin is
   * `/dev/null` (`NUL` on Windows) and the child sees EOF the moment it looks.
   * It is never the parent's stdin.
   *
   * That is a contract, not a detail. A CLI that reads stdin before doing its
   * work — and plenty do, if only to notice there is nothing there — would
   * otherwise wait on a handle nobody is ever going to write to, and the run
   * would end as a timeout minutes later with no output and nothing to explain
   * it. Inheriting is worse still: the child would be reading the *application's*
   * stdin, and consuming bytes that were not addressed to it.
   *
   * {@link runInteractive} is the only API allowed to keep stdin open, because
   * keeping it open is the entire reason it exists.
   */
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
      // Set here rather than in `baseExecaOptions`, which is shared with the
      // interactive path: a default of "no stdin" there would close the very
      // channel that path is built around.
      ...(options.input === undefined
        ? { stdin: 'ignore' as const }
        : { input: options.input })
    };

    const commandLabel = commandLabelFor(file, args);

    if (options.onLine) {
      return this.runStreaming(file, args, execaOptions, {
        maxBytes,
        onLine: options.onLine,
        onStderrLine: options.onStderrLine,
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

  /**
   * Stream a child's stdout line by line, with stderr kept strictly apart.
   *
   * The separation is the contract, not an implementation detail. The only
   * caller that streams is the Claude adapter, and what it does with each line
   * is parse it as a `stream-json` protocol event: a session id, a tool call, a
   * permission denial, the final result envelope. Merging the two streams — as
   * this did, by iterating execa's combined `all` — meant anything the CLI, a
   * hook, or a wrapper script printed to stderr was offered to that parser as
   * protocol. A single JSON-shaped diagnostic line on stderr could therefore
   * open a session, fabricate a tool execution, or announce a result the CLI
   * never produced. stderr is a diagnostic channel; it is retained, and it is
   * never protocol.
   */
  private async runStreaming(
    file: string,
    args: readonly string[],
    execaOptions: Options,
    ctx: {
      maxBytes: number;
      onLine: (line: string) => void;
      onStderrLine?: (line: string) => void;
      startedAt: number;
      commandLabel: string;
    }
  ): Promise<ProcessResult> {
    const stdoutBuffer = new BoundedBuffer(ctx.maxBytes);
    const stderrBuffer = new BoundedBuffer(ctx.maxBytes);
    let subprocess: ResultPromise | undefined;
    let drainStderr: Promise<void> = Promise.resolve();

    /**
     * The first callback throw, whichever stream raised it.
     *
     * Kept out here so the catch below can report the caller's own error as the
     * cause rather than whatever execa says about the child we just killed.
     */
    let callbackError: unknown = null;

    /** Kill the tree. Safe to call more than once, and on a dead child. */
    const terminate = (): void => {
      // `forceKillAfterDelay` escalates to the whole tree if it ignores this.
      subprocess?.kill();
    };

    /** Let the stderr reader finish, but never wait on it indefinitely. */
    const settleStderr = (): Promise<unknown> =>
      Promise.race([drainStderr, new Promise((resolve) => setTimeout(resolve, STDERR_GRACE_MS))]);

    try {
      subprocess = execa(file, [...args], {
        ...execaOptions,
        buffer: false
      });

      const child = subprocess;
      // Marks the process promise as observed. Every path below either awaits
      // it or abandons it after a kill, and an abandoned rejection would
      // otherwise surface as an unhandled one in the host process.
      child.catch(() => undefined);

      // Drained in parallel: a child that fills its stderr pipe while nobody
      // reads it blocks, and a blocked child never reaches its final envelope.
      drainStderr = (async () => {
        try {
          for await (const raw of child.iterable({ from: 'stderr' })) {
            const line = redactSecrets(String(raw));
            stderrBuffer.push(`${line}\n`);

            // Draining continues after a failed diagnostic callback, and only
            // the callback stops being called. Abandoning the reader instead
            // would leave the child free to block on a full stderr pipe — the
            // one thing this loop exists to prevent.
            if (callbackError !== null) continue;
            try {
              ctx.onStderrLine?.(line);
            } catch (error) {
              callbackError = error;
              terminate();
            }
          }
        } catch {
          // The process ending mid-read is normal; the exit path reports it.
        }
      })();

      for await (const rawLine of child.iterable({ from: 'stdout' })) {
        const line = redactSecrets(String(rawLine));
        stdoutBuffer.push(`${line}\n`);

        try {
          ctx.onLine(line);
        } catch (error) {
          // Kill *before* unwinding the iterator. Letting the throw escape the
          // loop first makes execa's cleanup wait on a child that is still
          // running, which turns an instant failure into a full timeout.
          if (callbackError === null) callbackError = error;
          terminate();
          break;
        }
      }

      if (callbackError !== null) throw callbackError;

      const result = await subprocess;
      await drainStderr;
      // A diagnostic callback can fail after the stdout loop has already ended.
      // `drainStderr` only settles once stderr is at EOF, so by here that has
      // either happened or it never will.
      if (callbackError !== null) throw callbackError;

      return {
        command: ctx.commandLabel,
        exitCode: result.exitCode ?? null,
        stdout: stdoutBuffer.toString(),
        stderr: stderrBuffer.toString(),
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.isCanceled),
        durationMs: Date.now() - ctx.startedAt,
        failed: Boolean(result.failed)
      };
    } catch (error) {
      // Whatever the cause, the child must not outlive this function — and must
      // not be left to the timeout, which would stall an immediate failure for
      // the full duration and report it as one.
      terminate();
      await settleStderr();

      // A caller's own error is the cause; execa's account of the kill that
      // followed it is not.
      const failure = toFailureResult(callbackError ?? error, ctx);
      // Preserve whatever we managed to stream before the failure. Each stream
      // keeps its own text, so a diagnostic still cannot arrive as stdout.
      return {
        ...failure,
        stdout: stdoutBuffer.toString() || failure.stdout,
        stderr: stderrBuffer.toString() || failure.stderr
      };
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

    /** The first callback throw, from either stream. See `runStreaming`. */
    let callbackError: unknown = null;

    // stderr is drained in parallel and never offered to the line handler:
    // a warning on stderr must not be mistaken for a protocol response.
    const drainStderr = (async () => {
      try {
        for await (const raw of subprocess.iterable({ from: 'stderr' })) {
          const line = redactSecrets(String(raw));
          stderrBuffer.push(`${line}\n`);

          // Same contract as `runStreaming`: a failed diagnostic callback ends
          // the session, but never the draining. Abandoning the reader would
          // leave the child free to block on a full stderr pipe.
          if (callbackError !== null) continue;
          try {
            options.onStderrLine?.(line);
          } catch (error) {
            callbackError = error;
            terminate();
          }
        }
      } catch {
        // The process ending mid-read is normal; the exit path reports it.
      }
    })();

    try {
      await options.onStart?.(controller);

      for await (const raw of subprocess.iterable({ from: 'stdout' })) {
        const line = redactSecrets(String(raw));
        stdoutBuffer.push(`${line}\n`);

        try {
          await options.onStdoutLine(line, controller);
        } catch (error) {
          // Kill *before* unwinding the iterator. Letting the throw escape the
          // loop first makes execa's cleanup wait on a child that is still
          // running, which turns an instant failure into a full timeout.
          if (callbackError === null) callbackError = error;
          terminate();
          break;
        }
      }

      if (callbackError !== null) throw callbackError;

      const result = await subprocess;
      await drainStderr;
      if (callbackError !== null) throw callbackError;

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
      const failure = toFailureResult(callbackError ?? error, ctx);
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
        new Promise((resolve) => setTimeout(resolve, STDERR_GRACE_MS))
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
