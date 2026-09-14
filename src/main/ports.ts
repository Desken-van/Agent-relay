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
import type { ClaudeRoundAssessmentRecord } from '../shared/domain/claude-assessment';
import type { GitChangeSet, RepositoryInfo, WorktreeInfo } from '../shared/domain/git';
import type {
  LocalInferenceCapabilities,
  LocalInferenceOutcome,
  LocalInferenceRequest,
  LocalInferenceState
} from '../shared/domain/local-inference';
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
  Task,
  TaskContinuation,
  ContinuationClaim
} from '../shared/domain/models';
import type {
  OperationEnvironment,
  OperationTarget,
  OperationTargetConfig
} from '../shared/domain/operations';
import type { VerificationRecord } from '../shared/domain/verification';
import type {
  DiagnosticFailureKind,
  DiagnosticLimits,
  DiagnosticProbeId,
  DiagnosticResult,
  OperationDiagnosticRun
} from '../shared/domain/operations-diagnostics';
import type { RuleOmissionReason, RuleSourceKind } from '../shared/domain/rule-evidence';
import type { PublishConfirmation } from '../shared/ipc';
import type {
  PlanReviewDecision,
  PlanReviewFinding,
  PlanReviewGate,
  PlanReviewVerdict,
  TaskRuleEvidenceBinding
} from '../shared/domain/plan-review';
import type {
  CodeReviewDecision,
  CodeReviewFinding,
  CodeReviewOccurrence,
  CodeReviewRound,
  CodeReviewSubject,
  CodeSnapshotChange,
  ProviderCodeFinding
} from '../shared/domain/code-review';
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

export type NewTask = Omit<Task, 'createdAt' | 'updatedAt' | 'implementationProvider' | 'reviewProvider' | 'providerRevision' | 'implementationThreadId'> &
  Partial<Pick<Task, 'implementationProvider' | 'reviewProvider' | 'providerRevision' | 'implementationThreadId'>>;
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
  changeProviders(id: string, expectedRevision: number, implementation: Task['implementationProvider'], review: Task['reviewProvider']): Task;
  /** Tasks whose worktree is currently allocated — used to prevent sharing. */
  listActiveWorktreePaths(): { taskId: string; worktreePath: string }[];
  delete(id: string): void;
}

/** `createdAt` is owned by the repository and never supplied by a caller. */
export type NewTaskContinuation = Omit<TaskContinuation, 'createdAt'>;

/**
 * Persistence for the immutable source ↔ continuation link.
 *
 * There is deliberately no `update`: the link records a decision made once,
 * at creation, and nothing about it is ever revised afterwards.
 */
export interface TaskContinuationRepository {
  findBySource(sourceTaskId: string): TaskContinuation | null;
  findByContinuation(continuationTaskId: string): TaskContinuation | null;
  /**
   * @throws when a link already exists for this source or this continuation —
   * the UNIQUE constraints are the final arbiter under concurrent callers, and
   * a caller racing another must treat that as "someone else already created
   * it" and re-read with {@link findBySource} rather than retry the insert.
   */
  create(link: NewTaskContinuation): TaskContinuation;
  findClaimBySource(sourceTaskId: string): ContinuationClaim | null;
  findClaimByContinuation(continuationTaskId: string): ContinuationClaim | null;
  listClaims(): ContinuationClaim[];
  acquireClaim(input: {
    sourceTaskId: string;
    claimId: string;
    worktreePath: string;
  }): ContinuationClaim;
  bindClaim(input: {
    sourceTaskId: string;
    claimId: string;
    continuationTaskId: string;
    validatedIdentity: string;
    effectiveEntryAction: TaskContinuation['entryAction'];
  }): ContinuationClaim;
  retargetClaimToVerification(sourceTaskId: string, claimId: string, validatedIdentity: string): ContinuationClaim;
  releaseClaim(sourceTaskId: string, claimId: string): void;
  deleteClaim(sourceTaskId: string): void;
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
  /**
   * Persist a provider conversation as soon as the provider identifies it.
   *
   * A process can time out, exhaust its turn budget, or crash after opening a
   * resumable conversation but before returning its final result. Waiting for
   * the result would lose the only identifier that lets a retry continue it.
   */
  onSessionId?(sessionId: string): void;
}

