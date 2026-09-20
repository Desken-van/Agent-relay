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
import { implementationProviderSchema, reviewProviderSchema } from './domain/execution-providers';
import type { CodexModelCatalogResult } from './domain/codex-catalog';
import type { CoaiConnectionDiagnostic } from './domain/coai-diagnostics';
import type { DiagnosticsReport } from './domain/diagnostics';
import type { SerializedError } from './domain/errors';
import type { PublishRefusalCode } from './domain/claude-assessment';
import type { GitChangeSet, ProjectValidation, RepositoryInfo, WorktreeInfo } from './domain/git';
import type { WorktreeDependencyStatus } from './domain/worktree-dependencies';
import { localInferencePromptSchema } from './domain/local-inference';
import type {
  LocalInferenceCapabilities,
  LocalInferenceOutcome,
  LocalInferenceState
} from './domain/local-inference';
import {
  APPROVAL_ACTIONS,
  GITHUB_VISIBILITIES,
  modelIdSchema,
  type Approval,
  type ContinuationEntryAction,
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
import type { CodexReviewResult, FindingTriageRecommendation, TaskSpecification } from './schemas/codex';
import {
  CODE_REVIEW_DECISION_ACTIONS,
  type CodeAutoDecideOutcome,
  type CodeCorrectionRequirement,
  type CodeReviewDecision,
  type CodeReviewFinding,
  type CodeReviewRound,
  type CodeReviewSubject,
  type CodeReviewSubjectIdentity,
  type CodeReviewTriage
} from './domain/code-review';
import {
  planReviewDecisionSchema,
  type PlanReviewAutoDecision,
  type PlanReviewFinding,
  type PlanReviewGate,
  type PlanReviewGateIdentity,
  type PlanReviewRecoveryReason
} from './domain/plan-review';
import type {
  PlanAdvanceOutcome,
  PlanAutoDecideOutcome,
  PlanCorrectionDetail
} from './domain/plan-correction';
import type {
  RuleEvidenceOmission,
  RuleEvidenceSource
} from './domain/rule-evidence';

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SerializedError };

/* -------------------------------------------------------------------------- */
/* Composite read models                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Enough of the linked task to navigate to it and show its state, without
 * recursively embedding a full {@link TaskDetail} on either side of the link.
 */
export interface TaskContinuationSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: Task['status'];
  readonly createdAt: string;
}

