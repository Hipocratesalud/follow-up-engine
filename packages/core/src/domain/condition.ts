import type { Evidence } from './common.ts';
import type { ClinicId, PatientId } from './ids.ts';
import type { Coding, ResourceRef } from './resource.ts';

/**
 * `rejected`: the patient does not have it (exported as FHIR `refuted`),
 * said by a clinician (`confirmedBy` holds who; automation never re-infers
 * it) or by the host, which refuted the diagnosis it had recorded.
 * `resolved`: the patient had it and no longer does. `entered_in_error`: it
 * was never this patient's (the host's record was entered in error or moved
 * to another patient); exported `entered-in-error`, never shown as a
 * diagnosis.
 */
export const PATIENT_CONDITION_STATUSES = [
  'confirmed',
  'probable',
  'resolved',
  'rejected',
  'entered_in_error',
] as const;
export type PatientConditionStatus = (typeof PATIENT_CONDITION_STATUSES)[number];

/** How the engine learned about the condition. */
export type ConditionSourceType =
  'recorded' | 'inferred_from_medication' | 'inferred_from_result' | 'extracted_from_note';

/**
 * A condition the engine believes the patient has, used to enroll them in
 * protocols. Exposed as a FHIR `Condition` with a verification status.
 * Unique per patient and code.
 */
export interface PatientCondition {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** ICD-10 code. */
  readonly code: Coding;
  readonly status: PatientConditionStatus;
  /** 0 to 1; 1 for conditions recorded by a clinician. */
  readonly confidence: number;
  readonly sourceType: ConditionSourceType;
  readonly source: ResourceRef;
  /**
   * Host user id of the clinician who reviewed it: confirmed it, or rejected
   * it (`rejected`). A `rejected` condition without it was refuted by the host.
   */
  readonly confirmedBy?: string;
  /** For conditions read from a note: the verbatim quote that supports it. */
  readonly evidence?: Evidence;
  readonly updatedAt: Date;
}
