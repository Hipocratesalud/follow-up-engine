import type { ExpectationEvent } from '../domain/expectation-event.ts';
import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';

/**
 * Append-only audit of what the engine did to expectations outside a case
 * (a closure reclassified after the fact). Unlike the case audit log, it
 * covers expectations that never became a case. Entries are never updated
 * or deleted.
 */
export interface ExpectationEventLog {
  /** Throws `TenantMismatchError` for another clinic's entry, `ConflictError` for a duplicate id. */
  append(clinicId: ClinicId, event: ExpectationEvent): Promise<void>;

  /** The events of one expectation, oldest first. */
  listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly ExpectationEvent[]>;

  /** The events of a patient's expectations, oldest first. */
  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly ExpectationEvent[]>;
}