export interface CodexSpecificationRequest {
  readonly projectPath: string;
  readonly taskTitle: string;
  readonly originalRequest: string;
  /** Immutable, validated project/convention evidence bound to this task. */
  readonly ruleEvidence?: string;
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
  /** The same immutable evidence used during specification and implementation. */
  readonly ruleEvidence?: string;
  readonly changes: GitChangeSet;
  readonly claudeReport: string;
  readonly testOutput: string;
  /**
   * Agent Relay's own successful verification of the exact review snapshot.
   * This is authoritative over historical verification prose in an agent report.
   */
  readonly relayVerification?: VerificationRecord;
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
  implement(request: ImplementationRequest, context: AgentRunContext): Promise<ImplementationResult>;
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
  reviewImplementation(request: CodexReviewRequest, context: AgentRunContext): Promise<CodexReviewOutcome>;
  run(
    request: ClaudeImplementationRequest,
    context: AgentRunContext
  ): Promise<ClaudeImplementationResult>;
  diagnose(): Promise<ToolDiagnostic>;
}

/** Provider-neutral execution result. Assessments describe observed commands, never report prose. */
export interface ImplementationRequest {
  readonly worktreePath: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly verificationCommands: readonly string[];
}

export interface ImplementationResult {
  readonly sessionId: string | null;
  readonly finalMessage: string;
  readonly assessment: ClaudeRoundAssessmentRecord;
}

export interface TaskRuleEvidenceRepository {
  findByTask(taskId: string): TaskRuleEvidenceBinding | null;
  create(binding: TaskRuleEvidenceBinding): TaskRuleEvidenceBinding;
}

/** `revision` is owned by the repository and never supplied by a caller. */
export type NewPlanReviewGate = Omit<PlanReviewGate, 'createdAt' | 'updatedAt' | 'revision'>;
export type PlanReviewGatePatch = Partial<
  Omit<
    PlanReviewGate,
    'id' | 'taskId' | 'specificationSha256' | 'ruleEvidenceSha256' | 'createdAt' | 'updatedAt' | 'revision'
  >
>;

export interface PlanReviewGateRepository {
  findByTask(taskId: string): PlanReviewGate | null;
  create(gate: NewPlanReviewGate): PlanReviewGate;
  update(id: string, patch: PlanReviewGatePatch): PlanReviewGate;
  /**
   * Apply a patch only if the row is still at `expectedRevision`.
   *
   * `null` means it was not: something wrote to this gate between the read that
   * justified the patch and this call, so the patch describes a state that no
   * longer exists and is discarded rather than applied. Every caller that
   * decided against a snapshot — anything that awaited an external answer —
   * must use this instead of {@link update}.
   */
  updateIfUnchanged(
    id: string,
    patch: PlanReviewGatePatch,
    expectedRevision: number
  ): PlanReviewGate | null;
}

/* -------------------------------------------------------------------------- */
/* External MCP                                                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Code review: immutable subject, durable rounds, findings and decisions      */
/* -------------------------------------------------------------------------- */

/** What the Git layer observed, before any hashing or policy is applied. */
export interface RawCodeSnapshotFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly change: CodeSnapshotChange;
  /** Absent for a deletion: there is no working-tree content to read. */
  readonly absolutePath: string | null;
}

/**
 * A cheap, total description of the worktree at one instant.
 *
 * Read before and after the file contents are digested. Hashing many files
 * takes time, and nothing stops the worktree changing during it — so a capture
 * that only listed and read would happily produce a hash of bytes that never
 * coexisted: edit A, edit B, restore A, and every individual read is honest
 * while their combination describes no filesystem state that ever existed.
 * Comparing this before and after is what turns that from an invisible lie
 * into a detected instability.
 */
export interface RawCodeSnapshotFingerprint {
  readonly headCommit: string;
  readonly branch: string;
  /** The porcelain status text, which moves whenever tracked content does. */
  readonly status: string;
  /** The change set as `path\0change` records, so an added file shows up. */
  readonly changeSet: string;
}

export interface RawCodeSnapshot {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly branch: string;
  readonly files: readonly RawCodeSnapshotFile[];
  /** True when the change set exceeded the caller's entry ceiling. */
  readonly truncated: boolean;
  /** True when the worktree holds tracked edits or untracked files. */
  readonly hasUncommittedState: boolean;
  /** Taken at the moment the file list was produced. */
  readonly fingerprint: RawCodeSnapshotFingerprint;
}

/** Which repository a checkout belongs to, and what it is sitting on. */
export interface RawCheckoutIdentity {
  /** The shared Git directory, resolved, so two spellings compare equal. */
  readonly commonDir: string;
  /** Null when HEAD is detached. */
  readonly branch: string | null;
  readonly detached: boolean;
}

