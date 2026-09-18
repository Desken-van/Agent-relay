/**
 * The Ornith action protocol.
 *
 * Ornith (the local-inference implementation provider) never receives a shell,
 * a tool-calling API, or anything resembling free-form command text. Every
 * completion it returns is exactly one JSON object naming exactly one of the
 * actions below, parsed with `JSON.parse` and nothing more forgiving — no
 * Markdown-fence stripping, no substring recovery, no "the model probably
 * meant". A completion that is not exactly this shape is a terminal failure
 * for the attempt, not something to repair or retry.
 *
 * This module is pure data and pure functions. It knows nothing about the
 * filesystem, Git, or the local-inference runtime; `src/main/services/
 * ornith-worktree-tools.ts` and `src/main/services/ornith-implementation.ts`
 * are what execute an action once it has been accepted here.
 */

import { z } from 'zod';
import { containsSecretShape } from '../util/redact';

/** The only contract version this build writes or reads. */
export const ORNITH_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Hard, application-owned limits                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every numeric ceiling the Ornith loop enforces.
 *
 * None of these is renderer-configurable, and nothing a model returns can
 * widen any of them — a `limit` field inside an action, were one ever added,
 * would be exactly the kind of self-reported budget this object exists to
 * replace. Existing `LocalInferenceConfig` request/response/token/timeout
 * ceilings (see `local-inference.ts`) remain additional and are never raised
 * by anything here.
 */
export const ORNITH_LIMITS = {
  /** Whole run. */
  maxModelTurns: 40,
  maxNonterminalActions: 39,
  maxLoopDeadlineMs: 30 * 60_000,

  /** Rolling stateless-request context. */
  maxRetainedResults: 20,
  maxRollingContextBytes: 256 * 1024,
  /** A stateless tool loop is invalid unless at least one compact result can return. */
  minRollingFeedbackBytes: 1_024,
  maxPromptBytes: 512 * 1024,
  maxCompletionBytes: 512 * 1024,
  maxToolResultBytes: 64 * 1024,
  /** Reserve room for the chat template/BOS and keep one action concise. */
  contextSafetyTokens: 512,
  maxTurnOutputTokens: 4_096,
  /** First action executes, second identical read-only action gets feedback, third stops. */
  maxConsecutiveIdenticalReadOnlyActions: 3,

  /** Cumulative repository I/O for the whole run. */
  maxCumulativeReadBytes: 4 * 1024 * 1024,
  maxCumulativeWriteBytes: 4 * 1024 * 1024,
  maxChangedFiles: 100,
  maxVerificationCalls: 3,

  /** Per-operation timeouts. */
  filesystemTimeoutMs: 10_000,
  /**
   * 20s, not 15s: headroom for slower disks/AV scanning now that the
   * dominant cost (a full `assertCheckoutIdentity` per candidate file) is
   * removed — see `searchIdentityRecheckFiles`. This alone is not the fix;
   * it is margin on top of it.
   */
  searchTimeoutMs: 20_000,
  gitTimeoutMs: 30_000,

  /**
   * How many candidate files `searchText`/`gitDiff` scan between checkout-
   * identity re-checks. Re-checking every file made a broad search re-spawn
   * `git` (inside `assertCheckoutIdentity`) once per candidate — O(files)
   * subprocess spawns, which is what actually exhausted `searchTimeoutMs` on
   * a few-hundred-file repository. Re-checking on a bounded cadence instead
   * keeps the identity guarantee (a worktree swapped mid-scan is still
   * caught within one interval, not only at the next model turn) while
   * making the cost O(files / interval) instead of O(files).
   */
  searchIdentityRecheckFiles: 25,

  /** Bounded number of times a read-only action's `timeout` denial is fed
   *  back to the model instead of ending the run. Only `timeout` on a
   *  read-only action is recoverable this way; every other denial code
   *  remains terminal. */
  maxReadOnlyRecoveryAttempts: 3,
  /** Separate, single-shot recovery budget for a read-only action denied by
   *  `limit_read_bytes_exceeded`: one bounded chance to pivot to a mutation
   *  using already-verified context before the run ends. Kept independent of
   *  `maxReadOnlyRecoveryAttempts` because the two denials have different
   *  causes (transient timeout vs. exhausted resource budget). */
  maxReadBudgetRecoveryAttempts: 1,

  /** Discovery-scope hint: how many of a specification's declared
   *  `scopedFilePaths` entries are honored after syntax sanitization. Matches
   *  `taskSpecificationSchema`'s own array cap; re-checked here because the
   *  sanitizer is reused independently of that schema. */
  maxScopedFilePaths: 20,

  /** Repository manifest. */
  maxManifestFiles: 20_000,

  /** Per-action bounds. */
  maxListFilesLimit: 200,
  maxReadBytes: 65_536,
  maxSearchQueryLength: 256,
  maxSearchFiles: 50,
  maxSearchMatches: 100,
  maxReplacements: 32,
  maxReplacementFragmentChars: 65_536,
  maxFileBytes: 1 * 1024 * 1024,
  maxGitDiffPaths: 50,
  maxFinishSummaryChars: 4_000,
  maxBlockedReasonChars: 2_000,
  maxRelativePathChars: 4_096,

  /** Bounded, safe denial/error text returned to the run record. */
  maxErrorChars: 500
} as const;