export interface TaskDetail {
  readonly task: Task;
  readonly project: Project;
  readonly runs: readonly Run[];
  readonly approvals: readonly Approval[];
  readonly specification: TaskSpecification | null;
  readonly lastReview: CodexReviewResult | null;
  readonly worktree: WorktreeInfo | null;
  /** Set when this task was itself created by "Continue in a new run". */
  readonly continuationOf: TaskContinuationSummary | null;
  /**
   * The persisted entry action this task was created with, when it is a
   * continuation. Drives the action projection's "Run verification" override
   * for a continuation whose inherited verification needs recomputing.
   */
  readonly continuationEntryAction: ContinuationEntryAction | null;
  /** Set once a continuation of this (necessarily FAILED) task exists. */
  readonly continuedAs: TaskContinuationSummary | null;
  /** Lets a source screen recover honestly when creation committed late or is still in flight. */
  readonly continuationCreationStatus: 'creating' | 'ready' | null;
  /** Backend-effective own-or-inherited implementation evidence; null means it permits publishing. */
  readonly effectivePublishRefusal: PublishRefusalCode | null;
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

/**
 * Everything the code-review screen will need, computed in the main process.
 *
 * `subjectIdentity` is server-computed for the same reason the plan gate's is:
 * deciding whether a stored review still speaks for the code on disk means
 * comparing two content hashes, and a renderer that recomputed them would be a
 * second implementation of the rule that decides — free to disagree with the
 * one that actually governs.
 */
export interface CodeReviewDetail {
  readonly subject: CodeReviewSubject | null;
  readonly subjectIdentity: CodeReviewSubjectIdentity;
  readonly rounds: readonly CodeReviewRound[];
  /**
   * Findings that are in force RIGHT NOW.
   *
   * Non-empty only when `subjectIdentity` is `current`. When the code has moved,
   * could not be read, or was only partially captured, this is empty and the
   * findings appear under `historicalFindings` instead — because a finding
   * about code the task no longer has, or code nobody could read, is not a
   * live statement about anything, and presenting it as one is how a stale
   * review comes to be acted on.
   */
  readonly findings: readonly CodeReviewFinding[];
  /**
   * Everything recorded for this task, in order, whatever its subject.
   *
   * Nothing is ever deleted; this is where it stays visible.
   */
  readonly historicalFindings: readonly CodeReviewFinding[];
  /**
   * The current decision for each finding that has one, keyed by finding id.
   *
   * Included now, in the phase that has no renderer, precisely so that INT-D-C
   * does not have to invent a second, incompatible way to ask. Without it a
   * client can see that findings exist but not what anybody decided about them,
   * which is the one thing an audit trail is for. Bounded by the number of
   * findings; the full per-finding history stays in the repository.
   */
  readonly latestDecisions: Readonly<Record<string, CodeReviewDecision>>;
  /** How many findings this task has recorded across every subject, ever. */
  readonly totalFindingsEverRecorded: number;
  /**
   * Why the working state could not be read, when it could not be.
   *
   * Set only for `unknown`. Bounded and redacted, so the reason reaches an
   * operator without a checkout path or a credential travelling with it.
   */
  readonly identityProblem: string | null;
  /**
   * The task's durable automatic-triage record, whatever subject it was
   * computed against — raw, exactly as stored. Present across a restart and
   * across every `codeReview:*` read, not only the one that requested it.
   *
   * Deliberately NOT pre-filtered to "still current" here, mirroring how
   * `PlanReviewGate.triageForFindings` is exposed raw and compared against
   * `findingsJson` by the reader: which of its recommendations still apply
   * is a per-finding comparison against `findings`/`subject` the caller
   * already has, computed once via `codeReviewCurrentTriageRecommendations`
   * rather than duplicated as a second, potentially disagreeing filter.
   */
  readonly triage: CodeReviewTriage | null;
  /**
   * Findings that were accepted and have not been shown to be fixed, across
   * every subject the task has had, oldest first. Accepting a finding says it is
   * valid; it never says the code changed, so nothing here disappears until a
   * `resolved` decision is recorded for it.
   */
  readonly correctionRequirements: readonly CodeCorrectionRequirement[];
  /**
   * Ids of the findings Auto decide is analyzing in the main process right now.
   * Read from the process, not from any screen, so a panel that was reloaded
   * mid-analysis still shows the truth and does not offer a second click.
   */
  readonly analyzing: readonly string[];
}

export interface PlanReviewDetail {
  readonly ruleEvidence: {
    readonly snapshotSha256: string;
    readonly boundAt: string;
    readonly sources: readonly RuleEvidenceSource[];
    readonly files: readonly {
      readonly sourceId: string;
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
    readonly omitted: readonly RuleEvidenceOmission[];
    readonly totalBytes: number;
  } | null;
  /**
   * Set when a binding row exists but its snapshot cannot be read back.
   *
   * Distinct from `ruleEvidence: null`, which means no task ever bound rules.
   * Collapsing the two made a corrupt binding look like an un-opted-in task and
   * invited a re-bind that could not succeed.
   */
  readonly ruleEvidenceProblem: string | null;
  readonly gate: PlanReviewGate | null;
  /**
   * Whether `gate` describes the task's CURRENT specification and rule binding.
   *
   * Computed in the main process, never in the renderer: a gate settled against
   * an earlier specification is still the task's latest gate, so nothing about
   * the row itself says it is stale, and the comparison that reveals it is the
   * same one the approval rule makes. Recomputing it on the other side of the
   * IPC boundary would be a second implementation of that rule, free to
   * disagree with the one that decides.
   *
   * `obsolete` and `unknown` are kept apart deliberately: one is proof that the
   * review belongs to an earlier specification, the other is the admission that
   * nothing could be compared. They call for different words on screen and
   * different actions.
   */
  readonly gateIdentity: PlanReviewGateIdentity;
  readonly findings: readonly PlanReviewFinding[];
  /**
   * SHA-256 of the current round's stored findings — the round's content
   * identity. Every per-finding request carries it, so an answer computed for
   * one round can never be merged into another.
   */
  readonly findingsSha256: string | null;
  /**
   * The decisions Auto decide already made for THIS round's findings, as stored.
   * Empty for any other round. The renderer shows them in the Decision fields
   * unless the operator has chosen something else, so a refresh or a restart
   * loses nothing Auto decide filled in.
   */
  readonly autoDecisions: readonly PlanReviewAutoDecision[];
  /** Indexes of the findings Auto decide is analyzing in the main process right now (see `CodeReviewDetail.analyzing`). */
  readonly analyzing: readonly number[];
  /** The plan-correction workflow: budget, next step, running phase, versions. */
  readonly correction: PlanCorrectionDetail;
  /**
   * Set when the latest review attempt cannot count and must be replaced under a fresh
   * review identity. Computed in the main process from the task's own gate rows — the same
   * function the correction loop and the approval rule use — so the screen never decides
   * for itself whether a review is trustworthy. While it is set, nothing about this gate
   * is evidence, whatever its status says, and the only action is the retry.
   */
  readonly recovery: PlanReviewRecoveryDetail | null;
}

/** Why a review cannot count, and the one safe thing to do about it. */
export interface PlanReviewRecoveryDetail {
  readonly reason: PlanReviewRecoveryReason;
  readonly message: string;
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

