import { describe, expect, it } from 'vitest';
import type {
  ClinicalEvent,
  ConditionRecordedEvent,
  EncounterFinishedEvent,
  MedicationPrescribedEvent,
  NoteReceivedEvent,
  ResultReceivedEvent,
} from '../../domain/clinical-event.ts';
import { clinicId, patientId } from '../../domain/ids.ts';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import { conditionCandidates } from '../annotator/conditions.ts';
import type { Protocol } from '../../config/protocol.ts';
import { ProtocolSchema } from '../../config/protocol.ts';
import { LOINC_SYSTEM } from '../terminology/loinc.ts';
import {
  currentDating,
  dateAtGestationalWeek,
  datingOf,
  gestationalAgeAt,
} from './gestational-age.ts';
import { albuminuriaCategory, ckdStage, gfrCategory, gfrCategoryOfCode } from './kidney.ts';
import { doseSignature, treatmentChanges } from './treatment-changes.ts';

const base = { clinicId: clinicId('clinic-unit'), patientId: patientId('pat-unit') };
const day = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);
let sequence = 0;

function result(
  code: string,
  at: string,
  value: Pick<ResultReceivedEvent, 'value' | 'valueDate'>,
): ResultReceivedEvent {
  sequence += 1;
  return {
    ...base,
    type: 'result.received',
    source: { resourceType: 'Observation', id: `obs-${String(sequence)}` },
    occurredAt: day(at),
    idempotencyKey: `Observation/obs-${String(sequence)}/1#result.received`,
    code: { system: LOINC_SYSTEM, code },
    interpretation: 'unknown',
    ...value,
  };
}

function diagnosis(code: string, at: string): ConditionRecordedEvent {
  sequence += 1;
  return {
    ...base,
    type: 'condition.recorded',
    source: { resourceType: 'Condition', id: `cond-${String(sequence)}` },
    occurredAt: day(at),
    idempotencyKey: `Condition/cond-${String(sequence)}/1#condition.recorded`,
    code: { system: ICD10_SYSTEM, code },
    verification: 'confirmed',
  };
}

function prescription(
  text: string,
  at: string,
  dosageText?: string,
  encounterId?: string,
): MedicationPrescribedEvent {
  sequence += 1;
  return {
    ...base,
    type: 'medication.prescribed',
    source: { resourceType: 'MedicationRequest', id: `med-${String(sequence)}` },
    occurredAt: day(at),
    idempotencyKey: `MedicationRequest/med-${String(sequence)}/1#medication.prescribed`,
    medication: { text },
    startAt: day(at),
    ...(dosageText === undefined ? {} : { dosageText }),
    ...(encounterId === undefined ? {} : { encounterId }),
  };
}

function consultation(
  id: string,
  at: string,
  noteText: string,
): [EncounterFinishedEvent, NoteReceivedEvent] {
  return [
    {
      ...base,
      type: 'encounter.finished',
      source: { resourceType: 'Encounter', id },
      encounterId: id,
      occurredAt: day(at),
      idempotencyKey: `Encounter/${id}/1#encounter.finished`,
      specialty: 'internal_medicine',
    },
    {
      ...base,
      type: 'note.received',
      source: { resourceType: 'DocumentReference', id: `${id}-note` },
      encounterId: id,
      occurredAt: day(at),
      idempotencyKey: `DocumentReference/${id}-note/1#note.received`,
      documentId: `${id}-note`,
      text: noteText,
      authoredAt: day(at),
    },
  ];
}

