import {
  ConflictError,
  NotFoundError,
  TenantMismatchError,
  type CaseId,
  type ClinicId,
  type Evidence,
  type Expectation,
  type ExpectationId,
  type ExpectationLayer,
  type ExpectationRepository,
  type ExpectationStatus,
  type Origin,
  type PatientId,
  type UpsertExpectationResult,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface ExpectationRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly idempotency_key: string;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly layer: ExpectationLayer;
  readonly source_type: string;
  readonly source_id: string;
  readonly match_key: string;
  readonly due_at: Date;
  readonly status: ExpectationStatus;
  readonly case_id: string | null;
  readonly closed_reason: string | null;
  readonly closed_at: Date | null;
  readonly origin: Origin;
  readonly protocol_id: string | null;
  readonly protocol_version: string | null;
  readonly reason_code: string;
  readonly reason_label: string;
  readonly evidence: Evidence | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `clinic_id, id, patient_id, idempotency_key, rule_id, rule_version, layer, source_type,
  source_id, match_key, due_at, status, case_id, closed_reason, closed_at, origin, protocol_id,
  protocol_version, reason_code, reason_label, evidence, created_at, updated_at`;

function toExpectation(row: ExpectationRow): Expectation {
  return {
    id: row.id as ExpectationId,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    idempotencyKey: row.idempotency_key,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    layer: row.layer,
    source: { resourceType: row.source_type, id: row.source_id },
    matchKey: row.match_key,
    dueAt: row.due_at,
    status: row.status,
    ...optional('caseId', row.case_id as CaseId | null),
    ...optional('closedReason', row.closed_reason),
    ...optional('closedAt', row.closed_at),
    origin: row.origin,
    ...optional('protocolId', row.protocol_id),
    ...optional('protocolVersion', row.protocol_version),
    reason: { code: row.reason_code, label: row.reason_label },
    ...optional('evidence', row.evidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Column values in {@link COLUMNS} order. */
function toParams(expectation: Expectation): unknown[] {
  return [
    expectation.clinicId,
    expectation.id,
    expectation.patientId,
    expectation.idempotencyKey,
    expectation.ruleId,
    expectation.ruleVersion,
    expectation.layer,
    expectation.source.resourceType,
    expectation.source.id,
    expectation.matchKey,
    expectation.dueAt,
    expectation.status,
    expectation.caseId ?? null,
    expectation.closedReason ?? null,
    expectation.closedAt ?? null,
    expectation.origin,
    expectation.protocolId ?? null,
    expectation.protocolVersion ?? null,
    expectation.reason.code,
    expectation.reason.label,
    expectation.evidence === undefined ? null : jsonParam(expectation.evidence),
    expectation.createdAt,
    expectation.updatedAt,
  ];
}

const PLACEHOLDERS = Array.from({ length: 23 }, (_, index) => `$${String(index + 1)}`).join(', ');

export class PostgresExpectationRepository implements ExpectationRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async upsertByIdempotencyKey(
    clinicId: ClinicId,
    expectation: Expectation,
  ): Promise<UpsertExpectationResult> {
    if (expectation.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    const table = this.#ctx.tables.expectations;
    const inserted = await this.#ctx
      .db()
      .query<ExpectationRow>(
        `INSERT INTO ${table} (${COLUMNS}) VALUES (${PLACEHOLDERS})
         ON CONFLICT (clinic_id, idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        toParams(expectation),
      )
      .catch((error: unknown) => {
        // Only the primary key can still conflict: same id, different idempotency key.
        throw isUniqueViolation(error) ? new ConflictError('Expectation', expectation.id) : error;
      });
    const [created] = inserted.rows;
    if (created !== undefined) {
      return { expectation: toExpectation(created), created: true };
    }
    const existing = await this.#ctx
      .db()
      .query<ExpectationRow>(
        `SELECT ${COLUMNS} FROM ${table} WHERE clinic_id = $1 AND idempotency_key = $2`,
        [clinicId, expectation.idempotencyKey],
      );
    const [row] = existing.rows;
    if (row === undefined) {
      throw new NotFoundError('Expectation', expectation.idempotencyKey);
    }
    return { expectation: toExpectation(row), created: false };
  }

  async get(clinicId: ClinicId, id: ExpectationId): Promise<Expectation | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<ExpectationRow>(
        `SELECT ${COLUMNS} FROM ${this.#ctx.tables.expectations} WHERE clinic_id = $1 AND id = $2`,
        [clinicId, id],
      );
    const [row] = rows;
    return row === undefined ? undefined : toExpectation(row);
  }

  async findOpenByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly Expectation[]> {
    const { rows } = await this.#ctx.db().query<ExpectationRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.expectations}
       WHERE clinic_id = $1 AND patient_id = $2 AND status = 'open'
       ORDER BY due_at, id`,
      [clinicId, patientId],
    );
    return rows.map(toExpectation);
  }

  async findDue(clinicId: ClinicId, now: Date, limit: number): Promise<readonly Expectation[]> {
    const { rows } = await this.#ctx.db().query<ExpectationRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.expectations}
       WHERE clinic_id = $1 AND status = 'open' AND due_at <= $2
       ORDER BY due_at, id
       LIMIT $3`,
      [clinicId, now, limit],
    );
    return rows.map(toExpectation);
  }

  async update(clinicId: ClinicId, expectation: Expectation): Promise<void> {
    if (expectation.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    const result = await this.#ctx
      .db()
      .query(
        `UPDATE ${this.#ctx.tables.expectations} SET (${COLUMNS}) = ROW(${PLACEHOLDERS})
         WHERE clinic_id = $1 AND id = $2`,
        toParams(expectation),
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error)
          ? new ConflictError('Expectation', expectation.idempotencyKey)
          : error;
      });
    if (result.rowCount !== 1) {
      throw new NotFoundError('Expectation', expectation.id);
    }
  }
}
