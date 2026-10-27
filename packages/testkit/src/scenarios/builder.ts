import { DEMO_CLINIC_ID, SYSTEMS, type Specialty, dayToDate } from '../constants.ts';
import type {
  ConditionDefinition,
  MedicationDefinition,
  OrderDefinition,
} from '../synthetic/catalog.ts';
import {
  appointmentResource,
  conditionResource,
  documentReferenceResource,
  encounterResource,
  type FhirResource,
  medicationRequestResource,
  patientResource,
  type PatientInput,
  resultResources,
  serviceRequestResource,
  transactionBundle,
} from '../synthetic/fhir-builders.ts';
import type { LlmFixtureExtraction, Scenario, ScenarioCheckpoint, ScenarioStep } from './types.ts';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** The extraction a careful reader would produce, with quotes checked against the note. */
export interface ExtractionSpec {
  readonly hasPlan: boolean;
  readonly conditions: readonly {
    readonly icd10: string;
    readonly display: string;
    readonly quote: string;
  }[];
  readonly medications: readonly {
    readonly text: string;
    readonly quote: string;
    readonly durationDays?: number;
  }[];
  readonly planItems: readonly {
    readonly kind: LlmFixtureExtraction['planItems'][number]['kind'];
    readonly description: string;
    readonly inDays: number;
    readonly quote: string;
    readonly loinc?: { readonly code: string; readonly display: string };
  }[];
}

export interface ConsultationStepSpec {
  readonly visitType: string;
  readonly note: string;
  readonly conditions: readonly ConditionDefinition[];
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
  readonly extraction: ExtractionSpec;
}

function requireQuote(note: string, quote: string, documentId: string): string {
  if (!note.includes(quote)) {
    throw new Error(`Evidence quote "${quote}" is not in the note of ${documentId}`);
  }
  return quote;
}

/**
 * Builds a scenario step by step. Every bundle of day `d` is stamped at
 * exactly `BASE_DATE + d` (12:00 UTC), so expected due dates are whole days.
 */
export class ScenarioBuilder {
  readonly patient: PatientInput;
  readonly specialty: Specialty;
  readonly practitionerId: string;
  readonly #steps: ScenarioStep[] = [];
  readonly #llmFixture: Record<string, LlmFixtureExtraction> = {};
  readonly #counters = new Map<string, number>();
  #patientSent = false;

  constructor(patient: PatientInput, specialty: Specialty, practitionerId: string) {
    this.patient = patient;
    this.specialty = specialty;
    this.practitionerId = practitionerId;
  }

