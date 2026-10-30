import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { DEFAULT_SCHEMA, quoteSchema } from './sql.ts';

/** One SQL migration file, `NNNN_name.sql`. */
export interface Migration {
  /** The zero-padded number, for example `0001`. */
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  /** sha256 of the file, so an edited applied migration is detected. */
  readonly checksum: string;
}

export interface MigrateOptions {
  /** Schema to install into. Default `follow_up`. */
  readonly schema?: string;
  /** Override the bundled migrations (tests). */
  readonly migrations?: readonly Migration[];
}

export interface MigrateResult {
  /** Versions applied by this call, in order. Empty when the schema was up to date. */
  readonly applied: readonly string[];
}

/** An applied migration no longer matches its file. Migrations are immutable once applied. */
export class MigrationChecksumError extends Error {
  override readonly name = 'MigrationChecksumError';

  constructor(version: string) {
    super(`Migration ${version} was modified after it was applied; add a new migration instead`);
  }
}

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads the bundled `migrations/NNNN_name.sql` files, ordered by version. */
export async function loadMigrations(directory: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => FILE_PATTERN.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const [, version = '', name = ''] = FILE_PATTERN.exec(file) ?? [];
      const sql = await readFile(new URL(file, directory), 'utf8');
      return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  ).then(assertUniqueVersions);
}

/** Two files with one version would apply in either order and break every later deploy. */
export class DuplicateMigrationVersionError extends Error {
  override readonly name = 'DuplicateMigrationVersionError';

  constructor(version: string, names: readonly string[]) {
    super(
      `Migration version ${version} is used by ${names.join(', ')}; give each file its own number`,
    );
  }
}

function assertUniqueVersions(migrations: Migration[]): Migration[] {
  const byVersion = new Map<string, string[]>();
  for (const migration of migrations) {
    byVersion.set(migration.version, [...(byVersion.get(migration.version) ?? []), migration.name]);
  }
  for (const [version, names] of byVersion) {
    if (names.length > 1) throw new DuplicateMigrationVersionError(version, names);
  }
  return migrations;
}

/**
 * Brings the engine schema up to date.
 *
 * Runs every pending migration in one transaction, under a transaction-level
 * advisory lock keyed on the schema, so two processes starting together
 * never migrate concurrently: the second waits, then finds nothing to do.
 * Applied versions are tracked in `<schema>.schema_migrations`. Each file
 * runs with `search_path` set to the schema, so it uses unqualified names.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const quoted = quoteSchema(schema);
  const migrations = options.migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `follow_up_engine:migrate:${schema}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quoted}.schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM ${quoted}.schema_migrations`,
    );
    const appliedChecksums = new Map(rows.map((row) => [row.version, row.checksum]));
    const applied: string[] = [];
    for (const migration of migrations) {
      const checksum = appliedChecksums.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new MigrationChecksumError(migration.version);
        }
        continue;
      }
      await client.query(`SET LOCAL search_path TO ${quoted}, pg_catalog`);
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${quoted}.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    return { applied };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
