import { RULE_IDS } from '../constants.ts';
import { CONDITIONS, MEDICATIONS, ORDERS } from '../synthetic/catalog.ts';
import type { PatientInput } from '../synthetic/fhir-builders.ts';
import { ScenarioBuilder } from './builder.ts';
import type { Scenario } from './types.ts';

/**
 * The PRD acceptance cases as replayable scenarios. Rules they encode:
 * lab result within 15 days, imaging 30, short treatment end + 3, abnormal
 * result 7, cadence 3x the usual interval once there are 2 visits, diabetes
 * protocol (visit every 180 days, HbA1c every 90), the doctor's plan beats
 * cadence and protocol for the need it covers, and one case per patient that
 * merges every expired expectation regardless of its layer.
 */

const {
  labOrderResultPending: LAB,
  shortTreatmentFollowup: SHORT_TX,
  cadenceBreak: CADENCE,
  doctorPlanFollowup: PLAN,
  protocolDiabetesVisit: DM_VISIT,
  protocolDiabetesHba1c: DM_HBA1C,
} = RULE_IDS;

const HBA1C = { code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' };

function patient(
  id: string,
  given: readonly string[],
  family: readonly string[],
  gender: 'female' | 'male',
  birthDate: string,
): PatientInput {
  return {
    id,
    mrn: `HC-S${id.slice(-4).toUpperCase()}`,
    name: { given, family },
    gender,
    birthDate,
  };
}

function diabetic6MonthsNoPlan(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-dm-noplan', ['Rosa', 'Elena'], ['Briceño', 'Salas'], 'female', '1964-07-19'),
    'diabetology',
    'prac-diab-01',
  );
  const note = [
    'Pcte fem 61a, conocida DM2 desde hace 8 años, en tto con metformina 850 mg c/12h. Acude a ctrl.',
    'Refiere buena adherencia, niega hipoglicemias.',
    'EF: TA 128/78 mmHg, FC 76 lpm, peso 71 kg. Glicemia capilar 132 mg/dl. Pies sin lesiones.',
    'Dx: DM2 en metas.',
    'Se explica condición y se refuerza dieta.',
  ].join('\n');
  s.consultation(0, {
    visitType: 'Consulta de control',
    note,
    conditions: [CONDITIONS.dm2],
    medications: [MEDICATIONS.metformin850],
    orders: [],
    extraction: {
      hasPlan: false,
      conditions: [{ icd10: 'E11', display: 'Type 2 diabetes mellitus', quote: 'DM2' }],
      medications: [{ text: 'metformina 850 mg c/12h', quote: 'metformina 850 mg c/12h' }],
      planItems: [],
    },
  });
  // HbA1c done at an outside lab with a standing order: both normal, linked to no order.
  s.result(85, ORDERS.hba1c, undefined, [5.6]);
  s.result(170, ORDERS.hba1c, undefined, [5.5]);
  return s.build(
    'diabetic_6_months_no_plan',
    'Diabetic patient seen once, with a note that has no plan. She keeps doing HbA1c every ~3 months ' +
      '(each result fulfills the HbA1c protocol and restarts it) but never comes back: at 6 months the ' +
      'diabetes visit protocol expires and opens a case. The note without a plan is a quality finding.',
    [
      {
        day: 1,
        openExpectations: [
          { ruleId: DM_VISIT, dueDay: 180 },
          { ruleId: DM_HBA1C, dueDay: 90 },
        ],
        absentRuleIds: [PLAN, CADENCE],
        activeCases: [],
        qualityFindings: ['note_without_plan'],
      },
      {
        day: 86,
        openExpectations: [
          { ruleId: DM_VISIT, dueDay: 180 },
          { ruleId: DM_HBA1C, dueDay: 175 },
        ],
        closedExpectations: [{ ruleId: DM_HBA1C, dueDay: 90, status: 'fulfilled' }],
        activeCases: [],
      },
      {
        day: 171,
        openExpectations: [
          { ruleId: DM_VISIT, dueDay: 180 },
          { ruleId: DM_HBA1C, dueDay: 260 },
        ],
        activeCases: [],
      },
      {
        day: 181,
        openExpectations: [{ ruleId: DM_HBA1C, dueDay: 260 }],
        absentRuleIds: [DM_VISIT],
        activeCases: [{ reasons: [DM_VISIT] }],
      },
    ],
  );
}

