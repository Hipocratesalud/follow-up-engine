import type { PatientCondition, PatientConditionStatus } from '../domain/condition.ts';
import type { ClinicId, PatientId } from '../domain/ids.ts';
import type { QualityFinding } from '../domain/quality-finding.ts';

/** Conditions the engine believes each patient has. Unique per patient and code. */
export interface ConditionRepository {
  /** Inserts or replaces the condition keyed by `patientId` + `code.system` + `code.code`. */
  upsert(clinicId: ClinicId, condition: PatientCondition): Promise<void>;

  listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    statuses?: readonly PatientConditionStatus[],
  ): Promise<readonly PatientCondition[]>;
}

/** Documentation-quality findings (FHIR `DetectedIssue`). */
export interface QualityFindingRepository {
  /** Idempotent on `id`. */
  save(clinicId: ClinicId, finding: QualityFinding): Promise<void>;

  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly QualityFinding[]>;
}
