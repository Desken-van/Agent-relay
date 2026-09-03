/**
 * Row <-> model mapping.
 *
 * SQLite columns are snake_case, domain models are camelCase. Doing the
 * translation in one place (rather than aliasing in every query) keeps the SQL
 * readable and means a renamed field fails to compile instead of silently
 * returning `undefined`.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Approval, Project, Run, RunEvent, Task } from '../../shared/domain/models';
import {
  OPERATION_ENVIRONMENTS,
  parseTargetConfig,
  type OperationEnvironment,
  type OperationTarget
} from '../../shared/domain/operations';
import {
  DIAGNOSTIC_FAILURE_KINDS,
  DIAGNOSTIC_PROBE_IDS,
  DIAGNOSTIC_RUN_STATUSES,
  DIAGNOSTIC_RUN_VERSION,
  parseDiagnosticResult,
  type DiagnosticFailureKind,
  type DiagnosticProbeId,
  type DiagnosticRunStatus,
  type OperationDiagnosticRun
} from '../../shared/domain/operations-diagnostics';
import type { RunAgent, RunStatus, RunType } from '../../shared/domain/models';
import type { TaskStatus } from '../../shared/domain/workflow';

export interface ProjectRow {
  id: string;
  name: string;
  local_path: string;
  project_type: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  github_visibility: string;
  created_at: string;
  updated_at: string;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    localPath: row.local_path,
    projectType: row.project_type as Project['projectType'],
    defaultBranch: row.default_branch,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    githubVisibility: row.github_visibility as Project['githubVisibility'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  original_request: string;
  status: string;
  current_round: number;
  max_rounds: number;
  codex_thread_id: string | null;
  claude_session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  specification_json: string | null;
  specification_approved_at: string | null;
  last_review_json: string | null;
  last_error: string | null;
  codex_model: string | null;
  claude_model: string | null;
  created_at: string;
  updated_at: string;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    originalRequest: row.original_request,
    status: row.status as TaskStatus,
    currentRound: row.current_round,
    maxRounds: row.max_rounds,
    codexThreadId: row.codex_thread_id,
    claudeSessionId: row.claude_session_id,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    specificationJson: row.specification_json,
    specificationApprovedAt: row.specification_approved_at,
    lastReviewJson: row.last_review_json,
    lastError: row.last_error,
    codexModel: row.codex_model,
    claudeModel: row.claude_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface RunRow {
  id: string;
  task_id: string;
  agent: string;
  run_type: string;
  status: string;
  round: number;
  started_at: string;
  finished_at: string | null;
  final_message: string | null;
  structured_result: string | null;
  error_message: string | null;
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    agent: row.agent as RunAgent,
    runType: row.run_type as RunType,
    status: row.status as RunStatus,
    round: row.round,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    finalMessage: row.final_message,
    structuredResult: row.structured_result,
    errorMessage: row.error_message
  };
}

export interface RunEventRow {
  id: string;
  run_id: string;
  timestamp: string;
  type: string;
  payload: string;
}

export function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    timestamp: row.timestamp,
    type: row.type as RunEvent['type'],
    payload: row.payload
  };
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  action: string;
  status: string;
  details: string;
  requested_at: string;
  resolved_at: string | null;
}

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    action: row.action as Approval['action'],
    status: row.status as Approval['status'],
    details: row.details,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at
  };
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

/* Membership tests, so a stored string becomes a typed value only by proving
 * it belongs — never by being asserted into place. */

function isOperationEnvironment(value: string): value is OperationEnvironment {
  return (OPERATION_ENVIRONMENTS as readonly string[]).includes(value);
}

function isDiagnosticProbeId(value: string): value is DiagnosticProbeId {
  return (DIAGNOSTIC_PROBE_IDS as readonly string[]).includes(value);
}

function isDiagnosticRunStatus(value: string): value is DiagnosticRunStatus {
  return (DIAGNOSTIC_RUN_STATUSES as readonly string[]).includes(value);
}

function isDiagnosticFailureKind(value: string): value is DiagnosticFailureKind {
  return (DIAGNOSTIC_FAILURE_KINDS as readonly string[]).includes(value);
}