function diabeticSingleVisitPlan3Months(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-dm-plan', ['Héctor'], ['Villalba', 'Rojas'], 'male', '1971-02-03'),
    'diabetology',
    'prac-diab-02',
  );
  const note = [
    'Pcte masc 54a, referido por glicemias elevadas en chequeo laboral. Trae glicemia en ayunas 168 mg/dl y HbA1c 7.9% (labs externos). Asintomático. IMC 31.',
    'EF: TA 126/80 mmHg. Pies sin lesiones.',
    'Dx: DM2 de reciente diagnóstico. Obesidad.',
    'Plan: metformina 850 mg VO c/12h con las comidas. Dieta y actividad física. Ctrl en 3 meses con HbA1c.',
  ].join('\n');
  s.consultation(0, {
    visitType: 'Primera consulta',
    note,
    conditions: [CONDITIONS.dm2, CONDITIONS.obesity],
    medications: [MEDICATIONS.metformin850],
    orders: [],
    extraction: {
      hasPlan: true,
      conditions: [
        { icd10: 'E11', display: 'Type 2 diabetes mellitus', quote: 'DM2 de reciente diagnóstico' },
        { icd10: 'E66', display: 'Obesity', quote: 'Obesidad' },
      ],
      medications: [{ text: 'metformina 850 mg VO c/12h', quote: 'metformina 850 mg VO c/12h' }],
      planItems: [
        {
          kind: 'follow_up_visit',
          description: 'follow-up visit',
          inDays: 90,
          quote: 'Ctrl en 3 meses',
        },
        { kind: 'lab', description: 'repeat HbA1c', inDays: 90, quote: 'con HbA1c', loinc: HBA1C },
      ],
    },
  });
  return s.build(
    'diabetic_single_visit_plan_3_months',
    'New diabetic patient with one visit whose plan says "control in 3 months with HbA1c". The ' +
      "doctor's plan covers both the visit and the HbA1c, so the diabetes protocol adds no visit or " +
      'HbA1c expectation. At day 91 both plan items have expired into a single case.',
    [
      {
        day: 1,
        openExpectations: [
          { ruleId: PLAN, dueDay: 90 },
          { ruleId: PLAN, dueDay: 90 },
        ],
        absentRuleIds: [DM_VISIT, DM_HBA1C, CADENCE],
        activeCases: [],
        qualityFindings: [],
      },
      {
        day: 91,
        absentRuleIds: [PLAN, DM_VISIT, DM_HBA1C],
        activeCases: [{ reasons: [PLAN] }],
      },
    ],
  );
}

function labOrderRepeatedSameTest(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-lab-same', ['Mercedes'], ['Arismendi', 'Lugo'], 'female', '1978-09-12'),
    'internal_medicine',
    'prac-im-02',
  );
  const note = [
    'Pcte fem 47a, consulta para chequeo. Antecedente de glicemia en ayunas 108 mg/dl hace 6 meses. Asintomática. IMC 29. TA 122/76.',
    'Dx: prediabetes.',
    'Plan: dieta baja en azúcares simples, actividad física 150 min/semana. Se solicita HbA1c. Traer resultados.',
  ].join('\n');
  s.consultation(0, {
    visitType: 'Consulta por morbilidad',
    note,
    conditions: [CONDITIONS.prediabetes],
    medications: [],
    orders: [ORDERS.hba1c],
    extraction: {
      hasPlan: true,
      conditions: [{ icd10: 'R73', display: 'Elevated blood glucose level', quote: 'prediabetes' }],
      medications: [],
      planItems: [],
    },
  });
  // The patient lost the paper order; the clinic re-issues the same test.
  s.order(10, ORDERS.hba1c);
  return s.build(
    'lab_order_repeated_same_test',
    'An HbA1c order on day 0 is re-issued on day 10 before any result. The new order supersedes the ' +
      'old expectation, so on day 16 there is one open lab expectation (due day 25) and no case; the ' +
      'case opens only after the second order expires.',
    [
      {
        day: 1,
        openExpectations: [{ ruleId: LAB, matchKey: 'loinc:4548-4', dueDay: 15 }],
        activeCases: [],
      },
      {
        day: 11,
        openExpectations: [{ ruleId: LAB, matchKey: 'loinc:4548-4', dueDay: 25 }],
        activeCases: [],
      },
      {
        day: 16,
        openExpectations: [{ ruleId: LAB, matchKey: 'loinc:4548-4', dueDay: 25 }],
        closedExpectations: [
          { ruleId: LAB, matchKey: 'loinc:4548-4', dueDay: 15, status: 'superseded' },
        ],
        activeCases: [],
      },
      { day: 26, absentRuleIds: [LAB], activeCases: [{ reasons: [LAB] }] },
    ],
  );
}

