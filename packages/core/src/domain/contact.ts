import type { Reason } from './common.ts';
import type { CaseId, ClinicId, ContactRequestId, PatientId, SuppressionId } from './ids.ts';

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
 * How a patient is contacted. Message channels (`whatsapp`, `sms`, `email`)
 * are sent by the host on its own channel; `phone_call` is a task for the
 * clinic team in the inbox ("Llamar al paciente").
 */
export const CONTACT_CHANNELS = ['whatsapp', 'phone_call', 'sms', 'email'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * Whether a contact attempt is a message the host sends (and the
 * one-message-per-patient-per-window rule counts), as opposed to a call the
 * clinic team makes. An attempt without a channel lets the host choose its
 * own messaging channel.
 */
export function isMessageChannel(channel: ContactChannel | undefined): boolean {
  return channel !== 'phone_call';
}

/**
 * What came of a contact attempt, as the host (or the clinic team, for a
 * call) reports it in a FHIR `Communication`. CodeSystem
 * `https://hipocratesalud.com/fhir/CodeSystem/contact-outcome`.
 */
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

/** Outcomes that mean the patient answered: the sequence stops asking. */
export const ANSWERED_OUTCOMES: ReadonlySet<ContactOutcome> = new Set([
  'replied',
  'booked',
  'declined',
  'treated_elsewhere',
]);

/** Outcomes that close an attempt without reaching the patient: its answer window ends at once. */
export const UNREACHED_OUTCOMES: ReadonlySet<ContactOutcome> = new Set([
  'wrong_number',
  'no_answer',
]);

/**
 * How strongly an outcome speaks for its attempt (higher wins). An attempt
 * reported `delivered`, then `read`, then `replied` is `replied`; an
 * out-of-order `delivered` after a `replied` changes nothing.
 */
export const CONTACT_OUTCOME_RANK: Readonly<Record<ContactOutcome, number>> = {
  delivered: 1,
  read: 2,
  no_answer: 3,
  wrong_number: 4,
  replied: 5,
  booked: 6,
  declined: 6,
  treated_elsewhere: 6,
};

/** Why an attempt exists: the case's escalation policy, a clinic user, or a wrong number reported on a message. */
export const CONTACT_REQUEST_TRIGGERS = ['policy', 'user', 'wrong_number'] as const;
export type ContactRequestTrigger = (typeof CONTACT_REQUEST_TRIGGERS)[number];

/**
 * One attempt to reach the patient about a case: exported as a FHIR
 * `CommunicationRequest` (`basedOn` the case `Task`). The engine never
 * writes the message: the host turns `purpose` into its own generic text.
 */
export interface ContactRequest {
  readonly id: ContactRequestId;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly caseId: CaseId;
  /** The channel the policy asks for; absent: the host chooses its messaging channel. */
  readonly channel?: ContactChannel;
  readonly purpose: PatientContactPurpose;
  readonly trigger: ContactRequestTrigger;
  /** 1-based attempt number within the case. */
  readonly attempt: number;
  /** Index of the escalation step that asked for it (`trigger: 'policy'`). */
  readonly policyStep?: number;
  /** Host user id of whoever asked for it (`trigger: 'user'`). */
  readonly requestedBy?: string;
  readonly requestedAt: Date;
  /** End of the answer window: no answer by then counts as unanswered. */
  readonly dueBy: Date;
}

/** FHIR `Communication.status` values the engine accepts (R4 event status). */
export const COMMUNICATION_STATUSES = [
  'preparation',
  'in-progress',
  'not-done',
  'on-hold',
  'stopped',
  'completed',
  'entered-in-error',
  'unknown',
] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

/** Who recorded a communication: the host integration, or a clinic user in the inbox (a call). */
export interface CommunicationSender {
  readonly type: 'host' | 'user';
  readonly id?: string;
}

/**
 * What happened on one attempt, reported by the host as a FHIR
 * `Communication` (`basedOn` the `CommunicationRequest`), or recorded by a
 * clinic user for a call. Stored at its latest version: a re-sent version
 * changes nothing, an older one is ignored.
 */
export interface ContactCommunication {
  /** The `Communication` id (the host's, or the engine's for a call recorded in the inbox). */
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly caseId: CaseId;
  readonly requestId: ContactRequestId;
  readonly channel?: ContactChannel;
  readonly status: CommunicationStatus;
  /** Absent for a status-only update (for example `in-progress`). */
  readonly outcome?: ContactOutcome;
  readonly sentAt?: Date;
  readonly receivedAt?: Date;
  readonly sender: CommunicationSender;
  /** FHIR `meta.versionId` of the stored version (numeric when the host sends it). */
  readonly versionId?: string;
  /** FHIR `meta.lastUpdated` of the stored version. */
  readonly lastUpdated?: Date;
  /** When the engine recorded this version. */
  readonly recordedAt: Date;
}

/** Why the engine stopped trusting a patient's contact data. */
export type ContactDataIssue = 'wrong_number';

/**
 * The patient's contact data looks wrong (a message or call reached the
 * wrong person). Shown on the patient page; message attempts are skipped
 * while it stands and calls go ahead. Cleared when a later attempt reaches
 * the patient.
 */
export interface PatientContactFlag {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly issue: ContactDataIssue;
  readonly raisedAt: Date;
  /** The communication that reported it. */
  readonly communicationId: string;
  readonly channel?: ContactChannel;
  readonly clearedAt?: Date;
}

/** Why a clinic user dismissed a case ("Descartar"). Required. */
export const DISMISS_REASONS = [
  'handled_elsewhere',
  'already_done',
  'not_applicable_to_patient',
  'wrong_diagnosis',
  'wrong_interval',
  'other',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/**
 * A rule or protocol item that no longer applies to one patient ("Dejar de
 * recordarlo para este paciente"): while active, no layer creates an
 * expectation of `ruleId` for the patient (live ingestion, protocols,
 * cadence and the backfill alike). Other patients are unaffected. Audited
 * (who, when, why) and reversible; exported as a FHIR `Flag`.
 */
export interface RuleSuppression {
  readonly id: SuppressionId;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** A rule id, or `protocol_<protocolId>_<itemKey>` for a protocol item. */
  readonly ruleId: string;
  /** The rule's reason when suppressed, to show the suppression without the catalog. */
  readonly reason: Reason;
  readonly dismissReason: DismissReason;
  /** The team's internal note (never sent out). */
  readonly note?: string;
  /** The dismissed case it came from, if any. */
  readonly caseId?: CaseId;
  /** Host user id. */
  readonly createdBy?: string;
  readonly createdAt: Date;
  readonly revokedBy?: string;
  readonly revokedAt?: Date;
}

export function isActiveSuppression(suppression: RuleSuppression): boolean {
  return suppression.revokedAt === undefined;
}

const NUMERIC_VERSION = /^\d{1,15}$/;

function sameContent(left: ContactCommunication, right: ContactCommunication): boolean {
  return (
    left.status === right.status &&
    left.outcome === right.outcome &&
    left.channel === right.channel &&
    left.sentAt?.getTime() === right.sentAt?.getTime() &&
    left.receivedAt?.getTime() === right.receivedAt?.getTime()
  );
}

/**
 * How a reported version of a communication compares with the stored one:
 * `-1` older (not stored), `0` the same (a re-delivery), `1` newer. By
 * numeric `versionId`, else `lastUpdated` (like `isOlderResourceVersion`);
 * without either, a different content is newer.
 */
export function compareCommunicationVersions(
  incoming: ContactCommunication,
  stored: ContactCommunication,
): -1 | 0 | 1 {
  const { versionId: incomingVersion } = incoming;
  const { versionId: storedVersion } = stored;
  if (
    incomingVersion !== undefined &&
    storedVersion !== undefined &&
    NUMERIC_VERSION.test(incomingVersion) &&
    NUMERIC_VERSION.test(storedVersion)
  ) {
    return Math.sign(Number(incomingVersion) - Number(storedVersion)) as -1 | 0 | 1;
  }
  if (incoming.lastUpdated !== undefined && stored.lastUpdated !== undefined) {
    const order = Math.sign(incoming.lastUpdated.getTime() - stored.lastUpdated.getTime());
    if (order !== 0) {
      return order as -1 | 1;
    }
  }
  return sameContent(incoming, stored) ? 0 : 1;
}
