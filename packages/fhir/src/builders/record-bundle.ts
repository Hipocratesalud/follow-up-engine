import type { Coding } from '@follow-up-engine/core';
import type { Bundle, BundleEntry, FhirResource } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { ENGINE_CODE_SYSTEMS, SNOMED_SERVICE_CATEGORY, TERMINOLOGY } from '../terminology.ts';

/** `http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation` codes the engine reads. */
const INTERPRETATION_CODE: Readonly<Record<'normal' | 'abnormal', string>> = {
  normal: 'N',
  abnormal: 'A',
};

export interface RecordOrderEntry {
  readonly kind: 'order';
  readonly loinc: string;
  readonly display: string;
  /** Defaults to `laboratory`. */
  readonly category?: 'laboratory' | 'imaging';
}

export interface RecordPrescriptionEntry {
  readonly kind: 'prescription';
  readonly text: string;
  readonly code?: Coding;
  readonly durationDays?: number;
}

export interface RecordDiagnosisEntry {
  readonly kind: 'diagnosis';
  readonly icd10: string;
  readonly display?: string;
  readonly verification?: 'confirmed' | 'provisional';
}

/** A visit the patient attended: an `Encounter` alone, no note. */
export interface RecordVisitEntry {
  readonly kind: 'visit';
}

export interface RecordResultEntry {
  readonly kind: 'result';
  readonly loinc: string;
  readonly display: string;
  readonly value?: number;
  readonly unit?: string;
  readonly interpretation?: 'normal' | 'abnormal';
  /** The `ServiceRequest.id` this result answers, when known. */
  readonly basedOnOrderId?: string;
}

export interface RecordAppointmentBookedEntry {
  readonly kind: 'appointment_booked';
  readonly specialty?: string;
  /** When the appointment is scheduled for (`Appointment.start`). */
  readonly scheduledFor: Date;
}

export interface RecordAppointmentCancelledEntry {
  readonly kind: 'appointment_cancelled';
  /** The `Appointment.id` returned when it was booked. */
  readonly appointmentId: string;
  readonly scheduledFor: Date;
}

export type RecordEntryInput =
  | RecordOrderEntry
  | RecordPrescriptionEntry
  | RecordDiagnosisEntry
  | RecordVisitEntry
  | RecordResultEntry
  | RecordAppointmentBookedEntry
  | RecordAppointmentCancelledEntry;

export interface RecordBundleInput {
  /** Host id of this structured action; every resource id derives from it. */
  readonly recordId: string;
  readonly patient: {
    readonly id: string;
    /** When given, the Patient resource is included (a new patient). */
    readonly name?: string;
    readonly gender?: 'male' | 'female' | 'other' | 'unknown';
    readonly birthDate?: string;
  };
  /** When the action happened (the evaluator's chosen date). */
  readonly occurredAt: Date;
  readonly entry: RecordEntryInput;
}

function put(resource: FhirResource & { readonly id: string }): BundleEntry {
  return { resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } };
}

export interface PatientBundleInput {
  readonly id: string;
  readonly name: string;
  readonly gender?: 'male' | 'female' | 'other' | 'unknown';
  readonly birthDate?: string;
}

/**
 * Builds a one-resource FHIR `transaction` Bundle that registers a Patient
 * alone: the evaluator lab's "New patient" (docs/deploy.md#hosted-demo), a
 * fictitious patient with no clinical history yet. Deliberately not a
 * {@link buildRecordBundle} `visit` entry: creating the patient record must
 * not also imply a visit happened (which would anchor visit-interval
 * protocols from day one).
 */
export function buildPatientBundle(input: PatientBundleInput): Bundle {
  return {
    resourceType: 'Bundle',
    id: toFhirId(`${input.id}-patient-bundle`),
    type: 'transaction',
    entry: [
      put({
        resourceType: 'Patient',
        id: input.id,
        name: [{ text: input.name }],
        ...(input.gender === undefined ? {} : { gender: input.gender }),
        ...(input.birthDate === undefined ? {} : { birthDate: input.birthDate }),
      }),
    ],
  };
}

/**
 * Builds a one-resource FHIR `transaction` Bundle for a structured record
 * the evaluator lab adds directly (no note, no LLM reading): a lab/imaging
 * order, a result, a prescription, a visit, a diagnosis or an appointment.
 * Every entry an idempotent `PUT` with a deterministic id (re-sending is
 * harmless); an `Encounter` groups the resource except a result or an
 * appointment, which stand on their own.
 */