function labOrderRepeatedDifferentTest(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-lab-diff', ['Orlando', 'José'], ['Fuenmayor', 'Paz'], 'male', '1973-05-28'),
    'internal_medicine',
    'prac-im-01',
  );
  const note = [
    'Pcte masc 52a consulta por astenia y somnolencia diurna de 2 meses. Niega pérdida de peso. TA 124/80, FC 64. Piel seca.',
    'Dx: astenia en estudio, descartar hipotiroidismo.',
    'Se solicita TSH.',
  ].join('\n');
  s.consultation(0, {
    visitType: 'Consulta por morbilidad',
    note,
    conditions: [CONDITIONS.fatigue],
    medications: [],
    orders: [ORDERS.tsh],
    extraction: {
      hasPlan: true,
      conditions: [{ icd10: 'R53', display: 'Malaise and fatigue', quote: 'astenia en estudio' }],
      medications: [],
      planItems: [],
    },
  });
  // The doctor adds a lipid panel on day 10, a different test: it does not supersede the TSH.
  s.order(10, ORDERS.lipidPanel);
  return s.build(
    'lab_order_repeated_different_test',
    'A TSH order on day 0 and a lipid panel on day 10. Different tests do not supersede each other: ' +
      'both stay open, the TSH expires first and opens the case, and the lipid panel joins the same ' +
      'case when it expires.',
    [
      {
        day: 11,
        openExpectations: [
          { ruleId: LAB, matchKey: 'loinc:3016-3', dueDay: 15 },
          { ruleId: LAB, matchKey: 'loinc:57698-3', dueDay: 25 },
        ],
        activeCases: [],
      },
      {
        day: 16,
        openExpectations: [{ ruleId: LAB, matchKey: 'loinc:57698-3', dueDay: 25 }],
        activeCases: [{ reasons: [LAB] }],
      },
      { day: 26, absentRuleIds: [LAB], activeCases: [{ reasons: [LAB] }] },
    ],
  );
}

function psychologyMonthlyDropout(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-psy-monthly', ['Daniela'], ['Montilla', 'Cárdenas'], 'female', '1992-11-04'),
    'psychology',
    'prac-psy-01',
  );
  const sessions: readonly (readonly [number, string])[] = [
    [
      0,
      [
        'Primera sesión. Pcte fem 33a, consulta por preocupación constante y tensión muscular asociadas a carga laboral.',
        'Se realiza entrevista inicial y encuadre. Afecto ansioso, discurso coherente.',
        'Impresión dx: TAG.',
        'Se inicia proceso con enfoque cognitivo-conductual.',
      ].join('\n'),
    ],
    [
      30,
      [
        'Sesión 2. Pcte refiere aplicar la respiración diafragmática en el trabajo con buen resultado.',
        'Se trabaja registro de pensamientos automáticos. Afecto eutímico.',
        'Se continúa proceso terapéutico.',
      ].join('\n'),
    ],
    [
      60,
      [
        'Sesión 3. Refiere semana con mayor carga laboral, identifica disparadores.',
        'Se trabaja reestructuración cognitiva. Buena disposición.',
        'Tarea: registro diario de preocupaciones.',
      ].join('\n'),
    ],
  ];
  sessions.forEach(([day, note], index) => {
    s.consultation(day, {
      visitType: index === 0 ? 'Primera sesión' : 'Sesión de psicoterapia',
      note,
      conditions: index === 0 ? [CONDITIONS.anxiety] : [],
      medications: [],
      orders: [],
      extraction: {
        hasPlan: true,
        conditions:
          index === 0
            ? [{ icd10: 'F41', display: 'Generalized anxiety disorder', quote: 'TAG' }]
            : [],
        medications: [],
        planItems: [],
      },
    });
  });
  return s.build(
    'psychology_monthly_dropout',
    'Monthly psychotherapy sessions on days 0, 30 and 60, with no dated next session in the notes. ' +
      'From the second visit the cadence layer expects the next one by 3x the usual 30-day interval ' +
      '(day 120, then day 150 after the third). The patient stops coming: the case opens at day 150.',
    [
      { day: 1, absentRuleIds: [CADENCE, PLAN], activeCases: [] },
      { day: 31, openExpectations: [{ ruleId: CADENCE, dueDay: 120 }], activeCases: [] },
      { day: 61, openExpectations: [{ ruleId: CADENCE, dueDay: 150 }], activeCases: [] },
      { day: 121, openExpectations: [{ ruleId: CADENCE, dueDay: 150 }], activeCases: [] },
      { day: 151, absentRuleIds: [CADENCE], activeCases: [{ reasons: [CADENCE] }] },
    ],
  );
}

