import {
  ANSWERED_OUTCOMES,
  CONTACT_OUTCOME_RANK,
  type ContactCommunication,
  type ContactOutcome,
  type ContactRequest,
  isMessageChannel,
  UNREACHED_OUTCOMES,
} from '../../domain/contact.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';

/**
 * One contact attempt and what came of it so far: the strongest outcome
 * reported on it (`CONTACT_OUTCOME_RANK`), whether the patient answered or
 * could not be reached, and when its answer window ends.
 */
export interface AttemptSummary {
  readonly request: ContactRequest;
  readonly communications: readonly ContactCommunication[];
  readonly outcome?: ContactOutcome;
  /** When the outcome that decided the attempt was recorded. */
  readonly outcomeAt?: Date;
  /** The patient answered (replied, booked, declined, treated elsewhere). */
  readonly answered: boolean;
  /**
   * The attempt happened: a message is sent when requested; a call only
   * once the team recorded what came of it.
   */
  readonly made: boolean;
  /**
   * When the attempt stops waiting for an answer: at once when it was
   * answered or could not reach the patient (no answer, wrong number), else
   * its `dueBy`.
   */
  readonly windowEndsAt: Date;
}

/** The outcome a communication still speaks for (one entered in error speaks for nothing). */
function standingOutcome(communication: ContactCommunication): ContactOutcome | undefined {
  return communication.status === 'entered-in-error' ? undefined : communication.outcome;
}

export function summarizeAttempt(
  request: ContactRequest,
  communications: readonly ContactCommunication[],
): AttemptSummary {
  const own = communications.filter((communication) => communication.requestId === request.id);
  let best: { readonly outcome: ContactOutcome; readonly at: Date } | undefined;
  for (const communication of own) {
    const reported = standingOutcome(communication);
    if (
      reported !== undefined &&
      (best === undefined || CONTACT_OUTCOME_RANK[reported] >= CONTACT_OUTCOME_RANK[best.outcome])
    ) {
      best = { outcome: reported, at: communication.recordedAt };
    }
  }
  const outcome = best?.outcome;
  const answered = outcome !== undefined && ANSWERED_OUTCOMES.has(outcome);
  const concluded = answered || (outcome !== undefined && UNREACHED_OUTCOMES.has(outcome));
  const outcomeAt = best?.at;
  return {
    request,
    communications: own,
    ...(outcome === undefined ? {} : { outcome }),
    ...(outcomeAt === undefined ? {} : { outcomeAt }),
    answered,
    made: isMessageChannel(request.channel) || outcome !== undefined,
    windowEndsAt:
      concluded && outcomeAt !== undefined && outcomeAt.getTime() < request.dueBy.getTime()
        ? outcomeAt
        : request.dueBy,
  };
}

/** Every attempt to reach the patient, from any of their cases, oldest first, with what came of it. */
export async function patientAttempts(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<AttemptSummary[]> {
  const requests = await stores.contacts.listRequestsForPatient(clinicId, patientId);
  const communications = await stores.contacts.listCommunicationsForPatient(clinicId, patientId);
  return requests.map((request) => summarizeAttempt(request, communications));
}

/**
 * The last time the host was asked to message this patient, from any of
 * their cases: what the one-message-per-window rule counts. Calls the clinic
 * team makes do not count.
 */
export async function lastPatientContactAt(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<Date | undefined> {
  const requests = await stores.contacts.listRequestsForPatient(clinicId, patientId);
  return requests.filter((request) => isMessageChannel(request.channel)).at(-1)?.requestedAt;
}

/** Whether the patient asked not to be followed up. */
export async function hasOptedOut(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<boolean> {
  const events = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
    types: ['patient.opted_out'],
  });
  return events.length > 0;
}

/** Whether the patient's contact data is flagged (a wrong number) and not cleared since. */
export async function hasInvalidContactData(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<boolean> {
  const flags = await stores.contacts.listFlags(clinicId, patientId);
  return flags.some((flag) => flag.clearedAt === undefined);
}
