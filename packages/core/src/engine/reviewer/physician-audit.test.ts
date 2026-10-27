import { describe, expect, it } from 'vitest';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ProposedFinding, ReviewAgentResult } from '../../ports/clinical-review-agent.ts';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import { detectSignals, type Signal } from './detectors.ts';
import { buildDossier, type PatientRecordSnapshot } from './dossier.ts';
import { reviewRecord } from './pipeline.ts';
import {
  anExpectation,
  CLINIC,
  condition,
  day,
  encounter,
  medication,
  note,
  PATIENT,
  result,
  snapshot,
} from './test-support.ts';

/*
 * The physicians' audit of the clinical reviewer on the demo clinic
 * (clinical-fix-4): screenings lost when findings merged, abbreviations the
 * "commented in the notes" check did not read, severities off in both
 * directions, coverage that hid an unreviewed abnormal result, and a
 * probable inferred diagnosis cited instead of the doctor's coded one.
 */

const ALL = (): boolean => true;

function signals(events: readonly ClinicalEvent[], overrides = {}): Signal[] {
  return detectSignals(buildDossier(snapshot(events, overrides)));
}

function rules(events: readonly ClinicalEvent[], overrides = {}): string[] {
  return signals(events, overrides).map((signal) => signal.rule);
}

function signalOf(
  events: readonly ClinicalEvent[],
  rule: string,
  overrides = {},
): Signal | undefined {
  return signals(events, overrides).find((signal) => signal.rule === rule);
}

/** An agent that submits fixed proposals. */
function agentSubmitting(proposals: readonly ProposedFinding[]) {
  return {
    review(): Promise<ReviewAgentResult> {
      return Promise.resolve({
        proposals,
        stopReason: 'submitted',
        steps: 1,
        toolCalls: 0,
        trace: [],
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        modelId: 'test:model',
        promptVersion: 'test@1',
      });
    },
  };
}

const diabetes = condition(-700, 'E11.9', 'Diabetes mellitus tipo 2');
const metformin = medication(-700, 'Metformina 850 mg', { atc: 'A10BA02' });
const DROPOUT = [
  diabetes,
  metformin,
  encounter(-400),
  note(-400, 'DM2 en tto con metformina. Alergias: niega. Plan: control en 3 meses.', {
    specialty: 'diabetology',
  }),
];

function fundusItem(dueIn: number, overrides: Partial<Expectation> = {}): Expectation {
  return anExpectation({
    id: 'exp-fundus' as Expectation['id'],
    idempotencyKey: 'key-fundus',
    ruleId: 'protocol_diabetes_fundus',
    layer: 'protocol',
    matchKey: 'procedure:fundus-exam',
    source: { resourceType: 'Condition', id: 'cond-1' },
    dueAt: day(dueIn),
    reason: { code: 'protocol_diabetes_fundus', label: 'Fundus exam due' },
    ...overrides,
  });
}

