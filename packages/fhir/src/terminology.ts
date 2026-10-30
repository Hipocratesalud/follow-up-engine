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
  /** `DetectedIssue.code` of a clinical reviewer finding: its category (`lab-trend`, ...). */
  clinicalFinding: codeSystem('clinical-finding-category'),
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
  /**
   * What came of a contact attempt (`Communication`): `delivered`, `read`,
   * `replied`, `booked`, `declined`, `treated_elsewhere`, `wrong_number`,
   * `no_answer`.
   */
  contactOutcome: codeSystem('contact-outcome'),
  /** `CommunicationRequest.medium` / `Communication.medium`: `whatsapp`, `phone_call`, `sms`, `email`. */
  contactChannel: codeSystem('contact-channel'),
  /** `CommunicationRequest.category`: the generic purpose of a contact (`schedule_follow_up`, ...). */
  contactPurpose: codeSystem('contact-purpose'),
  /** Why a clinic user dismissed a case (`Task.statusReason` of a dismissed case, `Flag` extension). */
  dismissReason: codeSystem('follow-up-dismiss-reason'),
  /** `Flag.category` of the engine's flags. */
  flagCategory: codeSystem('follow-up-flag-category'),
} as const;

/** `Task.code` of a case Task in {@link ENGINE_CODE_SYSTEMS.taskType}. */
export const CASE_TASK_CODE = 'follow-up-case';
/** `DetectedIssue.code` for a note without a follow-up plan. */
export const NOTE_WITHOUT_PLAN_CODE = 'note-without-plan';
/** `DetectedIssue.code` for a note too long to be read whole (its middle was not read). */
export const NOTE_TRUNCATED_CODE = 'note-truncated';
/**
 * What a document the evaluator lab uploads is, at the edge, before it is
 * ingested (docs/deploy.md#the-document-lab-and-its-per-evaluator-sandbox-clock):
 * not a FHIR code, just the lab form's own choice of what kind of paper this is.
 */
export const CONSULTATION_DOCUMENT_TYPES = [
  'consultation_note',
  'lab_result',
  'imaging_report',
  'prescription',
  'other',
] as const;
export type ConsultationDocumentType = (typeof CONSULTATION_DOCUMENT_TYPES)[number];

