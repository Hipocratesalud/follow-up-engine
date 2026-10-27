import { ICD10_SYSTEM } from '@follow-up-engine/core';

/** The only FHIR version the engine speaks. See docs/adr/0001-fhir-r4-data-model.md. */
export const FHIR_VERSION = '4.0.1';

/** Canonical base of every engine-defined artifact (CodeSystems, extensions, identifiers). */
export const ENGINE_FHIR_BASE = 'https://hipocratesalud.com/fhir';

const codeSystem = (name: string): string => `${ENGINE_FHIR_BASE}/CodeSystem/${name}`;
const structureDefinition = (name: string): string =>
  `${ENGINE_FHIR_BASE}/StructureDefinition/${name}`;
const namingSystem = (name: string): string => `${ENGINE_FHIR_BASE}/NamingSystem/${name}`;

/** Engine CodeSystems. Codes are the engine's own machine codes, verbatim. */
export const ENGINE_CODE_SYSTEMS = {
  /** `Task.code` of an expectation: the id of the rule that created it. */
  expectation: codeSystem('follow-up-expectation'),
  /** `Task.code` of a case: the single code {@link CASE_TASK_CODE}. */
  taskType: codeSystem('follow-up-task-type'),
  /** `Task.businessStatus` of an expectation: the exact engine status. */
  expectationStatus: codeSystem('follow-up-expectation-status'),
  /** `Task.businessStatus` of a case: the exact engine status. */
  caseStatus: codeSystem('follow-up-case-status'),
  /** `Task.statusReason` of a closed expectation (`closedReason`, e.g. `fulfilled_by_result`). */
  closedReason: codeSystem('follow-up-closed-reason'),
  /** `Task.statusReason` of a resolved case. */
  caseResolution: codeSystem('follow-up-case-resolution'),
  /** Machine reason codes (`Reason.code`), e.g. `imaging_result_pending`. */
  reason: codeSystem('follow-up-reason'),
  /** `DetectedIssue.code` of a documentation-quality finding. */
  qualityFinding: codeSystem('follow-up-quality-finding'),
  /** `Provenance.activity` of a case event (`CaseEvent.type`). */
  caseEvent: codeSystem('follow-up-case-event'),
  /** Specialty codes a host may send in `Encounter.serviceType` (e.g. `diabetology`). */
  specialty: codeSystem('specialty'),
  /** `Consent.category` code that marks a follow-up opt-out. */
  consent: codeSystem('follow-up-consent'),
  /** Placeholder system for orders that arrive with free text only. */
  uncoded: codeSystem('uncoded'),
  /** Local procedure codes protocols expect when no standard code fits (`fundus-exam`). */
  procedure: codeSystem('procedure'),
} as const;

/** `Task.code` of a case Task in {@link ENGINE_CODE_SYSTEMS.taskType}. */
export const CASE_TASK_CODE = 'follow-up-case';
/** `DetectedIssue.code` for a note without a follow-up plan. */
export const NOTE_WITHOUT_PLAN_CODE = 'note-without-plan';
/** `DetectedIssue.code` for a note too long to be read whole (its middle was not read). */
export const NOTE_TRUNCATED_CODE = 'note-truncated';
/** `Consent.category` code (in {@link ENGINE_CODE_SYSTEMS.consent}) for a follow-up opt-out. */
export const FOLLOW_UP_OPT_OUT_CONSENT_CODE = 'follow-up-opt-out';

