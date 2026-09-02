/**
 * The database's transaction helper, behind a port.
 *
 * Lets a service be atomic without taking a database handle: it declares a
 * {@link TransactionRunner} dependency and stays free of SQL, and the one place
 * that knows about SQLite is here.
 */

import type { TransactionRunner } from '../ports';
import type { Db } from './database';

export class SqliteTransactionRunner implements TransactionRunner {
  constructor(private readonly db: Db) {}

  run(work: () => void): void {
    this.db.transaction(work)();
  }
}
