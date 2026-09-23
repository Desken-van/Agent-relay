/**
 * Migration 20 and the gate rows it changes.
 *
 * The migration is additive by construction — four nullable columns, no CHECK, no
 * rebuild — and this proves it against a database that really is at version 19 and
 * really holds the stuck pair of gates the defect left behind: every row reads back
 * as it was, the new columns are NULL, and the row can then be recovered through the
 * repository without anyone touching SQLite by hand.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { createSqliteDatabase, type SqliteDatabase } from '../../src/main/db/sqlite';
import { SqlitePlanReviewGateRepository } from '../../src/main/db/repositories/plan-review-gate-repository';
import { planReviewRecovery } from '../../src/shared/domain/plan-review';
import type { NewPlanReviewGate } from '../../src/main/ports';
import { FixedClock } from '../../src/main/infra/clock';

const NOW = '2026-09-20T00:00:00.000Z';
const SHA = (character: string): string => character.repeat(64);
const open: { close(): void }[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of open.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databaseAt(version: number): SqliteDatabase {
  const db = createSqliteDatabase(':memory:');
  open.push(db);
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= version)) {
    migration.up(db);
    record.run(migration.version, migration.name, NOW);
  }
  return db;
}

/**
 * A real file at version 19 holding the stuck pair, upgraded by the application's own open
 * path — which is exactly what happens to a user's database when this build first starts.
 */
function upgradedStuckDatabase(): Db {
  const directory = mkdtempSync(join(tmpdir(), 'agent-relay-plan-subjects-'));
  directories.push(directory);
  const file = join(directory, 'agent-relay.sqlite');
  const older = createSqliteDatabase(file);
  older.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const record = older.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 19)) {
    migration.up(older);
    record.run(migration.version, migration.name, NOW);
  }
  seedStuckPair(older);
  older.close();
  const upgraded = openDatabase({ file });
  open.push(upgraded);
  return upgraded;
}

