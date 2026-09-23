import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import { SqliteApprovalRepository } from '../../src/main/db/repositories/approval-repository';
import { SqliteProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SqliteRunEventRepository } from '../../src/main/db/repositories/run-event-repository';
import { SqliteRunRepository } from '../../src/main/db/repositories/run-repository';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { defaultSettings } from '../../src/main/container';
import { FixedClock, SequentialIdGenerator } from '../../src/main/infra/clock';
import type { Settings } from '../../src/shared/domain/models';

let db: Db;
let clock: FixedClock;
let ids: SequentialIdGenerator;
let tempDir: string;

/** Built at runtime: a raw control byte in a source file makes it binary. */
const NUL = String.fromCharCode(0);

const DEFAULTS: Settings = defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-relay-db-'));
  db = openDatabase({ file: ':memory:' });
  clock = new FixedClock();
  ids = new SequentialIdGenerator('r');
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tempDir, { recursive: true, force: true });
});

function seedProject(repo: SqliteProjectRepository): string {
  const project = repo.create({
    id: ids.next(),
    name: 'Demo',
    localPath: `C:\\repo\\${ids.next()}`,
    projectType: 'existing',
    defaultBranch: 'main',
    githubOwner: 'Desken-van',
    githubRepo: 'demo',
    githubVisibility: 'private'
  });
  return project.id;
}

function seedTask(repo: SqliteTaskRepository, projectId: string): string {
  const task = repo.create({
    id: ids.next(),
    projectId,
    title: 'Task',
    originalRequest: 'Do the thing',
    codexModel: null,
    claudeModel: null,
    status: 'DRAFT',
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
    lastError: null
  });
  return task.id;
}

