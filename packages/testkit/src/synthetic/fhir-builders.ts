import { createHash } from 'node:crypto';
import { DEMO_CLINIC_ID, SYSTEMS, type Specialty } from '../constants.ts';
import type {
  Analyte,
  ConditionDefinition,
  MedicationDefinition,
  OrderDefinition,
} from './catalog.ts';

/** A FHIR R4 resource as plain JSON. */
export interface FhirResource {
  readonly resourceType: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface BundleEntry {
  readonly fullUrl: string;
  readonly resource: FhirResource;
  readonly request: { readonly method: 'PUT'; readonly url: string };
}

export interface TransactionBundle {
  readonly resourceType: 'Bundle';
  readonly id: string;
  readonly type: 'transaction';
  readonly timestamp: string;
  readonly entry: readonly BundleEntry[];
}

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  diabetology: 'Diabetología',
  internal_medicine: 'Medicina interna',
  psychology: 'Psicología',
  gynecology: 'Ginecología y obstetricia',
};

/** Deterministic RFC 4122-shaped UUID derived from a name. */
export function uuidFor(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

const iso = (date: Date): string => date.toISOString();
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const ref = (resourceType: string, id: string) => ({ reference: `${resourceType}/${id}` });
const coding = (system: string, code: string, display?: string) => ({
  system,
  code,
  ...(display === undefined ? {} : { display }),
});

interface Reference {
  readonly reference: string;
  readonly display?: string;
}

interface CodeableConcept {
  readonly coding: readonly {
    readonly system: string;
    readonly code: string;
    readonly display?: string;
  }[];
  readonly text?: string;
}

export const clinicRef = (): Reference => ({
  ...ref('Organization', DEMO_CLINIC_ID),
  display: 'Clínica Demo Hipócrates',
});

export function specialtyConcept(specialty: Specialty): CodeableConcept {
  return {
    coding: [coding(SYSTEMS.specialty, specialty, SPECIALTY_LABELS[specialty])],
    text: SPECIALTY_LABELS[specialty],
  };
}

export function transactionBundle(
  id: string,
  timestamp: Date,
  resources: readonly FhirResource[],
): TransactionBundle {
  return {
    resourceType: 'Bundle',
    id,
    type: 'transaction',
    timestamp: iso(timestamp),
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${uuidFor(`${DEMO_CLINIC_ID}/${resource.resourceType}/${resource.id}`)}`,
      resource,
      request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
    })),
  };
}

export interface PersonName {
  readonly given: readonly string[];
  readonly family: readonly string[];
}

export interface PatientInput {
  readonly id: string;
  readonly mrn: string;
  readonly name: PersonName;
  readonly gender: 'female' | 'male';
  readonly birthDate: string;
}

export function patientResource(input: PatientInput): FhirResource {
  return {
    resourceType: 'Patient',
    id: input.id,
    identifier: [{ use: 'usual', system: SYSTEMS.patientIdentifier, value: input.mrn }],
    active: true,
    name: [
      {
        use: 'official',
        text: `${input.name.given.join(' ')} ${input.name.family.join(' ')}`,
        family: input.name.family.join(' '),
        given: [...input.name.given],
      },
    ],
    gender: input.gender,
    birthDate: input.birthDate,
    managingOrganization: clinicRef(),
  };
}

export interface PractitionerInput {
  readonly id: string;
  readonly prefix: string;
  readonly name: PersonName;
  readonly gender: 'female' | 'male';
  readonly specialty: Specialty;
}

export function practitionerResource(input: PractitionerInput): FhirResource {
  return {
    resourceType: 'Practitioner',
    id: input.id,
    active: true,
    name: [
      {
        use: 'official',
        text: `${input.prefix} ${input.name.given.join(' ')} ${input.name.family.join(' ')}`,
        family: input.name.family.join(' '),
        given: [...input.name.given],
        prefix: [input.prefix],
      },
    ],
    gender: input.gender,
  };
}

export function practitionerRoleResource(input: PractitionerInput): FhirResource {
  return {
    resourceType: 'PractitionerRole',
    id: `role-${input.id}`,
    active: true,
    practitioner: ref('Practitioner', input.id),
    organization: clinicRef(),
    specialty: [specialtyConcept(input.specialty)],
  };
}

export function organizationResource(): FhirResource {
  return {
    resourceType: 'Organization',
    id: DEMO_CLINIC_ID,
    active: true,
    type: [
      {
        coding: [
          coding(
            'http://terminology.hl7.org/CodeSystem/organization-type',
            'prov',
            'Healthcare Provider',
          ),
        ],
      },
    ],
    name: 'Clínica Demo Hipócrates',
    alias: ['Clínica Demo'],
  };
}

export interface EncounterInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly specialty: Specialty;
  readonly start: Date;
  readonly end: Date;
  readonly virtual?: boolean;
  readonly reason?: string;
  readonly appointmentId?: string;
  readonly visitType: string;
}

export function encounterResource(input: EncounterInput): FhirResource {
  return {
    resourceType: 'Encounter',
    id: input.id,
    status: 'finished',
    class: input.virtual
      ? coding(SYSTEMS.actCode, 'VR', 'virtual')
      : coding(SYSTEMS.actCode, 'AMB', 'ambulatory'),
    type: [{ text: input.visitType }],
    serviceType: specialtyConcept(input.specialty),
    subject: ref('Patient', input.patientId),
    participant: [{ individual: ref('Practitioner', input.practitionerId) }],
    ...(input.appointmentId ? { appointment: [ref('Appointment', input.appointmentId)] } : {}),
    period: { start: iso(input.start), end: iso(input.end) },
    ...(input.reason ? { reasonCode: [{ text: input.reason }] } : {}),
    serviceProvider: clinicRef(),
  };
}

export interface NoteInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly encounterId: string;
  readonly specialty: Specialty;
  readonly authoredAt: Date;
  readonly start: Date;
  readonly text: string;
}

export function documentReferenceResource(input: NoteInput): FhirResource {
  return {
    resourceType: 'DocumentReference',
    id: input.id,
    status: 'current',
    docStatus: 'final',
    type: {
      coding: [coding(SYSTEMS.loinc, '11506-3', 'Progress note')],
      text: 'Nota de evolución',
    },
    subject: ref('Patient', input.patientId),
    date: iso(input.authoredAt),
    author: [ref('Practitioner', input.practitionerId)],
    custodian: clinicRef(),
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          language: 'es',
          data: Buffer.from(input.text, 'utf8').toString('base64'),
          title: 'Nota de evolución',
          creation: iso(input.authoredAt),
        },
      },
    ],
    context: {
      encounter: [ref('Encounter', input.encounterId)],
      period: { start: iso(input.start), end: iso(input.authoredAt) },
      practiceSetting: specialtyConcept(input.specialty),
    },
  };
}

/** Decodes the plain-text note of a DocumentReference built by {@link documentReferenceResource}. */
export function noteTextOf(resource: FhirResource): string {
  const content = resource['content'] as readonly { attachment: { data: string } }[] | undefined;
  const data = content?.[0]?.attachment.data;
  if (data === undefined)
    throw new Error(`DocumentReference/${resource.id} has no attachment data`);
  return Buffer.from(data, 'base64').toString('utf8');
}

const ORDER_CATEGORY = {
  laboratory: coding(SYSTEMS.snomed, '108252007', 'Laboratory procedure'),
  imaging: coding(SYSTEMS.snomed, '363679005', 'Imaging'),
} as const;

export interface OrderInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly encounterId?: string;
  readonly order: OrderDefinition;
  readonly authoredOn: Date;
}

export function serviceRequestResource(input: OrderInput): FhirResource {
  return {
    resourceType: 'ServiceRequest',
    id: input.id,
    status: 'active',
    intent: 'order',
    category: [{ coding: [ORDER_CATEGORY[input.order.category]] }],
    code: {
      coding: [coding(input.order.system ?? SYSTEMS.loinc, input.order.loinc, input.order.display)],
      text: input.order.label,
    },
    subject: ref('Patient', input.patientId),
    ...(input.encounterId ? { encounter: ref('Encounter', input.encounterId) } : {}),
    authoredOn: iso(input.authoredOn),
    requester: ref('Practitioner', input.practitionerId),
  };
}

export interface MedicationInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly encounterId: string;
  readonly medication: MedicationDefinition;
  readonly authoredOn: Date;
}

export function medicationRequestResource(input: MedicationInput): FhirResource {
  const { medication } = input;
  const duration = medication.durationDays;
  return {
    resourceType: 'MedicationRequest',
    id: input.id,
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: {
      coding: [coding(SYSTEMS.atc, medication.atc, medication.display)],
      text: medication.text,
    },
    subject: ref('Patient', input.patientId),
    encounter: ref('Encounter', input.encounterId),
    authoredOn: iso(input.authoredOn),
    requester: ref('Practitioner', input.practitionerId),
    dosageInstruction: [
      {
        text:
          duration === undefined
            ? medication.dosage
            : `${medication.dosage} x ${String(duration)} días`,
      },
    ],
    ...(duration === undefined
      ? {}
      : {
          dispenseRequest: {
            validityPeriod: { start: iso(input.authoredOn) },
            expectedSupplyDuration: {
              value: duration,
              unit: 'días',
              system: SYSTEMS.ucum,
              code: 'd',
            },
          },
        }),
  };
}

export interface ConditionInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  /** Absent for a diagnosis recorded outside a visit (a problem-list entry). */
  readonly encounterId?: string;
  readonly condition: ConditionDefinition;
  readonly recordedAt: Date;
  /** When it happened, if it is not when it was recorded (a delivery at a hospital). */
  readonly onsetAt?: Date;
  readonly clinicalStatus?: 'active' | 'resolved';
}

export function conditionResource(input: ConditionInput): FhirResource {
  return {
    resourceType: 'Condition',
    id: input.id,
    clinicalStatus: {
      coding: [coding(SYSTEMS.conditionClinical, input.clinicalStatus ?? 'active')],
    },
    verificationStatus: { coding: [coding(SYSTEMS.conditionVerification, 'confirmed')] },
    category: [
      {
        coding: [
          input.encounterId === undefined
            ? coding(SYSTEMS.conditionCategory, 'problem-list-item', 'Problem List Item')
            : coding(SYSTEMS.conditionCategory, 'encounter-diagnosis', 'Encounter Diagnosis'),
        ],
      },
    ],
    code: {
      coding: [coding(SYSTEMS.icd10, input.condition.icd10, input.condition.display)],
      text: input.condition.noteName,
    },
    subject: ref('Patient', input.patientId),
    ...(input.encounterId === undefined ? {} : { encounter: ref('Encounter', input.encounterId) }),
    ...(input.onsetAt === undefined ? {} : { onsetDateTime: iso(input.onsetAt) }),
    recordedDate: iso(input.recordedAt),
    recorder: ref('Practitioner', input.practitionerId),
  };
}

/** A date recorded about the patient: last menstrual period, estimated delivery date (LOINC). */
export interface DateFact {
  readonly loinc: string;
  readonly display: string;
  /** `YYYY-MM-DD`. */
  readonly value: string;
}

export interface DateObservationInput {
  readonly id: string;
  readonly patientId: string;
  readonly fact: DateFact;
  readonly effectiveAt: Date;
  readonly category: 'exam' | 'imaging';
  readonly encounterId?: string;
  readonly practitionerId?: string;
  readonly orderId?: string;
}

const OBSERVATION_CATEGORY_DISPLAY = { exam: 'Exam', imaging: 'Imaging' } as const;

/** An Observation whose value is a date (`valueDateTime`), such as the FUM or the FPP. */
export function dateObservationResource(input: DateObservationInput): FhirResource {
  return {
    resourceType: 'Observation',
    id: input.id,
    ...(input.orderId ? { basedOn: [ref('ServiceRequest', input.orderId)] } : {}),
    status: 'final',
    category: [
      {
        coding: [
          coding(
            SYSTEMS.observationCategory,
            input.category,
            OBSERVATION_CATEGORY_DISPLAY[input.category],
          ),
        ],
      },
    ],
    code: { coding: [coding(SYSTEMS.loinc, input.fact.loinc, input.fact.display)] },
    subject: ref('Patient', input.patientId),
    ...(input.encounterId ? { encounter: ref('Encounter', input.encounterId) } : {}),
    effectiveDateTime: iso(input.effectiveAt),
    issued: iso(input.effectiveAt),
    ...(input.practitionerId ? { performer: [ref('Practitioner', input.practitionerId)] } : {}),
    valueDateTime: input.fact.value,
  };
}

export type Interpretation = 'H' | 'L' | 'N';

const INTERPRETATION_DISPLAY: Record<Interpretation, string> = { H: 'High', L: 'Low', N: 'Normal' };

export interface AnalyteResult {
  readonly analyte: Analyte;
  readonly value: number;
}

export function interpretationOf(analyte: Analyte, value: number): Interpretation {
  if (analyte.high !== undefined && value >= analyte.high) return 'H';
  if (analyte.low !== undefined && value < analyte.low) return 'L';
  return 'N';
}

export interface ResultInput {
  readonly reportId: string;
  readonly patientId: string;
  readonly order: OrderDefinition;
  /** Absent when the result arrives without a linked order (outside lab). */
  readonly orderId?: string;
  readonly collectedAt: Date;
  readonly issuedAt: Date;
  /** Lab panels and analytes. */
  readonly analytes?: readonly AnalyteResult[];
  /** Imaging and cytology. */
  readonly conclusion?: { readonly text: string; readonly abnormal: boolean };
  /** Dates the report states (the estimated delivery date of a dating ultrasound). */
  readonly dateFacts?: readonly DateFact[];
}

const quantity = (value: number, analyte: Analyte) => ({
  value,
  unit: analyte.unit,
  system: SYSTEMS.ucum,
  code: analyte.ucum,
});

/** A DiagnosticReport plus its Observations, all `basedOn` the order when there is one. */
export function resultResources(input: ResultInput): FhirResource[] {
  const basedOn = input.orderId ? { basedOn: [ref('ServiceRequest', input.orderId)] } : {};
  const isLab = input.order.category === 'laboratory';
  const observations: FhirResource[] = [];

  (input.analytes ?? []).forEach((result, index) => {
    const interpretation = interpretationOf(result.analyte, result.value);
    const { low, high } = result.analyte;
    observations.push({
      resourceType: 'Observation',
      id: `${input.reportId}-obs${String(index + 1)}`,
      ...basedOn,
      status: 'final',
      category: [{ coding: [coding(SYSTEMS.observationCategory, 'laboratory', 'Laboratory')] }],
      code: { coding: [coding(SYSTEMS.loinc, result.analyte.loinc, result.analyte.display)] },
      subject: ref('Patient', input.patientId),
      effectiveDateTime: iso(input.collectedAt),
      issued: iso(input.issuedAt),
      valueQuantity: quantity(result.value, result.analyte),
      interpretation: [
        {
          coding: [
            coding(
              SYSTEMS.observationInterpretation,
              interpretation,
              INTERPRETATION_DISPLAY[interpretation],
            ),
          ],
        },
      ],
      ...(low === undefined && high === undefined
        ? {}
        : {
            referenceRange: [
              {
                ...(low === undefined ? {} : { low: quantity(low, result.analyte) }),
                ...(high === undefined ? {} : { high: quantity(high, result.analyte) }),
              },
            ],
          }),
    });
  });

  if (input.conclusion && isLab) {
    // Cytology: one coded observation carrying the reading and its interpretation.
    const interpretation: Interpretation = input.conclusion.abnormal ? 'H' : 'N';
    observations.push({
      resourceType: 'Observation',
      id: `${input.reportId}-obs1`,
      ...basedOn,
      status: 'final',
      category: [{ coding: [coding(SYSTEMS.observationCategory, 'laboratory', 'Laboratory')] }],
      code: {
        coding: [
          coding(input.order.system ?? SYSTEMS.loinc, input.order.loinc, input.order.display),
        ],
      },
      subject: ref('Patient', input.patientId),
      effectiveDateTime: iso(input.collectedAt),
      issued: iso(input.issuedAt),
      valueString: input.conclusion.text,
      interpretation: [
        {
          coding: [
            coding(
              SYSTEMS.observationInterpretation,
              interpretation,
              INTERPRETATION_DISPLAY[interpretation],
            ),
          ],
        },
      ],
    });
  }

  for (const fact of input.dateFacts ?? []) {
    observations.push(
      dateObservationResource({
        id: `${input.reportId}-obs${String(observations.length + 1)}`,
        patientId: input.patientId,
        fact,
        effectiveAt: input.collectedAt,
        category: isLab ? 'exam' : 'imaging',
        ...(input.orderId ? { orderId: input.orderId } : {}),
      }),
    );
  }

  const report: FhirResource = {
    resourceType: 'DiagnosticReport',
    id: input.reportId,
    ...basedOn,
    status: 'final',
    category: [
      {
        coding: [
          coding(
            SYSTEMS.diagnosticServiceSection,
            isLab ? 'LAB' : 'RAD',
            isLab ? 'Laboratory' : 'Radiology',
          ),
        ],
      },
    ],
    code: {
      coding: [coding(input.order.system ?? SYSTEMS.loinc, input.order.loinc, input.order.display)],
      text: input.order.label,
    },
    subject: ref('Patient', input.patientId),
    effectiveDateTime: iso(input.collectedAt),
    issued: iso(input.issuedAt),
    ...(observations.length > 0
      ? { result: observations.map((obs) => ref('Observation', obs.id)) }
      : {}),
    ...(input.conclusion
      ? {
          conclusion: input.conclusion.text,
          conclusionCode: [
            {
              coding: [
                input.conclusion.abnormal
                  ? coding(SYSTEMS.snomed, '263654008', 'Abnormal')
                  : coding(SYSTEMS.snomed, '17621005', 'Normal'),
              ],
            },
          ],
        }
      : {}),
  };
  return [report, ...observations];
}

export interface AppointmentInput {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly specialty: Specialty;
  readonly start: Date;
  readonly minutes: number;
  readonly createdAt: Date;
  readonly status: 'booked' | 'cancelled';
  readonly description: string;
  readonly cancellationReason?: string;
}

export function appointmentResource(input: AppointmentInput): FhirResource {
  return {
    resourceType: 'Appointment',
    id: input.id,
    status: input.status,
    ...(input.status === 'cancelled' && input.cancellationReason
      ? { cancelationReason: { text: input.cancellationReason } }
      : {}),
    serviceType: [specialtyConcept(input.specialty)],
    description: input.description,
    start: iso(input.start),
    end: iso(new Date(input.start.getTime() + input.minutes * 60_000)),
    minutesDuration: input.minutes,
    created: iso(input.createdAt),
    participant: [
      { actor: ref('Patient', input.patientId), required: 'required', status: 'accepted' },
      {
        actor: ref('Practitioner', input.practitionerId),
        required: 'required',
        status: 'accepted',
      },
    ],
  };
}

export { isoDate };
