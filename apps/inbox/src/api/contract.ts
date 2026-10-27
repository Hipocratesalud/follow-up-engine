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
  reason?: FeedbackReason;
  comment?: string;
}

export interface CaseDetail extends CaseView {
  timeline: CaseTimelineEntry[];
  feedback?: CaseFeedbackView;
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
  note?: string;
}

export interface FeedbackRequest {
  useful: boolean;
  reason?: FeedbackReason;
  comment?: string;
}

export type ConditionStatus = 'confirmed' | 'probable' | 'resolved' | 'rejected';

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
  code: 'note_without_plan';
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
