import type { ClinicId, PatientId } from './ids.ts';
import type { ResourceRef } from './resource.ts';

export type QualityFindingKind = 'note_without_plan';

/**
 * A documentation-quality issue for the clinician, for example a note that
 * records a diagnosis but no follow-up plan. Exposed as a FHIR
 * `DetectedIssue`. A suggestion to the clinician, never to the patient.
 */
export interface QualityFinding {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly kind: QualityFindingKind;
  /** The document the finding is about. */
  readonly source: ResourceRef;
  readonly detectedAt: Date;
}
