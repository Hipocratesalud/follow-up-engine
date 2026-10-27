import type { CaseResolutionKind } from './case.ts';
import type { Origin, Reason } from './common.ts';
import type { CaseId, ClinicId, PatientId } from './ids.ts';

export const DOMAIN_EVENT_TYPES = [
  'case.opened',
  'case.escalated',
  'case.resolved',
  'patient_contact.requested',
  'backfill.completed',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface CaseOpenedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly reasons: readonly Reason[];
  readonly priority: number;
  readonly origin: Origin;
}

export interface CaseEscalatedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly escalationStep: number;
  readonly priority: number;
}

export interface CaseResolvedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly resolution: CaseResolutionKind;
}

/**
 * Generic, diagnosis-free purpose of a patient contact. The host turns it
 * into its own message (and its own channel, such as WhatsApp).
 */
export const PATIENT_CONTACT_PURPOSES = [
  'schedule_follow_up',
  'complete_pending_test',
  'review_results',
  'medication_review',
] as const;
export type PatientContactPurpose = (typeof PATIENT_CONTACT_PURPOSES)[number];

/**
 * Asks the host to contact the patient. By construction it carries no
 * diagnosis, test name or free text: only ids, a generic purpose and a date.
 */
export interface PatientContactRequestedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly purpose: PatientContactPurpose;
  readonly dueBy?: Date;
}

export interface BackfillCompletedPayload {
  readonly runId: string;
  readonly patientsScanned: number;
  readonly expectationsCreated: number;
  readonly casesOpened: number;
}

interface DomainEventBase<TType extends DomainEventType, TPayload> {
  /** Unique; the host uses it as idempotency key (delivery is at least once). */
  readonly id: string;
  readonly type: TType;
  readonly clinicId: ClinicId;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

/** Outbound event delivered to the host through the outbox and `EventPublisher`. */
export type DomainEvent =
  | DomainEventBase<'case.opened', CaseOpenedPayload>
  | DomainEventBase<'case.escalated', CaseEscalatedPayload>
  | DomainEventBase<'case.resolved', CaseResolvedPayload>
  | DomainEventBase<'patient_contact.requested', PatientContactRequestedPayload>
  | DomainEventBase<'backfill.completed', BackfillCompletedPayload>;

/** The domain event variant with the given `type`. */
export type DomainEventOf<TType extends DomainEventType> = Extract<
  DomainEvent,
  { readonly type: TType }
>;