/** `Consent.category` code (in {@link ENGINE_CODE_SYSTEMS.consent}) for a follow-up opt-out. */
export const FOLLOW_UP_OPT_OUT_CONSENT_CODE = 'follow-up-opt-out';
/** `Flag.category` code (in {@link ENGINE_CODE_SYSTEMS.flagCategory}) of a per-patient rule suppression. */
export const FOLLOW_UP_SUPPRESSION_FLAG_CODE = 'follow-up-suppression';

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
  /**
   * Appointment, `valueReference` to the case `Task` (or the
   * `CommunicationRequest`) the booking answers: attribution of bookings to
   * the follow-up engine (HIP-141).
   */
  followUpOriginCase: structureDefinition('follow-up-origin-case'),
  /**
   * Task (case), on each `input` (one per reason), complex: `ruleId`,
   * `ruleVersion`, `layer` (`valueCode`), `protocolId`, `protocolVersion`
   * (`valueString`): which versioned rule or protocol produced the reason.
   */
  reasonRule: structureDefinition('follow-up-reason-rule'),
  /** Task (case), `valueInteger`: index into the escalation policy. */
  escalationStep: structureDefinition('follow-up-escalation-step'),
  /** Task (case), `valueString`: the named, versioned escalation policy the case follows. */
  escalationPolicy: structureDefinition('follow-up-escalation-policy'),
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
   * `resolvedBy` (`valueString`), `note` (`valueString`), `dismissReason`
   * (`valueCode`, dismissed cases).
   */
  resolution: structureDefinition('follow-up-case-resolution'),
  /** Condition, `valueDecimal` 0..1: the engine's confidence. */
  confidence: structureDefinition('follow-up-confidence'),
  /** Condition, `valueCode`: how the engine learned about it (`ConditionSourceType`). */
  conditionSource: structureDefinition('follow-up-condition-source'),
  /**
   * Condition and Task (expectation), `valueString`: host user id of the
   * clinician who confirmed it (a plan item the AI read, or its correction).
   */
  confirmedBy: structureDefinition('follow-up-confirmed-by'),
  /** Task (expectation), `valueDateTime`: when the clinician confirmed the plan item. */
  confirmedAt: structureDefinition('follow-up-confirmed-at'),
  /**
   * Task (expectation), `valueReference` to the expectation Task this one
   * corrected (that one is `cancelled`, `statusReason` `corrected_by_clinician`).
   */
  correctionOf: structureDefinition('follow-up-correction-of'),
  /**
   * Task (expectation), complex: a closure the engine reclassified after
   * the fact (`statusReason` is the reason it reads as now, executionPeriod
   * end the original closure). `originalReason` (`valueCode`, the
   * `closedReason` it was closed with), `at` (`valueDateTime`), `by`
   * (`valueReference`, the resource whose event caused it).
   */
  closureReclassification: structureDefinition('follow-up-closure-reclassification'),
  /** Condition (`refuted`), `valueString`: host user id of the clinician who rejected it. */
  refutedBy: structureDefinition('follow-up-refuted-by'),
  /** DetectedIssue (clinical finding), `valueCode`: `shadow` | `live`. */
  findingMode: structureDefinition('clinical-finding-mode'),
  /** DetectedIssue (clinical finding), `valueBoolean`: an open expectation or case already covers it. */
  alreadyCovered: structureDefinition('clinical-finding-already-covered'),
  /** DetectedIssue (clinical finding), `valueCode`: `confirmed` | `added` | `fallback`. */
  findingOrigin: structureDefinition('clinical-finding-origin'),
  /** DetectedIssue (clinical finding), `valueString`: `<provider>:<model>` and prompt version. */
  reviewerModel: structureDefinition('clinical-finding-model'),
  /** Provenance, `valueString`: the case event payload as JSON (ids and codes only). */
  caseEventPayload: structureDefinition('follow-up-case-event-payload'),
  /**
   * Communication, `valueCodeableConcept` in {@link ENGINE_CODE_SYSTEMS.contactOutcome}:
   * what came of the attempt. Also accepted in `Communication.statusReason`.
   */
  contactOutcome: structureDefinition('contact-outcome'),
  /** CommunicationRequest, `valueInteger`: 1-based attempt number within the case. */
  contactAttempt: structureDefinition('contact-attempt'),
  /** CommunicationRequest, `valueCode`: `policy` | `user` | `wrong_number`. */
  contactTrigger: structureDefinition('contact-trigger'),
  /** Flag (suppression), `valueCode` in {@link ENGINE_CODE_SYSTEMS.dismissReason}. */
  dismissReason: structureDefinition('follow-up-dismiss-reason'),
  /** Flag (suppression), `valueReference`: the dismissed case `Task` it came from. */
  sourceCase: structureDefinition('follow-up-source-case'),
  /** Flag (suppression), `valueString`: the team's internal note. */
  note: structureDefinition('follow-up-note'),
  /** Flag (suppression), `valueString`: host user id of whoever reactivated the rule. */
  revokedBy: structureDefinition('follow-up-revoked-by'),
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
  allergyVerification: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
  allergyClinical: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
  participationType: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
  provenanceParticipantType: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
  consentScope: 'http://terminology.hl7.org/CodeSystem/consentscope',
  participationMode: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode',
  ucum: 'http://unitsofmeasure.org',
} as const;

/**
 * SNOMED CT concepts that record the absence of allergies ("no known
 * allergy", "no known drug allergy", ...): an allergy status, not a substance.
 */
export const SNOMED_NO_KNOWN_ALLERGY: ReadonlySet<string> = new Set([
  '716186003', // No known allergy
  '409137002', // No known drug allergy
  '428607008', // No known environmental allergy
  '429625007', // No known food allergy
]);

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
