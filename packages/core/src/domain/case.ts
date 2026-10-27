import type { Origin } from './common.ts';
import type { CaseId, ClinicId, ExpectationId, FeedbackId, PatientId } from './ids.ts';
import type { JsonObject } from '../shared/json.ts';

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

/** Statuses in which a case is still being worked. At most one active case per `dedupKey`. */
export const ACTIVE_CASE_STATUSES = [
  'open',
  'notified',
  'snoozed',
  'escalated',
] as const satisfies readonly CaseStatus[];
export type ActiveCaseStatus = (typeof ACTIVE_CASE_STATUSES)[number];

/** One unmet expectation grouped into a case. */
export interface CaseReason {
  readonly expectationId: ExpectationId;
  readonly reasonCode: string;
}

export type CaseResolutionKind =
  'fulfilled' | 'handled_outside' | 'not_needed' | 'patient_declined' | 'patient_unreachable';

export interface CaseResolution {
  readonly kind: CaseResolutionKind;
  readonly resolvedAt: Date;
  /** Host user id of whoever resolved it; absent when the engine did. */
  readonly resolvedBy?: string;
  readonly note?: string;
}

/**
 * What the clinic sees and works: the unmet expectations of one patient for
 * one reason, grouped so the team gets one item instead of an alert per
 * order. Persisted and exposed as a FHIR `Task`.
 */
export interface FollowUpCase {
  readonly id: CaseId;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** Groups expectations into one case, for example `<patientId>:<reason group>`. */
  readonly dedupKey: string;
  readonly reasons: readonly CaseReason[];
  readonly status: CaseStatus;
  /** Higher is more urgent. Drives inbox ordering. */
  readonly priority: number;
  /** Host user id of the person working the case. */
  readonly assignee?: string;
  /** Index into the rule's escalation policy; 0 before any escalation. */
  readonly escalationStep: number;
  /** When the worker should next look at the case (escalation, reminder). */
  readonly nextActionAt?: Date;
  readonly snoozedUntil?: Date;
  /** When a backfill case becomes visible in the inbox (staggered release). */
  readonly releaseAt?: Date;
  readonly origin: Origin;
  readonly resolution?: CaseResolution;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CaseEventType =
  | 'opened'
  | 'reason_added'
  | 'released'
  | 'notified'
  | 'assigned'
  | 'snoozed'
  | 'escalated'
  | 'patient_contact_requested'
  | 'resolved'
  | 'dismissed'
  | 'reopened'
  | 'lost_to_follow_up'
  | 'feedback_recorded';

/** Who caused a case event. `id` is a rule id, host user id or patient id. */
export interface CaseEventActor {
  readonly type: 'rule' | 'user' | 'patient' | 'system';
  readonly id?: string;
}

/** Audit trail entry of a case. Append-only. */
export interface CaseEvent {
  readonly clinicId: ClinicId;
  readonly caseId: CaseId;
  readonly type: CaseEventType;
  readonly actor: CaseEventActor;
  /**
   * Structured context. The only free text is `note`, the internal note a
   * clinic user wrote with an action (shown to the team, never sent out).
   */
  readonly payload: JsonObject;
  readonly at: Date;
}

export type CaseFeedbackReason =
  'wrong_rule' | 'wrong_interval' | 'bad_extraction' | 'already_handled' | 'other';

/** A clinician's verdict on a case. Ground truth for evals and rule tuning. */
export interface CaseFeedback {
  readonly id: FeedbackId;
  readonly clinicId: ClinicId;
  readonly caseId: CaseId;
  readonly useful: boolean;
  readonly reason?: CaseFeedbackReason;
  readonly comment?: string;
  /** Host user id of the author. */
  readonly authorId?: string;
  readonly createdAt: Date;
}
