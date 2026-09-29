import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { SqliteRoadmapRepository } from '../../src/main/db/repositories/roadmap-repository';
import { FixedClock } from '../../src/main/infra/clock';
import type { RoadmapChange } from '../../src/main/ports';
import type { RoadmapNode } from '../../src/shared/domain/roadmap';
import { dependency, nodeRef, placement, PROJECT, OTHER_PROJECT, roadmapNode, taskRef } from '../helpers/roadmap-fixtures';

const AT = '2026-09-29T10:00:00.000Z';
const LATER = '2026-09-29T11:00:00.000Z';
let db: Db;
let repo: SqliteRoadmapRepository;
let clock: FixedClock;
let directory: string | undefined;
const connections: Db[] = [];

function seed(database: Db) {
  for (const project of [PROJECT, OTHER_PROJECT]) {
    database.prepare(`INSERT INTO projects(id,name,local_path,project_type,default_branch,github_visibility,created_at,updated_at)
      VALUES (?,?,?,'existing','main','private',?,?)`).run(project, project, `C:/${project}`, AT, AT);
  }
  const task = database.prepare(`INSERT INTO tasks(id,project_id,title,original_request,status,created_at,updated_at)
    VALUES (?,?,'Task','Request',?,?,?)`);
  for (const [id, status, created] of [['t1', 'DRAFT', AT], ['t2', 'FAILED', LATER], ['t3', 'DRAFT', LATER], ['t4', 'CANCELLED', AT]]) {
    task.run(id!, PROJECT, status!, created!, AT);
  }
  task.run('foreign-task', OTHER_PROJECT, 'DRAFT', AT, AT);
  database.prepare(`INSERT INTO task_continuations(id,source_task_id,continuation_task_id,entry_action,created_at)
    VALUES ('continuation','t2','t3','verification',?)`).run(AT);
}

function hierarchy(): RoadmapNode[] {
  return [
    roadmapNode({ id: 'g1', kind: 'goal', position: 0, acceptanceCriteria: [{ id: 'c1', text: 'Persist the roadmap.' }] }),
    roadmapNode({ id: 'g2', kind: 'goal', position: 1 }),
    roadmapNode({ id: 'p1', kind: 'phase', parentId: 'g1' }),
    roadmapNode({ id: 'p2', kind: 'phase', parentId: 'g2' }),
    roadmapNode({ id: 'e1', kind: 'epic', parentId: 'p1' }),
    roadmapNode({ id: 'e2', kind: 'epic', parentId: 'p2' })
  ];
}
function start() {
  return repo.apply(PROJECT, 0, { nodeUpserts: hierarchy(), placementUpserts: [placement('t1', 'e1', 0), placement('t2', 'e1', 1)] });
}
function contents(database = db) {
  return Object.fromEntries(['roadmap_heads', 'roadmap_nodes', 'roadmap_task_placements', 'roadmap_dependencies', 'tasks', 'task_continuations']
    .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function node(id: string) { return repo.read(PROJECT).nodes.find((row) => row.id === id)!; }

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  connections.push(db);
  seed(db);
  clock = new FixedClock(new Date(AT));
  repo = new SqliteRoadmapRepository(db, clock);
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  if (directory !== undefined) { rmSync(directory, { recursive: true, force: true }); directory = undefined; }
});

