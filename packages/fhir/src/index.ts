/**
 * `@follow-up-engine/fhir`: the engine's HL7 FHIR R4 (4.0.1) contract.
 *
 * - Inbound: validate a host's `transaction`/`batch` Bundle and map it to
 *   core `ClinicalBatch`es ({@link mapBundleToBatches}).
 * - Outbound: represent engine objects as FHIR resources (`Task`,
 *   `Condition`, `DetectedIssue`, `Provenance`, searchset `Bundle`).
 *
 * Pure functions only: no I/O, no clock, no randomness.
 */
export const PACKAGE_NAME = '@follow-up-engine/fhir';

export type * from './fhir-types.ts';
export {
  CASE_TASK_CODE,
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  ENGINE_FHIR_BASE,
  ENGINE_IDENTIFIER_SYSTEMS,
  FHIR_VERSION,
  FOLLOW_UP_OPT_OUT_CONSENT_CODE,
  NOTE_WITHOUT_PLAN_CODE,
  SNOMED_SERVICE_CATEGORY,
  TERMINOLOGY,
} from './terminology.ts';

// Inbound
export {
  mapBundleToBatches,
  validateBundle,
  type BundleMappingResult,
  type BundleValidationResult,
  type MapBundleOptions,
  type PatientResource,
} from './inbound/map-bundle.ts';
export type { MappedClinicalEvent } from './inbound/context.ts';

// Outbound
export { expectationToTask, EXPECTATION_TASK_STATUS } from './outbound/expectation-task.ts';
export {
  caseToTask,
  CASE_PRIORITY_THRESHOLDS,
  CASE_TASK_STATUS,
  taskPriority,
  type TaskPriority,
} from './outbound/case-task.ts';
export {
  CONDITION_STATUS_CODES,
  conditionId,
  exportableConditions,
  patientConditionToFhir,
  type PatientConditionInput,
} from './outbound/condition.ts';
export { QUALITY_FINDING_CODES, qualityFindingToDetectedIssue } from './outbound/detected-issue.ts';
export { caseEventId, caseEventToProvenance, provenanceAgent } from './outbound/provenance.ts';
export { toSearchsetBundle, type SearchsetOptions } from './outbound/searchset.ts';
export {
  FhirRepresentationError,
  fhirToPatientCondition,
  isActiveCaseTask,
  taskToCase,
  taskToExpectation,
} from './outbound/readers.ts';

// Builders and helpers
export {
  buildConsultationBundle,
  type ConsultationDiagnosisInput,
  type ConsultationInput,
  type ConsultationOrderInput,
  type ConsultationPrescriptionInput,
} from './builders/consultation-bundle.ts';
export {
  toOperationOutcome,
  type IssueCode,
  type IssueSeverity,
  type MappingIssue,
} from './support/operation-outcome.ts';
export { toFhirId } from './support/hash.ts';
