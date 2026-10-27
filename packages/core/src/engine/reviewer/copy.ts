/**
 * Every word the clinical reviewer writes for the clinic, per locale: the
 * finding texts of the deterministic detectors, the titles of cited
 * documents and the canonical lines of results ("Creatinine: 1.75 mg/dL").
 * Quotes from notes are never translated: they stay verbatim, in the
 * language the doctor wrote. A model writes its own findings in the same
 * locale (the prompt asks for it).
 */

import {
  DEFAULT_REVIEW_LOCALE,
  REVIEW_LOCALES,
  type ReviewLocale,
} from '../../domain/clinical-finding.ts';

export { DEFAULT_REVIEW_LOCALE, REVIEW_LOCALES, type ReviewLocale };

/** The language name a prompt asks a model to write in. */
export const LOCALE_LANGUAGE: Readonly<Record<ReviewLocale, string>> = {
  en: 'English',
  es: 'neutral Spanish (addressing the clinician with "tú")',
};

export interface FindingText {
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
}

interface RuleCopy {
  readonly risk: string;
  readonly suggestion: string;
}

export interface ReviewerCopy {
  /** Label of each measurement key (`creatinine`): also the canonical text of its results. */
  readonly measurements: Readonly<Record<string, string>>;
  readonly specialty: (key: string) => string;
  readonly noteTitle: (specialty: string | undefined) => string;
  readonly labTrend: (args: {
    readonly label: string;
    readonly rising: boolean;
    readonly count: number;
    readonly series: string;
    readonly unit: string;
    readonly changePct: number;
    readonly from: string;
    readonly to: string;
    readonly outOfRange: boolean;
    readonly renal: boolean;
  }) => FindingText;
  readonly vitalTrend: (args: {
    readonly kind: 'weight' | 'systolic';
    readonly values: string;
    readonly delta: number;
    readonly changePct: number;
    readonly count: number;
    readonly from: string;
    readonly to: string;
  }) => FindingText;
  readonly abnormalResult: (args: {
    readonly label: string;
    readonly value: string;
    readonly unit: string;
    readonly date: string;
    readonly high: boolean;
    readonly threshold: string;
    readonly days: number;
  }) => FindingText;
  readonly interactions: Readonly<Record<string, RuleCopy>>;
  readonly interactionSummary: (drugs: readonly string[]) => string;
  readonly drugConditions: Readonly<Record<string, RuleCopy>>;
  readonly conditionNames: Readonly<Record<string, string>>;
  readonly egfr: (value: number, estimated: boolean) => string;
  readonly diagnosisOf: (condition: string) => string;
  readonly drugConditionSummary: (drug: string, because: string) => string;
  readonly symptoms: Readonly<Record<string, { readonly label: string; readonly workup: string }>>;
  readonly symptomFinding: (args: {
    readonly label: string;
    readonly count: number;
    readonly specialties: readonly string[];
    readonly workup: string;
  }) => FindingText;
  readonly screenings: Readonly<
    Record<string, { readonly label: string; readonly suggestion: string }>
  >;
  readonly screeningFinding: (label: string, months: number, suggestion: string) => FindingText;
  readonly allergies: (notes: number, activeMedications: number) => FindingText;
  readonly uncodedDiagnosis: (display: string) => FindingText;
  readonly utilization: (recent: number, perQuarter: number) => FindingText;
  readonly questions: Readonly<
    Record<string, { readonly question: string; readonly rationale: string }>
  >;
  readonly questionSuggestion: string;
}

const signed = (value: number): string => `${value > 0 ? '+' : ''}${String(Math.round(value))}`;