  'localInference:getCapabilities': empty,
  'localInference:start': empty,
  'localInference:getState': empty,
  'localInference:checkHealth': empty,
  'localInference:stop': empty,
  // Additive to the five lifecycle operations above. Strict on purpose: a
  // prompt and nothing else. No request id, no messages array, no token or
  // template override, no model/provider identity, no path, URL, host, port,
  // repository data or argv — every one of those is resolved from durable,
  // main-process-only state, exactly like the lifecycle channels above it.
  'localInference:runTestInference': z.object({ prompt: localInferencePromptSchema }).strict(),

  'diagnostics:run': z.object({ force: z.boolean().optional() }).strict(),

  /** Read-only Coai connection/capability probe. Never calls a tool. */
  'coai:checkConnection': empty,

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
      claudeModel: modelIdSchema.optional(),
      implementationProvider: implementationProviderSchema.optional(),
      reviewProvider: reviewProviderSchema.optional()
    })
    .strict(),

  'runs:listByTask': byTask,
  'runs:events': z
    .object({ runId: z.string().min(1), afterId: z.string().min(1).optional(), limit: z.number().int().min(1).max(5000).optional() })
    .strict(),

  // Read-only: the task id only. Resolves the project/worktree path from
  // durable task state inside the main process — never accepted from the
  // renderer.
  'dependencies:status': byTask,
  // Strict on purpose, same as `workflow:continue`: only the task id. The
  // worktree path, package manager, and executable/argv are all resolved
  // from durable state inside the main process.
  'workflow:installDependencies': byTask,

  'workflow:generateSpecification': byTask,
  'workflow:configureProviders': z.object({ taskId: z.string().min(1), expectedRevision: z.number().int().min(0),
    implementationProvider: implementationProviderSchema, reviewProvider: reviewProviderSchema }).strict(),
  'workflow:implement': z.object({ taskId: z.string().min(1), acceptDirtyWorkingTree: z.boolean().optional() }).strict(),
  'workflow:review': byTask,
  'workflow:verify': byTask,
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
  // Strict on purpose: the source task id and nothing else. A worktree,
  // branch, specification, provider, evidence, review result, command or
  // requested budget is never accepted from the renderer — every one of
  // those is resolved from the source task's own durable state, inside the
  // main process, by the continuation service.
  'workflow:continue': byTask,

