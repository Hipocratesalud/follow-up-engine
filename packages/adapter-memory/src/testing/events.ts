import {
  type AppointmentBookedEvent,
  type AppointmentCancelledEvent,
  type ClinicalBatch,
  type ClinicalEvent,
  type ClinicId,
  type Coding,
  type ConditionRecordedEvent,
  type EncounterFinishedEvent,
  ICD10_SYSTEM,
  type MedicationPrescribedEvent,
  type NoteReceivedEvent,
  type PatientId,
  type PatientOptedOutEvent,
  type PractitionerId,
  type ResultInterpretation,
  type ResultReceivedEvent,
  type ServiceCategory,
  type ServiceRequestCreatedEvent,
} from '@follow-up-engine/core';

export const LOINC_SYSTEM = 'http://loinc.org';

/** Synthetic lab and imaging codes used across scenarios. */
export const CODES = {
  hba1c: { system: LOINC_SYSTEM, code: '4548-4', display: 'Hemoglobin A1c' },
  lipidPanel: { system: LOINC_SYSTEM, code: '24331-1', display: 'Lipid panel' },
  creatinine: { system: LOINC_SYSTEM, code: '2160-0', display: 'Creatinine' },
  potassium: { system: LOINC_SYSTEM, code: '2823-3', display: 'Potassium' },
  glucose: { system: LOINC_SYSTEM, code: '2345-7', display: 'Glucose' },
  chestXray: { system: LOINC_SYSTEM, code: '36643-5', display: 'Chest X-ray 2 views' },
} as const satisfies Readonly<Record<string, Coding>>;

/** Who and when an event is about. */
export interface EventContext {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly at: Date;
  readonly encounterId?: string;
}

function base<TType extends ClinicalEvent['type']>(
  context: EventContext,
  type: TType,
  resourceType: string,
  id: string,
): {
  readonly type: TType;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly source: { readonly resourceType: string; readonly id: string };
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly encounterId?: string;
} {
  return {
    type,
    clinicId: context.clinicId,
    patientId: context.patientId,
    source: { resourceType, id },
    occurredAt: context.at,
    idempotencyKey: `${resourceType}/${id}/1#${type}`,
    ...(context.encounterId === undefined ? {} : { encounterId: context.encounterId }),
  };
}

export function icd10(code: string): Coding {
  return { system: ICD10_SYSTEM, code };
}

export function encounterFinished(
  context: EventContext,
  input: { readonly id: string; readonly practitionerId?: string; readonly specialty?: string },
): EncounterFinishedEvent {
  return {
    ...base({ ...context, encounterId: input.id }, 'encounter.finished', 'Encounter', input.id),
    ...(input.practitionerId === undefined
      ? {}
      : { practitionerId: input.practitionerId as PractitionerId }),
    ...(input.specialty === undefined ? {} : { specialty: input.specialty }),
  };
}

export function serviceRequest(
  context: EventContext,
  input: { readonly id: string; readonly code: Coding; readonly category: ServiceCategory },
): ServiceRequestCreatedEvent {
  return {
    ...base(context, 'service_request.created', 'ServiceRequest', input.id),
    orderId: input.id,
    code: input.code,
    category: input.category,
  };
}

export function resultReceived(
  context: EventContext,
  input: {
    readonly id: string;
    readonly code: Coding;
    readonly interpretation?: ResultInterpretation;
    readonly basedOnOrderId?: string;
    readonly value?: number;
  },
): ResultReceivedEvent {
  return {
    ...base(context, 'result.received', 'Observation', input.id),
    code: input.code,
    interpretation: input.interpretation ?? 'normal',
    ...(input.basedOnOrderId === undefined ? {} : { basedOnOrderId: input.basedOnOrderId }),
    ...(input.value === undefined ? {} : { value: { value: input.value } }),
  };
}

export function medicationPrescribed(
  context: EventContext,
  input: {
    readonly id: string;
    readonly text: string;
    readonly durationDays?: number;
    readonly code?: Coding;
  },
): MedicationPrescribedEvent {
  return {
    ...base(context, 'medication.prescribed', 'MedicationRequest', input.id),
    medication: { text: input.text, ...(input.code === undefined ? {} : { code: input.code }) },
    startAt: context.at,
    ...(input.durationDays === undefined ? {} : { durationDays: input.durationDays }),
  };
}

export function conditionRecorded(
  context: EventContext,
  input: { readonly id: string; readonly icd10: string; readonly provisional?: boolean },
): ConditionRecordedEvent {
  return {
    ...base(context, 'condition.recorded', 'Condition', input.id),
    code: icd10(input.icd10),
    verification: input.provisional === true ? 'provisional' : 'confirmed',
  };
}

