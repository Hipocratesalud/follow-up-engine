import { foldText } from '../support/text.ts';

/**
 * The clinical reviewer's curated knowledge (terminology and rules only: the
 * words shown to the clinic live in `copy.ts`, per locale): which measurements it trends,
 * which drug combinations and drug-condition pairs it flags, which symptoms
 * it tracks across notes and which check-ups it expects. Deliberately small
 * and explicit (a table a clinician can read and correct), not a drug
 * database: the model may add findings beyond it, the code never invents.
 * Terminology facts (LOINC, ATC, ICD-10), not dosing advice.
 */

export const LOINC = 'http://loinc.org';

/** A measurement the reviewer trends. Values are compared in `unit`. */
export interface MeasurementDefinition {
  readonly key: string;
  /** Folded words that name it, in Spanish and English (the `get_lab_trend` tool's lookup). */
  readonly names: readonly string[];
  readonly kind: 'lab' | 'vital';
  readonly loinc: readonly string[];
  readonly unit: string;
  /** Other units the value may arrive in, with `canonical = factor * value + offset`. */
  readonly conversions?: readonly {
    readonly unit: string;
    readonly factor: number;
    readonly offset: number;
  }[];
  readonly low?: number;
  readonly high?: number;
  /** Which way is worse. `either`: a steady change in any direction (weight). */
  readonly worseWhen: 'up' | 'down' | 'either';
  /** Smallest relative change (%) over the trend that counts as a trend. */
  readonly minChangePct: number;
  /**
   * Words a note uses when the doctor comments on it (a commented trend is not
   * silent), whole words, abbreviations included: "RAC 222 mg/g", "Cr 1.4",
   * "K+ 5.2", "TFGe 48", "Hb glicosilada 8 %".
   */
  readonly mentions: readonly string[];
  readonly decimals: number;
  /**
   * A trend that never leaves the reference range is at most `low`. With a
   * margin, it is not reported at all unless its latest value comes within
   * the margin of the limit (potassium 3.9 → 4.8 is noise, 4.1 → 5.0 is not).
   */
  readonly inRangeMargin?: number;
}

