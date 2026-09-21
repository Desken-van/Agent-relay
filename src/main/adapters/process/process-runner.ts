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

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, type Options, type ResultPromise } from 'execa';
import { AgentRelayError } from '../../../shared/domain/errors';
import { redactSecrets, scrubEnvironment } from '../../../shared/util/redact';
import { findOnPath } from './executable-locator';

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
   * A separate cap for stderr alone, for a buffered run whose stdout cap is deliberately tight and
   * whose stderr (warnings, progress) must not be able to trip it. Unset: stderr shares
   * {@link maxOutputBytes}, exactly as before. Ignored by streaming runs.
   */
  readonly maxStderrBytes?: number;
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
  /**
   * Present (and `true`) only when the run failed BECAUSE a stream reached `maxOutputBytes`, as
   * reported by the process layer itself. It lets a caller that set a cap on purpose tell "the
   * output would not fit" from a genuine process failure; `stdout`/`stderr` then hold only what
   * was retained up to the cap, never the whole output.
   */
  readonly outputLimitExceeded?: boolean;
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

/* -------------------------------------------------------------------------- */
/* Supervised long-lived execution                                             */
/* -------------------------------------------------------------------------- */

export interface ManagedProcessOptions {
  readonly cwd?: string;
  /** Extra environment entries merged on top of the scrubbed parent env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly passthroughEnvNames?: readonly string[];
  /** Cap on retained stdout and stderr, counted separately. */
  readonly maxOutputBytes?: number;
  /** How long {@link ManagedProcess.stop} may take before it gives up. */
  readonly shutdownTimeoutMs?: number;
}

/**
 * How a managed child ended.
 *
 * Deliberately holds no message from `execa`: its failure text embeds the whole
 * command line, and this record is read by a provider that puts diagnostics into
 * durable state. A short OS error code is all that survives.
 */
export interface ManagedProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** True when the child could not be started at all (e.g. `ENOENT`). */
  readonly spawnFailed: boolean;
  /** A short OS error code, or null. Never a command line, path or argv. */
  readonly errorCode: string | null;
}

/** A bounded, redacted snapshot of what the child has printed so far. */
export interface ManagedProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The result of asking a managed child to go away.
 *
 * `unconfirmed` exists because "we could not verify that it is gone" is a
 * genuinely different fact from "it is gone", and a caller that reports a
 * confirmed cancellation or timeout must not be able to do so on the strength
 * of a kill it never observed landing.
 */
export type ManagedProcessStopResult =
  | { readonly kind: 'stopped'; readonly exit: ManagedProcessExit }
  | { readonly kind: 'unconfirmed'; readonly reason: string };

/**
 * A long-lived child, held at arm's length.
 *
 * Deliberately no streams, no `kill(signal)`, no subprocess. A supervisor may
 * watch it end, read a bounded snapshot of what it printed, and ask for the
 * whole tree to go away. That is the entire surface, which is what stops a
 * caller from writing to a server's stdin or parsing its log as a protocol.
 */
export interface ManagedProcess {
  /** The operating system's id for the child, or null if it never started. */
  readonly pid: number | null;
  /** Settles when the child is gone. Never rejects. */
  readonly exited: Promise<ManagedProcessExit>;
  /** False once {@link exited} has settled. */
  running(): boolean;
  /** Redacted, bounded, with an omission marker when anything was dropped. */
  output(): ManagedProcessOutput;
  /**
   * Terminate the process **tree** and wait for confirmed exit.
   *
   * `stopped` means the tree was accounted for, not merely that the child's exit
   * was observed: a descendant still alive after the budget is `unconfirmed`.
   *
   * Idempotent: repeated and concurrent calls share one cleanup and never start
   * a second kill.
   *
   * That holds for a CONFIRMED stop, which is remembered for ever. An
   * unconfirmed one is not an outcome but the absence of one, so a later call
   * may attempt the cleanup again rather than replaying a stale "could not be
   * confirmed" that nothing could ever move past.
   */
  stop(): Promise<ManagedProcessStopResult>;
}

/**
 * Start a child that outlives the call.
 *
 * Split from {@link ProcessRunner} on purpose. `run` is one-shot and owns the
 * child's whole lifetime; a managed runtime is a server that has to be up while
 * many requests are made against it, and only the local-inference provider needs
 * that. Both are implemented by `ExecaProcessRunner`, so there is still exactly
 * one place in the application that creates a child process.
 */