export function buildRecordBundle(input: RecordBundleInput): Bundle {
  const id = (suffix: string): string => toFhirId(`${input.recordId}-${suffix}`);
  const at = toFhirInstant(input.occurredAt);
  const patientRef = { reference: `Patient/${input.patient.id}` };
  const entries: BundleEntry[] = [];

  if (input.patient.name !== undefined) {
    entries.push(
      put({
        resourceType: 'Patient',
        id: input.patient.id,
        name: [{ text: input.patient.name }],
        ...(input.patient.gender === undefined ? {} : { gender: input.patient.gender }),
        ...(input.patient.birthDate === undefined ? {} : { birthDate: input.patient.birthDate }),
      }),
    );
  }

  const entry = input.entry;
  if (entry.kind === 'appointment_booked' || entry.kind === 'appointment_cancelled') {
    const appointmentId = entry.kind === 'appointment_booked' ? id('appt') : entry.appointmentId;
    entries.push(
      put({
        resourceType: 'Appointment',
        id: appointmentId,
        status: entry.kind === 'appointment_booked' ? 'booked' : 'cancelled',
        start: toFhirInstant(entry.scheduledFor),
        created: at,
        participant: [{ actor: patientRef, status: 'accepted' }],
        ...(entry.kind === 'appointment_booked' && entry.specialty !== undefined
          ? {
              specialty: [
                { coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: entry.specialty }] },
              ],
            }
          : {}),
      }),
    );
    return {
      resourceType: 'Bundle',
      id: id('bundle'),
      type: 'transaction',
      timestamp: at,
      entry: entries,
    };
  }

  if (entry.kind === 'result') {
    entries.push(
      put({
        resourceType: 'Observation',
        id: id('obs'),
        status: 'final',
        code: {
          coding: [{ system: TERMINOLOGY.loinc, code: entry.loinc, display: entry.display }],
          text: entry.display,
        },
        subject: patientRef,
        effectiveDateTime: at,
        ...(entry.basedOnOrderId === undefined
          ? {}
          : { basedOn: [{ reference: `ServiceRequest/${entry.basedOnOrderId}` }] }),
        ...(entry.value === undefined
          ? {}
          : {
              valueQuantity: {
                value: entry.value,
                ...(entry.unit === undefined
                  ? {}
                  : { unit: entry.unit, code: entry.unit, system: TERMINOLOGY.ucum }),
              },
            }),
        ...(entry.interpretation === undefined
          ? {}
          : {
              interpretation: [
                {
                  coding: [
                    {
                      system: TERMINOLOGY.observationInterpretation,
                      code: INTERPRETATION_CODE[entry.interpretation],
                    },
                  ],
                },
              ],
            }),
      }),
    );
    return {
      resourceType: 'Bundle',
      id: id('bundle'),
      type: 'transaction',
      timestamp: at,
      entry: entries,
    };
  }

  // Every other entry groups under one Encounter (also the "visit" entry itself).
  const encounterId = id('enc');
  const encounterRef = { reference: `Encounter/${encounterId}` };
  entries.push(
    put({
      resourceType: 'Encounter',
      id: encounterId,
      status: 'finished',
      class: {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'AMB',
        display: 'ambulatory',
      },
      subject: patientRef,
      period: { start: at, end: at },
    }),
  );

  if (entry.kind === 'order') {
    const category = entry.category ?? 'laboratory';
    entries.push(
      put({
        resourceType: 'ServiceRequest',
        id: id('sr'),
        status: 'active',
        intent: 'order',
        category: [
          { coding: [{ system: TERMINOLOGY.snomed, code: SNOMED_SERVICE_CATEGORY[category] }] },
        ],
        code: {
          coding: [{ system: TERMINOLOGY.loinc, code: entry.loinc, display: entry.display }],
          text: entry.display,
        },
        subject: patientRef,
        encounter: encounterRef,
        authoredOn: at,
      }),
    );
  } else if (entry.kind === 'prescription') {
    entries.push(
      put({
        resourceType: 'MedicationRequest',
        id: id('mr'),
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: {
          ...(entry.code === undefined ? {} : { coding: [{ ...entry.code }] }),
          text: entry.text,
        },
        subject: patientRef,
        encounter: encounterRef,
        authoredOn: at,
        ...(entry.durationDays === undefined
          ? {}
          : {
              dispenseRequest: {
                expectedSupplyDuration: {
                  value: entry.durationDays,
                  unit: 'days',
                  system: TERMINOLOGY.ucum,
                  code: 'd',
                },
              },
            }),
      }),
    );
  } else if (entry.kind === 'diagnosis') {
    entries.push(
      put({
        resourceType: 'Condition',
        id: id('dx'),
        clinicalStatus: { coding: [{ system: TERMINOLOGY.conditionClinical, code: 'active' }] },
        verificationStatus: {
          coding: [
            { system: TERMINOLOGY.conditionVerification, code: entry.verification ?? 'confirmed' },
          ],
        },
        category: [
          { coding: [{ system: TERMINOLOGY.conditionCategory, code: 'encounter-diagnosis' }] },
        ],
        code: {
          coding: [
            {
              system: TERMINOLOGY.icd10,
              code: entry.icd10,
              ...(entry.display === undefined ? {} : { display: entry.display }),
            },
          ],
          ...(entry.display === undefined ? {} : { text: entry.display }),
        },
        subject: patientRef,
        encounter: encounterRef,
        recordedDate: at,
      }),
    );
  }
  // `visit`: the Encounter alone is the whole point.

  return {
    resourceType: 'Bundle',
    id: id('bundle'),
    type: 'transaction',
    timestamp: at,
    entry: entries,
  };
}
