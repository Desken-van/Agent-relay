/**
 * The versioned contract for a **managed local inference runtime**.
 *
 * Agent Relay may supervise a llama.cpp-compatible server on loopback and ask it
 * for one completion at a time. That runtime owns nothing else: no task, no
 * review, no patch, no retry, no approval, no publication. Everything in this
 * file is pure data plus pure functions, so the lifecycle can be exhaustively
 * tested without a process, a socket or a model.
 *
 * Three rules do most of the work here:
 *
 *  1. **The contract is versioned and strict.** Every schema is `.strict()` and
 *     carries a literal {@link LOCAL_INFERENCE_CONTRACT_VERSION}. A payload
 *     written by a newer build fails to parse rather than being half-understood.
 *  2. **Identity is never a machine path.** A model is configured by a stable,
 *     bounded id *plus* a source; only the id is ever returned in a response.
 *     A receipt that named `D:\models\foo.gguf` would be worthless on any other
 *     machine and would leak the layout of this one.
 *  3. **Unknown is a value.** A runtime that does not report token counts gets
 *     `null`, and a runtime that does not report a finish reason gets
 *     `{ kind: 'unknown' }`. Zero and `stop` are answers; absence is not, and
 *     inventing one is how a truncated completion later reads as a finished one.
 *
 * Nothing here performs I/O, and nothing here knows what an adapter is.
 */

import { z } from 'zod';
import { InvalidTransitionError } from './errors';
import { hasControlCharacter, isAbsolutePathLike } from './operations';
import { containsSecretShape } from '../util/redact';

/* -------------------------------------------------------------------------- */
/* Protocol identity                                                           */
/* -------------------------------------------------------------------------- */

/** The name this contract goes by. Never parsed; compared for equality only. */
export const LOCAL_INFERENCE_PROTOCOL = 'agent-relay.local-inference';

/** The only contract version this build writes, and the only one it reads. */
export const LOCAL_INFERENCE_CONTRACT_VERSION = 1;

/**
 * The one command PATH discovery is ever allowed to look for.
 *
 * A fixed literal rather than configuration: an executable *name* that could be
 * supplied would make "find the runtime" a way to run an arbitrary program that
 * happens to sit earlier on PATH.
 */
export const LLAMA_SERVER_COMMAND = 'llama-server';

/**
 * The only interface a managed runtime is ever bound to or contacted on.
 *
 * Not configurable, in either direction. A managed process that listened on
 * `0.0.0.0` would be an inference endpoint for the whole network, and a base URL
 * that could be pointed elsewhere would make "local inference" a name rather
 * than a property.
 */
export const LOCAL_INFERENCE_HOST = '127.0.0.1';

/**
 * Executable forms that are not programs but instructions to an interpreter.
 *
 * A `.cmd` or `.bat` is run by `cmd.exe`, a `.ps1` by PowerShell, a `.vbs` by
 * the Windows Script Host. Spawning one without a shell either fails outright or
 * — worse — succeeds by having something else start the shell on our behalf, and
 * Agent Relay's "no shell, ever" rule then holds only in the code that says so.
 *
 * PATH discovery is allowed to *find* these (that is `findOnPath`'s general
 * contract, shared with every other tool), so the refusal lives here, applied to
 * whatever discovery returned as well as to a configured path.
 *
 * `.js`, `.mjs` and `.cjs` are deliberately absent: they are not interpreted by
 * a shell, and `launchFor` runs them through the Node runtime this application
 * is already using. That is what the test fixture relies on.
 */
export const SHELL_DEPENDENT_EXECUTABLE_EXTENSIONS: readonly string[] = [
  '.cmd',
  '.bat',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.sh'
];

