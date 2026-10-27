import type {
  ClinicalBatch,
  ClinicalEvent,
  ClinicalEventOf,
  ClinicalEventType,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  buildConsultationBundle,
  mapBundleToBatches,
  type BundleMappingResult,
} from '../src/index.ts';
import { clone, loadBundle } from './helpers.ts';

const CLINIC = 'clinic-demo';
const RECEIVED_AT = new Date('2026-01-05T20:00:00Z');

function map(bundle: unknown): BundleMappingResult {
  return mapBundleToBatches(bundle, { clinicId: CLINIC, receivedAt: RECEIVED_AT });
}

function onlyBatch(result: BundleMappingResult): ClinicalBatch {
  expect(result.batches).toHaveLength(1);
  const [batch] = result.batches;
  if (batch === undefined) {
    throw new Error('expected one batch');
  }
  return batch;
}

function eventsOf<T extends ClinicalEventType>(
  batch: ClinicalBatch,
  type: T,
): ClinicalEventOf<T>[] {
  return batch.events.filter((event): event is ClinicalEventOf<T> => event.type === type);
}

function types(batch: ClinicalBatch): ClinicalEvent['type'][] {
  return batch.events.map((event) => event.type);
}

function issueSeverities(result: BundleMappingResult): string[] {
  return (result.issues?.issue ?? []).map((issue) => issue.severity);
}

const DM_PATIENT = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01';
const DM_ENCOUNTER = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03';
const DM_HBA1C_ORDER = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05';