  #id(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${this.patient.id}-${kind}${String(next).padStart(2, '0')}`;
  }

  #push(day: number, resources: readonly FhirResource[]): void {
    this.#steps.push({
      day,
      bundle: transactionBundle(this.#id('bundle'), dayToDate(day), resources),
    });
  }

  #patientIfFirst(): FhirResource[] {
    if (this.#patientSent) return [];
    this.#patientSent = true;
    return [patientResource(this.patient)];
  }

  consultation(day: number, spec: ConsultationStepSpec): { readonly orderIds: readonly string[] } {
    const end = dayToDate(day);
    const start = new Date(end.getTime() - 30 * MS_PER_MINUTE);
    const encounterId = this.#id('enc');
    const documentId = this.#id('doc');
    const { practitionerId } = this;
    const patientId = this.patient.id;
    const orderIds: string[] = [];
    const resources: FhirResource[] = [
      ...this.#patientIfFirst(),
      encounterResource({
        id: encounterId,
        patientId,
        practitionerId,
        specialty: this.specialty,
        start,
        end,
        visitType: spec.visitType,
      }),
      documentReferenceResource({
        id: documentId,
        patientId,
        practitionerId,
        encounterId,
        specialty: this.specialty,
        start,
        authoredAt: end,
        text: spec.note,
      }),
      ...spec.orders.map((order) => {
        const id = this.#id('sr');
        orderIds.push(id);
        return serviceRequestResource({
          id,
          patientId,
          practitionerId,
          encounterId,
          order,
          authoredOn: end,
        });
      }),
      ...spec.medications.map((medication) =>
        medicationRequestResource({
          id: this.#id('mr'),
          patientId,
          practitionerId,
          encounterId,
          medication,
          authoredOn: end,
        }),
      ),
      ...spec.conditions.map((condition) =>
        conditionResource({
          id: this.#id('cond'),
          patientId,
          practitionerId,
          encounterId,
          condition,
          recordedAt: end,
        }),
      ),
    ];
    this.#push(day, resources);
    this.#llmFixture[documentId] = this.#extraction(documentId, spec.note, end, spec.extraction);
    return { orderIds };
  }

  #extraction(
    documentId: string,
    note: string,
    authoredAt: Date,
    spec: ExtractionSpec,
  ): LlmFixtureExtraction {
    return {
      hasPlan: spec.hasPlan,
      conditions: spec.conditions.map((condition) => ({
        code: { system: SYSTEMS.icd10, code: condition.icd10, display: condition.display },
        confidence: 0.95,
        evidenceQuote: requireQuote(note, condition.quote, documentId),
      })),
      medications: spec.medications.map((medication) => ({
        text: medication.text,
        ...(medication.durationDays === undefined ? {} : { durationDays: medication.durationDays }),
        evidenceQuote: requireQuote(note, medication.quote, documentId),
      })),
      planItems: spec.planItems.map((item) => ({
        kind: item.kind,
        description: item.description,
        dueAt: new Date(authoredAt.getTime() + item.inDays * MS_PER_DAY).toISOString(),
        evidenceQuote: requireQuote(note, item.quote, documentId),
        confidence: 0.9,
        ...(item.loinc
          ? { code: { system: SYSTEMS.loinc, code: item.loinc.code, display: item.loinc.display } }
          : {}),
      })),
      model: 'fixture',
      promptVersion: 'fixture-1',
      costUsd: 0,
    };
  }

  /** An order placed outside a consultation (re-issued or added later). */
  order(day: number, order: OrderDefinition): string {
    const id = this.#id('sr');
    this.#push(day, [
      ...this.#patientIfFirst(),
      serviceRequestResource({
        id,
        patientId: this.patient.id,
        practitionerId: this.practitionerId,
        order,
        authoredOn: dayToDate(day),
      }),
    ]);
    return id;
  }

  /** A result issued (and collected) at `BASE_DATE + day`. */
  result(
    day: number,
    order: OrderDefinition,
    orderId: string | undefined,
    analyteValues: readonly number[],
  ): void {
    const at = dayToDate(day);
    this.#push(
      day,
      resultResources({
        reportId: this.#id('dr'),
        patientId: this.patient.id,
        order,
        ...(orderId ? { orderId } : {}),
        collectedAt: at,
        issuedAt: at,
        analytes: (order.analytes ?? []).map((analyte, index) => ({
          analyte,
          value: analyteValues[index] ?? analyte.low ?? 0,
        })),
      }),
    );
  }

  /** Books an appointment at `day` for `BASE_DATE + startDay`. */
  booking(day: number, startDay: number, description: string): void {
    this.#push(day, [
      appointmentResource({
        id: this.#id('appt'),
        patientId: this.patient.id,
        practitionerId: this.practitionerId,
        specialty: this.specialty,
        start: dayToDate(startDay),
        minutes: 30,
        createdAt: dayToDate(day),
        status: 'booked',
        description,
      }),
    ]);
  }

  build(name: string, description: string, expect: readonly ScenarioCheckpoint[]): Scenario {
    return {
      name,
      description,
      clinicId: DEMO_CLINIC_ID,
      patientId: this.patient.id,
      specialty: this.specialty,
      steps: [...this.#steps],
      llmFixture: { ...this.#llmFixture },
      expect,
    };
  }
}
