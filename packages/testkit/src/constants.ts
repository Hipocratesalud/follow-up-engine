/**
 * Fixed reference instant of every fixture. Scenario day offsets count from
 * it, and the synthetic clinic's two years of history end on it. A fixed
 * date keeps every test, demo and eval reproducible.
 */
export const BASE_DATE = new Date('2026-01-05T12:00:00.000Z');

/** Tenant id of the synthetic demo clinic. */
export const DEMO_CLINIC_ID = 'clinic-demo';

/** Display name of the synthetic demo clinic (fictional). */
export const DEMO_CLINIC_NAME = 'Clínica Demo Hipócrates';

/**
 * Every rule id the scenarios refer to. The engine's rules and protocols use
 * the same ids, so a scenario can assert which rule produced an expectation.
 *
 * - `lab_order_result_pending`: a lab order expects a result within 15 days.
 * - `imaging_order_result_pending`: an imaging order expects a result within 30 days.
 * - `short_treatment_followup`: a short treatment expects a visit by its end + 3 days.
 * - `abnormal_result_followup`: an abnormal (H/L) result expects a visit within 7 days.
 * - `cadence_break`: with at least 2 visits, the next one is expected by 3x the usual interval.
 * - `doctor_plan_followup`: what the doctor wrote in the plan, due when the doctor said.
 * - `protocol_diabetes_*`, `protocol_hypertension_*`: care protocols; they only fill what the
 *   doctor's plan did not cover.
 */
export const RULE_IDS = {
  labOrderResultPending: 'lab_order_result_pending',
  imagingOrderResultPending: 'imaging_order_result_pending',
  shortTreatmentFollowup: 'short_treatment_followup',
  abnormalResultFollowup: 'abnormal_result_followup',
  cadenceBreak: 'cadence_break',
  doctorPlanFollowup: 'doctor_plan_followup',
  protocolDiabetesVisit: 'protocol_diabetes_visit',
  protocolDiabetesHba1c: 'protocol_diabetes_hba1c',
  protocolDiabetesLipids: 'protocol_diabetes_lipids',
  protocolDiabetesFundus: 'protocol_diabetes_fundus',
  protocolHypertensionVisit: 'protocol_hypertension_visit',
  protocolHypertensionLabs: 'protocol_hypertension_labs',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

/** {@link RULE_IDS} as a list, for validation. */
export const ALL_RULE_IDS: readonly RuleId[] = Object.values(RULE_IDS);

/** Specialties of the synthetic clinic, as used in `Encounter.serviceType` and gold notes. */
export const SPECIALTIES = [
  'diabetology',
  'internal_medicine',
  'psychology',
  'gynecology',
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

/** Terminology URIs used by the fixtures. */
export const SYSTEMS = {
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  atc: 'http://www.whocc.no/atc',
  ucum: 'http://unitsofmeasure.org',
  /** Local code system for the clinic's specialties (codes = {@link SPECIALTIES}). */
  specialty: 'https://follow-up-engine.dev/fhir/CodeSystem/specialty',
  /** Local identifier system for the demo clinic's patients. */
  patientIdentifier: 'https://follow-up-engine.dev/fhir/sid/demo-patient',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  observationInterpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  observationCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  diagnosticServiceSection: 'http://terminology.hl7.org/CodeSystem/v2-0074',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionVerification: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  conditionCategory: 'http://terminology.hl7.org/CodeSystem/condition-category',
} as const;

const MS_PER_DAY = 86_400_000;

/** The instant `days` whole days after {@link BASE_DATE} (negative for the past). */
export function dayToDate(days: number): Date {
  return new Date(BASE_DATE.getTime() + days * MS_PER_DAY);
}
