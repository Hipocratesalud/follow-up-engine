import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { DEFAULT_SCHEMA } from './sql.ts';

const RLS_FILE = new URL('../supabase/rls.sql', import.meta.url);

/**
 * Applies the optional Supabase row-level security policies
 * (`supabase/rls.sql`) to the `follow_up` schema (or `schema`), in one
 * transaction. Idempotent. Only for Supabase hosts that expose the schema
 * through the Data API; the engine itself does not need it. Run after
 * {@link migrate}.
 */
export async function applySupabaseRowLevelSecurity(
  pool: Pool,
  options: { readonly schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }
  // The file names the default schema; tests install it into their own.
  const sql = (await readFile(RLS_FILE, 'utf8')).replace(/\bfollow_up\b/g, schema);
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
