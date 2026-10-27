import type { Clock } from '@follow-up-engine/core';
import type { QueryResult, QueryResultRow } from 'pg';

/** Anything that runs a parameterized query: a `pg.Pool` or a checked-out `pg.PoolClient`. */
export interface Queryable {
  query<TRow extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TRow>>;
}

/** Default schema every engine table lives in, so it can sit next to a host's tables. */
export const DEFAULT_SCHEMA = 'follow_up';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Raised when a schema name is not a plain lowercase SQL identifier. */
export class InvalidSchemaNameError extends Error {
  override readonly name = 'InvalidSchemaNameError';

  constructor(schema: string) {
    super(`Invalid schema name ${JSON.stringify(schema)}: expected ${String(SCHEMA_PATTERN)}`);
  }
}

/**
 * Validates and quotes a schema name. Schema names are interpolated into SQL
 * (identifiers cannot be bound as parameters), so only plain lowercase
 * identifiers are accepted.
 */
export function quoteSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new InvalidSchemaNameError(schema);
  }
  return `"${schema}"`;
}

const TABLES = [
  'clinics',
  'clinical_resources',
  'clinical_events',
  'patient_conditions',
  'expectations',
  'follow_up_cases',
  'case_events',
  'case_feedback',
  'quality_findings',
  'llm_calls',
  'outbox',
  'jobs',
  'backfill_progress',
  'contact_requests',
  'contact_communications',
  'patient_contact_flags',
  'patient_rule_suppressions',
  'clinical_findings',
  'clinical_review_runs',
  'finding_flags',
  'plan_item_reviews',
] as const;

export type TableName = (typeof TABLES)[number];

/** Schema-qualified, quoted table names, ready to interpolate into SQL. */
export type Tables = Readonly<Record<TableName, string>>;

export function tablesFor(schema: string): Tables {
  const quoted = quoteSchema(schema);
  return Object.fromEntries(TABLES.map((table) => [table, `${quoted}."${table}"`])) as Record<
    TableName,
    string
  >;
}

/**
 * What every repository needs: where to run queries, the qualified table
 * names, and the clock for timestamps the port does not pass in.
 *
 * `db()` is resolved on every query so that a repository built on the pool
 * joins the ambient {@link PostgresUnitOfWork} transaction, if any.
 */
export interface RepositoryContext {
  readonly db: () => Queryable;
  readonly tables: Tables;
  readonly clock: Clock;
}

/** Serializes a value for a `jsonb` parameter. (node-postgres would turn JS arrays into SQL arrays.) */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

/** Postgres SQLSTATE of a driver error, if it is one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Name of the violated constraint or index, if the driver reported one. */
export function violatedConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const { constraint } = error;
    return typeof constraint === 'string' ? constraint : undefined;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === UNIQUE_VIOLATION;
}

/** Returns `{ [key]: value }` when `value` is not null, `{}` otherwise (for `exactOptionalPropertyTypes`). */
export function optional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | null | undefined,
): Partial<Readonly<Record<TKey, TValue>>> {
  return (value === null || value === undefined ? {} : { [key]: value }) as Partial<
    Readonly<Record<TKey, TValue>>
  >;
}
