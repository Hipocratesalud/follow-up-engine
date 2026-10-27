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

const SPECIALTY_SYSTEM = ENGINE_CODE_SYSTEMS.specialty;
const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';

/** A FHIR resource built by these helpers. */
export interface TestResource {
  readonly resourceType: string;
  readonly id: string;
  readonly [field: string]: unknown;
}

interface Versioned {
  /** `meta.versionId`; defaults to `1`. */
  readonly version?: number;
  /** `meta.lastUpdated`. */
  readonly at: Date;
}

function meta(input: Versioned) {
  return { versionId: String(input.version ?? 1), lastUpdated: input.at.toISOString() };
}

/** A transaction Bundle of `PUT` entries. */
export function transactionOf(...resources: readonly TestResource[]): unknown {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource) => ({
      resource,
      request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
    })),
  };
}

/** A finished Encounter of `specialty`, optionally with its treating practitioner. */
export function encounterResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly specialty: string;
    readonly practitionerId?: string;
    readonly status?: 'finished' | 'entered-in-error' | 'cancelled';
  },
): TestResource {
  return {
    resourceType: 'Encounter',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    serviceType: { coding: [{ system: SPECIALTY_SYSTEM, code: input.specialty }] },
    subject: { reference: `Patient/${input.patientId}` },
    ...(input.practitionerId === undefined
      ? {}
      : {
          participant: [
            {
              type: [
                {
                  coding: [
                    {
                      system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                      code: 'PPRF',
                    },
                  ],
                },
              ],
              individual: { reference: `Practitioner/${input.practitionerId}` },
            },
          ],
        }),
    period: { start: input.at.toISOString(), end: input.at.toISOString() },
  };
}

/** A clinical note (DocumentReference) of an encounter. */
export function noteResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly encounterId?: string;
    readonly specialty: string;
    readonly text: string;
    readonly docStatus?: 'final' | 'amended';
    readonly status?: 'current' | 'superseded' | 'entered-in-error';
    /** Ids of DocumentReferences this one replaces (`relatesTo.code = replaces`). */
    readonly replaces?: readonly string[];
  },
): TestResource {
  return {
    resourceType: 'DocumentReference',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'current',
    docStatus: input.docStatus ?? 'final',
    subject: { reference: `Patient/${input.patientId}` },
    date: input.at.toISOString(),
    ...(input.replaces === undefined
      ? {}
      : {
          relatesTo: input.replaces.map((id) => ({
            code: 'replaces',
            target: { reference: `DocumentReference/${id}` },
          })),
        }),
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          data: Buffer.from(input.text, 'utf8').toString('base64'),
        },
      },
    ],
    context: {
      ...(input.encounterId === undefined
        ? {}
        : { encounter: [{ reference: `Encounter/${input.encounterId}` }] }),
      practiceSetting: { coding: [{ system: SPECIALTY_SYSTEM, code: input.specialty }] },
    },
  };
}

/** A laboratory order (ServiceRequest) for a LOINC code. */
export function labOrderResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly loinc: string;
    readonly encounterId?: string;
    readonly status?: 'active' | 'revoked' | 'entered-in-error' | 'completed';
    readonly authoredOn?: Date;
  },
): TestResource {
  return {
    resourceType: 'ServiceRequest',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'active',
    intent: 'order',
    category: [{ coding: [{ system: SNOMED, code: '108252007' }] }],
    code: { coding: [{ system: LOINC, code: input.loinc }] },
    subject: { reference: `Patient/${input.patientId}` },
    ...(input.encounterId === undefined
      ? {}
      : { encounter: { reference: `Encounter/${input.encounterId}` } }),
    authoredOn: (input.authoredOn ?? input.at).toISOString(),
  };
}

/** A lab result (Observation), abnormal when `interpretation` is a v3 abnormal code. */
export function observationResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly loinc: string;
    readonly value: number;
    readonly unit: string;
    readonly interpretation?: 'N' | 'H' | 'HH' | 'L' | 'LL';
    readonly encounterId?: string;
    readonly basedOn?: string;
    readonly status?: 'final' | 'entered-in-error';
  },
): TestResource {
  return {
    resourceType: 'Observation',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'final',
    code: { coding: [{ system: LOINC, code: input.loinc }] },
    subject: { reference: `Patient/${input.patientId}` },
    ...(input.encounterId === undefined
      ? {}
      : { encounter: { reference: `Encounter/${input.encounterId}` } }),
    ...(input.basedOn === undefined
      ? {}
      : { basedOn: [{ reference: `ServiceRequest/${input.basedOn}` }] }),
    effectiveDateTime: input.at.toISOString(),
    issued: input.at.toISOString(),
    valueQuantity: { value: input.value, unit: input.unit },
    ...(input.interpretation === undefined
      ? {}
      : {
          interpretation: [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                  code: input.interpretation,
                },
              ],
            },
          ],
        }),
  };
}

