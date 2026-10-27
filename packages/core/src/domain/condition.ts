import type { Evidence } from './common.ts';
import type { ClinicId, PatientId } from './ids.ts';
import type { Coding, ResourceRef } from './resource.ts';

export type PatientConditionStatus = 'confirmed' | 'probable' | 'resolved';

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
  /** Host user id of the clinician who confirmed an inferred condition. */
  readonly confirmedBy?: string;
  /** For conditions read from a note: the verbatim quote that supports it. */
  readonly evidence?: Evidence;
  readonly updatedAt: Date;
}
