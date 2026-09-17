/**
 * The durable layer, exercised against real SQLite rather than a fake.
 *
 * The invariants under test are enforced by table constraints and by the SQL
 * itself — an insert-only subject, a revision in the WHERE clause, an
 * append-only decision trail. A stub repository would prove none of them, so
 * these run on a real database, and the migration test runs on a real file on
 * disk so the upgrade path is exercised the way an installation takes it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import { SqliteCodeReviewRepository } from '../../src/main/db/repositories/code-review-repository';
import { SqliteProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import type { NewCodeReviewFinding } from '../../src/main/ports';

const SUBJECT_A = 'a'.repeat(64);
const SUBJECT_B = 'b'.repeat(64);
const COMMIT_A = '1'.repeat(40);
const COMMIT_B = '2'.repeat(40);

let db: Db;
let clock: FixedClock;
let ids: SequentialIdGenerator;
let reviews: SqliteCodeReviewRepository;
let taskId: string;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  clock = new FixedClock();
  ids = new SequentialIdGenerator('c');
  reviews = new SqliteCodeReviewRepository(db, clock);

  const projects = new SqliteProjectRepository(db, clock);
  const tasks = new SqliteTaskRepository(db, clock);
  const project = projects.create({
    id: 'p1',
    name: 'demo',
    localPath: 'C:\\repo',
    projectType: 'existing',
    defaultBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    githubVisibility: 'private'
  });
  taskId = tasks.create({
    id: 't1',
    projectId: project.id,
    title: 'Add a health route',
    originalRequest: 'Add a health route.',
    status: 'READY_FOR_IMPLEMENTATION',
    currentRound: 0,
    maxRounds: 3,
    codexThreadId: null,
    claudeSessionId: null,
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    specificationJson: null,
    specificationApprovedAt: null,
    lastReviewJson: null,
    lastError: null,
    codexModel: null,
    claudeModel: null
  }).id;
});

afterEach(() => {
  closeDatabase(db);
});

function subject(subjectSha256 = SUBJECT_A, headCommit = COMMIT_B) {
  return reviews.createSubject({
    id: ids.next(),
    taskId,
    baseCommit: COMMIT_A,
    headCommit,
    branch: 'agent/task-1',
    snapshotJson: JSON.stringify(['snapshot', subjectSha256]),
    subjectSha256,
    fileCount: 2,
    totalBytes: 30,
    truncated: false,
    complete: true,
    hasUncommittedState: false,
    capturedAt: clock.nowIso()
  });
}

function round(subjectId: string, subjectSha256 = SUBJECT_A) {
  return reviews.createRound({
    id: ids.next(),
    taskId,
    subjectId,
    subjectSha256,
    status: 'requested',
    verdict: null,
    providerId: null,
    sessionId: null,
    providerRoundId: null,
    serverName: null,
    serverVersion: null,
    contractFingerprint: null,
    contractMismatchAt: null,
    reviewers: null,
    gatingCount: null,
    threshold: null,
    tokensIn: null,
    tokensOut: null,
    lastError: null,
    startedAt: clock.nowIso(),
    completedAt: null
  });
}

function finding(
  roundId: string,
  overrides: Partial<NewCodeReviewFinding> = {}
): NewCodeReviewFinding {
  return {
    id: ids.next(),
    taskId,
    subjectSha256: SUBJECT_A,
    fingerprint: 'f'.repeat(64),
    severity: 'major',
    category: 'reliability',
    gating: true,
    title: 'The retry is ambiguous',
    body: 'A lost response may repeat work.',
    fix: 'Persist the intent.',
    file: 'src/service.ts',
    line: 42,
    provider: 'codex',
    role: 'SecurityReliability',
    firstRoundId: roundId,
    lastRoundId: roundId,
    ...overrides
  };
}

describe('the durable code-review store', () => {
  it('cannot replace a subject once it is written', () => {
    const first = subject();

    // There is no update method at all — the port does not expose one — so the
    // only way to "change" a snapshot is to capture a different one, which is a
    // different row with a different identity. A statement about what was
    // reviewed that could be edited afterwards would prove nothing.
    expect(Object.keys(reviews)).not.toContain('updateSubject');
    expect('updateSubject' in reviews).toBe(false);

    const second = subject();
    expect(second.id).toBe(first.id);
    expect(second.snapshotJson).toBe(first.snapshotJson);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM code_review_subjects').get() as { n: number }).n
    ).toBe(1);
  });

  it('records a genuinely different working state as its own subject', () => {
    const first = subject(SUBJECT_A, COMMIT_B);
    const second = subject(SUBJECT_B, '3'.repeat(40));

    expect(second.id).not.toBe(first.id);
    expect(reviews.latestSubject(taskId)?.subjectSha256).toBe(SUBJECT_B);
    // The earlier subject is still readable: history is added to, never edited.
    expect(reviews.findSubjectByHash(taskId, SUBJECT_A)?.id).toBe(first.id);
  });

  it('refuses a round write against a revision that has moved', () => {
    const created = round(subject().id);
    const advanced = reviews.updateRound(created.id, { status: 'reviewing' });
    expect(advanced.revision).toBe(created.revision + 1);

    // The caller decided against revision 0; by now the row is at 1.
    expect(reviews.updateRoundIfUnchanged(created.id, { status: 'failed' }, created.revision))
      .toBeNull();
    expect(reviews.findRoundById(created.id)?.status).toBe('reviewing');

    expect(
      reviews.updateRoundIfUnchanged(created.id, { status: 'completed', verdict: 'proceed', completedAt: clock.nowIso() }, advanced.revision)
    ).not.toBeNull();
  });

  it('stores the provider locator durably, and keeps two rounds of one subject apart', () => {
    const one = subject();
    const first = round(one.id);
    const second = round(one.id);

    // Same task, same subject, same hash. In every respect a provider can be
    // asked about by describing the code, these two rounds are identical.
    expect(second.subjectSha256).toBe(first.subjectSha256);
    expect(first.providerRoundId).toBeNull();

    reviews.updateRound(first.id, {
      providerId: 'coai',
      sessionId: 'sess-a',
      providerRoundId: 'round-a'
    });
    reviews.updateRound(second.id, {
      providerId: 'coai',
      sessionId: 'sess-a',
      providerRoundId: 'round-b'
    });

    // Read back from storage, not from memory: this is what survives a restart,
    // and it is the only thing that can tell the two rounds apart afterwards.
    expect(reviews.findRoundById(first.id)?.providerRoundId).toBe('round-a');
    expect(reviews.findRoundById(second.id)?.providerRoundId).toBe('round-b');

    // And it can be cleared, because a round that never reached the provider
    // must not claim an identity it does not have.
    reviews.updateRound(second.id, {
      providerId: null,
      sessionId: null,
      providerRoundId: null
    });
    expect(reviews.findRoundById(second.id)?.providerRoundId).toBeNull();
    expect(reviews.findRoundById(first.id)?.providerRoundId).toBe('round-a');
  });

  it('round-trips the contract fingerprint and its mismatch marker independently, defaulting both to null', () => {
    const created = round(subject().id);
    expect(created.contractFingerprint).toBeNull();
    expect(created.contractMismatchAt).toBeNull();

    const fingerprint = 'f'.repeat(64);
    reviews.updateRound(created.id, { contractFingerprint: fingerprint, contractMismatchAt: null });
    expect(reviews.findRoundById(created.id)).toMatchObject({
      contractFingerprint: fingerprint,
      contractMismatchAt: null
    });

    // Marking a mismatch is a SEPARATE write from binding the fingerprint —
    // it must never be how the historical evidence gets overwritten.
    const mismatchAt = '2026-09-17T00:00:00.000Z';
    reviews.updateRound(created.id, { contractMismatchAt: mismatchAt });
    const stored = reviews.findRoundById(created.id);
    expect(stored?.contractFingerprint).toBe(fingerprint);
    expect(stored?.contractMismatchAt).toBe(mismatchAt);
  });

  it('links a repeated finding to the record it already has', () => {
    const first = round(subject().id);
    const second = round(reviews.latestSubject(taskId)!.id);

    const initial = reviews.upsertFinding(finding(first.id));
    expect(initial.created).toBe(true);

    // The same fingerprint from a later round against the same subject. It
    // keeps its id, and therefore keeps every decision already attached to it.
    const repeat = reviews.upsertFinding(
      finding(second.id, { id: ids.next(), firstRoundId: second.id, lastRoundId: second.id })
    );
    expect(repeat.created).toBe(false);
    expect(repeat.finding.id).toBe(initial.finding.id);
    expect(repeat.finding.firstRoundId).toBe(first.id);
    expect(repeat.finding.lastRoundId).toBe(second.id);
    expect(repeat.finding.timesReported).toBe(2);
    expect(reviews.listFindings(taskId)).toHaveLength(1);
  });

  it('keeps two different findings apart even when they arrive together', () => {
    const first = round(subject().id);
    reviews.upsertFinding(finding(first.id, { fingerprint: '1'.repeat(64) }));
    reviews.upsertFinding(finding(first.id, { id: ids.next(), fingerprint: '2'.repeat(64) }));

    expect(reviews.listFindings(taskId)).toHaveLength(2);
  });

  it('scopes a fingerprint to its subject, because the same words about other code differ', () => {
    const firstSubject = subject(SUBJECT_A);
    const secondSubject = subject(SUBJECT_B, '3'.repeat(40));
    const a = round(firstSubject.id, SUBJECT_A);
    const b = round(secondSubject.id, SUBJECT_B);

    reviews.upsertFinding(finding(a.id));
    reviews.upsertFinding(finding(b.id, { id: ids.next(), subjectSha256: SUBJECT_B }));

    expect(reviews.listFindings(taskId)).toHaveLength(2);
    expect(reviews.listFindingsForSubject(taskId, SUBJECT_A)).toHaveLength(1);
    expect(reviews.listFindingsForSubject(taskId, SUBJECT_B)).toHaveLength(1);
  });

  it('never drops a historical finding when a later round runs', () => {
    const firstSubject = subject(SUBJECT_A);
    const a = round(firstSubject.id, SUBJECT_A);
    reviews.upsertFinding(finding(a.id, { fingerprint: '1'.repeat(64) }));

    const secondSubject = subject(SUBJECT_B, '3'.repeat(40));
    const b = round(secondSubject.id, SUBJECT_B);
    reviews.upsertFinding(
      finding(b.id, { id: ids.next(), subjectSha256: SUBJECT_B, fingerprint: '2'.repeat(64) })
    );

    // The first round's finding is still there, still attached to the subject
    // it was about. A round is an addition to the record, not a replacement.
    expect(reviews.listFindings(taskId)).toHaveLength(2);
    expect(reviews.listFindingsForSubject(taskId, SUBJECT_A)).toHaveLength(1);
  });

  it('appends decisions and refuses one taken against a stale revision', () => {
    const created = round(subject().id);
    const stored = reviews.upsertFinding(finding(created.id)).finding;

    const first = reviews.appendDecisionIfUnchanged(
      {
        id: ids.next(),
        findingId: stored.id,
        subjectSha256: SUBJECT_A,
        action: 'accept',
        reason: 'Legitimate; will be addressed.',
        actor: 'operator',
        source: 'test',
        findingRevision: stored.revision,
        decidedAt: clock.nowIso()
      },
      stored.revision
    );
    expect(first).not.toBeNull();
    expect(first!.finding.revision).toBe(stored.revision + 1);

    // A second caller still holding the old revision must not overwrite it.
    const lost = reviews.appendDecisionIfUnchanged(
      {
        id: ids.next(),
        findingId: stored.id,
        subjectSha256: SUBJECT_A,
        action: 'reject',
        reason: 'Disagree, from a screen that had gone stale.',
        actor: 'operator',
        source: 'test',
        findingRevision: stored.revision,
        decidedAt: clock.nowIso()
      },
      stored.revision
    );
    expect(lost).toBeNull();
    expect(reviews.listDecisions(stored.id)).toHaveLength(1);
    expect(reviews.latestDecision(stored.id)?.action).toBe('accept');
  });

  it('keeps a superseded decision in the trail rather than overwriting it', () => {
    const created = round(subject().id);
    let stored = reviews.upsertFinding(finding(created.id)).finding;

    for (const [action, reason] of [
      ['accept', 'Legitimate; will be addressed.'],
      ['resolved', 'Fixed by the change under review.']
    ] as const) {
      const applied = reviews.appendDecisionIfUnchanged(
        {
          id: ids.next(),
          findingId: stored.id,
          subjectSha256: SUBJECT_A,
          action,
          reason,
          actor: 'operator',
          source: 'test',
          findingRevision: stored.revision,
          decidedAt: clock.nowIso()
        },
        stored.revision
      );
      expect(applied).not.toBeNull();
      stored = applied!.finding;
    }

    const trail = reviews.listDecisions(stored.id);
    expect(trail.map((entry) => entry.action)).toEqual(['accept', 'resolved']);
    expect(reviews.latestDecision(stored.id)?.action).toBe('resolved');
  });
});

/**
 * The constraints, attacked directly.
 *
 * These bypass the service and write to SQLite by hand, because that is the
 * only way to find out whether the DATABASE enforces the invariants or whether
 * a single careful caller has merely been keeping them by convention. A future
 * recovery path, a migration, or a second writer will not have that caller's
 * discipline.
 */
