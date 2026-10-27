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
}

export type ServiceCategory = 'laboratory' | 'imaging' | 'other';
export type ResultInterpretation = 'normal' | 'abnormal' | 'unknown';
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

/** A booked appointment was cancelled. */
export interface AppointmentCancelledEvent extends ClinicalEventBase {
  readonly type: 'appointment.cancelled';
  readonly scheduledFor: Date;
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
}

/**
 * The patient asked not to be contacted. The clinic keeps following them up
 * (expectations and cases go on); the engine never asks the host to contact
 * them again.
 */
export interface PatientOptedOutEvent extends ClinicalEventBase {
  readonly type: 'patient.opted_out';
}

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
  | PatientOptedOutEvent;

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
