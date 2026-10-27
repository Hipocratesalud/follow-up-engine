import {
  buildConsultationBundle,
  type ConsultationInput,
  ENGINE_CODE_SYSTEMS,
  TERMINOLOGY,
} from '@follow-up-engine/fhir';

/**
 * Synthetic FHIR bundles for the clinical calibration scenarios (HIP-123):
 * prescriptions with refills or "as needed" dosage, and lab results with a
 * value and a v3 interpretation flag.
 */

type Json = Record<string, unknown>;

interface Entry {
  readonly resource: Json & { readonly resourceType: string; readonly id: string };
  readonly request: { readonly method: string; readonly url: string };
}

/** A prescription with the dispensing details the consultation builder leaves out. */
export interface CalibrationPrescription {
  readonly text: string;
  readonly atc?: string;
  /** `dispenseRequest.expectedSupplyDuration`, in days. */
  readonly supplyDays?: number;
  /** `dispenseRequest.numberOfRepeatsAllowed`. */
  readonly refills?: number;
  /** `dosageInstruction[0].text`, for example `1 tab VO c/8h PRN dolor`. */
  readonly dosage?: string;
  /** `dosageInstruction[0].asNeededBoolean`. */
  readonly asNeeded?: boolean;
}

export interface CalibrationConsultation extends Omit<ConsultationInput, 'prescriptions'> {
  readonly prescriptions?: readonly CalibrationPrescription[];
}

/** {@link buildConsultationBundle} with dosage text, refills and "as needed" on each prescription. */
export function consultationBundle(input: CalibrationConsultation): unknown {
  const { prescriptions = [], ...rest } = input;
  const bundle = buildConsultationBundle({
    ...rest,
    prescriptions: prescriptions.map((prescription) => ({
      text: prescription.text,
      ...(prescription.atc === undefined
        ? {}
        : { code: { system: 'http://www.whocc.no/atc', code: prescription.atc } }),
      ...(prescription.supplyDays === undefined ? {} : { durationDays: prescription.supplyDays }),
    })),
  }) as unknown as { entry: Entry[] };
  let index = 0;
  for (const entry of bundle.entry) {
    if (entry.resource.resourceType !== 'MedicationRequest') {
      continue;
    }
    const prescription = prescriptions[index];
    index += 1;
    if (prescription === undefined) {
      continue;
    }
    const resource = entry.resource as Json;
    if (prescription.dosage !== undefined || prescription.asNeeded !== undefined) {
      resource['dosageInstruction'] = [
        {
          ...(prescription.dosage === undefined ? {} : { text: prescription.dosage }),
          ...(prescription.asNeeded === undefined
            ? {}
            : { asNeededBoolean: prescription.asNeeded }),
        },
      ];
    }
    if (prescription.refills !== undefined) {
      resource['dispenseRequest'] = {
        ...(resource['dispenseRequest'] ?? {}),
        numberOfRepeatsAllowed: prescription.refills,
      };
    }
  }
  return bundle;
}

/**
 * A note sent on its own, after its consultation, that does not say which
 * consultation it belongs to (no `context.encounter`).
 */
export function unlinkedNoteBundle(input: {
  readonly id: string;
  readonly patientId: string;
  readonly specialty: string;
  readonly at: Date;
  readonly text: string;
}): unknown {
  const resource = {
    resourceType: 'DocumentReference',
    id: input.id,
    status: 'current',
    docStatus: 'final',
    type: { coding: [{ system: TERMINOLOGY.loinc, code: '11506-3', display: 'Progress note' }] },
    subject: { reference: `Patient/${input.patientId}` },
    date: input.at.toISOString(),
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          data: btoa(String.fromCharCode(...new TextEncoder().encode(input.text))),
        },
      },
    ],
    context: {
      practiceSetting: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.specialty, code: input.specialty }],
      },
    },
  };
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [{ resource, request: { method: 'PUT', url: `DocumentReference/${input.id}` } }],
  };
}

/** A final lab result (DiagnosticReport + one valued Observation) answering an order. */
export function labResultBundle(input: {
  readonly id: string;
  readonly patientId: string;
  readonly loinc: string;
  readonly display: string;
  readonly at: Date;
  readonly value: number;
  readonly unit: string;
  /** v3 ObservationInterpretation code: `H`, `L`, `N`, `HH`, ... */
  readonly flag: string;
  /** The ServiceRequest it answers, if any. */
  readonly orderId?: string;
}): unknown {
  const issued = input.at.toISOString();
  const code = {
    coding: [{ system: TERMINOLOGY.loinc, code: input.loinc, display: input.display }],
    text: input.display,
  };
  const basedOn =
    input.orderId === undefined
      ? {}
      : { basedOn: [{ reference: `ServiceRequest/${input.orderId}` }] };
  const observation = {
    resourceType: 'Observation',
    id: `${input.id}-obs`,
    status: 'final',
    code,
    subject: { reference: `Patient/${input.patientId}` },
    effectiveDateTime: issued,
    issued,
    valueQuantity: { value: input.value, unit: input.unit },
    interpretation: [
      { coding: [{ system: TERMINOLOGY.observationInterpretation, code: input.flag }] },
    ],
  };
  const report = {
    resourceType: 'DiagnosticReport',
    id: input.id,
    status: 'final',
    code,
    subject: { reference: `Patient/${input.patientId}` },
    effectiveDateTime: issued,
    issued,
    ...basedOn,
    result: [{ reference: `Observation/${observation.id}` }],
  };
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [report, observation].map((resource) => ({
      resource,
      request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
    })),
  };
}

/** The id the consultation builder gives the n-th (1-based) order of a consultation. */
export function orderIdOf(consultationId: string, index: number): string {
  return `${consultationId}-sr-${String(index)}`;
}
