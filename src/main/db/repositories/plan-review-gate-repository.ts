import { AgentRelayError } from '../../../shared/domain/errors';
import type { PlanReviewGate } from '../../../shared/domain/plan-review';
import type {
  Clock,
  NewPlanReviewGate,
  PlanReviewGatePatch,
  PlanReviewGateRepository
} from '../../ports';
import type { Db } from '../database';

const COLUMNS = `id, task_id, specification_sha256, rule_evidence_sha256,
                 session_id, server_name, server_version, status, verdict,
                 findings_json, decisions_json, reviewers, gating_count, threshold,
                 last_error, created_at, updated_at`;

interface GateRow {
  id: string;
  task_id: string;
  specification_sha256: string;
  rule_evidence_sha256: string;
  session_id: string | null;
  server_name: string | null;
  server_version: string | null;
  status: PlanReviewGate['status'];
  verdict: PlanReviewGate['verdict'];
  findings_json: string | null;
  decisions_json: string | null;
  reviewers: string | null;
  gating_count: number | null;
  threshold: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toGate(row: GateRow): PlanReviewGate {
  return {
    id: row.id,
    taskId: row.task_id,
    specificationSha256: row.specification_sha256,
    ruleEvidenceSha256: row.rule_evidence_sha256,
    sessionId: row.session_id,
    serverName: row.server_name,
    serverVersion: row.server_version,
    status: row.status,
    verdict: row.verdict,
    findingsJson: row.findings_json,
    decisionsJson: row.decisions_json,
    reviewers: row.reviewers,
    gatingCount: row.gating_count,
    threshold: row.threshold,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SqlitePlanReviewGateRepository implements PlanReviewGateRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  findByTask(taskId: string): PlanReviewGate | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM plan_review_gates
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(taskId) as GateRow | undefined;
    return row ? toGate(row) : null;
  }

  create(gate: NewPlanReviewGate): PlanReviewGate {
    const now = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO plan_review_gates (
           id, task_id, specification_sha256, rule_evidence_sha256,
           session_id, server_name, server_version, status, verdict,
           findings_json, decisions_json, reviewers, gating_count, threshold,
           last_error, created_at, updated_at)
         VALUES (
           @id, @taskId, @specificationSha256, @ruleEvidenceSha256,
           @sessionId, @serverName, @serverVersion, @status, @verdict,
           @findingsJson, @decisionsJson, @reviewers, @gatingCount, @threshold,
           @lastError, @createdAt, @updatedAt)`
      )
      .run({ ...gate, createdAt: now, updatedAt: now });
    return { ...gate, createdAt: now, updatedAt: now };
  }

  update(id: string, patch: PlanReviewGatePatch): PlanReviewGate {
    const existing = this.db
      .prepare(`SELECT ${COLUMNS} FROM plan_review_gates WHERE id = ?`)
      .get(id) as GateRow | undefined;
    if (!existing) throw new AgentRelayError('NOT_FOUND', `No plan review gate with id ${id}.`);

    const next: PlanReviewGate = {
      ...toGate(existing),
      ...patch,
      updatedAt: this.clock.nowIso()
    };
    this.db
      .prepare(
        `UPDATE plan_review_gates SET
           session_id = @sessionId,
           server_name = @serverName,
           server_version = @serverVersion,
           status = @status,
           verdict = @verdict,
           findings_json = @findingsJson,
           decisions_json = @decisionsJson,
           reviewers = @reviewers,
           gating_count = @gatingCount,
           threshold = @threshold,
           last_error = @lastError,
           updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(next);
    return next;
  }
}
