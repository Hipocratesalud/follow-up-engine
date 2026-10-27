import { describe, expect, it } from 'vitest';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import { detectSignals, type Signal } from './detectors.ts';
import { buildDossier } from './dossier.ts';
import {
  booking,
  condition,
  encounter,
  medication,
  note,
  result,
  snapshot,
} from './test-support.ts';

function signals(events: readonly ClinicalEvent[], overrides = {}): Signal[] {
  return detectSignals(buildDossier(snapshot(events, overrides)));
}

function rules(events: readonly ClinicalEvent[], overrides = {}): string[] {
  return signals(events, overrides).map((signal) => signal.rule);
}

const ALLERGIES = 'Alergias: niega.';
const CREATININE = '2160-0';

describe('lab trends', () => {
  const rising = [
    result(-400, CREATININE, 1.05, 'mg/dL'),
    result(-300, CREATININE, 1.1, 'mg/dL'),
    result(-150, CREATININE, 1.4, 'mg/dL'),
    result(-40, CREATININE, 1.75, 'mg/dL'),
  ];

  it('finds a creatinine rising over 3+ results that no note mentions, with every result cited', () => {
    const found = signals([
      ...rising,
      note(-30, `Control. ${ALLERGIES} Plan: control en 3 meses.`),
    ]);
    const trend = found.find((signal) => signal.rule === 'lab_trend:creatinine');
    expect(trend).toMatchObject({
      category: 'lab_trend',
      severity: 'high',
      topic: { test: 'creatinine' },
    });
    expect(trend?.evidence.map((item) => item.quote)).toEqual([
      'Creatinine: 1.05 mg/dL',
      'Creatinine: 1.1 mg/dL',
      'Creatinine: 1.4 mg/dL',
      'Creatinine: 1.75 mg/dL',
    ]);
    expect(trend?.summary).toContain('1.05 → 1.1 → 1.4 → 1.75 mg/dL');
  });

  it('is silent once a note after the trend comments it', () => {
    const commented = note(
      -20,
      `Creatinina en ascenso, se solicita control de función renal. ${ALLERGIES}`,
    );
    expect(rules([...rising, commented])).not.toContain('lab_trend:creatinine');
  });

  it('a word that merely contains a mention term does not count as a comment ("ejercicio")', () => {
    const unrelated = note(-20, `Hace ejercicio a diario. ${ALLERGIES} Plan: control.`);
    expect(rules([...rising, unrelated])).toContain('lab_trend:creatinine');
  });

  it('converts units (µmol/L to mg/dL) and needs a real change', () => {
    const stable = [
      result(-300, CREATININE, 88, 'umol/L'),
      result(-200, CREATININE, 89, 'umol/L'),
      result(-100, CREATININE, 90, 'umol/L'),
    ];
    expect(rules(stable)).not.toContain('lab_trend:creatinine');
    const dossier = buildDossier(snapshot(stable));
    expect(
      dossier.trends.find((trend) => trend.test === 'creatinine')?.points[0]?.value,
    ).toBeCloseTo(0.995, 2);
  });

  it('flags a falling eGFR (worse when it goes down)', () => {
    const falling = [
      result(-300, '62238-1', 72, 'mL/min/1.73m2'),
      result(-200, '62238-1', 61, 'mL/min/1.73m2'),
      result(-100, '62238-1', 48, 'mL/min/1.73m2'),
    ];
    expect(rules(falling)).toContain('lab_trend:egfr');
  });
});

