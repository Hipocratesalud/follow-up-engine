import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantMismatchError, type ClinicId, type UnitOfWork } from '@follow-up-engine/core';
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from './sql.ts';
import type { PostgresStores } from './stores.ts';

/** The transaction a unit of work runs in, shared by nested calls. */
interface TransactionScope {
  readonly client: PoolClient;
  readonly clinicId: ClinicId;
  readonly stores: PostgresStores;
  savepoints: number;
  open: boolean;
}

/** A transaction-bound store was used after its unit of work finished. */
export class TransactionClosedError extends Error {
  override readonly name = 'TransactionClosedError';

  constructor() {
    super('The unit of work this store belongs to has already committed or rolled back');
  }
}

/**
 * The unit of work returned normally, but a statement inside it had failed
 * (its error caught and ignored), so Postgres rolled the transaction back.
 */
export class TransactionAbortedError extends Error {
  override readonly name = 'TransactionAbortedError';

  constructor() {
    super('A statement failed inside the unit of work; the transaction was rolled back');
  }
}

/**
 * Tracks the ambient transaction per async call chain, so repositories built
 * on the pool join it (see {@link TransactionContext.executor}) and nested
 * units of work reuse it.
 */
export class TransactionContext {
  readonly #storage = new AsyncLocalStorage<TransactionScope>();
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Executor for pool-bound repositories: the ambient transaction's client
   * when called inside `withTransaction`, the pool otherwise. This keeps a
   * repository call made inside a unit of work from running on a second
   * connection, where it would miss uncommitted writes or wait on the
   * transaction's own row locks.
   */
  readonly executor = (): Queryable => {
    const scope = this.#storage.getStore();
    return scope?.open === true ? scope.client : this.#pool;
  };

  current(): TransactionScope | undefined {
    const scope = this.#storage.getStore();
    return scope?.open === true ? scope : undefined;
  }

  run<TResult>(scope: TransactionScope, work: () => Promise<TResult>): Promise<TResult> {
    return this.#storage.run(scope, work);
  }
}

/**
 * `UnitOfWork` on a Postgres transaction.
 *
 * - Every store handed to `work` is bound to one connection inside
 *   `BEGIN ... COMMIT`; any throw rolls everything back (jobs and outbox
 *   events included) and rethrows.
 * - The transaction is scoped to the clinic: `app.clinic_id` is set with
 *   `set_config(..., true)` for row-level security policies that want it.
 * - Nested calls reuse the same transaction through a savepoint: a nested
 *   failure rolls back only the nested work, and the outer unit decides
 *   whether to continue. A nested call for a different clinic throws
 *   `TenantMismatchError`. Nested units must not run concurrently with each
 *   other on the same transaction (`Promise.all`); one connection runs one
 *   statement at a time and savepoints are a stack.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  readonly #pool: Pool;
  readonly #context: TransactionContext;
  readonly #bindStores: (executor: () => Queryable) => PostgresStores;

  constructor(
    pool: Pool,
    context: TransactionContext,
    bindStores: (executor: () => Queryable) => PostgresStores,
  ) {
    this.#pool = pool;
    this.#context = context;
    this.#bindStores = bindStores;
  }

  async withTransaction<TResult>(
    clinicId: ClinicId,
    work: (stores: PostgresStores) => Promise<TResult>,
  ): Promise<TResult> {
    const ambient = this.#context.current();
    if (ambient !== undefined) {
      if (ambient.clinicId !== clinicId) {
        throw new TenantMismatchError();
      }
      return this.#nested(ambient, work);
    }
    const client = await this.#pool.connect();
    let discardClient = false;
    const scope: TransactionScope = {
      client,
      clinicId,
      savepoints: 0,
      open: true,
      stores: this.#bindStores(() => {
        if (!scope.open) {
          throw new TransactionClosedError();
        }
        return client;
      }),
    };
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.clinic_id', $1, true)`, [clinicId]);
      const result = await this.#context.run(scope, () => work(scope.stores));
      const commit = await client.query('COMMIT');
      // A statement failed inside `work` and the error was swallowed: Postgres
      // answers COMMIT on an aborted transaction with a silent ROLLBACK.
      if (commit.command === 'ROLLBACK') {
        throw new TransactionAbortedError();
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discardClient = true;
      });
      throw error;
    } finally {
      scope.open = false;
      client.release(discardClient);
    }
  }

  async #nested<TResult>(
    scope: TransactionScope,
    work: (stores: PostgresStores) => Promise<TResult>,
  ): Promise<TResult> {
    scope.savepoints += 1;
    const savepoint = `unit_of_work_${String(scope.savepoints)}`;
    await scope.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await work(scope.stores);
      await scope.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await scope.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}
