import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { SqliteTransactionRunner } from '../../src/main/db/transaction-runner';

let directory: string;
let db: Db;
let observer: Db;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-relay-after-commit-'));
  const file = join(directory, 'after-commit.sqlite');
  db = openDatabase({ file });
  db.exec('CREATE TABLE marks (value TEXT NOT NULL)');
  observer = openDatabase({ file });
});

afterEach(() => {
  db.close();
  observer.close();
  rmSync(directory, { recursive: true, force: true });
});

const mark = (value: string) => db.prepare('INSERT INTO marks (value) VALUES (?)').run(value);
/** What another connection can see — only committed rows. */
const committed = () => (observer.prepare('SELECT value FROM marks ORDER BY rowid').all() as { value: string }[])
  .map((row) => row.value);

describe('afterCommit', () => {
  it('runs at once outside a transaction', () => {
    const seen: string[] = [];
    db.afterCommit(() => seen.push('now'));
    expect(seen).toEqual(['now']);
  });

  it('runs after the outermost COMMIT, when another connection can already see the work', () => {
    const seen: string[][] = [];
    db.transaction(() => {
      mark('a');
      db.afterCommit(() => seen.push(committed()));
      expect(seen).toEqual([]);
    })();
    expect(seen).toEqual([['a']]);
  });

  it('does not run when a nested transaction is released, only when the outer one commits', () => {
    const seen: string[] = [];
    db.transaction(() => {
      db.transaction(() => {
        mark('inner');
        db.afterCommit(() => seen.push(`inner sees ${committed().join(',')}`));
      })();
      expect(seen).toEqual([]);
      mark('outer');
    })();
    expect(seen).toEqual(['inner sees inner,outer']);
  });

  it('never runs a callback whose released savepoint is later rolled back by the outer transaction', () => {
    const seen: string[] = [];
    expect(() =>
      db.transaction(() => {
        db.transaction(() => {
          mark('inner');
          db.afterCommit(() => seen.push('inner'));
        })();
        throw new Error('outer rollback');
      })()
    ).toThrow('outer rollback');
    expect(seen).toEqual([]);
    expect(committed()).toEqual([]);
  });

  it('drops only what the rolled-back savepoint registered; the outer transaction still commits its own', () => {
    const seen: string[] = [];
    db.transaction(() => {
      db.afterCommit(() => seen.push('outer-before'));
      try {
        db.transaction(() => {
          mark('inner');
          db.afterCommit(() => seen.push('inner'));
          db.transaction(() => db.afterCommit(() => seen.push('deeper')))();
          throw new Error('inner rollback');
        })();
      } catch {
        // the caller chooses to continue
      }
      db.afterCommit(() => seen.push('outer-after'));
      mark('outer');
    })();
    expect(seen).toEqual(['outer-before', 'outer-after']);
    expect(committed()).toEqual(['outer']);
  });

  it('forgets everything registered before a rolled-back outer transaction', () => {
    const seen: string[] = [];
    expect(() => db.transaction(() => {
      db.afterCommit(() => seen.push('stale'));
      throw new Error('rollback');
    })()).toThrow('rollback');
    db.transaction(() => db.afterCommit(() => seen.push('fresh')))();
    expect(seen).toEqual(['fresh']);
  });

  it('runs every callback in order, then reports the first failure without undoing the commit', () => {
    const seen: string[] = [];
    expect(() =>
      db.transaction(() => {
        mark('kept');
        db.afterCommit(() => seen.push('first'));
        db.afterCommit(() => {
          throw new Error('listener failed');
        });
        db.afterCommit(() => seen.push('third'));
      })()
    ).toThrow('listener failed');
    expect(seen).toEqual(['first', 'third']);
    expect(committed()).toEqual(['kept']);
  });

  it('is what the transaction runner port exposes', () => {
    const runner = new SqliteTransactionRunner(db);
    const seen: string[] = [];
    runner.run(() => {
      runner.run(() => runner.afterCommit(() => seen.push(`after ${committed().length}`)));
      mark('x');
    });
    expect(seen).toEqual(['after 1']);
  });
});
