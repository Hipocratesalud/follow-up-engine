import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  type IsolatedDatabase,
  testDatabaseUrl,
} from '@follow-up-engine/adapter-postgres/testing';
import { afterAll, beforeAll } from 'vitest';

/** Whether Postgres suites run (`DATABASE_URL` is set). They are skipped, with a reason, otherwise. */
export const POSTGRES_ENABLED = testDatabaseUrl() !== undefined;

/** Title of a Postgres suite; says why it was skipped when there is no database. */
export function postgresTitle(title: string): string {
  return databaseSuiteTitle(`${title} (postgres)`);
}

/**
 * One freshly migrated, throwaway schema for the enclosing `describe`:
 * created before its tests, dropped after them. Suites use fresh clinic ids,
 * so tests share it safely.
 */
export function useIsolatedDatabase(): () => IsolatedDatabase {
  let database: IsolatedDatabase | undefined;
  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });
  afterAll(async () => {
    await database?.dispose();
    database = undefined;
  });
  return () => {
    if (database === undefined) {
      throw new Error('the isolated database is only available inside a test');
    }
    return database;
  };
}