  'planReview:get': byTask,
  'planReview:bindRules': byTask,
  'planReview:prepare': z
    .object({ taskId: z.string().min(1), acceptDirtyWorkingTree: z.boolean().optional() })
    .strict(),
  'planReview:review': byTask,
  'planReview:reconcile': byTask,
  // Replace a review that cannot count with a new attempt under a fresh review identity. It
  // replaces only: reviewing the replacement is the ordinary, separate "review" call. Takes no
  // round identity: it acts on the task's latest attempt, and refuses one whose call has an
  // unknown outcome (that is reconciled, never repeated).
  'planReview:retryFreshSession': byTask,

  // Code review (INT-D-A). Identifiers and typed decisions only.
  //
  // What these channels deliberately do NOT accept: an executable path, a
  // repository or worktree path, a base ref, a raw diff, a prompt or scope
  // text, or any provider configuration. All of those are read from durable
  // state in the main process. A renderer that could supply them would be
  // choosing what the external reviewer is asked and where it runs, which is
  // not a rendering decision — and `.strict()` makes the refusal explicit
  // rather than leaving an unknown field to be quietly ignored.
  'codeReview:get': byTask,
  'codeReview:capture': byTask,
  // The task, and nothing else. The main process resolves the project, the
  // worktree, the settings, the executable, the argv and the tool profile; a
  // renderer that could name any of those would be choosing what the external
  // reviewer is and where it runs. Single-flight stays with `CodeReviewClaims`,
  // so two windows pressing the button race in the service rather than here.
  'codeReview:review': byTask,
  // Read-only with respect to the external reviewer: it asks what became of a
  // round that was already dispatched and never starts one. Without it, a round
  // whose answer was lost stays unresolved forever and every later review for
  // that task is refused — safety taken to the point of uselessness.
  'codeReview:reconcile': byTask,
  'codeReview:decide': z
    .object({
      taskId: z.string().min(1),
      findingId: z.string().min(1),
      // The revision the caller was looking at, so a stale screen cannot
      // overwrite a newer answer with an older one.
      expectedRevision: z.number().int().nonnegative(),
      action: z.enum(CODE_REVIEW_DECISION_ACTIONS),
      reason: z.string().min(1).max(10_000)
    })
    .strict(),
  // Durable identifiers only. `findingIds`, if given, narrows analysis to
  // exactly those live findings; omitted means every currently undecided,
  // live finding for the task's current subject — computed in the main
  // process, never trusted from the renderer.
  'codeReview:triage': z
    .object({
      taskId: z.string().min(1),
      findingIds: z.array(z.string().min(1)).max(256).optional()
    })
    .strict(),
  // `gateId` and `expectedRevision` name the round the decisions answer. A
  // renderer that has been showing a round which has since been resolved and
  // replaced would otherwise submit its answers against the current one — the
  // finding indices line up whenever the two rounds are the same length, so
  // nothing else in this payload could tell them apart.
  'planReview:resolve': z
    .object({
      taskId: z.string().min(1),
      gateId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      decisions: z.array(planReviewDecisionSchema).max(256)
    })
    .strict(),
  // Durable identifiers only — never a prompt, path, or provider config. The
  // main process reconstructs the specification, rule evidence, findings and
  // prior decisions from repositories by `taskId` alone; `findingIndexes`, if
  // given, narrows which of the round's findings are analyzed (the durable
  // gate has no notion of "already decided" before `resolve` runs, so the
  // renderer's own undecided set is the only source for this).
  'planReview:triage': z
    .object({
      taskId: z.string().min(1),
      gateId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      findingIndexes: z.array(z.number().int().nonnegative()).max(256).optional()
    })
    .strict(),