export function isShellDependentExecutable(path: string): boolean {
  const lowered = path.toLowerCase();
  return SHELL_DEPENDENT_EXECUTABLE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/* -------------------------------------------------------------------------- */
/* Hard maxima                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ceilings a *configuration* may not exceed, whatever the caller believes.
 *
 * These are not the operator's limits — those are the configured values, which
 * are usually far smaller. These are the limits on the limits: the point past
 * which a number stops describing a budget and starts describing a way to make
 * this process hold a gigabyte of somebody else's output.
 */
export const LOCAL_INFERENCE_LIMITS = {
  /** Identity strings: a model id is a name, not prose. */
  modelIdMax: 128,
  providerIdMax: 64,
  /** One argv entry. Long enough for a path, short enough to be an argument. */
  fixedArgumentMax: 512,
  fixedArgumentsMax: 64,
  modelPathMax: 4096,
  runtimeModelIdMax: 256,
  workingDirectoryMax: 4096,

  messagesMax: 64,
  messageContentMax: 200_000,
  chatTemplateParametersMax: 32,
  chatTemplateKeyMax: 64,
  chatTemplateStringValueMax: 512,

  contextTokensMax: 1_000_000,
  outputTokensMax: 1_000_000,

  promptBytesMax: 4 * 1024 * 1024,
  requestBytesMax: 8 * 1024 * 1024,
  responseBytesMax: 8 * 1024 * 1024,
  completionBytesMax: 4 * 1024 * 1024,
  processOutputBytesMax: 2 * 1024 * 1024,

  startupTimeoutMsMax: 10 * 60_000,
  healthTimeoutMsMax: 60_000,
  inferenceTimeoutMsMax: 30 * 60_000,
  shutdownTimeoutMsMax: 60_000,

  /** Bounded, safe strings a runtime supplies and Agent Relay then keeps. */
  runtimeVersionMax: 200,
  runtimeResponseIdMax: 128,
  finishReasonMax: 64,
  /** Diagnostics carried on a state or an outcome. Never a body or an argv. */
  reasonMax: 500
} as const;

/* -------------------------------------------------------------------------- */
/* Primitive schemas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A safe opaque identifier: letters, digits and `. _ -`, starting alphanumeric.
 *
 * Deliberately narrower than the provider-locator alphabet used for external
 * review ids — no `:` and no `/` — because these ids also become an `--alias`
 * argv entry and a JSON `model` field, and neither should be able to look like
 * a namespace, a path or an option.
 */
function safeIdSchema(maxLength: number, what: string) {
  return z
    .string()
    .min(1, `A ${what} is required.`)
    .max(maxLength, `A ${what} may be at most ${maxLength} characters.`)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      `A ${what} may only contain letters, digits, dot, underscore and hyphen, and must start with a letter or a digit.`
    );
}

function boundedInt(maxValue: number, what: string) {
  return z
    .number()
    .int(`${what} must be a whole number.`)
    .positive(`${what} must be greater than zero.`)
    .max(maxValue, `${what} may be at most ${maxValue}.`);
}

/**
 * An absolute path with no relative segments and no control characters.
 *
 * Relative segments are refused rather than resolved: a configuration is built
 * once and launched many times, and a stored `..` would make what it points at
 * depend on where the application happened to be standing.
 */
function absolutePathSchema(maxLength: number, what: string) {
  return z
    .string()
    .min(1, `A ${what} is required.`)
    .max(maxLength, `A ${what} may be at most ${maxLength} characters.`)
    .refine((value) => !hasControlCharacter(value), `A ${what} may not contain control characters.`)
    .refine((value) => isAbsolutePathLike(value), `A ${what} must be absolute.`)
    .refine(
      (value) => !value.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..'),
      `A ${what} may not contain "." or ".." segments.`
    );
}

/* -------------------------------------------------------------------------- */
/* Executable                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the runtime binary comes from.
 *
 * Two cases, and they behave differently on purpose. `discovered` looks for the
 * one fixed command name. `explicit_path` names a file, and a file that is not
 * there is an error — it must never fall back to PATH, or a typo in a configured
 * path would silently run whatever llama-server the machine happens to have.
 */
