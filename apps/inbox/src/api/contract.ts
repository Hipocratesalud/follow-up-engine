/**
 * Inbox HTTP contract (JSON API served by apps/api under `/api`).
 *
 * This file mirrors the contract on purpose instead of importing
 * `@follow-up-engine/core`: the inbox is a separate deployable that only
 * talks HTTP. Dates are ISO 8601 strings. Spanish labels come from the API.
 */

export const LAYERS = ['universal', 'doctor_plan', 'cadence', 'protocol'] as const;
export type Layer = (typeof LAYERS)[number];

export const CASE_STATUSES = [
  'open',
  'notified',
  'snoozed',
  'escalated',
  'resolved',
  'dismissed',
  'lost_to_follow_up',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ACTIVE_CASE_STATUSES = [
  'open',
  'notified',
  'snoozed',
  'escalated',
] as const satisfies readonly CaseStatus[];

export type PriorityLabel = 'baja' | 'media' | 'alta' | 'urgente';
export type Sex = 'female' | 'male' | 'other' | 'unknown';
export type Origin = 'live' | 'backfill';

/** The authenticated clinic (`GET /api/inbox/clinic`). */
export interface ClinicInfo {
  id: string;
  name: string;
}

export interface PatientSummary {
  id: string;
  name: string;
  age?: number;
  sex?: Sex;
}

export interface PatientContact {
  allowed: boolean;
  optedOut: boolean;
  lastContactAt?: string;
  /** The patient's contact data is flagged (a wrong number): messages are skipped, calls go ahead. */
  contactDataInvalid?: boolean;
  /** The standing flag, when there is one. */
  contactFlag?: ContactFlagView;
}

/** A flag on the patient's contact data, shown on the patient page and the case. */
export interface ContactFlagView {
  issue: 'wrong_number';
  /** Spanish label: "Número equivocado". */
  label: string;
  raisedAt: string;
  channel?: ContactChannel;
}

// Patient contact loop ------------------------------------------------------

export const CONTACT_CHANNELS = ['whatsapp', 'phone_call', 'sms', 'email'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_OUTCOMES = [
  'delivered',
  'read',
  'replied',
  'booked',
  'declined',
  'treated_elsewhere',
  'wrong_number',
  'no_answer',
] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** Outcomes of a call the team made ("Llamar al paciente"). */
export const CALL_OUTCOMES = [
  'booked',
  'treated_elsewhere',
  'no_answer',
  'wrong_number',
  'declined',
] as const satisfies readonly ContactOutcome[];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * Where an attempt stands: `waiting` for an answer within its window,
 * `answered` (replied, booked, declined, treated elsewhere), `unreached`
 * (no answer, wrong number), `unanswered` (its window ended with no answer),
 * `pending_call` (a call the team has to make), `closed` (the case closed
 * before anything came of it).
 */
export type ContactAttemptStatus =
  'waiting' | 'answered' | 'unreached' | 'unanswered' | 'pending_call' | 'closed';

/** One report on an attempt (a FHIR `Communication`). */
export interface ContactCommunicationView {
  id: string;
  at: string;
  status: string;
  outcome?: ContactOutcome;
  outcomeLabel?: string;
  /** `host`: the clinic's system reported it; `user`: the team recorded a call. */
  sender: 'host' | 'user';
  senderName?: string;
}

/** One attempt to reach the patient (a FHIR `CommunicationRequest`), with what came of it. */
export interface ContactAttemptView {
  id: string;
  attempt: number;
  channel?: ContactChannel;
  /** Spanish: "WhatsApp", "Llamada", "SMS", "Correo", "Canal de la clínica". */
  channelLabel: string;
  trigger: 'policy' | 'user' | 'wrong_number';
  requestedAt: string;
  dueBy: string;
  requestedBy?: string;
  status: ContactAttemptStatus;
  statusLabel: string;
  outcome?: ContactOutcome;
  outcomeLabel?: string;
  outcomeAt?: string;
  communications: ContactCommunicationView[];
}

/** A call the team has to make for an active case ("Llamar al paciente"). */
export interface CallTaskView {
  requestId: string;
  dueBy: string;
  overdue: boolean;
  /** `wrong_number`: a message reached the wrong person, the call came forward. */
  trigger: 'policy' | 'user' | 'wrong_number';
  /** The five outcomes the team can record, with their Spanish labels, in display order. */
  outcomes: { outcome: CallOutcome; label: string }[];
}

// Dismissal and suppressions --------------------------------------------------

export const DISMISS_REASONS = [
  'handled_elsewhere',
  'already_done',
  'not_applicable_to_patient',
  'wrong_diagnosis',
  'wrong_interval',
  'other',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** A rule stopped for one patient ("Recordatorios desactivados"). */
export interface SuppressionView {
  id: string;
  ruleId: string;
  /** The rule's Spanish label. */
  label: string;
  dismissReason: DismissReason;
  dismissReasonLabel: string;
  note?: string;
  caseId?: string;
  createdAt: string;
  createdBy?: string;
  active: boolean;
  revokedAt?: string;
  revokedBy?: string;
}

/** Why a dismissed case was dismissed. */
export interface DismissalView {
  reason: DismissReason;
  reasonLabel: string;
  note?: string;
  by?: string;
  at: string;
  /** Rules the dismissal stopped for the patient. */
  suppressions: SuppressionView[];
}

/** Per rule: how useful the team found its cases and why it dismissed them (`GET /api/inbox/calibration`). */
export interface RuleCalibrationView {
  ruleId: string;
  label: string;
  layer?: Layer;
  casesWithFeedback: number;
  useful: number;
  notUseful: number;
  usefulRate?: number;
  dismissals: Record<DismissReason, number>;
  notUsefulReasons: Partial<Record<string, number>>;
}

export interface CalibrationReportView {
  since?: string;
  rules: RuleCalibrationView[];
}

export interface ResourceSource {
  resourceType: string;
  id: string;
  display: string;
}

export interface ReasonEvidence {
  quote: string;
  documentId: string;
  authoredAt: string;
  noteExcerpt?: string;
}

export interface CaseReasonView {
  expectationId: string;
  ruleId: string;
  layer: Layer;
  label: string;
  dueAt: string;
  overdueDays: number;
  /**
   * A protocol item or the visit pattern: "Dejar de recordarlo para este
   * paciente" can stop it. What a clinician asked for never is.
   */
  suppressible: boolean;
  source: ResourceSource;
  evidence?: ReasonEvidence;
}

export const ESCALATION_ACTIONS = [
  'notify_clinic',
  'request_patient_contact',
  'raise_priority',
  'escalate_to_coordinator',
  'mark_lost_to_follow_up',
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** One step of the case's escalation policy. `outcome` and `at` only in the case detail. */
export interface EscalationStepView {
  action: EscalationAction;
  /** Spanish label from the API. */
  label: string;
  afterDays: number;
  /** For steps already passed: it ran, or it could not happen and was skipped. */
  outcome?: 'done' | 'skipped';
  at?: string;
  /**
   * Pending steps of an active case: when the step runs if nobody acts, counted
   * as the engine does (from the next scheduled step, the end of a snooze, or
   * the release day of a held case).
   */
  scheduledAt?: string;
}

/** The case's escalation policy as the engine applies it. */
export interface EscalationView {
  policyId: string;
  /** Steps already passed. */
  currentStep: number;
  steps: EscalationStepView[];
  /** The next step and when it runs; absent on closed or snoozed cases. */
  next?: { action: EscalationAction; label: string; at: string };
}

export interface CaseView {
  id: string;
  patient: PatientSummary;
  status: CaseStatus;
  priority: number;
  priorityLabel: PriorityLabel;
  escalationStep: number;
  escalation: EscalationView;
  /** Display name of the owner. */
  assignee?: string;
  /** Owner id, as the `assignee` filter takes it. */
  assigneeId?: string;
  origin: Origin;
  openedAt: string;
  nextActionAt?: string;
  releaseAt?: string;
  snoozedUntil?: string;
  reasons: CaseReasonView[];
  suggestedAction: string;
  patientContact: PatientContact;
}

export type ActorType = 'rule' | 'user' | 'patient' | 'system';

export interface CaseTimelineEntry {
  at: string;
  type: string;
  actor: { type: ActorType; id?: string };
  label: string;
  /** The internal note the team wrote with the action. */
  note?: string;
}

export const FEEDBACK_REASONS = [
  'wrong_rule',
  'wrong_interval',
  'bad_extraction',
  'already_handled',
  'other',
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export interface CaseFeedbackView {
  useful: boolean;
  /** A dismissal records its reason as the case's feedback too. */
  reason?: FeedbackReason | DismissReason;
  comment?: string;
}

export interface CaseDetail extends CaseView {
  timeline: CaseTimelineEntry[];
  feedback?: CaseFeedbackView;
  /** Every attempt to reach the patient about this case, oldest first. */
  contactAttempts: ContactAttemptView[];
  /** The call the team has to make now, if any (active cases only). */
  callTask?: CallTaskView;
  /** Dismissed cases: why. */
  dismissal?: DismissalView;
}

export type CaseListView = 'active' | 'closed' | 'all';

export interface CaseListQuery {
  view?: CaseListView;
  origin?: Origin;
  /** Owner id, from `GET /api/inbox/owners`. */
  assignee?: string;
  /** Patient name or id contains this text. */
  q?: string;
  /** Only the cases of this patient id. */
  patient?: string;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  /** Items matching the query across every page. */
  total: number;
}

export type RecoveryPage = Page<CaseView>;

/** An owner of cases, for the "Responsable" filter (`GET /api/inbox/owners`). */
export interface OwnerView {
  id: string;
  name: string;
  activeCases: number;
}

export type CaseAction = 'notify' | 'snooze' | 'resolve' | 'dismiss';

export interface CaseActionRequest {
  action: CaseAction;
  snoozeDays?: number;
  /** Required with `dismiss` and reason `other`. */
  note?: string;
  /** Required with `dismiss`. */
  reason?: DismissReason;
  /** `dismiss` with `not_applicable_to_patient`: stop the case's rules for this patient. */
  suppress?: boolean;
}

/** `POST /api/inbox/cases/:id/call-outcome`: what came of the call. Answers the case detail. */
export interface CallOutcomeRequest {
  outcome: CallOutcome;
  /** The call (`callTask.requestId`); the latest call of the case when absent. */
  requestId?: string;
}

export interface FeedbackRequest {
  useful: boolean;
  reason?: FeedbackReason;
  comment?: string;
}

/**
 * `entered_in_error`: the clinic system's record was entered in error or
 * moved to another patient, so it was never this patient's. The API leaves
 * it out of the patient view and the inbox never shows it.
 */
export type ConditionStatus =
  'confirmed' | 'probable' | 'resolved' | 'rejected' | 'entered_in_error';

export interface ConditionView {
  id: string;
  code: string;
  display: string;
  status: ConditionStatus;
  confidence: number;
  sourceType: string;
  evidence?: { quote: string; documentId: string };
  /** Who rejected a `rejected` condition: the clinic's own system (FHIR) or the team in the inbox. */
  rejectedBy?: 'host' | 'clinician';
}

export type ExpectationStatus = 'open' | 'fulfilled' | 'superseded' | 'expired' | 'cancelled';

export interface PatientExpectationView {
  id: string;
  ruleId: string;
  layer: Layer;
  label: string;
  status: ExpectationStatus;
  dueAt: string;
  /** Why the engine closed it, in Spanish. */
  closedReason?: string;
  evidence?: { quote: string; documentId: string };
}

export interface QualityFindingView {
  id: string;
  code: 'note_without_plan' | 'note_truncated';
  documentId: string;
  at: string;
  label: string;
}

/**
 * The contract leaves `patient` untyped here. The inbox reads the case's
 * patient summary plus, when present, the contact status.
 */
export interface PatientDetail {
  patient: PatientSummary & { contact?: PatientContact };
  conditions: ConditionView[];
  expectations: PatientExpectationView[];
  qualityFindings: QualityFindingView[];
  /** Rules stopped for this patient, active first ("Recordatorios desactivados"). */
  suppressions: SuppressionView[];
}

export interface InboxStats {
  activeCases: number;
  byLayer: Record<Layer, number>;
  byStatus: Record<string, number>;
  feedback: { total: number; usefulRate: number };
  llm: {
    monthCostUsd: number;
    calls: number;
    avgCostPerNoteUsd: number;
    provider: string;
    model: string;
  };
}

export interface DemoClock {
  now: string;
  fake: boolean;
}

export interface LabOrderInput {
  loinc: string;
  display: string;
}

export interface DemoConsultationRequest {
  patientId?: string;
  patientName?: string;
  specialty: string;
  noteText: string;
  orders?: LabOrderInput[];
}

export type PlanItemKind = 'follow_up_visit' | 'lab' | 'imaging' | 'session' | 'other';

export interface ExtractedPlanItem {
  kind: PlanItemKind;
  description: string;
  dueAt: string;
  evidenceQuote: string;
  confidence: number;
}

export interface ExtractedConditionView {
  code: { system?: string; code: string; display?: string };
  confidence: number;
  evidenceQuote: string;
}

export interface ExtractedMedicationView {
  text: string;
  durationDays?: number;
  evidenceQuote: string;
}

export interface CreatedExpectation {
  id: string;
  ruleId: string;
  layer: Layer;
  label: string;
  dueAt: string;
}

export interface DemoConsultationResponse {
  bundle: unknown;
  extraction: {
    model: string;
    hasPlan: boolean;
    conditions: ExtractedConditionView[];
    medications: ExtractedMedicationView[];
    planItems: ExtractedPlanItem[];
    costUsd: number;
    latencyMs: number;
  };
  expectationsCreated: CreatedExpectation[];
}

export interface WebhookDelivery {
  at: string;
  type: string;
  payload: unknown;
  signatureValid: boolean;
  delivered: boolean;
}

/** One invalid input of a 422: the request field (`note`, `q`, `patientName`) and a Spanish message. */
export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: ApiFieldError[] };
}
