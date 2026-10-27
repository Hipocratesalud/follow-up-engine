import {
  type ClinicId,
  ConflictError,
  type ExpectationId,
  type PatientId,
  type PlanItemReview,
  type PlanItemReviewLog,
  TenantMismatchError,
} from '@follow-up-engine/core';
import type { MemoryDatabase } from '../memory-database.ts';

/** In-memory {@link PlanItemReviewLog}: append-only, in append order. */
export class MemoryPlanItemReviewLog implements PlanItemReviewLog {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  append(clinicId: ClinicId, review: PlanItemReview): Promise<void> {
    if (review.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    if (this.#all(clinicId).some((item) => item.id === review.id)) {
      return Promise.reject(new ConflictError('PlanItemReview', review.id));
    }
    this.#db.pushTo(this.#db.state.planItemReviews, review);
    return Promise.resolve();
  }

  listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly PlanItemReview[]> {
    return Promise.resolve(
      this.#all(clinicId).filter((item) => item.expectationId === expectationId),
    );
  }

  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly PlanItemReview[]> {
    return Promise.resolve(this.#all(clinicId).filter((item) => item.patientId === patientId));
  }

  listSince(clinicId: ClinicId, since: Date, limit: number): Promise<readonly PlanItemReview[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter((item) => item.at.getTime() >= since.getTime())
        .slice(0, limit),
    );
  }

  /** The clinic's reviews by time; the stable sort keeps append order on the same instant (like `seq`). */
  #all(clinicId: ClinicId): PlanItemReview[] {
    return this.#db.state.planItemReviews
      .filter((item) => item.clinicId === clinicId)
      .sort((left, right) => left.at.getTime() - right.at.getTime());
  }
}
