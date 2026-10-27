import {
  ConflictError,
  NotFoundError,
  TenantMismatchError,
  type CaseId,
  type CaseListQuery,
  type CasePage,
  type CaseReason,
  type CaseRepository,
  type CaseResolution,
  type CaseStatus,
  type ClinicId,
  type FollowUpCase,
  type Origin,
  type PatientId,
} from '@follow-up-engine/core';
import { reviveDate } from './codec.ts';
import {
  isUniqueViolation,
  jsonParam,
  optional,
  violatedConstraint,
  type RepositoryContext,
} from './sql.ts';

interface CaseRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly dedup_key: string;
  readonly reasons: readonly CaseReason[];
  readonly status: CaseStatus;
  readonly priority: number;
  readonly assignee: string | null;
  readonly escalation_step: number;
  readonly next_action_at: Date | null;
  readonly snoozed_until: Date | null;
  readonly release_at: Date | null;
  readonly origin: Origin;
  readonly resolution: (Omit<CaseResolution, 'resolvedAt'> & { resolvedAt: string }) | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `clinic_id, id, patient_id, dedup_key, reasons, status, priority, assignee,
  escalation_step, next_action_at, snoozed_until, release_at, origin, resolution, created_at, updated_at`;
const PLACEHOLDERS = Array.from({ length: 16 }, (_, index) => `$${String(index + 1)}`).join(', ');
const ACTIVE_DEDUP_INDEX = 'follow_up_cases_active_dedup_key';
const ACTIVE = `status IN ('open', 'notified', 'snoozed', 'escalated')`;

function toCase(row: CaseRow): FollowUpCase {
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
  ];
}

/** Raised when a `CaseListQuery.cursor` was not produced by this repository for the same ordering. */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';

  constructor() {
    super('Invalid case list cursor');
  }
}

type CaseOrder = NonNullable<CaseListQuery['orderBy']>;

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

function encodeCursor(order: CaseOrder, values: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify([order, ...values])).toString('base64url');
}

function decodeCursor(order: CaseOrder, cursor: string): readonly (string | number)[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const spec = ORDERS[order];
  if (
    !Array.isArray(decoded) ||
    decoded[0] !== order ||
    decoded.length !== spec.keys.length + 1 ||
    !decoded.every((value) => typeof value === 'string' || typeof value === 'number')
  ) {
    throw new InvalidCursorError();
  }
  return decoded.slice(1);
}

export class PostgresCaseRepository implements CaseRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async get(clinicId: ClinicId, id: CaseId): Promise<FollowUpCase | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<CaseRow>(
        `SELECT ${COLUMNS} FROM ${this.#ctx.tables.follow_up_cases} WHERE clinic_id = $1 AND id = $2`,
        [clinicId, id],
      );
    const [row] = rows;
    return row === undefined ? undefined : toCase(row);
  }

  async findActiveByDedupKey(
    clinicId: ClinicId,
    dedupKey: string,
  ): Promise<FollowUpCase | undefined> {
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1 AND dedup_key = $2 AND ${ACTIVE}`,
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
        `INSERT INTO ${this.#ctx.tables.follow_up_cases} (${COLUMNS}) VALUES (${PLACEHOLDERS})`,
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
        `UPDATE ${this.#ctx.tables.follow_up_cases} SET (${COLUMNS}) = ROW(${PLACEHOLDERS})
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

  async list(clinicId: ClinicId, query: CaseListQuery): Promise<CasePage> {
    const order = query.orderBy ?? 'priority';
    const spec = ORDERS[order];
    const params: unknown[] = [
      clinicId,
      query.statuses ?? null,
      query.patientId ?? null,
      query.assignee ?? null,
      query.origin ?? null,
      query.releasedAsOf ?? null,
    ];
    let keyset = '';
    if (query.cursor !== undefined) {
      const values = decodeCursor(order, query.cursor);
      const placeholders = values.map((value, index) => {
        params.push(value);
        return `$${String(params.length)}::${spec.casts[index] ?? 'text'}`;
      });
      keyset = `AND (${spec.keys.join(', ')}) > (${placeholders.join(', ')})`;
    }
    params.push(query.limit + 1);
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
         AND ($3::text IS NULL OR patient_id = $3)
         AND ($4::text IS NULL OR assignee = $4)
         AND ($5::text IS NULL OR origin = $5)
         AND ($6::timestamptz IS NULL OR release_at IS NULL OR release_at <= $6)
         ${keyset}
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

  async findDueForAction(
    clinicId: ClinicId,
    now: Date,
    limit: number,
  ): Promise<readonly FollowUpCase[]> {
    // The instant that makes a case due: its next action, or the end of its
    // snooze, whichever has passed first.
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${COLUMNS} FROM (
         SELECT *, LEAST(
           CASE WHEN next_action_at <= $2 THEN next_action_at END,
           CASE WHEN status = 'snoozed' AND snoozed_until <= $2 THEN snoozed_until END
         ) AS due_at
         FROM ${this.#ctx.tables.follow_up_cases}
         WHERE clinic_id = $1 AND ${ACTIVE}
           AND (next_action_at <= $2 OR (status = 'snoozed' AND snoozed_until <= $2))
       ) due
       ORDER BY due_at, id
       LIMIT $3`,
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