export const localInferenceExecutableSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('discovered'),
      /** Fixed. Discovery cannot be pointed at another program. */
      command: z.literal(LLAMA_SERVER_COMMAND)
    })
    .strict(),
  z
    .object({
      kind: z.literal('explicit_path'),
      path: absolutePathSchema(
        LOCAL_INFERENCE_LIMITS.modelPathMax,
        'runtime executable path'
      ).refine(
        (value) => !isShellDependentExecutable(value),
        'A runtime executable path may not name a command shim or script (.cmd, .bat, .ps1, …); Agent Relay never launches a shell.'
      )
    })
    .strict()
]);

export type LocalInferenceExecutable = z.infer<typeof localInferenceExecutableSchema>;

/* -------------------------------------------------------------------------- */
/* Model                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which weights to load, and what to call them.
 *
 * `id` is the identity: it is what goes into `--alias`, into the request body's
 * `model` field, and into every response. `source` is the machine-local detail
 * of how the runtime finds them, and it never leaves this process.
 */
export const localInferenceModelSchema = z
  .object({
    id: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'model id'),
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('path'),
          path: absolutePathSchema(LOCAL_INFERENCE_LIMITS.modelPathMax, 'model path')
        })
        .strict(),
      z
        .object({
          kind: z.literal('runtime_id'),
          /**
           * A name the runtime itself resolves. Passed to `--model` verbatim, so
           * it may not look like an option or carry a separator.
           */
          runtimeModelId: safeIdSchema(
            LOCAL_INFERENCE_LIMITS.runtimeModelIdMax,
            'runtime model identifier'
          )
        })
        .strict()
    ])
  })
  .strict();

export type LocalInferenceModel = z.infer<typeof localInferenceModelSchema>;

/** The `--model` argv value for a configured model. Never an identity. */
export function modelArgumentFor(model: LocalInferenceModel): string {
  return model.source.kind === 'path' ? model.source.path : model.source.runtimeModelId;
}

/* -------------------------------------------------------------------------- */
/* Fixed arguments                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Flags the adapter owns and a caller may therefore not supply.
 *
 * Every spelling llama.cpp accepts, because a deny-list that only knows the long
 * form is a deny-list with a hole in it. `--model=x` is normalised to `--model`
 * before the comparison, and matching is case-insensitive.
 */
export const RESERVED_RUNTIME_FLAGS: readonly string[] = [
  '--model',
  '-m',
  '--model-url',
  '--alias',
  '-a',
  '--host',
  '--port',
  '--ctx-size',
  '-c',
  '--ctx_size'
];

/** The flag part of an argv entry: `--model=x` → `--model`; `foo` → null. */
export function argumentFlagName(argument: string): string | null {
  if (!argument.startsWith('-')) return null;
  const equals = argument.indexOf('=');
  return (equals === -1 ? argument : argument.slice(0, equals)).toLowerCase();
}

export function isReservedRuntimeFlag(argument: string): boolean {
  const flag = argumentFlagName(argument);
  return flag !== null && RESERVED_RUNTIME_FLAGS.includes(flag);
}

/**
 * One trusted, construction-time argv entry.
 *
 * "Trusted" still means checked. These are individual argv entries, never a
 * command string, and nothing a request contains can ever add one — but a
 * configuration file is still a thing a person edits, and a credential pasted
 * into it would end up on a command line that other processes can read.
 */
export const fixedArgumentSchema = z
  .string()
  .min(1, 'A runtime argument may not be empty.')
  .max(
    LOCAL_INFERENCE_LIMITS.fixedArgumentMax,
    `A runtime argument may be at most ${LOCAL_INFERENCE_LIMITS.fixedArgumentMax} characters.`
  )
  .refine(
    (value) => !hasControlCharacter(value),
    'A runtime argument may not contain control characters.'
  )
  .refine(
    (value) => !containsSecretShape(value),
    'This runtime argument looks like a credential. The managed runtime is local and needs none.'
  )
  .refine(
    (value) => !isReservedRuntimeFlag(value),
    'This flag is owned by Agent Relay (model, alias, host, port and context size) and may not be overridden.'
  );

