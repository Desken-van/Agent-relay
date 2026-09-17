/**
 * Durable storage for the code-review lifecycle.
 *
 * Three invariants live here rather than in the service above, because a rule
 * enforced only by its caller is a rule until someone writes a second caller:
 *
 *  * a subject is insert-only — there is no update path at all;
 *  * every round and finding write bumps a monotonic revision, and the
 *    conditional variants put that revision in the WHERE clause;
 *  * decisions are append-only, so the trail keeps superseded answers.
 */

import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  CodeReviewDecision,
  CodeReviewFinding,
  CodeReviewOccurrence,
  CodeReviewRound,
  CodeReviewSubject
} from '../../../shared/domain/code-review';
import type {
  Clock,
  CodeReviewRepository,
  CodeReviewRoundPatch,
  CompletedRoundResult,
  NewCodeReviewDecision,
  NewCodeReviewFinding,
  NewCodeReviewRound,
  NewCodeReviewSubject,
  RoundFindingRecord
} from '../../ports';
import type { Db } from '../database';

const SUBJECT_COLUMNS = `id, task_id, base_commit, head_commit, branch, snapshot_json,
                         subject_sha256, file_count, total_bytes, truncated,
                         complete, has_uncommitted, captured_at, created_at`;

const OCCURRENCE_COLUMNS = `id, finding_id, round_id, subject_sha256, severity, category,
                            gating, title, body, fix, file, line, provider, role, created_at`;

const ROUND_COLUMNS = `id, task_id, subject_id, subject_sha256, status, verdict,
                       provider_id, session_id, provider_round_id, server_name, server_version,
                       contract_fingerprint, contract_mismatch_at,
                       reviewers,
                       gating_count, threshold, tokens_in, tokens_out, last_error,
                       revision, started_at, completed_at, created_at, updated_at`;

const FINDING_COLUMNS = `id, task_id, subject_sha256, fingerprint, severity, category,
                         gating, title, body, fix, file, line, provider, role,
                         first_round_id, last_round_id, times_reported, revision,
                         created_at, updated_at`;

const DECISION_COLUMNS = `id, finding_id, subject_sha256, action, reason, actor, source,
                          finding_revision, decided_at, created_at`;

interface SubjectRow {
  id: string;
  task_id: string;
  base_commit: string;
  head_commit: string;
  branch: string;
  snapshot_json: string;
  subject_sha256: string;
  file_count: number;
  total_bytes: number;
  truncated: number;
  complete: number;
  has_uncommitted: number;
  captured_at: string;
  created_at: string;
}

interface OccurrenceRow {
  id: string;
  finding_id: string;
  round_id: string;
  subject_sha256: string;
  severity: CodeReviewOccurrence['severity'];
  category: CodeReviewOccurrence['category'];
  gating: number;
  title: string;
  body: string;
  fix: string;
  file: string;
  line: number;
  provider: string;
  role: string;
  created_at: string;
}

