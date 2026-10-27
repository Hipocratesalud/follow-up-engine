import {
  ConflictError,
  InvalidCursorError,
  NotFoundError,
  TenantMismatchError,
  type CaseCount,
  type CaseFilter,
  type CaseId,
  type CaseListQuery,
  type CasePage,
  type CaseReadOptions,
  type CaseReason,
  type CaseRepository,
  type CaseResolution,
  type CaseStatus,
  type ClinicId,
  type FollowUpCase,
  type Origin,
  type PatientCasePage,
  type PatientCases,
  type PatientId,
  type PatientQueueQuery,
} from '@follow-up-engine/core';
import { reviveDate } from './codec.ts';
import {
  isUniqueViolation,
  jsonParam,
  optional,
  violatedConstraint,
  type RepositoryContext,
} from './sql.ts';

export interface CaseRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly dedup_key: string;
  readonly reasons: readonly CaseReason[];
  readonly status: CaseStatus;
  readonly priority: number;
  readonly assignee: string | null;
  readonly escalation_step: number;
  readonly escalation_policy_id: string | null;
  readonly next_action_at: Date | null;
  readonly snoozed_until: Date | null;
  readonly release_at: Date | null;
  readonly origin: Origin;
  readonly resolution: (Omit<CaseResolution, 'resolvedAt'> & { resolvedAt: string }) | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const CASE_COLUMNS = `clinic_id, id, patient_id, dedup_key, reasons, status, priority, assignee,
  escalation_step, next_action_at, snoozed_until, release_at, origin, resolution, created_at, updated_at,
  escalation_policy_id`;
const PLACEHOLDERS = Array.from({ length: 17 }, (_, index) => `$${String(index + 1)}`).join(', ');
const ACTIVE_DEDUP_INDEX = 'follow_up_cases_active_dedup_key';
const ACTIVE = `status IN ('open', 'notified', 'snoozed', 'escalated')`;

function lockClause(options: CaseReadOptions): string {
  return options.forUpdate === true ? 'FOR UPDATE' : '';
}