describe('migrations', () => {
  it('applies every migration exactly once', () => {
    const applied = runMigrations(db);
    expect(applied).toBe(0); // openDatabase already ran them

    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('reclassifies only proven review-limit stops and releases their worktree for continuation', () => {
    const legacy = createSqliteDatabase(':memory:');
    try {
      legacy.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      )`);
      // Migrations 12 and 22 are applied early, out of order relative to 13 (the one still pending and
      // actually under test here): 12 first because it rebuilds the `tasks` table (a fresh CREATE TABLE
      // that predates the two Ornith-profile columns) and would otherwise silently drop them again, then 22
      // for the columns themselves, so the CURRENT `SqliteTaskRepository` — which always writes them — can
      // create these historical fixture rows below. Neither's own effects matter to this test: no task
      // here uses 'ornith', so 12's new allowed value and 22's backfill are both no-ops. `runMigrations`
      // below still applies 13–21 in order and skips 12 and 22, already recorded.
      for (const migration of [
        ...MIGRATIONS.filter((entry) => entry.version < 12),
        ...MIGRATIONS.filter((entry) => entry.version === 12),
        ...MIGRATIONS.filter((entry) => entry.version === 22)
      ]) {
        migration.up(legacy);
        legacy.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, '2026-09-13T00:00:00.000Z');
      }

      const legacyClock = new FixedClock();
      const projects = new SqliteProjectRepository(legacy, legacyClock);
      const tasks = new SqliteTaskRepository(legacy, legacyClock);
      const runs = new SqliteRunRepository(legacy);
      const projectId = seedProject(projects);
      const review = { verdict: 'changes_requested', summary: 'More work', findings: [], followUpPrompt: 'Fix it' };
      const stopped = tasks.create({
        id: 'review-limit-source', projectId, title: 'Stopped review', originalRequest: 'Work',
        status: 'FAILED', currentRound: 3, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: 'C:\\worktrees\\shared', branchName: 'agent/review',
        baseBranch: 'main', specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: JSON.stringify(review), lastError: 'Review round limit reached (3/3).',
        codexModel: null, claudeModel: null
      });
      runs.create({ id: 'review-run', taskId: stopped.id, agent: 'codex', runType: 'review', status: 'running', round: 3, startedAt: legacyClock.nowIso() });
      runs.finish('review-run', { status: 'succeeded', finishedAt: legacyClock.nowIso(), structuredResult: JSON.stringify(review) });
      const genuineFailure = tasks.create({
        id: 'genuine-failure', projectId, title: 'Failed process', originalRequest: 'Work',
        status: 'FAILED', currentRound: 1, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: 'C:\\worktrees\\failed', branchName: 'agent/failed',
        baseBranch: 'main', specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: null, lastError: 'Process exited with code 1.', codexModel: null, claudeModel: null
      });

      // Migrations 13 (this test's review-limit subject) through 21 (local-inference-profiles) are
      // pending — 12 and 22 were already applied early, above.
      expect(runMigrations(legacy)).toBe(9);
      expect(tasks.findById(stopped.id)?.status).toBe('REVIEW_LIMIT_REACHED');
      expect(tasks.findById(genuineFailure.id)?.status).toBe('FAILED');
      expect(() => tasks.create({
        id: 'continuation-owner', projectId, title: 'Continuation', originalRequest: 'Work',
        status: 'CHANGES_REQUESTED', currentRound: 0, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: stopped.worktreePath, branchName: stopped.branchName,
        baseBranch: stopped.baseBranch, specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: JSON.stringify(review), lastError: null, codexModel: null, claudeModel: null
      })).not.toThrow();
    } finally {
      legacy.close();
    }
  });

  it('reclassifies only proven review-blocked stops, leaving stale or unrelated evidence untouched', () => {
    const legacy = createSqliteDatabase(':memory:');
    try {
      legacy.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      )`);
      // Migration 22 is applied early, out of its natural order, purely so the CURRENT
      // `SqliteTaskRepository` — which always writes its two Ornith-profile columns — can create these
      // historical fixture rows below. Its backfill step is a no-op here: no task exists yet, let alone an
      // Ornith one. `runMigrations` below still applies 13–21 in order and skips 22, already recorded.
      for (const migration of [
        ...MIGRATIONS.filter((entry) => entry.version < 13),
        ...MIGRATIONS.filter((entry) => entry.version === 22)
      ]) {
        migration.up(legacy);
        legacy.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, '2026-09-13T00:00:00.000Z');
      }

      const legacyClock = new FixedClock();
      const projects = new SqliteProjectRepository(legacy, legacyClock);
      const tasks = new SqliteTaskRepository(legacy, legacyClock);
      const runs = new SqliteRunRepository(legacy);
      const projectId = seedProject(projects);
      const blocked = { verdict: 'blocked', summary: 'Wrong approach.', findings: [], followUpPrompt: 'Rework it.' };

      const stopped = tasks.create({
        id: 'review-blocked-source', projectId, title: 'Blocked review', originalRequest: 'Work',
        status: 'FAILED', currentRound: 1, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: 'C:\\worktrees\\shared-blocked', branchName: 'agent/blocked',
        baseBranch: 'main', specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: JSON.stringify(blocked), lastError: 'Wrong approach.',
        codexModel: null, claudeModel: null
      });
      runs.create({ id: 'blocked-review-run', taskId: stopped.id, agent: 'codex', runType: 'review', status: 'running', round: 1, startedAt: legacyClock.nowIso() });
      runs.finish('blocked-review-run', { status: 'succeeded', finishedAt: legacyClock.nowIso(), structuredResult: JSON.stringify(blocked) });

      // Task JSON claims 'blocked', but the task's own succeeded review run
      // disagrees (stale/mismatched evidence) — must stay FAILED.
      const staleEvidence = tasks.create({
        id: 'stale-blocked-claim', projectId, title: 'Stale claim', originalRequest: 'Work',
        status: 'FAILED', currentRound: 1, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: 'C:\\worktrees\\stale-blocked', branchName: 'agent/stale-blocked',
        baseBranch: 'main', specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: JSON.stringify(blocked), lastError: 'Publish failed unexpectedly.',
        codexModel: null, claudeModel: null
      });
      runs.create({ id: 'stale-review-run', taskId: staleEvidence.id, agent: 'codex', runType: 'review', status: 'succeeded', round: 1, startedAt: legacyClock.nowIso() });
      runs.finish('stale-review-run', {
        status: 'succeeded', finishedAt: legacyClock.nowIso(),
        structuredResult: JSON.stringify({ ...blocked, verdict: 'changes_requested' })
      });

      const genuineFailure = tasks.create({
        id: 'genuine-failure-blocked', projectId, title: 'Failed process', originalRequest: 'Work',
        status: 'FAILED', currentRound: 1, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: 'C:\\worktrees\\failed-blocked', branchName: 'agent/failed-blocked',
        baseBranch: 'main', specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: null, lastError: 'Process exited with code 1.', codexModel: null, claudeModel: null
      });

      // Migrations 13 (review-limit-status) through 21 (local-inference-profiles) are still
      // pending — 22 was already applied early, above.
      expect(runMigrations(legacy)).toBe(9);
      expect(tasks.findById(stopped.id)?.status).toBe('REVIEW_BLOCKED');
      expect(tasks.findById(staleEvidence.id)?.status).toBe('FAILED');
      expect(tasks.findById(genuineFailure.id)?.status).toBe('FAILED');
      expect(() => tasks.create({
        id: 'continuation-owner-blocked', projectId, title: 'Continuation', originalRequest: 'Work',
        status: 'CHANGES_REQUESTED', currentRound: 0, maxRounds: 3, codexThreadId: null,
        claudeSessionId: null, worktreePath: stopped.worktreePath, branchName: stopped.branchName,
        baseBranch: stopped.baseBranch, specificationJson: null, specificationApprovedAt: null,
        lastReviewJson: JSON.stringify(blocked), lastError: null, codexModel: null, claudeModel: null
      })).not.toThrow();
    } finally {
      legacy.close();
    }
  });

  it('enables foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('cascades task deletion to runs, events and approvals', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const runs = new SqliteRunRepository(db);
    const runEvents = new SqliteRunEventRepository(db);
    const approvals = new SqliteApprovalRepository(db);

    const projectId = seedProject(projects);
    const taskId = seedTask(tasks, projectId);

    const run = runs.create({
      id: ids.next(),
      taskId,
      agent: 'codex',
      runType: 'specification',
      status: 'running',
      round: 0,
      startedAt: clock.nowIso()
    });
    runEvents.append({
      id: ids.next(),
      runId: run.id,
      type: 'log',
      payload: '{"text":"hi"}',
      timestamp: clock.nowIso()
    });
    approvals.create({
      id: ids.next(),
      taskId,
      action: 'commit',
      status: 'pending',
      details: '{}',
      requestedAt: clock.nowIso(),
      resolvedAt: null
    });

    projects.delete(projectId);

    expect(tasks.findById(taskId)).toBeNull();
    expect(runs.listByTask(taskId)).toHaveLength(0);
    expect(runEvents.listByRun(run.id)).toHaveLength(0);
    expect(approvals.listByTask(taskId)).toHaveLength(0);
  });
});

