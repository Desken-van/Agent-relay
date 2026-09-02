/**
 * Persisted domain models.
 *
 * Each model is declared once as a Zod schema and its TypeScript type is
 * inferred from it, so the database row shape, the IPC payload shape and the
 * compile-time type can never drift apart.
 *
 * Timestamps are ISO-8601 strings in UTC. They are stored as TEXT in SQLite
 * because that keeps rows human-readable when debugging with any SQLite client.
 */

import { z } from 'zod';
import { TASK_STATUSES } from './workflow';

/** ISO-8601 instant, e.g. `2026-08-10T09:41:12.004Z`. */
export const isoDateTime = z.string().min(20).max(32);

export const idSchema = z.string().min(1).max(64);

/* -------------------------------------------------------------------------- */
/* Project                                                                     */
/* -------------------------------------------------------------------------- */

export const PROJECT_TYPES = ['existing', 'new'] as const;
export const GITHUB_VISIBILITIES = ['private', 'public'] as const;

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  localPath: z.string().min(1),
  projectType: z.enum(PROJECT_TYPES),
  defaultBranch: z.string().min(1).max(255),
  githubOwner: z.string().max(200).nullable(),
  githubRepo: z.string().max(200).nullable(),
  githubVisibility: z.enum(GITHUB_VISIBILITIES),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type GithubVisibility = (typeof GITHUB_VISIBILITIES)[number];

/* -------------------------------------------------------------------------- */
/* Task                                                                        */
/* -------------------------------------------------------------------------- */

export const taskStatusSchema = z.enum(TASK_STATUSES);

/** Upper bound on a model identifier. Real ones are far shorter. */
export const MODEL_ID_MAX_LENGTH = 200;

/**
 * A model identifier, normalised.
 *
 * Trimmed, and an empty or whitespace-only value becomes `null` rather than
 * `''` — the UI's "Tool default" and a cleared text box must both land on the
 * same stored value, or two representations of "no override" would exist.
 *
 * Note for callers: `null` and `undefined` mean different things upstream.
 * `null` is an explicit "use the tool default"; `undefined` means the field was
 * omitted and a default should be inherited. Never collapse them with `??`.
 */
export const modelIdSchema = z
  .string()
  .max(MODEL_ID_MAX_LENGTH, `A model id may be at most ${MODEL_ID_MAX_LENGTH} characters.`)
  // Checked *before* trimming, deliberately. Trimming first would strip a
  // trailing newline or tab and then accept the value as clean, so a control
  // character at either end would pass exactly where it matters most.
  .refine(
    (value) => !hasControlCharacter(value),
    'A model id may not contain control characters.'
  )
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

/**
 * Claude Code model aliases the picker offers.
 *
 * The CLI documents these as "an alias for the latest model"; a full model name
 * such as `claude-opus-5` is equally valid, which is why this is a convenience
 * list for the UI and never a validation allow-list. Whether the account can
 * actually use a model is known only to the CLI.
 */
export const CLAUDE_MODEL_ALIASES = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' }
] as const;

export const taskSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().min(1).max(300),
  originalRequest: z.string().min(1),
  status: taskStatusSchema,
  currentRound: z.number().int().min(0),
  maxRounds: z.number().int().min(1).max(20),
  codexThreadId: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  /** Base branch the worktree was cut from. */
  baseBranch: z.string().nullable(),
  /** JSON-serialised `TaskSpecification`, set once Codex produces one. */
  specificationJson: z.string().nullable(),
  /** Set when the user explicitly approves the specification. */
  specificationApprovedAt: isoDateTime.nullable(),
  /** JSON-serialised `CodexReviewResult` from the most recent review. */
  lastReviewJson: z.string().nullable(),
  lastError: z.string().nullable(),
  /**
   * Model snapshot, taken once when the task is created and never changed.
   *
   * A task's model has to be fixed: its Codex thread and Claude session are
   * resumed for reviews and corrections, and swapping the model underneath an
   * existing conversation is behaviour neither tool defines. `null` means no
   * override — the tool uses its own default.
   */
  codexModel: z.string().min(1).max(MODEL_ID_MAX_LENGTH).nullable(),
  claudeModel: z.string().min(1).max(MODEL_ID_MAX_LENGTH).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export type Task = z.infer<typeof taskSchema>;

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

export const RUN_AGENTS = ['codex', 'claude', 'system'] as const;
export const RUN_TYPES = [
  'specification',
  'implementation',
  'review',
  'correction',
  'git',
  'github'
] as const;
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

export const runSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  agent: z.enum(RUN_AGENTS),
  runType: z.enum(RUN_TYPES),
  status: z.enum(RUN_STATUSES),
  /** 1-based relay round this run belongs to (0 for pre-loop work). */
  round: z.number().int().min(0),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  finalMessage: z.string().nullable(),
  /** JSON-serialised structured payload (specification / review result / git summary). */
  structuredResult: z.string().nullable(),
  errorMessage: z.string().nullable()
});