export interface CodeSnapshotRequest {
  readonly worktreePath: string;
  readonly baseBranch: string;
  readonly maxFiles: number;
}

export interface CodeSnapshotLimits {
  /**
   * The only ceiling left.
   *
   * There is deliberately no per-file or total byte limit: files are streamed,
   * so size costs constant memory, and a size-based skip once gave two
   * different files of equal length the same identity. Exceeding this ceiling
   * does not silently drop files either — it marks the snapshot incomplete.
   */
  readonly maxFiles: number;
}

export type NewCodeReviewSubject = Omit<CodeReviewSubject, 'createdAt'>;
export type NewCodeReviewRound = Omit<
  CodeReviewRound,
  'createdAt' | 'updatedAt' | 'revision'
>;
export type CodeReviewRoundPatch = Partial<
  Omit<
    CodeReviewRound,
    'id' | 'taskId' | 'subjectId' | 'subjectSha256' | 'createdAt' | 'updatedAt' | 'revision'
  >
>;
export type NewCodeReviewFinding = Omit<
  CodeReviewFinding,
  'createdAt' | 'updatedAt' | 'revision' | 'timesReported'
>;
export type NewCodeReviewDecision = Omit<CodeReviewDecision, 'createdAt'>;
export type NewCodeReviewOccurrence = Omit<CodeReviewOccurrence, 'createdAt'>;

/** One finding as a round stated it, with the identity it should be filed under. */
export interface RoundFindingRecord {
  readonly finding: NewCodeReviewFinding;
  readonly occurrence: Omit<NewCodeReviewOccurrence, 'findingId'>;
}

export interface CompletedRoundResult {
  readonly round: CodeReviewRound;
  readonly findings: readonly CodeReviewFinding[];
  readonly created: number;
}

/**
 * Durable storage for the code-review lifecycle.
 *
 * Note what is absent: there is no `updateSubject`. A snapshot is the statement
 * of what was reviewed, and a statement that can be edited afterwards proves
 * nothing. New working state means a new subject row.
 */
export interface CodeReviewRepository {
  /**
   * Insert a subject, or return the existing row with the same content hash.
   *
   * Idempotent for an unchanged working state, so re-capturing costs nothing
   * and never produces a second identity for identical content.
   */
  createSubject(subject: NewCodeReviewSubject): CodeReviewSubject;
  findSubjectById(id: string): CodeReviewSubject | null;
  findSubjectByHash(taskId: string, subjectSha256: string): CodeReviewSubject | null;
  latestSubject(taskId: string): CodeReviewSubject | null;

  createRound(round: NewCodeReviewRound): CodeReviewRound;
  findRoundById(id: string): CodeReviewRound | null;
  latestRound(taskId: string): CodeReviewRound | null;
  listRounds(taskId: string): CodeReviewRound[];
  updateRound(id: string, patch: CodeReviewRoundPatch): CodeReviewRound;
  /** Apply only if the row is still at `expectedRevision`; `null` if it moved. */
  updateRoundIfUnchanged(
    id: string,
    patch: CodeReviewRoundPatch,
    expectedRevision: number
  ): CodeReviewRound | null;

  /**
   * Record a finding, linking to the existing row when the fingerprint repeats.
   *
   * Returns the stored row and whether this call created it, so a caller can
   * report honestly how much of a round was new.
   */
  upsertFinding(finding: NewCodeReviewFinding): { finding: CodeReviewFinding; created: boolean };
  /**
   * Complete a round and file all of its findings, or write nothing at all.
   *
   * One transaction, because the alternative is a `completed` round carrying
   * however many findings happened to be written before something threw — a row
   * that says a review finished while under-reporting what it found, which is
   * the most dangerous shape this table could take.
   */
  completeRoundWithFindings(
    roundId: string,
    patch: CodeReviewRoundPatch,
    records: readonly RoundFindingRecord[]
  ): CompletedRoundResult;
  listOccurrences(findingId: string): CodeReviewOccurrence[];
  listOccurrencesForRound(roundId: string): CodeReviewOccurrence[];
  findFindingById(id: string): CodeReviewFinding | null;
  listFindings(taskId: string): CodeReviewFinding[];
  listFindingsForSubject(taskId: string, subjectSha256: string): CodeReviewFinding[];