  // Auto decide, ONE finding of ONE round. `findingsSha256` is the round's
  // content identity (see `PlanReviewDetail.findingsSha256`): together with
  // `gateId` it names exactly the findings the caller is looking at, so an
  // answer can never be applied to a different round. Nothing else is accepted —
  // no prompt, no recommendation, no decision text: the analysis and the reason
  // stored come from Codex triage in the main process.
  'planReview:autoDecide': z
    .object({
      taskId: z.string().min(1),
      gateId: z.string().min(1),
      findingsSha256: z.string().regex(/^[0-9a-f]{64}$/),
      findingIndex: z.number().int().nonnegative().max(255)
    })
    .strict(),
  // Resolve the round with these decisions and carry them through: when any is
  // an accept, Codex revises the specification and a fresh external review of
  // it starts. `autoContinue` keeps going while every finding of the next round
  // can be auto-decided. Same round identity as `planReview:resolve`.
  'planReview:resolveAndRevise': z
    .object({
      taskId: z.string().min(1),
      gateId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      decisions: z.array(planReviewDecisionSchema).max(256),
      autoContinue: z.boolean()
    })
    .strict(),
  // Resume the loop from durable state (a failed or interrupted correction, or
  // the review a completed correction is waiting for). Takes no round identity:
  // it derives what to do from what is recorded.
  'planReview:continueCorrection': z
    .object({ taskId: z.string().min(1), autoContinue: z.boolean() })
    .strict(),
  // Auto decide, ONE code-review finding, by its stable id. The decision, if
  // there is one, is recorded through the same durable path as an operator's.
  'codeReview:autoDecide': z
    .object({ taskId: z.string().min(1), findingId: z.string().min(1) })
    .strict(),

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

  'localInference:getCapabilities': LocalInferenceCapabilities;
  'localInference:start': LocalInferenceState;
  'localInference:getState': LocalInferenceState;
  'localInference:checkHealth': LocalInferenceState;
  'localInference:stop': LocalInferenceState;
  'localInference:runTestInference': LocalInferenceOutcome;

  'diagnostics:run': DiagnosticsReport;
  'coai:checkConnection': CoaiConnectionDiagnostic;

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

  'dependencies:status': WorktreeDependencyStatus;
  'workflow:installDependencies': Task;

  'workflow:generateSpecification': Task;
  'workflow:approveSpecification': Task;
  'workflow:sendToClaude': Task;
  'workflow:verify': Task;
  'workflow:configureProviders': Task;
  'workflow:implement': Task;
  'workflow:review': Task;
  'workflow:reviewWithCodex': Task;
  'workflow:sendCorrections': Task;
  'workflow:stop': Task;
  'workflow:approveForPublishing': Task;
  /**
   * The full continuation `TaskDetail`, so the renderer can select and
   * display it without an immediate second `tasks:get` round trip.
   */
  'workflow:continue': TaskDetail;

  'planReview:get': PlanReviewDetail;
  'planReview:bindRules': PlanReviewDetail;
  'planReview:prepare': PlanReviewDetail;
  'planReview:review': PlanReviewDetail;
  'planReview:reconcile': PlanReviewDetail;
  'planReview:retryFreshSession': PlanReviewDetail;
  'planReview:resolve': PlanReviewDetail;
  'planReview:triage': PlanReviewDetail;
  'planReview:autoDecide': { readonly detail: PlanReviewDetail; readonly outcome: PlanAutoDecideOutcome };
  'planReview:resolveAndRevise': { readonly detail: PlanReviewDetail; readonly outcome: PlanAdvanceOutcome };
  'planReview:continueCorrection': { readonly detail: PlanReviewDetail; readonly outcome: PlanAdvanceOutcome };
  'codeReview:autoDecide': { readonly outcome: CodeAutoDecideOutcome; readonly detail: CodeReviewDetail };
  'codeReview:get': CodeReviewDetail;
  'codeReview:capture': CodeReviewDetail;
  'codeReview:review': CodeReviewDetail;
  'codeReview:reconcile': CodeReviewDetail;
  'codeReview:decide': CodeReviewDetail;
  /**
   * Every call runs a fresh, independent Codex analysis (never reused or
   * cached), but its result IS persisted — see `CodeReviewRepository.
   * upsertTriage` and `CodeReviewDetail.triage`. `recommendations` here is
   * this exact call's answer, returned directly so a caller need not wait
   * for a second round trip; `detail` is included alongside it (rather than
   * folding `recommendations` into `detail` itself) because the two answer
   * different questions — this call's own fresh output, versus the durable
   * state a later, unrelated `codeReview:get` would read back.
   */
  'codeReview:triage': { readonly recommendations: readonly FindingTriageRecommendation[]; readonly detail: CodeReviewDetail };

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
