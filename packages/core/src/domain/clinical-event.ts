import type { Evidence } from './common.ts';
import type { ClinicId, PatientId, PractitionerId } from './ids.ts';
import type { Coding, ResourceRef } from './resource.ts';

/**
 * Every clinical event type the engine understands. Produced by
 * `@follow-up-engine/fhir` from incoming FHIR resources, except
 * `plan.extracted`, which the LLM gateway produces from a note.
 */
export const CLINICAL_EVENT_TYPES = [
  'encounter.finished',
  'appointment.booked',
  'appointment.cancelled',
  'service_request.created',
  'result.received',
  'medication.prescribed',
  'condition.recorded',
  'note.received',
  'plan.extracted',
  'patient.opted_out',
  'record.withdrawn',
] as const;

export type ClinicalEventType = (typeof CLINICAL_EVENT_TYPES)[number];

/** Fields shared by every clinical event. */
export interface ClinicalEventBase {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** The FHIR resource the event was derived from. */
  readonly source: ResourceRef;
  /** The consultation (FHIR `Encounter` id) the event belongs to, if any. */
  readonly encounterId?: string;
  /** When the fact happened clinically (not when the engine received it). */
  readonly occurredAt: Date;
  /**
   * Stable across re-deliveries of the same fact, so ingestion is
   * idempotent. Convention: `<resourceType>/<id>/<versionId>#<event type>`.
   */
  readonly idempotencyKey: string;
  /**
   * When the host recorded the version of `source` the event was derived
   * from (FHIR `meta.lastUpdated`), if known. Orders the versions of one
   * resource where the clinical time cannot: a rescheduled Appointment keeps
   * its original `created`.
   */
  readonly recordedAt?: Date;
}

export type ServiceCategory = 'laboratory' | 'imaging' | 'other';
export type ResultInterpretation = 'normal' | 'abnormal' | 'unknown';
/**
 * How far an abnormal result is from normal: `critical` for a panic value
 * (FHIR interpretation `HH`, `LL`, `AA`, or one labelled critical / panic),
 * `mild` for any other abnormal flag.
 */
export const RESULT_SEVERITIES = ['mild', 'critical'] as const;
export type ResultSeverity = (typeof RESULT_SEVERITIES)[number];
export type ConditionVerification = 'confirmed' | 'provisional';
export const PLAN_ITEM_KINDS = ['follow_up_visit', 'lab', 'imaging', 'session', 'other'] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

/** A consultation was completed. */
export interface EncounterFinishedEvent extends ClinicalEventBase {
  readonly type: 'encounter.finished';
  readonly practitionerId?: PractitionerId;
  readonly specialty?: string;
}

/** A future appointment was booked. */
export interface AppointmentBookedEvent extends ClinicalEventBase {
  readonly type: 'appointment.booked';
  readonly scheduledFor: Date;
  readonly practitionerId?: PractitionerId;
  readonly specialty?: string;
}

/** Why a booked appointment no longer counts (FHIR `Appointment.status`). */
export const APPOINTMENT_WITHDRAWAL_REASONS = ['cancelled', 'no_show', 'entered_in_error'] as const;
export type AppointmentWithdrawalReason = (typeof APPOINTMENT_WITHDRAWAL_REASONS)[number];

/**
 * A booked appointment will not happen or did not happen: cancelled, the
 * patient did not show up, or it was entered in error. Whatever its booking
 * fulfilled is open again.
 */
export interface AppointmentCancelledEvent extends ClinicalEventBase {
  readonly type: 'appointment.cancelled';
  readonly scheduledFor: Date;
  /** Absent means `cancelled`. */
  readonly reason?: AppointmentWithdrawalReason;
}

/** A lab, imaging or other order was placed (FHIR `ServiceRequest`). */
export interface ServiceRequestCreatedEvent extends ClinicalEventBase {
  readonly type: 'service_request.created';
  readonly orderId: string;
  readonly code: Coding;
  readonly category: ServiceCategory;
}

/** A result arrived (FHIR `DiagnosticReport` / `Observation`). */
export interface ResultReceivedEvent extends ClinicalEventBase {
  readonly type: 'result.received';
  /** The order it answers (`basedOn`), when the host links it. */
  readonly basedOnOrderId?: string;
  readonly code: Coding;
  readonly interpretation: ResultInterpretation;
  /** Present for abnormal results: `critical` for a panic value, else `mild`. */
  readonly severity?: ResultSeverity;
  /** Numeric value (FHIR `Observation.valueQuantity`), when the result has one. */
  readonly value?: { readonly value: number; readonly unit?: string };
}

/** A medication was prescribed (FHIR `MedicationRequest`). */
export interface MedicationPrescribedEvent extends ClinicalEventBase {
  readonly type: 'medication.prescribed';
  readonly medication: { readonly code?: Coding; readonly text: string };
  readonly startAt: Date;
  /** Days the prescription covers (`dispenseRequest.expectedSupplyDuration` or the dosage bounds). */
  readonly durationDays?: number;
  /** Refills allowed after the first dispense (`dispenseRequest.numberOfRepeatsAllowed`). */
  readonly refills?: number;
  /** Taken only when needed (FHIR `dosageInstruction.asNeeded[x]`). */
  readonly asNeeded?: boolean;
  /** Free-text dosage as the prescriber wrote it (`dosageInstruction.text`), for example `c/8h PRN dolor`. */
  readonly dosageText?: string;
}

