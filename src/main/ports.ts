/**
 * Ports: the interfaces that separate orchestration logic from the outside world.
 *
 * Everything Agent Relay cannot control — the filesystem, Git, GitHub, Codex,
 * Claude, the clock, the user's confirmation — is reached through one of these.
 * The orchestrator depends only on these types, which is what makes the relay
 * loop testable without touching a network or a real repository.
 */

import type {
  CodexModelCatalogResult,
  CodexModelOption
} from '../shared/domain/codex-catalog';
import type { DiagnosticsReport, ToolDiagnostic } from '../shared/domain/diagnostics';
import type { GitChangeSet, RepositoryInfo, WorktreeInfo } from '../shared/domain/git';
import type {
  Approval,
  ApprovalAction,
  ApprovalStatus,
  Project,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  Settings,
  Task
} from '../shared/domain/models';
import type { PublishConfirmation } from '../shared/ipc';
import type { CodexReviewResult, TaskSpecification } from '../shared/schemas/codex';

/* -------------------------------------------------------------------------- */
/* Infrastructure primitives                                                   */
/* -------------------------------------------------------------------------- */

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export interface IdGenerator {
  next(): string;
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

export type NewProject = Omit<Project, 'createdAt' | 'updatedAt'>;
export type ProjectPatch = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;

export interface ProjectRepository {
  list(): Project[];
  findById(id: string): Project | null;
  findByLocalPath(localPath: string): Project | null;
  create(project: NewProject): Project;
  update(id: string, patch: ProjectPatch): Project;
  delete(id: string): void;
}

export type NewTask = Omit<Task, 'createdAt' | 'updatedAt'>;
export type TaskPatch = Partial<Omit<Task, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;

export interface TaskRepository {
  listByProject(projectId: string): Task[];
  findById(id: string): Task | null;
  create(task: NewTask): Task;
  update(id: string, patch: TaskPatch): Task;
  /** Tasks whose worktree is currently allocated — used to prevent sharing. */
  listActiveWorktreePaths(): { taskId: string; worktreePath: string }[];
  delete(id: string): void;
}

export type NewRun = Omit<Run, 'finishedAt' | 'finalMessage' | 'structuredResult' | 'errorMessage'>;

export interface RunRepository {
  listByTask(taskId: string): Run[];
  findById(id: string): Run | null;
  create(run: NewRun): Run;
  finish(
    id: string,
    outcome: {
      status: RunStatus;
      finishedAt: string;
      finalMessage?: string | null;
      structuredResult?: string | null;
      errorMessage?: string | null;
    }
  ): Run;
  findLatestByType(taskId: string, runType: Run['runType']): Run | null;
}

export interface RunEventRepository {
  append(event: { runId: string; type: RunEventType; payload: string; timestamp: string; id: string }): RunEvent;
  listByRun(runId: string, options?: { afterId?: string; limit?: number }): RunEvent[];
  /** Total stored payload size for a run, used to enforce the log budget. */
  storedBytes(runId: string): number;
  deleteByRun(runId: string): void;
}

export interface ApprovalRepository {
  listByTask(taskId: string): Approval[];
  findById(id: string): Approval | null;
  create(approval: Approval): Approval;
  resolve(id: string, status: Exclude<ApprovalStatus, 'pending'>, resolvedAt: string): Approval;
  findGranted(taskId: string, action: ApprovalAction): Approval | null;
}

export interface SettingsRepository {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
}

/* -------------------------------------------------------------------------- */
/* Agent adapters                                                              */
/* -------------------------------------------------------------------------- */

/** A single incremental update from a running agent. */
export interface AgentProgressEvent {
  readonly type: RunEventType;
  readonly text: string;
  /** Extra structured data, already safe to persist. */
  readonly data?: Record<string, unknown>;
}

export interface AgentRunContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  onProgress(event: AgentProgressEvent): void;
}

export interface CodexSpecificationRequest {
  readonly projectPath: string;
  readonly taskTitle: string;
  readonly originalRequest: string;
  /** Existing thread to continue, or null to start a new one. */
  readonly threadId: string | null;
  /**
   * The task's snapshotted Codex model, or null for the tool's own default.
   *
   * Carried on the request rather than configured on the adapter: adapters are
   * rebuilt from Settings on every call, so a constructor option would make the
   * model follow current Settings instead of the task that owns the thread.
   */
  readonly model: string | null;
}

export interface CodexSpecificationResult {
  readonly threadId: string | null;
  readonly specification: TaskSpecification;
  readonly rawResponse: string;
}

export interface CodexReviewRequest {
  readonly worktreePath: string;
  readonly threadId: string | null;
  readonly specification: TaskSpecification;
  readonly changes: GitChangeSet;
  readonly claudeReport: string;
  readonly testOutput: string;
  readonly round: number;
  readonly maxRounds: number;
  /** Same snapshotted model as the specification that opened this thread. */
  readonly model: string | null;
}

export interface CodexReviewOutcome {
  readonly threadId: string | null;
  readonly review: CodexReviewResult;
  readonly rawResponse: string;
}

export type { CodexModelCatalogResult, CodexModelOption };

