import {
  type ClinicId,
  ConflictError,
  type ExpectationEvent,
  type ExpectationEventLog,
  type ExpectationId,
  type PatientId,
  TenantMismatchError,
} from '@follow-up-engine/core';
import type { MemoryDatabase } from '../memory-database.ts';

/** In-memory {@link ExpectationEventLog}: append-only, in append order. */
export class MemoryExpectationEventLog implements ExpectationEventLog {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  append(clinicId: ClinicId, event: ExpectationEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    if (this.#all(clinicId).some((item) => item.id === event.id)) {
      return Promise.reject(new ConflictError('ExpectationEvent', event.id));
    }
    this.#db.pushTo(this.#db.state.expectationEvents, event);
    return Promise.resolve();
  }

  listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly ExpectationEvent[]> {
    return Promise.resolve(
      this.#all(clinicId).filter((item) => item.expectationId === expectationId),
    );
  }

  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly ExpectationEvent[]> {
    return Promise.resolve(this.#all(clinicId).filter((item) => item.patientId === patientId));
  }

  /** The clinic's events by time; the stable sort keeps append order on the same instant (like `seq`). */
  #all(clinicId: ClinicId): ExpectationEvent[] {
    return this.#db.state.expectationEvents
      .filter((item) => item.clinicId === clinicId)
      .sort((left, right) => left.at.getTime() - right.at.getTime());
  }
}