describe('code-review relational integrity', () => {
  function otherTask(): string {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const project = projects.create({
      id: 'p2',
      name: 'other',
      localPath: 'C:\\other-repo',
      projectType: 'existing',
      defaultBranch: 'main',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private'
    });
    return tasks.create({
      id: 't2',
      projectId: project.id,
      title: 'Another task',
      originalRequest: 'Another.',
      status: 'READY_FOR_IMPLEMENTATION',
      currentRound: 0,
      maxRounds: 3,
      codexThreadId: null,
      claudeSessionId: null,
      worktreePath: null,
      branchName: null,
      baseBranch: null,
      specificationJson: null,
      specificationApprovedAt: null,
      lastReviewJson: null,
      lastError: null,
      codexModel: null,
      claudeModel: null
    }).id;
  }

  it('has foreign keys switched on, or none of the rest of this means anything', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses a round that points at another task\'s subject', () => {
    const mine = subject();
    const theirs = otherTask();

    // The round claims to belong to task 2 while citing task 1's subject. The
    // composite key makes those one fact, so the database can tell.
    expect(() =>
      db
        .prepare(
          `INSERT INTO code_review_rounds (
             id, task_id, subject_id, subject_sha256, status, verdict, session_id,
             server_name, server_version, reviewers, gating_count, threshold,
             tokens_in, tokens_out, last_error, revision, started_at, completed_at,
             created_at, updated_at)
           VALUES ('r-cross', ?, ?, ?, 'requested', NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, 0, 't', NULL, 't', 't')`
        )
        .run(theirs, mine.id, mine.subjectSha256)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses a round whose hash disagrees with the subject it names', () => {
    const mine = subject();
    expect(() =>
      db
        .prepare(
          `INSERT INTO code_review_rounds (
             id, task_id, subject_id, subject_sha256, status, verdict, session_id,
             server_name, server_version, reviewers, gating_count, threshold,
             tokens_in, tokens_out, last_error, revision, started_at, completed_at,
             created_at, updated_at)
           VALUES ('r-hash', ?, ?, ?, 'requested', NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, 0, 't', NULL, 't', 't')`
        )
        .run(taskId, mine.id, SUBJECT_B)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses half a locator, however the halves are arranged', () => {
    const mine = subject();
    const insert = (provider: string | null, session: string | null, round_: string | null) =>
      db
        .prepare(
          `INSERT INTO code_review_rounds (
             id, task_id, subject_id, subject_sha256, status, verdict,
             provider_id, session_id, provider_round_id,
             server_name, server_version, reviewers, gating_count, threshold,
             tokens_in, tokens_out, last_error, revision, started_at, completed_at,
             created_at, updated_at)
           VALUES ('r-half', ?, ?, ?, 'requested', NULL, ?, ?, ?, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, 0, 't', NULL, 't', 't')`
        )
        .run(taskId, mine.id, mine.subjectSha256, provider, session, round_);

    // Every way of filling some but not all of it. A row like this looks
    // answerable and names nothing, so recovery would ask a question it cannot
    // check the answer of.
    expect(() => insert('coai', 'sess', null)).toThrow(/CHECK/i);
    expect(() => insert('coai', null, 'round')).toThrow(/CHECK/i);
    expect(() => insert(null, 'sess', 'round')).toThrow(/CHECK/i);
    expect(() => insert('coai', null, null)).toThrow(/CHECK/i);

    // And an empty part is not a part. Written out because a CHECK that
    // evaluates to NULL passes in SQLite, so this is exactly the case a
    // carelessly written constraint lets through.
    expect(() => insert('coai', '', 'round')).toThrow(/CHECK/i);
    expect(() => insert('', 'sess', 'round')).toThrow(/CHECK/i);
    expect(() => insert('coai', 'sess', '')).toThrow(/CHECK/i);

    // All three, or none, is what the column set is for.
    expect(() => insert(null, null, null)).not.toThrow();
  });

  it('refuses to let two rounds own one provider round', () => {
    const mine = subject();
    const first = round(mine.id);
    const second = round(mine.id);
    reviews.updateRound(first.id, {
      providerId: 'coai',
      sessionId: 'sess-a',
      providerRoundId: 'round-a'
    });

    // The same provider round claimed twice. Both rows would accept the same
    // recovered answer, which is the duplicate the locator exists to prevent.
    expect(() =>
      reviews.updateRound(second.id, {
        providerId: 'coai',
        sessionId: 'sess-a',
        providerRoundId: 'round-a'
      })
    ).toThrow(/UNIQUE/i);

    // The same session with a different round is a different round, and fine.
    expect(() =>
      reviews.updateRound(second.id, {
        providerId: 'coai',
        sessionId: 'sess-a',
        providerRoundId: 'round-b'
      })
    ).not.toThrow();

    // As is the same session and round at a different provider: the ids are
    // only unique inside one provider's namespace.
    const third = round(mine.id);
    expect(() =>
      reviews.updateRound(third.id, {
        providerId: 'other',
        sessionId: 'sess-a',
        providerRoundId: 'round-a'
      })
    ).not.toThrow();

    // Rounds with no locator do not collide with each other.
    const fourth = round(mine.id);
    const fifth = round(mine.id);
    expect(fourth.providerId).toBeNull();
    expect(fifth.providerId).toBeNull();
  });

  it('refuses a finding for a subject that does not exist', () => {
    const created = round(subject().id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO code_review_findings (
             id, task_id, subject_sha256, fingerprint, severity, category, gating,
             title, body, fix, file, line, provider, role, first_round_id,
             last_round_id, times_reported, revision, created_at, updated_at)
           VALUES ('f-ghost', ?, ?, ?, 'major', 'reliability', 1, 't', 'b', 'f',
                   'src/a.ts', 1, 'codex', 'r', ?, ?, 1, 0, 't', 't')`
        )
        .run(taskId, SUBJECT_B, 'a'.repeat(64), created.id, created.id)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses an occurrence joining a finding and a round of different subjects', () => {
    const first = subject(SUBJECT_A);
    const second = subject(SUBJECT_B, '3'.repeat(40));
    const roundA = round(first.id, SUBJECT_A);
    const roundB = round(second.id, SUBJECT_B);
    const findingA = reviews.upsertFinding(finding(roundA.id)).finding;

    // The occurrence would tie a finding about subject A to a round about
    // subject B — the exact shape that makes later evidence self-contradictory.
    expect(() =>
      db
        .prepare(
          `INSERT INTO code_review_finding_occurrences (
             id, finding_id, round_id, subject_sha256, severity, category, gating,
             title, body, fix, file, line, provider, role, created_at)
           VALUES ('o-cross', ?, ?, ?, 'major', 'reliability', 1, 't', 'b', 'f',
                   'src/a.ts', 1, 'codex', 'r', 't')`
        )
        .run(findingA.id, roundB.id, SUBJECT_A)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses a decision whose subject disagrees with its finding', () => {
    const created = round(subject().id);
    const stored = reviews.upsertFinding(finding(created.id)).finding;

    expect(() =>
      db
        .prepare(
          `INSERT INTO code_review_decisions (
             id, finding_id, subject_sha256, action, reason, actor, source,
             finding_revision, decided_at, created_at)
           VALUES ('d-cross', ?, ?, 'accept', 'because', 'operator', 'test', 0, 't', 't')`
        )
        .run(stored.id, SUBJECT_B)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('still accepts the rows the service actually writes', () => {
    // The constraints must bind the wrong shapes without obstructing the right
    // one, or they would have been bought at the cost of the feature.
    const created = round(subject().id);
    const stored = reviews.upsertFinding(finding(created.id));
    expect(stored.created).toBe(true);
    expect(
      reviews.appendDecisionIfUnchanged(
        {
          id: ids.next(),
          findingId: stored.finding.id,
          subjectSha256: SUBJECT_A,
          action: 'accept',
          reason: 'Legitimate.',
          actor: 'operator',
          source: 'test',
          findingRevision: stored.finding.revision,
          decidedAt: clock.nowIso()
        },
        stored.finding.revision
      )
    ).not.toBeNull();
  });
});

describe('the code-review migration', () => {
  it('keeps code review at version 7 in the forward-only migration sequence', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(MIGRATIONS[6]?.name).toBe('code-review-evidence');
    expect(MIGRATIONS[7]?.name).toBe('task-provider-routing');
    expect(MIGRATIONS[8]?.name).toBe('local-inference-settings');
    expect(MIGRATIONS[9]?.name).toBe('task-continuations');
    expect(MIGRATIONS[10]?.name).toBe('local-inference-request-defaults');
    expect(MIGRATIONS[11]?.name).toBe('ornith-provider');
    expect(MIGRATIONS[12]?.name).toBe('review-limit-status');
    expect(MIGRATIONS[13]?.name).toBe('review-blocked-status');
    expect(MIGRATIONS[14]?.name).toBe('ornith-provider-version-collision-repair');
    expect(MIGRATIONS[15]?.name).toBe('coai-contract-fingerprint');
    expect(MIGRATIONS[16]?.name).toBe('plan-review-triage');
  });

  it('upgrades a real database file that stops at version 6, keeping its rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-relay-code-review-'));
    const file = join(directory, 'agent-relay.sqlite');

    try {
      // An installation that predates this feature: everything up to 6 applied,
      // with a row already in it.
      const older = createSqliteDatabase(file);
      older.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
        migration.up(older);
        older
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
      }
      older
        .prepare(
          `INSERT INTO projects (id, name, local_path, project_type, default_branch,
                                 github_owner, github_repo, github_visibility, created_at, updated_at)
           VALUES ('p1','existing','C:\\\\repo','existing','main',NULL,NULL,'private','t','t')`
        )
        .run();
      older.close();

      const upgraded = openDatabase({ file });
      try {
        const applied = (
          upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
            version: number;
          }[]
        ).map((row) => row.version);
        expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

        // The pre-existing row survived the upgrade untouched.
        expect(upgraded.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toEqual({
          name: 'existing'
        });

        // And the new tables are usable straight away.
        const tables = (
          upgraded
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as { name: string }[]
        ).map((row) => row.name);
        for (const table of [
          'code_review_subjects',
          'code_review_rounds',
          'code_review_findings',
          'code_review_decisions'
        ]) {
          expect(tables).toContain(table);
        }

        // Migration 16's two new nullable columns landed on both tables that
        // carry Coai evidence, on a database that predates the feature by ten
        // versions — not only on one built fresh in memory.
        for (const table of ['code_review_rounds', 'plan_review_gates']) {
          const columns = (
            upgraded.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]
          ).filter((c) => c.name === 'contract_fingerprint' || c.name === 'contract_mismatch_at');
          expect(columns, table).toHaveLength(2);
          for (const column of columns) expect(column.notnull, `${table}.${column.name}`).toBe(0);
        }
      } finally {
        closeDatabase(upgraded);
      }

      // A second startup applies nothing: reconciliation on an already-migrated
      // database has to be a no-op, or every launch would rewrite the schema.
      const again = openDatabase({ file });
      try {
        expect(runMigrations(again)).toBe(0);
        expect(runMigrations(again)).toBe(0);
      } finally {
        closeDatabase(again);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
