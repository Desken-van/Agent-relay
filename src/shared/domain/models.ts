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
  /** Codex model override, or null for the Codex default. */
  codexModel: z.string().nullable()
});

export type Settings = z.infer<typeof settingsSchema>;