/* -------------------------------------------------------------------------- */
/* Chat template parameters                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Request-level chat-template parameters, e.g. Ornith's `enable_thinking`.
 *
 * A flat map of identifier-shaped keys to JSON primitives. Nested objects and
 * arrays are refused: they are not needed by any template parameter this
 * contract supports, and every extra shape is another thing the byte budget and
 * the safety checks have to reason about.
 *
 * `false` and `0` survive unchanged. They are values, and a "falsy means absent"
 * shortcut anywhere in this path would silently turn `enable_thinking: false`
 * into "not specified".
 */
export const chatTemplateParametersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(LOCAL_INFERENCE_LIMITS.chatTemplateKeyMax)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        'A chat-template parameter name must be an identifier: letters, digits and underscore, not starting with a digit.'
      ),
    z.union([
      z
        .string()
        .max(LOCAL_INFERENCE_LIMITS.chatTemplateStringValueMax)
        .refine(
          (value) => !hasControlCharacter(value),
          'A chat-template parameter may not contain control characters.'
        ),
      z.number().refine(Number.isFinite, 'A chat-template number must be finite.'),
      z.boolean()
    ])
  )
  .refine(
    (value) => Object.keys(value).length <= LOCAL_INFERENCE_LIMITS.chatTemplateParametersMax,
    `At most ${LOCAL_INFERENCE_LIMITS.chatTemplateParametersMax} chat-template parameters may be supplied.`
  );

export type ChatTemplateParameters = z.infer<typeof chatTemplateParametersSchema>;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export const localInferenceConfigSchema = z
  .object({
    version: z.literal(LOCAL_INFERENCE_CONTRACT_VERSION),
    providerId: safeIdSchema(LOCAL_INFERENCE_LIMITS.providerIdMax, 'provider id'),
    executable: localInferenceExecutableSchema,
    model: localInferenceModelSchema,
    workingDirectory: absolutePathSchema(
      LOCAL_INFERENCE_LIMITS.workingDirectoryMax,
      'working directory'
    ).optional(),
    /** The host is fixed at {@link LOCAL_INFERENCE_HOST}; only the port varies. */
    port: z
      .number()
      .int('A port must be a whole number.')
      .min(1, 'A port must be between 1 and 65535.')
      .max(65535, 'A port must be between 1 and 65535.'),
    fixedArguments: z
      .array(fixedArgumentSchema)
      .max(
        LOCAL_INFERENCE_LIMITS.fixedArgumentsMax,
        `At most ${LOCAL_INFERENCE_LIMITS.fixedArgumentsMax} fixed runtime arguments may be supplied.`
      ),

    contextLimitTokens: boundedInt(LOCAL_INFERENCE_LIMITS.contextTokensMax, 'The context limit'),
    maxOutputTokens: boundedInt(LOCAL_INFERENCE_LIMITS.outputTokensMax, 'The output token cap'),

    maxPromptBytes: boundedInt(LOCAL_INFERENCE_LIMITS.promptBytesMax, 'The prompt byte limit'),
    maxRequestBytes: boundedInt(LOCAL_INFERENCE_LIMITS.requestBytesMax, 'The request byte limit'),
    maxResponseBytes: boundedInt(LOCAL_INFERENCE_LIMITS.responseBytesMax, 'The response byte limit'),
    maxCompletionBytes: boundedInt(
      LOCAL_INFERENCE_LIMITS.completionBytesMax,
      'The completion byte limit'
    ),
    maxProcessOutputBytes: boundedInt(
      LOCAL_INFERENCE_LIMITS.processOutputBytesMax,
      'The process output byte limit'
    ),

    startupTimeoutMs: boundedInt(
      LOCAL_INFERENCE_LIMITS.startupTimeoutMsMax,
      'The startup timeout'
    ),
    healthTimeoutMs: boundedInt(LOCAL_INFERENCE_LIMITS.healthTimeoutMsMax, 'The health timeout'),
    inferenceTimeoutMs: boundedInt(
      LOCAL_INFERENCE_LIMITS.inferenceTimeoutMsMax,
      'The inference timeout'
    ),
    shutdownTimeoutMs: boundedInt(
      LOCAL_INFERENCE_LIMITS.shutdownTimeoutMsMax,
      'The shutdown timeout'
    )
  })
  .strict()
  .superRefine((value, ctx) => {
    // Each of these is a pair that is individually valid and jointly nonsense.
    // Left unchecked, the first two produce a runtime that can never answer and
    // a response that can never fit, both of which look like a runtime fault.
    if (value.maxOutputTokens > value.contextLimitTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxOutputTokens'],
        message: 'The output token cap may not exceed the context limit.'
      });
    }
    if (value.maxPromptBytes > value.maxRequestBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxPromptBytes'],
        message: 'The prompt byte limit may not exceed the request byte limit.'
      });
    }
    if (value.maxCompletionBytes > value.maxResponseBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxCompletionBytes'],
        message: 'The completion byte limit may not exceed the response byte limit.'
      });
    }
  });

