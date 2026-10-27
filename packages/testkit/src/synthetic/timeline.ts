import { BASE_DATE, type Specialty } from '../constants.ts';
import type { ConditionDefinition, MedicationDefinition, OrderDefinition } from './catalog.ts';
import {
  appointmentResource,
  conditionResource,
  type DateFact,
  dateObservationResource,
  documentReferenceResource,
  encounterResource,
  type FhirResource,
  interpretationOf,
  medicationRequestResource,
  patientResource,
  type PatientInput,
  resultResources,
  serviceRequestResource,
  transactionBundle,
  type TransactionBundle,
} from './fhir-builders.ts';
import type { Prng } from './prng.ts';

export const TIMELINE_ENTRY_KINDS = [
  'consultation',
  'result',
  'appointment_booked',
  'appointment_cancelled',
  'diagnosis',
  'allergy',
] as const;
export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number];

/** One message from the host EHR: a FHIR transaction Bundle and when it was sent. */
export interface TimelineEntry {
  /** ISO instant the host sent the bundle (equals the bundle `timestamp`). */
  readonly at: string;
  readonly kind: TimelineEntryKind;
  readonly bundle: TransactionBundle;
}

export interface ConsultationSpec {
  readonly start: Date;
  readonly minutes: number;
  readonly visitType: string;
  readonly reason?: string;
  readonly virtual?: boolean;
  readonly appointmentId?: string;
  readonly noteText: string;
  readonly conditions: readonly ConditionDefinition[];
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
  /** Seen by another clinician of the clinic (a referral): their id and specialty. */
  readonly provider?: Provider;
  /** Dates recorded at the visit (last menstrual period, estimated delivery date). */
  readonly dateFacts?: readonly DateFact[];
}

/** A clinician of the clinic other than the patient's usual one. */
export interface Provider {
  readonly practitionerId: string;
  readonly specialty: Specialty;
}

export interface ConsultationRecord {
  readonly encounterId: string;
  readonly documentId: string;
  readonly end: Date;
  readonly orderIds: ReadonlyMap<OrderDefinition, string>;
}

const MS_PER_MINUTE = 60_000;

/**
 * Builds one patient's history as the host would push it: a transaction
 * Bundle per saved consultation, per arrived result and per booking change.
 * Ids are stable and derived from the patient id.
 */
export class PatientTimeline {
  readonly entries: TimelineEntry[] = [];
  readonly patient: PatientInput;
  readonly specialty: Specialty;
  readonly practitionerId: string;
  readonly #counters = new Map<string, number>();
  #patientSent = false;

  constructor(patient: PatientInput, specialty: Specialty, practitionerId: string) {
    this.patient = patient;
    this.specialty = specialty;
    this.practitionerId = practitionerId;
  }

