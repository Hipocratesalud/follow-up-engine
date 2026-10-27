import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationChecksumError } from './migrate.ts';
import { InvalidSchemaNameError } from './sql.ts';
import { databaseSuiteTitle, testDatabaseUrl } from './testing.ts';

describe('loadMigrations', () => {
  it('reads the bundled migrations in order with checksums', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual(
      [...migrations.map((migration) => migration.version)].sort(),
    );
    expect(migrations[0]).toMatchObject({ version: '0001', name: 'init' });
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle('migrate'), () => {
  const pools: pg.Pool[] = [];
  const schemas: string[] = [];

  function newPool(): pg.Pool {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    pools.push(pool);
    return pool;
  }

  function newSchema(): string {
    const schema = `follow_up_migrate_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    return schema;
  }

  let pool: pg.Pool;

  beforeAll(() => {
    pool = newPool();
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await Promise.all(pools.map((each) => each.end()));
  });

  it('applies pending migrations once and records them', async () => {
    const schema = newSchema();
    expect(await migrate(pool, { schema })).toEqual({ applied: ['0001'] });
    expect(await migrate(pool, { schema })).toEqual({ applied: [] });
    const { rows } = await pool.query<{ version: string }>(
      `SELECT version FROM "${schema}".schema_migrations`,
    );
    expect(rows).toEqual([{ version: '0001' }]);
  });

  it('serializes concurrent migrations from separate processes', async () => {
    const schema = newSchema();
    const results = await Promise.all(
      [newPool(), newPool(), newPool()].map((each) => migrate(each, { schema })),
    );
    expect(results.map((result) => result.applied).flat()).toEqual(['0001']);
  });

  it('refuses a migration edited after it was applied', async () => {
    const schema = newSchema();
    const migrations = await loadMigrations();
    await migrate(pool, { schema, migrations });
    const edited = migrations.map((migration) => ({ ...migration, checksum: '0'.repeat(64) }));
    await expect(migrate(pool, { schema, migrations: edited })).rejects.toThrow(
      MigrationChecksumError,
    );
  });

  it('rolls back a failing migration entirely', async () => {
    const schema = newSchema();
    const broken = [
      {
        version: '0001',
        name: 'ok',
        sql: 'CREATE TABLE a (clinic_id text NOT NULL)',
        checksum: 'a',
      },
      { version: '0002', name: 'broken', sql: 'CREATE TABLE b (', checksum: 'b' },
    ];
    await expect(migrate(pool, { schema, migrations: broken })).rejects.toThrow();
    const { rows } = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
    expect(rows).toEqual([]);
  });

  it('rejects schema names that are not plain identifiers', async () => {
    await expect(migrate(pool, { schema: 'follow_up"; DROP TABLE x; --' })).rejects.toThrow(
      InvalidSchemaNameError,
    );
  });

  it('gives every table a non-null clinic_id (clinics: its id)', async () => {
    const schema = newSchema();
    await migrate(pool, { schema });
    const { rows } = await pool.query<{ table_name: string; is_nullable: string | null }>(
      `SELECT t.table_name, c.is_nullable
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'clinic_id'
       WHERE t.table_schema = $1 AND t.table_name NOT IN ('schema_migrations', 'clinics')
       ORDER BY t.table_name`,
      [schema],
    );
    expect(rows.length).toBe(12);
    expect(rows.filter((row) => row.is_nullable !== 'NO')).toEqual([]);
  });
});