export interface OperationTargetRow {
  id: string;
  name: string;
  environment: string;
  adapter_type: string;
  config_version: number;
  config_json: string;
  credential_ref: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * A stored target, re-validated on the way out.
 *
 * Three checks, and all three refuse rather than coerce:
 *
 *  * `parseTargetConfig` rejects an unknown adapter type or config version, so
 *    a row written by a newer build throws here instead of being handed onward
 *    as a half-understood object;
 *  * the typed `config_version` column must agree with the version inside the
 *    JSON, and the typed `adapter_type` column with the adapter named inside
 *    it — two copies of the same fact that a partial write or a hand edit could
 *    otherwise leave disagreeing;
 *  * `environment` is checked against the enum rather than cast to it, because
 *    a cast is a claim the compiler cannot check and the data may not honour.
 */
export function toOperationTarget(row: OperationTargetRow): OperationTarget {
  const config = parseTargetConfig(row.config_json);

  if (row.config_version !== config.version) {
    throw new AgentRelayError(
      'PARSE_FAILED',
      'A stored target disagrees with itself about its configuration version.'
    );
  }
  if (row.adapter_type !== config.adapterType) {
    throw new AgentRelayError(
      'PARSE_FAILED',
      'A stored target disagrees with itself about its adapter type.'
    );
  }
  if (!isOperationEnvironment(row.environment)) {
    throw new AgentRelayError('PARSE_FAILED', 'A stored target names an unknown environment.');
  }

  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    adapterType: config.adapterType,
    config,
    credentialRef: row.credential_ref,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface OperationDiagnosticRunRow {
  id: string;
  target_id: string;
  probe_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  structured_result: string | null;
  failure_kind: string | null;
  error_message: string | null;
  version: number;
}

/**
 * A stored diagnostic run, re-validated on the way out.
 *
 * The row's own `version` must be exactly the one this build writes. Every
 * enum-valued column is checked rather than cast, for the same reason as the
 * target above: a cast asserts something about data that nothing verified.
 */
export function toOperationDiagnosticRun(row: OperationDiagnosticRunRow): OperationDiagnosticRun {
  if (row.version !== DIAGNOSTIC_RUN_VERSION) {
    throw new AgentRelayError(
      'PARSE_FAILED',
      'A stored diagnostic run was written in a shape this build cannot read.'
    );
  }
  if (!isDiagnosticProbeId(row.probe_id)) {
    throw new AgentRelayError('PARSE_FAILED', 'A stored diagnostic run names an unknown probe.');
  }
  if (!isDiagnosticRunStatus(row.status)) {
    throw new AgentRelayError('PARSE_FAILED', 'A stored diagnostic run has an unknown status.');
  }
  if (row.failure_kind !== null && !isDiagnosticFailureKind(row.failure_kind)) {
    throw new AgentRelayError(
      'PARSE_FAILED',
      'A stored diagnostic run has an unknown failure kind.'
    );
  }

  assertConsistentRun(row);

  // Parsed only after the row has been shown to be coherent, so a malformed
  // combination is never half-read before it is rejected.
  const result = row.structured_result === null ? null : parseDiagnosticResult(row.structured_result);

  if (result !== null) {
    if (result.targetId !== row.target_id) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        'A stored diagnostic result names a different target than the run holding it.'
      );
    }
    if (result.probeId !== row.probe_id) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        'A stored diagnostic result names a different probe than the run holding it.'
      );
    }
  }

  return {
    id: row.id,
    targetId: row.target_id,
    probeId: row.probe_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result,
    failureKind: row.failure_kind,
    errorMessage: row.error_message,
    version: row.version
  };
}

/**
 * The three shapes a stored run may take, restated on the way out.
 *
 * The table enforces the same thing, so a row failing this came from somewhere
 * a constraint does not reach: a restored file, a hand edit, a future schema
 * change. Returning a partially plausible object from one of those would be
 * worse than refusing — a failed run holding a leftover result reads as a
 * success to anyone who looked at the result and not the status.
 */
function assertConsistentRun(row: OperationDiagnosticRunRow): void {
  const refuse = (why: string): never => {
    throw new AgentRelayError('PARSE_FAILED', `A stored diagnostic run ${why}.`);
  };

  if (row.status === 'running') {
    if (row.finished_at !== null) refuse('is still running but has an end time');
    if (row.structured_result !== null) refuse('is still running but already has a result');
    if (row.failure_kind !== null) refuse('is still running but already has a failure kind');
    if (row.error_message !== null) refuse('is still running but already has an error message');
    return;
  }

  if (row.finished_at === null) refuse('has finished but has no end time');

  if (row.status === 'succeeded') {
    if (row.structured_result === null) refuse('succeeded but carries no result');
    if (row.failure_kind !== null) refuse('succeeded but carries a failure kind');
    if (row.error_message !== null) refuse('succeeded but carries an error message');
    return;
  }

  if (row.structured_result !== null) refuse('failed but carries a result');
  if (row.failure_kind === null) refuse('failed but does not say how');
  // Blank is the same silence as absent, and reads as a message to anyone
  // rendering the row.
  if (row.error_message === null || row.error_message.trim().length === 0) {
    refuse('failed but carries no usable message');
  }
}