function shortTreatmentNoFollowup(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-short-tx', ['Karina'], ['Zambrano', 'Ochoa'], 'female', '1996-04-22'),
    'internal_medicine',
    'prac-im-02',
  );
  const note = [
    'Pcte fem 29a consulta por disuria y polaquiuria de 2 días. Afebril, PPL negativa.',
    'Dx: ITU baja.',
    'Plan: nitrofurantoína 100 mg VO c/12h x 7 días. Abundantes líquidos.',
  ].join('\n');
  s.consultation(0, {
    visitType: 'Consulta por morbilidad',
    note,
    conditions: [CONDITIONS.uti],
    medications: [MEDICATIONS.nitrofurantoin],
    orders: [],
    extraction: {
      hasPlan: true,
      conditions: [
        { icd10: 'N39', display: 'Urinary tract infection, site not specified', quote: 'ITU baja' },
      ],
      medications: [
        {
          text: 'nitrofurantoína 100 mg VO c/12h x 7 días',
          quote: 'nitrofurantoína 100 mg VO c/12h x 7 días',
          durationDays: 7,
        },
      ],
      planItems: [],
    },
  });
  return s.build(
    'short_treatment_no_followup',
    'A 7-day antibiotic (MedicationRequest with expectedSupplyDuration 7 d) and no control visit. ' +
      'The short-treatment rule expects a visit by the end of treatment + 3 days (day 10); nothing ' +
      'arrives, so the case opens on day 10.',
    [
      { day: 1, openExpectations: [{ ruleId: SHORT_TX, dueDay: 10 }], activeCases: [] },
      { day: 11, absentRuleIds: [SHORT_TX], activeCases: [{ reasons: [SHORT_TX] }] },
    ],
  );
}

const POSTPARTUM_NOTE = [
  'Puérpera de 10 días, parto eutócico sin complicaciones. Lactancia materna exclusiva.',
  'TA 110/70. Útero involucionado, loquios normales. Mamas sin signos de mastitis.',
  'Dx: puerperio mediato normal.',
  'Plan: control puerperal en 6 semanas. Asesoría anticonceptiva en esa consulta.',
].join('\n');

function postpartumVisit(s: ScenarioBuilder): void {
  s.consultation(0, {
    visitType: 'Control puerperal',
    note: POSTPARTUM_NOTE,
    conditions: [CONDITIONS.postpartum],
    medications: [],
    orders: [],
    extraction: {
      hasPlan: true,
      conditions: [
        {
          icd10: 'Z39',
          display: 'Postpartum care and examination',
          quote: 'puerperio mediato normal',
        },
      ],
      medications: [],
      planItems: [
        {
          kind: 'follow_up_visit',
          description: 'postpartum control visit',
          inDays: 42,
          quote: 'control puerperal en 6 semanas',
        },
      ],
    },
  });
}

function gynecologyPostpartum6Weeks(): Scenario {
  const s = new ScenarioBuilder(
    patient('pat-scn-postpartum', ['Yuliana'], ['Pacheco', 'Marín'], 'female', '1998-08-30'),
    'gynecology',
    'prac-gyn-01',
  );
  postpartumVisit(s);
  return s.build(
    'gynecology_postpartum_6_weeks',
    'Postpartum visit whose plan asks for a control in 6 weeks. The patient never books it: the ' +
      "doctor's plan expectation (day 42) expires into a case.",
    [
      {
        day: 1,
        openExpectations: [{ ruleId: PLAN, dueDay: 42 }],
        activeCases: [],
        qualityFindings: [],
      },
      { day: 43, absentRuleIds: [PLAN], activeCases: [{ reasons: [PLAN] }] },
    ],
  );
}

function postpartumBookedResolves(): Scenario {
  const s = new ScenarioBuilder(
    patient(
      'pat-scn-postpartum-booked',
      ['Nathalie'],
      ['Echeverría', 'Toro'],
      'female',
      '1995-01-17',
    ),
    'gynecology',
    'prac-gyn-02',
  );
  postpartumVisit(s);
  // After the case opens, the clinic calls her and she books the control for day 49.
  s.booking(45, 49, 'Control puerperal');
  return s.build(
    'postpartum_booked_resolves',
    'Same postpartum plan; the case opens at day 42. On day 45 the patient books the control visit ' +
      '(Appointment booked for day 49), which resolves the case as fulfilled.',
    [
      { day: 43, activeCases: [{ reasons: [PLAN] }] },
      {
        day: 46,
        absentRuleIds: [PLAN],
        activeCases: [],
        resolvedCases: [{ reasons: [PLAN], resolution: 'fulfilled' }],
      },
    ],
  );
}