describe('project repository', () => {
  it('round-trips a project', () => {
    const repo = new SqliteProjectRepository(db, clock);
    const created = repo.create({
      id: 'p1',
      name: 'Demo',
      localPath: 'C:\\repo\\demo',
      projectType: 'existing',
      defaultBranch: 'main',
      githubOwner: 'Desken-van',
      githubRepo: 'demo',
      githubVisibility: 'private'
    });

    expect(repo.findById('p1')).toEqual(created);
    expect(repo.findByLocalPath('C:\\repo\\demo')?.id).toBe('p1');
    expect(repo.list()).toHaveLength(1);
  });

  it('rejects a duplicate local path with a useful message', () => {
    const repo = new SqliteProjectRepository(db, clock);
    const base = {
      name: 'Demo',
      localPath: 'C:\\repo\\demo',
      projectType: 'existing' as const,
      defaultBranch: 'main',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private' as const
    };
    repo.create({ id: 'p1', ...base });
    expect(() => repo.create({ id: 'p2', ...base })).toThrow(/already registered/i);
  });

  it('updates only the supplied fields and bumps updatedAt', () => {
    const repo = new SqliteProjectRepository(db, clock);
    const created = repo.create({
      id: 'p1',
      name: 'Demo',
      localPath: 'C:\\repo\\demo',
      projectType: 'existing',
      defaultBranch: 'main',
      githubOwner: null,
      githubRepo: null,
      githubVisibility: 'private'
    });

    clock.advance(60_000);
    const updated = repo.update('p1', { githubOwner: 'Desken-van' });

    expect(updated.githubOwner).toBe('Desken-van');
    expect(updated.name).toBe('Demo');
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it('throws when updating something that does not exist', () => {
    const repo = new SqliteProjectRepository(db, clock);
    expect(() => repo.update('nope', { name: 'x' })).toThrow(/No project/);
  });
});

describe('task repository', () => {
  it('persists session identifiers across reads', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const projectId = seedProject(projects);
    const taskId = seedTask(tasks, projectId);

    tasks.update(taskId, {
      codexThreadId: 'thread-abc',
      claudeSessionId: 'session-xyz',
      worktreePath: 'C:\\wt\\task',
      branchName: 'agent-relay/task',
      baseBranch: 'main',
      status: 'READY_FOR_REVIEW',
      currentRound: 2
    });

    const reloaded = new SqliteTaskRepository(db, clock).findById(taskId);
    expect(reloaded?.codexThreadId).toBe('thread-abc');
    expect(reloaded?.claudeSessionId).toBe('session-xyz');
    expect(reloaded?.status).toBe('READY_FOR_REVIEW');
    expect(reloaded?.currentRound).toBe(2);
  });

  it('lists only live tasks when reporting worktree ownership', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const projectId = seedProject(projects);

    const live = seedTask(tasks, projectId);
    const finished = seedTask(tasks, projectId);

    tasks.update(live, { worktreePath: 'C:\\wt\\live', status: 'IMPLEMENTING' });
    tasks.update(finished, { worktreePath: 'C:\\wt\\done', status: 'COMPLETED' });

    const active = tasks.listActiveWorktreePaths();
    expect(active).toHaveLength(1);
    expect(active[0]?.worktreePath).toBe('C:\\wt\\live');
  });

  it('orders tasks newest-first within a project', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const projectId = seedProject(projects);

    const first = seedTask(tasks, projectId);
    clock.advance(1000);
    const second = seedTask(tasks, projectId);

    expect(tasks.listByProject(projectId).map((t) => t.id)).toEqual([second, first]);
  });
});