describe('abnormal result without follow-up', () => {
  it('finds a markedly high HbA1c with no visit, booking or comment after it', () => {
    const events = [
      result(-300, '4548-4', 7.6, '%'),
      result(-200, '4548-4', 7.2, '%'),
      encounter(-190),
      result(-60, '4548-4', 9.2, '%'),
    ];
    const found = signals(events).find((signal) => signal.rule === 'abnormal_result:hba1c');
    expect(found).toMatchObject({ category: 'abnormal_result_no_followup', severity: 'high' });
    expect(found?.evidence).toEqual([{ handle: 'R3', quote: 'HbA1c: 9.2 %' }]);
  });

  it('is not raised when a visit, a booking soon or a comment came after', () => {
    const base = [result(-60, '4548-4', 9.2, '%')];
    expect(rules([...base, encounter(-30)])).not.toContain('abnormal_result:hba1c');
    expect(rules([...base, booking(-5, 10)])).not.toContain('abnormal_result:hba1c');
    expect(rules([...base, note(-10, 'HbA1c 9.2 %, se intensifica tratamiento.')])).not.toContain(
      'abnormal_result:hba1c',
    );
  });

  it('waits two weeks before calling a result unattended', () => {
    expect(rules([result(-5, '4548-4', 9.6, '%')])).not.toContain('abnormal_result:hba1c');
  });

  it('reads HbA1c sent in mmol/mol (IFCC) in %', () => {
    // 77 mmol/mol is about 9.2 %.
    expect(rules([result(-60, '59261-8', 77, 'mmol/mol')])).toContain('abnormal_result:hba1c');
  });
});

describe('vital trends', () => {
  const bp = (offset: number, systolic: number) => result(offset, '8480-6', systolic, 'mmHg');

  it('finds a systolic pressure creeping up over visits', () => {
    expect(rules([bp(-400, 128), bp(-270, 134), bp(-150, 141), bp(-30, 149)])).toContain(
      'vital_trend:systolic_bp',
    );
    expect(rules([bp(-400, 128), bp(-270, 131), bp(-150, 129), bp(-30, 130)])).not.toContain(
      'vital_trend:systolic_bp',
    );
  });

  it('reads systolic values out of blood pressure panels', () => {
    const panels = [-400, -270, -150, -30].map((offset, index) => {
      // A panel carries no value of its own: its systolic and diastolic are components.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping the value is the point
      const { value, ...panel } = result(offset, '85354-9', 0, 'mmHg', {
        id: `bp-${String(index)}`,
      });
      return panel;
    });
    const values = [128, 134, 141, 149];
    const components = new Map(
      panels.map((panel, index) => [
        `Observation/${panel.source.id}`,
        [
          { code: '8480-6', value: values[index] ?? 0, unit: 'mmHg' },
          { code: '8462-4', value: 80, unit: 'mmHg' },
        ],
      ]),
    );
    expect(rules(panels, { components })).toContain('vital_trend:systolic_bp');
  });

  it('finds a steady weight loss of 5 % or more', () => {
    const weights = [82, 79, 76, 72].map((value, index) =>
      result(-360 + index * 110, '29463-7', value, 'kg'),
    );
    expect(signals(weights).find((signal) => signal.rule === 'vital_trend:weight')?.severity).toBe(
      'medium',
    );
  });
});