describe('gestational age', () => {
  it('dates a pregnancy from the last menstrual period (Naegele: delivery 280 days later)', () => {
    const lmp = result('8665-2', '2026-03-10', { valueDate: day('2026-01-01') });
    const dating = datingOf(lmp);
    expect(dating?.basis).toBe('last_menstrual_period');
    expect(dating?.estimatedDeliveryDate.toISOString().slice(0, 10)).toBe('2026-10-08');
    const age = gestationalAgeAt(
      dating ?? { estimatedDeliveryDate: new Date() },
      day('2026-03-10'),
    );
    expect(age).toEqual({ weeks: 9, days: 5, totalDays: 68 });
  });

  it('dates a pregnancy from an estimated delivery date', () => {
    const edd = result('11778-8', '2026-05-01', { valueDate: day('2026-09-25') });
    const dating = datingOf(edd);
    expect(dating?.basis).toBe('estimated_delivery_date');
    expect(
      gestationalAgeAt(dating ?? { estimatedDeliveryDate: new Date() }, day('2026-05-01')).weeks,
    ).toBe(19);
    expect(
      dateAtGestationalWeek(dating ?? { estimatedDeliveryDate: new Date() }, 24)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-06-05');
  });

  it('dates a pregnancy from the weeks a note states ("embarazo de 20 semanas y 3 días")', () => {
    const fromNote = result('11884-4', '2026-04-15', {
      value: { value: 20 + 3 / 7, unit: 'wk' },
    });
    const dating = datingOf(fromNote);
    expect(dating?.basis).toBe('gestational_age');
    expect(
      gestationalAgeAt(dating ?? { estimatedDeliveryDate: new Date() }, day('2026-04-15')),
    ).toMatchObject({
      weeks: 20,
      days: 3,
    });
    // In days, and in Spanish units.
    expect(
      datingOf(result('11884-4', '2026-04-15', { value: { value: 143, unit: 'd' } }))
        ?.estimatedDeliveryDate,
    ).toEqual(dating?.estimatedDeliveryDate);
    expect(
      datingOf(result('49051-6', '2026-04-15', { value: { value: 20, unit: 'semanas' } })),
    ).toBeDefined();
  });

  it('dates a pregnancy from an ICD-10-CM weeks-of-gestation code (Z3A.32)', () => {
    const dating = datingOf(diagnosis('Z3A.32', '2026-06-01'));
    expect(
      gestationalAgeAt(dating ?? { estimatedDeliveryDate: new Date() }, day('2026-06-01')).weeks,
    ).toBe(32);
    expect(datingOf(diagnosis('Z3A.01', '2026-06-01'))).toBeUndefined();
  });

  it('ignores implausible dating (a typo, a delivery date years away)', () => {
    expect(
      datingOf(result('11884-4', '2026-04-15', { value: { value: 60, unit: 'wk' } })),
    ).toBeUndefined();
    expect(
      datingOf(result('11778-8', '2026-04-15', { valueDate: day('2028-01-01') })),
    ).toBeUndefined();
    expect(
      datingOf(result('8665-2', '2026-04-15', { valueDate: day('2026-05-01') })),
    ).toBeUndefined();
  });

  it('uses the latest estimate of the current pregnancy only', () => {
    const previous = result('11778-8', '2025-01-10', { valueDate: day('2025-06-01') });
    const lmp = result('8665-2', '2026-02-01', { valueDate: day('2026-01-01') });
    // An ultrasound two weeks later corrects the dates.
    const ultrasound = result('11778-8', '2026-02-15', { valueDate: day('2026-10-15') });
    const events: ClinicalEvent[] = [previous, lmp, ultrasound];
    expect(currentDating(events)?.source).toEqual(ultrasound.source);
    expect(currentDating([previous, lmp], day('2025-07-01'))?.source).toEqual(lmp.source);
    expect(currentDating([previous], day('2025-07-01'))).toBeUndefined();
  });
});

describe('KDIGO staging', () => {
  it('maps eGFR and albuminuria to their categories at the boundaries', () => {
    expect([90, 89, 60, 59, 45, 44, 30, 29, 15, 14].map(gfrCategory)).toEqual([
      'G1',
      'G2',
      'G2',
      'G3a',
      'G3a',
      'G3b',
      'G3b',
      'G4',
      'G4',
      'G5',
    ]);
    expect([29, 30, 300, 301].map(albuminuriaCategory)).toEqual(['A1', 'A2', 'A2', 'A3']);
  });

  it('stages from the latest eGFR and urine albumin/creatinine ratio, in any unit', () => {
    const events = [
      result('62238-1', '2025-01-10', { value: { value: 52, unit: 'mL/min/1.73m2' } }),
      result('98979-8', '2025-07-10', { value: { value: 41, unit: 'mL/min/{1.73_m2}' } }),
      result('9318-7', '2025-07-10', { value: { value: 4.2, unit: 'mg/mmol' } }),
    ];
    expect(ckdStage(events, [])).toEqual({ gfr: 'G3b', albuminuria: 'A2' });
  });

  it('falls back to the stage a coded N18 diagnosis states', () => {
    expect(gfrCategoryOfCode('N18.4')).toBe('G4');
    expect(gfrCategoryOfCode('N18.32')).toBe('G3b');
    expect(gfrCategoryOfCode('E11')).toBeUndefined();
    const condition = {
      ...base,
      code: { system: ICD10_SYSTEM, code: 'N18.4' },
      status: 'confirmed' as const,
      confidence: 1,
      sourceType: 'recorded' as const,
      source: { resourceType: 'Condition', id: 'c1' },
      updatedAt: day('2025-01-01'),
    };
    expect(ckdStage([], [condition])).toEqual({ gfr: 'G4' });
  });
});

describe('treatment changes', () => {
  const antidepressants = { atc: ['N06A'] };

  it('reads the dose of a prescription from its text and dosage', () => {
    expect(doseSignature(prescription('Sertralina 50 mg', '2026-01-01', '1 tab VO OD'))).toBe(
      '50mg 1tab',
    );
    expect(doseSignature(prescription('Levotiroxina 0,075 mg', '2026-01-01'))).toBe('0.075mg');
  });

  it('finds the start, ignores a renewal at the same dose, and finds a dose change', () => {
    const changes = treatmentChanges(
      [
        ...consultation('enc-0', '2025-12-01', 'Primera consulta.'),
        prescription('Sertralina 50 mg', '2026-01-05', '1 tab VO OD'),
        prescription('Sertralina 50 mg', '2026-02-05', '1 tab VO OD'),
        prescription('Sertralina 100 mg', '2026-03-05', '1 tab VO OD'),
        prescription('Losartán 50 mg', '2026-03-05'),
      ],
      antidepressants,
    );
    expect(
      changes.map((change) => [change.kind, change.event.occurredAt.toISOString().slice(0, 10)]),
    ).toEqual([
      ['started', '2026-01-05'],
      ['dose_changed', '2026-03-05'],
    ]);
  });

  it('counts a switch to another antidepressant as a start', () => {
    const changes = treatmentChanges(
      [
        ...consultation('enc-0', '2025-12-01', 'Primera consulta.'),
        prescription('Sertralina 50 mg', '2026-01-05'),
        prescription('Escitalopram 10 mg', '2026-02-05'),
      ],
      antidepressants,
    );
    expect(changes.map((change) => change.kind)).toEqual(['started', 'started']);
  });
});

describe('treatment starts in a record seen for the first time (HIP-139)', () => {
  const statins = { atc: ['C10'] };
  const atorvastatin = (at: string, encounterId?: string) =>
    prescription('Atorvastatina 20 mg', at, '1 tab VO HS', encounterId);
  const kinds = (changes: ReturnType<typeof treatmentChanges>) =>
    changes.map((change) => [change.kind, change.event.occurredAt.toISOString().slice(0, 10)]);

  it('a drug prescribed at the first consultation the record has is already in course, not a start', () => {
    const events = [
      ...consultation('enc-1', '2024-03-14', 'DM2 y dislipidemia. Plan: continuar tratamiento.'),
      atorvastatin('2024-03-14', 'enc-1'),
      ...consultation('enc-2', '2024-06-12', 'Control. En tto con atorvastatina 20 mg.'),
      atorvastatin('2024-06-12', 'enc-2'),
    ];
    expect(treatmentChanges(events, statins)).toEqual([]);
  });

  it('the note of the first consultation says it starts ("se inicia"): a start', () => {
    for (const text of [
      'Plan: dieta. Se inicia atorvastatina 20 mg, 1 tab VO HS.',
      'Se indica atorvastatina 20 mg VO HS.',
      'Started atorvastatin. Lipid panel in 8 weeks.',
    ]) {
      const events = [
        ...consultation('enc-1', '2024-10-07', text),
        atorvastatin('2024-10-07', 'enc-1'),
      ];
      expect(kinds(treatmentChanges(events, statins)), text).toEqual([['started', '2024-10-07']]);
    }
  });

  it('a start phrase about another drug, or a continuation, does not make it a start', () => {
    const events = [
      ...consultation(
        'enc-1',
        '2024-03-14',
        'Continuar atorvastatina 20 mg. Se inicia metformina 850 mg c/12h.',
      ),
      atorvastatin('2024-03-14', 'enc-1'),
    ];
    expect(treatmentChanges(events, statins)).toEqual([]);
  });

  it('a drug first prescribed after earlier consultations is a start, unless the note says it is in course', () => {
    const earlier = consultation('enc-0', '2024-01-10', 'Primera consulta. HTA.');
    expect(
      kinds(
        treatmentChanges(
          [
            ...earlier,
            ...consultation('enc-1', '2024-04-02', 'Control.'),
            atorvastatin('2024-04-02', 'enc-1'),
          ],
          statins,
        ),
      ),
    ).toEqual([['started', '2024-04-02']]);
    expect(
      treatmentChanges(
        [
          ...earlier,
          ...consultation('enc-1', '2024-04-02', 'Toma losartan 50 mg y atorvastatina 20 mg.'),
          atorvastatin('2024-04-02', 'enc-1'),
        ],
        statins,
      ),
    ).toEqual([]);
  });

  it('a dose change of a drug already in course is still a change', () => {
    const events = [
      ...consultation('enc-1', '2024-02-19', 'En tto con levotiroxina 50 mcg. Continuar.'),
      prescription('Levotiroxina 50 mcg', '2024-02-19', '1 tab VO en ayunas', 'enc-1'),
      ...consultation('enc-2', '2025-09-12', 'Se ajusta levotiroxina a 75 mcg/día.'),
      prescription('Levotiroxina 75 mcg', '2025-09-12', '1 tab VO en ayunas', 'enc-2'),
    ];
    expect(kinds(treatmentChanges(events, { atc: ['H03AA'] }))).toEqual([
      ['dose_changed', '2025-09-12'],
    ]);
  });

  it('after `since` (an episode closed by a discharge), the first prescription starts again', () => {
    const events = [
      ...consultation('enc-1', '2024-01-10', 'Se inicia sertralina 50 mg.'),
      prescription('Sertralina 50 mg', '2024-01-10', '1 tab VO OD', 'enc-1'),
      ...consultation('enc-2', '2024-09-10', 'Recaida. Sertralina 50 mg.'),
      prescription('Sertralina 50 mg', '2024-09-10', '1 tab VO OD', 'enc-2'),
    ];
    expect(kinds(treatmentChanges(events, { atc: ['N06A'] }, day('2024-06-01')))).toEqual([
      ['started', '2024-09-10'],
    ]);
  });
});

describe('enrollment by repeated results (kidney disease)', () => {
  const ckd = ProtocolSchema.parse({
    id: 'ckd',
    version: '0.1.0',
    status: 'draft',
    description: 'test',
    reason: { code: 'ckd', label: 'ERC' },
    sources: [{ title: 'KDIGO', organization: 'KDIGO', year: 2013, url: 'https://kdigo.org' }],
    enrollment: {
      conditionCodes: ['N18'],
      minimumStatus: 'probable',
      results: [
        {
          code: { system: LOINC_SYSTEM, code: '62238-1' },
          lt: 60,
          conditionCode: 'N18.9',
          confirm: { count: 2, minDaysApart: 90 },
        },
      ],
    },
    items: [
      {
        key: 'visit',
        kind: 'follow_up_visit',
        reason: { code: 'v', label: 'Control' },
        everyDays: 180,
        fulfilledBy: [{ event: 'encounter.finished', match: 'any' }],
        priority: 10,
        suggestedAction: { code: 's', label: 'Agendar' },
      },
    ],
    escalationPolicy: { steps: [{ afterDays: 0, action: 'notify_clinic' }] },
  }) satisfies Protocol;
  const egfr = (at: string, value: number) =>
    result('33914-3', at, { value: { value, unit: 'mL/min/1.73m2' } });
  const candidates = (events: readonly ClinicalEvent[], history: readonly ClinicalEvent[]) =>
    conditionCandidates({
      events,
      protocols: [ckd],
      existing: [],
      extractedConfidence: new Map(),
      extractedMedications: [],
      history,
    });

  it('enrolls on the second eGFR below 60 at least 90 days after the first', () => {
    const first = egfr('2025-01-10', 55);
    const second = egfr('2025-04-15', 52);
    const [candidate] = candidates([second], [first, second]);
    expect(candidate).toMatchObject({
      code: { code: 'N18.9' },
      status: 'probable',
      sourceType: 'inferred_from_result',
      source: second.source,
    });
  });

  it('does not enroll on one low eGFR, nor on two less than 90 days apart', () => {
    const first = egfr('2025-01-10', 55);
    expect(candidates([first], [first])).toEqual([]);
    const soon = egfr('2025-03-01', 50);
    expect(candidates([soon], [first, soon])).toEqual([]);
    const normal = egfr('2025-06-01', 75);
    expect(candidates([normal], [first, normal])).toEqual([]);
  });
});
