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
import type {
  OperationEnvironment,
  OperationTarget,
  OperationTargetConfig
} from '../shared/domain/operations';
import type {
  DiagnosticFailureKind,
  DiagnosticLimits,
  DiagnosticProbeId,
  DiagnosticResult,
  OperationDiagnosticRun
} from '../shared/domain/operations-diagnostics';
import type { PublishConfirmation } from '../shared/ipc';
import type { CodexReviewResult, TaskSpecification } from '../shared/schemas/codex';

/* -------------------------------------------------------------------------- */
/* Infrastructure primitives                                                   */
/* -------------------------------------------------------------------------- */

export interface Clock {
  now(): Date;
  nowIso(): string;
}

/**
 * Runs a unit of work inside one database transaction.
 *
 * Exists so a service can be atomic without holding a database handle and
 * writing SQL of its own. Nesting is safe — the SQLite layer uses a savepoint
 * for an inner transaction.
 */
export interface TransactionRunner {
  run(work: () => void): void;
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
  /**
   * Every task sitting in a busy status, across all projects.
   *
   * Only startup reconciliation needs this: a task is busy because an agent is
   * running, and after a crash the rows saying so are the only trace left.
   */
  listBusy(): Task[];
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
  /**
   * Every run still marked `running`, across all tasks.
   *
   * A run is only ever finished by the code that started it, so after an abrupt
   * exit these are exactly the runs nothing will ever close on its own.
   */
  listRunning(): Run[];
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
  /**
   * Permission rules to pre-approve for this run.
   *
   * Supplied by the caller so that the rules the CLI is given and the rules the
   * round is later judged against come from one reading of Settings. The
   * adapter can read Settings itself, but a second read is a second answer:
   * Settings edited while a worktree was being prepared would otherwise leave
   * the policy assessing a list the process never had.
   *
   * Omitted means "use whatever the adapter was constructed with".
   */
  readonly allowedTools?: readonly string[];
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
  /**
   * The command the CLI refused, when it reported one.
   *
   * Taken from `tool_input.command`, or recovered from the matching tool use
   * by id. Never reconstructed from the reason text: a guess here would later
   * decide whether a round is safe, and a wrong guess is worse than no answer.
   * Null means "the CLI did not say".
   *
   * May be a truncated preview — see {@link commandTruncated}.
   */
  readonly command: string | null;
  /** See {@link ClaudeToolExecution.commandTruncated}; the same rules apply. */
  readonly commandTruncated: boolean;
  /**
   * {@link ClaudeToolExecution.toolUseSequence} of the call this refused, or
   * null when no call could be tied to it.
   *
   * Filled in later if the denial is reported before the call it names. Only
   * ever taken from a matching `tool_use_id`: a denial with no id stays null,
   * and an identical command is not a link — see the note on that field.
   */
  readonly toolUseSequence: number | null;
  /**
   * Which part of the stream reported it.
   *
   * A denial normally arrives twice — as a `permission_denied` event and again
   * in the result envelope — and stays one record either way. `'both'` means
   * both reported it, which is the ordinary case and not a second denial.
   */
  readonly source: 'stream' | 'result' | 'both';
}

/**
 * One tool call Claude made, paired with its result where one arrived.
 *
 * Deliberately holds no output. The point is correlation and status — whether a
 * given call happened and whether it failed — not a second copy of the timeline.
 */