export const MEASUREMENTS: readonly MeasurementDefinition[] = [
  {
    key: 'creatinine',
    names: ['creatinina', 'creatinine'],
    kind: 'lab',
    loinc: ['2160-0', '38483-4', '14682-9'],
    unit: 'mg/dL',
    conversions: [{ unit: 'umol/L', factor: 1 / 88.42, offset: 0 }],
    low: 0.5,
    high: 1.2,
    worseWhen: 'up',
    minChangePct: 15,
    mentions: [
      'creatinina',
      'creatininemia',
      'creat',
      'cr',
      'funcion renal',
      'tfg',
      'tfge',
      'egfr',
      'filtrado',
      'nefropatia',
      'erc',
      'renal',
    ],
    decimals: 2,
  },
  {
    key: 'egfr',
    names: ['filtrado glomerular', 'egfr', 'tfg', 'glomerular filtration'],
    kind: 'lab',
    loinc: ['33914-3', '62238-1', '48642-3', '48643-1', '98979-8', '69405-9'],
    unit: 'mL/min/1.73m2',
    low: 60,
    worseWhen: 'down',
    minChangePct: 15,
    mentions: [
      'filtrado',
      'tfg',
      'tfge',
      'egfr',
      'gfr',
      'fge',
      'ckd-epi',
      'funcion renal',
      'erc',
      'renal',
      'creatinina',
      'cr',
    ],
    decimals: 0,
  },
  {
    key: 'hba1c',
    names: ['hba1c', 'a1c', 'hemoglobina glicosilada', 'glycated hemoglobin'],
    kind: 'lab',
    loinc: ['4548-4', '17856-6', '4549-2', '62388-4', '59261-8'],
    unit: '%',
    conversions: [{ unit: 'mmol/mol', factor: 0.0915, offset: 2.15 }],
    high: 7,
    worseWhen: 'up',
    minChangePct: 10,
    mentions: [
      'hba1c',
      'hgba1c',
      'hemoglobina glicosilada',
      'hemoglobina glucosilada',
      'hemoglobina glicada',
      'hb glicosilada',
      'hb glucosilada',
      'glicohemoglobina',
      'a1c',
      'control glucemico',
    ],
    decimals: 1,
  },
  {
    key: 'glucose',
    names: ['glucosa', 'glucose', 'glicemia'],
    kind: 'lab',
    loinc: ['1558-6', '2345-7', '2339-0'],
    unit: 'mg/dL',
    low: 70,
    high: 126,
    worseWhen: 'up',
    minChangePct: 15,
    mentions: ['glucosa', 'glicemia', 'glucemia'],
    decimals: 0,
  },
  {
    key: 'ldl',
    names: ['ldl', 'colesterol ldl', 'ldl cholesterol'],
    kind: 'lab',
    loinc: ['13457-7', '18262-6', '2089-1'],
    unit: 'mg/dL',
    high: 130,
    worseWhen: 'up',
    minChangePct: 15,
    mentions: ['ldl', 'colesterol', 'perfil lipidico', 'dislipidemia'],
    decimals: 0,
  },
  {
    key: 'potassium',
    names: ['potasio', 'potassium'],
    kind: 'lab',
    loinc: ['2823-3', '6298-4'],
    unit: 'mmol/L',
    low: 3.5,
    high: 5.1,
    worseWhen: 'up',
    minChangePct: 10,
    mentions: ['potasio', 'kalemia', 'kaliemia', 'hiperkalemia', 'hiperpotasemia', 'k+', 'k'],
    decimals: 1,
    inRangeMargin: 0.2,
  },
  {
    key: 'hemoglobin',
    names: ['hemoglobina', 'hemoglobin'],
    kind: 'lab',
    loinc: ['718-7'],
    unit: 'g/dL',
    low: 12,
    high: 17.5,
    worseWhen: 'down',
    minChangePct: 10,
    mentions: ['hemoglobina', 'anemia', 'hb ', 'hgb'],
    decimals: 1,
  },
  {
    key: 'uacr',
    names: ['albuminuria', 'microalbuminuria', 'uacr', 'rac', 'acr'],
    kind: 'lab',
    loinc: ['9318-7', '14959-1', '14958-3'],
    unit: 'mg/g',
    high: 30,
    worseWhen: 'up',
    minChangePct: 25,
    mentions: [
      'albuminuria',
      'microalbuminuria',
      'microalb',
      'proteinuria',
      'rac',
      'acr',
      'uacr',
      'albumina/creatinina',
      'relacion albumina/creatinina',
      'cociente albumina/creatinina',
      'indice albumina/creatinina',
    ],
    decimals: 0,
  },
  {
    key: 'systolic_bp',
    names: ['presion arterial sistolica', 'systolic', 'sistolica'],
    kind: 'vital',
    loinc: ['8480-6'],
    unit: 'mmHg',
    high: 140,
    worseWhen: 'up',
    minChangePct: 8,
    mentions: ['presion arterial', 'tension arterial', 'hipertension', 'hta', ' ta ', 'pa '],
    decimals: 0,
  },
  {
    key: 'diastolic_bp',
    names: ['presion arterial diastolica', 'diastolic', 'diastolica'],
    kind: 'vital',
    loinc: ['8462-4'],
    unit: 'mmHg',
    high: 90,
    worseWhen: 'up',
    minChangePct: 8,
    mentions: ['presion arterial', 'tension arterial', 'hipertension', 'hta'],
    decimals: 0,
  },
  {
    key: 'weight',
    names: ['peso', 'weight'],
    kind: 'vital',
    loinc: ['29463-7', '3141-9'],
    unit: 'kg',
    worseWhen: 'either',
    minChangePct: 5,
    mentions: ['peso', 'adelgaz', 'perdida de peso', 'ganancia de peso', 'aumento de peso', 'imc'],
    decimals: 1,
  },
];

/** LOINC of a blood pressure panel; its systolic and diastolic come as components. */
export const BLOOD_PRESSURE_PANEL_LOINC = ['85354-9', '55284-4', '35094-2'];

/** The measurement a LOINC code reports, if the reviewer trends it. */
export function measurementOfLoinc(code: string): MeasurementDefinition | undefined {
  return MEASUREMENTS.find((measurement) => measurement.loinc.includes(code));
}

/** The measurement named by a key, a label or a LOINC code ("creatinina", "egfr", "2160-0"). */
export function findMeasurement(name: string): MeasurementDefinition | undefined {
  const folded = foldText(name).trim();
  return (
    MEASUREMENTS.find((measurement) => measurement.key === folded) ??
    MEASUREMENTS.find((measurement) => measurement.loinc.includes(folded)) ??
    MEASUREMENTS.find((measurement) => measurement.names.includes(folded)) ??
    MEASUREMENTS.find(
      (measurement) =>
        folded.length >= 3 && measurement.names.some((word) => word.startsWith(folded)),
    ) ??
    MEASUREMENTS.find((measurement) => measurement.mentions.some((word) => folded === word.trim()))
  );
}