describe('screenings are never merged away (pat-0015..0020)', () => {
  it('fundus, foot and albuminuria gaps citing the same diagnosis stay three findings', async () => {
    const outcome = await reviewRecord(CLINIC, snapshot(DROPOUT), {
      enabled: ALL,
      patientRef: 'P-1',
    });
    const screenings = outcome.findings.filter(
      (finding) => finding.category === 'missing_screening',
    );
    expect(screenings).toHaveLength(3);
    expect(outcome.discarded.merged).toBeUndefined();
    expect(new Set(screenings.map((finding) => finding.dedupKey)).size).toBe(3);
  });

  it('coverage is per screening: the fundus item covers the fundus finding only', async () => {
    const outcome = await reviewRecord(
      CLINIC,
      snapshot(DROPOUT, { liveExpectations: [fundusItem(20)] }),
      { enabled: ALL, patientRef: 'P-1' },
    );
    const covered = Object.fromEntries(
      outcome.findings
        .filter((finding) => finding.category === 'missing_screening')
        .map((finding) => [finding.summary, finding.alreadyCovered]),
    );
    expect(covered).toEqual({
      'Patient with diabetes with no fundus exam recorded in the last year': true,
      'Patient with diabetes with no foot exam recorded in the last year': false,
      'Patient with diabetes with no albuminuria test recorded in the last year': false,
    });
  });

  it('a finding the agent merged over several screenings is covered only when each one is', async () => {
    const dossier = buildDossier(snapshot(DROPOUT));
    const found = detectSignals(dossier).filter(
      (signal) => signal.category === 'missing_screening',
    );
    const merged: ProposedFinding = {
      category: 'missing_screening',
      severity: 'medium',
      summary: 'No fundus exam nor foot exam in the last year',
      rationale: 'Neither is recorded.',
      suggestion: 'Consider both at the next visit.',
      citations: [
        { docId: found[0]?.evidence[0]?.handle ?? '', quote: found[0]?.evidence[0]?.quote ?? '' },
      ],
      signalIds: found.slice(0, 2).map((signal) => signal.id),
    };
    const outcome = await reviewRecord(
      CLINIC,
      snapshot(DROPOUT, { liveExpectations: [fundusItem(20)] }),
      { agent: agentSubmitting([merged]), enabled: ALL, patientRef: 'P-1' },
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.alreadyCovered).toBe(false);
  });

  it('an expectation due more than 90 days out does not cover a check-up never done (pat-0029)', async () => {
    const outcome = await reviewRecord(
      CLINIC,
      snapshot(DROPOUT, { liveExpectations: [fundusItem(290)] }),
      { enabled: ALL, patientRef: 'P-1' },
    );
    const fundus = outcome.findings.find((finding) => finding.summary.includes('fundus'));
    expect(fundus?.alreadyCovered).toBe(false);
  });

  it('two symptoms quoted from the same notes are two findings', async () => {
    const notes = [-300, -190, -75].map((offset) =>
      note(offset, 'Refiere cefalea vespertina. Refiere también cansancio. Plan: control.', {
        specialty: 'internal_medicine',
      }),
    );
    const outcome = await reviewRecord(CLINIC, snapshot(notes), {
      enabled: ALL,
      patientRef: 'P-1',
    });
    expect(
      outcome.findings.filter((finding) => finding.category === 'unaddressed_symptom'),
    ).toHaveLength(2);
  });
});

describe('the "commented in the notes" lexicon reads abbreviations (pat-0146)', () => {
  const uacr = [177, 186, 200, 212, 222].map((value, index) =>
    result(-500 + index * 95, '9318-7', value, 'mg/g'),
  );

  it('a UACR trend the notes quote as "RAC" is not silent', () => {
    expect(rules(uacr)).toContain('lab_trend:uacr');
    expect(
      rules([...uacr, note(-80, 'Trae labs: creatinina 2.6 mg/dL, TFG 21, RAC 222 mg/g.')]),
    ).not.toContain('lab_trend:uacr');
  });

  it.each([
    ['uacr', '9318-7', [40, 60, 90], 'mg/g', ['ACR 90 mg/g', 'UACR 90', 'microalb 90 mg/g']],
    ['creatinine', '2160-0', [1.1, 1.4, 1.75], 'mg/dL', ['Cr 1.75 mg/dL', 'creat 1.75']],
    ['egfr', '62238-1', [72, 61, 48], 'mL/min/1.73m2', ['eGFR 48', 'TFGe 48']],
    ['potassium', '2823-3', [4.6, 5.2, 5.9], 'mmol/L', ['K+ 5.9', 'K 5.9 mEq/L']],
    ['hba1c', '4548-4', [7.6, 8.6, 9.6], '%', ['A1c 9.6 %', 'Hb glicosilada 9.6 %']],
  ] as const)(
    'a %s trend named by its abbreviation is commented',
    (key, loinc, values, unit, phrases) => {
      const series = values.map((value, index) => result(-300 + index * 100, loinc, value, unit));
      expect(rules(series)).toContain(`lab_trend:${key}`);
      for (const phrase of phrases) {
        expect(
          rules([...series, note(-20, `Trae labs: ${phrase}. Plan: control.`)]),
          phrase,
        ).not.toContain(`lab_trend:${key}`);
      }
    },
  );
});

