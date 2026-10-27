import { ENGINE_CODE_SYSTEMS, FOLLOW_UP_OPT_OUT_CONSENT_CODE } from '@follow-up-engine/fhir';

/** Synthetic FHIR bundles for host events the consultation builder does not cover. */

function transaction(resource: { readonly resourceType: string; readonly id: string }) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      { resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } },
    ],
  };
}

/** An Appointment booked at `bookedAt` for `start`, or the same Appointment cancelled at `cancelledAt`. */
export function appointmentBundle(input: {
  readonly id: string;
  readonly patientId: string;
  readonly specialty: string;
  readonly start: Date;
  readonly bookedAt: Date;
  readonly cancelledAt?: Date;
}): unknown {
  const cancelled = input.cancelledAt !== undefined;
  return transaction({
    resourceType: 'Appointment',
    id: input.id,
    meta: {
      versionId: cancelled ? '2' : '1',
      lastUpdated: (input.cancelledAt ?? input.bookedAt).toISOString(),
    },
    status: cancelled ? 'cancelled' : 'booked',
    specialty: [{ coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: input.specialty }] }],
    start: input.start.toISOString(),
    end: new Date(input.start.getTime() + 30 * 60_000).toISOString(),
    created: input.bookedAt.toISOString(),
    participant: [
      {
        actor: { reference: `Patient/${input.patientId}` },
        status: cancelled ? 'declined' : 'accepted',
      },
    ],
  } as { resourceType: string; id: string });
}

/** The patient asks not to be contacted about follow-up (FHIR `Consent`, provision deny). */
export function optOutBundle(input: {
  readonly id: string;
  readonly patientId: string;
  readonly at: Date;
}): unknown {
  return transaction({
    resourceType: 'Consent',
    id: input.id,
    status: 'active',
    scope: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' },
      ],
    },
    category: [
      { coding: [{ system: ENGINE_CODE_SYSTEMS.consent, code: FOLLOW_UP_OPT_OUT_CONSENT_CODE }] },
    ],
    patient: { reference: `Patient/${input.patientId}` },
    dateTime: input.at.toISOString(),
    provision: { type: 'deny' },
  } as { resourceType: string; id: string });
}
