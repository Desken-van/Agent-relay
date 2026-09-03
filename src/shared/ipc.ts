/**
 * The complete, typed contract between the renderer and the main process.
 *
 * Design rules enforced here:
 *
 *  * The renderer can only name a *channel*, never a command. There is no
 *    "run this string" channel anywhere in the application.
 *  * Every channel declares a Zod schema for its input. The main process
 *    validates against it before the handler body runs, so a compromised or
 *    buggy renderer cannot smuggle an unexpected shape through.
 *  * Handlers return {@link IpcResult}, never a rejected promise, so the
 *    renderer always receives a structured, redacted error.
 */

import { z } from 'zod';
import type { CodexModelCatalogResult } from './domain/codex-catalog';
import type { DiagnosticsReport } from './domain/diagnostics';
import type { SerializedError } from './domain/errors';
import type { GitChangeSet, ProjectValidation, RepositoryInfo, WorktreeInfo } from './domain/git';
import {
  APPROVAL_ACTIONS,
  GITHUB_VISIBILITIES,
  modelIdSchema,
  type Approval,
  type Project,
  type Run,
  type RunEvent,
  type Settings,
  type Task,
  settingsSchema
} from './domain/models';
import {
  newOperationTargetSchema,
  operationTargetPatchSchema,
  type OperationTarget
} from './domain/operations';
import {
  diagnosticOptionsSchema,
  diagnosticProbeIdSchema,
  type OperationDiagnosticRun
} from './domain/operations-diagnostics';
import type { CodexReviewResult, TaskSpecification } from './schemas/codex';

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SerializedError };

/* -------------------------------------------------------------------------- */
/* Composite read models                                                       */
/* -------------------------------------------------------------------------- */

export interface TaskDetail {
  readonly task: Task;
  readonly project: Project;
  readonly runs: readonly Run[];
  readonly approvals: readonly Approval[];
  readonly specification: TaskSpecification | null;
  readonly lastReview: CodexReviewResult | null;
  readonly worktree: WorktreeInfo | null;
}

/** Exactly what the user is shown before any GitHub- or repo-mutating action. */
export interface PublishConfirmation {
  readonly action: (typeof APPROVAL_ACTIONS)[number];
  readonly headline: string;
  readonly account: string;
  readonly repository: string;
  readonly visibility: string;
  readonly branch: string;
  readonly details: readonly string[];
  /** True when the action reaches the network / GitHub. */
  readonly affectsRemote: boolean;
}

export interface PublishOutcome {
  readonly action: (typeof APPROVAL_ACTIONS)[number];
  readonly approvalId: string;
  readonly performed: boolean;
  readonly message: string;
  readonly url: string | null;
}

/** Push payload delivered on the `agent-relay:event` channel. */
export type AppEvent =
  | { readonly kind: 'task-updated'; readonly task: Task }
  | { readonly kind: 'project-updated'; readonly project: Project }
  | { readonly kind: 'run-started'; readonly run: Run }
  | { readonly kind: 'run-updated'; readonly run: Run }
  | { readonly kind: 'run-event'; readonly taskId: string; readonly event: RunEvent }
  | { readonly kind: 'diagnostics'; readonly report: DiagnosticsReport };

/* -------------------------------------------------------------------------- */
/* Input schemas                                                               */
/* -------------------------------------------------------------------------- */

const empty = z.object({}).strict();
const byTask = z.object({ taskId: z.string().min(1) }).strict();
const byOperationTarget = z.object({ targetId: z.string().min(1) }).strict();