describe('severity follows the clinical meaning', () => {
  it('a potassium trend entirely within range is not a finding (pat-0062: 3.9 → 4.1 → 4.8)', () => {
    const potassium = [3.9, 4.1, 4.8].map((value, index) =>
      result(-400 + index * 150, '2823-3', value, 'mmol/L'),
    );
    expect(rules(potassium)).not.toContain('lab_trend:potassium');
    const nearLimit = [4.1, 4.5, 5.0].map((value, index) =>
      result(-400 + index * 150, '2823-3', value, 'mmol/L'),
    );
    expect(signalOf(nearLimit, 'lab_trend:potassium')?.severity).toBe('low');
  });

  it('any other trend entirely within range is at most low', () => {
    const creatinine = [0.6, 0.8, 1.0].map((value, index) =>
      result(-400 + index * 150, '2160-0', value, 'mg/dL'),
    );
    expect(signalOf(creatinine, 'lab_trend:creatinine')?.severity).toBe('low');
  });

  it('a systolic pressure rising within the normal range is not a vital trend', () => {
    const bp = [114, 122, 133].map((value, index) =>
      result(-400 + index * 150, '8480-6', value, 'mmHg'),
    );
    expect(rules(bp)).not.toContain('vital_trend:systolic_bp');
  });

  it('a headache that wakes the patient at night is a red flag: high, named in the rationale (rev-0003)', () => {
    const found = signalOf(
      [
        note(-300, 'Consulta por cefalea frontal vespertina de 2 semanas.', {
          specialty: 'internal_medicine',
        }),
        note(-190, 'Persiste cefalea, ahora casi diaria.', { specialty: 'internal_medicine' }),
        note(-75, 'Acude nuevamente por cefalea que la despierta en la noche.', {
          specialty: 'internal_medicine',
        }),
      ],
      'symptom:headache',
    );
    expect(found?.severity).toBe('high');
    expect(found?.rationale).toMatch(/wakes the patient at night/);
    expect(found?.evidence.map((item) => item.quote)).toContain(
      'Acude nuevamente por cefalea que la despierta en la noche',
    );
  });

  it('the worst headache or a neurological deficit is a red flag; a denied deficit is not', () => {
    const base = [
      note(-300, 'Consulta por cefalea.', { specialty: 'internal_medicine' }),
      note(-190, 'Persiste cefalea.', { specialty: 'internal_medicine' }),
    ];
    expect(
      signalOf([...base, note(-20, 'Cefalea intensa, la peor de su vida.')], 'symptom:headache')
        ?.severity,
    ).toBe('high');
    expect(
      signalOf([...base, note(-20, 'Cefalea con debilidad en brazo derecho.')], 'symptom:headache')
        ?.severity,
    ).toBe('high');
    expect(
      signalOf(
        [...base, note(-20, 'Persiste cefalea tensional, sin déficit neurológico.')],
        'symptom:headache',
      )?.severity,
    ).toBe('medium');
  });

  it('unintentional weight loss ≥ 5 % with poor appetite at 65 or older is high, with a work-up (rev-0010)', () => {
    const weights = [82, 79, 76, 72].map((value, index) =>
      result(-360 + index * 110, '29463-7', value, 'kg'),
    );
    const record = [
      ...weights,
      note(-130, 'Refiere cansancio persistente y menos apetito. Plan: control en 3 meses.'),
    ];
    const old = { birthDate: '1960-07-19' };
    const found = signalOf(record, 'vital_trend:weight', old);
    expect(found?.severity).toBe('high');
    expect(found?.rationale).toMatch(/poor appetite/);
    expect(found?.suggestion).toMatch(/work-up/);
    // A 6 % loss in a 40-year-old with no other sign stays low.
    const mild = [80, 78.5, 75.2].map((value, index) =>
      result(-300 + index * 120, '29463-7', value, 'kg'),
    );
    expect(signalOf(mild, 'vital_trend:weight', { birthDate: '1985-01-01' })?.severity).toBe('low');
    // A loss the plan asked for is not a red flag.
    const intended = [
      ...weights,
      note(-300, 'Obesidad. Plan: dieta hipocalórica para bajar de peso.'),
      note(-130, 'Refiere menos apetito con la dieta.'),
    ];
    expect(signalOf(intended, 'vital_trend:weight', old)?.severity).not.toBe('high');
  });

  it('a symptom the latest note denies is not current (pat-0145: "MsIs sin edema")', () => {
    const notes = [
      note(-300, 'EF: MsIs edema grado I maleolar.', { specialty: 'internal_medicine' }),
      note(-200, 'EF: MsIs edema grado I maleolar.', { specialty: 'internal_medicine' }),
      note(-100, 'EF: MsIs edema grado I maleolar.', { specialty: 'internal_medicine' }),
    ];
    expect(rules(notes)).toContain('symptom:edema');
    expect(
      rules([
        ...notes,
        note(-30, 'EF: TA 132/80. MsIs sin edema.', { specialty: 'internal_medicine' }),
      ]),
    ).not.toContain('symptom:edema');
  });
});

