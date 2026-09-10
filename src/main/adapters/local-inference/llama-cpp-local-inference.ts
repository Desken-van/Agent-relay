/**
 * A bounded adapter for a llama.cpp-compatible inference server on loopback.
 *
 * What this owns: finding an executable, starting **one** process, proving that
 * process answers a health contract, sending **one** completion request, and
 * taking the whole process tree away again. What it does not own — and has no
 * method for — is anything Agent Relay owns: tasks, reviews, patches, retries,
 * approvals, publication. llama.cpp here is a replaceable local runtime behind a
 * typed internal port, not an agent.
 *
 * The properties worth stating outright, because each one is load-bearing:
 *
 *  * **Discovery is not health, and health is not inference.** A `--version`
 *    banner proves a file exists. A `/health` answer proves a process is
 *    listening. Only a validated completion proves inference works, and only
 *    that sets `inferenceVerified`.
 *  * **One POST per `infer`, ever.** After `fetch` has been called, every
 *    ambiguous ending — timeout, cancellation, dropped connection, crash,
 *    malformed body, overflow — is reported as `dispatchOutcome: 'unknown'` and
 *    stops there. The runtime may well have run the prompt; a second attempt
 *    would be a second inference, not a retry.
 *  * **A non-success can never carry a completion.** The outcome union has one
 *    member with a response in it.
 *  * **Nothing terminal is claimed on an unconfirmed kill.** A cancellation or a
 *    timeout becomes `cancelled`/`timed_out` only after the process tree is
 *    observed gone. If that cannot be confirmed, the state is `failed`.
 *  * **No shell, ever, and no request text in argv.** argv is built from
 *    validated construction-time configuration only; the prompt exists solely in
 *    an HTTP body.
 *
 * Deliberately not wired into `container.ts`: LOCAL-A has no approved settings
 * source and no UI, so there is nowhere legitimate for a configuration to come
 * from yet.
 */

import { randomBytes } from 'node:crypto';
import { AgentRelayError } from '../../../shared/domain/errors';
import {
  canLocalInferenceTransition,
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_HOST,
  LOCAL_INFERENCE_LIMITS,
  LOCAL_INFERENCE_PROTOCOL,
  LLAMA_SERVER_COMMAND,
  isShellDependentExecutable,
  localInferenceRequestSchema,
  localInferenceTransition,
  modelArgumentFor,
  parseLocalInferenceConfig,
  type LocalInferenceCapabilities,
  type LocalInferenceConfig,
  type LocalInferenceDispatchOutcome,
  type LocalInferenceEvent,
  type LocalInferenceFinishReason,
  type LocalInferenceOutcome,
  type LocalInferenceRequest,
  type LocalInferenceResponse,
  type LocalInferenceState
} from '../../../shared/domain/local-inference';
import { redactSecrets } from '../../../shared/util/redact';
import {
  unsafeProviderIdentity,
  unsafeProviderLocatorId,
  unsafeProviderProse
} from '../../../shared/util/provider-text';
import type { LocalInferenceProvider } from '../../ports';
import {
  launchFor,
  locateExecutable,
  type LocatedExecutable
} from '../process/executable-locator';
import type {
  ManagedProcess,
  ManagedProcessExit,
  ManagedProcessRunner,
  ProcessRunner
} from '../process/process-runner';

/** The adapter needs one-shot runs (`--version`) and one supervised server. */
export type LocalInferenceProcessRunner = ProcessRunner & ManagedProcessRunner;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LlamaCppLocalInferenceOptions {
  /** Injected in tests. Production uses the global `fetch`. */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/** How long to wait between startup health polls. */
const STARTUP_POLL_MS = 50;

/**
 * How much of a rejected response body is read before the socket is dropped.
 *
 * Small on purpose. It is drained so the connection can close cleanly, and it is
 * never parsed, never returned and never retained — a runtime that answers 500
 * has said everything that matters in the status line.
 */
const REJECTED_BODY_DRAIN_BYTES = 4096;

type TerminalKind = 'failed' | 'cancelled' | 'timed_out';
type TerminalEvents = Readonly<Record<TerminalKind, LocalInferenceEvent>>;

/** The state a terminal path settled into, and what the cleanup proved. */
interface Settlement {
  readonly state: LocalInferenceState;
  /**
   * Null when the process tree was confirmed gone — or when there was nothing
   * to terminate. Otherwise the bounded reason it could not be confirmed, which
   * is what forbids calling the operation a confirmed cancellation or timeout.
   */
  readonly unconfirmed: string | null;
}

/** Terminal events, grouped per operation so the three paths cannot diverge. */
const START_EVENTS: TerminalEvents = {
  failed: 'start_failed',
  cancelled: 'start_cancelled',
  timed_out: 'start_timed_out'
};

const HEALTH_EVENTS: TerminalEvents = {
  failed: 'health_failed',
  cancelled: 'health_cancelled',
  timed_out: 'health_timed_out'
};

const INFERENCE_EVENTS: TerminalEvents = {
  failed: 'inference_failed',
  cancelled: 'inference_cancelled',
  timed_out: 'inference_timed_out'
};

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Bounded, redacted, single-line diagnostic text. Never a body or an argv. */
function boundedReason(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length <= LOCAL_INFERENCE_LIMITS.reasonMax
    ? flat
    : `${flat.slice(0, LOCAL_INFERENCE_LIMITS.reasonMax - 1)}…`;
}

function terminalState(kind: TerminalKind, reason: string): LocalInferenceState {
  const safe = boundedReason(reason);
  if (kind === 'failed') return { kind: 'failed', reason: safe };
  if (kind === 'cancelled') return { kind: 'cancelled', reason: safe };
  return { kind: 'timed_out', reason: safe };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** A short opaque id for one started process. Safe as an identifier everywhere. */
function newInstanceId(): string {
  return `rt${randomBytes(8).toString('hex')}`;
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * A deadline that also honours any number of external cancellations.
 *
 * The two are kept apart deliberately: "the caller changed its mind" and "the
 * runtime took too long" produce different terminal states, and a single
 * `signal.aborted` check after the fact cannot tell them apart.
 */
class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly links: { signal: AbortSignal; handler: () => void }[] = [];
  private expired = false;

  constructor(timeoutMs: number, signals: readonly (AbortSignal | undefined)[]) {
    this.timer = setTimeout(() => {
      this.expired = true;
      this.controller.abort();
    }, Math.max(1, timeoutMs));
    this.timer.unref?.();

    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        this.controller.abort();
        continue;
      }
      const handler = (): void => this.controller.abort();
      signal.addEventListener('abort', handler, { once: true });
      this.links.push({ signal, handler });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get timedOut(): boolean {
    return this.expired;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted && !this.expired;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const { signal, handler } of this.links) signal.removeEventListener('abort', handler);
  }
}

type BoundedBody =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'error' };