describe('medication safety', () => {
  const losartan = medication(-300, 'Losartán 50 mg', { atc: 'C09CA01' });
  const thiazide = medication(-300, 'Hidroclorotiazida 25 mg', { atc: 'C03AA03' });
  const ibuprofen = medication(-100, 'Ibuprofeno 400 mg', { atc: 'M01AE01' });

  it('flags NSAID + ARB + diuretic once, not again as its NSAID + ARB pair', () => {
    const found = signals([losartan, thiazide, ibuprofen]).filter(
      (signal) => signal.category === 'drug_interaction',
    );
    expect(found.map((signal) => signal.rule)).toEqual(['interaction:nsaid_raas_diuretic']);
    expect(found[0]?.evidence).toHaveLength(3);
    expect(found[0]?.severity).toBe('high');
  });

  it('classifies drugs written as free text through the ATC name table', () => {
    const found = rules([
      medication(-200, 'Sertralina 50 mg'),
      medication(-20, 'Tramadol 50 mg c/8h'),
    ]);
    expect(found).toContain('interaction:ssri_tramadol');
  });

  it('ignores a short course that already ended', () => {
    const finished = medication(-100, 'Ibuprofeno 400 mg', { atc: 'M01AE01', durationDays: 5 });
    expect(
      rules([losartan, thiazide, finished]).some((rule) => rule.startsWith('interaction:')),
    ).toBe(false);
  });

  it('metformin with an eGFR estimated from creatinine (CKD-EPI 2021) under 45', () => {
    const found = signals([
      medication(-500, 'Metformina 850 mg', { atc: 'A10BA02' }),
      result(-40, CREATININE, 1.75, 'mg/dL'),
    ]).find((signal) => signal.category === 'drug_condition_conflict');
    expect(found?.rule).toBe('drug_condition:metformin_egfr_45');
    expect(found?.summary).toContain('CKD-EPI 2021');
    expect(found?.evidence.map((item) => item.handle)).toEqual(['M1', 'R1']);
  });

  it('a measured eGFR under 30 makes metformin a contraindication', () => {
    const found = rules([
      medication(-500, 'Metformina 850 mg', { atc: 'A10BA02' }),
      result(-40, '62238-1', 27, 'mL/min/1.73m2'),
    ]);
    expect(found).toContain('drug_condition:metformin_egfr_30');
  });

  it('an NSAID with heart failure, cited by the coded diagnosis', () => {
    const found = signals([
      condition(-400, 'I50.9', 'Insuficiencia cardíaca'),
      medication(-30, 'Diclofenaco 50 mg', { atc: 'M01AB05' }),
    ]).find((signal) => signal.rule === 'drug_condition:nsaid_heart_failure');
    expect(found?.evidence.map((item) => item.quote)).toContain('I50.9 Insuficiencia cardíaca');
  });
});

describe('symptoms across notes', () => {
  it('finds a symptom affirmed in three notes with no workup, quoting each sentence verbatim', () => {
    const found = signals([
      note(-300, 'Consulta por cefalea frontal vespertina. Plan: paracetamol si dolor.', {
        specialty: 'internal_medicine',
      }),
      note(-190, 'Persiste cefalea, ahora casi diaria. Plan: control.', {
        specialty: 'internal_medicine',
      }),
      note(-75, 'Acude nuevamente por cefalea nocturna. Plan: control en 2 meses.', {
        specialty: 'internal_medicine',
      }),
    ]).find((signal) => signal.rule === 'symptom:headache');
    expect(found?.evidence.map((item) => item.quote)).toEqual([
      'Consulta por cefalea frontal vespertina',
      'Persiste cefalea, ahora casi diaria',
      'Acude nuevamente por cefalea nocturna',
    ]);
  });

  it('ignores denied mentions ("niega", "sin") and symptoms already worked up', () => {
    const denied = [
      note(-300, 'Consulta por cefalea tensional.'),
      note(-190, 'Niega cefalea desde la última consulta.'),
      note(-75, 'Pies: sensibilidad conservada, sin cefalea ni mareos.'),
    ];
    expect(rules(denied)).not.toContain('symptom:headache');
    const studied = [
      note(-300, 'Consulta por cefalea.'),
      note(-190, 'Persiste cefalea.'),
      note(-75, 'Persiste cefalea, se solicita TAC de cráneo.'),
    ];
    expect(rules(studied)).not.toContain('symptom:headache');
  });

  it('two notes from different specialties are enough', () => {
    const found = rules([
      note(-200, 'Refiere mareos al levantarse.', { specialty: 'internal_medicine' }),
      note(-50, 'Comenta mareos frecuentes.', { specialty: 'gynecology' }),
    ]);
    expect(found).toContain('symptom:dizziness');
  });
});

