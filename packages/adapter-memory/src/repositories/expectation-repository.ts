import {
  type ClinicId,
  type Expectation,
  type ExpectationId,
  type ExpectationRepository,
  type ExpectationStatus,
  NotFoundError,
  type PatientId,
  TenantMismatchError,
  type UpsertExpectationResult,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

function byDueAt(left: Expectation, right: Expectation): number {
  return left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id);
}

/** In-memory {@link ExpectationRepository}. */
export class MemoryExpectationRepository implements ExpectationRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  upsertByIdempotencyKey(
    clinicId: ClinicId,
    expectation: Expectation,
  ): Promise<UpsertExpectationResult> {
    if (expectation.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const state = this.#db.state;
    const existingId = state.expectationKeys.get(tenantKey(clinicId, expectation.idempotencyKey));
    const existing =
      existingId === undefined
        ? undefined
        : state.expectations.get(tenantKey(clinicId, existingId));
    if (existing !== undefined) {
      return Promise.resolve({ expectation: existing, created: false });
    }
    state.expectations.set(tenantKey(clinicId, expectation.id), expectation);
    state.expectationKeys.set(tenantKey(clinicId, expectation.idempotencyKey), expectation.id);
    return Promise.resolve({ expectation, created: true });
  }

  get(clinicId: ClinicId, id: ExpectationId): Promise<Expectation | undefined> {
    return Promise.resolve(this.#db.state.expectations.get(tenantKey(clinicId, id)));
  }

  findOpenByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly Expectation[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter(
          (expectation) => expectation.patientId === patientId && expectation.status === 'open',
        )
        .sort(byDueAt),
    );
  }

  listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    statuses?: readonly ExpectationStatus[],
  ): Promise<readonly Expectation[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter(
          (expectation) =>
            expectation.patientId === patientId &&
            (statuses === undefined || statuses.includes(expectation.status)),
        )
        .sort(byDueAt),
    );
  }

  findDue(clinicId: ClinicId, now: Date, limit: number): Promise<readonly Expectation[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter(
          (expectation) =>
            expectation.status === 'open' && expectation.dueAt.getTime() <= now.getTime(),
        )
        .sort(byDueAt)
        .slice(0, limit),
    );
  }

  update(clinicId: ClinicId, expectation: Expectation): Promise<void> {
    if (expectation.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, expectation.id);
    if (!this.#db.state.expectations.has(key)) {
      return Promise.reject(new NotFoundError('Expectation', expectation.id));
    }
    this.#db.state.expectations.set(key, expectation);
    return Promise.resolve();
  }

  /** Every expectation of a clinic, any status (for tests and demos). */
  listAll(clinicId: ClinicId): readonly Expectation[] {
    return this.#all(clinicId);
  }

  #all(clinicId: ClinicId): Expectation[] {
    return [...this.#db.state.expectations.values()].filter(
      (expectation) => expectation.clinicId === clinicId,
    );
  }
}
