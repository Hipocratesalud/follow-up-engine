import type { Coding } from '@follow-up-engine/core';
import type { Bundle, BundleEntry, FhirResource } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { encodeBase64Utf8 } from '../support/text.ts';
import {
  type ConsultationDocumentType,
  ENGINE_CODE_SYSTEMS,
  SNOMED_SERVICE_CATEGORY,
  TERMINOLOGY,
} from '../terminology.ts';

export interface ConsultationOrderInput {
  readonly loinc: string;
  readonly display: string;
  /** Defaults to `laboratory`. */
  readonly category?: 'laboratory' | 'imaging';
}

export interface ConsultationPrescriptionInput {
  readonly text: string;
  readonly code?: Coding;
  readonly durationDays?: number;
}

export interface ConsultationDiagnosisInput {
  readonly icd10: string;
  readonly display?: string;
  readonly verification?: 'confirmed' | 'provisional';
}

/**
 * The `DocumentReference.type` LOINC code for each {@link ConsultationDocumentType}
 * (`CONSULTATION_DOCUMENT_TYPES`, `../terminology.ts`). Extraction itself
 * does not depend on it (`mapDocumentReference` reads any current, final
 * DocumentReference with text); it only labels the record.
 */
const DOCUMENT_TYPE_CODES: Readonly<
  Record<ConsultationDocumentType, { code: string; display: string }>
> = {
  consultation_note: { code: '11506-3', display: 'Progress note' },
  lab_result: { code: '11502-2', display: 'Laboratory report' },
  imaging_report: { code: '18748-4', display: 'Diagnostic imaging report' },
  prescription: { code: '57833-6', display: 'Prescription record' },
  other: { code: '34133-9', display: 'Summary of episode note' },
};

export interface ConsultationInput {
  /** Host id of the consultation; every resource id derives from it (`<id>-enc`, `<id>-note`, ...). */
  readonly consultationId: string;
  readonly patient: {
    readonly id: string;
    /** When given, the Patient resource is included (a new patient). */
    readonly name?: string;
    readonly gender?: 'male' | 'female' | 'other' | 'unknown';
    readonly birthDate?: string;
  };
  readonly practitionerId?: string;
  /** Engine specialty code, for example `diabetology`. */
  readonly specialty: string;
  /** When the consultation ended and the note was signed. */
  readonly occurredAt: Date;
  readonly noteText: string;
  /** Default `consultation_note` (the demo's free-text consultation form). */
  readonly documentType?: ConsultationDocumentType;
  readonly orders?: readonly ConsultationOrderInput[];
  readonly prescriptions?: readonly ConsultationPrescriptionInput[];
  readonly diagnoses?: readonly ConsultationDiagnosisInput[];
}

function put(resource: FhirResource & { readonly id: string }): BundleEntry {
  return {
    resource,
    request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
  };
}

/**
 * Builds the FHIR `transaction` Bundle a host sends when a consultation is
 * saved: Encounter, note (DocumentReference), orders (ServiceRequest),
 * prescriptions (MedicationRequest), diagnoses (Condition) and, for a new
 * patient, the Patient. Every entry is an idempotent `PUT` with a
 * deterministic id, so re-sending the same consultation is harmless.
 *
 * Used by the demo endpoint and by tests; any EHR can build the same shape.
 */
export function buildConsultationBundle(input: ConsultationInput): Bundle {
  const id = (suffix: string): string => toFhirId(`${input.consultationId}-${suffix}`);
  const at = toFhirInstant(input.occurredAt);
  const patientRef = { reference: `Patient/${input.patient.id}` };
  const encounterId = id('enc');
  const encounterRef = { reference: `Encounter/${encounterId}` };
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
      serviceType: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: input.specialty }],
        text: input.specialty,
      },
      subject: patientRef,
      ...(input.practitionerId === undefined
        ? {}
        : {
            participant: [
              {
                type: [{ coding: [{ system: TERMINOLOGY.participationType, code: 'PPRF' }] }],
                individual: { reference: `Practitioner/${input.practitionerId}` },
              },
            ],
          }),
      period: { start: at, end: at },
    }),
  );

  const documentType = DOCUMENT_TYPE_CODES[input.documentType ?? 'consultation_note'];
  entries.push(
    put({
      resourceType: 'DocumentReference',
      id: id('note'),
      status: 'current',
      docStatus: 'final',
      type: {
        coding: [
          { system: TERMINOLOGY.loinc, code: documentType.code, display: documentType.display },
        ],
      },
      subject: patientRef,
      date: at,
      content: [
        {
          attachment: {
            contentType: 'text/plain; charset=utf-8',
            data: encodeBase64Utf8(input.noteText),
          },
        },
      ],
      context: {
        encounter: [encounterRef],
        practiceSetting: {
          coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: input.specialty }],
        },
      },
    }),
  );

  (input.orders ?? []).forEach((order, index) => {
    const category = order.category ?? 'laboratory';
    entries.push(
      put({
        resourceType: 'ServiceRequest',
        id: id(`sr-${String(index + 1)}`),
        status: 'active',
        intent: 'order',
        category: [
          {
            coding: [{ system: TERMINOLOGY.snomed, code: SNOMED_SERVICE_CATEGORY[category] }],
          },
        ],
        code: {
          coding: [{ system: TERMINOLOGY.loinc, code: order.loinc, display: order.display }],
          text: order.display,
        },
        subject: patientRef,
        encounter: encounterRef,
        authoredOn: at,
      }),
    );
  });

  (input.prescriptions ?? []).forEach((prescription, index) => {
    entries.push(
      put({
        resourceType: 'MedicationRequest',
        id: id(`mr-${String(index + 1)}`),
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: {
          ...(prescription.code === undefined ? {} : { coding: [{ ...prescription.code }] }),
          text: prescription.text,
        },
        subject: patientRef,
        encounter: encounterRef,
        authoredOn: at,
        ...(prescription.durationDays === undefined
          ? {}
          : {
              dispenseRequest: {
                expectedSupplyDuration: {
                  value: prescription.durationDays,
                  unit: 'days',
                  system: TERMINOLOGY.ucum,
                  code: 'd',
                },
              },
            }),
      }),
    );
  });

  (input.diagnoses ?? []).forEach((diagnosis, index) => {
    entries.push(
      put({
        resourceType: 'Condition',
        id: id(`dx-${String(index + 1)}`),
        clinicalStatus: { coding: [{ system: TERMINOLOGY.conditionClinical, code: 'active' }] },
        verificationStatus: {
          coding: [
            {
              system: TERMINOLOGY.conditionVerification,
              code: diagnosis.verification ?? 'confirmed',
            },
          ],
        },
        category: [
          { coding: [{ system: TERMINOLOGY.conditionCategory, code: 'encounter-diagnosis' }] },
        ],
        code: {
          coding: [
            {
              system: TERMINOLOGY.icd10,
              code: diagnosis.icd10,
              ...(diagnosis.display === undefined ? {} : { display: diagnosis.display }),
            },
          ],
          ...(diagnosis.display === undefined ? {} : { text: diagnosis.display }),
        },
        subject: patientRef,
        encounter: encounterRef,
        recordedDate: at,
      }),
    );
  });

  return {
    resourceType: 'Bundle',
    id: id('bundle'),
    type: 'transaction',
    timestamp: at,
    entry: entries,
  };
}