describe('check-ups, record quality, utilization and questions', () => {
  const diabetes = condition(-500, 'E11.9', 'Diabetes mellitus tipo 2');
  const metformin = medication(-500, 'Metformina 850 mg', { atc: 'A10BA02' });

  it('a diabetic without fundus exam, foot exam or albuminuria in a year', () => {
    const found = rules([diabetes, metformin, note(-60, `DM2 estable. ${ALLERGIES}`)]);
    expect(found).toEqual(
      expect.arrayContaining([
        'screening:diabetic_fundus',
        'screening:diabetic_foot',
        'screening:diabetic_albuminuria',
      ]),
    );
  });

  it('check-ups documented in notes or results count', () => {
    const found = rules([
      diabetes,
      metformin,
      note(-60, `Fondo de ojo sin retinopatía. Pies: pulsos pedios presentes. ${ALLERGIES}`),
      result(-70, '9318-7', 12, 'mg/g'),
    ]);
    expect(found.filter((rule) => rule.startsWith('screening:'))).toEqual([]);
  });

  it('allergies never recorded while prescribing (a prescription in the last 90 days)', () => {
    const recent = medication(-30, 'Metformina 850 mg', { atc: 'A10BA02' });
    expect(rules([recent, note(-60, 'DM2 estable.')])).toContain('record_quality:allergies');
    expect(rules([recent, note(-60, 'DM2 estable. Sin alergias conocidas.')])).not.toContain(
      'record_quality:allergies',
    );
    // An old chronic prescription alone does not raise it again and again.
    expect(rules([metformin, note(-60, 'DM2 estable.')])).not.toContain('record_quality:allergies');
  });

  it('writes in the review locale; quotes from notes stay as written', () => {
    const events = [
      result(-300, '2160-0', 1.1, 'mg/dL'),
      result(-200, '2160-0', 1.4, 'mg/dL'),
      result(-100, '2160-0', 1.75, 'mg/dL'),
      note(-50, 'Control. Alergias: niega.'),
    ];
    const english = detectSignals(buildDossier(snapshot(events), 'en'))[0];
    const spanish = detectSignals(buildDossier(snapshot(events), 'es'))[0];
    expect(english?.summary).toMatch(/^Creatinine rising over the last 3 results/);
    expect(english?.evidence[0]?.quote).toBe('Creatinine: 1.1 mg/dL');
    expect(spanish?.summary).toMatch(/^Creatinina en ascenso en los últimos 3 resultados/);
    expect(spanish?.evidence[0]?.quote).toBe('Creatinina: 1.1 mg/dL');
  });

  it("visits far more frequent than the patient's own pattern", () => {
    const visits = [-80, -60, -40, -20, -5].flatMap((offset) => [
      encounter(offset, 'internal_medicine'),
      note(offset, `Consulta por dolor abdominal recurrente. ${ALLERGIES}`),
    ]);
    expect(rules([encounter(-400, 'internal_medicine'), ...visits])).toContain(
      'utilization:frequent_visits',
    );
  });

  it('questions for the next visit need a visit booked within 60 days', () => {
    const record = [diabetes, metformin, note(-60, `DM2 estable. ${ALLERGIES}`)];
    expect(rules(record)).not.toContain('question:diabetic_neuropathy');
    expect(rules([...record, booking(-3, 20)])).toContain('question:diabetic_neuropathy');
    expect(rules([...record, booking(-3, 90)])).not.toContain('question:diabetic_neuropathy');
    const asked = [...record, booking(-3, 20), note(-30, 'Niega parestesias en pies.')];
    expect(rules(asked)).not.toContain('question:diabetic_neuropathy');
  });

  it('produces only the enabled categories, with stable ids', () => {
    const dossier = buildDossier(snapshot([metformin, note(-60, 'DM2 estable.')]));
    const all = detectSignals(dossier);
    expect(all.map((signal) => signal.id)).toEqual(all.map((_, index) => `S${String(index + 1)}`));
    expect(
      detectSignals(dossier, (category) => category === 'record_quality').every(
        (signal) => signal.category === 'record_quality',
      ),
    ).toBe(true);
  });
});
