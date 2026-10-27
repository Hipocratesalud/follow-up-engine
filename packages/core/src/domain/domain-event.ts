import type { BackfillCounts } from './backfill.ts';
import type { CaseResolutionKind } from './case.ts';
import type { Origin, Reason } from './common.ts';
import type { CaseId, ClinicId, PatientId } from './ids.ts';

export const DOMAIN_EVENT_TYPES = [
  'case.opened',
  'case.escalated',
  'case.resolved',
  'patient_contact.requested',
  'backfill.completed',
  'backfill.paused',
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
  /**
   * The patient's preferred language (BCP-47, from `Patient.communication`):
   * the host writes its message in it. Absent: the host did not state one
   * (the host falls back to the clinic's language).
   */
  readonly language?: string;
}

/** The initial backfill finished: every counter of the run. */
export interface BackfillCompletedPayload extends BackfillCounts {
  readonly runId: string;
  /** Shadow run: computed and stored, nothing scheduled for release. */
  readonly shadow: boolean;
  /** Cases given a release day (staggered by the daily cap per owner). */
  readonly casesScheduled: number;
  /** Cases too old to notify: listed among the patients to recover only. */
  readonly casesNotNotified: number;
}

/** Alert: the backfill stopped before the end (the clinic's LLM budget ran out) and resumes later. */
export interface BackfillPausedPayload extends BackfillCounts {
  readonly runId: string;
  readonly reason: 'llm_budget_exceeded';
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
  | DomainEventBase<'backfill.completed', BackfillCompletedPayload>
  | DomainEventBase<'backfill.paused', BackfillPausedPayload>;

/** The domain event variant with the given `type`. */
export type DomainEventOf<TType extends DomainEventType> = Extract<
  DomainEvent,
  { readonly type: TType }
>;