/* -------------------------------------------------------------------------- */
/* Denial / limit codes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every reason an Ornith attempt can be refused or cut short.
 *
 * A fixed, closed vocabulary rather than free text: run events and structured
 * results may record *which* of these applied, but never the raw content that
 * triggered it (path, prompt, completion, argv) — see the module comment on
 * `src/main/services/ornith-implementation.ts`.
 */
export const ORNITH_DENIAL_CODES = [
  'runtime_unavailable',
  'runtime_unhealthy',
  'runtime_identity_changed',
  'lease_busy',
  'malformed_output',
  'oversized_output',
  'unknown_action',
  'disallowed_action',
  'invalid_path',
  'path_outside_worktree',
  'path_not_regular_file',
  'path_symlink',
  'checkout_identity_changed',
  'stale_hash',
  'replacement_mismatch',
  'file_exists',
  'file_not_found',
  'limit_turns_exceeded',
  'limit_actions_exceeded',
  'limit_context_exceeded',
  'limit_prompt_exceeded',
  'limit_result_exceeded',
  'limit_read_bytes_exceeded',
  'limit_write_bytes_exceeded',
  'limit_changed_files_exceeded',
  'limit_manifest_files_exceeded',
  'limit_verification_calls_exceeded',
  'limit_deadline_exceeded',
  'timeout',
  'blocked',
  'cancelled',
  'internal_error'
] as const;
export type OrnithDenialCode = (typeof ORNITH_DENIAL_CODES)[number];

/* -------------------------------------------------------------------------- */
/* Path & primitive schemas                                                   */
/* -------------------------------------------------------------------------- */