describe('an unreviewed abnormal result is covered only by an action on that result (rev-0002)', () => {
  const hba1c = result(-60, '4548-4', 9.2, '%', { id: 'obs-hba1c-92' });
  const record = [
    result(-300, '4548-4', 7.6, '%'),
    encounter(-250),
    note(-250, 'DM2 en tto. Alergias: niega. Plan: control en 6 meses con HbA1c.'),
    hba1c,
  ];

  async function coverageWith(expectation: Expectation) {
    const outcome = await reviewRecord(
      CLINIC,
      snapshot(record, { liveExpectations: [expectation] }),
      { enabled: ALL, patientRef: 'P-1' },
    );
    return outcome.findings.find((finding) => finding.category === 'abnormal_result_no_followup');
  }

  it('a routine re-test of the same analyte does not cover it', async () => {
    const retest = anExpectation({
      ruleId: 'protocol_diabetes_hba1c',
      layer: 'protocol',
      matchKey: 'loinc:4548-4',
      source: hba1c.source,
      dueAt: day(30),
      reason: { code: 'protocol_diabetes_hba1c', label: 'No recent HbA1c' },
    });
    expect((await coverageWith(retest))?.alreadyCovered).toBe(false);
  });

  it('a review of that result (a visit it triggered) covers it', async () => {
    const review = anExpectation({ source: hba1c.source, matchKey: 'visit' });
    expect((await coverageWith(review))?.alreadyCovered).toBe(true);
  });

  it('a visit planned before the result does not review it', async () => {
    const planned = anExpectation({
      ruleId: 'doctor_plan_followup',
      layer: 'doctor_plan',
      source: { resourceType: 'DocumentReference', id: 'note-old' },
      matchKey: 'visit',
    });
    expect((await coverageWith(planned))?.alreadyCovered).toBe(false);
  });
});