describe('consultation bundles, one per specialty', () => {
  it('diabetology: urn:uuid transaction with a new patient becomes one consultation batch', () => {
    const result = map(loadBundle('consultation-diabetology'));
    expect(result.issues).toBeUndefined();
    const batch = onlyBatch(result);

    expect(batch).toMatchObject({
      clinicId: CLINIC,
      patientId: DM_PATIENT,
      encounterId: DM_ENCOUNTER,
    });
    expect(batch.receivedAt).toEqual(RECEIVED_AT);
    expect(types(batch)).toEqual([
      'encounter.finished',
      'note.received',
      'service_request.created',
      'service_request.created',
      'medication.prescribed',
      'condition.recorded',
    ]);
    for (const event of batch.events) {
      expect(event).toMatchObject({
        clinicId: CLINIC,
        patientId: DM_PATIENT,
        encounterId: DM_ENCOUNTER,
      });
    }

    const [encounter] = eventsOf(batch, 'encounter.finished');
    expect(encounter).toMatchObject({
      practitionerId: '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02',
      specialty: 'diabetology',
      occurredAt: new Date('2026-01-05T18:30:00Z'),
    });

    const [note] = eventsOf(batch, 'note.received');
    expect(note?.text).toContain('Plan: continuar metformina 850 mg c/12h.');
    expect(note).toMatchObject({
      specialty: 'diabetology',
      authoredAt: new Date('2026-01-05T18:30:00Z'),
    });

    const orders = eventsOf(batch, 'service_request.created');
    expect(orders.map((order) => [order.orderId, order.code.code, order.category])).toEqual([
      [DM_HBA1C_ORDER, '4548-4', 'laboratory'],
      ['5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06', '57698-3', 'laboratory'],
    ]);

    const [medication] = eventsOf(batch, 'medication.prescribed');
    expect(medication).toMatchObject({
      medication: { text: 'metformina 850 mg', code: { code: '861004' } },
      durationDays: 90,
      startAt: new Date('2026-01-05T18:30:00Z'),
    });

    const [condition] = eventsOf(batch, 'condition.recorded');
    expect(condition).toMatchObject({
      code: { system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' },
      verification: 'confirmed',
    });
  });

  it('diabetology: stores every resource with urn:uuid references rewritten to Type/id', () => {
    const { resources } = map(loadBundle('consultation-diabetology'));
    expect(resources.map(({ resource }) => resource.resourceType)).toEqual([
      'Patient',
      'Encounter',
      'DocumentReference',
      'ServiceRequest',
      'ServiceRequest',
      'MedicationRequest',
      'Condition',
    ]);
    const encounter = resources.find(({ resource }) => resource.resourceType === 'Encounter');
    expect(encounter?.resource).toMatchObject({
      id: DM_ENCOUNTER,
      subject: { reference: `Patient/${DM_PATIENT}` },
      participant: [
        { individual: { reference: 'Practitioner/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02' } },
      ],
    });
    expect(JSON.stringify(resources)).not.toContain('urn:uuid');
    expect(resources.every(({ patientId }) => patientId === DM_PATIENT)).toBe(true);
  });

  it('returns the practitioners and organizations of a bundle as context resources', () => {
    const { contextResources } = map(loadBundle('consultation-diabetology'));
    expect(contextResources).toEqual([
      expect.objectContaining({
        resourceType: 'Practitioner',
        id: '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02',
      }),
    ]);
  });

  it('hypertension: PUT entries, HTML note, Medication by reference, ICD-10-CM and an uncoded order', () => {
    const result = map(loadBundle('consultation-hypertension'));
    const batch = onlyBatch(result);
    expect(batch).toMatchObject({ patientId: 'pat-hta-0002', encounterId: 'hta-enc-0112' });

    const [note] = eventsOf(batch, 'note.received');
    expect(note?.text).toBe(
      'Motivo: control de hipertensión arterial.\n' +
        'PA 152/96 mmHg en dos tomas. Sin cefalea ni dolor torácico. Adherencia irregular a losartán.\n' +
        'Impresión: HTA no controlada.\n' +
        'Plan: aumentar losartán a 100 mg/día por 30 días. Ecocardiograma. MAPA de 24 h. Control en 4 semanas.',
    );
    expect(note?.specialty).toBe('cardiology');
    expect(note?.idempotencyKey).toBe('DocumentReference/hta-note-0112/1#note.received');

    const [medication] = eventsOf(batch, 'medication.prescribed');
    expect(medication).toMatchObject({
      medication: {
        text: 'losartán 100 mg',
        code: { system: 'http://www.whocc.no/atc', code: 'C09CA01' },
      },
      durationDays: 30,
    });

    const orders = eventsOf(batch, 'service_request.created');
    expect(
      orders.map((order) => [order.orderId, order.category, order.code.system, order.code.code]),
    ).toEqual([
      ['hta-sr-echo', 'imaging', 'http://loinc.org', '34552-0'],
      [
        'hta-sr-abpm',
        'other',
        'https://hipocratesalud.com/fhir/CodeSystem/uncoded',
        'mapa-de-24-horas',
      ],
    ]);

    const [condition] = eventsOf(batch, 'condition.recorded');
    expect(condition?.code).toEqual({
      system: 'http://hl7.org/fhir/sid/icd-10',
      code: 'I10',
      display: 'Essential (primary) hypertension',
    });

    expect(result.issues?.issue).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'code-invalid',
        expression: ['Bundle.entry[5].resource.code'],
      }),
    ]);
  });

  it('psychology: Composition sections become the note; provisional diagnosis; next session booked', () => {
    const batch = onlyBatch(map(loadBundle('consultation-psychology')));
    expect(batch.patientId).toBe('pat-psy-0003');
    expect(types(batch)).toEqual([
      'encounter.finished',
      'note.received',
      'condition.recorded',
      'appointment.booked',
    ]);

    const [note] = eventsOf(batch, 'note.received');
    expect(note?.source.resourceType).toBe('Composition');
    expect(note?.text).toContain('Nota de sesión de psicoterapia\n\nSubjetivo\nRefiere ánimo bajo');
    expect(note?.text).toContain('Plan\n- Terapia cognitivo-conductual semanal, 8 sesiones.');
    expect(note?.text).toContain('Tareas\nRegistro diario de actividades & estado de ánimo.');
    expect(note?.text).not.toMatch(/<[a-z]/);
    expect(note?.specialty).toBe('psychology');

    expect(eventsOf(batch, 'condition.recorded')[0]?.verification).toBe('provisional');
    expect(eventsOf(batch, 'appointment.booked')[0]).toMatchObject({
      scheduledFor: new Date('2026-01-14T17:00:00Z'),
      practitionerId: 'psy-07',
      specialty: 'psychology',
      encounterId: '9a7b6c5d-1111-4c2d-8e3f-a1b2c3d4e502',
    });
  });

  it('gynecology: text-only medication with a dosing period, uncoded imaging order', () => {
    const result = map(loadBundle('consultation-gynecology'));
    const batch = onlyBatch(result);
    expect(batch).toMatchObject({ patientId: 'pat-gyn-0004', encounterId: 'gyn-enc-0109' });

    const [medication] = eventsOf(batch, 'medication.prescribed');
    expect(medication?.medication).toEqual({ text: 'ácido tranexámico 500 mg c/8h' });
    expect(medication).toMatchObject({
      startAt: new Date('2026-01-20T00:00:00Z'),
      durationDays: 5,
    });

    const orders = eventsOf(batch, 'service_request.created');
    expect(orders.map((order) => [order.category, order.code.code])).toEqual([
      ['imaging', 'ecografia-transvaginal'],
      ['laboratory', '10524-7'],
    ]);
    expect(eventsOf(batch, 'condition.recorded')[0]?.verification).toBe('confirmed');
    expect(issueSeverities(result)).toEqual(['warning']);
  });
});