export interface CodexModelCatalog {
  /** Never rejects: an unreachable catalogue is `available: false`. */
  list(options?: { refresh?: boolean }): Promise<CodexModelCatalogResult>;
}

export interface CodexAdapter {
  /**
   * Produce a structured specification. Runs with workspace access limited to
   * reading the project, because the specification step must not edit anything.
   */
  createSpecification(
    request: CodexSpecificationRequest,
    context: AgentRunContext
  ): Promise<CodexSpecificationResult>;

  /** Review an implementation. MUST run with `sandboxMode: 'read-only'`. */
  reviewImplementation(
    request: CodexReviewRequest,
    context: AgentRunContext
  ): Promise<CodexReviewOutcome>;

  diagnose(): Promise<ToolDiagnostic>;
}

export interface ClaudeImplementationRequest {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly prompt: string;
  /** Existing session to resume via `--resume`, or null to start fresh. */
  readonly sessionId: string | null;
  readonly maxTurns: number;
  /** The task's snapshotted Claude model, or null for the tool's own default. */
  readonly model: string | null;
}

/**
 * A tool call Claude Code refused to run because it lacked permission.
 *
 * Defined here rather than in the adapter that happens to parse it: the
 * orchestrator reasons about denials, so the shape belongs to the port, and the
 * adapter is what conforms to it. Nothing inward may import an adapter.
 */
export interface ClaudePermissionDenial {
  readonly tool: string;
  /** Correlation id from the CLI, used to deduplicate. Null when absent. */
  readonly toolUseId: string | null;
  readonly reason: string;
}

export interface ClaudeImplementationResult {
  readonly sessionId: string | null;
  readonly finalMessage: string;
  readonly isError: boolean;
  readonly numTurns: number | null;
  readonly rawResultJson: string | null;
  /**
   * Tool calls Claude was refused. Non-empty always implies `isError`, because a
   * round that was blocked from part of its work did not succeed.
   */
  readonly permissionDenials: readonly ClaudePermissionDenial[];
}

export interface ClaudeAdapter {
  run(
    request: ClaudeImplementationRequest,
    context: AgentRunContext
  ): Promise<ClaudeImplementationResult>;
  diagnose(): Promise<ToolDiagnostic>;
}

/* -------------------------------------------------------------------------- */
/* Git & GitHub                                                                */
/* -------------------------------------------------------------------------- */

export interface CreateWorktreeRequest {
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly branchName: string;
  readonly worktreePath: string;
}

export interface GitAdapter {
  inspect(repositoryPath: string): Promise<RepositoryInfo>;
  branchExists(repositoryPath: string, branch: string): Promise<boolean>;
  createWorktree(request: CreateWorktreeRequest): Promise<WorktreeInfo>;
  listWorktrees(repositoryPath: string): Promise<WorktreeInfo[]>;
  /** Non-destructive: refuses when the worktree has uncommitted changes. */
  removeWorktree(repositoryPath: string, worktreePath: string): Promise<void>;
  collectChanges(
    worktreePath: string,
    baseBranch: string,
    options: { maxDiffBytes: number }
  ): Promise<GitChangeSet>;
  /** `git init` — only ever called after an explicit user confirmation. */
  initRepository(path: string, defaultBranch: string): Promise<RepositoryInfo>;
  stageAll(worktreePath: string): Promise<void>;
  commit(worktreePath: string, message: string): Promise<{ commit: string }>;
  push(worktreePath: string, remote: string, branch: string): Promise<{ output: string }>;
  diagnose(): Promise<ToolDiagnostic>;
}

export interface GitHubRepositoryRequest {
  readonly owner: string;
  readonly name: string;
  readonly visibility: 'private' | 'public';
  readonly localPath: string;
}

export interface GitHubPullRequestRequest {
  readonly worktreePath: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
}

export interface GitHubAdapter {
  diagnose(): Promise<ToolDiagnostic>;
  hasAccessToOwner(owner: string): Promise<boolean>;
  createRepository(request: GitHubRepositoryRequest): Promise<{ url: string; output: string }>;
  createPullRequest(request: GitHubPullRequestRequest): Promise<{ url: string; output: string }>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* User confirmation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The hard gate in front of every repository- or GitHub-mutating action.
 *
 * In production this is a native modal dialog owned by the main process, which
 * is why a compromised renderer cannot approve on the user's behalf. In tests it
 * is a stub, which is how "publishing cannot happen without approval" is proven.
 */
export interface ConfirmationService {
  confirm(request: PublishConfirmation): Promise<boolean>;
  /** Generic yes/no gate for other irreversible local actions (e.g. `git init`). */
  confirmSimple(request: {
    headline: string;
    detail: string;
    details: readonly string[];
    confirmLabel: string;
  }): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics & events                                                        */
/* -------------------------------------------------------------------------- */

export interface DiagnosticsService {
  run(force?: boolean): Promise<DiagnosticsReport>;
  cached(): DiagnosticsReport | null;
}

export interface EventPublisher {
  publishTask(task: Task): void;
  publishProject(project: Project): void;
  publishRun(run: Run, kind: 'run-started' | 'run-updated'): void;
  publishRunEvent(taskId: string, event: RunEvent): void;
  publishDiagnostics(report: DiagnosticsReport): void;
}