export type LocalInferenceConfig = z.infer<typeof localInferenceConfigSchema>;

/** Parse a configuration, failing closed on anything unrecognised. */
export function parseLocalInferenceConfig(input: unknown): LocalInferenceConfig {
  return localInferenceConfigSchema.parse(input);
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export const LOCAL_INFERENCE_ROLES = ['system', 'user', 'assistant'] as const;
export type LocalInferenceRole = (typeof LOCAL_INFERENCE_ROLES)[number];

export const localInferenceMessageSchema = z
  .object({
    role: z.enum(LOCAL_INFERENCE_ROLES),
    content: z
      .string()
      .min(1, 'A message may not be empty.')
      .max(
        LOCAL_INFERENCE_LIMITS.messageContentMax,
        `A message may be at most ${LOCAL_INFERENCE_LIMITS.messageContentMax} characters.`
      )
  })
  .strict();

export type LocalInferenceMessage = z.infer<typeof localInferenceMessageSchema>;

/**
 * One inference request.
 *
 * Note what is absent and cannot be added without changing this schema: tools,
 * file paths, repository context, patches, retries, streaming. This contract can
 * ask for one completion and nothing else.
 */
export const localInferenceRequestSchema = z
  .object({
    version: z.literal(LOCAL_INFERENCE_CONTRACT_VERSION),
    requestId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'request id'),
    messages: z
      .array(localInferenceMessageSchema)
      .min(1, 'At least one message is required.')
      .max(
        LOCAL_INFERENCE_LIMITS.messagesMax,
        `At most ${LOCAL_INFERENCE_LIMITS.messagesMax} messages may be sent.`
      ),
    /** May only *lower* the configured cap; the adapter clamps, never raises. */
    maxOutputTokens: boundedInt(
      LOCAL_INFERENCE_LIMITS.outputTokensMax,
      'The request output token cap'
    ).optional(),
    chatTemplateParameters: chatTemplateParametersSchema.optional()
  })
  .strict();

export type LocalInferenceRequest = z.infer<typeof localInferenceRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why the runtime stopped generating.
 *
 * A union rather than a string, and `unknown` is a member rather than a default.
 * OpenAI-compatible servers omit `finish_reason` often enough that substituting
 * `stop` would be a lie told routinely — and `stop` is exactly the value a caller
 * would read as "this completion is whole".
 */
export const localInferenceFinishReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop') }).strict(),
  z.object({ kind: z.literal('length') }).strict(),
  z.object({ kind: z.literal('content_filter') }).strict(),
  z.object({ kind: z.literal('tool_calls') }).strict(),
  /** A bounded reason this build does not recognise. Never mapped onto `stop`. */
  z
    .object({
      kind: z.literal('other'),
      reason: z.string().min(1).max(LOCAL_INFERENCE_LIMITS.finishReasonMax)
    })
    .strict(),
  /** The runtime did not say. */
  z.object({ kind: z.literal('unknown') }).strict()
]);

