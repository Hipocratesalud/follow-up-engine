import { randomUUID } from 'node:crypto';
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

const OWN_CLINIC = 'clinic-rls-own';
const OTHER_CLINIC = 'clinic-rls-other';

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly category: string;
  readonly required: boolean;
  readonly enumLabel: string | null;
}

/** A value of the column's type, unique per row where it matters. */
function syntheticValue(column: ColumnInfo, clinic: string, row: number): unknown {
  switch (column.category) {
    case 'N':
      return row;
    case 'B':
      return false;
    case 'D':
      return '2026-01-05T00:00:00Z';
    case 'T':
      return '1 day';
    case 'A':
      return '{}';
    case 'E':
      return column.enumLabel;
    default:
      if (column.type === 'uuid') {
        return randomUUID();
      }
      if (column.type === 'jsonb' || column.type === 'json') {
        return '{}';
      }
      if (column.type === 'bytea') {
        return Buffer.from([row]);
      }
      return `${clinic}-${column.name}-${String(row)}`;
  }
}

/**
 * Behavior, not policy text: inside a rolled-back transaction, one synthetic
 * row per clinic goes into every table of the schema (foreign keys and
 * CHECK constraints suspended for the probe), anon and authenticated get
 * broad grants (the worst case), and each table is read as `authenticated`
 * with a JWT for the other clinic and as `anon`. A leak is any row of
 * another clinic (or any row at all of a table without `clinic_id`) that
 * the read returns. `extraSql` runs before the reads (to plant a bad policy).
 */
async function probeCrossClinicReads(
  pool: pg.Pool,
  schema: string,
  extraSql: readonly string[] = [],
): Promise<{ leaks: string[]; readable: string[]; unseeded: string[] }> {
  const client = await pool.connect();
  const quoted = `"${schema}"`;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
      [schema],
    );
    const clinicColumn = new Map<string, string | undefined>();
    const unseeded: string[] = [];
    for (const { name: table } of tables) {
      const { rows: checks } = await client.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'c'`,
        [`${quoted}."${table}"`],
      );
      for (const { conname } of checks) {
        await client.query(`ALTER TABLE ${quoted}."${table}" DROP CONSTRAINT "${conname}"`);
      }
      const { rows: columns } = await client.query<ColumnInfo>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                t.typcategory AS category,
                (a.attnotnull AND NOT a.atthasdef AND a.attidentity = '' AND a.attgenerated = '')
                  AS required,
                (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = a.atttypid
                 ORDER BY e.enumsortorder LIMIT 1) AS "enumLabel"
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        [`${quoted}."${table}"`],
      );
      const owner = columns.some((column) => column.name === 'clinic_id')
        ? 'clinic_id'
        : table === 'clinics'
          ? 'id'
          : undefined;
      clinicColumn.set(table, owner);
      for (const [row, clinic] of [OWN_CLINIC, OTHER_CLINIC].entries()) {
        const filled = columns.filter((column) => column.required || column.name === owner);
        const values = filled.map((column) =>
          column.name === owner ? clinic : syntheticValue(column, clinic, row + 1),
        );
        try {
          await client.query('SAVEPOINT seed');
          await client.query(
            `INSERT INTO ${quoted}."${table}" (${filled.map((c) => `"${c.name}"`).join(', ')})
             VALUES (${filled.map((c, i) => `$${String(i + 1)}::${c.type}`).join(', ')})`,
            values,
          );
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT seed');
          unseeded.push(table);
        }
      }
    }
    await client.query(`GRANT USAGE ON SCHEMA ${quoted} TO anon, authenticated`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoted} TO anon, authenticated`);
    for (const sql of extraSql) {
      await client.query(sql);
    }
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ clinic_id: OTHER_CLINIC, role: 'authenticated' }),
    ]);
    const leaks = new Set<string>();
    const readable: string[] = [];
    for (const role of ['authenticated', 'anon']) {
      await client.query(`SET LOCAL ROLE ${role}`);
      for (const { name: table } of tables) {
        const owner = clinicColumn.get(table);
        const foreign =
          owner === undefined || role === 'anon' ? 'true' : `"${owner}" IS DISTINCT FROM $1`;
        await client.query('SAVEPOINT probe');
        try {
          const { rows } = await client.query<{ foreign: string; total: string }>(
            `SELECT count(*) FILTER (WHERE ${foreign}) AS foreign, count(*) AS total
             FROM ${quoted}."${table}"`,
            owner === undefined || role === 'anon' ? [] : [OTHER_CLINIC],
          );
          if (Number(rows[0]?.foreign ?? 0) > 0) {
            leaks.add(table);
          }
          if (role === 'authenticated' && Number(rows[0]?.total ?? 0) > 0) {
            readable.push(table);
          }
        } catch {
          // Permission denied: nothing readable, nothing leaked.
          await client.query('ROLLBACK TO SAVEPOINT probe');
        }
      }
      await client.query('RESET ROLE');
    }
    return { leaks: [...leaks].sort(), readable, unseeded: [...new Set(unseeded)] };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Row-level security can never be forgotten: every table of the engine
 * schema has RLS right after `migrate()` (a later migration that adds a
 * table without it fails here, in CI), and after `supabase/rls.sql` every
 * policy is a read for `authenticated` and, read by read, no clinic sees a
 * row of another clinic in any table. Runs on plain
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

  it('denies every cross-clinic read, table by table, with an emulated clinic JWT', async () => {
    await applySupabaseRowLevelSecurity(pool, { schema: database.schema });
    const result = await probeCrossClinicReads(pool, database.schema);
    expect(result.leaks).toEqual([]);
    expect(result.unseeded).toEqual([]);
    // Not vacuous: every table with a policy showed the clinic its own synthetic row.
    const { rows } = await pool.query<{ table: string }>(
      `SELECT DISTINCT tablename AS table FROM pg_policies WHERE schemaname = $1 ORDER BY 1`,
      [database.schema],
    );
    expect(rows.map((row) => row.table)).toContain('follow_up_cases');
    expect(result.readable).toEqual(rows.map((row) => row.table));
  });

  it('the cross-clinic probe catches a policy that mentions clinic_id but leaks', async () => {
    await applySupabaseRowLevelSecurity(pool, { schema: database.schema });
    const result = await probeCrossClinicReads(pool, database.schema, [
      `CREATE POLICY leaky ON "${database.schema}".follow_up_cases
         FOR SELECT TO authenticated USING (clinic_id IS NOT NULL)`,
    ]);
    expect(result.leaks).toEqual(['follow_up_cases']);
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