export interface ClaudeToolExecution {
  /** `tool_use.id`; null when the CLI omitted it, and then it cannot correlate. */
  readonly toolUseId: string | null;
  /**
   * Position of this call in the order Claude *made* the calls: 1, 2, 3…
   *
   * Array position cannot answer that question. A result may be flushed ahead
   * of its call, so an entry can be created before the call that owns it is
   * known, and its slot reflects when the stream first mentioned the id rather
   * than when Claude invoked anything.
   *
   * This is invocation order, never completion order — results arriving out of
   * order do not move it. Numbers are assigned once, when a real `tool_use` is
   * first seen: a re-delivered call keeps the number it already had, and a
   * placeholder standing in for a call that has not arrived holds null and
   * reserves nothing, so the sequence has no gaps. Anonymous calls each get
   * their own number, because they are separate invocations even though they
   * cannot be correlated to a result.
   *
   * Null means no call was seen at all — an orphan result.
   *
   * Scoped to one parser, and so to one CLI process: a resumed round starts
   * again at 1 and its numbers say nothing about the round before it.
   */
  readonly toolUseSequence: number | null;
  readonly tool: string;
  /**
   * The command for Bash/PowerShell; null for tools that do not run one.
   *
   * Redacted, and a preview rather than the whole command when it was long —
   * see {@link commandTruncated}.
   */
  readonly command: string | null;
  /**
   * True when {@link command} is only the leading part of what actually ran.
   *
   * False whenever `command` is null: "nothing was reported" is not "something
   * was cut". False also when the command fitted, and then `command` is the
   * complete redacted text.
   *
   * The full text is deliberately nowhere — not in this record, the run events,
   * the database or the logs. That makes this flag the only evidence that
   * something is missing, so a later policy **must** treat a truncated command
   * as unknown and fail closed. In particular it must not be classified as
   * auxiliary or as a verification command, and no security decision may rest
   * on a forbidden string being absent from the preview: the part that was cut
   * is exactly where such a string would hide.
   */
  readonly commandTruncated: boolean;
  /** Short, safe description for tools without a command (file path, pattern…). */
  readonly summary: string;
  /**
   * True when a `tool_use` block for this entry was actually seen.
   *
   * False marks an orphan: a `tool_result` arrived whose call never did, so
   * `tool`, `command` and `summary` are placeholders and describe nothing.
   * Together with {@link resultReceived} this distinguishes the three shapes a
   * record can have — a completed call, a call still open, and a result that
   * cannot be attributed to any call.
   */
  readonly toolUseSeen: boolean;
  /** True once a `tool_result` carrying this id arrived. */
  readonly resultReceived: boolean;
  /**
   * `tool_result.is_error`, or null when the outcome is not known.
   *
   * Null is not success — it is "the stream did not say", either because the
   * field was absent or because two results contradicted each other. It is
   * never inferred from output text, because "no errors printed" and "the
   * command succeeded" are different claims.
   */
  readonly isError: boolean | null;
  /**
   * True when two results for this id disagreed about `is_error`.
   *
   * The stream should never do this. When it does, {@link isError} goes back to
   * null rather than keeping whichever value happened to arrive first: a caller
   * that forgets this flag entirely still cannot read a contradiction as a pass.
   * Nothing is lost by refusing to choose — there are only two boolean values,
   * so this flag already says that both were seen.
   */
  readonly resultConflict: boolean;
}

/**
 * What the stream actually contained, separate from what it means.
 *
 * Phase 6A records this; nothing decides anything differently because of it
 * yet. A permission denial still fails the round exactly as before.
 */
export interface ClaudeStreamEvidence {
  readonly toolExecutions: readonly ClaudeToolExecution[];
  /** True when the CLI emitted its final `result` envelope. */
  readonly resultEnvelopeSeen: boolean;
  /**
   * `is_error` as the final envelope stated it, or null when it did not.
   *
   * Null covers three different silences — no envelope, no field, and two
   * envelopes that disagreed — and none of them is success. Read alongside
   * {@link resultEnvelopeConflict} to tell the last case from the others.
   *
   * Separate from {@link ClaudeImplementationResult.isError}, which is the
   * outcome the application acts on and folds in denials and process failures.
   * This field is only what the envelope literally said.
   */
  readonly resultEnvelopeIsError: boolean | null;
  /**
   * True when more than one final envelope arrived and they disagreed.
   *
   * The CLI should send exactly one. If it sends two that contradict each other,
   * {@link resultEnvelopeIsError} goes to null rather than keeping either value,
   * on the same reasoning as {@link ClaudeToolExecution.resultConflict}.
   */
  readonly resultEnvelopeConflict: boolean;
  /** Non-empty stdout lines that were not valid JSON. */
  readonly malformedLineCount: number;
  /** Calls seen but never answered: `toolUseSeen && !resultReceived`. */
  readonly incompleteToolUseCount: number;
  /** Results that named no call we ever saw: `!toolUseSeen`. */
  readonly orphanToolResultCount: number;
}