  nextId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${this.patient.id}-${kind}${String(next).padStart(2, '0')}`;
  }

  #push(kind: TimelineEntryKind, at: Date, resources: readonly FhirResource[]): void {
    const bundle = transactionBundle(this.nextId('bundle'), at, resources);
    this.entries.push({ at: at.toISOString(), kind, bundle });
  }

  /** A saved consultation: Encounter, note, orders, prescriptions, diagnoses (and Patient the first time). */
  consultation(spec: ConsultationSpec): ConsultationRecord {
    const encounterId = this.nextId('enc');
    const documentId = this.nextId('doc');
    const end = new Date(spec.start.getTime() + spec.minutes * MS_PER_MINUTE);
    const patientId = this.patient.id;
    const practitionerId = spec.provider?.practitionerId ?? this.practitionerId;
    const specialty = spec.provider?.specialty ?? this.specialty;
    const resources: FhirResource[] = [];
    if (!this.#patientSent) {
      resources.push(patientResource(this.patient));
      this.#patientSent = true;
    }
    resources.push(
      encounterResource({
        id: encounterId,
        patientId,
        practitionerId,
        specialty,
        start: spec.start,
        end,
        visitType: spec.visitType,
        ...(spec.virtual ? { virtual: true } : {}),
        ...(spec.reason ? { reason: spec.reason } : {}),
        ...(spec.appointmentId ? { appointmentId: spec.appointmentId } : {}),
      }),
      documentReferenceResource({
        id: documentId,
        patientId,
        practitionerId,
        encounterId,
        specialty,
        start: spec.start,
        authoredAt: end,
        text: spec.noteText,
      }),
    );
    const orderIds = new Map<OrderDefinition, string>();
    for (const order of spec.orders) {
      const id = this.nextId('sr');
      orderIds.set(order, id);
      resources.push(
        serviceRequestResource({
          id,
          patientId,
          practitionerId,
          encounterId,
          order,
          authoredOn: end,
        }),
      );
    }
    for (const medication of spec.medications) {
      resources.push(
        medicationRequestResource({
          id: this.nextId('mr'),
          patientId,
          practitionerId,
          encounterId,
          medication,
          authoredOn: end,
        }),
      );
    }
    for (const condition of spec.conditions) {
      resources.push(
        conditionResource({
          id: this.nextId('cond'),
          patientId,
          practitionerId,
          encounterId,
          condition,
          recordedAt: end,
        }),
      );
    }
    for (const fact of spec.dateFacts ?? []) {
      resources.push(
        dateObservationResource({
          id: this.nextId('obs'),
          patientId,
          fact,
          effectiveAt: end,
          category: 'exam',
          encounterId,
          practitionerId,
        }),
      );
    }
    this.#push('consultation', end, resources);
    return { encounterId, documentId, end, orderIds };
  }

  /**
   * A lab or imaging result. Skipped (returns false) if it would arrive
   * after the base date: at the base date it is still pending.
   */
  result(
    rng: Prng,
    order: OrderDefinition,
    orderId: string | undefined,
    orderedAt: Date,
    values: {
      readonly abnormal: boolean;
      readonly analyteValues?: readonly number[];
      /** Exact sample and report instants (otherwise 1 to 6 days after the order, reported 1 to 4 days later). */
      readonly timing?: { readonly collectedAt: Date; readonly issuedAt: Date };
      readonly dateFacts?: readonly DateFact[];
    },
  ): boolean {
    const collectedAt =
      values.timing?.collectedAt ??
      new Date(orderedAt.getTime() + rng.int(1, 6) * 86_400_000 + rng.int(0, 120) * MS_PER_MINUTE);
    const issuedAt =
      values.timing?.issuedAt ?? new Date(collectedAt.getTime() + rng.int(1, 4) * 86_400_000);
    if (issuedAt > BASE_DATE) return false;
    const reportId = this.nextId('dr');
    const analytes = order.analytes?.map((analyte, index) => ({
      analyte,
      value: values.analyteValues?.[index] ?? normalValue(rng, analyte),
    }));
    const conclusion = order.conclusions
      ? {
          text: values.abnormal ? order.conclusions[1] : order.conclusions[0],
          abnormal: values.abnormal,
        }
      : undefined;
    this.#push(
      'result',
      issuedAt,
      resultResources({
        reportId,
        patientId: this.patient.id,
        order,
        ...(orderId ? { orderId } : {}),
        collectedAt,
        issuedAt,
        ...(analytes ? { analytes } : {}),
        ...(conclusion ? { conclusion } : {}),
        ...(values.dateFacts ? { dateFacts: values.dateFacts } : {}),
      }),
    );
    return true;
  }

  /**
   * A diagnosis entered outside a visit, on the patient's problem list (a
   * delivery the hospital reported): a Condition with no Encounter.
   */
  diagnosis(condition: ConditionDefinition, recordedAt: Date, onsetAt?: Date): void {
    this.#push('diagnosis', recordedAt, [
      conditionResource({
        id: this.nextId('cond'),
        patientId: this.patient.id,
        practitionerId: this.practitionerId,
        condition,
        recordedAt,
        ...(onsetAt ? { onsetAt } : {}),
      }),
    ]);
  }

  /** Books a future appointment (with the patient's usual clinician unless `provider` says otherwise); returns its id. */
  book(
    createdAt: Date,
    start: Date,
    minutes: number,
    description: string,
    provider?: Provider,
  ): string {
    const id = this.nextId('appt');
    this.#push('appointment_booked', createdAt, [
      appointmentResource({
        id,
        patientId: this.patient.id,
        practitionerId: provider?.practitionerId ?? this.practitionerId,
        specialty: provider?.specialty ?? this.specialty,
        start,
        minutes,
        createdAt,
        status: 'booked',
        description,
      }),
    ]);
    return id;
  }

  cancel(
    id: string,
    at: Date,
    bookedAt: Date,
    start: Date,
    minutes: number,
    description: string,
    provider?: Provider,
  ): void {
    this.#push('appointment_cancelled', at, [
      appointmentResource({
        id,
        patientId: this.patient.id,
        practitionerId: provider?.practitionerId ?? this.practitionerId,
        specialty: provider?.specialty ?? this.specialty,
        start,
        minutes,
        createdAt: bookedAt,
        status: 'cancelled',
        description,
        cancellationReason: 'Paciente cancela por motivos personales',
      }),
    ]);
  }

  sorted(): TimelineEntry[] {
    return [...this.entries].sort((a, b) => a.at.localeCompare(b.at));
  }
}

/** A plausible normal value for an analyte, inside its reference range. */
export function normalValue(
  rng: Prng,
  analyte: { low?: number; high?: number; decimals: number },
): number {
  const low = analyte.low ?? (analyte.high ?? 1) * 0.55;
  const high = analyte.high ?? (analyte.low ?? 1) * 1.8;
  const value = low + (high - low) * (0.2 + rng.next() * 0.6);
  const factor = 10 ** analyte.decimals;
  return Math.round(value * factor) / factor;
}

export { interpretationOf };
