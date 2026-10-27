import type { BackfillCounts } from './backfill.ts';
import type { CaseResolutionKind } from './case.ts';
import type { Origin, Reason } from './common.ts';
import type { ContactChannel, ContactOutcome, PatientContactPurpose } from './contact.ts';
import type { CaseId, ClinicId, ContactRequestId, PatientId } from './ids.ts';
import type { ReconciliationCounts, ReconciliationScope } from './reconciliation.ts';

export const DOMAIN_EVENT_TYPES = [
  'case.opened',
  'case.escalated',
  'case.resolved',
  'patient_contact.requested',
  'contact.outcome_recorded',
  'backfill.completed',
  'backfill.paused',
  'clinical_finding.created',
  'reconciliation.completed',
  'reconciliation.repairs_found',
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
 * Asks the host to contact the patient. By construction it carries no
 * diagnosis, test name or free text: only ids, a generic purpose and a date.
 */
export interface PatientContactRequestedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly purpose: PatientContactPurpose;
  readonly dueBy?: Date;
  /** The attempt (FHIR `CommunicationRequest`) the host reports back on with a `Communication`. */
  readonly requestId?: ContactRequestId;
  /** Channel hint of the policy step; absent: the host chooses. Never `phone_call` (an inbox task). */
  readonly channel?: ContactChannel;
  /** 1-based attempt number within the case. */
  readonly attempt?: number;
}

/**
 * A clinic user recorded what came of a call in the inbox. Sent so the host,
 * which owns the patient's contact data and its own reminders, can act on
 * it (fix a wrong number, stop messaging a patient who booked or declined).
 * Outcomes the host itself reported are not echoed back. Ids and codes only.
 */
export interface ContactOutcomeRecordedPayload {
  readonly caseId: CaseId;
  readonly patientId: PatientId;
  readonly requestId: ContactRequestId;
  readonly communicationId: string;
  readonly channel?: ContactChannel;
  readonly outcome: ContactOutcome;
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

/**
 * A clinical reviewer finding of a category validated for live use. Shadow
 * findings never produce it. Ids and severity only: the host reads the
 * finding as a FHIR `DetectedIssue` with its API key.
 */
export interface ClinicalFindingCreatedPayload {
  readonly findingId: string;
  readonly patientId: PatientId;
  readonly severity: 'low' | 'medium' | 'high';
}

/** The nightly reconciliation finished: how many patients it looked at and what it repaired. */
export interface ReconciliationCompletedPayload extends ReconciliationCounts {
  readonly runId: string;
  readonly scope: ReconciliationScope;
}

/**
 * Alert: the reconciliation found and repaired state that a lost or
 * out-of-order event left inconsistent. Counts only; the repairs are in the
 * audit trail (actor `system`, reason `reconciliation`).
 */
export interface ReconciliationRepairsFoundPayload extends ReconciliationCounts {
  readonly runId: string;
  readonly scope: ReconciliationScope;
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
  | DomainEventBase<'contact.outcome_recorded', ContactOutcomeRecordedPayload>
  | DomainEventBase<'backfill.completed', BackfillCompletedPayload>
  | DomainEventBase<'backfill.paused', BackfillPausedPayload>
  | DomainEventBase<'clinical_finding.created', ClinicalFindingCreatedPayload>
  | DomainEventBase<'reconciliation.completed', ReconciliationCompletedPayload>
  | DomainEventBase<'reconciliation.repairs_found', ReconciliationRepairsFoundPayload>;

/** The domain event variant with the given `type`. */
export type DomainEventOf<TType extends DomainEventType> = Extract<
  DomainEvent,
  { readonly type: TType }
>;
