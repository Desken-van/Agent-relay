/**
 * Tests for the `node:sqlite` compatibility layer.
 *
 * This layer exists because `node:sqlite` throws on a bound object containing
 * keys the statement does not declare, while the repositories legitimately pass
 * whole domain objects to statements that touch a subset of their columns.
 * These tests pin that behaviour down, plus transactions and pragmas.
 */

import { describe, expect, it } from 'vitest';
import { createSqliteDatabase, namedParametersOf, type SqliteDatabase } from '../../src/main/db/sqlite';

function freshDb(): SqliteDatabase {
  const db = createSqliteDatabase(':memory:');
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b INTEGER, c TEXT)');
  return db;
}

describe('namedParametersOf', () => {
  it('finds @-prefixed parameters', () => {
    expect([...namedParametersOf('INSERT INTO t (a,b) VALUES (@alpha, @beta)')]).toEqual([
      'alpha',
      'beta'
    ]);
  });

  it('finds $ and : forms too', () => {
    expect([...namedParametersOf('SELECT * FROM t WHERE a = $one AND b = :two')]).toEqual([
      'one',
      'two'
    ]);
  });

  it('ignores an @ inside a string literal', () => {
    const names = namedParametersOf("SELECT * FROM t WHERE a = 'user@example.com' AND b = @real");
    expect([...names]).toEqual(['real']);
  });

  it('handles escaped quotes inside string literals', () => {
    const names = namedParametersOf("SELECT 'it''s @notaparam' AS x WHERE b = @real");
    expect([...names]).toEqual(['real']);
  });

  it('returns an empty set for positional-only SQL', () => {
    expect(namedParametersOf('SELECT * FROM t WHERE id = ?').size).toBe(0);
  });

  it('de-duplicates a parameter used twice', () => {
    expect([...namedParametersOf('SELECT * FROM t WHERE a = @x OR c = @x')]).toEqual(['x']);
  });
});

describe('parameter narrowing', () => {
  it('accepts an object carrying keys the statement does not declare', () => {
    const db = freshDb();
    const insert = db.prepare('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)');

    // This is exactly what the repositories do: pass a whole domain object to a
    // statement that only touches some of its columns. Raw node:sqlite rejects it.
    expect(() =>
      insert.run({
        id: '1',
        a: 'hello',
        b: 42,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        somethingElse: 'ignored'
      } as never)
    ).not.toThrow();

    expect(db.prepare('SELECT id, a, b FROM t').get()).toMatchObject({ id: '1', a: 'hello', b: 42 });
    db.close();
  });

  it('binds a missing declared key as NULL rather than failing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (id, a, c) VALUES (@id, @a, @c)').run({ id: '1', a: 'x' } as never);
    expect(db.prepare('SELECT c FROM t').get()).toMatchObject({ c: null });
    db.close();
  });

  it('still supports positional parameters', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (id, a, b) VALUES (?, ?, ?)').run('1', 'pos', 7);
    expect(db.prepare('SELECT a, b FROM t WHERE id = ?').get('1')).toMatchObject({
      a: 'pos',
      b: 7
    });
    db.close();
  });

  it('preserves explicit nulls', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (id, a, c) VALUES (@id, @a, @c)').run({
      id: '1',
      a: 'x',
      c: null
    });
    expect(db.prepare('SELECT c FROM t').get()).toMatchObject({ c: null });
    db.close();
  });

  it('returns integers as numbers, not BigInt', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (id, b) VALUES (?, ?)').run('1', 9007199254740);
    const row = db.prepare('SELECT b FROM t').get() as { b: unknown };
    expect(typeof row.b).toBe('number');
    db.close();
  });

  it('returns undefined from get() when there is no row', () => {
    const db = freshDb();
    expect(db.prepare('SELECT a FROM t WHERE id = ?').get('missing')).toBeUndefined();
    db.close();
  });

  it('returns an empty array from all() when there are no rows', () => {
    const db = freshDb();
    expect(db.prepare('SELECT a FROM t').all()).toEqual([]);
    db.close();
  });
});

describe('transactions', () => {
  it('commits on success', () => {
    const db = freshDb();
    const insertTwo = db.transaction(() => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'x');
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('2', 'y');
    });
    insertTwo();

    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 2 });
    db.close();
  });

  it('rolls back everything when the body throws', () => {
    const db = freshDb();
    const boom = db.transaction(() => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'x');
      throw new Error('boom');
    });

    expect(() => boom()).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 0 });
    db.close();
  });

  it('passes arguments through to the body', () => {
    const db = freshDb();
    const insert = db.transaction((id: string, a: string) => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run(id, a);
    });
    insert('7', 'seven');

    expect(db.prepare('SELECT a FROM t WHERE id = ?').get('7')).toMatchObject({ a: 'seven' });
    db.close();
  });

  it('nests using savepoints, rolling back only the inner block', () => {
    const db = freshDb();

    const inner = db.transaction(() => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('inner', 'i');
      throw new Error('inner failed');
    });

    const outer = db.transaction(() => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('outer', 'o');
      try {
        inner();
      } catch {
        // Swallowed on purpose: the outer transaction should still commit.
      }
    });

    outer();

    const ids = (db.prepare('SELECT id FROM t ORDER BY id').all() as { id: string }[]).map(
      (row) => row.id
    );
    expect(ids).toEqual(['outer']);
    db.close();
  });

  it('recovers after a rolled-back transaction and can transact again', () => {
    const db = freshDb();
    const fails = db.transaction(() => {
      throw new Error('nope');
    });
    expect(() => fails()).toThrow();

    const works = db.transaction(() => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'ok');
    });
    expect(() => works()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 1 });
    db.close();
  });
});

describe('pragma', () => {
  it('applies a setting when the statement contains "="', () => {
    const db = createSqliteDatabase(':memory:');
    expect(() => db.pragma('foreign_keys = ON')).not.toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('reads a value as a row by default', () => {
    const db = createSqliteDatabase(':memory:');
    expect(db.pragma('foreign_keys')).toMatchObject({ foreign_keys: expect.any(Number) });
    db.close();
  });
});

describe('errors', () => {
  it('surfaces a UNIQUE constraint violation with the column name', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'x');
    expect(() => db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'y')).toThrow(
      /UNIQUE constraint failed: t\.id/
    );
    db.close();
  });
});