  /**
   * Append a decision, only if the finding is still at `expectedRevision`.
   *
   * `null` means it was not: something decided this finding between the read
   * that produced the caller's view and this write, so the caller's answer is
   * about a state that no longer exists.
   */
  appendDecisionIfUnchanged(
    decision: NewCodeReviewDecision,
    expectedRevision: number
  ): { decision: CodeReviewDecision; finding: CodeReviewFinding } | null;
  listDecisions(findingId: string): CodeReviewDecision[];
  latestDecision(findingId: string): CodeReviewDecision | null;
}

/**
 * Everything about one path that the subject hash is computed from.
 *
 * Deliberately the same tuple as `canonicalCodeSnapshot` writes — path, change,
 * digest, bytes. A manifest holding less than the identity holds cannot prove
 * the identity was stable: a file whose bytes never move can still change what
 * it IS between two passes, an untracked file becoming an added one being the
 * ordinary case, and that alone gives a different subject hash.
 */
export interface CodeSnapshotManifestEntry {
  readonly change: CodeSnapshotChange;
  readonly contentSha256: string | null;
  readonly bytes: number;
}

/**
 * One capture's content manifest: every path, and what the identity says of it.
 *
 * Compared against a second pass to decide whether the tree held still. The
 * cheap Git fingerprint cannot answer that on its own — an edit that leaves the
 * same added and removed line counts moves none of its fields — so it is kept
 * only as an early exit, never as the proof.
 */
export interface CodeSnapshotManifest {
  /** Every path this pass saw, mapped to its identity tuple. Sorted. */
  readonly entries: ReadonlyMap<string, CodeSnapshotManifestEntry>;
  readonly headCommit: string;
  readonly baseCommit: string;
  readonly branch: string;
  /**
   * Which checkout the bytes came out of.
   *
   * Compared pass to pass as well, so a worktree re-pointed at another
   * repository mid-capture is caught even in the case where the two happen to
   * agree on head, base and branch.
   */
  readonly checkout: RawCheckoutIdentity;
}

/** Captures the working state of a task branch WITHOUT changing it. */
export interface CodeSnapshotSource {
  /**
   * Which repository this checkout belongs to and what branch it is on.
   *
   * Read before any durable write, so a worktree pointing at another repository
   * or sitting on the wrong branch is refused before a round exists.
   */
  describeCheckout(worktreePath: string): Promise<RawCheckoutIdentity>;
  /**
   * Re-read the cheap description, to prove the worktree held still.
   *
   * Deliberately not a second full capture: it must be cheap enough to run
   * after every attempt without doubling the cost of the thing it is checking.
   */
  fingerprint(request: CodeSnapshotRequest): Promise<RawCodeSnapshotFingerprint>;
  /**
   * Read the branch's committed tip and its uncommitted changes.
   *
   * Read-only by contract: it must not stage, commit, stash, check out or
   * otherwise touch the index or the working tree. A review that altered what
   * it was reviewing would be measuring itself.
   */
  capture(request: CodeSnapshotRequest): Promise<RawCodeSnapshot>;
}

export interface ExternalCodeReviewSubject {
  /**
   * The TASK WORKTREE, not the project checkout.
   *
   * The snapshot is taken from the worktree and includes its uncommitted and
   * untracked state. Handing a reviewer the project root instead would point it
   * at a different working tree that happens to share a repository — so it
   * would review code the subject hash does not describe, and say `proceed`
   * about it.
   */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly headCommit: string;
  /** The exact snapshot hash this dispatch is for. */
  readonly subjectSha256: string;
}

/**
 * Whether a reviewer can be called at all, asked before anything is written.
 *
 * A separate, typed question rather than something inferred from whatever a
 * `reviewCode` call happens to throw. "The provider is not configured" and "the
 * call went out and its answer was lost" demand opposite responses — the first
 * leaves no external effect and must leave no durable trace either, the second
 * must never be retried automatically — and guessing between them from an
 * exception type is exactly the kind of inference that gets one of them wrong.
 */
/**
 * Whether a reviewer can be called at all, asked before anything is written.
 *
 * A separate, typed question rather than something inferred from whatever a
 * `reviewCode` call happens to throw. "The provider is not configured" and "the
 * call went out and its answer was lost" demand opposite responses — the first
 * leaves no external effect and must leave no durable trace either, the second
 * must never be retried automatically — and guessing between them from an
 * exception type is exactly the kind of inference that gets one of them wrong.
 *
 * ## What an implementation may and may not do here
 *
 * MAY: read local configuration, look up an executable, check an already-held
 * credential, ask a provider a read-only discovery question.
 *
 * MUST NOT: call `review_code` or any equivalent, consume a review round, or
 * cause any other non-idempotent effect. The service treats a refusal here as
 * PROOF that nothing external happened and writes no round; an implementation
 * that spent a round while answering would make that record false.
 */
