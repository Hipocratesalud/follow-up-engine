import { FakeClock } from '@follow-up-engine/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapters, type PostgresAdapters } from './adapters.ts';
import { hashApiKey } from './clinic-directory.ts';
import { migrate } from './migrate.ts';
import { applySupabaseRowLevelSecurity } from './supabase.ts';
import { BASE, makeCase, newClinic } from './test-fixtures.ts';

/**
 * Runs only against a local Supabase stack (`supabase start`), never a
 * remote project: set SUPABASE_DATABASE_URL to its local Postgres, for
 * example postgresql://postgres:postgres@127.0.0.1:54322/postgres. It
 * installs the default `follow_up` schema, applies `supabase/rls.sql`, checks
 * what the Data API roles can see, and drops the schema afterwards.
 */
const supabaseUrl = process.env['SUPABASE_DATABASE_URL'];
const title =
  supabaseUrl === undefined || supabaseUrl === ''
    ? 'Supabase row-level security [skipped: SUPABASE_DATABASE_URL is not set; see docs/deploy.md]'
    : 'Supabase row-level security';

describe.skipIf(supabaseUrl === undefined || supabaseUrl === '')(title, () => {
  let pool: pg.Pool;
  let engine: PostgresAdapters;
  const [clinicA, clinicB] = [newClinic('a'), newClinic('b')];

  beforeAll(async () => {
    // This suite drops the `follow_up` schema: refuse anything but a local stack.
    if (!/@(127\.0\.0\.1|localhost)[:/]/.test(supabaseUrl ?? '')) {
      throw new Error('SUPABASE_DATABASE_URL must point at a local Supabase stack');
    }
    pool = new pg.Pool({ connectionString: supabaseUrl, max: 3 });

    await pool.query('DROP SCHEMA IF EXISTS follow_up CASCADE');
    await migrate(pool);
    await applySupabaseRowLevelSecurity(pool);
    await applySupabaseRowLevelSecurity(pool); // idempotent
    engine = createPostgresAdapters(pool, { clock: new FakeClock(BASE) });

    // The engine role writes freely: it owns the tables.
    await engine.clinics.register({ id: clinicA, name: 'A', apiKeyHash: hashApiKey('key-a') });
    await engine.clinics.register({ id: clinicB, name: 'B' });
    await engine.cases.create(clinicA, makeCase(clinicA, { dedupKey: 'a' }));
    await engine.cases.create(clinicB, makeCase(clinicB, { dedupKey: 'b' }));
    await engine.jobs.enqueue(clinicA, { type: 'note.extract_plan', payload: {} });
  });

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS follow_up CASCADE');
    await pool.end();
  });

  /** Runs `sql` the way PostgREST does for a request: as `role`, with the JWT claims set. */
  async function asApiRole<TRow extends pg.QueryResultRow>(
    role: 'authenticated' | 'anon',
    claims: Record<string, string>,
    sql: string,
  ): Promise<TRow[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role, ...claims }),
      ]);
      const { rows } = await client.query<TRow>(sql);
      return rows;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('shows a clinic user only the rows of the clinic in their JWT', async () => {
    const rows = await asApiRole<{ clinic_id: string }>(
      'authenticated',
      { clinic_id: clinicA },
      'SELECT clinic_id FROM follow_up.follow_up_cases',
    );
    expect(rows).toEqual([{ clinic_id: clinicA }]);
    const none = await asApiRole('authenticated', {}, 'SELECT * FROM follow_up.follow_up_cases');
    expect(none).toEqual([]);
  });

  it('exposes the clinic row without its API key hash', async () => {
    const rows = await asApiRole<{ id: string }>(
      'authenticated',
      { clinic_id: clinicA },
      'SELECT id, name FROM follow_up.clinics',
    );
    expect(rows).toEqual([{ id: clinicA, name: 'A' }]);
    await expect(
      asApiRole(
        'authenticated',
        { clinic_id: clinicA },
        'SELECT api_key_hash FROM follow_up.clinics',
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('hides internal tables and denies writes and anonymous access', async () => {
    await expect(
      asApiRole('authenticated', { clinic_id: clinicA }, 'SELECT * FROM follow_up.jobs'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApiRole(
        'authenticated',
        { clinic_id: clinicA },
        `UPDATE follow_up.follow_up_cases SET priority = 99`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asApiRole('anon', {}, 'SELECT * FROM follow_up.follow_up_cases')).rejects.toThrow(
      /permission denied/,
    );
  });
});