export function noteReceived(
  context: EventContext,
  input: { readonly id: string; readonly text: string; readonly specialty?: string },
): NoteReceivedEvent {
  return {
    ...base(context, 'note.received', 'DocumentReference', input.id),
    documentId: input.id,
    text: input.text,
    authoredAt: context.at,
    ...(input.specialty === undefined ? {} : { specialty: input.specialty }),
  };
}

export function appointmentBooked(
  context: EventContext,
  input: {
    readonly id: string;
    readonly scheduledFor: Date;
    readonly specialty?: string;
    readonly practitionerId?: string;
  },
): AppointmentBookedEvent {
  return {
    ...base(context, 'appointment.booked', 'Appointment', input.id),
    scheduledFor: input.scheduledFor,
    ...(input.specialty === undefined ? {} : { specialty: input.specialty }),
    ...(input.practitionerId === undefined
      ? {}
      : { practitionerId: input.practitionerId as PractitionerId }),
  };
}

export function appointmentCancelled(
  context: EventContext,
  input: { readonly id: string; readonly scheduledFor: Date },
): AppointmentCancelledEvent {
  return {
    ...base(context, 'appointment.cancelled', 'Appointment', input.id),
    idempotencyKey: `Appointment/${input.id}/2#appointment.cancelled`,
    scheduledFor: input.scheduledFor,
  };
}

export function patientOptedOut(
  context: EventContext,
  input: { readonly id: string },
): PatientOptedOutEvent {
  return base(context, 'patient.opted_out', 'Consent', input.id);
}

/** A saved consultation, described the way a clinician would. */
export interface ConsultationSpec {
  readonly encounterId: string;
  readonly specialty?: string;
  readonly practitionerId?: string;
  readonly note?: { readonly id: string; readonly text: string };
  readonly conditions?: readonly {
    readonly id: string;
    readonly icd10: string;
    readonly provisional?: boolean;
  }[];
  readonly labs?: readonly { readonly id: string; readonly code: Coding }[];
  readonly imaging?: readonly { readonly id: string; readonly code: Coding }[];
  readonly medications?: readonly {
    readonly id: string;
    readonly text: string;
    readonly durationDays?: number;
  }[];
  readonly results?: readonly {
    readonly id: string;
    readonly code: Coding;
    readonly interpretation?: ResultInterpretation;
    readonly value?: number;
  }[];
  readonly booking?: {
    readonly id: string;
    readonly scheduledFor: Date;
    readonly specialty?: string;
  };
}

/** The events of one consultation as a {@link ClinicalBatch}. */
export function consultation(
  context: Omit<EventContext, 'encounterId'>,
  spec: ConsultationSpec,
): ClinicalBatch {
  const inEncounter: EventContext = { ...context, encounterId: spec.encounterId };
  const events: ClinicalEvent[] = [
    encounterFinished(context, {
      id: spec.encounterId,
      ...(spec.practitionerId === undefined ? {} : { practitionerId: spec.practitionerId }),
      ...(spec.specialty === undefined ? {} : { specialty: spec.specialty }),
    }),
    ...(spec.conditions ?? []).map((condition) => conditionRecorded(inEncounter, condition)),
    ...(spec.labs ?? []).map((lab) =>
      serviceRequest(inEncounter, { ...lab, category: 'laboratory' }),
    ),
    ...(spec.imaging ?? []).map((study) =>
      serviceRequest(inEncounter, { ...study, category: 'imaging' }),
    ),
    ...(spec.medications ?? []).map((medication) => medicationPrescribed(inEncounter, medication)),
    ...(spec.results ?? []).map((result) => resultReceived(inEncounter, result)),
  ];
  if (spec.note !== undefined) {
    events.push(
      noteReceived(inEncounter, {
        ...spec.note,
        ...(spec.specialty === undefined ? {} : { specialty: spec.specialty }),
      }),
    );
  }
  if (spec.booking !== undefined) {
    events.push(appointmentBooked(inEncounter, spec.booking));
  }
  return {
    clinicId: context.clinicId,
    patientId: context.patientId,
    encounterId: spec.encounterId,
    receivedAt: context.at,
    events,
  };
}

/** Wraps loose events of one patient into a batch. */
export function batchOf(
  context: Omit<EventContext, 'encounterId'>,
  events: readonly ClinicalEvent[],
): ClinicalBatch {
  return {
    clinicId: context.clinicId,
    patientId: context.patientId,
    receivedAt: context.at,
    events,
  };
}