export type Run = z.infer<typeof runSchema>;
export type RunAgent = (typeof RUN_AGENTS)[number];
export type RunType = (typeof RUN_TYPES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* RunEvent                                                                    */
/* -------------------------------------------------------------------------- */

export const RUN_EVENT_TYPES = [
  'started',
  'log',
  'stderr',
  'thinking',
  'tool_use',
  'file_change',
  'command',
  'assistant_message',
  'progress',
  'result',
  /**
   * A round that succeeded, with something the reviewer should know first.
   *
   * Deliberately an event type rather than a run status: the run did succeed,
   * and inventing a fourth outcome would make every consumer that switches on
   * status wrong at once. The timeline shows it in amber; the run stays green.
   */
  'warning',
  'error',
  'cancelled',
  'finished'
] as const;

export const runEventSchema = z.object({
  id: idSchema,
  runId: idSchema,
  timestamp: isoDateTime,
  type: z.enum(RUN_EVENT_TYPES),
  /** Free-form JSON payload. Always a string in the database. */
  payload: z.string()
});

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Approval                                                                    */
/* -------------------------------------------------------------------------- */

export const APPROVAL_ACTIONS = [
  'commit',
  'push',
  'create_repository',
  'create_pull_request'
] as const;
export const APPROVAL_STATUSES = ['pending', 'granted', 'denied'] as const;

export const approvalSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  action: z.enum(APPROVAL_ACTIONS),
  status: z.enum(APPROVAL_STATUSES),
  /** JSON snapshot of exactly what the user was shown when they confirmed. */
  details: z.string(),
  requestedAt: isoDateTime,
  resolvedAt: isoDateTime.nullable()
});

export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/** True when a rule contains a control character, which no real rule does. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Upper bound on how many permission rules a user may grant. */
export const CLAUDE_ALLOWED_TOOLS_LIMIT = 50;

/** Upper bound on the length of a single permission rule. */
export const CLAUDE_TOOL_RULE_MAX_LENGTH = 200;

/**
 * One Claude Code permission rule, e.g. `Bash(npm test *)`.
 *
 * Surrounding whitespace is trimmed, because these arrive from a textarea where
 * a stray space is invisible and would silently stop a rule from matching.
 */
export const claudeToolRuleSchema = z
  .string()
  .max(CLAUDE_TOOL_RULE_MAX_LENGTH, `A permission rule may be at most ${CLAUDE_TOOL_RULE_MAX_LENGTH} characters.`)
  .transform((rule) => rule.trim())
  .refine((rule) => rule.length > 0, 'A permission rule cannot be empty.')
  .refine(
    (rule) => !hasControlCharacter(rule),
    'A permission rule may not contain control characters.'
  );

/**
 * The permission rules pre-approved by default.
 *
 * Deliberately just enough to run the project's tests, through either shell. A
 * broad rule such as `Bash(*)` would pre-approve the whole shell for an agent
 * nobody is watching.
 */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  'Bash(npm test *)',
  'PowerShell(npm test *)'
];

/**
 * The rules whose success counts as having verified the work, by default.
 *
 * Identical to {@link DEFAULT_CLAUDE_ALLOWED_TOOLS} today, and still spelled out
 * separately: the two lists answer different questions, and deriving one from
 * the other would quietly turn every newly permitted command into evidence that
 * the change works.
 */
export const DEFAULT_CLAUDE_VERIFICATION_TOOLS: readonly string[] = [
  'Bash(npm test *)',
  'PowerShell(npm test *)'
];

/**
 * The permission rules a fresh install ships with.
 *
 * Used by the Settings form's Reset, so "reset" means the same thing there as
 * it does for a new profile: back to the two rules that let Claude run the
 * project's tests, and nothing else.
 */
export function defaultClaudePermissionRules(): {
  claudeAllowedTools: string[];
  claudeVerificationTools: string[];
} {
  return {
    claudeAllowedTools: [...DEFAULT_CLAUDE_ALLOWED_TOOLS],
    claudeVerificationTools: [...DEFAULT_CLAUDE_VERIFICATION_TOOLS]
  };
}

