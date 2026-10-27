import type { Expectation } from '../domain/expectation.ts';
import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';

export interface UpsertExpectationResult {
  /** The stored expectation: the new one, or the existing one with the same key. */
  readonly expectation: Expectation;
  readonly created: boolean;
}

/** Persists expectations. Adapters throw `TenantMismatchError` if `expectation.clinicId !== clinicId`. */
export interface ExpectationRepository {
  /**
   * Inserts the expectation unless one with the same `idempotencyKey`
   * exists in the clinic, in which case the existing one is returned untouched.
   */
  upsertByIdempotencyKey(
    clinicId: ClinicId,
    expectation: Expectation,
  ): Promise<UpsertExpectationResult>;

  get(clinicId: ClinicId, id: ExpectationId): Promise<Expectation | undefined>;

  /** Open expectations of a patient, by `dueAt` ascending. */
  findOpenByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly Expectation[]>;

  /** Open expectations with `dueAt <= now`, by `dueAt` ascending. */
  findDue(clinicId: ClinicId, now: Date, limit: number): Promise<readonly Expectation[]>;

  /** Replaces a stored expectation. Throws `NotFoundError` if it does not exist. */
  update(clinicId: ClinicId, expectation: Expectation): Promise<void>;
}