describe('run and run-event repositories', () => {
  it('appends events in insertion order and supports incremental reads', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const runs = new SqliteRunRepository(db);
    const runEvents = new SqliteRunEventRepository(db);

    const taskId = seedTask(tasks, seedProject(projects));
    const run = runs.create({
      id: 'run-1',
      taskId,
      agent: 'claude',
      runType: 'implementation',
      status: 'running',
      round: 1,
      startedAt: clock.nowIso()
    });

    // All within the same millisecond — ordering must not rely on timestamps.
    const created = ['a', 'b', 'c', 'd'].map((letter) =>
      runEvents.append({
        id: `e-${letter}`,
        runId: run.id,
        type: 'log',
        payload: JSON.stringify({ text: letter }),
        timestamp: clock.nowIso()
      })
    );

    expect(runEvents.listByRun(run.id).map((e) => e.id)).toEqual(created.map((e) => e.id));
    expect(runEvents.listByRun(run.id, { afterId: 'e-b' }).map((e) => e.id)).toEqual(['e-c', 'e-d']);
    expect(runEvents.listByRun(run.id, { limit: 2 })).toHaveLength(2);
  });

  it('reports the stored payload size for the log budget', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const runs = new SqliteRunRepository(db);
    const runEvents = new SqliteRunEventRepository(db);

    const taskId = seedTask(tasks, seedProject(projects));
    runs.create({
      id: 'run-1',
      taskId,
      agent: 'claude',
      runType: 'implementation',
      status: 'running',
      round: 1,
      startedAt: clock.nowIso()
    });

    expect(runEvents.storedBytes('run-1')).toBe(0);
    const payload = JSON.stringify({ text: 'x'.repeat(100) });
    runEvents.append({ id: 'e1', runId: 'run-1', type: 'log', payload, timestamp: clock.nowIso() });
    expect(runEvents.storedBytes('run-1')).toBe(payload.length);
  });

  it('closes out a run and finds the latest by type', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const runs = new SqliteRunRepository(db);
    const taskId = seedTask(tasks, seedProject(projects));

    runs.create({
      id: 'run-1',
      taskId,
      agent: 'claude',
      runType: 'implementation',
      status: 'running',
      round: 1,
      startedAt: clock.nowIso()
    });
    clock.advance(1000);
    runs.create({
      id: 'run-2',
      taskId,
      agent: 'claude',
      runType: 'implementation',
      status: 'running',
      round: 2,
      startedAt: clock.nowIso()
    });

    const finished = runs.finish('run-2', {
      status: 'succeeded',
      finishedAt: clock.nowIso(),
      finalMessage: 'done',
      structuredResult: '{"a":1}'
    });

    expect(finished.status).toBe('succeeded');
    expect(finished.finalMessage).toBe('done');
    expect(runs.findLatestByType(taskId, 'implementation')?.id).toBe('run-2');
    expect(runs.findLatestByType(taskId, 'review')).toBeNull();
  });
});