describe('other host events', () => {
  it('results: interpretation from v3 codes, basedOn → order id, inherited from the parent report', () => {
    const batch = onlyBatch(map(loadBundle('result-hba1c')));
    expect(batch.encounterId).toBeUndefined();
    const results = eventsOf(batch, 'result.received');
    expect(
      results.map((result) => [
        `${result.source.resourceType}/${result.source.id}`,
        result.code.code,
        result.interpretation,
        result.basedOnOrderId,
      ]),
    ).toEqual([
      ['Observation/obs-hba1c-0115', '4548-4', 'abnormal', DM_HBA1C_ORDER],
      ['DiagnosticReport/dr-hba1c-0115', '4548-4', 'abnormal', DM_HBA1C_ORDER],
      ['Observation/obs-ldl-0115', '18262-6', 'normal', undefined],
    ]);
    expect(results[0]?.occurredAt).toEqual(new Date('2026-01-15T14:20:00Z'));
    expect(results[2]?.occurredAt).toEqual(new Date('2026-01-14T11:30:00Z'));
  });

  it('results: critical (HH, LL, AA, "panic") and mild abnormal flags set the severity (HIP-124)', () => {
    const observation = (id: string, interpretation: Record<string, unknown>) => ({
      resource: {
        resourceType: 'Observation',
        id,
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
        subject: { reference: 'Patient/p-1' },
        effectiveDateTime: '2026-01-05T10:00:00Z',
        interpretation: [interpretation],
      },
      request: { method: 'PUT', url: `Observation/${id}` },
    });
    const v3 = (code: string) => ({
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code },
      ],
    });
    const results = eventsOf(
      onlyBatch(
        map({
          resourceType: 'Bundle',
          type: 'batch',
          entry: [
            observation('k-hh', v3('HH')),
            observation('k-ll', v3('LL')),
            observation('k-aa', v3('AA')),
            observation('k-h', v3('H')),
            observation('k-n', v3('N')),
            observation('k-panic', { text: 'Valor de pánico' }),
          ],
        }),
      ),
      'result.received',
    );
    expect(
      results.map((result) => [result.source.id, result.interpretation, result.severity]),
    ).toEqual([
      ['k-hh', 'abnormal', 'critical'],
      ['k-ll', 'abnormal', 'critical'],
      ['k-aa', 'abnormal', 'critical'],
      ['k-h', 'abnormal', 'mild'],
      ['k-n', 'normal', undefined],
      ['k-panic', 'abnormal', 'critical'],
    ]);
  });

  it('results: Observation.valueQuantity becomes the value; a single-test report carries it too', () => {
    const results = eventsOf(onlyBatch(map(loadBundle('result-hba1c'))), 'result.received');
    expect(results.map((result) => result.value)).toEqual([
      { value: 8.1, unit: '%' },
      { value: 8.1, unit: '%' },
      { value: 96, unit: 'mg/dL' },
    ]);
  });

  it('appointments: booked then cancelled, keyed by version', () => {
    const [booked] = eventsOf(
      onlyBatch(map(loadBundle('appointment-booked'))),
      'appointment.booked',
    );
    expect(booked).toMatchObject({
      scheduledFor: new Date('2026-04-06T18:00:00Z'),
      occurredAt: new Date('2026-01-20T13:00:00Z'),
      practitionerId: 'doc-dm-01',
      specialty: 'diabetology',
      idempotencyKey: 'Appointment/appt-dm-0405/1#appointment.booked',
    });
    const [cancelled] = eventsOf(
      onlyBatch(map(loadBundle('appointment-cancelled'))),
      'appointment.cancelled',
    );
    expect(cancelled).toMatchObject({
      scheduledFor: new Date('2026-04-06T18:00:00Z'),
      occurredAt: new Date('2026-03-30T09:00:00Z'),
      idempotencyKey: 'Appointment/appt-dm-0405/2#appointment.cancelled',
    });
  });

  it('opt-out: Patient extension and Consent each give patient.opted_out for their patient', () => {
    const result = map(loadBundle('patient-opt-out'));
    expect(result.issues).toBeUndefined();
    expect(
      result.batches.map((batch) => [batch.patientId, ...batch.events.map((event) => event.type)]),
    ).toEqual([
      ['pat-hta-0002', 'patient.opted_out'],
      ['pat-gyn-0004', 'patient.opted_out'],
    ]);
    expect(result.batches[0]?.events[0]?.idempotencyKey).toBe(
      'Patient/pat-hta-0002/2026-02-01T12:00:00Z#patient.opted_out',
    );
  });

  it('a Patient whose opt-out extension is false gives no event and no batch', () => {
    const bundle = clone(loadBundle('patient-opt-out'));
    const entries = bundle['entry'] as { resource: Record<string, unknown> }[];
    const patient = entries[0]?.resource;
    if (patient === undefined) {
      throw new Error('fixture changed');
    }
    patient['extension'] = [
      {
        url: 'https://hipocratesalud.com/fhir/StructureDefinition/follow-up-opt-out',
        valueBoolean: false,
      },
    ];
    const result = map(bundle);
    expect(result.batches.map((batch) => batch.patientId)).toEqual(['pat-gyn-0004']);
    expect(result.resources.map(({ resource }) => resource.id)).toContain('pat-hta-0002');
  });
});