export interface ManagedProcessRunner {
  launch(
    file: string,
    args: readonly string[],
    options?: ManagedProcessOptions
  ): ManagedProcess;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_SHUTDOWN_MS = 10_000;
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
 * How much of a legacy Windows shutdown budget is held back from `taskkill`.
 *
 * Enough to observe the exit that `taskkill` has already caused, and no more.
 */
const WINDOWS_EXIT_RESERVE_MS = 200;

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

/* -------------------------------------------------------------------------- */
/* Process-tree termination                                                    */
/* -------------------------------------------------------------------------- */

/** Resolve `promise`, or `null` if it has not settled within `ms`. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    // `unref` so a pending grace period cannot hold the process open.
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Signal the child's whole process **group**, not just the child.
 *
 * POSIX only. The managed child is spawned `detached`, which makes it the leader
 * of a new group whose id equals its pid, so `kill(-pid)` reaches every
 * descendant that has not deliberately left the group. This is also why it keeps
 * working for a moment after the leader itself has died: the group outlives its
 * leader, and an orphaned helper is exactly the thing worth reaching.
 */
function signalPosixTree(pid: number, subprocess: ResultPromise, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // No such group (already reaped, or never detached). Fall through.
  }
  try {
    subprocess.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Is any process still a member of `pid`'s process group?
 *
 * POSIX only, and it is what turns "the child exited" into "the tree is gone".
 * Signal 0 performs the permission and existence checks without delivering
 * anything, so `kill(-pid, 0)` asks the kernel the one question that matters:
 * does that group still have members? `EPERM` is read as **alive** on purpose —
 * a group we may not signal is a group we certainly cannot claim to have
 * terminated.
 */
function posixGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until `pid`'s group is empty, or give up after `ms`. */
async function waitForPosixGroupGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + Math.max(0, ms);
  for (;;) {
    if (!posixGroupAlive(pid)) return true;
    if (Date.now() >= until) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10);
      timer.unref?.();
    });
  }
}

/** What a `taskkill /T` attempt established about the tree. */
type WindowsTreeKill = 'terminated' | 'not_found' | 'unconfirmed';

const WINDOWS_JOB_LAUNCHER = 'agent-relay-windows-job.exe';
const WINDOWS_JOB_MAX_CONFIRMED_EXIT_CODE = 239;

/** Whether the native launcher's exit is proof that its Job Object was empty. */
export function windowsJobExitConfirmsEmpty(exit: ManagedProcessExit): boolean {
  return (
    !exit.spawnFailed &&
    exit.signal === null &&
    exit.exitCode !== null &&
    exit.exitCode >= 0 &&
    exit.exitCode <= WINDOWS_JOB_MAX_CONFIRMED_EXIT_CODE
  );
}

/**
 * Locate the Agent Relay-owned launcher built by `scripts/build-native.mjs`.
 *
 * In tests this module is loaded from `src/main/adapters/process`, while the
 * production bundle and its copied launcher sit together under `out/main`.
 * Nothing is discovered from PATH: substituting another executable here would
 * turn a process-containment guarantee into an ambient machine setting.
 */
function windowsJobLauncher(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, WINDOWS_JOB_LAUNCHER),
    resolve(here, '..', '..', '..', '..', 'build', 'Release', WINDOWS_JOB_LAUNCHER)
  ];
  const launcher = candidates.find((candidate) => existsSync(candidate));
  if (launcher !== undefined) return launcher;
  throw new AgentRelayError(
    'TOOL_MISSING',
    'The Agent Relay Windows process-containment launcher is not built.',
    { remediation: 'Run npm install before starting Agent Relay.' }
  );
}

/**
 * Kill a process tree on Windows.
 *
 * This is the fail-closed legacy path for a ManagedProcess not rooted at Agent
 * Relay's Job Object launcher. Contained Windows runtimes use a private control
 * pipe instead and obtain their whole-tree evidence from the launcher exiting.
 * `taskkill` is spawned here rather than in the caller because this file is the
 * single child-process boundary — and with the same no-shell, hidden-window,
 * scrubbed-environment rules as everything else.
 *
 * There is deliberately no graceful step before it. Windows has no `SIGTERM`:
 * asking Node to "gracefully" stop the parent would terminate it outright and
 * orphan the very descendants `/T` exists to collect.
 *
 * Its **result is the tree evidence**, and the caller depends on it. Exit code 0
 * means every process `/T` walked was terminated; 128 means there was nothing by
 * that pid to walk; anything else — access denied, a partial failure, `taskkill`
 * itself missing or timing out — establishes nothing, and saying so is the only
 * way a descendant that survived can be reported instead of assumed away.
 */
