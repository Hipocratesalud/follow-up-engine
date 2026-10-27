import type {
  AppointmentAttendedCasePayload,
  AppointmentBookedCasePayload,
  AppointmentOrigin,
  AppointmentOriginType,
} from '../../domain/attribution.ts';
import type { CaseEvent, CaseEventActor } from '../../domain/case.ts';
import type { AppointmentBookedEvent, ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { type PatientTimeline, refKey } from '../timeline.ts';

/**
 * HIP-141 attribution: which bookings the engine can claim.
 *
 * The host says where a booking came from on the FHIR `Appointment` (the
 * case `Task`, the `CommunicationRequest` it answers). The engine never
 * trusts that blindly: a claim counts only for a case or contact attempt of
 * the same clinic and the same patient. What it cannot verify is stored as
 * `organic` with `unverified: true`, so a host bug never inflates the
 * metrics. A contact attempt names its case, so it wins over a case claimed
 * alongside it.
 */
export async function verifyAppointmentOrigins(
  stores: TransactionalStores,
  clinicId: ClinicId,
  events: readonly ClinicalEvent[],
): Promise<ClinicalEvent[]> {
  const verified: ClinicalEvent[] = [];
  for (const event of events) {
    if (event.type !== 'appointment.booked' || event.origin === undefined) {
      verified.push(event);
      continue;
    }
    verified.push({ ...event, origin: await verifyOrigin(stores, clinicId, event) });
  }
  return verified;
}

async function verifyOrigin(
  stores: TransactionalStores,
  clinicId: ClinicId,
  event: AppointmentBookedEvent,
): Promise<AppointmentOrigin> {
  const claim = event.origin;
  if (claim === undefined || claim.type === 'organic') {
    return claim ?? { type: 'organic' };
  }
  if (claim.contactRequestId !== undefined) {
    const request = await stores.contacts.getRequest(clinicId, claim.contactRequestId);
    if (request?.patientId === event.patientId) {
      return {
        type: 'patient_contact',
        caseId: request.caseId,
        contactRequestId: request.id,
      };
    }
  }
  if (claim.caseId !== undefined) {
    const followUpCase = await stores.cases.get(clinicId, claim.caseId);
    if (followUpCase?.patientId === event.patientId) {
      return { type: 'follow_up_case', caseId: followUpCase.id };
    }
  }
  return { type: 'organic', unverified: true };
}

/** The origin type of a booking (absent origin: `organic`). */
export function originTypeOf(event: AppointmentBookedEvent | undefined): AppointmentOriginType {
  return event?.origin?.type ?? 'organic';
}

/**
 * Records on each case the bookings of a batch that concern it: a booking
 * attributed to the case, and any booking that fulfilled one of its reasons
 * (attributed or not: an unattributed one is an `organic` resolution).
 * Audited once per case, appointment and date (a re-delivery adds nothing;
 * a reschedule is a new booking). Called before resolving the cases, so
 * the trail reads "booked", then "resolved".
 */
export async function recordCaseBookings(input: {
  readonly stores: TransactionalStores;
  readonly clinicId: ClinicId;
  readonly events: readonly ClinicalEvent[];
  readonly closed: readonly { readonly expectation: Expectation }[];
  readonly now: Date;
}): Promise<void> {
  const { stores, clinicId } = input;
  for (const event of input.events) {
    if (event.type !== 'appointment.booked') {
      continue;
    }
    const source = refKey(event.source);
    const fulfilled = new Map<CaseId, number>();
    for (const { expectation } of input.closed) {
      if (
        expectation.status === 'fulfilled' &&
        expectation.caseId !== undefined &&
        expectation.closedBy !== undefined &&
        refKey(expectation.closedBy) === source
      ) {
        fulfilled.set(expectation.caseId, (fulfilled.get(expectation.caseId) ?? 0) + 1);
      }
    }
    const attributedCase = event.origin?.type === 'organic' ? undefined : event.origin?.caseId;
    if (attributedCase !== undefined && !fulfilled.has(attributedCase)) {
      fulfilled.set(attributedCase, 0);
    }
    for (const [caseId, fulfilledReasons] of fulfilled) {
      const followUpCase = await stores.cases.get(clinicId, caseId);
      if (followUpCase === undefined) {
        continue;
      }
      // An organic booking recorded on a case it does not fulfill says nothing.
      const originType = caseId === attributedCase ? originTypeOf(event) : 'organic';
      const payload: AppointmentBookedCasePayload = {
        appointmentId: event.source.id,
        originType,
        scheduledFor: event.scheduledFor.toISOString(),
        fulfilledReasons,
        ...(originType === 'patient_contact' && event.origin?.contactRequestId !== undefined
          ? { contactRequestId: event.origin.contactRequestId }
          : {}),
      };
      const trail = await stores.audit.listForCase(clinicId, caseId);
      if (trail.some((entry) => sameBooking(entry, payload))) {
        continue;
      }
      await stores.audit.append(clinicId, {
        clinicId,
        caseId,
        type: 'appointment_booked',
        actor: bookingActor(originType),
        payload: { ...payload },
        at: input.now,
      });
    }
  }
}

function bookingActor(originType: AppointmentOriginType): CaseEventActor {
  return originType === 'patient_contact' ? { type: 'patient' } : { type: 'system' };
}

function sameBooking(entry: CaseEvent, payload: AppointmentBookedCasePayload): boolean {
  return (
    entry.type === 'appointment_booked' &&
    entry.payload['appointmentId'] === payload.appointmentId &&
    entry.payload['scheduledFor'] === payload.scheduledFor
  );
}

/**
 * A booking that fulfilled a case's reason was kept: the visit now fulfills
 * it instead (the recheck at the appointment date plus the grace days).
 * Recorded once per case and appointment as `appointment_attended`, with
 * the booking's origin, so the metrics can tell attributed visits from
 * organic ones.
 */
export async function recordAttendance(input: {
  readonly stores: TransactionalStores;
  readonly expectation: Expectation;
  readonly previous: ResourceRef | undefined;
  readonly event: ClinicalEvent;
  readonly timeline: PatientTimeline;
  readonly now: Date;
}): Promise<void> {
  const { stores, expectation, previous, event } = input;
  const caseId = expectation.caseId;
  if (
    caseId === undefined ||
    previous?.resourceType !== 'Appointment' ||
    event.type !== 'encounter.finished'
  ) {
    return;
  }
  const appointmentKey = refKey(previous);
  const booking = input.timeline.events
    .filter(
      (candidate): candidate is AppointmentBookedEvent =>
        candidate.type === 'appointment.booked' && refKey(candidate.source) === appointmentKey,
    )
    .at(-1);
  const payload: AppointmentAttendedCasePayload = {
    appointmentId: previous.id,
    encounterId: event.source.id,
    // Attributed only to the case the booking was attributed to.
    originType: booking?.origin?.caseId === caseId ? originTypeOf(booking) : 'organic',
  };
  const trail = await stores.audit.listForCase(expectation.clinicId, caseId);
  if (
    trail.some(
      (entry) =>
        entry.type === 'appointment_attended' &&
        entry.payload['appointmentId'] === payload.appointmentId,
    )
  ) {
    return;
  }
  await stores.audit.append(expectation.clinicId, {
    clinicId: expectation.clinicId,
    caseId,
    type: 'appointment_attended',
    actor: { type: 'patient' },
    payload: { ...payload },
    at: input.now,
  });
}