function threeLayersOneCase(): Scenario {
  const s = new ScenarioBuilder(
    patient(
      'pat-scn-three-layers',
      ['Ramón', 'Antonio'],
      ['Bracho', 'Medina'],
      'male',
      '1962-03-08',
    ),
    'diabetology',
    'prac-diab-01',
  );
  s.consultation(0, {
    visitType: 'Consulta de control',
    note: [
      'Pcte masc 63a, conocido DM2 desde hace 12 años, en tto con metformina 1000 mg c/12h. Acude a ctrl. Asintomático.',
      'TA 132/82, peso 84 kg. Glicemia capilar 148 mg/dl.',
      'Dx: DM2.',
    ].join('\n'),
    conditions: [CONDITIONS.dm2],
    medications: [MEDICATIONS.metformin1000],
    orders: [],
    extraction: {
      hasPlan: false,
      conditions: [{ icd10: 'E11', display: 'Type 2 diabetes mellitus', quote: 'DM2' }],
      medications: [{ text: 'metformina 1000 mg c/12h', quote: 'metformina 1000 mg c/12h' }],
      planItems: [],
    },
  });
  const secondNote = [
    'Pcte masc 63a, DM2, acude a ctrl. Refiere olvidar la dosis nocturna. Glicemia capilar 176 mg/dl. TA 130/80.',
    'Dx: DM2 fuera de metas.',
    'Plan: metformina 1000 mg c/12h, reforzar adherencia. Se solicita perfil lipídico. Ctrl en 1 mes con resultados.',
  ].join('\n');
  s.consultation(60, {
    visitType: 'Consulta de control',
    note: secondNote,
    conditions: [CONDITIONS.dm2],
    medications: [MEDICATIONS.metformin1000],
    orders: [ORDERS.lipidPanel],
    extraction: {
      hasPlan: true,
      conditions: [
        { icd10: 'E11', display: 'Type 2 diabetes mellitus', quote: 'DM2 fuera de metas' },
      ],
      medications: [{ text: 'metformina 1000 mg c/12h', quote: 'metformina 1000 mg c/12h' }],
      planItems: [
        {
          kind: 'follow_up_visit',
          description: 'follow-up visit with results',
          inDays: 30,
          quote: 'Ctrl en 1 mes con resultados',
        },
      ],
    },
  });
  return s.build(
    'three_layers_one_case',
    'Day 0: diabetic visit without a plan enrolls the patient in the diabetes protocol (visit day 180, ' +
      'HbA1c day 90). Day 60: a visit fulfills the protocol visit and its plan ("control in 1 month") ' +
      'covers the next visit, so neither the protocol nor the cadence layer adds a visit; a lipid ' +
      'panel order adds a universal lab expectation (day 75). The lab (universal), the plan (doctor) ' +
      'and the HbA1c (protocol) expire on days 75, 90 and 90 and merge into ONE case for the patient.',
    [
      {
        day: 1,
        openExpectations: [
          { ruleId: DM_VISIT, dueDay: 180 },
          { ruleId: DM_HBA1C, dueDay: 90 },
        ],
        activeCases: [],
        qualityFindings: ['note_without_plan'],
      },
      {
        day: 61,
        openExpectations: [
          { ruleId: LAB, matchKey: 'loinc:57698-3', dueDay: 75 },
          { ruleId: PLAN, dueDay: 90 },
          { ruleId: DM_HBA1C, dueDay: 90 },
        ],
        absentRuleIds: [DM_VISIT, CADENCE],
        closedExpectations: [{ ruleId: DM_VISIT, dueDay: 180, status: 'fulfilled' }],
        activeCases: [],
        qualityFindings: ['note_without_plan'],
      },
      { day: 76, activeCases: [{ reasons: [LAB] }] },
      {
        day: 91,
        absentRuleIds: [LAB, PLAN],
        activeCases: [{ reasons: [LAB, PLAN, DM_HBA1C] }],
      },
    ],
  );
}

/** Every scenario, in a stable order. */
export function buildScenarios(): Scenario[] {
  return [
    diabetic6MonthsNoPlan(),
    diabeticSingleVisitPlan3Months(),
    labOrderRepeatedSameTest(),
    labOrderRepeatedDifferentTest(),
    psychologyMonthlyDropout(),
    shortTreatmentNoFollowup(),
    gynecologyPostpartum6Weeks(),
    postpartumBookedResolves(),
    threeLayersOneCase(),
  ];
}