export type LocalInferenceFinishReason = z.infer<typeof localInferenceFinishReasonSchema>;

export const localInferenceResponseSchema = z
  .object({
    version: z.literal(LOCAL_INFERENCE_CONTRACT_VERSION),
    requestId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'request id'),
    providerId: safeIdSchema(LOCAL_INFERENCE_LIMITS.providerIdMax, 'provider id'),
    /** The stable configured id — never a model path. */
    modelId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'model id'),
    /** Established by the successful start that owns this completed response. */
    runtimeVersion: z.string().min(1).max(LOCAL_INFERENCE_LIMITS.runtimeVersionMax),
    /** Identifies the started process, so two runs are never confused. */
    runtimeInstanceId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'runtime instance id'),
    durationMs: z.number().int().nonnegative(),
    completion: z.string().max(LOCAL_INFERENCE_LIMITS.completionBytesMax),
    /** Nonnegative integers, or null when the runtime did not report them. */
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    runtimeResponseId: z.string().max(LOCAL_INFERENCE_LIMITS.runtimeResponseIdMax).nullable(),
    finishReason: localInferenceFinishReasonSchema
  })
  .strict();

export type LocalInferenceResponse = z.infer<typeof localInferenceResponseSchema>;

/**
 * What is known about whether the runtime actually received the request.
 *
 * The conservative member is `unknown`, and it covers everything that happened
 * after `fetch` was called: a timeout, a cancellation, a dropped connection, a
 * crash, a malformed answer, an overflow. None of those prove the runtime did
 * not run the prompt, so none of them may license a second attempt.
 */
export const LOCAL_INFERENCE_DISPATCH_OUTCOMES = ['not_dispatched', 'rejected', 'unknown'] as const;
export type LocalInferenceDispatchOutcome = (typeof LOCAL_INFERENCE_DISPATCH_OUTCOMES)[number];

const failureShape = {
  version: z.literal(LOCAL_INFERENCE_CONTRACT_VERSION),
  requestId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'request id'),
  /** Bounded and safe: never a body, a path, an argv or a prompt. */
  reason: z.string().min(1).max(LOCAL_INFERENCE_LIMITS.reasonMax),
  dispatchOutcome: z.enum(LOCAL_INFERENCE_DISPATCH_OUTCOMES)
} as const;

/**
 * The result of one `infer` call.
 *
 * Only `completed` carries a response, which is what makes "a cancellation
 * cannot be mistaken for a successful inference" a property of the type rather
 * than a habit of the callers.
 */
export const localInferenceOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('completed'),
      version: z.literal(LOCAL_INFERENCE_CONTRACT_VERSION),
      response: localInferenceResponseSchema
    })
    .strict(),
  z.object({ kind: z.literal('failed'), ...failureShape }).strict(),
  z.object({ kind: z.literal('cancelled'), ...failureShape }).strict(),
  z.object({ kind: z.literal('timed_out'), ...failureShape }).strict()
]);

export type LocalInferenceOutcome = Readonly<z.infer<typeof localInferenceOutcomeSchema>>;

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What this adapter can do, and what has actually been proved.
 *
 * `available` and `inferenceVerified` are deliberately different questions.
 * Finding `llama-server` on PATH and reading its `--version` banner proves a
 * file exists and printed something; it proves nothing about whether a model
 * loads or a completion ever comes back. Only a validated completion sets
 * `inferenceVerified`.
 */
