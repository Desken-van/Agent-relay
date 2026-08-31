/**
 * Row <-> model mapping.
 *
 * SQLite columns are snake_case, domain models are camelCase. Doing the
 * translation in one place (rather than aliasing in every query) keeps the SQL
 * readable and means a renamed field fails to compile instead of silently
 * returning `undefined`.
 */

import type { Approval, Project, Run, RunEvent, Task } from '../../shared/domain/models';
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
