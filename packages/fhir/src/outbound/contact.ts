import {
  type CaseStatus,
  type ContactChannel,
  type ContactCommunication,
  type ContactOutcome,
  type ContactRequest,
  isActiveSuppression,
  type PatientContactPurpose,
  type RuleSuppression,
  summarizeAttempt,
  UNREACHED_OUTCOMES,
} from '@follow-up-engine/core';
import type {
  CodeableConcept,
  Communication,
  CommunicationRequest,
  Extension,
  Flag,
  Reference,
} from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  ENGINE_IDENTIFIER_SYSTEMS,
  FOLLOW_UP_SUPPRESSION_FLAG_CODE,
  TERMINOLOGY,
} from '../terminology.ts';
import {
  concept,
  ext,
  hostUserReference,
  patientReference,
  referenceTo,
  taskReference,
} from './elements.ts';

/** The HL7 v3 ParticipationMode of each channel, when one fits (WhatsApp and SMS are online writing). */
const PARTICIPATION_MODE: Readonly<Record<ContactChannel, string>> = {
  whatsapp: 'ONLINEWRIT',
  sms: 'ONLINEWRIT',
  email: 'EMAILWRIT',
  phone_call: 'PHONE',
};

/** Generic, diagnosis-free description of each purpose (`CommunicationRequest.payload`). */
export const CONTACT_PURPOSE_TEXT: Readonly<Record<PatientContactPurpose, string>> = {
  schedule_follow_up: 'Ask the patient to schedule their follow-up visit.',
  complete_pending_test: 'Ask the patient to complete a pending test.',
  review_results: 'Ask the patient to come to review their results.',
  medication_review: 'Ask the patient to come to review their treatment.',
};

/** `medium` of a channel: the engine's code, plus the HL7 v3 ParticipationMode. */
export function channelConcept(channel: ContactChannel): CodeableConcept {
  return {
    coding: [
      { system: ENGINE_CODE_SYSTEMS.contactChannel, code: channel },
      { system: TERMINOLOGY.participationMode, code: PARTICIPATION_MODE[channel] },
    ],
  };
}

/** The engine itself as the requester of an automatic attempt. */
function engineReference(): Reference {
  return {
    type: 'Device',
    identifier: { system: ENGINE_IDENTIFIER_SYSTEMS.engine, value: 'follow-up-engine' },
    display: 'Follow-up Engine',
  };
}

export function contactRequestReference(requestId: string): Reference {
  return referenceTo({ resourceType: 'CommunicationRequest', id: requestId });
}

/**
 * `CommunicationRequest.status` of an attempt: `completed` once something
 * conclusive came of it (the patient answered, or could not be reached),
 * `revoked` when its case closed before that, `active` otherwise.
 */
export function contactRequestStatus(
  request: ContactRequest,
  communications: readonly ContactCommunication[],
  caseStatus: CaseStatus | undefined,
): CommunicationRequest['status'] {
  const summary = summarizeAttempt(request, communications);
  const concluded =
    summary.answered || (summary.outcome !== undefined && UNREACHED_OUTCOMES.has(summary.outcome));
  if (concluded) {
    return 'completed';
  }
  const closed =
    caseStatus === 'resolved' || caseStatus === 'dismissed' || caseStatus === 'lost_to_follow_up';
  return closed ? 'revoked' : 'active';
}

/**
 * A contact attempt as a FHIR `CommunicationRequest`: `basedOn` the case
 * `Task`, `payload` a generic purpose only (never clinical content),
 * `medium` the channel hint (absent: the host chooses), `authoredOn` when it
 * was asked, `occurrenceDateTime` the answer deadline.
 */
export function contactRequestToFhir(
  request: ContactRequest,
  context: {
    readonly communications?: readonly ContactCommunication[];
    readonly caseStatus?: CaseStatus;
  } = {},
): CommunicationRequest {
  const extension: Extension[] = [
    ...ext.integer(ENGINE_EXTENSIONS.contactAttempt, request.attempt),
    ...ext.code(ENGINE_EXTENSIONS.contactTrigger, request.trigger),
    ...ext.integer(ENGINE_EXTENSIONS.escalationStep, request.policyStep),
  ];
  return {
    resourceType: 'CommunicationRequest',
    id: toFhirId(request.id),
    extension,
    basedOn: [taskReference(request.caseId)],
    status: contactRequestStatus(request, context.communications ?? [], context.caseStatus),
    category: [concept(ENGINE_CODE_SYSTEMS.contactPurpose, request.purpose)],
    priority: 'routine',
    ...(request.channel === undefined ? {} : { medium: [channelConcept(request.channel)] }),
    subject: patientReference(request.patientId),
    recipient: [patientReference(request.patientId)],
    payload: [{ contentString: CONTACT_PURPOSE_TEXT[request.purpose] }],
    occurrenceDateTime: toFhirInstant(request.dueBy),
    authoredOn: toFhirInstant(request.requestedAt),
    requester:
      request.requestedBy === undefined
        ? engineReference()
        : hostUserReference(request.requestedBy),
  };
}

