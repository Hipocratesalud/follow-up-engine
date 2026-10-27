import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import {
  type ContactChannel,
  type ContactRequest,
  type ContactRequestTrigger,
  isMessageChannel,
  type PatientContactPurpose,
} from '../../domain/contact.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { contactRequestId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import type { JsonObject } from '../../shared/json.ts';
import type { CaseWriter } from '../case-manager/case-writer.ts';
import type { Catalog } from '../catalog.ts';
import { addDays } from '../support/time.ts';
import { patientLanguage } from './history.ts';

/** The generic purpose of contacting the patient about a case: its first reason's suggested action. */
export function contactPurpose(
  catalog: Catalog,
  reasons: readonly Expectation[],
): PatientContactPurpose {
  const [first] = reasons;
  return (
    (first === undefined
      ? undefined
      : catalog.definition(first.ruleId)?.suggestedAction.patientContactPurpose) ??
    'schedule_follow_up'
  );
}

export interface OpenAttemptInput {
  readonly followUpCase: FollowUpCase;
  readonly purpose: PatientContactPurpose;
  readonly channel?: ContactChannel | undefined;
  readonly trigger: ContactRequestTrigger;
  readonly answerWindowDays: number;
  readonly actor: CaseEventActor;
  readonly now: Date;
  readonly policyStep?: number;
  /** The team's internal note, kept on the case event only. */
  readonly note?: string;
  /** Extra audit context (the escalation step and action). */
  readonly audit?: JsonObject;
}

/**
 * Opens one contact attempt on a case: stores the `CommunicationRequest`,
 * audits `patient_contact_requested` and, for a message, asks the host to
 * send it (`patient_contact.requested`: ids, a generic purpose, the channel
 * hint and the answer deadline; never clinical content). A call is a task
 * for the clinic team in the inbox: nothing goes to the host.
 */
export async function openContactAttempt(
  context: {
    readonly stores: TransactionalStores;
    readonly writer: CaseWriter;
    readonly ids: IdGenerator;
  },
  input: OpenAttemptInput,
): Promise<ContactRequest> {
  const { stores, writer, ids } = context;
  const { followUpCase, now } = input;
  const previous = await stores.contacts.listRequestsForCase(
    followUpCase.clinicId,
    followUpCase.id,
  );
  const language = await patientLanguage(stores, followUpCase.clinicId, followUpCase.patientId);
  const request: ContactRequest = {
    id: contactRequestId(ids.next('contact_request')),
    clinicId: followUpCase.clinicId,
    patientId: followUpCase.patientId,
    caseId: followUpCase.id,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    purpose: input.purpose,
    trigger: input.trigger,
    attempt: previous.length + 1,
    ...(input.policyStep === undefined ? {} : { policyStep: input.policyStep }),
    ...(input.actor.type === 'user' && input.actor.id !== undefined
      ? { requestedBy: input.actor.id }
      : {}),
    requestedAt: now,
    dueBy: addDays(now, input.answerWindowDays),
    ...(language === undefined ? {} : { language }),
  };
  await stores.contacts.createRequest(followUpCase.clinicId, request);
  await writer.audit(followUpCase, 'patient_contact_requested', input.actor, now, {
    ...input.audit,
    requestId: request.id,
    purpose: request.purpose,
    attempt: request.attempt,
    trigger: request.trigger,
    ...(request.channel === undefined ? {} : { channel: request.channel }),
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  if (isMessageChannel(request.channel)) {
    await writer.emit('patient_contact.requested', now, {
      caseId: followUpCase.id,
      patientId: followUpCase.patientId,
      purpose: request.purpose,
      dueBy: request.dueBy,
      requestId: request.id,
      ...(request.channel === undefined ? {} : { channel: request.channel }),
      attempt: request.attempt,
      ...(request.language === undefined ? {} : { language: request.language }),
    });
  }
  return request;
}

/**
 * Whether the case already has a call to make or made since its last
 * message attempt (a wrong number moved the call forward): the policy's own
 * call step has nothing left to do.
 */
export function callAlreadyRequested(requests: readonly ContactRequest[]): boolean {
  const lastMessage = requests
    .filter((request) => isMessageChannel(request.channel))
    .at(-1)?.requestedAt;
  return requests.some(
    (request) =>
      request.channel === 'phone_call' &&
      (lastMessage === undefined || request.requestedAt.getTime() >= lastMessage.getTime()),
  );
}