/** Detect host-absolute paths even when adjacent to punctuation like `path=`. */
export function containsAbsoluteMachinePath(value: string): boolean {
  return /[A-Za-z]:[\\/]/.test(value) ||
    /\\\\[^\\/\s]+[\\/]/.test(value) ||
    /(^|[\s=:[({,"'])\/(?!\/)[^\s)\]}"'>,;]+/m.test(value);
}

/** Replace machine-absolute path tokens in bounded, non-authoritative prose. */
export function redactAbsoluteMachinePaths(value: string): string {
  return value
    .replace(/\\\\[^\\/\s]+[\\/][^\s)\]}"'>,;]*/g, '[absolute-path-omitted]')
    .replace(/[A-Za-z]:[\\/][^\s)\]}"'>,;]*/g, '[absolute-path-omitted]')
    .replace(/(^|[\s=:[({,"'])\/(?!\/)[^\s)\]}"'>,;]+/gm, '$1[absolute-path-omitted]');
}

/** True when `value` contains a C0 control character or DEL. No regex literal, so no escape-sequence corruption risk. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/**
 * Syntactic validation only. The worktree tool executor additionally resolves
 * the path against the real filesystem (symlinks, hard links, containment,
 * checkout identity) — this function cannot see any of that, and is not a
 * substitute for it.
 */
function isValidOrnithRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > ORNITH_LIMITS.maxRelativePathChars) return false;
  if (hasControlCharacter(value)) return false;
  // POSIX-normalized only: a backslash is either a Windows separator (which a
  // normalized relative path never contains) or part of a UNC prefix. Either
  // way it is refused rather than reinterpreted.
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  // Drive-relative / drive-rooted, e.g. "C:" or "C:foo".
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  if (segments.includes('.git')) return false;
  return true;
}

export const ornithRelativePathSchema = z
  .string()
  .refine(isValidOrnithRelativePath, 'Not a normalized repository-relative POSIX path.');

/**
 * Reduce a specification's raw, model-authored `scopedFilePaths` claim to a
 * safe, deduplicated, bounded candidate list, using the exact same strict
 * syntax check a live action's `path` field must pass. This is intentionally
 * permissive at the schema layer (`taskSpecificationSchema` only bounds count
 * and length) and strict here: a malformed or oversized entry is dropped
 * individually rather than failing specification parsing outright, and later,
 * manifest-membership filtering (in `OrnithWorktreeTools`) further narrows the
 * result to paths that actually exist. Never throws.
 */
export function sanitizeScopedFilePaths(candidates: readonly string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) return [];
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const candidate of candidates) {
    if (sanitized.length >= ORNITH_LIMITS.maxScopedFilePaths) break;
    if (seen.has(candidate)) continue;
    if (!ornithRelativePathSchema.safeParse(candidate).success) continue;
    seen.add(candidate);
    sanitized.push(candidate);
  }
  return sanitized;
}

/** Same rule, but an empty string is accepted to mean "the worktree root". */
export const ornithRelativePrefixSchema = z
  .string()
  .max(ORNITH_LIMITS.maxRelativePathChars)
  .refine(
    (value) => value.length === 0 || isValidOrnithRelativePath(value),
    'Not a normalized repository-relative POSIX prefix.'
  );

export const ornithSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Must be a lowercase SHA-256 hex digest.');

/** Prose that Agent Relay will store: no control characters beyond tab/LF/CR, no credential shapes. */
function isSafeOrnithProse(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) return false;
  }
  return !containsSecretShape(value);
}

function safeOrnithProseSchema(maxLength: number, what: string) {
  return z
    .string()
    .min(1, `${what} is required.`)
    .max(maxLength, `${what} may be at most ${maxLength} characters.`)
    .refine(isSafeOrnithProse, `${what} may not contain control characters or credential-shaped text.`);
}

/** File text content: same prose safety rule, sized in bytes rather than characters. */
export const ornithFileContentSchema = z
  .string()
  .refine(isSafeOrnithProse, 'File content may not contain control characters or credential-shaped text.')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= ORNITH_LIMITS.maxFileBytes,
    `File content may be at most ${ORNITH_LIMITS.maxFileBytes} bytes.`
  );

function ornithFragmentSchema(requireNonEmpty: boolean) {
  const bounded = requireNonEmpty
    ? z.string().min(1, 'oldText may not be empty.').max(ORNITH_LIMITS.maxReplacementFragmentChars)
    : z.string().max(ORNITH_LIMITS.maxReplacementFragmentChars);
  return bounded.refine(
    isSafeOrnithProse,
    'A replacement fragment may not contain control characters or credential-shaped text.'
  );
}

export const ornithReplacementSchema = z
  .object({
    oldText: ornithFragmentSchema(true),
    newText: ornithFragmentSchema(false)
  })
  .strict();
export type OrnithReplacement = z.infer<typeof ornithReplacementSchema>;

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

const versionField = z.literal(ORNITH_PROTOCOL_VERSION);

export const ornithListFilesActionSchema = z
  .object({
    version: versionField,
    action: z.literal('list_files'),
    prefix: ornithRelativePrefixSchema,
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(ORNITH_LIMITS.maxListFilesLimit)
  })
  .strict();

export const ornithReadFileActionSchema = z
  .object({
    version: versionField,
    action: z.literal('read_file'),
    path: ornithRelativePathSchema,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(ORNITH_LIMITS.maxReadBytes)
  })
  .strict();

export const ornithSearchTextActionSchema = z
  .object({
    version: versionField,
    action: z.literal('search_text'),
    query: z
      .string()
      .min(1, 'A search query is required.')
      .max(ORNITH_LIMITS.maxSearchQueryLength)
      .refine(isSafeOrnithProse, 'A search query may not contain control characters or credential-shaped text.'),
    caseSensitive: z.boolean(),
    files: z.array(ornithRelativePathSchema).max(ORNITH_LIMITS.maxSearchFiles).optional(),
    limit: z.number().int().positive().max(ORNITH_LIMITS.maxSearchMatches)
  })
  .strict();

export const ornithCreateFileActionSchema = z
  .object({
    version: versionField,
    action: z.literal('create_file'),
    path: ornithRelativePathSchema,
    content: ornithFileContentSchema
  })
  .strict();

export const ornithReplaceTextActionSchema = z
  .object({
    version: versionField,
    action: z.literal('replace_text'),
    path: ornithRelativePathSchema,
    sha256: ornithSha256Schema,
    replacements: z.array(ornithReplacementSchema).min(1).max(ORNITH_LIMITS.maxReplacements)
  })
  .strict();

export const ornithDeleteFileActionSchema = z
  .object({
    version: versionField,
    action: z.literal('delete_file'),
    path: ornithRelativePathSchema,
    sha256: ornithSha256Schema
  })
  .strict();

export const ornithGitStatusActionSchema = z
  .object({
    version: versionField,
    action: z.literal('git_status')
  })
  .strict();

export const ornithGitDiffActionSchema = z
  .object({
    version: versionField,
    action: z.literal('git_diff'),
    paths: z.array(ornithRelativePathSchema).max(ORNITH_LIMITS.maxGitDiffPaths).optional()
  })
  .strict();

export const ornithRunVerificationActionSchema = z
  .object({
    version: versionField,
    action: z.literal('run_verification')
  })
  .strict();

export const ornithFinishActionSchema = z
  .object({
    version: versionField,
    action: z.literal('finish'),
    summary: safeOrnithProseSchema(ORNITH_LIMITS.maxFinishSummaryChars, 'The finish summary')
  })
  .strict();

export const ornithBlockedActionSchema = z
  .object({
    version: versionField,
    action: z.literal('blocked'),
    reason: safeOrnithProseSchema(ORNITH_LIMITS.maxBlockedReasonChars, 'The blocked reason')
  })
  .strict();

/** Every action the model may request, and nothing else. */
export const ornithActionSchema = z.discriminatedUnion('action', [
  ornithListFilesActionSchema,
  ornithReadFileActionSchema,
  ornithSearchTextActionSchema,
  ornithCreateFileActionSchema,
  ornithReplaceTextActionSchema,
  ornithDeleteFileActionSchema,
  ornithGitStatusActionSchema,
  ornithGitDiffActionSchema,
  ornithRunVerificationActionSchema,
  ornithFinishActionSchema,
  ornithBlockedActionSchema
]);
export type OrnithAction = z.infer<typeof ornithActionSchema>;
export type OrnithActionKind = OrnithAction['action'];

/**
 * The runtime-side grammar for one Ornith action. This intentionally constrains
 * JSON structure and numeric/cardinality bounds only; the Zod schemas above
 * remain authoritative for path, credential-shape, byte and semantic checks.
 * Avoiding regex/ref features also keeps llama.cpp schema-to-grammar conversion
 * on its small, deterministic subset.
 */
export const ORNITH_ACTION_JSON_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'list_files' },
        prefix: { type: 'string' },
        cursor: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: ORNITH_LIMITS.maxListFilesLimit }
      },
      required: ['version', 'action', 'prefix', 'limit'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'read_file' },
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: ORNITH_LIMITS.maxReadBytes }
      },
      required: ['version', 'action', 'path', 'offset', 'limit'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'search_text' },
        query: { type: 'string', minLength: 1, maxLength: ORNITH_LIMITS.maxSearchQueryLength },
        caseSensitive: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' }, maxItems: ORNITH_LIMITS.maxSearchFiles },
        limit: { type: 'integer', minimum: 1, maximum: ORNITH_LIMITS.maxSearchMatches }
      },
      required: ['version', 'action', 'query', 'caseSensitive', 'limit'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'create_file' },
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['version', 'action', 'path', 'content'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'replace_text' },
        path: { type: 'string' },
        sha256: { type: 'string' },
        replacements: {
          type: 'array',
          minItems: 1,
          maxItems: ORNITH_LIMITS.maxReplacements,
          items: {
            type: 'object',
            properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
            required: ['oldText', 'newText'],
            additionalProperties: false
          }
        }
      },
      required: ['version', 'action', 'path', 'sha256', 'replacements'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'delete_file' },
        path: { type: 'string' },
        sha256: { type: 'string' }
      },
      required: ['version', 'action', 'path', 'sha256'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'git_status' }
      },
      required: ['version', 'action'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'git_diff' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: ORNITH_LIMITS.maxGitDiffPaths }
      },
      required: ['version', 'action'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'run_verification' }
      },
      required: ['version', 'action'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'finish' },
        summary: { type: 'string', minLength: 1, maxLength: ORNITH_LIMITS.maxFinishSummaryChars }
      },
      required: ['version', 'action', 'summary'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        version: { const: ORNITH_PROTOCOL_VERSION },
        action: { const: 'blocked' },
        reason: { type: 'string', minLength: 1, maxLength: ORNITH_LIMITS.maxBlockedReasonChars }
      },
      required: ['version', 'action', 'reason'],
      additionalProperties: false
    }
  ]
} as const;