describe('Roadmap storage', () => {
  it('reads an empty roadmap at revision zero without backfilling; Unassigned includes every status in stable order', () => {
    const before = contents();
    expect(repo.read(PROJECT)).toMatchObject({ revision: 0, nodes: [], placements: [], dependencies: [] });
    expect(repo.listUnassigned(PROJECT).map((row) => row.id)).toEqual(['t2', 't3', 't1', 't4']);
    expect(repo.read(PROJECT).tasks.find((row) => row.id === 't2')?.continuedByTaskId).toBe('t3');
    expect(contents()).toEqual(before);
  });

  it('writes hierarchy, placement and typed dependencies once, preserving every workflow row', () => {
    const tasks = contents().tasks;
    const result = repo.apply(PROJECT, 0, {
      nodeUpserts: [...hierarchy()].reverse(), // storage orders parents before children
      placementUpserts: [placement('t1', 'e1', 0)],
      dependencyInserts: [dependency('d1', nodeRef('e1'), nodeRef('e2')), dependency('d2', taskRef('t3'), taskRef('t1'))]
    });
    expect(result.revision).toBe(1);
    expect(result.dependencies).toHaveLength(2);
    expect(result.nodes.find((row) => row.id === 'g1')?.acceptanceCriteria).toEqual(hierarchy()[0]!.acceptanceCriteria);
    expect(repo.listUnassigned(PROJECT).map((row) => row.id)).toEqual(['t2', 't3', 't4']);
    expect(contents().tasks).toEqual(tasks);
  });

  it('reads updated workflow facts without incrementing the roadmap revision', () => {
    start();
    db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = 't1'").run();
    expect(repo.read(PROJECT)).toMatchObject({ revision: 1, tasks: expect.arrayContaining([expect.objectContaining({ id: 't1', status: 'COMPLETED' })]) });
  });

  it('refuses stale revisions without changing any table or timestamp', () => {
    start(); clock.advance(1000);
    const before = contents();
    expect(() => repo.apply(PROJECT, 0, { nodeRemovals: ['e2'] })).toThrow('Roadmap changed. Refresh.');
    expect(contents()).toEqual(before);
  });

  it('rolls back the first head insertion on an invalid final snapshot', () => {
    const before = contents();
    expect(() => repo.apply(PROJECT, 0, {
      nodeUpserts: hierarchy().map((row) => row.id === 'g1' ? { ...row, state: 'accepted' } : row)
    })).toThrow('not structurally valid');
    expect(contents()).toEqual(before);
  });

  it('rolls back deletes, position shifts, updates, inserts and revision when final validation fails', () => {
    start();
    repo.apply(PROJECT, 1, { dependencyInserts: [dependency('old', nodeRef('g1'), nodeRef('g2'))] });
    const before = contents();
    expect(() => repo.apply(PROJECT, 2, {
      dependencyRemovals: ['old'],
      nodeUpserts: [ { ...node('g1'), position: 1 }, { ...node('g2'), position: 0, title: 'Changed' } ],
      placementRemovals: ['t2'],
      dependencyInserts: [dependency('bad', nodeRef('e1'), taskRef('t1'))] // containment, caught after SQL writes
    })).toThrow('not structurally valid');
    expect(contents()).toEqual(before);
  });

  it('swaps node and task positions without losing identities or creation timestamps', () => {
    start();
    const result = repo.apply(PROJECT, 1, {
      nodeUpserts: [{ ...node('g1'), position: 1, updatedAt: LATER }, { ...node('g2'), position: 0, updatedAt: LATER }],
      placementUpserts: [placement('t1', 'e1', 1), placement('t2', 'e1', 0)]
    });
    expect(result.nodes.filter((row) => row.kind === 'goal').map((row) => row.id)).toEqual(['g2', 'g1']);
    expect(result.placements.map((row) => row.taskId)).toEqual(['t2', 't1']);
    expect(result.nodes.find((row) => row.id === 'g1')).toMatchObject({ createdAt: AT, updatedAt: LATER });
  });

  it('moves tasks and nodes across groups with stable IDs and permits a gap in a source-only group', () => {
    start();
    const result = repo.apply(PROJECT, 1, {
      nodeUpserts: [{ ...node('e1'), parentId: 'p2', position: 0 }, { ...node('e2'), position: 1 }],
      placementUpserts: [placement('t1', 'e2', 0)]
    });
    expect(result.nodes.find((row) => row.id === 'e1')?.parentId).toBe('p2');
    expect(result.placements).toEqual([placement('t2', 'e1', 1), placement('t1', 'e2', 0)]);
  });

  it('moves surviving children and tasks out before deleting their old ancestors in the same transaction', () => {
    start();
    const result = repo.apply(PROJECT, 1, {
      nodeRemovals: ['g1', 'p1', 'e1'],
      nodeUpserts: [{ ...node('g2'), position: 0 }],
      placementUpserts: [placement('t1', 'e2', 0), placement('t2', 'e2', 1)]
    });
    expect(result.nodes.map((row) => row.id)).toEqual(['g2', 'p2', 'e2']);
    expect(result.placements.every((row) => row.epicId === 'e2')).toBe(true);
    const moved = repo.apply(PROJECT, 2, { nodeUpserts: [roadmapNode({ id: 'g3', kind: 'goal', position: 0 }), { ...node('p2'), parentId: 'g3' }], nodeRemovals: ['g2'] });
    expect(moved.nodes.map((row) => row.id)).toEqual(['g3', 'p2', 'e2']);
  });

  it('allows a metadata-only update without rewriting its sibling order', () => {
    start();
    expect(repo.apply(PROJECT, 1, { nodeUpserts: [{ ...node('g1'), title: 'New title' }] }).nodes[0]?.title).toBe('New title');
  });

  it('rejects incomplete or non-dense destination orders and restores the head', () => {
    start(); const before = contents();
    expect(() => repo.apply(PROJECT, 1, { placementUpserts: [placement('t3', 'e1', 2)] })).toThrow('complete order');
    expect(() => repo.apply(PROJECT, 1, { placementUpserts: [placement('t3', 'e2', 2)] })).toThrow('complete order');
    expect(contents()).toEqual(before);
  });

  it('unassigns without altering the task and removes dependency references explicitly', () => {
    start();
    repo.apply(PROJECT, 1, { dependencyInserts: [dependency('d1', nodeRef('g2'), taskRef('t1'))] });
    const result = repo.apply(PROJECT, 2, { dependencyRemovals: ['d1'], placementRemovals: ['t1', 't2'], nodeRemovals: ['g1', 'p1', 'e1'] });
    expect(result.dependencies).toEqual([]);
    expect(result.tasks).toHaveLength(4);
    expect(repo.listUnassigned(PROJECT)).toHaveLength(4);
  });

  it('retargets a dependency with delete plus a new identity, never updates the old record', () => {
    start(); repo.apply(PROJECT, 1, { dependencyInserts: [dependency('old', nodeRef('g1'), nodeRef('g2'))] });
    const result = repo.apply(PROJECT, 2, { dependencyRemovals: ['old'], dependencyInserts: [dependency('new', nodeRef('e1'), nodeRef('e2'))] });
    expect(result.dependencies.map((row) => row.id)).toEqual(['new']);
    const before = contents();
    expect(() => repo.apply(PROJECT, 3, { dependencyInserts: [dependency('new', nodeRef('g1'), nodeRef('g2'))] })).toThrow();
    expect(contents()).toEqual(before);
  });

  it.each([
    { nodeRemovals: ['missing'] },
    { placementRemovals: ['foreign-task'] },
    { nodeRemovals: ['e1', 'e1'] },
    { nodeUpserts: [roadmapNode({ id: 'g1', kind: 'goal' }), roadmapNode({ id: 'g1', kind: 'goal' })] },
    { nodeRemovals: ['g1'], nodeUpserts: [roadmapNode({ id: 'g1', kind: 'goal' })] },
    { nodeUpserts: [roadmapNode({ id: 'g1', kind: 'goal', createdAt: LATER })] },
    { nodeUpserts: [roadmapNode({ id: 'new', kind: 'goal', projectId: OTHER_PROJECT })] },
    { placementUpserts: [placement('foreign-task', 'e2', 0)] }
  ] satisfies RoadmapChange[])('rejects invalid/foreign/ambiguous changes atomically: %j', (change) => {
    start(); const before = contents();
    expect(() => repo.apply(PROJECT, 1, change)).toThrow();
    expect(contents()).toEqual(before);
  });

  it('cannot hijack another project’s node by upserting its id', () => {
    repo.apply(OTHER_PROJECT, 0, { nodeUpserts: [roadmapNode({ id: 'foreign', kind: 'goal', projectId: OTHER_PROJECT })] });
    const before = contents();
    expect(() => repo.apply(PROJECT, 0, { nodeUpserts: [roadmapNode({ id: 'foreign', kind: 'goal' })] })).toThrow();
    expect(contents()).toEqual(before);
  });

  it.each(['not-json', '{}', '[{"id":"c","text":" padded "}]'])('reports corrupt stored criteria with a path and refuses writes (%s)', (json) => {
    start();
    db.prepare('UPDATE roadmap_nodes SET acceptance_criteria_json = ? WHERE id = ?').run(json, 'g1');
    const before = contents();
    try { repo.read(PROJECT); expect.unreachable(); } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', details: expect.stringContaining('nodes.0.acceptanceCriteria') });
    }
    expect(() => repo.apply(PROJECT, 1, { nodeUpserts: [hierarchy()[0]!] })).toThrow();
    expect(contents()).toEqual(before);
  });

  it('uses savepoints correctly when a caller rolls back an enclosing transaction', () => {
    const before = contents();
    expect(() => db.transaction(() => { start(); throw new Error('caller rollback'); })()).toThrow('caller rollback');
    expect(contents()).toEqual(before);
  });

  it('rejects an unknown project and malformed input without creating a head', () => {
    expect(() => repo.read('missing')).toThrow('no longer exists');
    expect(() => repo.apply('missing', 0, {})).toThrow('no longer exists');
    expect(() => repo.apply(PROJECT, -1, {})).toThrow();
    expect(() => repo.apply(PROJECT, 0, { unexpected: true } as RoadmapChange)).toThrow();
    expect(db.prepare('SELECT * FROM roadmap_heads').all()).toEqual([]);
  });

  it('persists the exact snapshot across close/reopen and rejects a stale writer on another connection', () => {
    directory = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-'));
    const file = join(directory, 'roadmap.sqlite');
    const first = openDatabase({ file }); seed(first);
    const firstRepo = new SqliteRoadmapRepository(first, clock);
    const before = firstRepo.apply(PROJECT, 0, { nodeUpserts: hierarchy(), placementUpserts: [placement('t1', 'e1', 0)], dependencyInserts: [dependency('d1', nodeRef('e1'), nodeRef('e2'))] });
    first.close();
    const reopened = openDatabase({ file }); connections.push(reopened);
    const second = openDatabase({ file }); connections.push(second);
    const writer = new SqliteRoadmapRepository(reopened, clock);
    const stale = new SqliteRoadmapRepository(second, clock);
    expect(writer.read(PROJECT)).toEqual(before);
    const savedRevision = stale.read(PROJECT).revision;
    writer.apply(PROJECT, savedRevision, { dependencyRemovals: ['d1'] });
    const current = contents(reopened);
    expect(() => stale.apply(PROJECT, savedRevision, { nodeRemovals: ['e2'] })).toThrow('Roadmap changed. Refresh.');
    expect(contents(reopened)).toEqual(current);
    expect(stale.read(PROJECT)).toEqual(writer.read(PROJECT));
  });
});
