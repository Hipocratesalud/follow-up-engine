import { SystemClock, type Clock } from '@follow-up-engine/core';
import pg from 'pg';
import { PostgresOutboxRelay, type DrainOutboxOptions, type DrainOutboxResult } from './outbox.ts';
import { DEFAULT_SCHEMA, tablesFor, type Queryable } from './sql.ts';
import { bindStores, type PostgresStores } from './stores.ts';
import { PostgresUnitOfWork, TransactionContext } from './unit-of-work.ts';

export interface CreatePoolOptions {
  /** Default `process.env.DATABASE_URL`. TLS via `sslmode` / `sslrootcert` (see docs/deploy.md). */
  readonly connectionString?: string;
  /** Default 10. */
  readonly max?: number;
  /** Shown in `pg_stat_activity`. Default `follow-up-engine`. */
  readonly applicationName?: string;
  /**
   * Called when an idle pooled connection errors (server restart, network).
   * The pool already discards the connection; without a listener node-postgres
   * would crash the process, so a no-op is installed by default.
   */
  readonly onIdleClientError?: (error: Error) => void;
}

/** Raised when no connection string is configured. */
export class MissingDatabaseUrlError extends Error {
  override readonly name = 'MissingDatabaseUrlError';

  constructor() {
    super('DATABASE_URL is not set (see docs/deploy.md)');
  }
}

/** A connection pool for the engine. One per process; close it with `pool.end()`. */
export function createPool(options: CreatePoolOptions = {}): pg.Pool {
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new MissingDatabaseUrlError();
  }
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'follow-up-engine',
  });
  pool.on('error', options.onIdleClientError ?? (() => undefined));
  return pool;
}

export interface PostgresAdaptersOptions {
  /** Schema the migrations were applied to. Default `follow_up`. */
  readonly schema?: string;
  /** Default `SystemClock`. Used for timestamps the ports do not pass in (enqueue, complete). */
  readonly clock?: Clock;
}

/** Every port implementation over one pool, ready for a composition root. */
export interface PostgresAdapters extends PostgresStores {
  readonly unitOfWork: PostgresUnitOfWork;
  readonly outboxRelay: PostgresOutboxRelay;
  /**
   * Where to run a custom query: the ambient `withTransaction` connection
   * when called inside one, the pool otherwise (health checks, reports).
   */
  readonly db: () => Queryable;
  /** Delivers pending outbox events through a publisher. See {@link PostgresOutboxRelay}. */
  drainOutbox(options: DrainOutboxOptions): Promise<DrainOutboxResult>;
}

/**
 * Builds every Postgres adapter over `pool`.
 *
 * The stores returned here run on the pool, except when called inside
 * `unitOfWork.withTransaction`, where they join that transaction. The pool
 * is the caller's: the adapters never end it.
 */
export function createPostgresAdapters(
  pool: pg.Pool,
  options: PostgresAdaptersOptions = {},
): PostgresAdapters {
  const tables = tablesFor(options.schema ?? DEFAULT_SCHEMA);
  const clock = options.clock ?? new SystemClock();
  const context = new TransactionContext(pool);
  const stores = bindStores(context.executor, tables, clock);
  const outboxRelay = new PostgresOutboxRelay({ db: context.executor, tables, clock });
  return {
    ...stores,
    unitOfWork: new PostgresUnitOfWork(pool, context, (executor) =>
      bindStores(executor, tables, clock),
    ),
    outboxRelay,
    db: context.executor,
    drainOutbox: (drainOptions) => outboxRelay.drain(drainOptions),
  };
}