export interface CodeReviewerAvailability {
  readonly available: boolean;
  /** Why not, when not. Bounded and safe: never a path, argv or secret. */
  readonly reason: string | null;
}

export interface ExternalCodeReviewRound {
  /**
   * The locator this answer belongs to, echoed back.
   *
   * Checked against the locator that was dispatched. Together with the subject
   * attestation it answers two different questions — WHICH round this is, and
   * WHAT it read — and a result that cannot answer both is not applied.
   */
  readonly locator: ExternalCodeRoundLocator;
  /**
   * The snapshot hash the reviewer attests it actually read.
   *
   * The service refuses a result that does not match the subject it dispatched.
   * `readsUncommittedWorktreeState` is a promise about a reviewer's general
   * behaviour; this is evidence about THIS answer, and only the second can
   * catch a reviewer that read the right worktree at the wrong moment, or a
   * result that arrived for a different round entirely. A reviewer that cannot
   * produce it returns null and its answers are never treated as confirmed.
   */
  readonly reviewedSubjectSha256: string | null;
  readonly verdict: string;
  readonly gatingCount: number;
  readonly threshold: number;
  readonly reviewers: string;
  readonly findings: readonly ProviderCodeFinding[];
  readonly instruction: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

/**
 * What a reviewer says about a round that was already dispatched.
 *
 * Read-only, and the only reviewer call recovery is allowed to make. It exists
 * because a lost answer leaves a round that nothing else can move: the call was
 * made, it may well have run, and repeating it would consume a second round.
 * The three shapes are kept apart because they license different actions —
 * `completed` may settle the round, `running` may not, and `unknown` is the
 * admission that nothing was learned at all.
 */
/**
 * Which round at the provider, as the provider itself names it.
 *
 * A subject hash cannot do this job. Several rounds legitimately share one
 * repository, branch, base, head and subject hash — that is the normal shape of
 * reviewing the same code twice — so asking a provider "what happened to the
 * round for this subject?" is a question with more than one right answer, and
 * writing whichever one comes back into whichever durable row is unresolved
 * attaches somebody else's verdict to this round.
 *
 * The locator is obtained BEFORE the non-idempotent dispatch and stored on the
 * round, so recovery can name exactly the round it lost rather than describing
 * it and hoping.
 */
export interface ExternalCodeRoundLocator {
  /**
   * Which provider this round lives at. Stable across restarts.
   *
   * Session and round ids are only unique inside one provider's namespace, so
   * without this a round dispatched to one provider could be reconciled against
   * another that happens to use the same id shape — and the configuration CAN
   * change between the dispatch and the recovery, which is exactly when a
   * durable round is waiting to be settled.
   */
  readonly providerId: string;
  /** The provider's session. Opaque to Agent Relay. */
  readonly sessionId: string;
  /** The round within that session. Opaque to Agent Relay. */
  readonly roundId: string;
}

export type ExternalCodeRoundStatus =
  | { readonly kind: 'completed'; readonly round: ExternalCodeReviewRound }
  | { readonly kind: 'running' }
  /**
   * The provider is certain this locator never ran a review.
   *
   * Distinct from `unknown`, and only ever returned when the provider can PROVE
   * it: it is the one answer that could safely release a round for another
   * attempt. `unknown` cannot, because "no record" and "a record I cannot read"
   * look identical from here.
   */
  | { readonly kind: 'not_started' }
  | { readonly kind: 'unknown'; readonly reason: string | null };

/**
 * The external code reviewer.
 *
 * Separate from {@link ExternalPlanReviewer} because the two gates answer
 * different questions and must be able to fail, be budgeted and be swapped
 * independently. `reviewCode` is NOT idempotent: it consumes a round.
 */
export interface ExternalCodeReviewer {
  /**
   * Does this reviewer read the worktree's uncommitted and untracked state?
   *
   * A reviewer that reads only committed refs cannot see a subject containing
   * uncommitted work, and would return a verdict about something else entirely.
   * Declaring the capability makes that a refusal instead of a wrong answer:
   * the service will not dispatch such a subject to a committed-only reviewer.
   * The default for anything that has not thought about it is `false`.
   */
  readonly readsUncommittedWorktreeState: boolean;
  /**
   * Can this reviewer run right now?
   *
   * Called BEFORE the durable round row exists. A refusal here is proof that
   * nothing external happened, so it must leave nothing behind to reconcile.
   */
  availability(signal?: AbortSignal): Promise<CodeReviewerAvailability>;
  /**
   * Read back a dispatched round WITHOUT starting or consuming one.
   *
   * Must be idempotent and must never call `review_code` or its equivalent.
   * An implementation that cannot answer returns `unknown` rather than
   * guessing, because "no answer" is not evidence that no review ran.
   */
  /**
   * This reviewer's stable identity, as it appears in every locator it hands out.
   *
   * Compared against the identity recorded on a durable round before recovery
   * asks anything: a round dispatched to one provider must never be settled by
   * whatever provider happens to be configured now.
   */
  readonly providerId: string;
  /**
   * Establish the durable identity this round will be known by, and return it.
   *
   * Called after the durable intent row exists and BEFORE `reviewCode`. It must
   * open or reserve a session/round at the provider and must NOT itself consume
   * a review round — otherwise a crash between this call and the write that
   * stores its answer would spend a round nothing can ever find again.
   */
  /**
   * @param clientToken
   * The durable id of the LOCAL round this reservation is for, used as the
   * provider's idempotency key. It must come from the round row that already
   * exists, so the same local round always reserves the same provider round and
   * a retry after a lost answer resumes instead of reserving a second one.
   *
   * Deliberately not the subject hash: several legitimate rounds review one
   * subject, so a token derived from it would collapse them into one. And not a
   * timestamp or anything the adapter invents, because neither survives the
   * restart the token exists for.
   */
  beginRound(
    subject: ExternalCodeReviewSubject,
    clientToken: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundLocator>;
  /**
   * Read back ONE named round without starting or consuming any.
   *
   * Must be idempotent, must never call `review_code` or its equivalent, and
   * must answer about the given locator only. An implementation that cannot
   * prove the answer belongs to that locator returns `unknown` rather than
   * guessing: "no answer" is not evidence that no review ran.
   */
  roundStatus(
    locator: ExternalCodeRoundLocator,
    subject: ExternalCodeReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus>;
  reviewCode(
    locator: ExternalCodeRoundLocator,
    subject: ExternalCodeReviewSubject,
    scopeText: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeReviewRound>;
}

export interface ExternalMcpToolAnnotations {
  readonly readOnly: boolean | null;
  readonly destructive: boolean | null;
  readonly idempotent: boolean | null;
  readonly openWorld: boolean | null;
}

export interface ExternalMcpTool {
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ExternalMcpToolAnnotations;
}

export interface ExternalMcpServerIdentity {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
}

export interface ExternalMcpDiscovery {
  readonly server: ExternalMcpServerIdentity;
  readonly tools: readonly ExternalMcpTool[];
}

export interface ExternalMcpCallResult {
  readonly server: ExternalMcpServerIdentity;
  readonly tool: ExternalMcpTool;
  readonly isError: boolean;
  /** Text blocks only, already redacted and bounded by the process boundary. */
  readonly content: readonly string[];
}

export interface ExternalMcpServerConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** The exact tool set this configuration accepts. Drift fails closed. */
  readonly allowedTools: readonly string[];
  readonly timeoutMs: number;
  readonly maxMessageBytes: number;
  readonly maxContentBytes: number;
  readonly maxContentBlocks: number;
}

export interface ExternalMcpClient {
  discover(config: ExternalMcpServerConfig, signal?: AbortSignal): Promise<ExternalMcpDiscovery>;
  call(
    config: ExternalMcpServerConfig,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<ExternalMcpCallResult>;
}

export interface ExternalPlanReviewSubject {
  readonly repositoryPath: string;
  readonly branch: string;
}

export interface ExternalPlanReviewSession {
  readonly sessionId: string;
  readonly stage: string;
  readonly awaitingResolve: boolean;
  readonly planProceeded: boolean;
  readonly serverName: string;
  readonly serverVersion: string;
}

export interface ExternalPlanReviewRound {
  readonly verdict: PlanReviewVerdict;
  readonly gatingCount: number;
  readonly threshold: number;
  readonly reviewers: string;
  readonly findings: readonly PlanReviewFinding[];
  readonly instruction: string;
  readonly serverName: string;
  readonly serverVersion: string;
}

export interface ExternalPlanReviewResolution {
  readonly stage: string;
  readonly awaitingResolve: boolean;
  readonly recordedDecisions: number;
  readonly instruction: string;
  readonly serverName: string;
  readonly serverVersion: string;
}

/**
 * What a read-only status probe can establish about an external session.
 *
 * Deliberately narrow. The provider's status surface reports which stage the
 * session is in and which rounds it has recorded, but it does NOT return the
 * findings of a completed round. Anything not listed here cannot be recovered
 * by reading, and must therefore leave a gate in its unknown phase rather than
 * being guessed at.
 */
export interface ExternalPlanReviewRoundCounts {
  /** Every PlanReview round the provider has recorded, in any state. */
  readonly total: number;
  /** Still executing. The provider is mid-round; nothing here may start another. */
  readonly running: number;
  /** Finished and recorded. Its findings are NOT readable through status. */
  readonly done: number;
  /** Started and never finished. Not a result, and never counted as one. */
  readonly interrupted: number;
}

export interface ExternalPlanReviewStatus {
  /** Required by the provider's contract; never invented when absent. */
  readonly sessionId: string;
  readonly stage: string;
  readonly awaitingResolve: boolean;
  readonly planProceeded: boolean;
  /**
   * The recorded plan rounds, split by the three states the provider reports.
   *
   * Kept apart rather than reduced to one number: "no round has run", "a round
   * is running", "a round finished" and "a round was interrupted" justify four
   * different durable transitions, and collapsing them loses exactly the
   * distinctions the recovery depends on.
   */
  readonly planRounds: ExternalPlanReviewRoundCounts;
  readonly serverName: string;
  readonly serverVersion: string;
}

export interface ExternalPlanReviewer {
  open(subject: ExternalPlanReviewSubject, signal?: AbortSignal): Promise<ExternalPlanReviewSession>;
  /**
   * Read the session back without changing it.
   *
   * The only reviewer method Agent Relay may call to recover from an unknown
   * outcome: it must be read-only, because `review_plan` and `resolve` are not
   * idempotent and may already have taken effect when their answer was lost.
   * A provider that can positively establish that no session exists reports
   * `AgentRelayError` with code `NOT_FOUND`; callers may only use that evidence
   * to re-arm an `opening` gate, before any plan round could have been sent.
   */
  status(
    subject: ExternalPlanReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewStatus>;
  reviewPlan(
    subject: ExternalPlanReviewSubject,
    planText: string,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewRound>;
  resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewResolution>;
}

/* -------------------------------------------------------------------------- */
/* Local inference                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A supervised local inference runtime.
 *
 * Note how little is here. There is no task, no review, no patch, no retry, no
 * approval, no publication and no repository — because the runtime owns none of
 * those, and a port that could express them would be an invitation to move
 * workflow state out of Agent Relay and into a process it does not control.
 *
 * The whole surface is: what state are you in, what can you do, start, prove
 * you are alive, answer one prompt, stop.
 *
 * `infer` never rejects for a runtime-side failure — it returns a discriminated
 * {@link LocalInferenceOutcome}, so a cancellation or a timeout cannot be handed
 * back in the same shape as a completion. It *does* throw
 * {@link InvalidTransitionError} for an operation that is not legal in the
 * current state, and that throw happens before any process or request.
 */
export interface LocalInferenceProvider {
  /** The current lifecycle state. Cheap, synchronous, and never a probe. */
  state(): LocalInferenceState;
  /**
   * Discovery plus a bounded `--version` probe.
   *
   * Read-only and idempotent. It never marks the provider healthy and never
   * sets `inferenceVerified`: a banner is evidence that a file exists, not that
   * a model loads.
   */
  capabilities(signal?: AbortSignal): Promise<LocalInferenceCapabilities>;
  /** Launch exactly one runtime and poll it to health. Never self-restarting. */
  start(signal?: AbortSignal): Promise<LocalInferenceState>;
  /** One bounded loopback health request. Legal only while healthy. */
  health(signal?: AbortSignal): Promise<LocalInferenceState>;
  /** Exactly one completion request. Never retried, never restarted. */
  infer(request: LocalInferenceRequest, signal?: AbortSignal): Promise<LocalInferenceOutcome>;
  /** Terminate the runtime tree. Safe and idempotent from every state. */
  stop(): Promise<LocalInferenceState>;
}

/**
 * The lifecycle surface exposed by LOCAL-B1, plus LOCAL-B3's one manual
 * smoke-test operation.
 *
 * `runTestInference` accepts only prompt text — never a request id, a message
 * array, a token override or template parameters. It builds exactly one
 * version-1 request from the saved configuration and delegates once to the
 * retained provider; the caller cannot widen or replace any configured bound.
 */
export interface LocalInferenceLifecycleService {
  capabilities(): Promise<LocalInferenceCapabilities>;
  start(): Promise<LocalInferenceState>;
  state(): LocalInferenceState;
  health(): Promise<LocalInferenceState>;
  stop(): Promise<LocalInferenceState>;
  runTestInference(prompt: string): Promise<LocalInferenceOutcome>;
}

/**
 * The application-wide right to run one Ornith turn sequence against the
 * retained local-inference provider.
 *
 * Not an IPC type: it never crosses the renderer boundary. Held for the
 * lifetime of one Ornith implementation/correction attempt and released on
 * every exit (success, failure, cancellation). `runtimeInstanceId`,
 * `providerId` and `modelId` are captured once, at acquisition, and every
 * later completion must be checked against them — see
 * {@link OrnithInferenceLeaseService.inferForOrnith}.
 */
export interface OrnithHealthyLease {
  readonly runtimeInstanceId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Idempotent. Safe to call more than once, and from a `finally` block. */
  release(): void;
  /**
   * Register a callback fired if the independently-callable
   * `localInference:stop` operation stops the retained runtime while this
   * lease is still held.
   *
   * This is how `localInference:stop` closes an active Ornith run rather
   * than leaving it to discover the runtime is gone only on its next turn:
   * the handler is expected to abort the owning task's own AbortSignal, which
   * unwinds the Ornith loop through its normal cancellation path (release the
   * lease, reconcile task state, record the run as cancelled). Not fired by
   * this lease's own `release()`.
   */
  onIndependentStop(handler: () => void): void;
}

/**
 * Internal-only surface LOCAL-A exposes to the Ornith implementation service.
 *
 * Deliberately separate from {@link LocalInferenceLifecycleService}: that
 * interface is what IPC handlers use on the renderer's behalf, and none of
 * this belongs there — there is no IPC channel for any of it. `start()` is
 * conspicuously absent from every method here: acquiring or using a lease
 * must never construct, launch or restart a runtime, only use one that is
 * already retained and already healthy.
 */
export interface OrnithInferenceLeaseService {
  /**
   * Acquire the one application-wide Ornith execution lease and perform one
   * bounded `health(signal)` check against the already-retained provider.
   *
   * @throws {AgentRelayError} with code `BUSY` when another Ornith run
   * already holds the lease, or `VALIDATION_FAILED` when no provider is
   * retained, the retained provider is not `healthy`, or the health check
   * does not confirm it. Never calls `start()`.
   */
  acquireOrnithLease(signal?: AbortSignal): Promise<OrnithHealthyLease>;
  /**
   * Re-confirm the lease is still valid: the same provider/model identity is
   * still configured and the retained provider is still healthy right now.
   * Used immediately before a worktree-preparing caller records the run.
   */
  recheckOrnithLease(lease: OrnithHealthyLease, signal?: AbortSignal): Promise<boolean>;
  /**
   * Exactly one `infer` call through the retained provider.
   *
   * Refuses (a `failed` outcome, `dispatchOutcome: 'not_dispatched'`) rather
   * than dispatching when the lease is no longer held, the provider is no
   * longer retained, or the configured provider/model identity no longer
   * matches the lease. Never retries and never calls `start()`.
   */
  inferForOrnith(
    lease: OrnithHealthyLease,
    request: LocalInferenceRequest,
    signal?: AbortSignal
  ): Promise<LocalInferenceOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Rule evidence                                                              */
/* -------------------------------------------------------------------------- */

export interface RuleSourceListing {
  readonly paths: readonly string[];
  readonly omitted: readonly { path: string; reason: RuleOmissionReason }[];
}

export type RuleSourceReadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly path: string; readonly reason: RuleOmissionReason };

export interface RuleSourceReader {
  /** Discover the fixed project-memory files and bounded rule directories. */
  discoverProject(rootPath: string, maxEntries: number): RuleSourceListing;
  /** Read exactly one source-relative file without following symlinks. */
  read(rootPath: string, relativePath: string, maxBytes: number): RuleSourceReadResult;
}

export interface RuleEvidenceSourceRequest {
  readonly id: string;
  readonly kind: RuleSourceKind;
  readonly rootPath: string;
  /** When set, a different HEAD fails closed. */
  readonly expectedRevision?: string;
  /** Required for external conventions; project worktrees may intentionally be dirty. */
  readonly requireClean: boolean;
  /** Required for conventions; project sources use fixed discovery instead. */
  readonly paths?: readonly string[];
}

export interface RuleEvidenceLimits {
  readonly maxSources: number;
  readonly maxFiles: number;
  readonly maxDiscoveryEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
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
