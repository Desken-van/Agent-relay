import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
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