export interface LocalInferenceCapabilities {
  readonly protocol: typeof LOCAL_INFERENCE_PROTOCOL;
  readonly contractVersion: typeof LOCAL_INFERENCE_CONTRACT_VERSION;
  readonly providerId: string;
  readonly modelId: string;
  /** An executable was located. Not a claim that it works. */
  readonly available: boolean;
  /** Why not, when not. Bounded and safe; never the path that was tried. */
  readonly unavailableReason: string | null;
  /** How the executable was found, or null when it was not. */
  readonly executableSource: 'configured' | 'path' | 'well-known' | 'bundled' | null;
  /** The first line of the `--version` banner, or null when it did not parse. */
  readonly runtimeVersion: string | null;
  readonly supportsChatCompletions: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsUsageWhenReported: boolean;
  readonly supportsChatTemplateParameters: boolean;
  /** True only after one completion was received and validated in full. */
  readonly inferenceVerified: boolean;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export const LOCAL_INFERENCE_STATE_KINDS = [
  'unavailable',
  'starting',
  'healthy',
  'inferring',
  'stopping',
  'stopped',
  'failed',
  'cancelled',
  'timed_out'
] as const;

export type LocalInferenceStateKind = (typeof LOCAL_INFERENCE_STATE_KINDS)[number];

/**
 * The provider's lifecycle, as one discriminated union.
 *
 * Each member carries only what is needed to identify the current operation and
 * the runtime it belongs to. In particular there is no output, no body, no path
 * and no argv here: state is read by diagnostics, and diagnostics are kept.
 */
const lifecycleReasonSchema = z
  .string()
  .min(1)
  .max(LOCAL_INFERENCE_LIMITS.reasonMax)
  .refine((value) => !hasControlCharacter(value), 'A lifecycle reason may not contain controls.')
  .refine(
    (value) => !containsSecretShape(value),
    'A lifecycle reason may not contain credential-shaped text.'
  );

export const localInferenceStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable'), reason: lifecycleReasonSchema }).strict(),
  z
    .object({
      kind: z.literal('starting'),
      runtimeInstanceId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'runtime instance id')
    })
    .strict(),
  z
    .object({
      kind: z.literal('healthy'),
      runtimeInstanceId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'runtime instance id')
    })
    .strict(),
  z
    .object({
      kind: z.literal('inferring'),
      runtimeInstanceId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'runtime instance id'),
      requestId: safeIdSchema(LOCAL_INFERENCE_LIMITS.modelIdMax, 'request id')
    })
    .strict(),
  z
    .object({
      kind: z.literal('stopping'),
      /** Null when there was never a process to stop. */
      runtimeInstanceId: safeIdSchema(
        LOCAL_INFERENCE_LIMITS.modelIdMax,
        'runtime instance id'
      ).nullable()
    })
    .strict(),
  z.object({ kind: z.literal('stopped') }).strict(),
  z.object({ kind: z.literal('failed'), reason: lifecycleReasonSchema }).strict(),
  z.object({ kind: z.literal('cancelled'), reason: lifecycleReasonSchema }).strict(),
  z.object({ kind: z.literal('timed_out'), reason: lifecycleReasonSchema }).strict()
]);

export type LocalInferenceState = Readonly<z.infer<typeof localInferenceStateSchema>>;

export const LOCAL_INFERENCE_EVENTS = [
  'discovery_failed',
  'start_requested',
  'started_healthy',
  'start_failed',
  'start_cancelled',
  'start_timed_out',
  'health_checked',
  'health_failed',
  'health_cancelled',
  'health_timed_out',
  'inference_started',
  'inference_completed',
  'inference_failed',
  'inference_cancelled',
  'inference_timed_out',
  'process_exited',
  'stop_requested',
  'stop_completed',
  'stop_failed',
  'stop_timed_out'
] as const;

export type LocalInferenceEvent = (typeof LOCAL_INFERENCE_EVENTS)[number];

type LocalInferenceTransitionTable = {
  readonly [S in LocalInferenceStateKind]: {
    readonly [E in LocalInferenceEvent]?: LocalInferenceStateKind;
  };
};