describe('approval repository', () => {
  it('resolves exactly once', () => {
    const projects = new SqliteProjectRepository(db, clock);
    const tasks = new SqliteTaskRepository(db, clock);
    const approvals = new SqliteApprovalRepository(db);
    const taskId = seedTask(tasks, seedProject(projects));

    approvals.create({
      id: 'a1',
      taskId,
      action: 'push',
      status: 'pending',
      details: '{}',
      requestedAt: clock.nowIso(),
      resolvedAt: null
    });

    expect(approvals.findGranted(taskId, 'push')).toBeNull();

    const granted = approvals.resolve('a1', 'granted', clock.nowIso());
    expect(granted.status).toBe('granted');
    expect(approvals.findGranted(taskId, 'push')?.id).toBe('a1');

    expect(() => approvals.resolve('a1', 'denied', clock.nowIso())).toThrow(/already been resolved/i);
  });
});

describe('settings repository', () => {
  it('returns defaults when nothing is stored', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    expect(repo.get()).toEqual(DEFAULTS);
  });

  it('persists a partial update and merges it over the defaults', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    const updated = repo.update({ maxReviewRounds: 5, githubOwner: 'someone-else' });

    expect(updated.maxReviewRounds).toBe(5);
    expect(updated.githubOwner).toBe('someone-else');
    expect(updated.worktreesRoot).toBe(DEFAULTS.worktreesRoot);

    // A fresh repository instance sees the same values.
    expect(new SqliteSettingsRepository(db, DEFAULTS).get().maxReviewRounds).toBe(5);
  });

  it('rejects an out-of-range value rather than storing it', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    expect(() => repo.update({ maxReviewRounds: 999 })).toThrow(/not valid/i);
    expect(repo.get().maxReviewRounds).toBe(DEFAULTS.maxReviewRounds);
  });

  it('falls back to defaults when a stored value is corrupt', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    repo.update({ maxReviewRounds: 4 });

    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('"not a number"', 'maxReviewRounds');

    expect(repo.get()).toEqual(DEFAULTS);
  });

  it('ignores unknown keys left over from an older version', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('legacyOption', '"gone"');
    expect(repo.get()).toEqual(DEFAULTS);
  });

  it('defaults the Claude permission rules to running the tests and nothing else', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    expect(repo.get().claudeAllowedTools).toEqual(['Bash(npm test *)', 'PowerShell(npm test *)']);
  });

  it('trims permission rules on the way in', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    // Both lists together: the verification rules have to stay a subset of the
    // allowed ones, so narrowing one means narrowing the other.
    const updated = repo.update({
      claudeAllowedTools: ['  Bash(npm test *)  '],
      claudeVerificationTools: ['  Bash(npm test *)  ']
    });
    expect(updated.claudeAllowedTools).toEqual(['Bash(npm test *)']);
    expect(updated.claudeVerificationTools).toEqual(['Bash(npm test *)']);
  });

  it('rejects an empty, over-long or control-character permission rule', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);

    expect(() => repo.update({ claudeAllowedTools: ['   '] })).toThrow(/not valid/i);
    expect(() => repo.update({ claudeAllowedTools: ['Bash(' + 'x'.repeat(400) + ')'] })).toThrow(
      /not valid/i
    );
    expect(() => repo.update({ claudeAllowedTools: [`Bash(npm test)${NUL}rm -rf`] })).toThrow(
      /not valid/i
    );

    expect(repo.get().claudeAllowedTools).toEqual(DEFAULTS.claudeAllowedTools);
  });

  it('refuses more permission rules than the limit allows', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    const tooMany = Array.from({ length: 51 }, (_, i) => `Bash(cmd${i} *)`);
    expect(() => repo.update({ claudeAllowedTools: tooMany })).toThrow(/not valid/i);
  });

  it('refuses a permission list that leaves the verification rules unrunnable', () => {
    // Granting nothing used to be allowed. It no longer is: a verification rule
    // Claude was never permitted to run could only ever be denied, so a round
    // configured this way could never be published and would never say why.
    const repo = new SqliteSettingsRepository(db, DEFAULTS);

    expect(() => repo.update({ claudeAllowedTools: [] })).toThrow(/cannot be used/i);
    expect(repo.get().claudeAllowedTools).toEqual(DEFAULTS.claudeAllowedTools);
  });

  it('drops only the corrupt permission rules, keeping the user\'s other settings', () => {
    const repo = new SqliteSettingsRepository(db, DEFAULTS);
    repo.update({ githubOwner: 'someone-else', maxReviewRounds: 7 });

    // A hand-edited row, or a value written before the rules tightened.
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('"Bash(*)"', 'claudeAllowedTools');

    const loaded = repo.get();
    expect(loaded.claudeAllowedTools).toEqual(DEFAULTS.claudeAllowedTools);
    expect(loaded.githubOwner).toBe('someone-else');
    expect(loaded.maxReviewRounds).toBe(7);
  });
});

describe('durability on disk', () => {
  it('survives closing and reopening the database file', () => {
    const file = join(tempDir, 'agent-relay.sqlite');
    const first = openDatabase({ file });
    const projects = new SqliteProjectRepository(first, clock);
    const tasks = new SqliteTaskRepository(first, clock);

    const projectId = seedProject(projects);
    const taskId = seedTask(tasks, projectId);
    tasks.update(taskId, { codexThreadId: 'thread-1', claudeSessionId: 'sess-1', status: 'APPROVED' });
    closeDatabase(first);

    const second = openDatabase({ file });
    const reloadedTask = new SqliteTaskRepository(second, clock).findById(taskId);

    expect(new SqliteProjectRepository(second, clock).findById(projectId)).not.toBeNull();
    expect(reloadedTask?.status).toBe('APPROVED');
    expect(reloadedTask?.codexThreadId).toBe('thread-1');
    expect(reloadedTask?.claudeSessionId).toBe('sess-1');

    closeDatabase(second);
  });
});