function outcomeConcept(outcome: ContactOutcome): CodeableConcept {
  return concept(ENGINE_CODE_SYSTEMS.contactOutcome, outcome);
}

/**
 * What came of an attempt as a FHIR `Communication`: `basedOn` the
 * `CommunicationRequest`, `about` the case `Task`, the outcome in the
 * `contact-outcome` extension (and in `statusReason` when it could not
 * reach the patient). A call recorded in the inbox has the clinic user as
 * `sender`.
 */
export function communicationToFhir(communication: ContactCommunication): Communication {
  const { outcome } = communication;
  return {
    resourceType: 'Communication',
    id: toFhirId(communication.id),
    ...(communication.versionId === undefined && communication.lastUpdated === undefined
      ? {}
      : {
          meta: {
            ...(communication.versionId === undefined
              ? {}
              : { versionId: communication.versionId }),
            ...(communication.lastUpdated === undefined
              ? {}
              : { lastUpdated: toFhirInstant(communication.lastUpdated) }),
          },
        }),
    ...(outcome === undefined
      ? {}
      : {
          extension: [
            {
              url: ENGINE_EXTENSIONS.contactOutcome,
              valueCodeableConcept: outcomeConcept(outcome),
            },
          ],
        }),
    basedOn: [contactRequestReference(communication.requestId)],
    status: communication.status,
    ...(outcome !== undefined && UNREACHED_OUTCOMES.has(outcome)
      ? { statusReason: outcomeConcept(outcome) }
      : {}),
    ...(communication.channel === undefined
      ? {}
      : { medium: [channelConcept(communication.channel)] }),
    subject: patientReference(communication.patientId),
    about: [taskReference(communication.caseId)],
    ...(communication.sentAt === undefined ? {} : { sent: toFhirInstant(communication.sentAt) }),
    ...(communication.receivedAt === undefined
      ? {}
      : { received: toFhirInstant(communication.receivedAt) }),
    ...(communication.sender.type === 'user' && communication.sender.id !== undefined
      ? { sender: hostUserReference(communication.sender.id) }
      : {}),
  };
}

/**
 * A per-patient rule suppression as a FHIR `Flag` (category
 * `follow-up-suppression`): `code` the rule (in the expectation CodeSystem,
 * with its label), `status` `active` until reactivated (`inactive`, with
 * `period.end`), the dismissal reason, source case and note in extensions.
 */
export function suppressionToFlag(suppression: RuleSuppression): Flag {
  const active = isActiveSuppression(suppression);
  return {
    resourceType: 'Flag',
    id: toFhirId(suppression.id),
    extension: [
      ...ext.code(ENGINE_EXTENSIONS.dismissReason, suppression.dismissReason),
      ...ext.reference(
        ENGINE_EXTENSIONS.sourceCase,
        suppression.caseId === undefined ? undefined : taskReference(suppression.caseId),
      ),
      ...ext.string(ENGINE_EXTENSIONS.note, suppression.note),
      ...ext.string(ENGINE_EXTENSIONS.revokedBy, suppression.revokedBy),
    ],
    status: active ? 'active' : 'inactive',
    category: [
      concept(
        ENGINE_CODE_SYSTEMS.flagCategory,
        FOLLOW_UP_SUPPRESSION_FLAG_CODE,
        'Follow-up reminder suppressed for this patient',
      ),
    ],
    code: {
      coding: [
        {
          system: ENGINE_CODE_SYSTEMS.expectation,
          code: suppression.ruleId,
          display: suppression.reason.label,
        },
      ],
      text: suppression.reason.label,
    },
    subject: patientReference(suppression.patientId),
    period: {
      start: toFhirInstant(suppression.createdAt),
      ...(suppression.revokedAt === undefined ? {} : { end: toFhirInstant(suppression.revokedAt) }),
    },
    ...(suppression.createdBy === undefined
      ? {}
      : { author: hostUserReference(suppression.createdBy) }),
  };
}