/** A lab report (DiagnosticReport) listing Observations by id, answering an order. */
export function diagnosticReportResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly loinc: string;
    readonly resultIds: readonly string[];
    readonly basedOn?: string;
    readonly status?: 'final' | 'entered-in-error' | 'cancelled';
  },
): TestResource {
  return {
    resourceType: 'DiagnosticReport',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'final',
    code: { coding: [{ system: LOINC, code: input.loinc }] },
    subject: { reference: `Patient/${input.patientId}` },
    ...(input.basedOn === undefined
      ? {}
      : { basedOn: [{ reference: `ServiceRequest/${input.basedOn}` }] }),
    effectiveDateTime: input.at.toISOString(),
    issued: input.at.toISOString(),
    result: input.resultIds.map((id) => ({ reference: `Observation/${id}` })),
  };
}

/** An Appointment in any status, booked at `bookedAt` for `start`. */
export function appointmentResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly specialty?: string;
    readonly practitionerId?: string;
    readonly start: Date;
    readonly bookedAt: Date;
    readonly status?: 'booked' | 'cancelled' | 'noshow' | 'entered-in-error' | 'fulfilled';
  },
): TestResource {
  return {
    resourceType: 'Appointment',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'booked',
    ...(input.specialty === undefined
      ? {}
      : { specialty: [{ coding: [{ system: SPECIALTY_SYSTEM, code: input.specialty }] }] }),
    start: input.start.toISOString(),
    end: new Date(input.start.getTime() + 30 * 60_000).toISOString(),
    created: input.bookedAt.toISOString(),
    participant: [
      { actor: { reference: `Patient/${input.patientId}` }, status: 'accepted' },
      ...(input.practitionerId === undefined
        ? []
        : [{ actor: { reference: `Practitioner/${input.practitionerId}` }, status: 'accepted' }]),
    ],
  };
}

/** A short prescription (MedicationRequest) of `durationDays`. */
export function prescriptionResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly text: string;
    readonly durationDays: number;
    readonly encounterId?: string;
    readonly status?: 'active' | 'stopped' | 'cancelled' | 'entered-in-error';
    readonly authoredOn?: Date;
  },
): TestResource {
  return {
    resourceType: 'MedicationRequest',
    id: input.id,
    meta: meta(input),
    status: input.status ?? 'active',
    intent: 'order',
    medicationCodeableConcept: { text: input.text },
    subject: { reference: `Patient/${input.patientId}` },
    ...(input.encounterId === undefined
      ? {}
      : { encounter: { reference: `Encounter/${input.encounterId}` } }),
    authoredOn: (input.authoredOn ?? input.at).toISOString(),
    dispenseRequest: {
      expectedSupplyDuration: {
        value: input.durationDays,
        unit: 'days',
        system: 'http://unitsofmeasure.org',
        code: 'd',
      },
    },
  };
}

/** A diagnosis (Condition) with an ICD-10 code and a verification status. */
export function conditionResource(
  input: Versioned & {
    readonly id: string;
    readonly patientId: string;
    readonly icd10: string;
    readonly verification: 'confirmed' | 'provisional' | 'refuted' | 'entered-in-error';
    readonly recordedDate?: Date;
  },
): TestResource {
  return {
    resourceType: 'Condition',
    id: input.id,
    meta: meta(input),
    clinicalStatus: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          code: input.verification,
        },
      ],
    },
    code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: input.icd10 }] },
    subject: { reference: `Patient/${input.patientId}` },
    recordedDate: (input.recordedDate ?? input.at).toISOString(),
  };
}

/** A Patient resource (name and version), to exercise out-of-order delivery. */
export function patientResource(
  input: Versioned & { readonly id: string; readonly family: string },
): TestResource {
  return {
    resourceType: 'Patient',
    id: input.id,
    meta: meta(input),
    name: [{ family: input.family }],
  };
}