describe('allergies (HIP-139)', () => {
  const allergyBundle = (resources: readonly Record<string, unknown>[]) => ({
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource) => ({
      resource,
      request: { method: 'PUT', url: `AllergyIntolerance/${String(resource['id'])}` },
    })),
  });
  const verified = (code: string) => ({
    coding: [
      { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code },
    ],
  });
  const active = {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        code: 'active',
      },
    ],
  };

  it('AllergyIntolerance becomes allergy.recorded: a substance, or "no known allergy"', () => {
    const batch = onlyBatch(
      map(
        allergyBundle([
          {
            resourceType: 'AllergyIntolerance',
            id: 'al-nka',
            clinicalStatus: active,
            verificationStatus: verified('confirmed'),
            code: {
              coding: [
                {
                  system: 'http://snomed.info/sct',
                  code: '716186003',
                  display: 'No known allergy',
                },
              ],
              text: 'Sin alergias conocidas',
            },
            patient: { reference: 'Patient/p-1' },
            recordedDate: '2025-03-01T10:00:00Z',
          },
          {
            resourceType: 'AllergyIntolerance',
            id: 'al-pen',
            clinicalStatus: active,
            verificationStatus: verified('confirmed'),
            type: 'allergy',
            category: ['medication'],
            criticality: 'high',
            code: {
              coding: [
                { system: 'http://snomed.info/sct', code: '764146007', display: 'Penicillin' },
              ],
              text: 'Penicilina',
            },
            patient: { reference: 'Patient/p-1' },
            recordedDate: '2025-03-01T10:00:00Z',
            reaction: [{ manifestation: [{ text: 'Urticaria' }] }],
          },
        ]),
      ),
    );
    const allergies = eventsOf(batch, 'allergy.recorded');
    expect(
      allergies.map((event) => [event.code?.code, event.noKnownAllergy, event.criticality]),
    ).toEqual([
      ['716186003', true, undefined],
      ['764146007', false, 'high'],
    ]);
    expect(allergies[0]?.occurredAt).toEqual(new Date('2025-03-01T10:00:00Z'));
  });

  it('an allergy entered in error or refuted withdraws the earlier version', () => {
    const batch = onlyBatch(
      map(
        allergyBundle([
          {
            resourceType: 'AllergyIntolerance',
            id: 'al-err',
            verificationStatus: verified('entered-in-error'),
            code: { coding: [{ system: 'http://snomed.info/sct', code: '387406002' }] },
            patient: { reference: 'Patient/p-1' },
          },
        ]),
      ),
    );
    expect(types(batch)).toEqual(['record.withdrawn']);
  });
});

