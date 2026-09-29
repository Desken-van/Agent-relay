/**
 * Design contract for Milestone 13B — NOT a migration, and not code the application runs.
 *
 * Executes the SQL block of docs/roadmap.md §7 ("Migration 24") against a real in-memory database migrated
 * through 1–23, so every refusal the document promises is observed rather than trusted. 13B turns that SQL into
 * the real migration 24 and replaces this file with tests of it; once the migration exists this file stops
 * applying cleanly (the tables already exist), which is intended.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db/database';

const AT = '2026-09-29T10:00:00.000Z';

function designDdl(): string {
  const document = readFileSync(resolve(import.meta.dirname, '..', '..', 'docs', 'roadmap.md'), 'utf8');
  const block = /### Migration 24[^\n]*\r?\n[\s\S]*?```sql\r?\n([\s\S]*?)```/.exec(document)?.[1];
  if (block === undefined) throw new Error('docs/roadmap.md has no SQL block under "### Migration 24".');
  return block;
}

function setup() {
  const db = openDatabase({ file: ':memory:' });
  const project = db.prepare(
    `INSERT INTO projects (id, name, local_path, project_type, default_branch, github_owner, github_repo,
                           github_visibility, created_at, updated_at)
     VALUES (?, ?, ?, 'existing', 'main', NULL, NULL, 'private', ?, ?)`
  );
  project.run('p1', 'P1', 'C:/p1', AT, AT);
  project.run('p2', 'P2', 'C:/p2', AT, AT);
  const task = db.prepare(
    `INSERT INTO tasks (id, project_id, title, original_request, status, created_at, updated_at)
     VALUES (?, ?, 't', 'r', ?, ?, ?)`
  );
  task.run('t1', 'p1', 'DRAFT', AT, AT);
  task.run('t2', 'p1', 'REVIEW_LIMIT_REACHED', '2026-09-29T11:00:00.000Z', AT);
  task.run('t3', 'p1', 'IMPLEMENTING', '2026-09-29T11:00:00.000Z', AT);
  task.run('tx', 'p2', 'COMPLETED', AT, AT);
  db.prepare(
    `INSERT INTO task_continuations (id, source_task_id, continuation_task_id, entry_action, created_at)
     VALUES ('c1', 't2', 't3', 'verification', ?)`
  ).run(AT);
  const tasksBefore = db.prepare('SELECT * FROM tasks ORDER BY id').all();

  db.exec(designDdl());

  const node = db.prepare(
    `INSERT INTO roadmap_nodes (id, project_id, kind, parent_id, parent_kind, title, position, state,
                                created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'n', ?, 'open', '${AT}', '${AT}')`
  );
  node.run('g1', 'p1', 'goal', null, null, 0);
  node.run('ph1', 'p1', 'phase', 'g1', 'goal', 0);
  node.run('e1', 'p1', 'epic', 'ph1', 'phase', 0);
  node.run('gx', 'p2', 'goal', null, null, 0);
  const place = db.prepare(
    `INSERT INTO roadmap_task_placements (task_id, project_id, epic_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, '${AT}', '${AT}')`
  );
  const dep = db.prepare(
    `INSERT INTO roadmap_dependencies (id, project_id, dependent_node_id, dependent_task_id,
                                       prerequisite_node_id, prerequisite_task_id, created_at)
     VALUES (?, 'p1', ?, ?, ?, ?, '${AT}')`
  );
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db, node, place, dep, count, tasksBefore };
}

describe('docs/roadmap.md migration 24 design', () => {
  it('accepts goal → phase → epic, leaves every task row as it was and every task unassigned', () => {
    const { db, count, tasksBefore } = setup();
    expect(count('roadmap_nodes')).toBe(4);
    expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasksBefore);
    const unassigned = db.prepare(
      `SELECT t.id FROM tasks t
        WHERE t.project_id = ? AND NOT EXISTS (SELECT 1 FROM roadmap_task_placements p WHERE p.task_id = t.id)
        ORDER BY t.created_at DESC, t.id ASC`
    ).all('p1');
    expect(unassigned).toEqual([{ id: 't2' }, { id: 't3' }, { id: 't1' }]);
    db.close();
  });

  describe.each([
    ['phase', 'goal'],
    ['epic', 'phase']
  ] as const)('a %s', (kind, parentKind) => {
    it.each([
      ['a missing parent', 'nowhere'],
      ['a parent of the wrong kind', kind === 'phase' ? 'e1' : 'g1'],
      ["another project's parent", 'gx'],
      ['itself', 'self']
    ])('is refused with %s, whether parent_kind is NULL or stated', (_label, parent) => {
      const { db, node } = setup();
      const parentId = parent === 'self' ? 'x1' : parent;
      expect(() => node.run('x1', 'p1', kind, parentId, null, 7)).toThrow(/CHECK constraint failed/);
      expect(() => node.run('x1', 'p1', kind, parentId, parentKind, 7)).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM roadmap_nodes WHERE id = 'x1'`).get()).toEqual({ n: 0 });
      db.close();
    });

    it('is refused without a parent, and with a parent_kind other than the one its kind requires', () => {
      const { db, node } = setup();
      expect(() => node.run('x1', 'p1', kind, null, parentKind, 7)).toThrow(/CHECK constraint failed/);
      expect(() => node.run('x1', 'p1', kind, null, null, 7)).toThrow(/CHECK constraint failed/);
      expect(() => node.run('x1', 'p1', kind, 'g1', 'epic', 7)).toThrow(/CHECK constraint failed/);
      db.close();
    });
  });

  it('refuses a goal with a parent or a parent kind', () => {
    const { db, node } = setup();
    expect(() => node.run('x1', 'p1', 'goal', 'g1', 'goal', 7)).toThrow(/CHECK constraint failed/);
    expect(() => node.run('x1', 'p1', 'goal', null, 'goal', 7)).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('refuses a NULL key in every roadmap table: a NULL would skip the foreign keys that use it', () => {
    const { db, node, place, dep } = setup();
    expect(() => node.run(null, 'p1', 'goal', null, null, 7)).toThrow(/NOT NULL constraint failed/);
    expect(() => place.run(null, 'p1', 'e1', 0)).toThrow(/NOT NULL constraint failed/);
    expect(() => dep.run(null, 'e1', null, null, 't1')).toThrow(/NOT NULL constraint failed/);
    expect(() => db.prepare(`INSERT INTO roadmap_heads (project_id, revision, updated_at) VALUES (NULL, 0, ?)`).run(AT))
      .toThrow(/NOT NULL constraint failed/);
    db.close();
  });

  it('keeps a node on its project and kind, allows a same-value full-row write, and checks the title', () => {
    const { db, node } = setup();
    expect(() => node.run('g9', 'p1', 'goal', null, null, 0)).toThrow(/UNIQUE constraint failed/);
    expect(() => node.run('ph9', 'p1', 'phase', 'g1', 'goal', 0)).toThrow(/UNIQUE constraint failed/);
    expect(() => db.prepare(`UPDATE roadmap_nodes SET kind = 'epic' WHERE id = 'g1'`).run()).toThrow(/keeps its id/);
    expect(() => db.prepare(`UPDATE roadmap_nodes SET project_id = 'p2' WHERE id = 'g1'`).run()).toThrow(/keeps its id/);
    expect(() =>
      db.prepare(`UPDATE roadmap_nodes SET id = id, project_id = project_id, kind = kind, title = 'x' WHERE id = 'g1'`).run()
    ).not.toThrow();
    expect(() => db.prepare(`UPDATE roadmap_nodes SET title = '' WHERE id = 'g1'`).run()).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('places a task only under an epic of its own project, once, at a free position', () => {
    const { db, place } = setup();
    place.run('t1', 'p1', 'e1', 0);
    expect(() => place.run('t2', 'p1', 'ph1', 1)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => place.run('tx', 'p2', 'e1', 1)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => place.run('tx', 'p1', 'e1', 1)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => place.run('t2', 'p1', 'e1', 0)).toThrow(/UNIQUE constraint failed/);
    expect(() => place.run('t1', 'p1', 'e1', 3)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('keeps a dependency to one end each, in one project, never self, never twice, never edited', () => {
    const { db, dep } = setup();
    dep.run('d1', 'e1', null, null, 't1');
    dep.run('d2', null, 't2', null, 't1');
    expect(() => dep.run('d3', null, 't2', null, 't1')).toThrow(/UNIQUE constraint failed/);
    expect(() => dep.run('d4', null, 't1', null, 't1')).toThrow(/CHECK constraint failed/);
    expect(() => dep.run('d5', 'e1', 't1', null, 't2')).toThrow(/CHECK constraint failed/);
    expect(() => dep.run('d6', null, null, null, 't2')).toThrow(/CHECK constraint failed/);
    expect(() => dep.run('d7', null, 't1', null, 'tx')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => dep.run('d8', null, 't1', 'gx', null)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.prepare(`UPDATE roadmap_dependencies SET prerequisite_task_id = 't2' WHERE id = 'd1'`).run())
      .toThrow(/never edited/);
    db.close();
  });

  it('removes a forgotten project’s roadmap and nothing of another project', () => {
    const { db, place, dep, count } = setup();
    place.run('t1', 'p1', 'e1', 0);
    dep.run('d1', 'e1', null, null, 't2');
    dep.run('d2', null, 't3', 'ph1', null);
    db.prepare(`INSERT INTO roadmap_heads (project_id, revision, updated_at) VALUES ('p1', 3, ?)`).run(AT);
    db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run();
    expect(
      ['roadmap_nodes', 'roadmap_task_placements', 'roadmap_dependencies', 'roadmap_heads', 'tasks'].map(count)
    ).toEqual([1, 0, 0, 0, 1]);
    db.close();
  });

  it('refuses deleting a referenced epic, a parent, a node with edges, or a placed or depended-on task', () => {
    const { db, node, place, dep } = setup();
    place.run('t1', 'p1', 'e1', 0);
    node.run('g2', 'p1', 'goal', null, null, 1);
    dep.run('d1', 'g2', null, null, 't2');
    const remove = (sql: string) => () => db.prepare(sql).run();
    expect(remove(`DELETE FROM roadmap_nodes WHERE id = 'e1'`)).toThrow(/FOREIGN KEY constraint failed/);
    expect(remove(`DELETE FROM roadmap_nodes WHERE id = 'g1'`)).toThrow(/FOREIGN KEY constraint failed/);
    expect(remove(`DELETE FROM roadmap_nodes WHERE id = 'g2'`)).toThrow(/FOREIGN KEY constraint failed/);
    expect(remove(`DELETE FROM tasks WHERE id = 't1'`)).toThrow(/FOREIGN KEY constraint failed/);
    expect(remove(`DELETE FROM tasks WHERE id = 't2'`)).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare(`DELETE FROM roadmap_dependencies WHERE id = 'd1'`).run();
    expect(remove(`DELETE FROM roadmap_nodes WHERE id = 'g2'`)).not.toThrow();
    db.close();
  });

  it('advances the head only from the expected revision', () => {
    const { db } = setup();
    const ensure = db.prepare(`INSERT OR IGNORE INTO roadmap_heads (project_id, revision, updated_at) VALUES (?, 0, ?)`);
    const bump = db.prepare(
      `UPDATE roadmap_heads SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND revision = ?`
    );
    ensure.run('p1', AT);
    expect(Number(bump.run(AT, 'p1', 0).changes)).toBe(1);
    ensure.run('p1', AT);
    expect(Number(bump.run(AT, 'p1', 0).changes)).toBe(0);
    expect(db.prepare(`SELECT revision FROM roadmap_heads WHERE project_id = 'p1'`).get()).toEqual({ revision: 1 });
    db.close();
  });

  it('reorders only in two phases, and reads each sibling group in order from its index', () => {
    const { db, place, node } = setup();
    node.run('e2', 'p1', 'epic', 'ph1', 'phase', 1);
    place.run('t1', 'p1', 'e1', 0);
    place.run('t2', 'p1', 'e1', 1);
    place.run('t3', 'p1', 'e2', 0);
    expect(() =>
      db.prepare(`UPDATE roadmap_task_placements SET position = 1 - position WHERE epic_id = 'e1'`).run()
    ).toThrow(/UNIQUE constraint failed/);
    // Move t3 to the front of e1: e1 becomes [t3, t2, t1] and e2 is left with a gap.
    db.transaction(() => {
      const max = db.prepare(`SELECT MAX(position) AS m FROM roadmap_task_placements WHERE epic_id = 'e1'`).get() as {
        m: number;
      };
      const offset = 1 + Math.max(2, max.m);
      db.prepare(`UPDATE roadmap_task_placements SET position = position + ? WHERE epic_id = 'e1'`).run(offset);
      const write = db.prepare(`UPDATE roadmap_task_placements SET epic_id = ?, position = ? WHERE task_id = ?`);
      write.run('e1', 0, 't3');
      write.run('e1', 1, 't2');
      write.run('e1', 2, 't1');
    })();
    expect(
      db.prepare(`SELECT task_id, epic_id, position FROM roadmap_task_placements ORDER BY epic_id, position`).all()
    ).toEqual([
      { task_id: 't3', epic_id: 'e1', position: 0 },
      { task_id: 't2', epic_id: 'e1', position: 1 },
      { task_id: 't1', epic_id: 'e1', position: 2 }
    ]);
    const plan = (sql: string, argument: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(argument) as { detail: string }[])
        .map((row) => row.detail)
        .join(' | ');
    for (const [sql, argument] of [
      ['SELECT id FROM roadmap_nodes WHERE parent_id = ? ORDER BY position', 'g1'],
      ['SELECT id FROM roadmap_nodes WHERE project_id = ? AND parent_id IS NULL ORDER BY position', 'p1'],
      ['SELECT task_id FROM roadmap_task_placements WHERE epic_id = ? ORDER BY position', 'e1']
    ] as const) {
      const detail = plan(sql, argument);
      expect(detail).toMatch(/USING INDEX/);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    }
    db.close();
  });
});