/** Engine extensions. All are simple (one `value[x]`) unless documented otherwise. */
export const ENGINE_EXTENSIONS = {
  /** Patient, `valueBoolean`: true when the patient opted out of follow-up. */
  followUpOptOut: structureDefinition('follow-up-opt-out'),
  /** Task (expectation), `valueCode`: `universal` | `doctor_plan` | `cadence` | `protocol`. */
  layer: structureDefinition('follow-up-layer'),
  /** Task (expectation), `valueString`: semantic version of the rule. */
  ruleVersion: structureDefinition('follow-up-rule-version'),
  /** Task (expectation), `valueString`: id of the protocol that created it. */
  protocolId: structureDefinition('follow-up-protocol-id'),
  /** Task (expectation), `valueString`: semantic version of the protocol. */
  protocolVersion: structureDefinition('follow-up-protocol-version'),
  /** Task (expectation), `valueString`: what a fulfilling event must match. */
  matchKey: structureDefinition('follow-up-match-key'),
  /** Task, `valueCode`: `live` | `backfill`. */
  origin: structureDefinition('follow-up-origin'),
  /**
   * Task (expectation) and Condition, complex: `quote` (`valueString`, verbatim
   * text from the note) and `source` (`valueReference` to the DocumentReference).
   */
  evidence: structureDefinition('follow-up-evidence'),
  /** Task (case), `valueInteger`: index into the escalation policy. */
  escalationStep: structureDefinition('follow-up-escalation-step'),
  /** Task (case), `valueInteger`: the engine's numeric priority (higher is more urgent). */
  priorityScore: structureDefinition('follow-up-priority-score'),
  /** Task (case), `valueString`: the key that groups expectations into the case. */
  dedupKey: structureDefinition('follow-up-dedup-key'),
  /** Task (case), `valueDateTime`: when a backfill case becomes visible. */
  releaseAt: structureDefinition('follow-up-release-at'),
  /** Task (case), `valueDateTime`: when the worker next looks at the case. */
  nextActionAt: structureDefinition('follow-up-next-action-at'),
  /** Task (case), `valueDateTime`: end of the current snooze. */
  snoozedUntil: structureDefinition('follow-up-snoozed-until'),
  /**
   * Task (case), complex: `kind` (`valueCode`), `resolvedAt` (`valueDateTime`),
   * `resolvedBy` (`valueString`), `note` (`valueString`).
   */
  resolution: structureDefinition('follow-up-case-resolution'),
  /** Condition, `valueDecimal` 0..1: the engine's confidence. */
  confidence: structureDefinition('follow-up-confidence'),
  /** Condition, `valueCode`: how the engine learned about it (`ConditionSourceType`). */
  conditionSource: structureDefinition('follow-up-condition-source'),
  /** Condition, `valueString`: host user id of the clinician who confirmed it. */
  confirmedBy: structureDefinition('follow-up-confirmed-by'),
  /** Condition (`refuted`), `valueString`: host user id of the clinician who rejected it. */
  refutedBy: structureDefinition('follow-up-refuted-by'),
  /** Provenance, `valueString`: the case event payload as JSON (ids and codes only). */
  caseEventPayload: structureDefinition('follow-up-case-event-payload'),
} as const;

/** Engine identifier systems. */
export const ENGINE_IDENTIFIER_SYSTEMS = {
  /** `Task.identifier` of an expectation: its idempotency key. */
  expectationKey: namingSystem('follow-up-expectation-key'),
  /** Host user ids (assignees, resolvers, actors of case events). */
  hostUser: namingSystem('host-user'),
  /** Rule ids acting as Provenance agents. */
  rule: namingSystem('follow-up-rule'),
  /** The engine itself as a Provenance agent. */
  engine: namingSystem('follow-up-engine'),
} as const;

/** External terminologies the mapping understands. */
export const TERMINOLOGY = {
  icd10: ICD10_SYSTEM,
  icd10cm: 'http://hl7.org/fhir/sid/icd-10-cm',
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  observationInterpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  conditionVerification: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionCategory: 'http://terminology.hl7.org/CodeSystem/condition-category',
  participationType: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
  provenanceParticipantType: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
  consentScope: 'http://terminology.hl7.org/CodeSystem/consentscope',
  ucum: 'http://unitsofmeasure.org',
} as const;

/** SNOMED CT codes that classify a `ServiceRequest.category`. */
export const SNOMED_SERVICE_CATEGORY = {
  laboratory: '108252007',
  imaging: '363679005',
} as const;

/**
 * Common LOINC laboratory tests: an order coded with one of these is a
 * laboratory order even when the host sent no `category`. Deliberately
 * short (chemistry, hematology, lipids, renal, thyroid, urine): a code not
 * listed is never guessed.
 */
export const LABORATORY_LOINC_CODES: ReadonlySet<string> = new Set([
  '4548-4', // Hemoglobin A1c
  '17856-6', // Hemoglobin A1c (HPLC)
  '2345-7', // Glucose, serum or plasma
  '2339-0', // Glucose, blood
  '1558-6', // Fasting glucose
  '2093-3', // Cholesterol
  '2085-9', // HDL cholesterol
  '13457-7', // LDL cholesterol (calculated)
  '18262-6', // LDL cholesterol (direct)
  '2571-8', // Triglycerides
  '24331-1', // Lipid panel
  '57698-3', // Lipid panel with direct LDL
  '2160-0', // Creatinine
  '33914-3', // eGFR
  '62238-1', // eGFR (CKD-EPI)
  '3094-0', // Urea nitrogen
  '2951-2', // Sodium
  '2823-3', // Potassium
  '17861-6', // Calcium
  '1742-6', // ALT
  '1920-8', // AST
  '3016-3', // TSH
  '3024-7', // Free T4
  '718-7', // Hemoglobin
  '4544-3', // Hematocrit
  '6690-2', // Leukocytes
  '777-3', // Platelets
  '58410-2', // CBC panel
  '57021-8', // CBC with differential
  '24323-8', // Comprehensive metabolic panel
  '51990-0', // Basic metabolic panel
  '14959-1', // Microalbumin/creatinine ratio, urine
  '9318-7', // Albumin/creatinine ratio, urine
  '24356-8', // Urinalysis complete
  '5902-2', // Prothrombin time
  '6301-6', // INR
  '2276-4', // Ferritin
  '1989-3', // 25-hydroxyvitamin D
  '2132-9', // Vitamin B12
  '2857-1', // PSA
]);