/**
 * Read a response body, refusing to hold more than `limit` bytes of it.
 *
 * `response.text()` is deliberately not used anywhere in this file: it buffers
 * whatever arrives, so a runtime that answered with a gigabyte would be a
 * gigabyte in this process before any limit could be consulted. The stream is
 * cancelled at the first byte past the budget, and the partial text is thrown
 * away rather than parsed.
 */
async function readBoundedBody(response: Response, limit: number): Promise<BoundedBody> {
  const body = response.body;
  if (body === null) return { kind: 'ok', text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'overflow' };
      }
      chunks.push(value);
    }
  } catch {
    // A connection lost mid-body. Whatever arrived is a fragment, and a fragment
    // of JSON is not a smaller answer — it is no answer.
    await reader.cancel().catch(() => undefined);
    return { kind: 'error' };
  }

  try {
    return {
      kind: 'ok',
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    };
  } catch {
    // Replacing malformed bytes with U+FFFD would turn an invalid wire response
    // into different, apparently valid JSON. Fail the whole body instead.
    return { kind: 'error' };
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** A token count as reported: a nonnegative integer, absent, or unusable. */
function readTokenCount(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

/**
 * Map the runtime's `finish_reason` onto the typed union.
 *
 * Absent becomes `{ kind: 'unknown' }` and an unrecognised string becomes
 * `{ kind: 'other' }`. Neither becomes `stop`, which is the value a caller would
 * read as "this completion is whole".
 */
function readFinishReason(value: unknown): LocalInferenceFinishReason | 'invalid' {
  if (value === undefined || value === null) return { kind: 'unknown' };
  if (typeof value !== 'string') return 'invalid';

  switch (value) {
    case 'stop':
      return { kind: 'stop' };
    case 'length':
      return { kind: 'length' };
    case 'content_filter':
      return { kind: 'content_filter' };
    case 'tool_calls':
      return { kind: 'tool_calls' };
    default:
      break;
  }

  if (value.length === 0) return 'invalid';
  return unsafeProviderIdentity(value, LOCAL_INFERENCE_LIMITS.finishReasonMax) === null
    ? { kind: 'other', reason: value }
    : 'invalid';
}

/** Everything a parsed completion contributes, before identity is attached. */
interface ParsedCompletion {
  readonly completion: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly runtimeResponseId: string | null;
  readonly finishReason: LocalInferenceFinishReason;
}

type CompletionParse =
  | { readonly ok: true; readonly value: ParsedCompletion }
  | { readonly ok: false; readonly reason: string };

/** A usable runtime executable, or a bounded reason there is not one. */
type ExecutableResolution =
  | { readonly kind: 'found'; readonly located: LocatedExecutable }
  | { readonly kind: 'unusable'; readonly reason: string };

type VersionProbe =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timed_out' };

/**
 * Read an OpenAI-compatible chat completion, defensively.
 *
 * llama.cpp adds fields of its own (timings, slot ids, and more with every
 * release), so unknown properties are ignored rather than refused. What is not
 * tolerated is anything that would let a partial or unintelligible answer be
 * reported as a completion: more or fewer than one choice, a missing or
 * non-string content, a token count that is not a count, a finish reason that is
 * not a string.
 */
export function parseCompletion(text: string, maxCompletionBytes: number): CompletionParse {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The runtime returned a response that is not valid JSON.' };
  }

  const root = asRecord(payload);
  if (root === null) {
    return { ok: false, reason: 'The runtime returned a response that is not a JSON object.' };
  }

  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return {
      ok: false,
      reason: 'The runtime returned a response without exactly one completion choice.'
    };
  }

  const choice = asRecord(choices[0]);
  const message = choice === null ? null : asRecord(choice.message);
  const content = message === null ? undefined : message.content;
  if (typeof content !== 'string') {
    return { ok: false, reason: 'The runtime returned a choice without text content.' };
  }

  // The runtime's text—not a potentially shorter redacted replacement—must fit
  // the completion budget. Redaction then happens before anything is returned
  // to a caller that may store it.
  if (Buffer.byteLength(content, 'utf8') > maxCompletionBytes) {
    return {
      ok: false,
      reason: `The completion exceeded the ${maxCompletionBytes}-byte limit; no partial text is reported.`
    };
  }
  const completion = redactSecrets(content);
  // Prose may wrap; an escape sequence in text that is later rendered may not.
  // Delegated to the repository's rule rather than restated here, so this check
  // cannot drift from the one every other provider-supplied string obeys. Its
  // credential half is already satisfied by the redaction above, and its
  // character bound is weaker than the byte bound just applied.
  const unsafe = unsafeProviderProse(completion, maxCompletionBytes);
  if (unsafe !== null) {
    return { ok: false, reason: `The completion is not safe to store: ${unsafe}.` };
  }

  const finishReason = readFinishReason(choice?.finish_reason);
  if (finishReason === 'invalid') {
    return { ok: false, reason: 'The runtime reported an unusable finish reason.' };
  }

  const usage = root.usage === undefined || root.usage === null ? null : asRecord(root.usage);
  if (root.usage !== undefined && root.usage !== null && usage === null) {
    return { ok: false, reason: 'The runtime reported usage that is not an object.' };
  }
  const promptTokens = readTokenCount(usage?.prompt_tokens);
  const completionTokens = readTokenCount(usage?.completion_tokens);
  if (promptTokens === 'invalid' || completionTokens === 'invalid') {
    return { ok: false, reason: 'The runtime reported an invalid token count.' };
  }

  let runtimeResponseId: string | null = null;
  if (root.id !== undefined && root.id !== null) {
    if (
      typeof root.id !== 'string' ||
      unsafeProviderLocatorId(root.id, LOCAL_INFERENCE_LIMITS.runtimeResponseIdMax) !== null
    ) {
      return { ok: false, reason: 'The runtime returned an unusable response id.' };
    }
    runtimeResponseId = root.id;
  }

  if (
    root.model !== undefined &&
    root.model !== null &&
    (typeof root.model !== 'string' ||
      unsafeProviderIdentity(root.model, LOCAL_INFERENCE_LIMITS.runtimeModelIdMax) !== null)
  ) {
    return { ok: false, reason: 'The runtime returned an unusable model identity.' };
  }

  return {
    ok: true,
    value: { completion, promptTokens, completionTokens, runtimeResponseId, finishReason }
  };
}

