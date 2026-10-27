import {
  type ClinicId,
  ConflictError,
  type RuleOverride,
  type RuleOverrideAction,
  type RuleOverrideChange,
  type RuleOverrideRecord,
  type RuleOverrideStore,
  type RuleOverrideWrite,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface OverrideRow {
  readonly clinic_id: string;
  readonly rule_id: string;
  readonly due_in_days: number | null;
  readonly enabled: boolean | null;
  readonly version: number;
  readonly updated_at: Date;
  readonly updated_by: string;
  readonly reason: string;
}

interface ChangeRow {
  readonly clinic_id: string;
  readonly rule_id: string;
  readonly version: number;
  readonly action: RuleOverrideAction;
  readonly previous: RuleOverride | null;
  readonly next: RuleOverride | null;
  readonly actor: string;
  readonly reason: string;
  readonly at: Date;
}

function overrideOf(row: Pick<OverrideRow, 'due_in_days' | 'enabled'>): RuleOverride {
  return { ...optional('dueInDays', row.due_in_days), ...optional('enabled', row.enabled) };
}

/** A stored `{ dueInDays?, enabled? }` object, with only the known fields kept. */
function storedOverride(value: RuleOverride | null): RuleOverride | undefined {
  return value === null
    ? undefined
    : { ...optional('dueInDays', value.dueInDays), ...optional('enabled', value.enabled) };
}

function toRecord(row: OverrideRow): RuleOverrideRecord {
  return {
    clinicId: row.clinic_id as ClinicId,
    ruleId: row.rule_id,
    override: overrideOf(row),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
  };
}

function toChange(row: ChangeRow): RuleOverrideChange {
  const previous = storedOverride(row.previous);
  const next = storedOverride(row.next);
  return {
    clinicId: row.clinic_id as ClinicId,
    ruleId: row.rule_id,
    version: row.version,
    action: row.action,
    ...(previous === undefined ? {} : { previous }),
    ...(next === undefined ? {} : { next }),
    actor: row.actor,
    reason: row.reason,
    at: row.at,
  };
}

const CHANGE_COLUMNS = 'clinic_id, rule_id, version, action, previous, next, actor, reason, at';

/**
 * Per-clinic rule overrides (`rule_overrides`) and their append-only history
 * (`rule_override_history`). A write is one statement: the history row, the
 * override upserted or deleted, and the version check all commit together,
 * inside a unit of work or not.
 */
export class PostgresRuleOverrideStore implements RuleOverrideStore {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async list(clinicId: ClinicId): Promise<readonly RuleOverrideRecord[]> {
    const { rows } = await this.#ctx
      .db()
      .query<OverrideRow>(
        `SELECT * FROM ${this.#ctx.tables.rule_overrides} WHERE clinic_id = $1 ORDER BY rule_id`,
        [clinicId],
      );
    return rows.map(toRecord);
  }

  async get(clinicId: ClinicId, ruleId: string): Promise<RuleOverrideRecord | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<OverrideRow>(
        `SELECT * FROM ${this.#ctx.tables.rule_overrides} WHERE clinic_id = $1 AND rule_id = $2`,
        [clinicId, ruleId],
      );
    const [row] = rows;
    return row === undefined ? undefined : toRecord(row);
  }

  async write(clinicId: ClinicId, change: RuleOverrideWrite): Promise<RuleOverrideChange> {
    const { overrides, history } = {
      overrides: this.#ctx.tables.rule_overrides,
      history: this.#ctx.tables.rule_override_history,
    };
    const action: RuleOverrideAction = change.override === undefined ? 'reset' : 'set';
    const { rows } = await this.#ctx
      .db()
      .query<ChangeRow>(
        `WITH latest AS (
           SELECT COALESCE(max(version), 0) AS version FROM ${history}
           WHERE clinic_id = $1 AND rule_id = $2
         ), current AS (
           SELECT jsonb_strip_nulls(jsonb_build_object('dueInDays', due_in_days, 'enabled', enabled))
             AS override
           FROM ${overrides} WHERE clinic_id = $1 AND rule_id = $2
         ), recorded AS (
           INSERT INTO ${history} (clinic_id, rule_id, version, action, previous, next, actor, reason, at)
           SELECT $1, $2, latest.version + 1, $3, (SELECT override FROM current), $4::jsonb, $5, $6, $7
           FROM latest
           WHERE $8::integer IS NULL OR latest.version = $8
           RETURNING ${CHANGE_COLUMNS}
         ), upserted AS (
           INSERT INTO ${overrides} AS o
             (clinic_id, rule_id, due_in_days, enabled, version, updated_at, updated_by, reason)
           SELECT $1, $2, ($4::jsonb ->> 'dueInDays')::integer, ($4::jsonb ->> 'enabled')::boolean,
                  recorded.version, $7, $5, $6
           FROM recorded WHERE $3 = 'set'
           ON CONFLICT (clinic_id, rule_id) DO UPDATE SET
             due_in_days = EXCLUDED.due_in_days, enabled = EXCLUDED.enabled,
             version = EXCLUDED.version, updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason
         ), removed AS (
           DELETE FROM ${overrides}
           WHERE clinic_id = $1 AND rule_id = $2 AND $3 = 'reset' AND EXISTS (SELECT 1 FROM recorded)
         )
         SELECT ${CHANGE_COLUMNS} FROM recorded`,
        [
          clinicId,
          change.ruleId,
          action,
          change.override === undefined ? null : jsonParam(change.override),
          change.actor,
          change.reason,
          change.at,
          change.expectedVersion ?? null,
        ],
      )
      .catch((error: unknown) => {
        // A concurrent change took the same version first.
        throw isUniqueViolation(error) ? new ConflictError('RuleOverride', change.ruleId) : error;
      });
    const [row] = rows;
    if (row === undefined) {
      throw new ConflictError(
        'RuleOverride',
        `${change.ruleId}@${String(change.expectedVersion ?? '')}`,
      );
    }
    return toChange(row);
  }

  async history(
    clinicId: ClinicId,
    query: { readonly ruleId?: string; readonly limit?: number } = {},
  ): Promise<readonly RuleOverrideChange[]> {
    const { rows } = await this.#ctx.db().query<ChangeRow>(
      `SELECT ${CHANGE_COLUMNS} FROM ${this.#ctx.tables.rule_override_history}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR rule_id = $2)
       ORDER BY seq DESC
       LIMIT $3`,
      [clinicId, query.ruleId ?? null, query.limit ?? null],
    );
    return rows.map(toChange);
  }

  async revision(clinicId: ClinicId): Promise<number> {
    const { rows } = await this.#ctx
      .db()
      .query<{ revision: string }>(
        `SELECT count(*) AS revision FROM ${this.#ctx.tables.rule_override_history} WHERE clinic_id = $1`,
        [clinicId],
      );
    return Number(rows[0]?.revision ?? 0);
  }
}
