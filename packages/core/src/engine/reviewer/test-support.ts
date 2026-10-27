import type { FollowUpCase } from '../../domain/case.ts';
import type {
  AppointmentBookedEvent,
  ClinicalEvent,
  ConditionRecordedEvent,
  EncounterFinishedEvent,
  MedicationPrescribedEvent,
  NoteReceivedEvent,
  ResultReceivedEvent,
} from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { type ClinicId, clinicId, type PatientId, patientId } from '../../domain/ids.ts';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import type { PatientRecordSnapshot } from './dossier.ts';

/*
 * Builders of reviewer test records (tests only; not exported by the
 * package). Days count from NOW, negative in the past.
 */

export const CLINIC: ClinicId = clinicId('clinic-reviewer-test');
export const PATIENT: PatientId = patientId('pat-reviewer-test');
export const NOW = new Date('2026-01-05T12:00:00.000Z');
const DAY = 86_400_000;

export function day(offset: number): Date {
  return new Date(NOW.getTime() + offset * DAY);
}

let sequence = 0;
function base(type: string, at: Date, resourceType: string, id?: string) {
  sequence += 1;
  const resourceId = id ?? `${resourceType.toLowerCase()}-${String(sequence)}`;
  return {
    clinicId: CLINIC,
    patientId: PATIENT,
    source: { resourceType, id: resourceId },
    occurredAt: at,
    idempotencyKey: `${resourceType}/${resourceId}#${type}#${String(sequence)}`,
  };
}

export function note(
  offset: number,
  text: string,
  options: {
    readonly specialty?: string;
    readonly id?: string;
    readonly encounterId?: string;
  } = {},
): NoteReceivedEvent {
  const at = day(offset);
  const event = base('note.received', at, 'DocumentReference', options.id);
  return {
    ...event,
    type: 'note.received',
    documentId: event.source.id,
    text,
    authoredAt: at,
    ...(options.specialty === undefined ? {} : { specialty: options.specialty }),
    ...(options.encounterId === undefined ? {} : { encounterId: options.encounterId }),
  };
}

export function encounter(offset: number, specialty = 'diabetology'): EncounterFinishedEvent {
  return {
    ...base('encounter.finished', day(offset), 'Encounter'),
    type: 'encounter.finished',
    specialty,
  };
}

export function result(
  offset: number,
  loinc: string,
  value: number,
  unit: string,
  options: { readonly id?: string } = {},
): ResultReceivedEvent {
  return {
    ...base('result.received', day(offset), 'Observation', options.id),
    type: 'result.received',
    code: { system: 'http://loinc.org', code: loinc },
    interpretation: 'unknown',
    value: { value, unit },
  };
}

export function medication(
  offset: number,
  text: string,
  options: {
    readonly atc?: string;
    readonly durationDays?: number;
    readonly dosageText?: string;
  } = {},
): MedicationPrescribedEvent {
  const at = day(offset);
  return {
    ...base('medication.prescribed', at, 'MedicationRequest'),
    type: 'medication.prescribed',
    medication: {
      text,
      ...(options.atc === undefined
        ? {}
        : { code: { system: 'http://www.whocc.no/atc', code: options.atc } }),
    },
    startAt: at,
    ...(options.durationDays === undefined ? {} : { durationDays: options.durationDays }),
    ...(options.dosageText === undefined ? {} : { dosageText: options.dosageText }),
  };
}

export function condition(offset: number, code: string, display: string): ConditionRecordedEvent {
  return {
    ...base('condition.recorded', day(offset), 'Condition'),
    type: 'condition.recorded',
    code: { system: ICD10_SYSTEM, code, display },
    verification: 'confirmed',
  };
}

export function booking(offset: number, scheduledIn: number): AppointmentBookedEvent {
  return {
    ...base('appointment.booked', day(offset), 'Appointment'),
    type: 'appointment.booked',
    scheduledFor: day(scheduledIn),
  };
}

export function snapshot(
  events: readonly ClinicalEvent[],
  overrides: Partial<PatientRecordSnapshot> = {},
): PatientRecordSnapshot {
  return {
    clinicId: CLINIC,
    patientId: PATIENT,
    now: NOW,
    birthDate: '1957-06-12',
    gender: 'male',
    events: [...events].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    ),
    conditions: [],
    liveExpectations: [],
    activeCases: [],
    ...overrides,
  };
}

export function anExpectation(
  overrides: Partial<Expectation> & Pick<Expectation, 'source'>,
): Expectation {
  return {
    id: 'exp-1' as Expectation['id'],
    clinicId: CLINIC,
    patientId: PATIENT,
    idempotencyKey: 'key-1',
    ruleId: 'abnormal_result_followup',
    ruleVersion: '1.0.0',
    layer: 'universal',
    matchKey: 'visit',
    dueAt: day(5),
    status: 'open',
    origin: 'live',
    reason: { code: 'abnormal_result_followup', label: 'Resultado alterado sin control' },
    createdAt: day(-5),
    updatedAt: day(-5),
    ...overrides,
  };
}

export function aCase(expectationId: string): FollowUpCase {
  return {
    id: 'case-1' as FollowUpCase['id'],
    clinicId: CLINIC,
    patientId: PATIENT,
    dedupKey: 'follow_up',
    reasons: [
      { expectationId: expectationId as Expectation['id'], reasonCode: 'abnormal_result_followup' },
    ],
    status: 'open',
    priority: 80,
    escalationStep: 0,
    origin: 'live',
    createdAt: day(-1),
    updatedAt: day(-1),
  };
}