const EN: ReviewerCopy = {
  measurements: {
    creatinine: 'Creatinine',
    egfr: 'Estimated GFR',
    hba1c: 'HbA1c',
    glucose: 'Fasting glucose',
    ldl: 'LDL cholesterol',
    potassium: 'Potassium',
    hemoglobin: 'Hemoglobin',
    uacr: 'Urine albumin/creatinine ratio',
    systolic_bp: 'Systolic blood pressure',
    diastolic_bp: 'Diastolic blood pressure',
    weight: 'Weight',
  },
  specialty: (key) =>
    ({
      diabetology: 'diabetology',
      internal_medicine: 'internal medicine',
      psychology: 'psychology',
      gynecology: 'gynecology',
      cardiology: 'cardiology',
      ophthalmology: 'ophthalmology',
    })[key] ?? key.replace(/_/g, ' '),
  noteTitle: (specialty) =>
    specialty === undefined ? 'Clinical note' : `${capitalize(specialty)} note`,
  labTrend: (a) => ({
    summary: `${a.label} ${a.rising ? 'rising' : 'falling'} over the last ${String(a.count)} results (${a.series} ${a.unit}) with no comment in the notes`,
    rationale: `${String(a.count)} results in a row got worse (${signed(a.changePct)} % between ${a.from} and ${a.to})${a.outOfRange ? ', the latest out of range' : ''}, and no later note mentions it.`,
    suggestion: a.renal
      ? 'Consider assessing renal function and reviewing drugs that depend on it (metformin, NSAIDs).'
      : `Consider reviewing ${a.label.toLowerCase()} and the treatment at the next visit.`,
  }),
  vitalTrend: (a) => ({
    summary:
      a.kind === 'weight'
        ? `Steady weight ${a.delta > 0 ? 'gain' : 'loss'} (${a.values} kg, ${signed(a.changePct)} %)`
        : `Systolic blood pressure rising over ${String(a.count)} visits (${a.values} mmHg)`,
    rationale: `${String(a.count)} measurements in a row moved the same way between ${a.from} and ${a.to}.`,
    suggestion:
      a.kind === 'weight'
        ? 'Consider exploring the cause of the weight change (diet, medication, intercurrent illness).'
        : 'Consider confirming the readings (ambulatory or home monitoring) and reviewing the antihypertensive treatment.',
  }),
  abnormalResult: (a) => ({
    summary: `${a.label} of ${a.value} ${a.unit} with no visit or comment afterwards`,
    rationale: `Result of ${a.date} ${a.high ? 'well above' : 'well below'} range (${a.high ? `target < ${a.threshold}` : `> ${a.threshold}`} ${a.unit}); ${String(a.days)} days ago, with no visit, upcoming appointment or note about it.`,
    suggestion: 'Consider contacting the patient to review the result and adjust the plan.',
  }),
  interactions: {
    nsaid_raas_diuretic: {
      risk: 'NSAID together with an ACE inhibitor/ARB and a diuretic ("triple whammy"): risk of acute kidney injury.',
      suggestion:
        'Consider whether the NSAID is needed and check renal function (creatinine, potassium).',
    },
    vka_nsaid: {
      risk: 'Vitamin K antagonist with an NSAID: increased bleeding risk.',
      suggestion: 'Consider avoiding the NSAID or monitoring INR and signs of bleeding.',
    },
    ssri_tramadol: {
      risk: 'SSRI with tramadol: risk of serotonin syndrome and seizures.',
      suggestion: 'Consider another analgesic or monitoring for serotonergic symptoms.',
    },
    nsaid_raas: {
      risk: 'NSAID with an ACE inhibitor/ARB: blunts the antihypertensive effect and can impair renal function.',
      suggestion: 'Consider whether the NSAID is needed and check blood pressure and creatinine.',
    },
    raas_potassium_sparing: {
      risk: 'ACE inhibitor/ARB with a potassium-sparing diuretic: risk of hyperkalemia.',
      suggestion: 'Consider checking serum potassium.',
    },
    ssri_nsaid: {
      risk: 'SSRI with an NSAID: increased risk of gastrointestinal bleeding.',
      suggestion: 'Consider gastroprotection or whether the NSAID is needed.',
    },
    doac_nsaid: {
      risk: 'Direct oral anticoagulant with an NSAID: increased bleeding risk.',
      suggestion: 'Consider avoiding the NSAID or monitoring signs of bleeding.',
    },
    clopidogrel_omeprazole: {
      risk: 'Clopidogrel with omeprazole/esomeprazole: may reduce the antiplatelet effect.',
      suggestion: 'Consider another PPI (pantoprazole) if gastroprotection is needed.',
    },
  },
  interactionSummary: (drugs) => `Risky combination: ${drugs.join(' + ')}`,
  drugConditions: {
    metformin_egfr_30: {
      risk: 'Metformin with a GFR below 30: contraindicated (risk of lactic acidosis).',
      suggestion: 'Consider stopping metformin and reassessing the diabetes treatment.',
    },
    metformin_egfr_45: {
      risk: 'Metformin with a GFR below 45: the dose needs adjusting.',
      suggestion:
        'Consider reviewing the metformin dose (at most 1,000 mg/day) and renal function.',
    },
    nsaid_egfr_60: {
      risk: 'NSAID with reduced renal function (GFR below 60).',
      suggestion: 'Consider avoiding the NSAID or using the lowest dose for the shortest time.',
    },
    nsaid_heart_failure: {
      risk: 'NSAID with heart failure: fluid retention and decompensation.',
      suggestion: 'Consider stopping the NSAID and using another analgesic.',
    },
    nonselective_beta_blocker_asthma: {
      risk: 'Non-selective beta blocker with asthma: risk of bronchospasm.',
      suggestion: 'Consider a cardioselective beta blocker or another option.',
    },
    thiazide_gout: {
      risk: 'Thiazide with gout: raises uric acid and can trigger flares.',
      suggestion: 'Consider another antihypertensive if flares recur.',
    },
  },
  conditionNames: {
    nsaid_heart_failure: 'heart failure',
    nonselective_beta_blocker_asthma: 'asthma',
    thiazide_gout: 'gout',
  },
  egfr: (value, estimated) =>
    estimated
      ? `an estimated GFR of ${String(value)} mL/min/1.73m² (CKD-EPI 2021, from creatinine)`
      : `a GFR of ${String(value)} mL/min/1.73m²`,
  diagnosisOf: (condition) => `a diagnosis of ${condition}`,
  drugConditionSummary: (drug, because) => `${drug} with ${because}`,
  symptoms: {
    headache: {
      label: 'headache',
      workup: 'a focused headache assessment (red flags, blood pressure)',
    },
    dizziness: {
      label: 'dizziness',
      workup: 'an assessment of the dizziness (blood pressure, glucose, medication)',
    },
    chest_pain: {
      label: 'chest pain',
      workup: 'ruling out a cardiovascular cause (ECG, cardiology review)',
    },
    dyspnea: {
      label: 'shortness of breath',
      workup: 'an assessment of the dyspnea (cardiopulmonary exam, oxygen saturation)',
    },
    paresthesia: {
      label: 'paresthesias',
      workup: 'a neurological assessment (neuropathy, B12, glycemic control)',
    },
    palpitations: { label: 'palpitations', workup: 'an ECG and a heart rhythm assessment' },
    edema: {
      label: 'edema',
      workup: 'an assessment of the edema (renal and cardiac function, medication)',
    },
    weight_loss: { label: 'unintended weight loss', workup: 'an assessment of the weight loss' },
    fatigue: {
      label: 'tiredness',
      workup: 'an assessment of the tiredness (blood count, TSH, glucose)',
    },
  },
  symptomFinding: (a) => ({
    summary: `${capitalize(a.label)} mentioned in ${String(a.count)} visits without a workup`,
    rationale: `It appears in ${String(a.count)} notes of the last year${a.specialties.length > 1 ? ` (${a.specialties.join(', ')})` : ''} and none records a test or a referral for it.`,
    suggestion: `Consider ${a.workup}.`,
  }),
  screenings: {
    diabetic_fundus: {
      label: 'fundus exam',
      suggestion: 'Consider ordering a fundus exam (annual diabetic retinopathy screening).',
    },
    diabetic_foot: {
      label: 'foot exam',
      suggestion: 'Consider examining the feet at the next visit (monofilament, pulses).',
    },
    diabetic_albuminuria: {
      label: 'albuminuria test',
      suggestion: 'Consider ordering a urine albumin/creatinine ratio (annual screening).',
    },
  },
  screeningFinding: (label, months, suggestion) => ({
    summary: `Patient with diabetes with no ${label} recorded in the last year`,
    rationale: `No note, order or result of a ${label} in the last ${String(months)} months.`,
    suggestion,
  }),
  allergies: (notes, medications) => ({
    summary: 'Allergies not recorded for a patient with active prescriptions',
    rationale: `None of the ${String(notes)} notes records the allergy status, and ${String(medications)} medication(s) are active.`,
    suggestion: 'Consider recording allergies (or "no known allergies") at the next visit.',
  }),
  uncodedDiagnosis: (display) => ({
    summary: `Diagnosis written in a note but not coded (${display})`,
    rationale: 'The diagnosis appears in the text of the note but no coded diagnosis records it.',
    suggestion: 'Consider coding the diagnosis (ICD-10) in the record.',
  }),
  utilization: (recent, perQuarter) => ({
    summary: `${String(recent)} visits in the last 90 days (about ${String(perQuarter)} per quarter before)`,
    rationale:
      'The patient comes in far more often than in their own pattern of the previous year.',
    suggestion: 'Consider whether an unresolved underlying problem is behind the repeated visits.',
  }),
  questions: {
    diabetic_neuropathy: {
      question: 'Ask whether they have noticed tingling, burning or numbness in the feet.',
      rationale:
        'Patient with diabetes with no recent record of peripheral neuropathy symptoms in the notes.',
    },
    statin_myalgia: {
      question: 'Ask whether they have muscle pain or weakness since starting the statin.',
      rationale: 'Patient on a statin with no record of muscle tolerance in the last year.',
    },
    ace_cough: {
      question: 'Ask whether they have a persistent dry cough since starting the ACE inhibitor.',
      rationale:
        'Patient on an ACE inhibitor with no record of tolerance (cough) in the last year.',
    },
  },
  questionSuggestion: 'Bring it up at the next visit; nothing needs doing before.',
};