export const ipcInputSchemas = {
  'settings:get': empty,
  'settings:update': settingsSchema.partial().strict(),

  'diagnostics:run': z.object({ force: z.boolean().optional() }).strict(),

  /** Picker-visible Codex models. Never starts a thread or a turn. */
  'codex:listModels': z.object({ refresh: z.boolean().optional() }).strict(),

  'dialog:pickDirectory': z
    .object({ title: z.string().max(200).optional(), defaultPath: z.string().optional() })
    .strict(),

  'projects:list': empty,
  'projects:validatePath': z.object({ localPath: z.string().min(1) }).strict(),
  'projects:addExisting': z
    .object({
      localPath: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      defaultBranch: z.string().min(1).max(255).optional(),
      githubOwner: z.string().max(200).nullable().optional(),
      githubRepo: z.string().max(200).nullable().optional(),
      githubVisibility: z.enum(GITHUB_VISIBILITIES).optional()
    })
    .strict(),
  'projects:createNew': z
    .object({
      parentDirectory: z.string().min(1),
      name: z.string().min(1).max(100),
      defaultBranch: z.string().min(1).max(255).optional(),
      githubOwner: z.string().max(200).nullable().optional(),
      githubVisibility: z.enum(GITHUB_VISIBILITIES).optional()
    })
    .strict(),
  'projects:initGit': z.object({ projectId: z.string().min(1) }).strict(),
  'projects:update': z
    .object({
      projectId: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      defaultBranch: z.string().min(1).max(255).optional(),
      githubOwner: z.string().max(200).nullable().optional(),
      githubRepo: z.string().max(200).nullable().optional(),
      githubVisibility: z.enum(GITHUB_VISIBILITIES).optional()
    })
    .strict(),
  /** Removes the project from Agent Relay's database. Never touches the disk. */
  'projects:forget': z.object({ projectId: z.string().min(1) }).strict(),

  'tasks:list': z.object({ projectId: z.string().min(1) }).strict(),
  'tasks:get': byTask,
  'tasks:create': z
    .object({
      projectId: z.string().min(1),
      title: z.string().min(1).max(300),
      originalRequest: z.string().min(1).max(100_000),
      maxRounds: z.number().int().min(1).max(20).optional(),
      /**
       * `.optional()` with no `.default()` on purpose: an omitted field must
       * stay `undefined` so the service can tell "inherit the Settings
       * default" apart from an explicit `null` meaning "Tool default".
       */
      codexModel: modelIdSchema.optional(),
      claudeModel: modelIdSchema.optional()
    })
    .strict(),

  'runs:listByTask': byTask,
  'runs:events': z
    .object({ runId: z.string().min(1), afterId: z.string().min(1).optional(), limit: z.number().int().min(1).max(5000).optional() })
    .strict(),

  'workflow:generateSpecification': byTask,
  'workflow:approveSpecification': byTask,
  'workflow:sendToClaude': z
    .object({
      taskId: z.string().min(1),
      /**
       * Set only when the user has been shown the dirty working tree and chosen
       * to continue anyway. Without it, a dirty repository blocks worktree
       * creation.
       */
      acceptDirtyWorkingTree: z.boolean().optional()
    })
    .strict(),
  'workflow:reviewWithCodex': byTask,
  'workflow:sendCorrections': byTask,
  'workflow:stop': byTask,
  'workflow:approveForPublishing': byTask,

  'git:changes': z.object({ taskId: z.string().min(1), refresh: z.boolean().optional() }).strict(),
  'git:repositoryInfo': z.object({ projectId: z.string().min(1) }).strict(),

  'publish:prepare': z
    .object({
      taskId: z.string().min(1),
      action: z.enum(APPROVAL_ACTIONS),
      commitMessage: z.string().min(1).max(2000).optional(),
      repositoryName: z.string().min(1).max(100).optional(),
      owner: z.string().min(1).max(100).optional(),
      visibility: z.enum(GITHUB_VISIBILITIES).optional(),
      pullRequestTitle: z.string().min(1).max(300).optional(),
      pullRequestBody: z.string().max(60_000).optional()
    })
    .strict(),
  'publish:execute': z
    .object({
      taskId: z.string().min(1),
      action: z.enum(APPROVAL_ACTIONS),
      commitMessage: z.string().min(1).max(2000).optional(),
      repositoryName: z.string().min(1).max(100).optional(),
      owner: z.string().min(1).max(100).optional(),
      visibility: z.enum(GITHUB_VISIBILITIES).optional(),
      pullRequestTitle: z.string().min(1).max(300).optional(),
      pullRequestBody: z.string().max(60_000).optional()
    })
    .strict(),

  'shell:openExternal': z.object({ url: z.string().url().max(2000) }).strict(),
  'shell:revealPath': z.object({ path: z.string().min(1) }).strict(),

  /* ---------------------------------------------------------------------- */
  /* Operations — read-only                                                  */
  /* ---------------------------------------------------------------------- */
  //
  // Every one of these is either a lookup or a change to the *registry*.
  // `operations:runDiagnostic` names a probe from a fixed enum; there is no
  // field anywhere below through which a statement, a command or an
  // executable path can be sent, and the limits a caller may choose from are
  // bounded by the schema rather than trusted.
  'operations:listTargets': empty,
  'operations:getTarget': byOperationTarget,
  'operations:createTarget': newOperationTargetSchema,
  'operations:updateTarget': z
    .object({ targetId: z.string().min(1), patch: operationTargetPatchSchema })
    .strict(),
  'operations:deleteTarget': byOperationTarget,
  'operations:listDiagnostics': z
    .object({ targetId: z.string().min(1), limit: z.number().int().min(1).max(500).optional() })
    .strict(),
  'operations:runDiagnostic': z
    .object({
      targetId: z.string().min(1),
      probeId: diagnosticProbeIdSchema,
      options: diagnosticOptionsSchema.optional()
    })
    .strict()
} as const;

export type IpcChannel = keyof typeof ipcInputSchemas;

export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcInputSchemas)[C]>;

/** Return type of every channel. */
export interface IpcResponseMap {
  'settings:get': Settings;
  'settings:update': Settings;

  'diagnostics:run': DiagnosticsReport;

  'codex:listModels': CodexModelCatalogResult;

  'dialog:pickDirectory': string | null;

  'projects:list': Project[];
  'projects:validatePath': ProjectValidation;
  'projects:addExisting': Project;
  'projects:createNew': Project;
  'projects:initGit': Project;
  'projects:update': Project;
  'projects:forget': { removed: true };

  'tasks:list': Task[];
  'tasks:get': TaskDetail;
  'tasks:create': Task;

  'runs:listByTask': Run[];
  'runs:events': RunEvent[];

  'workflow:generateSpecification': Task;
  'workflow:approveSpecification': Task;
  'workflow:sendToClaude': Task;
  'workflow:reviewWithCodex': Task;
  'workflow:sendCorrections': Task;
  'workflow:stop': Task;
  'workflow:approveForPublishing': Task;

  'git:changes': GitChangeSet;
  'git:repositoryInfo': RepositoryInfo;

  'publish:prepare': PublishConfirmation;
  'publish:execute': PublishOutcome;

  'shell:openExternal': { opened: boolean };
  'shell:revealPath': { opened: boolean };

  'operations:listTargets': OperationTarget[];
  'operations:getTarget': OperationTarget;
  'operations:createTarget': OperationTarget;
  'operations:updateTarget': OperationTarget;
  'operations:deleteTarget': { removed: true };
  'operations:listDiagnostics': OperationDiagnosticRun[];
  'operations:runDiagnostic': OperationDiagnosticRun;
}

export const IPC_CHANNELS = Object.keys(ipcInputSchemas) as IpcChannel[];

export { APP_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from './ipc-channels';

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ipcInputSchemas, value);
}
