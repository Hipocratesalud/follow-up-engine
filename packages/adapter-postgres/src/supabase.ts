import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const RLS_FILE = new URL('../supabase/rls.sql', import.meta.url);

/**
 * Applies the optional Supabase row-level security policies
 * (`supabase/rls.sql`) to the default `follow_up` schema, in one
 * transaction. Idempotent. Only for Supabase hosts that expose the schema
 * through the Data API; the engine itself does not need it. Run after
 * {@link migrate}.
 */
export async function applySupabaseRowLevelSecurity(pool: Pool): Promise<void> {
  const sql = await readFile(RLS_FILE, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