interface RoundRow {
  id: string;
  task_id: string;
  subject_id: string;
  subject_sha256: string;
  status: CodeReviewRound['status'];
  verdict: CodeReviewRound['verdict'];
  provider_id: string | null;
  session_id: string | null;
  provider_round_id: string | null;
  server_name: string | null;
  server_version: string | null;
  contract_fingerprint: string | null;
  contract_mismatch_at: string | null;
  reviewers: string | null;
  gating_count: number | null;
  threshold: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  last_error: string | null;
  revision: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FindingRow {
  id: string;
  task_id: string;
  subject_sha256: string;
  fingerprint: string;
  severity: CodeReviewFinding['severity'];
  category: CodeReviewFinding['category'];
  gating: number;
  title: string;
  body: string;
  fix: string;
  file: string;
  line: number;
  provider: string;
  role: string;
  first_round_id: string;
  last_round_id: string;
  times_reported: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  finding_id: string;
  subject_sha256: string;
  action: CodeReviewDecision['action'];
  reason: string;
  actor: CodeReviewDecision['actor'];
  source: string;
  finding_revision: number;
  decided_at: string;
  created_at: string;
}

function toSubject(row: SubjectRow): CodeReviewSubject {
  return {
    id: row.id,
    taskId: row.task_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    branch: row.branch,
    snapshotJson: row.snapshot_json,
    subjectSha256: row.subject_sha256,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    truncated: row.truncated === 1,
    complete: row.complete === 1,
    hasUncommittedState: row.has_uncommitted === 1,
    capturedAt: row.captured_at,
    createdAt: row.created_at
  };
}

function toOccurrence(row: OccurrenceRow): CodeReviewOccurrence {
  return {
    id: row.id,
    findingId: row.finding_id,
    roundId: row.round_id,
    subjectSha256: row.subject_sha256,
    severity: row.severity,
    category: row.category,
    gating: row.gating === 1,
    title: row.title,
    body: row.body,
    fix: row.fix,
    file: row.file,
    line: row.line,
    provider: row.provider,
    role: row.role,
    createdAt: row.created_at
  };
}

function toRound(row: RoundRow): CodeReviewRound {
  return {
    id: row.id,
    taskId: row.task_id,
    subjectId: row.subject_id,
    subjectSha256: row.subject_sha256,
    status: row.status,
    verdict: row.verdict,
    providerId: row.provider_id,
    sessionId: row.session_id,
    providerRoundId: row.provider_round_id,
    serverName: row.server_name,
    serverVersion: row.server_version,
    contractFingerprint: row.contract_fingerprint,
    contractMismatchAt: row.contract_mismatch_at,
    reviewers: row.reviewers,
    gatingCount: row.gating_count,
    threshold: row.threshold,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    lastError: row.last_error,
    revision: row.revision,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toFinding(row: FindingRow): CodeReviewFinding {
  return {
    id: row.id,
    taskId: row.task_id,
    subjectSha256: row.subject_sha256,
    fingerprint: row.fingerprint,
    severity: row.severity,
    category: row.category,
    gating: row.gating === 1,
    title: row.title,
    body: row.body,
    fix: row.fix,
    file: row.file,
    line: row.line,
    provider: row.provider,
    role: row.role,
    firstRoundId: row.first_round_id,
    lastRoundId: row.last_round_id,
    timesReported: row.times_reported,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toDecision(row: DecisionRow): CodeReviewDecision {
  return {
    id: row.id,
    findingId: row.finding_id,
    subjectSha256: row.subject_sha256,
    action: row.action,
    reason: row.reason,
    actor: row.actor,
    source: row.source,
    findingRevision: row.finding_revision,
    decidedAt: row.decided_at,
    createdAt: row.created_at
  };
}

export class SqliteCodeReviewRepository implements CodeReviewRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  /* ---------------------------------------------------------------- subjects */

  createSubject(subject: NewCodeReviewSubject): CodeReviewSubject {
    // Re-capturing an unchanged working state must not mint a second identity
    // for identical content, and must not be an error either: the operator did
    // nothing wrong, and the answer to "what is under review" is unchanged.
    const existing = this.findSubjectByHash(subject.taskId, subject.subjectSha256);
    if (existing) return existing;

    const createdAt = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO code_review_subjects (
           id, task_id, base_commit, head_commit, branch, snapshot_json,
           subject_sha256, file_count, total_bytes, truncated, complete,
           has_uncommitted, captured_at, created_at)
         VALUES (
           @id, @taskId, @baseCommit, @headCommit, @branch, @snapshotJson,
           @subjectSha256, @fileCount, @totalBytes, @truncated, @complete,
           @hasUncommitted, @capturedAt, @createdAt)`
      )
      // Named explicitly rather than spread: SQLite has no boolean, and a
      // domain object carrying three of them cannot be bound as-is.
      .run({
        id: subject.id,
        taskId: subject.taskId,
        baseCommit: subject.baseCommit,
        headCommit: subject.headCommit,
        branch: subject.branch,
        snapshotJson: subject.snapshotJson,
        subjectSha256: subject.subjectSha256,
        fileCount: subject.fileCount,
        totalBytes: subject.totalBytes,
        truncated: subject.truncated ? 1 : 0,
        complete: subject.complete ? 1 : 0,
        hasUncommitted: subject.hasUncommittedState ? 1 : 0,
        capturedAt: subject.capturedAt,
        createdAt
      });
    return { ...subject, createdAt };
  }

  findSubjectById(id: string): CodeReviewSubject | null {
    const row = this.db
      .prepare(`SELECT ${SUBJECT_COLUMNS} FROM code_review_subjects WHERE id = ?`)
      .get(id) as SubjectRow | undefined;
    return row ? toSubject(row) : null;
  }

  findSubjectByHash(taskId: string, subjectSha256: string): CodeReviewSubject | null {
    const row = this.db
      .prepare(
        `SELECT ${SUBJECT_COLUMNS} FROM code_review_subjects
          WHERE task_id = ? AND subject_sha256 = ?`
      )
      .get(taskId, subjectSha256) as SubjectRow | undefined;
    return row ? toSubject(row) : null;
  }

  latestSubject(taskId: string): CodeReviewSubject | null {
    const row = this.db
      .prepare(
        `SELECT ${SUBJECT_COLUMNS} FROM code_review_subjects
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(taskId) as SubjectRow | undefined;
    return row ? toSubject(row) : null;
  }

  /* ------------------------------------------------------------------ rounds */

  createRound(round: NewCodeReviewRound): CodeReviewRound {
    const now = this.clock.nowIso();
    const next: CodeReviewRound = { ...round, revision: 0, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO code_review_rounds (
           id, task_id, subject_id, subject_sha256, status, verdict, provider_id,
           session_id, provider_round_id, server_name, server_version,
           contract_fingerprint, contract_mismatch_at, reviewers,
           gating_count, threshold, tokens_in, tokens_out, last_error, revision,
           started_at, completed_at, created_at, updated_at)
         VALUES (
           @id, @taskId, @subjectId, @subjectSha256, @status, @verdict, @providerId,
           @sessionId, @providerRoundId, @serverName, @serverVersion,
           @contractFingerprint, @contractMismatchAt, @reviewers,
           @gatingCount, @threshold, @tokensIn, @tokensOut, @lastError, @revision,
           @startedAt, @completedAt, @createdAt, @updatedAt)`
      )
      .run(next);
    return next;
  }

  findRoundById(id: string): CodeReviewRound | null {
    const row = this.db
      .prepare(`SELECT ${ROUND_COLUMNS} FROM code_review_rounds WHERE id = ?`)
      .get(id) as RoundRow | undefined;
    return row ? toRound(row) : null;
  }

  latestRound(taskId: string): CodeReviewRound | null {
    const row = this.db
      .prepare(
        `SELECT ${ROUND_COLUMNS} FROM code_review_rounds
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(taskId) as RoundRow | undefined;
    return row ? toRound(row) : null;
  }

  listRounds(taskId: string): CodeReviewRound[] {
    return (
      this.db
        .prepare(
          `SELECT ${ROUND_COLUMNS} FROM code_review_rounds
            WHERE task_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(taskId) as RoundRow[]
    ).map(toRound);
  }

  updateRound(id: string, patch: CodeReviewRoundPatch): CodeReviewRound {
    const applied = this.writeRound(id, patch, null);
    if (applied === null) {
      throw new AgentRelayError('INTERNAL', `Code review round ${id} changed during a write.`);
    }
    return applied;
  }

  updateRoundIfUnchanged(
    id: string,
    patch: CodeReviewRoundPatch,
    expectedRevision: number
  ): CodeReviewRound | null {
    return this.writeRound(id, patch, expectedRevision);
  }

  private writeRound(
    id: string,
    patch: CodeReviewRoundPatch,
    expectedRevision: number | null
  ): CodeReviewRound | null {
    const existing = this.db
      .prepare(`SELECT ${ROUND_COLUMNS} FROM code_review_rounds WHERE id = ?`)
      .get(id) as RoundRow | undefined;
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No code review round with id ${id}.`);
    }
    if (expectedRevision !== null && existing.revision !== expectedRevision) return null;

    const next: CodeReviewRound = {
      ...toRound(existing),
      ...patch,
      revision: existing.revision + 1,
      updatedAt: this.clock.nowIso()
    };
    const outcome = this.db
      .prepare(
        `UPDATE code_review_rounds SET
           status = @status,
           verdict = @verdict,
           provider_id = @providerId,
           session_id = @sessionId,
           provider_round_id = @providerRoundId,
           server_name = @serverName,
           server_version = @serverVersion,
           contract_fingerprint = @contractFingerprint,
           contract_mismatch_at = @contractMismatchAt,
           reviewers = @reviewers,
           gating_count = @gatingCount,
           threshold = @threshold,
           tokens_in = @tokensIn,
           tokens_out = @tokensOut,
           last_error = @lastError,
           revision = @revision,
           started_at = @startedAt,
           completed_at = @completedAt,
           updated_at = @updatedAt
         WHERE id = @id AND revision = @currentRevision`
      )
      .run({ ...next, currentRevision: existing.revision });
    return Number(outcome.changes) === 1 ? next : null;
  }

  /* ---------------------------------------------------------------- findings */

  upsertFinding(finding: NewCodeReviewFinding): {
    finding: CodeReviewFinding;
    created: boolean;
  } {
    const existing = this.db
      .prepare(
        `SELECT ${FINDING_COLUMNS} FROM code_review_findings
          WHERE task_id = ? AND subject_sha256 = ? AND fingerprint = ?`
      )
      .get(finding.taskId, finding.subjectSha256, finding.fingerprint) as FindingRow | undefined;

    const now = this.clock.nowIso();

    if (existing) {
      // The same defect, stated again by a later round against the same
      // subject. It keeps its id — and therefore every decision already
      // attached to it — and records that it was seen once more. Nothing about
      // the earlier statement is overwritten: the prose is identical by
      // definition, because identical prose is what made the fingerprint match.
      const next: CodeReviewFinding = {
        ...toFinding(existing),
        lastRoundId: finding.lastRoundId,
        timesReported: existing.times_reported + 1,
        revision: existing.revision + 1,
        updatedAt: now
      };
      this.db
        .prepare(
          `UPDATE code_review_findings SET
             last_round_id = @lastRoundId,
             times_reported = @timesReported,
             revision = @revision,
             updated_at = @updatedAt
           WHERE id = @id`
        )
        .run({
          id: next.id,
          lastRoundId: next.lastRoundId,
          timesReported: next.timesReported,
          revision: next.revision,
          updatedAt: next.updatedAt
        });
      return { finding: next, created: false };
    }

    const created: CodeReviewFinding = {
      ...finding,
      timesReported: 1,
      revision: 0,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO code_review_findings (
           id, task_id, subject_sha256, fingerprint, severity, category, gating,
           title, body, fix, file, line, provider, role, first_round_id,
           last_round_id, times_reported, revision, created_at, updated_at)
         VALUES (
           @id, @taskId, @subjectSha256, @fingerprint, @severity, @category, @gating,
           @title, @body, @fix, @file, @line, @provider, @role, @firstRoundId,
           @lastRoundId, @timesReported, @revision, @createdAt, @updatedAt)`
      )
      // SQLite has no boolean: the column is a checked 0/1 integer.
      .run({ ...created, gating: created.gating ? 1 : 0 });
    return { finding: created, created: true };
  }

  completeRoundWithFindings(
    roundId: string,
    patch: CodeReviewRoundPatch,
    records: readonly RoundFindingRecord[]
  ): CompletedRoundResult {
    let outcome: CompletedRoundResult | null = null;

    // All of it, or none of it. A `completed` round holding only the findings
    // that happened to be written before something threw would under-report a
    // review that actually finished — and nothing downstream could tell.
    const apply = this.db.transaction(() => {
      const round = this.updateRound(roundId, patch);
      const findings: CodeReviewFinding[] = [];
      let created = 0;

      for (const record of records) {
        const stored = this.upsertFinding(record.finding);
        if (stored.created) created += 1;
        findings.push(stored.finding);
        this.db
          .prepare(
            `INSERT INTO code_review_finding_occurrences (
               id, finding_id, round_id, subject_sha256, severity, category, gating,
               title, body, fix, file, line, provider, role, created_at)
             VALUES (
               @id, @findingId, @roundId, @subjectSha256, @severity, @category, @gating,
               @title, @body, @fix, @file, @line, @provider, @role, @createdAt)`
          )
          .run({
            ...record.occurrence,
            findingId: stored.finding.id,
            gating: record.occurrence.gating ? 1 : 0,
            createdAt: this.clock.nowIso()
          });
      }

      outcome = { round, findings, created };
    });
    apply();

    if (outcome === null) {
      throw new AgentRelayError('INTERNAL', 'The round completion transaction produced no result.');
    }
    return outcome;
  }

  listOccurrences(findingId: string): CodeReviewOccurrence[] {
    return (
      this.db
        .prepare(
          `SELECT ${OCCURRENCE_COLUMNS} FROM code_review_finding_occurrences
            WHERE finding_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(findingId) as OccurrenceRow[]
    ).map(toOccurrence);
  }

  listOccurrencesForRound(roundId: string): CodeReviewOccurrence[] {
    return (
      this.db
        .prepare(
          `SELECT ${OCCURRENCE_COLUMNS} FROM code_review_finding_occurrences
            WHERE round_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(roundId) as OccurrenceRow[]
    ).map(toOccurrence);
  }

  findFindingById(id: string): CodeReviewFinding | null {
    const row = this.db
      .prepare(`SELECT ${FINDING_COLUMNS} FROM code_review_findings WHERE id = ?`)
      .get(id) as FindingRow | undefined;
    return row ? toFinding(row) : null;
  }

  listFindings(taskId: string): CodeReviewFinding[] {
    return (
      this.db
        .prepare(
          `SELECT ${FINDING_COLUMNS} FROM code_review_findings
            WHERE task_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(taskId) as FindingRow[]
    ).map(toFinding);
  }

  listFindingsForSubject(taskId: string, subjectSha256: string): CodeReviewFinding[] {
    return (
      this.db
        .prepare(
          `SELECT ${FINDING_COLUMNS} FROM code_review_findings
            WHERE task_id = ? AND subject_sha256 = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(taskId, subjectSha256) as FindingRow[]
    ).map(toFinding);
  }

  /* --------------------------------------------------------------- decisions */

  appendDecisionIfUnchanged(
    decision: NewCodeReviewDecision,
    expectedRevision: number
  ): { decision: CodeReviewDecision; finding: CodeReviewFinding } | null {
    const existing = this.db
      .prepare(`SELECT ${FINDING_COLUMNS} FROM code_review_findings WHERE id = ?`)
      .get(decision.findingId) as FindingRow | undefined;
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No code review finding with id ${decision.findingId}.`);
    }
    if (existing.revision !== expectedRevision) return null;

    const now = this.clock.nowIso();
    const stored: CodeReviewDecision = { ...decision, createdAt: now };
    const bumped: CodeReviewFinding = {
      ...toFinding(existing),
      revision: existing.revision + 1,
      updatedAt: now
    };

    // One transaction: a decision that was written while its finding stayed at
    // the old revision would let the next caller believe nothing had happened.
    const apply = this.db.transaction(() => {
      const outcome = this.db
        .prepare(
          `UPDATE code_review_findings SET revision = @revision, updated_at = @updatedAt
            WHERE id = @id AND revision = @currentRevision`
        )
        .run({
          id: bumped.id,
          revision: bumped.revision,
          updatedAt: bumped.updatedAt,
          currentRevision: existing.revision
        });
      if (Number(outcome.changes) !== 1) {
        throw new AgentRelayError('INTERNAL', 'The finding moved during a decision write.');
      }
      this.db
        .prepare(
          `INSERT INTO code_review_decisions (
             id, finding_id, subject_sha256, action, reason, actor, source,
             finding_revision, decided_at, created_at)
           VALUES (
             @id, @findingId, @subjectSha256, @action, @reason, @actor, @source,
             @findingRevision, @decidedAt, @createdAt)`
        )
        .run(stored);
    });
    apply();

    return { decision: stored, finding: bumped };
  }

  listDecisions(findingId: string): CodeReviewDecision[] {
    return (
      this.db
        .prepare(
          `SELECT ${DECISION_COLUMNS} FROM code_review_decisions
            WHERE finding_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(findingId) as DecisionRow[]
    ).map(toDecision);
  }

  latestDecision(findingId: string): CodeReviewDecision | null {
    const row = this.db
      .prepare(
        `SELECT ${DECISION_COLUMNS} FROM code_review_decisions
          WHERE finding_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(findingId) as DecisionRow | undefined;
    return row ? toDecision(row) : null;
  }
}