describe('batching', () => {
  it('splits one bundle into a batch per patient', () => {
    const a = buildConsultationBundle({
      consultationId: 'c-a',
      patient: { id: 'pat-a' },
      specialty: 'diabetology',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      noteText: 'Plan: control en 3 meses.',
    });
    const b = buildConsultationBundle({
      consultationId: 'c-b',
      patient: { id: 'pat-b' },
      specialty: 'psychology',
      occurredAt: new Date('2026-01-05T13:00:00Z'),
      noteText: 'Plan: próxima sesión en 1 semana.',
    });
    const merged = { ...a, entry: [...(a.entry ?? []), ...(b.entry ?? [])] };
    const result = map(merged);
    expect(
      result.batches.map((batch) => [batch.patientId, batch.encounterId, batch.events.length]),
    ).toEqual([
      ['pat-a', 'c-a-enc', 2],
      ['pat-b', 'c-b-enc', 2],
    ]);
  });

  it('with several encounters for one patient, groups resources by the encounter they reference', () => {
    const first = buildConsultationBundle({
      consultationId: 'v1',
      patient: { id: 'pat-x' },
      specialty: 'cardiology',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      noteText: 'Primera visita.',
      orders: [{ loinc: '2093-3', display: 'Colesterol total' }],
    });
    const second = buildConsultationBundle({
      consultationId: 'v2',
      patient: { id: 'pat-x' },
      specialty: 'cardiology',
      occurredAt: new Date('2026-02-05T12:00:00Z'),
      noteText: 'Segunda visita.',
    });
    const loose = {
      resource: {
        resourceType: 'Condition',
        id: 'loose-dx',
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' }] },
        subject: { reference: 'Patient/pat-x' },
      },
      request: { method: 'PUT', url: 'Condition/loose-dx' },
    };
    const bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [...(first.entry ?? []), ...(second.entry ?? []), loose],
    };
    const result = map(bundle);
    expect(
      result.batches.map((batch) => [batch.encounterId, batch.events.map((event) => event.type)]),
    ).toEqual([
      ['v1-enc', ['encounter.finished', 'note.received', 'service_request.created']],
      ['v2-enc', ['encounter.finished', 'note.received']],
      [undefined, ['condition.recorded']],
    ]);
  });

  it('is deterministic and idempotent: the same bundle maps to identical batches', () => {
    const bundle = loadBundle('consultation-diabetology');
    expect(map(clone(bundle))).toEqual(map(clone(bundle)));
  });

  it('changes idempotency keys when content changes and no version is given', () => {
    const before = onlyBatch(map(loadBundle('consultation-gynecology')));
    const changed = clone(loadBundle('consultation-gynecology'));
    const entries = changed['entry'] as { resource: Record<string, unknown> }[];
    const order = entries[4]?.resource;
    if (order === undefined) {
      throw new Error('fixture changed');
    }
    order['authoredOn'] = '2026-01-10';
    const after = onlyBatch(map(changed));
    const key = (batch: ClinicalBatch, id: string): string | undefined =>
      batch.events.find((event) => event.source.id === id)?.idempotencyKey;
    expect(key(after, 'gyn-sr-pap')).not.toBe(key(before, 'gyn-sr-pap'));
    expect(key(after, 'gyn-sr-us')).toBe(key(before, 'gyn-sr-us'));
  });
});

