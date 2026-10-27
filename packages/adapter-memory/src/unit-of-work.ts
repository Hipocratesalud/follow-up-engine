import type { ClinicId, TransactionalStores, UnitOfWork } from '@follow-up-engine/core';
import type { MemoryDatabase } from './memory-database.ts';

/**
 * In-memory {@link UnitOfWork} with real rollback: the database is
 * snapshotted before the work runs and restored if it throws, so jobs,
 * outbox events and domain changes commit together or not at all.
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
      const snapshot = this.#db.snapshot();
      try {
        return await work(this.#stores);
      } catch (error) {
        this.#db.restore(snapshot);
        throw error;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