export function toCase(row: CaseRow): FollowUpCase {
  return {
    id: row.id as CaseId,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    dedupKey: row.dedup_key,
    reasons: row.reasons,
    status: row.status,
    priority: row.priority,
    ...optional('assignee', row.assignee),
    escalationStep: row.escalation_step,
    ...optional('escalationPolicyId', row.escalation_policy_id),
    ...optional('nextActionAt', row.next_action_at),
    ...optional('snoozedUntil', row.snoozed_until),
    ...optional('releaseAt', row.release_at),
    origin: row.origin,
    ...optional(
      'resolution',
      row.resolution && {
        ...row.resolution,
        resolvedAt: reviveDate(row.resolution.resolvedAt, 'resolution.resolvedAt'),
      },
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toParams(value: FollowUpCase): unknown[] {
  return [
    value.clinicId,
    value.id,
    value.patientId,
    value.dedupKey,
    jsonParam(value.reasons),
    value.status,
    value.priority,
    value.assignee ?? null,
    value.escalationStep,
    value.nextActionAt ?? null,
    value.snoozedUntil ?? null,
    value.releaseAt ?? null,
    value.origin,
    value.resolution === undefined ? null : jsonParam(value.resolution),
    value.createdAt,
    value.updatedAt,
    value.escalationPolicyId ?? null,
  ];
}

/** Raised when a `CaseListQuery.cursor` was not produced by this repository for the same ordering. */
export { InvalidCursorError };

type CaseOrder = NonNullable<CaseListQuery['orderBy']>;
type PatientOrder = `patients_${NonNullable<PatientQueueQuery['orderBy']>}`;

/**
 * Keyset pagination: every ordering is expressed as an ascending tuple of
 * SQL expressions ending in the unique `id`, so "the next page" is a row
 * comparison `(keys) > (cursor)` that an index can serve, stable under
 * concurrent inserts (unlike OFFSET).
 */
interface OrderSpec {
  readonly keys: readonly string[];
  readonly casts: readonly string[];
  readonly cursorOf: (row: CaseRow) => readonly (string | number)[];
}

const ORDERS: Readonly<Record<CaseOrder, OrderSpec>> = {
  priority: {
    keys: ['-priority', 'created_at', 'id'],
    casts: ['integer', 'timestamptz', 'text'],
    cursorOf: (row) => [-row.priority, row.created_at.toISOString(), row.id],
  },
  created_at: {
    keys: ['created_at', 'id'],
    casts: ['timestamptz', 'text'],
    cursorOf: (row) => [row.created_at.toISOString(), row.id],
  },
  next_action_at: {
    keys: [`COALESCE(next_action_at, 'infinity'::timestamptz)`, 'id'],
    casts: ['timestamptz', 'text'],
    cursorOf: (row) => [row.next_action_at?.toISOString() ?? 'infinity', row.id],
  },
};

/**
 * Keyset orders of the patient queue, over the per-patient aggregates of the
 * matching cases (`top_priority`, `first_created_at`). `COLLATE "C"`: the
 * same byte order as the memory adapter.
 */
interface PatientOrderSpec {
  readonly keys: readonly string[];
  /** The same keys, qualified by the `page` CTE. */
  readonly pageKeys: string;
  readonly casts: readonly string[];
  readonly cursorOf: (row: PatientKeyRow) => readonly (string | number)[];
}

interface PatientKeyRow {
  readonly patient_id: string;
  readonly top_priority: number;
  readonly first_created_at: Date;
}

const PATIENT_ORDERS: Readonly<Record<PatientOrder, PatientOrderSpec>> = {
  patients_priority: {
    keys: ['-top_priority', 'first_created_at', 'patient_id COLLATE "C"'],
    pageKeys: '-page.top_priority, page.first_created_at, page.patient_id COLLATE "C"',
    casts: ['integer', 'timestamptz', 'text'],
    cursorOf: (row) => [-row.top_priority, row.first_created_at.toISOString(), row.patient_id],
  },
  patients_created_at: {
    keys: ['first_created_at', 'patient_id COLLATE "C"'],
    pageKeys: 'page.first_created_at, page.patient_id COLLATE "C"',
    casts: ['timestamptz', 'text'],
    cursorOf: (row) => [row.first_created_at.toISOString(), row.patient_id],
  },
};

function orderSpec(order: CaseOrder | PatientOrder): {
  readonly keys: readonly string[];
  readonly casts: readonly string[];
} {
  return order in PATIENT_ORDERS
    ? PATIENT_ORDERS[order as PatientOrder]
    : ORDERS[order as CaseOrder];
}

function encodeCursor(
  order: CaseOrder | PatientOrder,
  values: readonly (string | number)[],
): string {
  return Buffer.from(JSON.stringify([order, ...values])).toString('base64url');
}

/** Whether a decoded cursor value parses as the SQL type it is cast to. */
function fitsCast(value: unknown, cast: string): boolean {
  switch (cast) {
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'timestamptz':
      return (
        typeof value === 'string' &&
        (value === 'infinity' ||
          (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))))
      );
    default:
      return typeof value === 'string' && !value.includes('\u0000');
  }
}

function decodeCursor(
  order: CaseOrder | PatientOrder,
  cursor: string,
): readonly (string | number)[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const spec = orderSpec(order);
  if (
    !Array.isArray(decoded) ||
    decoded[0] !== order ||
    decoded.length !== spec.keys.length + 1 ||
    !decoded.slice(1).every((value, index) => fitsCast(value, spec.casts[index] ?? 'text'))
  ) {
    throw new InvalidCursorError();
  }
  return decoded.slice(1) as (string | number)[];
}

/** `AND ...` conditions of a case filter; values are appended to `params`. */
function filterClause(filter: CaseFilter, params: unknown[]): string {
  const conditions: string[] = [];
  const add = (value: unknown, cast: string, condition: (placeholder: string) => string) => {
    params.push(value);
    conditions.push(condition(`$${String(params.length)}::${cast}`));
  };
  if (filter.statuses !== undefined) {
    add(filter.statuses, 'text[]', (p) => `status = ANY(${p})`);
  }
  if (filter.patientIds !== undefined) {
    add(filter.patientIds, 'text[]', (p) => `patient_id = ANY(${p})`);
  }
  if (filter.assignee !== undefined) {
    add(filter.assignee, 'text', (p) => `assignee = ${p}`);
  }
  if (filter.origin !== undefined) {
    add(filter.origin, 'text', (p) => `origin = ${p}`);
  }
  if (filter.releasedAsOf !== undefined) {
    add(filter.releasedAsOf, 'timestamptz', (p) => `(release_at IS NULL OR release_at <= ${p})`);
  }
  if (filter.unreleasedAsOf !== undefined) {
    add(filter.unreleasedAsOf, 'timestamptz', (p) => `release_at > ${p}`);
  }
  return conditions.map((condition) => `AND ${condition}`).join(' ');
}

/** `AND (keys) > (cursor)` for the next page, or nothing for the first one. */
function keysetClause(
  order: CaseOrder | PatientOrder,
  spec: { readonly keys: readonly string[]; readonly casts: readonly string[] },
  cursor: string | undefined,
  params: unknown[],
): string {
  if (cursor === undefined) {
    return '';
  }
  const placeholders = decodeCursor(order, cursor).map((value, index) => {
    params.push(value);
    return `$${String(params.length)}::${spec.casts[index] ?? 'text'}`;
  });
  return `AND (${spec.keys.join(', ')}) > (${placeholders.join(', ')})`;
}

export class PostgresCaseRepository implements CaseRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async get(
    clinicId: ClinicId,
    id: CaseId,
    options: CaseReadOptions = {},
  ): Promise<FollowUpCase | undefined> {
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases} WHERE clinic_id = $1 AND id = $2
       ${lockClause(options)}`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toCase(row);
  }

  async findActiveByDedupKey(
    clinicId: ClinicId,
    dedupKey: string,
    options: CaseReadOptions = {},
  ): Promise<FollowUpCase | undefined> {
    // With FOR UPDATE, a row changed meanwhile by another transaction is
    // re-checked against the WHERE clause once its lock is released: a case
    // resolved in between is no longer returned.
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1 AND dedup_key = $2 AND ${ACTIVE}
       ${lockClause(options)}`,
      [clinicId, dedupKey],
    );
    const [row] = rows;
    return row === undefined ? undefined : toCase(row);
  }

  async create(clinicId: ClinicId, value: FollowUpCase): Promise<void> {
    if (value.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.follow_up_cases} (${CASE_COLUMNS}) VALUES (${PLACEHOLDERS})`,
        toParams(value),
      )
      .catch((error: unknown) => {
        throw this.#conflict(error, value);
      });
  }

  async update(clinicId: ClinicId, value: FollowUpCase): Promise<void> {
    if (value.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    const result = await this.#ctx
      .db()
      .query(
        `UPDATE ${this.#ctx.tables.follow_up_cases} SET (${CASE_COLUMNS}) = ROW(${PLACEHOLDERS})
         WHERE clinic_id = $1 AND id = $2`,
        toParams(value),
      )
      .catch((error: unknown) => {
        throw this.#conflict(error, value);
      });
    if (result.rowCount !== 1) {
      throw new NotFoundError('FollowUpCase', value.id);
    }
  }

  async setPriority(clinicId: ClinicId, id: CaseId, priority: number): Promise<boolean> {
    const result = await this.#ctx.db().query(
      `UPDATE ${this.#ctx.tables.follow_up_cases} SET priority = $3
       WHERE clinic_id = $1 AND id = $2 AND ${ACTIVE}`,
      [clinicId, id, priority],
    );
    return result.rowCount === 1;
  }

  async list(clinicId: ClinicId, query: CaseListQuery): Promise<CasePage> {
    const order = query.orderBy ?? 'priority';
    const spec = ORDERS[order];
    const params: unknown[] = [clinicId];
    const where = filterClause(
      {
        ...query,
        ...(query.patientId === undefined ? {} : { patientIds: [query.patientId] }),
      },
      params,
    );
    const keyset = keysetClause(order, spec, query.cursor, params);
    params.push(query.limit + 1);
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1 ${where} ${keyset}
       ORDER BY ${spec.keys.join(', ')}
       LIMIT $${String(params.length)}`,
      params,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const items = page.map(toCase);
    return rows.length > query.limit && last !== undefined
      ? { items, nextCursor: encodeCursor(order, spec.cursorOf(last)) }
      : { items };
  }

  async listPatients(clinicId: ClinicId, query: PatientQueueQuery): Promise<PatientCasePage> {
    const order: PatientOrder = `patients_${query.orderBy ?? 'priority'}`;
    const spec = PATIENT_ORDERS[order];
    const params: unknown[] = [clinicId];
    const where = filterClause(query, params);
    const keyset = keysetClause(order, spec, query.cursor, params);
    params.push(query.limit + 1);
    const caseOrder =
      order === 'patients_priority' ? 'm.priority DESC, m.created_at, m.id' : 'm.created_at, m.id';
    // One page of patients (limit + 1 to know whether another page follows),
    // ranked on the aggregates of their matching cases, then those cases.
    const { rows } = await this.#ctx.db().query<CaseRow & PatientKeyRow>(
      `WITH matching AS (
         SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
         WHERE clinic_id = $1 ${where}
       ),
       patients AS (
         SELECT patient_id, max(priority)::integer AS top_priority,
                min(created_at) AS first_created_at
         FROM matching GROUP BY patient_id
       ),
       page AS (
         SELECT * FROM patients WHERE true ${keyset}
         ORDER BY ${spec.keys.join(', ')}
         LIMIT $${String(params.length)}
       )
       SELECT m.*, page.top_priority, page.first_created_at
       FROM page JOIN matching m ON m.patient_id = page.patient_id
       ORDER BY ${spec.pageKeys}, ${caseOrder}`,
      params,
    );
    const patients: { key: PatientKeyRow; cases: FollowUpCase[] }[] = [];
    for (const row of rows) {
      const current = patients.at(-1);
      if (current?.key.patient_id === row.patient_id) {
        current.cases.push(toCase(row));
      } else {
        patients.push({ key: row, cases: [toCase(row)] });
      }
    }
    const page = patients.slice(0, query.limit);
    const items: PatientCases[] = page.map((patient) => ({
      patientId: patient.key.patient_id as PatientId,
      cases: patient.cases,
    }));
    const last = page.at(-1);
    return patients.length > query.limit && last !== undefined
      ? { items, nextCursor: encodeCursor(order, spec.cursorOf(last.key)) }
      : { items };
  }

  async count(clinicId: ClinicId, filter: CaseFilter): Promise<CaseCount> {
    const params: unknown[] = [clinicId];
    const where = filterClause(filter, params);
    const { rows } = await this.#ctx.db().query<{ patients: number; cases: number }>(
      `SELECT count(DISTINCT patient_id)::integer AS patients, count(*)::integer AS cases
       FROM ${this.#ctx.tables.follow_up_cases} WHERE clinic_id = $1 ${where}`,
      params,
    );
    return { patients: rows[0]?.patients ?? 0, cases: rows[0]?.cases ?? 0 };
  }

  async findDueForAction(
    clinicId: ClinicId,
    now: Date,
    limit: number,
  ): Promise<readonly FollowUpCase[]> {
    // The instant that makes a case due: its next action, or the end of its
    // snooze, whichever has passed first. The rows stay locked for the sweep's
    // transaction; one a user is changing right now is left for the next sweep.
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1 AND ${ACTIVE}
         AND (next_action_at <= $2 OR (status = 'snoozed' AND snoozed_until <= $2))
       ORDER BY LEAST(
           CASE WHEN next_action_at <= $2 THEN next_action_at END,
           CASE WHEN status = 'snoozed' AND snoozed_until <= $2 THEN snoozed_until END
         ), id
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [clinicId, now, limit],
    );
    return rows.map(toCase);
  }

  #conflict(error: unknown, value: FollowUpCase): unknown {
    if (!isUniqueViolation(error)) {
      return error;
    }
    return violatedConstraint(error) === ACTIVE_DEDUP_INDEX
      ? new ConflictError('FollowUpCase', value.dedupKey)
      : new ConflictError('FollowUpCase', value.id);
  }
}