describe('builder round trip', () => {
  it('a consultation built with buildConsultationBundle maps back to its inputs', () => {
    const occurredAt = new Date('2026-01-05T12:00:00Z');
    const bundle = buildConsultationBundle({
      consultationId: 'demo-0001',
      patient: { id: 'pat-demo-1', name: 'Paciente Demo' },
      practitionerId: 'doc-1',
      specialty: 'diabetology',
      occurredAt,
      noteText: 'DM2. Plan: HbA1c y control en 3 meses.',
      orders: [
        { loinc: '4548-4', display: 'HbA1c' },
        { loinc: '24627-2', display: 'Radiografía de tórax', category: 'imaging' },
      ],
      prescriptions: [{ text: 'metformina 850 mg c/12h', durationDays: 90 }],
      diagnoses: [
        { icd10: 'E11.9', display: 'DM2' },
        { icd10: 'E78.5', verification: 'provisional' },
      ],
    });
    const result = map(bundle);
    expect(result.issues).toBeUndefined();
    const batch = onlyBatch(result);
    expect(batch).toMatchObject({ patientId: 'pat-demo-1', encounterId: 'demo-0001-enc' });
    expect(batch.events.map((event) => event.idempotencyKey.split('#')[1])).toEqual([
      'encounter.finished',
      'note.received',
      'service_request.created',
      'service_request.created',
      'medication.prescribed',
      'condition.recorded',
      'condition.recorded',
    ]);
    expect(eventsOf(batch, 'encounter.finished')[0]).toMatchObject({
      practitionerId: 'doc-1',
      specialty: 'diabetology',
      occurredAt,
    });
    expect(eventsOf(batch, 'note.received')[0]).toMatchObject({
      documentId: 'demo-0001-note',
      text: 'DM2. Plan: HbA1c y control en 3 meses.',
      specialty: 'diabetology',
      authoredAt: occurredAt,
    });
    expect(
      eventsOf(batch, 'service_request.created').map((order) => [order.code.code, order.category]),
    ).toEqual([
      ['4548-4', 'laboratory'],
      ['24627-2', 'imaging'],
    ]);
    expect(eventsOf(batch, 'medication.prescribed')[0]).toMatchObject({
      medication: { text: 'metformina 850 mg c/12h' },
      durationDays: 90,
    });
    expect(
      eventsOf(batch, 'condition.recorded').map((condition) => [
        condition.code.code,
        condition.verification,
      ]),
    ).toEqual([
      ['E11.9', 'confirmed'],
      ['E78.5', 'provisional'],
    ]);
  });
});