export interface ClaudeImplementationResult {
  readonly sessionId: string | null;
  readonly finalMessage: string;
  /**
   * The CLI reported a failure: an `error` event, or a final envelope saying so.
   *
   * Not the round's verdict. A refused tool call leaves this false — the CLI
   * exits 0 and calls the round a success — which is exactly why the outcome is
   * decided from {@link evidence} and {@link permissionDenials} by the round
   * policy instead. Kept for diagnostics and for the process-level failures the
   * policy has no opinion about.
   */
  readonly isError: boolean;
  readonly numTurns: number | null;
  readonly rawResultJson: string | null;
/**
   * Tool calls Claude was refused.
   *
   * Non-empty does *not* imply {@link isError}: whether a refusal sank the round
   * depends on what was refused and whether the work was verified regardless,
   * which is a judgement the round policy makes.
   */
  readonly permissionDenials: readonly ClaudePermissionDenial[];
  /**
   * Structured record of what the stream contained. Not persisted, and not yet
   * consulted by any decision — it exists so a later policy can tell an
   * incidental refusal apart from a round that never ran its tests.
   */
  readonly evidence: ClaudeStreamEvidence;
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

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export type NewOperationTarget = Omit<OperationTarget, 'createdAt' | 'updatedAt'>;

export interface StoredTargetPatch {
  readonly name?: string;
  readonly environment?: OperationEnvironment;
  readonly config?: OperationTargetConfig;
  readonly credentialRef?: string | null;
  readonly enabled?: boolean;
}

export interface OperationTargetRepository {
  list(): OperationTarget[];
  findById(id: string): OperationTarget | null;
  create(target: NewOperationTarget): OperationTarget;
  update(id: string, patch: StoredTargetPatch): OperationTarget;
  delete(id: string): void;
}

export interface NewDiagnosticRun {
  readonly id: string;
  readonly targetId: string;
  readonly probeId: DiagnosticProbeId;
  readonly startedAt: string;
}

/**
 * How a diagnostic run ended.
 *
 * A union rather than one shape with optional fields, so the combinations that
 * make no sense cannot be written down: a success carrying an error message, a
 * failure still holding the result of an earlier attempt. The table enforces
 * the same three shapes, and the repository checks them again at runtime —
 * a type is a promise to the compiler, not to a caller that reached for `as`.
 */
export type DiagnosticOutcome =
  | {
      readonly status: 'succeeded';
      readonly finishedAt: string;
      readonly result: DiagnosticResult;
      readonly failureKind?: never;
      readonly errorMessage?: never;
    }
  | {
      readonly status: 'failed';
      readonly finishedAt: string;
      readonly failureKind: DiagnosticFailureKind;
      /** Never empty: a failure with nothing to say is not a record of anything. */
      readonly errorMessage: string;
      readonly result?: never;
    };

export interface OperationDiagnosticRepository {
  listByTarget(targetId: string, limit?: number): OperationDiagnosticRun[];
  findById(id: string): OperationDiagnosticRun | null;
  /** Every run still marked `running`, across all targets. */
  listRunning(): OperationDiagnosticRun[];
  /** The still-running run for one target, if any. */
  findRunningForTarget(targetId: string): OperationDiagnosticRun | null;
  countByTarget(targetId: string): number;
  start(run: NewDiagnosticRun): OperationDiagnosticRun;
  finish(id: string, outcome: DiagnosticOutcome): OperationDiagnosticRun;
}

/**
 * A read-only probe against one target.
 *
 * The port takes a *probe id*, never a statement. An implementation is chosen by
 * the registry from a fixed table keyed on {@link OperationTarget.adapterType},
 * so nothing that crosses IPC or comes out of a model can select, name or
 * describe the code that runs.
 */
export interface OperationProbeAdapter {
  probe(request: OperationProbeRequest): Promise<OperationProbeOutcome>;
}

export interface OperationProbeRequest {
  readonly target: OperationTarget;
  readonly probeId: DiagnosticProbeId;
  readonly limits: DiagnosticLimits;
  readonly signal?: AbortSignal;
}

/**
 * What a probe attempt produced.
 *
 * Never a rejected promise: a failure is a fact about the target, and the
 * service has to persist it as one. `kind` distinguishes the four ways a probe
 * can fail to prove anything, so `failed` never has to stand for all of them.
 */
export type OperationProbeOutcome =
  | { readonly ok: true; readonly result: DiagnosticResult }
  | {
      readonly ok: false;
      readonly kind: DiagnosticFailureKind;
      readonly message: string;
    };
