import {
  type ClinicId,
  ConflictError,
  type ExpectationEvent,
  type ExpectationEventLog,
  type ExpectationEventType,
  type ExpectationId,
  type PatientId,
  type ReclassificationCause,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { isUniqueViolation, optional, type RepositoryContext } from './sql.ts';

interface EventRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly expectation_id: string;
  readonly type: ExpectationEventType;
  readonly actor: 'engine';
  readonly at: Date;
  readonly from_reason: string;
  readonly to_reason: string;
  readonly cause: ReclassificationCause;
  readonly caused_by_type: string;
  readonly caused_by_id: string;
  readonly related_expectation_id: string | null;
}

const COLUMNS = `clinic_id, id, patient_id, expectation_id, type, actor, at, from_reason,
  to_reason, cause, caused_by_type, caused_by_id, related_expectation_id`;

function toEvent(row: EventRow): ExpectationEvent {
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    expectationId: row.expectation_id as ExpectationId,
    type: row.type,
    actor: row.actor,
    at: row.at,
    fromReason: row.from_reason,
    toReason: row.to_reason,
    cause: row.cause,
    causedBy: { resourceType: row.caused_by_type, id: row.caused_by_id },
    ...optional('relatedExpectationId', row.related_expectation_id as ExpectationId | null),
  };
}

/** Append-only audit of expectations (`expectation_events`). Rows are never updated or deleted. */
export class PostgresExpectationEventLog implements ExpectationEventLog {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async append(clinicId: ClinicId, event: ExpectationEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.expectation_events} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          clinicId,
          event.id,
          event.patientId,
          event.expectationId,
          event.type,
          event.actor,
          event.at,
          event.fromReason,
          event.toReason,
          event.cause,
          event.causedBy.resourceType,
          event.causedBy.id,
          event.relatedExpectationId ?? null,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('ExpectationEvent', event.id) : error;
      });
  }

  async listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly ExpectationEvent[]> {
    const { rows } = await this.#ctx.db().query<EventRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.expectation_events}
       WHERE clinic_id = $1 AND expectation_id = $2 ORDER BY at, seq`,
      [clinicId, expectationId],
    );
    return rows.map(toEvent);
  }

  async listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ExpectationEvent[]> {
    const { rows } = await this.#ctx.db().query<EventRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.expectation_events}
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY at, seq`,
      [clinicId, patientId],
    );
    return rows.map(toEvent);
  }
}