export const settingsSchema = z.object({
  /** Absolute path to the Claude Code executable, or null to auto-discover. */
  claudeExecutablePath: z.string().nullable(),
  /** Absolute path to the Codex executable, or null to use the bundled/PATH one. */
  codexExecutablePath: z.string().nullable(),
  /** Absolute path to the GitHub CLI, or null to use PATH. */
  ghExecutablePath: z.string().nullable(),
  /** Default GitHub owner used when creating repositories. */
  githubOwner: z.string().max(200),
  /** Where "new project" directories are created by default. */
  projectsRoot: z.string(),
  /** Where per-task Git worktrees are created. */
  worktreesRoot: z.string(),
  /** Hard ceiling on Codex review rounds per task. */
  maxReviewRounds: z.number().int().min(1).max(20),
  /** Milliseconds before an agent process is cancelled. */
  processTimeoutMs: z.number().int().min(30_000).max(24 * 60 * 60_000),
  /** Maximum characters of log text kept per run. */
  maxStoredLogBytes: z.number().int().min(10_000).max(50_000_000),
  /** Maximum characters of `git diff` sent to Codex for review. */
  maxDiffBytes: z.number().int().min(1_000).max(5_000_000),
  /** Claude Code `--max-turns` value for a single implementation run. */
  claudeMaxTurns: z.number().int().min(1).max(500),
  /**
   * Extra Claude Code permission rules pre-approved for the unattended
   * implementation run, passed through to `--allowedTools`.
   *
   * Matching commands execute without a prompt inside the task's worktree, so
   * the list is meant to stay short. It is a pre-approval, not the complete set
   * of what Claude can do — see the adapter for what else the permission mode
   * and the project's own settings allow. Nothing here can re-enable a direct
   * match on the fixed destructive deny list, which is applied afterwards.
   */
  claudeAllowedTools: z.array(claudeToolRuleSchema).max(CLAUDE_ALLOWED_TOOLS_LIMIT),
  /**
   * Which of the allowed commands count as *checking the work*.
   *
   * A strict subset of `claudeAllowedTools`, and not derived from it: being
   * permitted to run a command says nothing about whether running it
   * demonstrates the change is correct. `Bash(git status *)` may be perfectly
   * reasonable to allow and proves nothing.
   *
   * A round whose verification did not demonstrably run and pass cannot be
   * published, so an empty list is rejected at save time rather than quietly
   * blocking every round afterwards.
   */
  claudeVerificationTools: z
    .array(claudeToolRuleSchema)
    .max(CLAUDE_ALLOWED_TOOLS_LIMIT),
  /**
   * Default Codex model offered when *creating a new task*.
   *
   * This is only a form default. A task snapshots its own pair at creation, so
   * changing this never affects a task that already exists.
   */
  codexModel: modelIdSchema,
  /** Default Claude model offered when creating a new task. Same semantics. */
  claudeModel: modelIdSchema
});

export type Settings = z.infer<typeof settingsSchema>;

/* -------------------------------------------------------------------------- */
/* Settings form state                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The two textareas in the Claude permissions card, and the parsed values
 * behind them.
 *
 * `null` text means "show whatever is in the saved settings"; a string means the
 * user has typed something the draft has not necessarily caught up with. Both
 * have to move together, or the form shows one thing and saves another.
 */
export interface PermissionRuleDraft {
  readonly claudeAllowedTools: string[];
  readonly claudeVerificationTools: string[];
  readonly allowedText: string | null;
  readonly verificationText: string | null;
}

/**
 * What **Reset** applies: the shipped rules, in both lists and both textareas.
 *
 * Reset restores the defaults rather than the last saved values because it is
 * the way out of a saved configuration the validator now rejects — reverting to
 * the rejected text would leave the Save button disabled and no way forward.
 */
export function resetPermissionRules(): PermissionRuleDraft {
  const rules = defaultClaudePermissionRules();
  return {
    ...rules,
    allowedText: rules.claudeAllowedTools.join('\n'),
    verificationText: rules.claudeVerificationTools.join('\n')
  };
}

/**
 * Whether the form has unsaved changes, and whether Save should be offered.
 *
 * Two independent conditions, and the bug this exists to fix was having only
 * one of them: the button was enabled whenever the rules validated, so a
 * successful save left it looking as though the work had not been done. A
 * button that never goes quiet cannot tell anyone whether their change landed.
 *
 * `dirty` compares the whole settings object, not just the permission lists —
 * every field on this form goes through the same draft.
 */
export interface SettingsSaveState {
  /** The draft differs from what is stored. */
  readonly dirty: boolean;
  /** There is something to save, and it is valid. */
  readonly canSave: boolean;
}

/** Stable key order, so two equal objects always serialise the same way. */
function canonicalSettings(settings: Settings): string {
  const entries = Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function settingsAreEqual(a: Settings, b: Settings): boolean {
  return canonicalSettings(a) === canonicalSettings(b);
}

export function settingsSaveState(input: {
  /** What the store currently holds; null while settings are still loading. */
  readonly saved: Settings | null;
  /** The draft the form would submit; null when there are no local edits. */
  readonly draft: Settings | null;
  /** How many verification rules the validator rejected. */
  readonly blockingProblems: number;
}): SettingsSaveState {
  const { saved, draft, blockingProblems } = input;

  // Nothing loaded, or no draft to compare: there is nothing to save.
  if (saved === null || draft === null) return { dirty: false, canSave: false };

  const dirty = !settingsAreEqual(saved, draft);
  return { dirty, canSave: dirty && blockingProblems === 0 };
}

/**
 * What a successful **Save** applies: nothing.
 *
 * The draft is dropped so the form re-reads the values that were just stored.
 * Deliberately not the same operation as Reset — sharing one made a successful
 * save silently replace the user's own rules with the defaults, and then write
 * those defaults on the next save.
 */
export function clearLocalEdits(): {
  readonly draft: null;
  readonly allowedText: null;
  readonly verificationText: null;
} {
  return { draft: null, allowedText: null, verificationText: null };
}
