import { FakeClock } from '@follow-up-engine/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from './clinic-directory.ts';
import { applySupabaseRowLevelSecurity } from './supabase.ts';
import { BASE, newClinic } from './test-fixtures.ts';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  type IsolatedDatabase,
  testDatabaseUrl,
} from './testing.ts';

/**
 * Row-level security can never be forgotten: every table of the engine
 * schema has RLS right after `migrate()` (a later migration that adds a
 * table without it fails here, in CI), and after `supabase/rls.sql` every
 * policy is a clinic-scoped read for `authenticated`. Runs on plain
 * Postgres: the Supabase roles and `auth.jwt()` are emulated when missing.
 */
describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle('row-level security'), () => {
  let database: IsolatedDatabase;
  let pool: pg.Pool;
  const clinic = newClinic('rls');

  beforeAll(async () => {
    database = await createIsolatedDatabase({ max: 3 });
    pool = database.pool;
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END
      $$`);
    await pool.query('CREATE SCHEMA IF NOT EXISTS auth');
    await pool.query(`
      DO $$
      BEGIN
        IF to_regprocedure('auth.jwt()') IS NULL THEN
          CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
            'SELECT coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
        END IF;
      END
      $$`);
    await pool.query('GRANT USAGE ON SCHEMA auth TO anon, authenticated');
    await pool.query('GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated');
    const adapters = database.adapters({ clock: new FakeClock(BASE) });
    await adapters.clinics.register({ id: clinic, name: 'RLS', apiKeyHash: hashApiKey('k') });
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function tables(): Promise<{ name: string; rls: boolean }[]> {
    const { rows } = await pool.query<{ name: string; rls: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
      [database.schema],
    );
    return rows;
  }

  it('has RLS on every table right after migrate(), before any Supabase script', async () => {
    const all = await tables();
    expect(all.map((table) => table.name)).toContain('api_keys');
    expect(all.filter((table) => !table.rls)).toEqual([]);
  });

  it('after rls.sql, every policy is a clinic-scoped read for authenticated users', async () => {
    await applySupabaseRowLevelSecurity(pool, { schema: database.schema });
    await applySupabaseRowLevelSecurity(pool, { schema: database.schema });
    expect((await tables()).filter((table) => !table.rls)).toEqual([]);
    const { rows } = await pool.query<{
      table: string;
      cmd: string;
      roles: string[];
      qual: string;
    }>(
      `SELECT tablename AS table, cmd, roles::text[] AS roles, qual FROM pg_policies
       WHERE schemaname = $1`,
      [database.schema],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const policy of rows) {
      expect(policy).toMatchObject({ cmd: 'SELECT', roles: ['authenticated'] });
      expect(policy.qual).toMatch(/clinic_id/);
    }
    const anonGrants = await pool.query(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND grantee = 'anon'`,
      [database.schema],
    );
    expect(anonGrants.rows).toEqual([]);
  });

  it('denies by default even after broad grants and on a table added later', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const schema = `"${database.schema}"`;
      // What Supabase's guide to exposing a custom schema does, by mistake here.
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated`);
      await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO anon, authenticated`);
      await client.query(`CREATE TABLE ${schema}.future_table (clinic_id text, secret text)`);
      await client.query(`ALTER TABLE ${schema}.future_table ENABLE ROW LEVEL SECURITY`);
      await client.query(`GRANT ALL ON ${schema}.future_table TO anon, authenticated`);
      await client.query(`INSERT INTO ${schema}.future_table VALUES ($1, 'phi')`, [clinic]);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ clinic_id: clinic }),
      ]);
      for (const role of ['anon', 'authenticated']) {
        await client.query(`SET LOCAL ROLE ${role}`);
        for (const table of ['future_table', 'api_keys', 'jobs', 'outbox']) {
          const { rows } = await client.query(`SELECT * FROM ${schema}.${table}`);
          expect({ role, table, rows }).toEqual({ role, table, rows: [] });
        }
        await client.query('RESET ROLE');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