const ES: ReviewerCopy = {
  measurements: {
    creatinine: 'Creatinina',
    egfr: 'Filtrado glomerular estimado',
    hba1c: 'HbA1c',
    glucose: 'Glucosa en ayunas',
    ldl: 'Colesterol LDL',
    potassium: 'Potasio',
    hemoglobin: 'Hemoglobina',
    uacr: 'Cociente albúmina/creatinina en orina',
    systolic_bp: 'Presión arterial sistólica',
    diastolic_bp: 'Presión arterial diastólica',
    weight: 'Peso',
  },
  specialty: (key) =>
    ({
      diabetology: 'diabetología',
      internal_medicine: 'medicina interna',
      psychology: 'psicología',
      gynecology: 'ginecología',
      cardiology: 'cardiología',
      ophthalmology: 'oftalmología',
    })[key] ?? key.replace(/_/g, ' '),
  noteTitle: (specialty) => (specialty === undefined ? 'Nota clínica' : `Nota de ${specialty}`),
  labTrend: (a) => ({
    summary: `${a.label} ${a.rising ? 'en ascenso' : 'en descenso'} en los últimos ${String(a.count)} resultados (${a.series} ${a.unit}) sin comentario en las notas`,
    rationale: `${String(a.count)} resultados seguidos empeoran (${signed(a.changePct)} % entre el ${a.from} y el ${a.to})${a.outOfRange ? ', el último fuera de rango' : ''}, y ninguna nota posterior lo menciona.`,
    suggestion: a.renal
      ? 'Considera evaluar la función renal y revisar los fármacos que dependen de ella (metformina, AINE).'
      : `Considera revisar ${a.label.toLowerCase()} y el tratamiento en la próxima consulta.`,
  }),
  vitalTrend: (a) => ({
    summary:
      a.kind === 'weight'
        ? `Peso ${a.delta > 0 ? 'en aumento' : 'en descenso'} sostenido (${a.values} kg, ${signed(a.changePct)} %)`
        : `Presión arterial sistólica en ascenso en ${String(a.count)} controles (${a.values} mmHg)`,
    rationale: `${String(a.count)} mediciones seguidas en la misma dirección entre el ${a.from} y el ${a.to}.`,
    suggestion:
      a.kind === 'weight'
        ? 'Considera explorar la causa del cambio de peso (dieta, medicación, enfermedad intercurrente).'
        : 'Considera confirmar las cifras (MAPA o automedida) y revisar el tratamiento antihipertensivo.',
  }),
  abnormalResult: (a) => ({
    summary: `${a.label} de ${a.value} ${a.unit} sin consulta ni comentario posterior`,
    rationale: `Resultado del ${a.date} ${a.high ? 'muy por encima' : 'muy por debajo'} del rango (${a.high ? `objetivo < ${a.threshold}` : `> ${a.threshold}`} ${a.unit}); hace ${String(a.days)} días y no hay visita, cita próxima ni nota que lo comente.`,
    suggestion: 'Considera contactar al paciente para revisar el resultado y ajustar el plan.',
  }),
  interactions: {
    nsaid_raas_diuretic: {
      risk: 'AINE junto con IECA/ARA-II y diurético ("triple whammy"): riesgo de lesión renal aguda.',
      suggestion:
        'Considera revisar la necesidad del AINE y controlar la función renal (creatinina, potasio).',
    },
    vka_nsaid: {
      risk: 'Anticoagulante antivitamina K con AINE: riesgo aumentado de sangrado.',
      suggestion: 'Considera evitar el AINE o vigilar el INR y signos de sangrado.',
    },
    ssri_tramadol: {
      risk: 'ISRS con tramadol: riesgo de síndrome serotoninérgico y de convulsiones.',
      suggestion: 'Considera otra analgesia o vigilar síntomas serotoninérgicos.',
    },
    nsaid_raas: {
      risk: 'AINE con IECA/ARA-II: reduce el efecto antihipertensivo y puede deteriorar la función renal.',
      suggestion:
        'Considera revisar la necesidad del AINE y controlar presión arterial y creatinina.',
    },
    raas_potassium_sparing: {
      risk: 'IECA/ARA-II con ahorrador de potasio: riesgo de hiperpotasemia.',
      suggestion: 'Considera controlar el potasio sérico.',
    },
    ssri_nsaid: {
      risk: 'ISRS con AINE: riesgo aumentado de sangrado digestivo.',
      suggestion: 'Considera gastroprotección o revisar la necesidad del AINE.',
    },
    doac_nsaid: {
      risk: 'Anticoagulante oral directo con AINE: riesgo aumentado de sangrado.',
      suggestion: 'Considera evitar el AINE o vigilar signos de sangrado.',
    },
    clopidogrel_omeprazole: {
      risk: 'Clopidogrel con omeprazol/esomeprazol: puede reducir el efecto antiagregante.',
      suggestion: 'Considera un IBP alternativo (pantoprazol) si la gastroprotección es necesaria.',
    },
  },
  interactionSummary: (drugs) => `Combinación de riesgo: ${drugs.join(' + ')}`,
  drugConditions: {
    metformin_egfr_30: {
      risk: 'Metformina con filtrado glomerular menor de 30: contraindicada por riesgo de acidosis láctica.',
      suggestion: 'Considera suspender la metformina y reevaluar el tratamiento de la diabetes.',
    },
    metformin_egfr_45: {
      risk: 'Metformina con filtrado glomerular menor de 45: requiere ajuste de dosis.',
      suggestion:
        'Considera revisar la dosis de metformina (máximo 1000 mg/día) y la función renal.',
    },
    nsaid_egfr_60: {
      risk: 'AINE con función renal disminuida (filtrado menor de 60).',
      suggestion: 'Considera evitar el AINE o usar la menor dosis por el menor tiempo.',
    },
    nsaid_heart_failure: {
      risk: 'AINE con insuficiencia cardíaca: retención de líquidos y descompensación.',
      suggestion: 'Considera suspender el AINE y usar otra analgesia.',
    },
    nonselective_beta_blocker_asthma: {
      risk: 'Betabloqueante no selectivo con asma: riesgo de broncoespasmo.',
      suggestion: 'Considera un betabloqueante cardioselectivo u otra alternativa.',
    },
    thiazide_gout: {
      risk: 'Tiazida con gota: eleva el ácido úrico y puede precipitar crisis.',
      suggestion: 'Considera otra alternativa antihipertensiva si las crisis se repiten.',
    },
  },
  conditionNames: {
    nsaid_heart_failure: 'insuficiencia cardíaca',
    nonselective_beta_blocker_asthma: 'asma',
    thiazide_gout: 'gota',
  },
  egfr: (value, estimated) =>
    estimated
      ? `filtrado estimado de ${String(value)} mL/min/1.73m² (CKD-EPI 2021, desde la creatinina)`
      : `filtrado glomerular de ${String(value)} mL/min/1.73m²`,
  diagnosisOf: (condition) => `diagnóstico de ${condition}`,
  drugConditionSummary: (drug, because) => `${drug} con ${because}`,
  symptoms: {
    headache: {
      label: 'cefalea',
      workup: 'una evaluación dirigida de la cefalea (signos de alarma, presión arterial)',
    },
    dizziness: {
      label: 'mareo',
      workup: 'una evaluación del mareo (presión arterial, glucemia, medicación)',
    },
    chest_pain: {
      label: 'dolor torácico',
      workup: 'descartar causa cardiovascular (ECG, evaluación cardiológica)',
    },
    dyspnea: {
      label: 'disnea',
      workup: 'una evaluación de la disnea (examen cardiopulmonar, saturación)',
    },
    paresthesia: {
      label: 'parestesias',
      workup: 'una evaluación neurológica (neuropatía, B12, control glucémico)',
    },
    palpitations: { label: 'palpitaciones', workup: 'un ECG y una evaluación del ritmo cardíaco' },
    edema: {
      label: 'edema',
      workup: 'una evaluación del edema (función renal, cardíaca y medicación)',
    },
    weight_loss: {
      label: 'pérdida de peso no buscada',
      workup: 'una evaluación de la pérdida de peso',
    },
    fatigue: {
      label: 'cansancio',
      workup: 'una evaluación del cansancio (hemograma, TSH, glucemia)',
    },
  },
  symptomFinding: (a) => ({
    summary: `${capitalize(a.label)} mencionado en ${String(a.count)} consultas sin estudio`,
    rationale: `Aparece en ${String(a.count)} notas del último año${a.specialties.length > 1 ? ` (${a.specialties.join(', ')})` : ''} y ninguna registra un estudio o una derivación por ese síntoma.`,
    suggestion: `Considera ${a.workup}.`,
  }),
  screenings: {
    diabetic_fundus: {
      label: 'fondo de ojo',
      suggestion: 'Considera solicitar fondo de ojo (cribado anual de retinopatía diabética).',
    },
    diabetic_foot: {
      label: 'examen de pies',
      suggestion: 'Considera examinar los pies en la próxima consulta (monofilamento, pulsos).',
    },
    diabetic_albuminuria: {
      label: 'albuminuria',
      suggestion: 'Considera solicitar el cociente albúmina/creatinina en orina (cribado anual).',
    },
  },
  screeningFinding: (label, months, suggestion) => ({
    summary: `Paciente con diabetes sin ${label} registrado en el último año`,
    rationale: `No hay nota, orden ni resultado de ${label} en los últimos ${String(months)} meses.`,
    suggestion,
  }),
  allergies: (notes, medications) => ({
    summary: 'Alergias no registradas en un paciente con prescripciones activas',
    rationale: `Ninguna de las ${String(notes)} notas registra el estado de alergias, y hay ${String(medications)} medicamento(s) activo(s).`,
    suggestion:
      'Considera registrar las alergias (o "sin alergias conocidas") en la próxima consulta.',
  }),
  uncodedDiagnosis: (display) => ({
    summary: `Diagnóstico escrito en la nota pero no codificado (${display})`,
    rationale:
      'El diagnóstico aparece en el texto de la nota pero no hay un diagnóstico codificado que lo registre.',
    suggestion: 'Considera codificar el diagnóstico (CIE-10) en la historia.',
  }),
  utilization: (recent, perQuarter) => ({
    summary: `${String(recent)} consultas en los últimos 90 días (antes, unas ${String(perQuarter)} por trimestre)`,
    rationale: 'El paciente consulta mucho más seguido que en su patrón del año anterior.',
    suggestion:
      'Considera revisar si hay un problema de fondo sin resolver detrás de las consultas repetidas.',
  }),
  questions: {
    diabetic_neuropathy: {
      question: 'Pregunta si ha notado hormigueo, ardor o adormecimiento en los pies.',
      rationale:
        'Paciente con diabetes sin registro reciente de síntomas de neuropatía periférica en las notas.',
    },
    statin_myalgia: {
      question: 'Pregunta si tiene dolor o debilidad muscular desde que toma la estatina.',
      rationale: 'Paciente con estatina sin registro de tolerancia muscular en el último año.',
    },
    ace_cough: {
      question: 'Pregunta si tiene tos seca persistente desde que toma el IECA.',
      rationale: 'Paciente con IECA sin registro de tolerancia (tos) en el último año.',
    },
  },
  questionSuggestion: 'Inclúyela en la próxima consulta; no requiere acción antes.',
};

function capitalize(text: string): string {
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

export const REVIEWER_COPY: Readonly<Record<ReviewLocale, ReviewerCopy>> = { en: EN, es: ES };

/** The copy of a locale (unknown locales fall back to the default). */
export function reviewerCopy(locale: string | undefined): ReviewerCopy {
  return REVIEWER_COPY[
    (REVIEW_LOCALES as readonly string[]).includes(locale ?? '')
      ? (locale as ReviewLocale)
      : DEFAULT_REVIEW_LOCALE
  ];
}
