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
