import type { ClinicId, TransactionalStores, UnitOfWork } from '@follow-up-engine/core';
import type { MemoryDatabase } from './memory-database.ts';

/**
 * In-memory {@link UnitOfWork} with real rollback: every write of the work is
 * journaled and undone if it throws, so jobs, outbox events and domain
 * changes commit together or not at all, at the cost of what the work wrote.
 * Transactions are serialized (one at a time), like `SERIALIZABLE` without
 * retries; do not nest them.
 */
export class MemoryUnitOfWork implements UnitOfWork {
  readonly #db: MemoryDatabase;
  readonly #stores: TransactionalStores;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(db: MemoryDatabase, stores: TransactionalStores) {
    this.#db = db;
    this.#stores = stores;
  }

  withTransaction<TResult>(
    _clinicId: ClinicId,
    work: (stores: TransactionalStores) => Promise<TResult>,
  ): Promise<TResult> {
    const run = async (): Promise<TResult> => {
      this.#db.begin();
      try {
        const result = await work(this.#stores);
        this.#db.commit();
        return result;
      } catch (error) {
        this.#db.rollback();
        throw error;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
