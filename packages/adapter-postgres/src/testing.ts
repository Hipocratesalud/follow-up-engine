import { randomBytes } from 'node:crypto';
import type { Clock } from '@follow-up-engine/core';
import type pg from 'pg';
import { createPool, createPostgresAdapters, type PostgresAdapters } from './adapters.ts';
import { migrate } from './migrate.ts';
import { quoteSchema } from './sql.ts';

/**
 * Test support: a freshly migrated, throwaway schema per test file, so test
 * files (and contract suites) run in parallel against one database without
 * seeing each other's rows. Exported as
 * `@follow-up-engine/adapter-postgres/testing`; not for production code.
 */
export interface IsolatedDatabase {
  readonly pool: pg.Pool;
  readonly schema: string;
  /** Adapters bound to the isolated schema. */
  adapters(options?: { readonly clock?: Clock }): PostgresAdapters;
  /** Drops the schema and closes the pool. */
  dispose(): Promise<void>;
}

/** The `DATABASE_URL` integration tests run against, or `undefined` to skip them. */
export function testDatabaseUrl(): string | undefined {
  const url = process.env['DATABASE_URL'];
  return url === undefined || url === '' ? undefined : url;
}

export async function createIsolatedDatabase(
  options: { readonly connectionString?: string; readonly max?: number } = {},
): Promise<IsolatedDatabase> {
  const pool = createPool({
    ...(options.connectionString === undefined
      ? {}
      : { connectionString: options.connectionString }),
    max: options.max ?? 5,
    applicationName: 'follow-up-engine-test',
  });
  const schema = `follow_up_test_${randomBytes(6).toString('hex')}`;
  await migrate(pool, { schema });
  return {
    pool,
    schema,
    adapters: (adapterOptions = {}) =>
      createPostgresAdapters(pool, {
        schema,
        ...(adapterOptions.clock === undefined ? {} : { clock: adapterOptions.clock }),
      }),
    dispose: async () => {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

/**
 * Suite title that says why it was skipped when no database is configured,
 * for `describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle(...), ...)`.
 */
export function databaseSuiteTitle(title: string): string {
  return testDatabaseUrl() === undefined
    ? `${title} [skipped: DATABASE_URL is not set; run \`docker compose up -d postgres\` and export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine]`
    : title;
}