export const ORNITH_ACTION_KINDS: readonly OrnithActionKind[] = [
  'list_files',
  'read_file',
  'search_text',
  'create_file',
  'replace_text',
  'delete_file',
  'git_status',
  'git_diff',
  'run_verification',
  'finish',
  'blocked'
];

/** Actions that consume a turn but do not end the loop. */
export const ORNITH_NONTERMINAL_ACTION_KINDS: readonly OrnithActionKind[] = [
  'list_files',
  'read_file',
  'search_text',
  'create_file',
  'replace_text',
  'delete_file',
  'git_status',
  'git_diff',
  'run_verification'
];

export function isOrnithTerminalAction(kind: OrnithActionKind): boolean {
  return kind === 'finish' || kind === 'blocked';
}

/* -------------------------------------------------------------------------- */
/* Completion parsing                                                         */
/* -------------------------------------------------------------------------- */

export type OrnithActionParseResult =
  | { readonly ok: true; readonly action: OrnithAction }
  | { readonly ok: false; readonly code: OrnithDenialCode; readonly reason: string };

/**
 * Parse one raw model completion into exactly one accepted action.
 *
 * Deliberately intolerant: the whole trimmed text is handed to `JSON.parse`
 * once. Prose before or after the object, a Markdown code fence, a trailing
 * comma, or any other near-miss is a parse failure, not something this
 * function tries to recover from. Any oversized completion is refused before
 * `JSON.parse` even runs, so a pathological payload cannot spend CPU parsing
 * something that was always going to be rejected on size alone.
 */
export function parseOrnithCompletion(raw: string): OrnithActionParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'malformed_output', reason: 'The completion was empty.' };
  }
  if (Buffer.byteLength(trimmed, 'utf8') > ORNITH_LIMITS.maxCompletionBytes) {
    return {
      ok: false,
      code: 'oversized_output',
      reason: `The completion exceeded the ${ORNITH_LIMITS.maxCompletionBytes}-byte limit.`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'malformed_output', reason: 'The completion was not a single valid JSON document.' };
  }

  const result = ornithActionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      code: 'malformed_output',
      reason: 'The completion did not match the Ornith action schema.'
    };
  }
  return { ok: true, action: result.data };
}