/** `value` in the measurement's unit, or `undefined` when its unit cannot be converted. */
export function toMeasurementUnit(
  measurement: MeasurementDefinition,
  value: number,
  unit: string | undefined,
): number | undefined {
  if (unit === undefined || normalizeUnit(unit) === normalizeUnit(measurement.unit)) {
    return value;
  }
  const conversion = measurement.conversions?.find(
    (candidate) => normalizeUnit(candidate.unit) === normalizeUnit(unit),
  );
  return conversion === undefined ? undefined : conversion.factor * value + conversion.offset;
}

function normalizeUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/µ/g, 'u')
    .replace(/\s+hb$/, '')
    .replace(/[\s{}]/g, '');
}

// Drug classes ----------------------------------------------------------------

/** A drug class by ATC prefix. */
export interface DrugClass {
  readonly key: string;
  /** Folded words that name the class itself, in Spanish and English ("aine", "nsaid"). */
  readonly names: readonly string[];
  readonly atcPrefixes: readonly string[];
}

export const DRUG_CLASSES: readonly DrugClass[] = [
  { key: 'nsaid', names: ['aine', 'nsaid'], atcPrefixes: ['M01A'] },
  { key: 'ace_inhibitor', names: ['ieca', 'ace inhibitor'], atcPrefixes: ['C09A', 'C09B'] },
  { key: 'arb', names: ['ara-ii', 'ara ii', 'arb'], atcPrefixes: ['C09C', 'C09D'] },
  { key: 'diuretic', names: ['diuretico', 'diuretic'], atcPrefixes: ['C03'] },
  {
    key: 'potassium_sparing',
    names: ['ahorrador de potasio', 'potassium-sparing'],
    atcPrefixes: ['C03DA'],
  },
  {
    key: 'vitamin_k_antagonist',
    names: ['antivitamina k', 'vitamin k antagonist'],
    atcPrefixes: ['B01AA'],
  },
  { key: 'doac', names: ['anticoagulante oral directo', 'doac'], atcPrefixes: ['B01AE', 'B01AF'] },
  { key: 'ssri', names: ['isrs', 'ssri'], atcPrefixes: ['N06AB'] },
  { key: 'tramadol', names: ['tramadol'], atcPrefixes: ['N02AX02'] },
  { key: 'metformin', names: ['metformina', 'metformin'], atcPrefixes: ['A10BA02'] },
  { key: 'clopidogrel', names: ['clopidogrel'], atcPrefixes: ['B01AC04'] },
  { key: 'omeprazole', names: ['omeprazol', 'omeprazole'], atcPrefixes: ['A02BC01', 'A02BC05'] },
  {
    key: 'nonselective_beta_blocker',
    names: ['betabloqueante no selectivo', 'non-selective beta blocker'],
    atcPrefixes: ['C07AA'],
  },
  { key: 'thiazide', names: ['tiazida', 'thiazide'], atcPrefixes: ['C03A', 'C03EA'] },
  { key: 'statin', names: ['estatina', 'statin'], atcPrefixes: ['C10AA'] },
  { key: 'sglt2', names: ['isglt2', 'sglt2 inhibitor'], atcPrefixes: ['A10BK'] },
];

export function drugClassesOf(atc: string | undefined): DrugClass[] {
  if (atc === undefined) return [];
  return DRUG_CLASSES.filter((drugClass) =>
    drugClass.atcPrefixes.some((prefix) => atc.startsWith(prefix)),
  );
}