/**
 * The single source of truth for legal moves.
 *
 * Read as: "while the provider is <state>, event <event> moves it to <state>".
 * Anything not listed is refused by {@link localInferenceTransition}, and the
 * omissions are the interesting part:
 *
 *  * `start_requested` is absent from `starting`, `healthy`, `inferring` and
 *    `stopping`. One provider supervises at most one process, and a second start
 *    would silently abandon the first.
 *  * `inference_started` appears only under `healthy`. Inferring against a
 *    runtime that has not answered a health check is guessing.
 *  * `health_checked` also appears only under `healthy`. The startup loop polls
 *    the same endpoint privately; that is not an external health transition and
 *    must not be able to declare one.
 *  * Nothing leaves `stopped` or a terminal state except an explicit
 *    `start_requested`. The provider never restarts itself.
 */
export const LOCAL_INFERENCE_TRANSITIONS: LocalInferenceTransitionTable = {
  unavailable: {
    discovery_failed: 'unavailable',
    start_requested: 'starting',
    // The public state can be unavailable while an older, unconfirmed process
    // is still retained. The provider normally returns early when there is no
    // process; when there is one, it must be able to enter the real stop path.
    stop_requested: 'stopping'
  },
  starting: {
    started_healthy: 'healthy',
    start_failed: 'failed',
    start_cancelled: 'cancelled',
    start_timed_out: 'timed_out',
    process_exited: 'failed',
    stop_requested: 'stopping'
  },
  healthy: {
    health_checked: 'healthy',
    health_failed: 'failed',
    health_cancelled: 'cancelled',
    health_timed_out: 'timed_out',
    inference_started: 'inferring',
    process_exited: 'failed',
    stop_requested: 'stopping'
  },
  inferring: {
    inference_completed: 'healthy',
    inference_failed: 'failed',
    inference_cancelled: 'cancelled',
    inference_timed_out: 'timed_out',
    process_exited: 'failed',
    stop_requested: 'stopping'
  },
  stopping: {
    stop_completed: 'stopped',
    // Only when the cleanup itself could not be completed as specified.
    stop_failed: 'failed',
    stop_timed_out: 'timed_out'
  },
  stopped: {
    discovery_failed: 'unavailable',
    start_requested: 'starting',
    stop_requested: 'stopped'
  },
  failed: {
    discovery_failed: 'unavailable',
    start_requested: 'starting',
    stop_requested: 'stopping'
  },
  cancelled: {
    discovery_failed: 'unavailable',
    start_requested: 'starting',
    stop_requested: 'stopping'
  },
  timed_out: {
    discovery_failed: 'unavailable',
    start_requested: 'starting',
    stop_requested: 'stopping'
  }
};

export function canLocalInferenceTransition(
  from: LocalInferenceStateKind,
  event: LocalInferenceEvent
): boolean {
  return LOCAL_INFERENCE_TRANSITIONS[from][event] !== undefined;
}

/** Every event that is currently legal for `from`. */
export function allowedLocalInferenceEvents(
  from: LocalInferenceStateKind
): LocalInferenceEvent[] {
  return Object.keys(LOCAL_INFERENCE_TRANSITIONS[from]) as LocalInferenceEvent[];
}

/**
 * Apply `event` to `from`.
 *
 * @throws {InvalidTransitionError} when the move is not in the table. Callers
 * must consult this *before* launching a process or sending a request, so a
 * refused operation leaves nothing behind.
 */
export function localInferenceTransition(
  from: LocalInferenceStateKind,
  event: LocalInferenceEvent
): LocalInferenceStateKind {
  const next = LOCAL_INFERENCE_TRANSITIONS[from][event];
  if (next === undefined) {
    throw new InvalidTransitionError(from, event);
  }
  return next;
}

/** States in which a managed runtime process may currently exist. */
export const LOCAL_INFERENCE_ACTIVE_KINDS: readonly LocalInferenceStateKind[] = [
  'starting',
  'healthy',
  'inferring',
  'stopping'
];

export function isLocalInferenceActive(kind: LocalInferenceStateKind): boolean {
  return LOCAL_INFERENCE_ACTIVE_KINDS.includes(kind);
}