/** A diagnosis was recorded (FHIR `Condition`). */
export interface ConditionRecordedEvent extends ClinicalEventBase {
  readonly type: 'condition.recorded';
  /** ICD-10 code ({@link ICD10_SYSTEM}). */
  readonly code: Coding;
  readonly verification: ConditionVerification;
  /** When the diagnosis was read from a note: the verbatim quote that supports it. */
  readonly evidence?: Evidence;
}

/** A clinical note arrived (FHIR `DocumentReference`). */
export interface NoteReceivedEvent extends ClinicalEventBase {
  readonly type: 'note.received';
  readonly documentId: string;
  /** Plain text of the note. Synthetic in this repository. */
  readonly text: string;
  readonly specialty?: string;
  readonly authoredAt: Date;
  /**
   * Notes this one replaces (FHIR `relatesTo.code = replaces`): their plan
   * gives way to this note's. A new version of the same note replaces the
   * previous version without saying so.
   */
  readonly replacesDocumentIds?: readonly string[];
}

/** One follow-up the doctor wrote in the plan section of a note. */
export interface PlanItem {
  readonly kind: PlanItemKind;
  /** Short English description, for example `repeat HbA1c`. */
  readonly description: string;
  readonly dueAt: Date;
  /** Verbatim quote from the note that supports the item. */
  readonly evidenceQuote: string;
  /** Model confidence, 0 to 1. */
  readonly confidence: number;
  /** Optional code when the model could map the item (LOINC, CPT, ...). */
  readonly code?: Coding;
}

/** The LLM read the doctor's plan out of a note. */
export interface PlanExtractedEvent extends ClinicalEventBase {
  readonly type: 'plan.extracted';
  readonly sourceDocumentId: string;
  readonly items: readonly PlanItem[];
  /** The note discharged the patient from this specialty ("alta"): no visit pattern after it. */
  readonly discharged?: boolean;
  /** Which model and prompt produced the items, for provenance. */
  readonly extractor: { readonly model: string; readonly promptVersion: string };
  /** The note's `replacesDocumentIds`: their plan items give way to these. */
  readonly replacesDocumentIds?: readonly string[];
}

/**
 * The patient asked not to be contacted. The clinic keeps following them up
 * (expectations and cases go on); the engine never asks the host to contact
 * them again.
 */
export interface PatientOptedOutEvent extends ClinicalEventBase {
  readonly type: 'patient.opted_out';
}

/**
 * Why a resource the host sent before no longer stands: an order revoked, a
 * prescription stopped or cancelled, a diagnosis refuted, a note superseded,
 * anything entered in error, or a resource moved to another patient (its
 * subject was corrected).
 */
export const RECORD_WITHDRAWAL_REASONS = [
  'revoked',
  'stopped',
  'cancelled',
  'refuted',
  'superseded',
  'entered_in_error',
  'subject_changed',
] as const;
export type RecordWithdrawalReason = (typeof RECORD_WITHDRAWAL_REASONS)[number];

/**
 * A resource the host sent before was withdrawn (`source` is that
 * resource). What the engine derived from it is withdrawn too: expectations
 * it triggered are cancelled (`source_withdrawn`), what it fulfilled is open
 * again, a condition it alone recorded no longer enrolls the patient, and
 * the rest of the engine ignores its earlier events.
 */
export interface RecordWithdrawnEvent extends ClinicalEventBase {
  readonly type: 'record.withdrawn';
  readonly reason: RecordWithdrawalReason;
}

/** Withdrawals that mean the fact was never true (not just that it ended). */
export const RETRACTING_WITHDRAWAL_REASONS: ReadonlySet<RecordWithdrawalReason> = new Set([
  'refuted',
  'entered_in_error',
  'subject_changed',
]);

/** A normalized clinical fact. Discriminated by `type`. */
export type ClinicalEvent =
  | EncounterFinishedEvent
  | AppointmentBookedEvent
  | AppointmentCancelledEvent
  | ServiceRequestCreatedEvent
  | ResultReceivedEvent
  | MedicationPrescribedEvent
  | ConditionRecordedEvent
  | NoteReceivedEvent
  | PlanExtractedEvent
  | PatientOptedOutEvent
  | RecordWithdrawnEvent;

/** The event variant with the given `type`. */
export type ClinicalEventOf<TType extends ClinicalEventType> = Extract<
  ClinicalEvent,
  { readonly type: TType }
>;

/**
 * What the ingestion pipeline hands to the annotator: the events of one
 * FHIR transaction Bundle, usually one saved consultation (Encounter + note
 * + orders + prescriptions + conditions). The annotator processes a batch as
 * a unit: rules first, then the LLM plan, then protocols fill only what the
 * plan did not cover.
 */
export interface ClinicalBatch {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly encounterId?: string;
  readonly receivedAt: Date;
  readonly events: readonly ClinicalEvent[];
}