describe('a probable inferred diagnosis gives way to the coded one (rev-0001, rev-0005)', () => {
  const hba1c = result(-400, '4548-4', 6.8, '%', { id: 'obs-a1c' });
  const coded = condition(-300, 'E11.9', 'Type 2 diabetes mellitus');
  function standing(
    code: string,
    status: PatientCondition['status'],
    source: PatientCondition['source'],
    sourceType: PatientCondition['sourceType'],
  ): PatientCondition {
    return {
      clinicId: CLINIC,
      patientId: PATIENT,
      code: { system: ICD10_SYSTEM, code },
      status,
      confidence: status === 'confirmed' ? 1 : 0.8,
      sourceType,
      source,
      updatedAt: day(-300),
    };
  }
  const conditions: PatientCondition[] = [
    standing('E14', 'probable', hba1c.source, 'inferred_from_result'),
    standing('E11.9', 'confirmed', coded.source, 'recorded'),
  ];
  const record: PatientRecordSnapshot = snapshot(
    [hba1c, coded, note(-60, 'DM2 estable. Alergias: niega.', { specialty: 'diabetology' })],
    { conditions },
  );

  it('the dossier keeps only the confirmed code', () => {
    expect(buildDossier(record).conditions.map((item) => item.code)).toEqual(['E11.9']);
  });

  it('the evidence of "patient with diabetes" is the coded diagnosis, never the HbA1c', () => {
    const screening = detectSignals(buildDossier(record)).find(
      (signal) => signal.rule === 'screening:diabetic_fundus',
    );
    expect(screening?.evidence.map((item) => item.quote)).toEqual([
      'E11.9 Type 2 diabetes mellitus',
    ]);
  });
});

describe('blood pressure above target with no treatment change (pat-0148)', () => {
  /** A BP panel (85354-9) at `offset` days: systolic and diastolic as components. */
  function panel(offset: number, systolic: number, diastolic: number) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a panel has no value of its own
    const { value, ...event } = result(offset, '85354-9', 0, 'mmHg', {
      id: `bp${String(-offset)}`,
    });
    return {
      event,
      components: [
        `Observation/${event.source.id}`,
        [
          { code: '8480-6', value: systolic, unit: 'mmHg' },
          { code: '8462-4', value: diastolic, unit: 'mmHg' },
        ],
      ] as const,
    };
  }
  const losartan = (offset: number, dose = '1 tab VO c/12h') =>
    medication(offset, 'Losartán 50 mg', { atc: 'C09CA01', dosageText: dose });

  function review(
    readings: readonly ReturnType<typeof panel>[],
    prescriptions: readonly ClinicalEvent[],
  ): Signal[] {
    return signals([...readings.map((reading) => reading.event), ...prescriptions], {
      components: new Map(readings.map((reading) => reading.components)),
    });
  }

  it('161/99 then 165/88 on the same losartan is a high vital-sign finding', () => {
    const found = review(
      [panel(-630, 145, 96), panel(-450, 114, 72), panel(-270, 161, 99), panel(-84, 165, 88)],
      [losartan(-630), losartan(-450), losartan(-270), losartan(-84)],
    ).filter((signal) => signal.category === 'vital_trend');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('high');
  });

  it('above target twice without a rising trend is still therapeutic inertia', () => {
    const found = signalOf(
      [panel(-270, 158, 96).event, panel(-84, 150, 95).event, losartan(-270), losartan(-84)],
      'vital_trend:uncontrolled_bp',
      {
        components: new Map([panel(-270, 158, 96).components, panel(-84, 150, 95).components]),
      },
    );
    expect(found?.severity).toBe('medium');
    expect(found?.summary).toBe(
      'Blood pressure above target at 2 visits in a row (158/96 → 150/95 mmHg) with no treatment change',
    );
    expect(found?.evidence.map((item) => item.quote)).toContain('Losartán 50 mg — 1 tab VO c/12h');
  });

  it('a dose change at the last visit, or a controlled reading, is not inertia', () => {
    const readings = [panel(-270, 158, 96), panel(-84, 150, 95)];
    const rule = (found: Signal[]) => found.map((signal) => signal.rule);
    expect(
      rule(review(readings, [losartan(-270), losartan(-84, '1 tab VO c/12h + amlodipino')])),
    ).not.toContain('vital_trend:uncontrolled_bp');
    expect(
      rule(review([panel(-270, 158, 96), panel(-84, 132, 82)], [losartan(-270), losartan(-84)])),
    ).not.toContain('vital_trend:uncontrolled_bp');
  });
});
