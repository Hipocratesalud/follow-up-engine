import { describe, expect, it } from 'vitest';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { clinicId, patientId } from '../../domain/ids.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { latestAppointmentVersions, PatientTimeline } from '../timeline.ts';
import { bookingLapsed, bookingToleranceDays, type CorrelationTarget } from './correlation.ts';
import { canonicalSpecialty, clauseAround, specialtiesNamedIn } from './specialty.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-01-05T12:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const base = { clinicId: clinicId('c'), patientId: patientId('p') };

function booked(version: number, start: number, created: number, recorded?: number) {
  return {
    ...base,
    type: 'appointment.booked',
    source: { resourceType: 'Appointment', id: 'ap-1' },
    occurredAt: at(created),
    ...(recorded === undefined ? {} : { recordedAt: at(recorded) }),
    idempotencyKey: `Appointment/ap-1/${String(version)}#appointment.booked`,
    scheduledFor: at(start),
  } as const satisfies ClinicalEvent;
}

function cancelled(version: number, recorded: number) {
  return {
    ...base,
    type: 'appointment.cancelled',
    source: { resourceType: 'Appointment', id: 'ap-1' },
    occurredAt: at(recorded),
    recordedAt: at(recorded),
    idempotencyKey: `Appointment/ap-1/${String(version)}#appointment.cancelled`,
    scheduledFor: at(10),
  } as const satisfies ClinicalEvent;
}

function target(dueInDays: number, severity?: 'critical'): CorrelationTarget {
  return {
    expectation: {
      dueAt: at(dueInDays),
      createdAt: at(0),
      ...(severity === undefined ? {} : { severity }),
    } as Expectation,
    definition: {} as ExpectationDefinition,
    kind: 'follow_up_visit',
    specialties: new Set(),
    context: {},
  };
}

describe('appointment versions (HIP-133)', () => {
  it('keeps only the latest version of each Appointment', () => {
    const rescheduled = latestAppointmentVersions([booked(1, 10, 1, 1), booked(2, 60, 1, 8)]);
    expect(rescheduled.map((event) => event.idempotencyKey)).toEqual([
      'Appointment/ap-1/2#appointment.booked',
    ]);
    // Booked again after a cancellation: dated by when the host recorded it, not by `created`.
    const timeline = new PatientTimeline([
      booked(1, 10, 1, 1),
      cancelled(2, 5),
      booked(3, 12, 1, 6),
    ]);
    expect(timeline.ofType('appointment.booked').map((event) => event.scheduledFor)).toEqual([
      at(12),
    ]);
    const stillCancelled = new PatientTimeline([booked(1, 10, 1, 1), cancelled(2, 5)]);
    expect(stillCancelled.ofType('appointment.booked')).toEqual([]);
  });

  it('a booking lapses once its date and grace days pass', () => {
    expect(bookingLapsed(booked(1, 10, 1), { now: at(11), bookingGraceDays: 2 })).toBe(false);
    expect(bookingLapsed(booked(1, 10, 1), { now: at(12), bookingGraceDays: 2 })).toBe(true);
    expect(bookingLapsed(booked(1, 10, 1), {})).toBe(false);
  });
});

describe('booking tolerance (HIP-133)', () => {
  const correlation = { event: 'appointment.booked', match: 'any' } as const;

  it('scales with the interval, never below the fixed days', () => {
    expect(bookingToleranceDays(correlation, target(7))).toBe(3);
    expect(bookingToleranceDays(correlation, target(14))).toBe(3);
    expect(bookingToleranceDays(correlation, target(30))).toBe(5);
    expect(bookingToleranceDays(correlation, target(90))).toBe(14);
    expect(bookingToleranceDays(correlation, target(180))).toBe(27);
  });

  it('is configurable per correlation and strict for critical results', () => {
    expect(bookingToleranceDays({ ...correlation, toleranceFraction: 0 }, target(90))).toBe(3);
    expect(bookingToleranceDays({ ...correlation, toleranceDays: 7 }, target(14))).toBe(7);
    expect(bookingToleranceDays(correlation, target(1, 'critical'))).toBe(0);
  });
});

describe('specialties (HIP-133)', () => {
  it('compares codes and labels in Spanish or English', () => {
    expect(canonicalSpecialty('Cardiología')).toBe('cardiology');
    expect(canonicalSpecialty('Medicina Interna')).toBe('internal_medicine');
    expect(canonicalSpecialty('internal_medicine')).toBe('internal_medicine');
    expect(canonicalSpecialty('Diabetología')).toBe('diabetology');
    expect(canonicalSpecialty('Clínica del dolor')).toBe('clinica_del_dolor');
  });

  it('reads the specialties a plan item names, in its own clause only', () => {
    const note = 'Soplo cardiaco. Plan: control con cardiología en 1 mes.';
    expect(clauseAround(note, 'en 1 mes')).toBe(' control con cardiologia en 1 mes');
    expect(specialtiesNamedIn(clauseAround(note, 'en 1 mes'))).toEqual(new Set(['cardiology']));
    const other = 'Interconsulta con cardiología y control en 3 meses.';
    expect(specialtiesNamedIn(clauseAround(other, 'control en 3 meses'))).toEqual(new Set());
    expect(specialtiesNamedIn('Soplo cardiaco')).toEqual(new Set());
  });
});