async function killWindowsTree(pid: number, timeoutMs: number): Promise<WindowsTreeKill> {
  const taskkill = findOnPath('taskkill');
  if (taskkill === null) return 'unconfirmed';

  try {
    const result = await execa(taskkill, ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      timeout: Math.max(1, timeoutMs),
      stdin: 'ignore',
      env: scrubEnvironment(process.env, []),
      extendEnv: false,
      reject: false
    });
    if (result.exitCode === 0) return 'terminated';
    // 128 is "there is no running instance of the task": the pid is already
    // gone, which `/T` cannot distinguish from "and so are its children".
    return result.exitCode === 128 ? 'not_found' : 'unconfirmed';
  } catch {
    return 'unconfirmed';
  }
}

/**
 * A long-lived child and everything needed to supervise it safely.
 *
 * Kept private to this module: the only way to obtain one is
 * {@link ExecaProcessRunner.launch}, and the only thing handed back is the
 * narrow {@link ManagedProcess} interface.
 */
class ExecaManagedProcess implements ManagedProcess {
  readonly pid: number | null;
  readonly exited: Promise<ManagedProcessExit>;

  private readonly stdoutBuffer: BoundedBuffer;
  private readonly stderrBuffer: BoundedBuffer;
  private settledExit: ManagedProcessExit | null = null;
  /** The one cleanup. Every `stop` call after the first awaits this. */
  private stopping: Promise<ManagedProcessStopResult> | null = null;

  constructor(
    private readonly subprocess: ResultPromise,
    private readonly shutdownTimeoutMs: number,
    maxOutputBytes: number,
    private readonly windowsJobContained: boolean
  ) {
    this.pid = subprocess.pid ?? null;
    this.stdoutBuffer = new BoundedBuffer(maxOutputBytes);
    this.stderrBuffer = new BoundedBuffer(maxOutputBytes);

    // Both streams are drained continuously and separately. A server that fills
    // a pipe nobody reads blocks, and a blocked server never answers a health
    // check — which would present as a startup timeout with no explanation.
    this.drain('stdout', this.stdoutBuffer);
    this.drain('stderr', this.stderrBuffer);

    this.exited = subprocess.then(
      (result) => this.settle(toManagedExit(result)),
      (error) => this.settle(toManagedExit(error))
    );
  }

  running(): boolean {
    return this.settledExit === null;
  }

  output(): ManagedProcessOutput {
    return { stdout: this.stdoutBuffer.toString(), stderr: this.stderrBuffer.toString() };
  }

  stop(): Promise<ManagedProcessStopResult> {
    // Only a CONFIRMED stop is final.
    //
    // Caching every outcome made the first unconfirmed answer permanent: the
    // process might exit a moment later and every subsequent call would still
    // replay "could not be confirmed", so nothing could ever establish that the
    // tree was gone. Releasing the slot on an unconfirmed result lets a later
    // call look again, within the same bounded shutdown budget.
    //
    // Idempotence is unchanged where it matters. Concurrent callers still share
    // one in-flight attempt, because the slot is cleared only once that attempt
    // has settled; and a confirmed stop is remembered for ever, so a second kill
    // is never issued against a process already known to be gone.
    this.stopping ??= this.terminate().then((result) => {
      if (result.kind !== 'stopped') this.stopping = null;
      return result;
    });
    return this.stopping;
  }

  private settle(exit: ManagedProcessExit): ManagedProcessExit {
    this.settledExit = exit;
    return exit;
  }

  private drain(stream: 'stdout' | 'stderr', buffer: BoundedBuffer): void {
    void (async () => {
      try {
        for await (const raw of this.subprocess.iterable({ from: stream })) {
          // Redacted before retention, never after: what is kept is what a
          // caller may read, and a secret retained "temporarily" is retained.
          buffer.push(`${redactSecrets(String(raw))}\n`);
        }
      } catch {
        // The child ending mid-read is the ordinary case; `exited` reports it.
      }
    })();
  }

