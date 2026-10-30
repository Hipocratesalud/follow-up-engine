import type { Bundle, FhirResource } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  FOLLOW_UP_OPT_OUT_CONSENT_CODE,
  TERMINOLOGY,
} from '../terminology.ts';

/**
 * FHIR writes of the order-to-completion agent (docs/agent/order-to-completion.md):
 * a result the patient sent as a photo, and a visit they confirmed. Both go
 * through the same ingestion as `POST /fhir`, so the engine alone decides
 * what they fulfill. One-resource `transaction` Bundles with idempotent
 * `PUT`s: re-sending changes nothing.
 */

export interface AgentResultInput {
  readonly observationId: string;
  readonly patientId: string;
  readonly code: { readonly system: string; readonly code: string; readonly display: string };
  readonly value: number;
  readonly unit?: string;
  readonly referenceLow?: number;
  readonly referenceHigh?: number;
  /** HL7 v3 ObservationInterpretation code, computed by code from the printed range. */
  readonly interpretation?: 'H' | 'L' | 'N';
  /** When the sample was taken (the report's date). */
  readonly effectiveAt: Date;
  /** When the clinic received it. */
  readonly receivedAt: Date;
  /** `Observation.note`; default: reported by the patient as a photo, read by the agent. */
  readonly note?: string;
}

function put(resource: FhirResource & { readonly id: string }) {
  return {
    resource,
    request: { method: 'PUT' as const, url: `${resource.resourceType}/${resource.id}` },
  };
}

function quantity(value: number, unit: string | undefined) {
  return {
    value,
    ...(unit === undefined ? {} : { unit, system: TERMINOLOGY.ucum, code: unit }),
  };
}

/** A patient-reported lab result (`Observation`, status `final`), read from a photo. */
export function buildAgentResultBundle(input: AgentResultInput): Bundle {
  const id = toFhirId(input.observationId);
  const range =
    input.referenceLow === undefined && input.referenceHigh === undefined
      ? undefined
      : [
          {
            ...(input.referenceLow === undefined
              ? {}
              : { low: quantity(input.referenceLow, input.unit) }),
            ...(input.referenceHigh === undefined
              ? {}
              : { high: quantity(input.referenceHigh, input.unit) }),
          },
        ];
  return {
    resourceType: 'Bundle',
    id: toFhirId(`${input.observationId}-bundle`),
    type: 'transaction',
    timestamp: toFhirInstant(input.receivedAt),
    entry: [
      put({
        resourceType: 'Observation',
        id,
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory',
              },
            ],
          },
        ],
        code: {
          coding: [
            { system: input.code.system, code: input.code.code, display: input.code.display },
          ],
          text: input.code.display,
        },
        subject: { reference: `Patient/${input.patientId}` },
        effectiveDateTime: toFhirInstant(input.effectiveAt),
        issued: toFhirInstant(input.receivedAt),
        valueQuantity: quantity(input.value, input.unit),
        ...(range === undefined ? {} : { referenceRange: range }),
        ...(input.interpretation === undefined
          ? {}
          : {
              interpretation: [
                {
                  coding: [
                    {
                      system: TERMINOLOGY.observationInterpretation,
                      code: input.interpretation,
                    },
                  ],
                },
              ],
            }),
        note: [
          {
            text:
              input.note ??
              'Reported by the patient as a photo of the lab report; read by the follow-up agent.',
          },
        ],
      }),
    ],
  };
}

export interface AgentAppointmentInput {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly start: Date;
  readonly end: Date;
  readonly practitionerName: string;
  readonly location: string;
  readonly bookedAt: Date;
  /** The case `Task` the booking answers: the `follow-up-origin-case` extension (HIP-141 attribution). */
  readonly originCaseId?: string;
  readonly specialty?: string;
}

/** A visit the patient confirmed with the agent (`Appointment`, status `booked`). */
export function buildAgentAppointmentBundle(input: AgentAppointmentInput): Bundle {
  return {
    resourceType: 'Bundle',
    id: toFhirId(`${input.appointmentId}-bundle`),
    type: 'transaction',
    timestamp: toFhirInstant(input.bookedAt),
    entry: [
      put({
        resourceType: 'Appointment',
        id: toFhirId(input.appointmentId),
        ...(input.originCaseId === undefined
          ? {}
          : {
              extension: [
                {
                  url: ENGINE_EXTENSIONS.followUpOriginCase,
                  valueReference: { reference: `Task/${input.originCaseId}` },
                },
              ],
            }),
        status: 'booked',
        ...(input.specialty === undefined
          ? {}
          : {
              specialty: [
                { coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: input.specialty }] },
              ],
            }),
        description: input.location,
        start: toFhirInstant(input.start),
        end: toFhirInstant(input.end),
        created: toFhirInstant(input.bookedAt),
        participant: [
          { actor: { reference: `Patient/${input.patientId}` }, status: 'accepted' },
          { actor: { display: input.practitionerName }, status: 'accepted' },
        ],
      }),
    ],
  };
}

export interface AgentOptOutInput {
  readonly consentId: string;
  readonly patientId: string;
  /** When the patient asked to stop. */
  readonly at: Date;
}

/**
 * The patient asked the agent to stop writing (`Consent`, status `active`,
 * provision `deny`, category `follow-up-opt-out`): the engine records
 * `patient.opted_out`, stops asking the host to contact the patient and
 * escalates to the coordinator instead (docs/fhir.md).
 */
export function buildAgentOptOutBundle(input: AgentOptOutInput): Bundle {
  return {
    resourceType: 'Bundle',
    id: toFhirId(`${input.consentId}-bundle`),
    type: 'transaction',
    timestamp: toFhirInstant(input.at),
    entry: [
      put({
        resourceType: 'Consent',
        id: toFhirId(input.consentId),
        status: 'active',
        scope: { coding: [{ system: TERMINOLOGY.consentScope, code: 'patient-privacy' }] },
        category: [
          {
            coding: [{ system: ENGINE_CODE_SYSTEMS.consent, code: FOLLOW_UP_OPT_OUT_CONSENT_CODE }],
          },
        ],
        patient: { reference: `Patient/${input.patientId}` },
        dateTime: toFhirInstant(input.at),
        provision: { type: 'deny' },
      }),
    ],
  };
}
