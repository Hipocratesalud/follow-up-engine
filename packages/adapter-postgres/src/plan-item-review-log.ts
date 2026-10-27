import {
  type CaseId,
  type ClinicId,
  ConflictError,
  type ExpectationId,
  type PatientId,
  type PlanItemKind,
  type PlanItemReview,
  type PlanItemReviewLog,
  type PlanItemReviewType,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { isUniqueViolation, optional, type RepositoryContext } from './sql.ts';

interface ReviewRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly expectation_id: string;
  readonly type: PlanItemReviewType;
  readonly user_id: string;
  readonly at: Date;
  readonly case_id: string | null;
  readonly before_kind: PlanItemKind;
  readonly before_due_at: Date;
  readonly after_kind: PlanItemKind | null;
  readonly after_due_at: Date | null;
  readonly replacement_id: string | null;
}

const COLUMNS = `clinic_id, id, patient_id, expectation_id, type, user_id, at, case_id,
  before_kind, before_due_at, after_kind, after_due_at, replacement_id`;

function toReview(row: ReviewRow): PlanItemReview {
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    expectationId: row.expectation_id as ExpectationId,
    type: row.type,
    userId: row.user_id,
    at: row.at,
    ...optional('caseId', row.case_id as CaseId | null),
    before: { kind: row.before_kind, dueAt: row.before_due_at },
    ...(row.after_kind === null || row.after_due_at === null
      ? {}
      : { after: { kind: row.after_kind, dueAt: row.after_due_at } }),
    ...optional('replacementId', row.replacement_id as ExpectationId | null),
  };
}

/** Append-only audit of plan item reviews (`plan_item_reviews`). Rows are never updated or deleted. */
export class PostgresPlanItemReviewLog implements PlanItemReviewLog {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async append(clinicId: ClinicId, review: PlanItemReview): Promise<void> {
    if (review.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.plan_item_reviews} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          clinicId,
          review.id,
          review.patientId,
          review.expectationId,
          review.type,
          review.userId,
          review.at,
          review.caseId ?? null,
          review.before.kind,
          review.before.dueAt,
          review.after?.kind ?? null,
          review.after?.dueAt ?? null,
          review.replacementId ?? null,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('PlanItemReview', review.id) : error;
      });
  }

  async listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly PlanItemReview[]> {
    const { rows } = await this.#ctx.db().query<ReviewRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.plan_item_reviews}
       WHERE clinic_id = $1 AND expectation_id = $2 ORDER BY at, seq`,
      [clinicId, expectationId],
    );
    return rows.map(toReview);
  }

  async listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly PlanItemReview[]> {
    const { rows } = await this.#ctx.db().query<ReviewRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.plan_item_reviews}
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY at, seq`,
      [clinicId, patientId],
    );
    return rows.map(toReview);
  }

  async listSince(
    clinicId: ClinicId,
    since: Date,
    limit: number,
  ): Promise<readonly PlanItemReview[]> {
    const { rows } = await this.#ctx.db().query<ReviewRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.plan_item_reviews}
       WHERE clinic_id = $1 AND at >= $2 ORDER BY at, seq LIMIT $3`,
      [clinicId, since, limit],
    );
    return rows.map(toReview);
  }
}
