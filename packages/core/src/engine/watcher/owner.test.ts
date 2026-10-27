import { describe, expect, it } from 'vitest';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { clinicId, patientId, practitionerId } from '../../domain/ids.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { PatientTimeline } from '../timeline.ts';
import { caseOwner } from './owner.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-01-05T12:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const base = { clinicId: clinicId('c'), patientId: patientId('p') };

function visit(id: string, day: number, specialty: string, practitioner: string): ClinicalEvent {
  return {
    ...base,
    type: 'encounter.finished',
    source: { resourceType: 'Encounter', id },
    encounterId: id,
    occurredAt: at(day),
    idempotencyKey: `Encounter/${id}#encounter.finished`,
    specialty,
    practitionerId: practitionerId(practitioner),
  };
}

function result(id: string, day: number, basedOnOrderId?: string): ClinicalEvent {
  return {
    ...base,
    type: 'result.received',
    source: { resourceType: 'Observation', id },
    occurredAt: at(day),
    idempotencyKey: `Observation/${id}#result.received`,
    code: { system: 'http://loinc.org', code: '3016-3' },
    interpretation: 'normal',
    ...(basedOnOrderId === undefined ? {} : { basedOnOrderId }),
  };
}

function order(id: string, day: number, encounterId: string): ClinicalEvent {
  return {
    ...base,
    type: 'service_request.created',
    source: { resourceType: 'ServiceRequest', id },
    encounterId,
    occurredAt: at(day),
    idempotencyKey: `ServiceRequest/${id}#service_request.created`,
    orderId: id,
    code: { system: 'http://loinc.org', code: '3016-3' },
    category: 'laboratory',
  };
}

const expectationOn = (resourceType: string, id: string) =>
  ({ source: { resourceType, id } }) as unknown as Expectation;
const protocol = { specialties: ['internal_medicine'] } as unknown as ExpectationDefinition;

describe('case owner (clinical audit 2026-10-27)', () => {
  const timeline = new PatientTimeline([
    visit('enc-im', -200, 'internal_medicine', 'prac-im-1'),
    visit('enc-gyn', -100, 'gynecology', 'prac-gyn-1'),
    order('sr-1', -300, 'enc-old'),
    visit('enc-old', -300, 'internal_medicine', 'prac-im-2'),
    result('obs-standalone', -150),
    result('obs-ordered', -290, 'sr-1'),
  ]);

  it('a protocol reason on a standalone result goes to the last treating clinician of the protocol', () => {
    expect(
      caseOwner(expectationOn('Observation', 'obs-standalone'), timeline, 'front_desk', protocol),
    ).toBe('prac-im-1');
  });

  it('a result linked to its order goes to the clinician who ordered it', () => {
    expect(caseOwner(expectationOn('Observation', 'obs-ordered'), timeline, 'front_desk')).toBe(
      'prac-im-2',
    );
  });

  it('a visit-anchored reason keeps its consultation practitioner', () => {
    expect(caseOwner(expectationOn('Encounter', 'enc-gyn'), timeline, 'front_desk', protocol)).toBe(
      'prac-gyn-1',
    );
  });

  it('the front desk only when the record names no practitioner', () => {
    expect(
      caseOwner(
        expectationOn('Observation', 'obs-standalone'),
        new PatientTimeline([result('obs-standalone', -150)]),
        'front_desk',
        protocol,
      ),
    ).toBe('front_desk');
  });
});