  /**
   * Terminate the **tree** within the shutdown budget, or admit that it did not.
   *
   * The parent exiting is not the answer to the question this method is asked.
   * A runtime spawns helpers, and a helper that outlives the process that
   * started it is exactly the orphan a supervised launch exists to prevent — so
   * `stopped` is returned only when the tree, not merely the child, has been
   * accounted for.
   *
   * The budget is split: half for a polite request, the remainder for force.
   * On Windows there is no polite request, so the whole budget goes to stopping
   * the Job Object launcher and observing its exit.
   */
  private async terminate(): Promise<ManagedProcessStopResult> {
    const pid = this.pid;
    if (pid === null) {
      // Never spawned. There is nothing to kill, but the exit still has to be
      // observed before this can honestly be called stopped.
      const exit = await settleWithin(this.exited, this.shutdownTimeoutMs);
      return exit === null
        ? { kind: 'unconfirmed', reason: 'The runtime process never started and never settled.' }
        : { kind: 'stopped', exit };
    }

    const budget = Math.max(1, this.shutdownTimeoutMs);
    const startedAt = Date.now();
    const remaining = (): number => Math.max(1, budget - (Date.now() - startedAt));
    const notGone: ManagedProcessStopResult = {
      kind: 'unconfirmed',
      reason: `The runtime process did not exit within ${budget}ms of being terminated.`
    };

    if (process.platform === 'win32') {
      // The launcher exits normally only after its Job Object is empty. This
      // remains proof even when the runtime itself crashed first: the kernel,
      // not a vanished parent pid, retained the descendants.
      if (this.windowsJobContained && this.settledExit !== null) {
        return windowsJobExitConfirmsEmpty(this.settledExit)
          ? { kind: 'stopped', exit: this.settledExit }
          : {
              kind: 'unconfirmed',
              reason: 'The Windows process-containment launcher exited without proving its Job Object empty.'
            };
      }

      if (this.windowsJobContained) {
        // stdin is a private control pipe to the launcher, not the runtime's
        // stdin. Closing it asks the launcher to terminate its Job Object and
        // wait until the kernel reports that object empty before exiting.
        // Therefore the launcher's exit is positive whole-tree evidence and
        // needs neither taskkill nor a pid-tree reconstruction.
        try {
          this.subprocess.stdin?.end();
        } catch {
          return {
            kind: 'unconfirmed',
            reason: 'The Windows process-containment launcher could not be asked to stop.'
          };
        }
        const exit = await settleWithin(this.exited, remaining());
        if (exit === null) return notGone;
        return windowsJobExitConfirmsEmpty(exit)
          ? { kind: 'stopped', exit }
          : {
              kind: 'unconfirmed',
              reason: 'The Windows process-containment launcher exited without proving its Job Object empty.'
            };
      }

      // For a legacy/non-contained handle, `/T` only proves a tree while its
      // parent is walkable. The Job Object launcher removes that crash gap; the
      // fallback stays fail-closed for the narrow ManagedProcess abstraction.
      const walkable = this.settledExit === null;
      // Almost the whole budget. Windows has no graceful phase to reserve time
      // for, and `taskkill` walking a tree is the expensive part by a wide
      // margin — once it reports back, the exit promise has usually settled
      // already. Splitting the budget evenly, as a POSIX-shaped implementation
      // would, only made the tree verdict expire on a slow machine and turned a
      // perfectly ordinary cleanup into an unconfirmed one.
      const tree = await killWindowsTree(pid, Math.max(1, budget - WINDOWS_EXIT_RESERVE_MS));

      if (this.settledExit === null) {
        try {
          this.subprocess.kill();
        } catch {
          // Already gone; the exit promise is the authority either way.
        }
      }

      // The taskkill attempt is part of—not additional to—the configured
      // shutdown deadline. Spend only what remains after it returns.
      const exit = await settleWithin(this.exited, remaining());
      if (exit === null) return notGone;
      if (!walkable || tree !== 'terminated') {
        return {
          kind: 'unconfirmed',
          reason: `The runtime process exited, but its process tree could not be confirmed terminated within ${budget}ms.`
        };
      }
      return { kind: 'stopped', exit };
    }

    signalPosixTree(pid, this.subprocess, 'SIGTERM');
    const afterTerm = await settleWithin(this.exited, Math.max(1, Math.floor(budget / 2)));
    // The parent exiting politely says nothing about a descendant that ignored
    // the same signal. The group is what is checked, and while it still has
    // members the escalation below happens whether or not the child is gone.
    if (afterTerm !== null && !posixGroupAlive(pid)) return { kind: 'stopped', exit: afterTerm };

    signalPosixTree(pid, this.subprocess, 'SIGKILL');

    const exit = afterTerm ?? (await settleWithin(this.exited, remaining()));
    if (exit === null) return notGone;

    return (await waitForPosixGroupGone(pid, remaining()))
      ? { kind: 'stopped', exit }
      : {
          kind: 'unconfirmed',
          reason: `A descendant of the runtime process was still alive ${budget}ms after the process tree was terminated.`
        };
  }
}

/**
 * Read an execa outcome — success, failure or spawn error — as a managed exit.
 *
 * `reject: false` means a non-zero exit resolves rather than throws, but a
 * genuine spawn failure can still arrive down either path, so both are folded
 * through here.
 */
