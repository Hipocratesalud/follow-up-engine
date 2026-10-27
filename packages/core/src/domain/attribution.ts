import type { CaseId, ContactRequestId } from './ids.ts';

/**
 * Where a booked appointment came from, from the engine's point of view:
 *
 * - `follow_up_case`: the clinic team booked it while working a case (the
 *   host says which case `Task`).
 * - `patient_contact`: the patient booked it after a contact attempt the
 *   engine asked for (the host names the `CommunicationRequest`).
 * - `organic`: nothing ties it to a case. It still counts when it fulfills a
 *   case's reasons (an "organic" resolution).
 */
export const APPOINTMENT_ORIGIN_TYPES = ['follow_up_case', 'patient_contact', 'organic'] as const;
export type AppointmentOriginType = (typeof APPOINTMENT_ORIGIN_TYPES)[number];

/** Origins that tie a booking to a case (the engine can claim it). */
export const ATTRIBUTED_ORIGIN_TYPES: ReadonlySet<AppointmentOriginType> = new Set([
  'follow_up_case',
  'patient_contact',
]);

/**
 * The origin of an `appointment.booked` event. On the way in it is what the
 * host claims (FHIR `Appointment.basedOn`, `supportingInformation` or the
 * `follow-up-origin-case` extension); the engine verifies it against its own
 * cases and contact attempts before storing the event, and stores a claim it
 * cannot verify (unknown id, another clinic or another patient) as `organic`
 * with `unverified: true`.
 */
export interface AppointmentOrigin {
  readonly type: AppointmentOriginType;
  /** The case the booking answers (`follow_up_case`, `patient_contact`). */
  readonly caseId?: CaseId;
  /** The contact attempt that led to it (`patient_contact`). */
  readonly contactRequestId?: ContactRequestId;
  /** The host claimed an origin the engine could not verify. */
  readonly unverified?: true;
}

/** Whether a booking origin ties it to a case. */
export function isAttributedOrigin(origin: AppointmentOrigin | undefined): boolean {
  return origin !== undefined && ATTRIBUTED_ORIGIN_TYPES.has(origin.type);
}

/** Payload of the `appointment_booked` case event (ids and codes only). */
export interface AppointmentBookedCasePayload {
  readonly appointmentId: string;
  readonly originType: AppointmentOriginType;
  readonly scheduledFor: string;
  /** How many of the case's reasons the booking fulfilled when it arrived. */
  readonly fulfilledReasons: number;
  readonly contactRequestId?: string;
}

/** Payload of the `appointment_attended` case event (ids and codes only). */
export interface AppointmentAttendedCasePayload {
  readonly appointmentId: string;
  /** The visit that kept the booking (FHIR `Encounter` id). */
  readonly encounterId: string;
  readonly originType: AppointmentOriginType;
}