/** What one bounded `/health` request established. */
type HealthProbe =
  | { readonly kind: 'ok' }
  /** Reachable, but not yet answering the health contract. Retryable. */
  | { readonly kind: 'not_ready'; readonly reason: string }
  /** Answered 2xx with a body that is not a health envelope. Not retryable. */
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'transport'; readonly reason: string }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'cancelled' };

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export class LlamaCppLocalInference implements LocalInferenceProvider {
  private readonly config: LocalInferenceConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  /** Built once at construction, so later mutation of the input cannot move it. */
  private readonly runtimeArgv: readonly string[];

  private current: LocalInferenceState = { kind: 'stopped' };
  private managed: ManagedProcess | null = null;
  /**
   * A runtime this provider tried to terminate and could not confirm is gone.
   *
   * Ownership is NOT released on an unconfirmed cleanup. The handle used to be
   * dropped as soon as the kill returned, which reads as "we are done with it"
   * — but an unconfirmed kill means the opposite: the process may still be
   * alive, still holding the port, still answering. Dropping the reference then
   * left nothing able to say so, and because the state became `failed` — from
   * which `start` is legal — the very next start launched a second runtime
   * beside the first.
   *
   * So the process stays here until a cleanup confirms it ended. While it does,
   * `start` is refused and `stop` re-attempts THIS process rather than
   * reporting success because the current handle happens to be null.
   */
  private unretired: ManagedProcess | null = null;
  private runtimeInstanceId: string | null = null;
  /**
   * The version established for the runtime that is currently supervised.
   *
   * Kept apart from {@link probedRuntimeVersion} deliberately. A capability
   * probe is a fresh `--version` run of a file on disk, and it can fail for
   * reasons that have nothing to do with the process already running — the file
   * replaced by an upgrade, a machine briefly out of handles. Folding the two
   * together let one such failure erase the identity a started runtime had
   * already proved, and the next completed response then carried
   * `runtimeVersion: null` for a runtime whose version was known.
   */
  private instanceRuntimeVersion: string | null = null;
  /** What the most recent capability probe read, if anything. */
  private probedRuntimeVersion: string | null = null;
  private inferenceVerified = false;

  /**
   * Aborted by `stop`, so an in-flight startup, health check or inference can
   * never come back and answer for a runtime that is already gone.
   */
  private operation: AbortController | null = null;
  /**
   * Bumped whenever ownership of the runtime changes hands.
   *
   * Every asynchronous path captures it before awaiting and checks it after. A
   * late HTTP answer or a late process exit belonging to a superseded generation
   * is dropped rather than written over a terminal state.
   */
  private generation = 0;
  /** The one in-flight cleanup. Concurrent `stop` calls await this. */
  private stopping: Promise<LocalInferenceState> | null = null;

  constructor(
    private readonly runner: LocalInferenceProcessRunner,
    config: unknown,
    options: LlamaCppLocalInferenceOptions = {}
  ) {
    this.config = parseLocalInferenceConfig(config);
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? ((): number => Date.now());
    this.runtimeArgv = Object.freeze(buildRuntimeArgv(this.config));
  }

  /** The argv this provider would launch. Exposed for diagnostics and tests. */
  get argv(): readonly string[] {
    return this.runtimeArgv;
  }

  state(): LocalInferenceState {
    return this.current;
  }

  /* ------------------------------------------------------------------ */
  /* Capabilities                                                        */
  /* ------------------------------------------------------------------ */

  async capabilities(signal?: AbortSignal): Promise<LocalInferenceCapabilities> {
    const resolved = this.resolveExecutable();
    if (resolved.kind !== 'found') {
      // Only when nothing is running. Discovery failing while a process is up
      // says something about PATH, not about the process.
      if (
        this.unretired === null &&
        canLocalInferenceTransition(this.current.kind, 'discovery_failed')
      ) {
        this.apply('discovery_failed', { kind: 'unavailable', reason: resolved.reason });
      }
      return this.describe(false, resolved.reason, null);
    }

    const probe = await this.probeVersion(resolved.located, this.config.healthTimeoutMs, [signal]);
    this.probedRuntimeVersion = probe.kind === 'ok' ? probe.version : null;
    return this.describe(true, null, resolved.located.source);
  }

  private describe(
    available: boolean,
    unavailableReason: string | null,
    executableSource: LocatedExecutable['source'] | null
  ): LocalInferenceCapabilities {
    return {
      protocol: LOCAL_INFERENCE_PROTOCOL,
      contractVersion: LOCAL_INFERENCE_CONTRACT_VERSION,
      providerId: this.config.providerId,
      modelId: this.config.model.id,
      available,
      unavailableReason,
      executableSource,
      // A supervised runtime's established version outranks a probe that has
      // just been run against a file on disk: the process being described is
      // the one that is running, not the one that would be launched now.
      runtimeVersion: this.instanceRuntimeVersion ?? this.probedRuntimeVersion,
      supportsChatCompletions: true,
      // LOCAL-A sends `stream: false` and has no incremental path at all.
      supportsStreaming: false,
      supportsUsageWhenReported: true,
      supportsChatTemplateParameters: true,
      // Never set by discovery or by a version banner. See `infer`.
      inferenceVerified: this.inferenceVerified
    };
  }

  /**
   * Resolve the runtime executable, or say why it cannot be used.
   *
   * Two refusals, both before anything is probed or launched:
   *
   *  * A configured path that is not there stops here. It must never fall back
   *    to PATH — that is `locateExecutable`'s documented behaviour, and it is
   *    the reason discovery is expressed as a discriminated union rather than an
   *    optional override.
   *  * A path that names a command shim or a script is refused even though it
   *    exists. `findOnPath` honours `PATHEXT`, so a `llama-server.cmd` earlier
   *    on PATH than any real binary is a perfectly ordinary thing for it to
   *    return — and running one means running `cmd.exe`. `launchFor` only
   *    rewrites JavaScript entry points, so nothing below this line would have
   *    caught it.
   */
  private resolveExecutable(): ExecutableResolution {
    const executable = this.config.executable;
    const located =
      executable.kind === 'explicit_path'
        ? locateExecutable(LLAMA_SERVER_COMMAND, { configuredPath: executable.path })
        : locateExecutable(LLAMA_SERVER_COMMAND);

    if (located === null) return { kind: 'unusable', reason: this.missingExecutableReason() };
    if (isShellDependentExecutable(located.path)) {
      return {
        kind: 'unusable',
        reason:
          'The local inference executable that was found is a command shim or script, and Agent Relay never launches one.'
      };
    }
    return { kind: 'found', located };
  }

  /** Never names the path that was tried: state and capabilities are retained. */
  private missingExecutableReason(): string {
    return this.config.executable.kind === 'explicit_path'
      ? 'The configured local inference executable is not present.'
      : `${LLAMA_SERVER_COMMAND} was not found.`;
  }

  /**
   * One bounded `--version` run.
   *
   * Capability inspection only. It starts nothing, listens on nothing, and its
   * success is not evidence about inference — see the class comment.
   */
  private async probeVersion(
    located: LocatedExecutable,
    timeoutMs: number,
    signals: readonly (AbortSignal | undefined)[]
  ): Promise<VersionProbe> {
    const launch = launchFor(located.path);
    const deadline = new Deadline(timeoutMs, signals);
    let result;
    try {
      result = await this.runner.run(launch.file, [...launch.prefixArgs, '--version'], {
        // The same directory the runtime would be launched in, so a probe and a
        // launch cannot disagree about where the runtime is standing.
        ...(this.config.workingDirectory === undefined
          ? {}
          : { cwd: this.config.workingDirectory }),
        timeoutMs,
        maxOutputBytes: this.config.maxProcessOutputBytes,
        env: launch.env,
        signal: deadline.signal
      });
    } catch {
      return { kind: 'failed', reason: 'The runtime version probe could not be launched.' };
    } finally {
      deadline.dispose();
    }

    if (deadline.timedOut || result.timedOut) return { kind: 'timed_out' };
    if (deadline.cancelled || result.cancelled) return { kind: 'cancelled' };
    if (result.exitCode !== 0) {
      return { kind: 'failed', reason: 'The runtime version probe did not succeed.' };
    }

    // llama.cpp prints its banner to stderr on some builds and stdout on others.
    const line = firstNonEmptyLine(`${result.stdout}\n${result.stderr}`);
    if (
      line === null ||
      unsafeProviderIdentity(line, LOCAL_INFERENCE_LIMITS.runtimeVersionMax) !== null
    ) {
      return { kind: 'failed', reason: 'The runtime version probe returned an invalid identity.' };
    }
    return { kind: 'ok', version: line };
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  async start(signal?: AbortSignal): Promise<LocalInferenceState> {
    // Checked before anything is located or launched: a refused start must leave
    // no process behind and no request sent.
    this.assertAllowed('start_requested');

    // The state machine permits `failed -> starting`, and it should: a runtime
    // that failed cleanly may be started again. What it cannot see is whether
    // the previous runtime is actually gone. An unconfirmed termination is not
    // a clean failure, and starting on top of it is how two live runtimes end
    // up sharing one port — so this is refused here, above the machine, on the
    // one piece of evidence the machine does not carry.
    if (this.unretired !== null) {
      throw new AgentRelayError(
        'BUSY',
        'The previous runtime could not be confirmed stopped, so a new one must not be started beside it.',
        {
          remediation:
            'Stop the provider again to re-attempt the cleanup. Starting is refused until one confirms the previous process ended.'
        }
      );
    }

    const resolved = this.resolveExecutable();
    if (resolved.kind !== 'found') {
      return this.apply('discovery_failed', { kind: 'unavailable', reason: resolved.reason });
    }
    const located = resolved.located;

    const runtimeInstanceId = newInstanceId();
    this.apply('start_requested', { kind: 'starting', runtimeInstanceId });
    const generation = ++this.generation;
    const operation = new AbortController();
    this.operation = operation;
    this.runtimeInstanceId = runtimeInstanceId;

    // Startup includes one capability probe in its overall budget. Finding an
    // executable is not enough: before supervising it as a compatible runtime,
    // require one bounded, safe version identity from that exact file.
    const deadline = this.now() + this.config.startupTimeoutMs;
    const versionProbe = await this.probeVersion(
      located,
      Math.max(1, deadline - this.now()),
      [signal, operation.signal]
    );
    if (!this.owns(generation)) return this.current;
    switch (versionProbe.kind) {
      case 'ok':
        // The identity this instance is entitled to report for as long as it
        // runs. A later capability probe cannot take it away.
        this.instanceRuntimeVersion = versionProbe.version;
        this.probedRuntimeVersion = versionProbe.version;
        break;
      case 'cancelled':
        return this.settle(generation, 'cancelled', START_EVENTS, 'Startup was cancelled.');
      case 'timed_out':
        return this.settle(
          generation,
          'timed_out',
          START_EVENTS,
          `The runtime version probe exceeded the startup budget.`
        );
      case 'failed':
        return this.settle(generation, 'failed', START_EVENTS, versionProbe.reason);
    }

    if (deadline - this.now() <= 0) {
      return this.settle(
        generation,
        'timed_out',
        START_EVENTS,
        `The runtime did not become healthy within ${this.config.startupTimeoutMs}ms.`
      );
    }

    const launch = launchFor(located.path);
    let managed: ManagedProcess;
    try {
      managed = this.runner.launch(launch.file, [...launch.prefixArgs, ...this.runtimeArgv], {
        ...(this.config.workingDirectory === undefined
          ? {}
          : { cwd: this.config.workingDirectory }),
        env: launch.env,
        maxOutputBytes: this.config.maxProcessOutputBytes,
        shutdownTimeoutMs: this.config.shutdownTimeoutMs
      });
    } catch {
      // The runner refused to spawn at all. Nothing exists to clean up, but the
      // state must not be left claiming a startup is in progress.
      this.retireInstance();
      return this.apply(
        'start_failed',
        terminalState('failed', 'The runtime process could not be launched.')
      );
    }
    this.managed = managed;
    this.watchForUnexpectedExit(managed, generation);

    for (;;) {
      if (!this.owns(generation)) return this.current;

      if (!managed.running()) {
        const exit = await managed.exited;
        return this.settle(generation, 'failed', START_EVENTS, exitReason(exit));
      }
      if (signal?.aborted === true || operation.signal.aborted) {
        return this.settle(generation, 'cancelled', START_EVENTS, 'Startup was cancelled.');
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return this.settle(
          generation,
          'timed_out',
          START_EVENTS,
          `The runtime did not become healthy within ${this.config.startupTimeoutMs}ms.`
        );
      }

      // Each attempt is bounded by the health timeout *or* whatever is left of
      // the startup budget, whichever is smaller. Two independent bounds, and
      // neither can be spent by the other.
      const probe = await this.probeHealth(Math.min(this.config.healthTimeoutMs, remaining), [
        signal,
        operation.signal
      ]);
      if (!this.owns(generation)) return this.current;

      switch (probe.kind) {
        case 'ok':
          if (!managed.running()) {
            const exit = await managed.exited;
            return this.settle(generation, 'failed', START_EVENTS, exitReason(exit));
          }
          return this.apply('started_healthy', { kind: 'healthy', runtimeInstanceId });
        case 'malformed':
          // A 2xx that is not a health envelope is a different program, or a
          // broken one. Polling it again would only spend the budget.
          return this.settle(generation, 'failed', START_EVENTS, probe.reason);
        case 'cancelled':
          return this.settle(generation, 'cancelled', START_EVENTS, 'Startup was cancelled.');
        case 'not_ready':
        case 'transport':
        case 'timed_out':
          // All ordinary while a server is still binding or loading weights.
          break;
      }

      await delay(Math.min(STARTUP_POLL_MS, Math.max(0, deadline - this.now())));
    }
  }

  /**
   * A managed process that ends while nothing is watching for it.
   *
   * Only from `healthy`. During `starting` and `inferring` the operation that
   * owns the runtime detects the exit itself and reports it with the context it
   * has; a second reporter would race that one and would sometimes win.
   */
  private watchForUnexpectedExit(managed: ManagedProcess, generation: number): void {
    void managed.exited.then(async (exit) => {
      if (!this.owns(generation)) return;
      // An operation may intentionally detach the handle before awaiting
      // cleanup. Its own terminal transition remains authoritative; the exit
      // watcher must only report a process that was still provider-owned when
      // it ended unexpectedly.
      if (this.managed !== managed) return;
      if (this.current.kind !== 'healthy') return;

      // The parent being gone does not prove its helpers are gone. Run the same
      // idempotent tree cleanup used by every explicit terminal path before
      // making the unexpected exit authoritative.
      const cleanup = await managed.stop();
      if (!this.owns(generation) || this.managed !== managed) return;
      if (this.current.kind !== 'healthy') return;
      this.managed = null;
      this.retireInstance();
      // The parent is gone, but this cleanup is what speaks for its children.
      // Unconfirmed means a descendant may still be running, so the handle is
      // kept and the next start is refused until a stop confirms otherwise.
      if (cleanup.kind !== 'stopped') this.unretired = managed;
      const reason =
        cleanup.kind === 'stopped' ? exitReason(exit) : `${exitReason(exit)} ${cleanup.reason}`;
      this.apply('process_exited', terminalState('failed', reason));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Health                                                              */
  /* ------------------------------------------------------------------ */

  async health(signal?: AbortSignal): Promise<LocalInferenceState> {
    // Legal only while healthy — and refused before any request is sent.
    this.assertAllowed('health_checked');

    const generation = this.generation;
    const runtimeInstanceId = this.runtimeInstanceId;
    const managed = this.managed;
    const probe = await this.probeHealth(this.config.healthTimeoutMs, [
      signal,
      this.operation?.signal
    ]);
    if (!this.owns(generation)) return this.current;
    if (this.current.kind !== 'healthy') return this.current;

    switch (probe.kind) {
      case 'ok':
        return runtimeInstanceId === null || managed === null || !managed.running()
          ? this.settle(
              generation,
              'failed',
              HEALTH_EVENTS,
              'The runtime answered but is no longer identified.'
            )
          : this.apply('health_checked', { kind: 'healthy', runtimeInstanceId });
      case 'timed_out':
        return this.settle(
          generation,
          'timed_out',
          HEALTH_EVENTS,
          `The health check did not answer within ${this.config.healthTimeoutMs}ms.`
        );
      case 'cancelled':
        return this.settle(
          generation,
          'cancelled',
          HEALTH_EVENTS,
          'The health check was cancelled.'
        );
      case 'not_ready':
      case 'malformed':
      case 'transport':
        return this.settle(generation, 'failed', HEALTH_EVENTS, probe.reason);
    }
  }

  /**
   * One bounded GET against the fixed loopback health endpoint.
   *
   * The only thing that can produce `ok` is a 2xx whose bounded JSON body is an
   * object with `status` exactly `"ok"`. Additional fields are fine — llama.cpp
   * reports slot counts — but nothing is ever inferred from the process being
   * alive, from a log line, or from the port merely accepting a connection.
   */
  private async probeHealth(
    timeoutMs: number,
    signals: readonly (AbortSignal | undefined)[]
  ): Promise<HealthProbe> {
    const deadline = new Deadline(timeoutMs, signals);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.urlFor('/health'), {
          method: 'GET',
          // The local runtime is an address, not a destination to be negotiated.
          // Without this, a 3xx from whatever is listening on the configured
          // port sends the next request somewhere this provider never chose —
          // and `redirect: 'error'` refuses BEFORE that second request is put on
          // the wire, which is the only place the refusal is worth anything.
          // Inspecting `response.url` afterwards would be reading about a leak
          // that had already happened.
          redirect: 'error',
          signal: deadline.signal
        });
      } catch {
        if (deadline.timedOut) return { kind: 'timed_out' };
        if (deadline.cancelled) return { kind: 'cancelled' };
        return { kind: 'transport', reason: 'The runtime health endpoint could not be reached.' };
      }

      if (!response.ok) {
        await readBoundedBody(response, REJECTED_BODY_DRAIN_BYTES);
        return {
          kind: 'not_ready',
          reason: `The runtime health endpoint answered HTTP ${response.status}.`
        };
      }

      const body = await readBoundedBody(
        response,
        Math.min(this.config.maxResponseBytes, REJECTED_BODY_DRAIN_BYTES * 16)
      );
      if (body.kind === 'overflow') {
        return {
          kind: 'malformed',
          reason: 'The runtime health response was too large to be one.'
        };
      }
      if (body.kind === 'error') {
        if (deadline.timedOut) return { kind: 'timed_out' };
        if (deadline.cancelled) return { kind: 'cancelled' };
        return { kind: 'transport', reason: 'The runtime health response was cut short.' };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return {
          kind: 'malformed',
          reason: 'The runtime health endpoint returned a body that is not valid JSON.'
        };
      }
      const record = asRecord(parsed);
      if (record === null) {
        return {
          kind: 'malformed',
          reason: 'The runtime health endpoint returned a body that is not a JSON object.'
        };
      }
      if (record.status === 'ok') return { kind: 'ok' };

      // `{"status":"loading model"}` is what llama.cpp says while it warms up.
      return { kind: 'not_ready', reason: 'The runtime is not reporting status "ok".' };
    } finally {
      deadline.dispose();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inference                                                           */
  /* ------------------------------------------------------------------ */

  async infer(
    request: LocalInferenceRequest,
    signal?: AbortSignal
  ): Promise<LocalInferenceOutcome> {
    // The whole request is validated before the state moves and before anything
    // is sent, so a malformed request cannot leave the provider mid-inference.
    const parsed = this.parseRequest(request);
    this.assertAllowed('inference_started');

    const runtimeInstanceId = this.runtimeInstanceId;
    const managed = this.managed;
    // The version is part of the identity a completed response must carry, and
    // a successful start is what establishes it — so its absence here means the
    // runtime is not identified, not that the field is optional.
    const runtimeVersion = this.instanceRuntimeVersion;
    if (runtimeInstanceId === null || managed === null || runtimeVersion === null) {
      return failure(
        'failed',
        parsed.requestId,
        'not_dispatched',
        'The provider has no identified runtime to infer against.'
      );
    }

    const promptBytes = parsed.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
      0
    );
    if (promptBytes > this.config.maxPromptBytes) {
      return failure(
        'failed',
        parsed.requestId,
        'not_dispatched',
        `The prompt is ${promptBytes} bytes, over the ${this.config.maxPromptBytes}-byte limit.`
      );
    }

    // A request may only ever lower the configured cap, never raise it.
    const maxTokens = Math.min(
      parsed.maxOutputTokens ?? this.config.maxOutputTokens,
      this.config.maxOutputTokens
    );
    const bodyText = JSON.stringify({
      model: this.config.model.id,
      messages: parsed.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      stream: false,
      n: 1,
      max_tokens: maxTokens,
      // Present only when supplied. `false` and `0` travel unchanged: they are
      // values, and a template parameter that means "off" has to arrive as off.
      ...(parsed.chatTemplateParameters === undefined
        ? {}
        : { chat_template_kwargs: parsed.chatTemplateParameters })
    });

    const requestBytes = Buffer.byteLength(bodyText, 'utf8');
    if (requestBytes > this.config.maxRequestBytes) {
      return failure(
        'failed',
        parsed.requestId,
        'not_dispatched',
        `The request body is ${requestBytes} bytes, over the ${this.config.maxRequestBytes}-byte limit.`
      );
    }

    this.apply('inference_started', {
      kind: 'inferring',
      runtimeInstanceId,
      requestId: parsed.requestId
    });
    const generation = this.generation;
    const startedAt = this.now();
    const deadline = new Deadline(this.config.inferenceTimeoutMs, [signal, this.operation?.signal]);

    try {
      let response: Response;
      try {
        // The one and only dispatch. There is no loop around this call, no
        // fallback model and no restart: everything below reports what happened.
        response = await this.fetchImpl(this.urlFor('/v1/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: bodyText,
          // Same boundary, and it matters more here: the body is the prompt. A
          // followed redirect would hand the whole prompt to a second address
          // and then report its answer as this runtime's completion. Refused
          // before that request is sent, so the other address receives nothing.
          //
          // Note what this does NOT claim. The first server already received
          // the POST — it had to, in order to answer 3xx — so refusing the
          // redirect is not evidence that nothing was processed. The failure
          // therefore travels the ambiguous path below and is recorded with an
          // `unknown` disposition, never as "not dispatched", and the request is
          // not repeated anywhere.
          redirect: 'error',
          signal: deadline.signal
        });
      } catch {
        return await this.abandon(
          generation,
          parsed.requestId,
          deadline,
          'The inference request did not complete.'
        );
      }

      if (!response.ok) {
        await readBoundedBody(response, REJECTED_BODY_DRAIN_BYTES);
        // The runtime answered and refused. That is the one post-dispatch
        // failure that is *not* ambiguous, so it is `rejected`, not `unknown`.
        return await this.concludeFailure(
          generation,
          parsed.requestId,
          'failed',
          'rejected',
          `The runtime rejected the inference request with HTTP ${response.status}.`
        );
      }

      const body = await readBoundedBody(response, this.config.maxResponseBytes);
      if (body.kind === 'overflow') {
        return await this.concludeFailure(
          generation,
          parsed.requestId,
          'failed',
          'unknown',
          `The response exceeded the ${this.config.maxResponseBytes}-byte limit and was discarded.`
        );
      }
      if (body.kind === 'error') {
        return await this.abandon(
          generation,
          parsed.requestId,
          deadline,
          'The inference response was cut short.'
        );
      }

      const parsedBody = parseCompletion(body.text, this.config.maxCompletionBytes);
      if (!parsedBody.ok) {
        return await this.concludeFailure(
          generation,
          parsed.requestId,
          'failed',
          'unknown',
          parsedBody.reason
        );
      }

      if (!this.owns(generation)) {
        // Stopped while this was in flight. The answer is real, but the runtime
        // it belongs to is gone and the terminal state must not be overwritten.
        return await this.supersededInference(
          generation,
          parsed.requestId,
          'The provider was stopped while the request was in flight.'
        );
      }

      if (!managed.running()) {
        return await this.concludeFailure(
          generation,
          parsed.requestId,
          'failed',
          'unknown',
          'The runtime exited before the completion could be accepted.'
        );
      }

      const built: LocalInferenceResponse = {
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: parsed.requestId,
        providerId: this.config.providerId,
        // The stable configured id, never the model path.
        modelId: this.config.model.id,
        runtimeVersion,
        runtimeInstanceId,
        durationMs: Math.max(0, Math.round(this.now() - startedAt)),
        ...parsedBody.value
      };

      this.inferenceVerified = true;
      this.apply('inference_completed', { kind: 'healthy', runtimeInstanceId });
      return { kind: 'completed', version: LOCAL_INFERENCE_CONTRACT_VERSION, response: built };
    } finally {
      deadline.dispose();
    }
  }

  private parseRequest(request: LocalInferenceRequest): LocalInferenceRequest {
    const result = localInferenceRequestSchema.safeParse(request);
    if (result.success) return result.data;
    throw new AgentRelayError('VALIDATION_FAILED', 'The local inference request is not valid.', {
      details: boundedReason(
        result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      )
    });
  }

  /**
   * An inference that ended without an answer, after the POST went out.
   *
   * Timeout and cancellation are told apart from the deadline, not guessed from
   * the exception — and everything here is `dispatchOutcome: 'unknown'`, because
   * the runtime may have processed the prompt regardless.
   */
  private async abandon(
    generation: number,
    requestId: string,
    deadline: Deadline,
    reason: string
  ): Promise<LocalInferenceOutcome> {
    const kind: TerminalKind = deadline.timedOut
      ? 'timed_out'
      : deadline.cancelled
        ? 'cancelled'
        : 'failed';
    const detail = deadline.timedOut
      ? `${reason} It exceeded the ${this.config.inferenceTimeoutMs}ms inference timeout.`
      : deadline.cancelled
        ? `${reason} It was cancelled.`
        : reason;
    return this.concludeFailure(generation, requestId, kind, 'unknown', detail);
  }

  /**
   * Report a non-completed inference and take the runtime down with it.
   *
   * The runtime is terminated rather than reused: an inference that ended
   * ambiguously may still be running inside it, and the next request would be
   * queued behind work nobody is waiting for. Coming back requires an explicit
   * `start` — the provider never restarts itself.
   *
   * **The outcome and the state agree.** When the process tree could not be
   * confirmed gone, {@link settle} downgrades the state to `failed`, and this
   * downgrades the outcome with it. An earlier version kept the kind the caller
   * experienced — reasoning that "what happened to the request" and "what
   * happened to the cleanup" are two different facts — and that is true but
   * beside the point: `cancelled` and `timed_out` are this contract's way of
   * saying the operation is *finished*, and an operation whose runtime may still
   * be executing the prompt is not finished. The reason text carries both facts,
   * and `dispatchOutcome` is untouched: still `unknown`, still never a licence
   * to send a second request.
   */
  private async concludeFailure(
    generation: number,
    requestId: string,
    kind: TerminalKind,
    dispatchOutcome: LocalInferenceDispatchOutcome,
    reason: string
  ): Promise<LocalInferenceOutcome> {
    if (!this.owns(generation)) {
      return this.supersededInference(generation, requestId, reason);
    }
    const settlement = await this.settleTree(generation, kind, INFERENCE_EVENTS, reason);
    return settlement.unconfirmed === null
      ? failure(kind, requestId, dispatchOutcome, reason)
      : failure('failed', requestId, dispatchOutcome, `${reason} ${settlement.unconfirmed}`);
  }

  /**
   * Finish an inference superseded by an explicit stop.
   *
   * The stop owns the process handle and therefore owns the cleanup evidence.
   * An inference from the previous generation must join that same promise: it
   * may report cancellation only after the stop proved the tree gone, and must
   * report failure when the cleanup remained unconfirmed.
   */
  private async supersededInference(
    generation: number,
    requestId: string,
    reason: string
  ): Promise<LocalInferenceOutcome> {
    const inFlight = this.stopping;
    const state = inFlight === null ? this.current : await inFlight;
    const confirmed = state.kind === 'stopped';
    const detail = confirmed
      ? reason
      : `${reason} The runtime process tree could not be confirmed stopped.`;
    // The generation is deliberately named in the signature: this helper is
    // only valid for an operation already superseded by the current owner.
    if (this.owns(generation)) {
      return failure('failed', requestId, 'unknown', detail);
    }
    return failure(confirmed ? 'cancelled' : 'failed', requestId, 'unknown', detail);
  }

  /* ------------------------------------------------------------------ */
  /* Stop                                                                */
  /* ------------------------------------------------------------------ */

  async stop(): Promise<LocalInferenceState> {
    const inFlight = this.stopping;
    // Concurrent callers share one cleanup: nothing is ever killed twice.
    if (inFlight !== null) return inFlight;

    const kind = this.current.kind;
    // Idempotent: nothing to launch, nothing to kill, no request to send.
    if (
      (kind === 'stopped' || kind === 'unavailable') &&
      this.managed === null &&
      this.unretired === null
    ) {
      return this.current;
    }

    const run = this.runStop();
    this.stopping = run;
    try {
      return await run;
    } finally {
      this.stopping = null;
    }
  }

  private async runStop(): Promise<LocalInferenceState> {
    // A runtime whose termination was never confirmed is still this provider's
    // to account for, so a repeated stop re-attempts THAT process. Without this
    // the second stop would find `managed` null and answer `stopped` — the
    // reference having been lost is not evidence the process ended.
    const managed = this.managed ?? this.unretired;
    this.apply('stop_requested', {
      kind: 'stopping',
      runtimeInstanceId: this.runtimeInstanceId
    });

    // Supersede every in-flight operation *before* awaiting anything: from here
    // their answers can no longer move the state, and none of them can report a
    // success for a runtime that is being taken away.
    this.generation += 1;
    this.operation?.abort();
    this.operation = null;

    // Held across the await for the same reason as in `settle`: nothing may
    // observe this provider between letting go of the handle and recording that
    // it is still accountable for the process.
    if (managed !== null) this.unretired = managed;
    this.managed = null;

    // `ManagedProcess.stop()` returns the attempt already in flight rather than
    // starting a second kill, so an explicit stop that arrives during an
    // automatic cleanup JOINS that cleanup and reports its real result. It
    // cannot answer `stopped` while the outcome is still unknown.
    const cleanup = managed === null ? null : await managed.stop();
    this.retireInstance();

    if (managed !== null && cleanup !== null && cleanup.kind !== 'stopped') {
      // `stop_timed_out` exists in the lifecycle graph, but an unconfirmed kill
      // is reported as `failed` on purpose: "we could not verify it is gone" is
      // a worse fact than "it took too long", and it is the one that matters.
      //
      // The handle is KEPT — it was taken above and is not given back here.
      // Reporting `failed` while forgetting the process would let the next
      // start run beside it. A further explicit stop may still try again,
      // because an unconfirmed attempt is released by the process itself.
      return this.apply('stop_failed', terminalState('failed', cleanup.reason));
    }
    // Confirmed gone — or there was never anything to kill. Either way nothing
    // is outstanding, so a later start is free to run.
    if (this.unretired === managed) this.unretired = null;
    return this.apply('stop_completed', { kind: 'stopped' });
  }

  /* ------------------------------------------------------------------ */
  /* Shared lifecycle plumbing                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Terminate the runtime, then enter the terminal state — or `failed` if the
   * cleanup could not be confirmed.
   *
   * The single place that decides "may this be called a confirmed cancellation
   * or timeout?", which is why start, health and inference all funnel through it
   * rather than each writing its own kill-then-transition. Its answer is
   * returned as well as applied, so a caller building an *outcome* — only
   * `infer` does — cannot describe the request as cancelled or timed out while
   * this has recorded that the runtime may still be alive.
   */
  private async settleTree(
    generation: number,
    kind: TerminalKind,
    events: TerminalEvents,
    reason: string
  ): Promise<Settlement> {
    const managed = this.managed;
    // Detach before awaiting `stop()`. Otherwise its exit promise can race this
    // cleanup while the public state is still `healthy`, causing the unexpected
    // exit watcher to consume the one legal terminal transition first.
    this.managed = null;
    // Handed over in the SAME synchronous step it was taken in, and held across
    // the await. Recording it afterwards left a window in which the process was
    // referenced by nothing: `managed` was already null and `unretired` was not
    // yet set, so an explicit stop arriving while this cleanup was still in
    // flight found nothing to stop, answered `stopped`, and let the next start
    // launch a second runtime beside a live one.
    if (managed !== null) this.unretired = managed;
    const cleanup = managed === null ? null : await managed.stop();
    // Released only on proof, and only if nothing else has taken over in the
    // meantime — a concurrent stop may already have retired this same process.
    if (cleanup !== null && cleanup.kind === 'stopped' && this.unretired === managed) {
      this.unretired = null;
    }
    const unconfirmed = cleanup !== null && cleanup.kind !== 'stopped' ? cleanup.reason : null;
    if (!this.owns(generation)) return { state: this.current, unconfirmed };

    this.retireInstance();

    if (unconfirmed !== null) {
      return {
        state: this.apply(events.failed, terminalState('failed', `${reason} ${unconfirmed}`)),
        unconfirmed
      };
    }
    return { state: this.apply(events[kind], terminalState(kind, reason)), unconfirmed: null };
  }

  /**
   * {@link settleTree} for the paths that report a lifecycle state.
   *
   * Start and health answer with the state itself, and the state has already
   * been downgraded to `failed` where the cleanup was unconfirmed — so there is
   * nothing further for them to decide.
   */
  private async settle(
    generation: number,
    kind: TerminalKind,
    events: TerminalEvents,
    reason: string
  ): Promise<LocalInferenceState> {
    return (await this.settleTree(generation, kind, events, reason)).state;
  }

  /** Forget the identity of a runtime this provider no longer supervises. */
  private retireInstance(): void {
    this.runtimeInstanceId = null;
    this.instanceRuntimeVersion = null;
  }

  private owns(generation: number): boolean {
    return this.generation === generation;
  }

  private assertAllowed(event: LocalInferenceEvent): void {
    // Throws InvalidTransitionError and leaves the state untouched.
    localInferenceTransition(this.current.kind, event);
  }

  private apply(event: LocalInferenceEvent, next: LocalInferenceState): LocalInferenceState {
    const kind = localInferenceTransition(this.current.kind, event);
    if (kind !== next.kind) {
      throw new AgentRelayError(
        'INTERNAL',
        `Local inference event "${event}" leads to "${kind}", not "${next.kind}".`
      );
    }
    this.current = next;
    return next;
  }

  /** Loopback only, built from a validated numeric port. Never configurable. */
  private urlFor(path: '/health' | '/v1/chat/completions'): string {
    return `http://${LOCAL_INFERENCE_HOST}:${this.config.port}${path}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The launch arguments, in one deterministic order.
 *
 * The adapter-owned entries come last so they are the final word: the schema
 * already refuses a fixed argument that spells one of them, and the ordering
 * makes that belt-and-braces rather than the only defence.
 *
 * Nothing from a request appears here. The prompt, the template parameters and
 * the token cap all live in an HTTP body, which is why a prompt containing
 * `&& rm -rf /` is a string a model wrote and not a second command.
 */
export function buildRuntimeArgv(config: LocalInferenceConfig): string[] {
  return [
    ...config.fixedArguments,
    '--model',
    modelArgumentFor(config.model),
    // The stable id, so the runtime answers to the same name the receipts use.
    '--alias',
    config.model.id,
    '--host',
    LOCAL_INFERENCE_HOST,
    '--port',
    String(config.port),
    '--ctx-size',
    String(config.contextLimitTokens)
  ];
}

function failure(
  kind: TerminalKind,
  requestId: string,
  dispatchOutcome: LocalInferenceDispatchOutcome,
  reason: string
): LocalInferenceOutcome {
  const safe = boundedReason(reason);
  if (kind === 'failed') {
    return {
      kind: 'failed',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId,
      reason: safe,
      dispatchOutcome
    };
  }
  if (kind === 'cancelled') {
    return {
      kind: 'cancelled',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId,
      reason: safe,
      dispatchOutcome
    };
  }
  return {
    kind: 'timed_out',
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    requestId,
    reason: safe,
    dispatchOutcome
  };
}

/** A bounded description of how the process ended. Never its output. */
function exitReason(exit: ManagedProcessExit): string {
  if (exit.spawnFailed) {
    const code = exit.errorCode === null ? '' : ` (${exit.errorCode})`;
    return `The runtime process could not be started${code}.`;
  }
  if (exit.signal !== null) {
    return `The runtime process was terminated by ${exit.signal}.`;
  }
  return `The runtime process exited with code ${exit.exitCode ?? 'unknown'}.`;
}
