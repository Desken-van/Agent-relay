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
                 session_id, server_name, server_version,
                 contract_fingerprint, contract_mismatch_at, status, verdict,
                 findings_json, decisions_json, reviewers, gating_count, threshold,
                 last_error, reconciled_at, revision, triage_json, triage_for_findings,
                 created_at, updated_at`;

interface GateRow {
  id: string;
  task_id: string;
  specification_sha256: string;
  rule_evidence_sha256: string;
  session_id: string | null;
  server_name: string | null;
  server_version: string | null;
  contract_fingerprint: string | null;
  contract_mismatch_at: string | null;
  status: PlanReviewGate['status'];
  verdict: PlanReviewGate['verdict'];
  findings_json: string | null;
  decisions_json: string | null;
  reviewers: string | null;
  gating_count: number | null;
  threshold: number | null;
  last_error: string | null;
  reconciled_at: string | null;
  revision: number;
  triage_json: string | null;
  triage_for_findings: string | null;
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
    contractFingerprint: row.contract_fingerprint,
    contractMismatchAt: row.contract_mismatch_at,
    status: row.status,
    verdict: row.verdict,
    findingsJson: row.findings_json,
    decisionsJson: row.decisions_json,
    reviewers: row.reviewers,
    gatingCount: row.gating_count,
    threshold: row.threshold,
    lastError: row.last_error,
    reconciledAt: row.reconciled_at,
    revision: row.revision,
    triageJson: row.triage_json,
    triageForFindings: row.triage_for_findings,
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
           session_id, server_name, server_version,
           contract_fingerprint, contract_mismatch_at, status, verdict,
           findings_json, decisions_json, reviewers, gating_count, threshold,
           last_error, reconciled_at, revision, triage_json, triage_for_findings,
           created_at, updated_at)
         VALUES (
           @id, @taskId, @specificationSha256, @ruleEvidenceSha256,
           @sessionId, @serverName, @serverVersion,
           @contractFingerprint, @contractMismatchAt, @status, @verdict,
           @findingsJson, @decisionsJson, @reviewers, @gatingCount, @threshold,
           @lastError, @reconciledAt, @revision, @triageJson, @triageForFindings,
           @createdAt, @updatedAt)`
      )
      .run({ ...gate, revision: 0, createdAt: now, updatedAt: now });
    return { ...gate, revision: 0, createdAt: now, updatedAt: now };
  }

  update(id: string, patch: PlanReviewGatePatch): PlanReviewGate {
    const applied = this.write(id, patch, null);
    // Unreachable through this path: an unconditional write compares against
    // the revision it has itself just read, and reads and writes here are
    // synchronous, so nothing can slip between the two.
    if (applied === null) {
      throw new AgentRelayError(
        'INTERNAL',
        `Plan review gate ${id} changed during an unconditional write.`
      );
    }
    return applied;
  }

  updateIfUnchanged(
    id: string,
    patch: PlanReviewGatePatch,
    expectedRevision: number
  ): PlanReviewGate | null {
    return this.write(id, patch, expectedRevision);
  }

  private write(
    id: string,
    patch: PlanReviewGatePatch,
    expectedRevision: number | null
  ): PlanReviewGate | null {
    const existing = this.db
      .prepare(`SELECT ${COLUMNS} FROM plan_review_gates WHERE id = ?`)
      .get(id) as GateRow | undefined;
    if (!existing) throw new AgentRelayError('NOT_FOUND', `No plan review gate with id ${id}.`);
    if (expectedRevision !== null && existing.revision !== expectedRevision) return null;

    const next: PlanReviewGate = {
      ...toGate(existing),
      ...patch,
      revision: existing.revision + 1,
      updatedAt: this.clock.nowIso()
    };
    // The revision is in the WHERE clause as well as the SET: the row is written
    // only if it is still the row that was read, whatever else reaches this
    // database. The guard is the condition, not the bump.
    const outcome = this.db
      .prepare(
        `UPDATE plan_review_gates SET
           session_id = @sessionId,
           server_name = @serverName,
           server_version = @serverVersion,
           contract_fingerprint = @contractFingerprint,
           contract_mismatch_at = @contractMismatchAt,
           status = @status,
           verdict = @verdict,
           findings_json = @findingsJson,
           decisions_json = @decisionsJson,
           reviewers = @reviewers,
           gating_count = @gatingCount,
           threshold = @threshold,
           last_error = @lastError,
           reconciled_at = @reconciledAt,
           revision = @revision,
           triage_json = @triageJson,
           triage_for_findings = @triageForFindings,
           updated_at = @updatedAt
         WHERE id = @id AND revision = @currentRevision`
      )
      .run({ ...next, currentRevision: existing.revision });
    return Number(outcome.changes) === 1 ? next : null;
  }
}