/** A combination the reviewer flags. Every class listed must be present. */
export interface InteractionRule {
  readonly key: string;
  readonly classes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

/**
 * Curated, small and conservative: combinations every prescriber guide
 * flags. Ordered most specific first (the triple combination wins over its
 * pairs).
 */
export const INTERACTION_RULES: readonly InteractionRule[] = [
  {
    key: 'nsaid_raas_diuretic',
    classes: ['nsaid', 'raas', 'diuretic'],
    severity: 'high',
  },
  {
    key: 'vka_nsaid',
    classes: ['vitamin_k_antagonist', 'nsaid'],
    severity: 'high',
  },
  {
    key: 'ssri_tramadol',
    classes: ['ssri', 'tramadol'],
    severity: 'high',
  },
  {
    key: 'nsaid_raas',
    classes: ['nsaid', 'raas'],
    severity: 'medium',
  },
  {
    key: 'raas_potassium_sparing',
    classes: ['raas', 'potassium_sparing'],
    severity: 'medium',
  },
  {
    key: 'ssri_nsaid',
    classes: ['ssri', 'nsaid'],
    severity: 'medium',
  },
  {
    key: 'doac_nsaid',
    classes: ['doac', 'nsaid'],
    severity: 'high',
  },
  {
    key: 'clopidogrel_omeprazole',
    classes: ['clopidogrel', 'omeprazole'],
    severity: 'low',
  },
];

/** `raas` is either an ACE inhibitor or an ARB. */
export function classKeysOf(atc: string | undefined): Set<string> {
  const keys = new Set(drugClassesOf(atc).map((drugClass) => drugClass.key));
  if (keys.has('ace_inhibitor') || keys.has('arb')) keys.add('raas');
  return keys;
}

// Drug-condition conflicts ------------------------------------------------------

/** What makes a drug a concern for this patient. */
export type ConflictTrigger =
  | { readonly kind: 'egfr_below'; readonly threshold: number }
  | { readonly kind: 'condition'; readonly icd10Prefixes: readonly string[] };

export interface DrugConditionRule {
  readonly key: string;
  readonly drugClass: string;
  readonly trigger: ConflictTrigger;
  readonly severity: 'low' | 'medium' | 'high';
}

/** Ordered most severe first: the first rule that applies to a drug wins. */
export const DRUG_CONDITION_RULES: readonly DrugConditionRule[] = [
  {
    key: 'metformin_egfr_30',
    drugClass: 'metformin',
    trigger: { kind: 'egfr_below', threshold: 30 },
    severity: 'high',
  },
  {
    key: 'metformin_egfr_45',
    drugClass: 'metformin',
    trigger: { kind: 'egfr_below', threshold: 45 },
    severity: 'medium',
  },
  {
    key: 'nsaid_egfr_60',
    drugClass: 'nsaid',
    trigger: { kind: 'egfr_below', threshold: 60 },
    severity: 'medium',
  },
  {
    key: 'nsaid_heart_failure',
    drugClass: 'nsaid',
    trigger: { kind: 'condition', icd10Prefixes: ['I50'] },
    severity: 'high',
  },
  {
    key: 'nonselective_beta_blocker_asthma',
    drugClass: 'nonselective_beta_blocker',
    trigger: { kind: 'condition', icd10Prefixes: ['J45', 'J46'] },
    severity: 'high',
  },
  {
    key: 'thiazide_gout',
    drugClass: 'thiazide',
    trigger: { kind: 'condition', icd10Prefixes: ['M10', 'M1A'] },
    severity: 'low',
  },
];

// Symptoms ----------------------------------------------------------------------

export interface SymptomDefinition {
  readonly key: string;
  /** Folded (no accents, lowercase) phrases that name it in a note, Spanish and English. */
  readonly terms: readonly string[];
}

export const SYMPTOMS: readonly SymptomDefinition[] = [
  {
    key: 'headache',
    terms: ['cefalea', 'dolor de cabeza', 'cefaleas', 'headache', 'headaches'],
  },
  {
    key: 'dizziness',
    terms: ['mareo', 'mareos', 'vertigo', 'vertigos', 'dizziness', 'dizzy'],
  },
  {
    key: 'chest_pain',
    terms: [
      'dolor toracico',
      'dolor en el pecho',
      'opresion toracica',
      'dolor precordial',
      'chest pain',
    ],
  },
  {
    key: 'dyspnea',
    terms: [
      'disnea',
      'falta de aire',
      'dificultad para respirar',
      'ahogo',
      'dyspnea',
      'shortness of breath',
    ],
  },
  {
    key: 'paresthesia',
    terms: [
      'parestesia',
      'parestesias',
      'hormigueo',
      'adormecimiento',
      'entumecimiento',
      'tingling',
      'numbness',
    ],
  },
  {
    key: 'palpitations',
    terms: ['palpitaciones', 'taquicardia', 'palpitations'],
  },
  {
    key: 'edema',
    terms: [
      'edema',
      'hinchazon de piernas',
      'hinchazon de tobillos',
      'piernas hinchadas',
      'swollen ankles',
    ],
  },
  {
    key: 'weight_loss',
    terms: ['perdida de peso', 'baja de peso', 'adelgazamiento', 'weight loss'],
  },
  {
    key: 'fatigue',
    terms: ['cansancio', 'fatiga', 'astenia', 'fatigue', 'tiredness'],
  },
];

/**
 * Red flags that make a recurring symptom urgent (`high`), named in the
 * finding. Read only in the sentence that mentions the symptom, and never
 * when denied ("sin déficit neurológico").
 */
export interface RedFlag {
  readonly key: string;
  /** Folded phrases, Spanish and English. */
  readonly terms: readonly string[];
}

export const SYMPTOM_RED_FLAGS: Readonly<Record<string, readonly RedFlag[]>> = {
  headache: [
    {
      key: 'nocturnal_awakening',
      terms: [
        'la despierta',
        'lo despierta',
        'le despierta',
        'despierta en la noche',
        'despertar nocturno',
        'nocturna',
        'wakes her',
        'wakes him',
        'wakes the patient',
        'at night',
      ],
    },
    {
      key: 'worst_headache',
      terms: [
        'peor de su vida',
        'peor cefalea',
        'peor dolor de cabeza',
        'en trueno',
        'subita',
        'subito',
        'de inicio brusco',
        'worst headache',
        'thunderclap',
        'sudden onset',
      ],
    },
    {
      key: 'neurological_deficit',
      terms: [
        'deficit neurologico',
        'focalidad',
        'focal',
        'debilidad en',
        'hemiparesia',
        'paresia',
        'diplopia',
        'disartria',
        'afasia',
        'perdida de vision',
        'convulsion',
        'neurological deficit',
        'weakness in',
        'slurred speech',
      ],
    },
  ],
};

/** Words of a note that record a poor appetite (a red flag of a weight loss). */
export const POOR_APPETITE_TERMS = [
  'menos apetito',
  'poco apetito',
  'falta de apetito',
  'perdida de apetito',
  'perdida del apetito',
  'disminucion del apetito',
  'hiporexia',
  'anorexia',
  'inapetencia',
  'sin apetito',
  'poor appetite',
  'loss of appetite',
  'decreased appetite',
];

/** Words of a note that make a weight loss intended (a diet, a weight-loss drug, surgery). */
export const INTENDED_WEIGHT_LOSS_TERMS = [
  'bajar de peso',
  'perder peso',
  'reducir peso',
  'reduccion de peso',
  'dieta hipocalorica',
  'plan de adelgazamiento',
  'cirugia bariatrica',
  'manga gastrica',
  'bypass gastrico',
  'semaglutid',
  'liraglutid',
  'tirzepatid',
  'lose weight',
  'weight loss program',
];

/** ATC prefixes of weight-loss drugs (GLP-1 receptor agonists, antiobesity agents). */
export const WEIGHT_LOSS_DRUG_ATC = ['A10BJ', 'A08'];

/** A steady weight loss at least this large (%) over 12 months is a red flag. */
export const WEIGHT_LOSS_RED_FLAG_PCT = 5;
/** A loss this large (%) is a red flag on its own. */
export const WEIGHT_LOSS_SEVERE_PCT = 10;
/** From this age a 5 % unintentional loss is a red flag on its own. */
export const WEIGHT_LOSS_OLDER_AGE = 65;

/** ATC prefixes of antihypertensive drugs (a treatment change for uncontrolled pressure). */
export const ANTIHYPERTENSIVE_ATC = ['C02', 'C03', 'C07', 'C08', 'C09'];

/** Office blood pressure at or above this (systolic or diastolic) is not controlled. */
export const UNCONTROLLED_BP = { systolic: 140, diastolic: 90 } as const;
/** At or above this it is severe (`high`). */
export const SEVERE_BP = { systolic: 160, diastolic: 100 } as const;

/** Words that, right before a symptom, deny it ("niega cefalea", "sin disnea"). */
export const NEGATIONS = [
  'niega',
  'sin',
  'no refiere',
  'no presenta',
  'no hay',
  'ausencia de',
  'no',
  'descarta',
  'nunca',
  'denies',
  'without',
  'negative for',
];

/** Words that, in the same note, show the symptom is being worked up or referred. */
export const WORKUP_TERMS = [
  'se solicita',
  'solicito',
  'interconsulta',
  'referimos',
  'se refiere',
  'refiero',
  'derivo',
  'se deriva',
  'tac',
  'tomografia',
  'resonancia',
  'electrocardiograma',
  'ecg',
  'holter',
  'ecocardiograma',
  'estudio de',
  'ordered',
  'referred',
  'referral',
  'mri',
  'ct scan',
  'echocardiogram',
];

// Check-ups ----------------------------------------------------------------------

export interface ScreeningRule {
  readonly key: string;
  /** ICD-10 prefixes of the conditions it applies to. */
  readonly icd10Prefixes: readonly string[];
  /** Folded phrases in a note that show it was done or asked for. */
  readonly evidenceTerms: readonly string[];
  /** Result LOINC codes that show it was done. */
  readonly resultLoinc?: readonly string[];
  /** Protocol rule ids whose live expectation already asks for it. */
  readonly coveredByRules: readonly string[];
  readonly everyDays: number;
  readonly severity: 'low' | 'medium';
  /** Folded words of any language that name the check-up in a finding's text (coverage of added findings). */
  readonly coverageTerms: readonly string[];
}

export const SCREENING_RULES: readonly ScreeningRule[] = [
  {
    key: 'diabetic_fundus',
    icd10Prefixes: ['E10', 'E11', 'E13', 'E14'],
    evidenceTerms: ['fondo de ojo', 'oftalmolog', 'retinopatia', 'retinografia', 'fundoscopia'],
    resultLoinc: ['32451-7'],
    coveredByRules: ['protocol_diabetes_fundus'],
    everyDays: 365,
    severity: 'medium',
    coverageTerms: ['fondo de ojo', 'fundus', 'retinopat', 'oftalmolog', 'ophthalmolog'],
  },
  {
    key: 'diabetic_foot',
    icd10Prefixes: ['E10', 'E11', 'E13', 'E14'],
    evidenceTerms: [
      'pie diabetico',
      'examen de pies',
      'exploracion de pies',
      'monofilamento',
      'pulsos pedios',
      'sensibilidad en pies',
      'pies:',
    ],
    coveredByRules: [],
    everyDays: 365,
    severity: 'low',
    coverageTerms: ['pies', 'pie diabetico', 'foot', 'feet', 'monofilament'],
  },
  {
    key: 'diabetic_albuminuria',
    icd10Prefixes: ['E10', 'E11', 'E13', 'E14'],
    evidenceTerms: ['microalbuminuria', 'albuminuria', 'albumina/creatinina'],
    resultLoinc: ['9318-7', '14959-1', '14958-3'],
    coveredByRules: [],
    everyDays: 365,
    severity: 'low',
    coverageTerms: ['albuminuria', 'albumin'],
  },
];

// Questions for the next visit ----------------------------------------------------

export interface PreVisitQuestionRule {
  readonly key: string;
  /** Applies to patients with one of these conditions (ICD-10 prefixes) ... */
  readonly icd10Prefixes?: readonly string[];
  /** ... or taking a drug of this class. */
  readonly drugClass?: string;
  /** Not asked when a note of the last `withinDays` already talks about it (folded phrases). */
  readonly answeredBy: readonly string[];
  readonly withinDays: number;
}

export const PRE_VISIT_QUESTIONS: readonly PreVisitQuestionRule[] = [
  {
    key: 'diabetic_neuropathy',
    icd10Prefixes: ['E10', 'E11', 'E13', 'E14'],
    answeredBy: [
      'parestesia',
      'hormigueo',
      'adormecimiento',
      'neuropatia',
      'sensibilidad',
      'monofilamento',
      'pies:',
    ],
    withinDays: 180,
  },
  {
    key: 'statin_myalgia',
    drugClass: 'statin',
    answeredBy: ['mialgia', 'dolor muscular', 'calambres', 'tolera bien', 'buena tolerancia'],
    withinDays: 365,
  },
  {
    key: 'ace_cough',
    drugClass: 'ace_inhibitor',
    answeredBy: ['tos', 'tolera bien', 'buena tolerancia'],
    withinDays: 365,
  },
];

/** Words in a note that record the allergy status ("alergias: niega", "sin alergias conocidas"). */
export const ALLERGY_TERMS = [
  'alergia',
  'alergias',
  'alergico',
  'alergica',
  'nkda',
  'rams',
  'allergy',
  'allergies',
  'allergic',
];