function toManagedExit(value: unknown): ManagedProcessExit {
  const result = (value ?? {}) as {
    exitCode?: number;
    signal?: string;
    isTerminated?: boolean;
    failed?: boolean;
    code?: string;
  };

  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  const errorCode = typeof result.code === 'string' ? result.code.slice(0, 64) : null;

  return {
    exitCode,
    signal,
    // Nothing ran: no code, no signal, and the child was never terminated by us.
    spawnFailed:
      Boolean(result.failed) && exitCode === null && signal === null && !result.isTerminated,
    errorCode
  };
}

export class ExecaProcessRunner implements ProcessRunner, InteractiveProcessRunner, ManagedProcessRunner {
  /**
   * Start a server-shaped child and hand back a supervisor for it.
   *
   * Everything that makes {@link run} safe applies unchanged — same options
   * builder, same `shell: false`, same scrubbed environment, same redaction,
   * same bounded and separated output. Three things differ, and each is there
   * because a long-lived process is not a one-shot one:
   *
   *  * **No timeout.** execa's would kill the server out from under its
   *    supervisor at an arbitrary moment. Deadlines belong to the caller, which
   *    is the only party that knows whether it is starting up, health checking
   *    or inferring.
   *  * **stdin is `ignore`.** There is no protocol on it; the runtime is spoken
   *    to over loopback HTTP. Leaving it open would be a channel nobody owns.
   *  * **`detached` on POSIX.** It makes the child a process-group leader, which
   *    is what turns "kill the child" into "kill the tree".
   */
  launch(
    file: string,
    args: readonly string[],
    options: ManagedProcessOptions = {}
  ): ManagedProcess {
    assertSpawnable(file, args);

    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_MS;

    const base = baseExecaOptions({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.passthroughEnvNames === undefined
        ? {}
        : { passthroughEnvNames: options.passthroughEnvNames }),
      // 0 disables execa's timer. The provider owns every deadline.
      timeoutMs: 0
    });

    const windowsContained = process.platform === 'win32';
    const spawnFile = windowsContained ? windowsJobLauncher() : file;
    const spawnArgs = windowsContained ? [file, ...args] : [...args];
    const subprocess = execa(spawnFile, spawnArgs, {
      ...base,
      buffer: false,
      // On Windows this is a private control pipe consumed by the Job Object
      // launcher. The configured runtime itself receives NUL from the native
      // launcher. POSIX runtimes receive /dev/null directly.
      stdin: windowsContained ? 'pipe' : 'ignore',
      // On Windows the executable above is Agent Relay's Job Object launcher.
      // POSIX uses a detached process group for the equivalent containment.
      detached: process.platform !== 'win32',
      // execa's own escalation is redundant with the tree kill below and would
      // race it; termination is driven entirely by `ManagedProcess.stop`.
      forceKillAfterDelay: false
    });

    // Marks the promise as observed: `ExecaManagedProcess` attaches its own
    // handlers, but the window before that is enough for Node to complain.
    subprocess.catch(() => undefined);

    return new ExecaManagedProcess(subprocess, shutdownTimeoutMs, maxBytes, windowsContained);
  }

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

    return this.runBuffered(file, args, execaOptions, {
      maxBytes,
      maxStderrBytes: options.maxStderrBytes,
      startedAt,
      commandLabel
    });
  }

  private async runBuffered(
    file: string,
    args: readonly string[],
    execaOptions: Options,
    ctx: { maxBytes: number; maxStderrBytes?: number; startedAt: number; commandLabel: string }
  ): Promise<ProcessResult> {
    try {
      const result = await execa(file, [...args], {
        ...execaOptions,
        // One number caps both streams, as it always has; the object form only when stderr is given its own.
        maxBuffer:
          ctx.maxStderrBytes === undefined ? ctx.maxBytes : { stdout: ctx.maxBytes, stderr: ctx.maxStderrBytes }
      });

      return {
        command: ctx.commandLabel,
        exitCode: result.exitCode ?? null,
        stdout: redactSecrets(asText(result.stdout)),
        stderr: redactSecrets(asText(result.stderr)),
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.isCanceled),
        durationMs: Date.now() - ctx.startedAt,
        failed: Boolean(result.failed),
        // The runner resolves rather than throws on failure, so the cap is reported here too.
        ...(result.isMaxBuffer === true ? { outputLimitExceeded: true } : {})
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
  /** Set by execa when a stream exceeded `maxBuffer`. */
  isMaxBuffer?: boolean;
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
    failed: true,
    // Only ever set when true, so a result that did not hit the cap is byte-for-byte what it was.
    ...(failure.isMaxBuffer === true ? { outputLimitExceeded: true } : {})
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