function seedStuckPair(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO projects (id, name, local_path, project_type, default_branch, github_owner, github_repo, github_visibility, created_at, updated_at)
    VALUES ('p1', 'Demo', 'C:\\repo', 'existing', 'main', NULL, NULL, 'private', '${NOW}', '${NOW}');

    INSERT INTO tasks (id, project_id, title, original_request, status, current_round, max_rounds,
      codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch, specification_json,
      specification_approved_at, last_review_json, last_error, codex_model, claude_model,
      implementation_provider, review_provider, provider_revision, implementation_thread_id, created_at, updated_at)
    VALUES ('task-1', 'p1', 'Task one', 'Do the thing', 'READY_FOR_IMPLEMENTATION', 0, 3,
      NULL, NULL, NULL, 'agent-relay/task-1', 'main', '{"version":2}',
      NULL, NULL, NULL, NULL, NULL,
      'claude', 'codex', 0, NULL, '${NOW}', '${NOW}');

    INSERT INTO task_rule_evidence (task_id, snapshot_sha256, snapshot_json, bound_at)
    VALUES ('task-1', '${SHA('b')}', '{}', '${NOW}');

    INSERT INTO plan_review_gates (id, task_id, specification_sha256, rule_evidence_sha256, session_id, server_name,
      server_version, status, verdict, findings_json, decisions_json, reviewers, gating_count, threshold, last_error,
      reconciled_at, created_at, updated_at)
    VALUES ('gate-1', 'task-1', '${SHA('a')}', '${SHA('b')}', 'session-1', 'coai-mcp', '1.2.3', 'proceeded', 'revise',
      '[]', '[{"finding":0,"action":"accept","reason":"Yes."}]', 'all 2 reviewers answered', 1, 1, NULL,
      NULL, '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z');

    INSERT INTO plan_review_gates (id, task_id, specification_sha256, rule_evidence_sha256, session_id, server_name,
      server_version, status, verdict, findings_json, decisions_json, reviewers, gating_count, threshold, last_error,
      reconciled_at, created_at, updated_at)
    VALUES ('gate-2', 'task-1', '${SHA('c')}', '${SHA('b')}', 'session-1', 'coai-mcp', '1.2.3', 'reviewing', NULL,
      NULL, NULL, NULL, NULL, NULL,
      'Coai refused the request: the plan stage is over for this session (stage: CodeReview); open a new session for a new plan',
      NULL, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
  `);
}

describe('migration 20 (plan-review-isolated-subjects)', () => {
  it('follows migration 19 in its expected position, and is applied exactly once', () => {
    expect(MIGRATIONS[19]).toMatchObject({ version: 20, name: 'plan-review-isolated-subjects' });
    const db = databaseAt(19);
    // 20, 21 and 22 all remain to run from here — this only proves 20 itself runs, and only once.
    expect(runMigrations(db)).toBe(3);
    expect(runMigrations(db)).toBe(0);
  });

  it('only adds nullable columns: every existing row reads back as it was, with the four new ones NULL', () => {
    const db = databaseAt(19);
    seedStuckPair(db);
    const before = db.prepare('SELECT * FROM plan_review_gates ORDER BY id').all() as Record<string, unknown>[];

    expect(runMigrations(db)).toBe(3);

    const after = db.prepare('SELECT * FROM plan_review_gates ORDER BY id').all() as Record<string, unknown>[];
    expect(after).toHaveLength(2);
    for (const [index, row] of after.entries()) {
      const { review_subject, rounds_at_open, failure_kind, superseded_by, ...rest } = row;
      expect([review_subject, rounds_at_open, failure_kind, superseded_by]).toEqual([null, null, null, null]);
      // Untouched, byte for byte: no rebuild, no rewritten value.
      expect(rest).toEqual(before[index]);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('adds no constraint that an older row could violate, and leaves the status set alone', () => {
    const db = databaseAt(19);
    runMigrations(db);
    const table = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'plan_review_gates'").get() as { sql: string }).sql;

    // The status CHECK is exactly the one migration 5 wrote: no new status was needed.
    expect(table).toContain("'prepared','opening','reviewing','awaiting_resolve','resolving',");
    expect(table).toMatch(/review_subject\s+TEXT[,\s]/);
    expect(table).not.toMatch(/review_subject[^,]*CHECK/);
    expect(table).not.toMatch(/failure_kind[^,]*CHECK/);
  });

  it('lets the recovery run over the upgraded stuck rows through the repository, keeping the failed attempt untouched', () => {
    const db = upgradedStuckDatabase();
    const gates = new SqlitePlanReviewGateRepository(db, new FixedClock(new Date('2026-09-21T00:00:00.000Z')));

    // What the loop and the screen read: the stuck gate is recognised as unable to count.
    const stuck = gates.findByTask('task-1')!;
    expect(stuck.id).toBe('gate-2');
    expect(planReviewRecovery(stuck, gates.listByTask('task-1'))).toBe('foreign_session');
    expect(planReviewRecovery(gates.findById('gate-1'), gates.listByTask('task-1'))).toBeNull();

    const next: NewPlanReviewGate = {
      id: 'gate-3',
      taskId: 'task-1',
      specificationSha256: stuck.specificationSha256,
      ruleEvidenceSha256: stuck.ruleEvidenceSha256,
      sessionId: null,
      serverName: null,
      serverVersion: null,
      contractFingerprint: null,
      contractMismatchAt: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null,
      triageJson: null,
      triageForFindings: null,
      autoDecisionsJson: null,
      reviewSubject: 'e'.repeat(40),
      roundsAtOpen: null,
      failureKind: null,
      supersededBy: null
    };
    const created = gates.supersede('gate-2', next);

    expect(created.reviewSubject).toBe('e'.repeat(40));
    expect(gates.findByTask('task-1')!.id).toBe('gate-3');
    // The stuck attempt is exactly what it was, plus the pointer.
    expect(gates.findById('gate-2')).toMatchObject({
      status: 'reviewing',
      sessionId: 'session-1',
      supersededBy: 'gate-3',
      lastError: expect.stringContaining('the plan stage is over for this session')
    });
    // Nothing about the first gate changed.
    expect(gates.findById('gate-1')).toMatchObject({ status: 'proceeded', supersededBy: null });
  });
});

describe('the gate repository’s new columns', () => {
  function repository() {
    return new SqlitePlanReviewGateRepository(upgradedStuckDatabase(), new FixedClock(new Date('2026-09-21T00:00:00.000Z')));
  }

  it('round-trips a review subject, an opening baseline and a failure kind, and updates them', () => {
    const gates = repository();

    const updated = gates.update('gate-2', { reviewSubject: 'f'.repeat(40), roundsAtOpen: 2, failureKind: 'not_dispatched' });

    expect(updated).toMatchObject({ reviewSubject: 'f'.repeat(40), roundsAtOpen: 2, failureKind: 'not_dispatched' });
    expect(gates.findById('gate-2')).toMatchObject({ reviewSubject: 'f'.repeat(40), roundsAtOpen: 2, failureKind: 'not_dispatched' });
    // A later write to another column does not disturb them.
    expect(gates.update('gate-2', { lastError: 'x' })).toMatchObject({ reviewSubject: 'f'.repeat(40), roundsAtOpen: 2 });
  });

  it('replaces an attempt once and only once, and writes nothing when it refuses', () => {
    const gates = repository();
    const base = gates.findById('gate-2')!;
    const make = (id: string): NewPlanReviewGate => ({
      ...base,
      id,
      status: 'prepared',
      sessionId: null,
      lastError: null,
      supersededBy: null
    });

    gates.supersede('gate-2', make('gate-3'));

    expect(() => gates.supersede('gate-2', make('gate-4'))).toThrow(/already replaced/);
    expect(gates.findById('gate-4')).toBeNull();
    expect(() => gates.supersede('no-such-gate', make('gate-5'))).toThrow(/No plan review gate/);
    expect(gates.findById('gate-5')).toBeNull();
    // An insert that fails (a duplicate id) rolls the pointer back too: no half-replaced attempt.
    expect(() => gates.supersede('gate-3', make('gate-1'))).toThrow();
    expect(gates.findById('gate-3')!.supersededBy).toBeNull();
  });

  describe('withdrawing the approval that rested on the replaced attempt', () => {
    const approval = (repo: SqlitePlanReviewGateRepository) => {
      const row = (repo as unknown as { db: Db }).db
        .prepare('SELECT specification_approved_at AS approved FROM tasks WHERE id = ?')
        .get('task-1') as { approved: string | null };
      return row.approved;
    };
    const approve = (repo: SqlitePlanReviewGateRepository) =>
      (repo as unknown as { db: Db }).db
        .prepare("UPDATE tasks SET specification_approved_at = '2026-09-20T00:00:00.000Z' WHERE id = 'task-1'")
        .run();

    it('clears the approval in the same transaction as the replacement', () => {
      const gates = repository();
      approve(gates);
      const base = gates.findById('gate-2')!;

      gates.supersede('gate-2', { ...base, id: 'gate-3', status: 'prepared', sessionId: null, supersededBy: null }, { withdrawApproval: true });

      expect(approval(gates)).toBeNull();
      expect(gates.findByTask('task-1')!.id).toBe('gate-3');
    });

    it('leaves the approval alone unless asked, so a replacement that is not discarding evidence changes nothing else', () => {
      const gates = repository();
      approve(gates);
      const base = gates.findById('gate-2')!;

      gates.supersede('gate-2', { ...base, id: 'gate-3', status: 'prepared', sessionId: null, supersededBy: null });

      expect(approval(gates)).toBe('2026-09-20T00:00:00.000Z');
    });

    it('rolls the approval back with everything else when the replacement cannot be written', () => {
      const gates = repository();
      approve(gates);
      const base = gates.findById('gate-2')!;

      // A duplicate id fails the insert, after the approval would have been cleared in a non-atomic version.
      expect(() =>
        gates.supersede('gate-2', { ...base, id: 'gate-1', status: 'prepared', sessionId: null, supersededBy: null }, { withdrawApproval: true })
      ).toThrow();

      expect(approval(gates)).toBe('2026-09-20T00:00:00.000Z');
      expect(gates.findById('gate-2')!.supersededBy).toBeNull();
      expect(gates.findByTask('task-1')!.id).toBe('gate-2');
    });
  });

  it('bumps the replaced attempt’s revision, so a decision made against it earlier is discarded', () => {
    const gates = repository();
    const before = gates.findById('gate-2')!;
    gates.supersede('gate-2', { ...before, id: 'gate-3', status: 'prepared', sessionId: null, supersededBy: null });

    expect(gates.findById('gate-2')!.revision).toBe(before.revision + 1);
    expect(gates.updateIfUnchanged('gate-2', { lastError: 'late' }, before.revision)).toBeNull();
  });
});
