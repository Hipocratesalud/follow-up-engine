import type { Coding } from '../../domain/resource.ts';
import { foldText } from '../support/text.ts';

/**
 * Which tests a plan quote can name, and which codes and English
 * descriptions belong to each: one lexicon for the note extraction
 * (`packages/llm`, which reads a model's plan items against it) and the
 * engine (which codes a plan item the model left uncoded and matches an
 * uncoded one only with a result of a test its quote names).
 *
 * Configuration, not logic: `terms` are Spanish as written in Latin American
 * notes (abbreviations included), English as written in US-style notes
 * ("BMP", "LFTs", "UA", "CXR", "A1c") and the English words a model writes in
 * `description`, compared lowercase, without accents, as whole words. One
 * table for both languages: a test name means the same test in either, and
 * the English shorthand never occurs in Spanish notes. Codes are LOINC; the
 * first one is the group's usual order code. A procedure without a LOINC
 * code (the eye fundus exam) carries its own `code`. Add a group (or a
 * synonym) here with a gold note that needs it.
 */
export interface TestGroup {
  readonly id: string;
  readonly kind: 'lab' | 'imaging';
  /** Short English description used when the model's own does not match the quote. */
  readonly label: string;
  readonly terms: readonly string[];
  readonly loinc: readonly string[];
  /**
   * The group's own code when no LOINC fits (a procedure such as the eye
   * fundus exam): what a plan item naming the test is coded as, and what
   * a result of the test arrives with.
   */
  readonly code?: { readonly system: string; readonly code: string };
}

export const TEST_GROUPS: readonly TestGroup[] = [
  {
    id: 'hba1c',
    kind: 'lab',
    label: 'HbA1c',
    terms: [
      'hba1c',
      'hb a1c',
      'hba 1c',
      'a1c',
      'hemoglobina glicosilada',
      'hemoglobina glicada',
      'hemoglobina glucosilada',
      'glicohemoglobina',
      'hemoglobin a1c',
      'glycated hemoglobin',
      'glycosylated hemoglobin',
      'glycohemoglobin',
    ],
    loinc: ['4548-4', '17856-6', '4549-2', '59261-8', '41995-2'],
  },
  {
    id: 'glucose',
    kind: 'lab',
    label: 'fasting glucose',
    terms: [
      'glicemia',
      'glucemia',
      'glucosa',
      'glicemia en ayunas',
      'glucemia en ayunas',
      'glucosa en ayunas',
      'curva de tolerancia',
      'ptog',
      'glucose',
      'blood sugar',
      'glycemia',
      'fasting glucose',
      'fasting blood sugar',
      'fbg',
      'ogtt',
      'glucose tolerance test',
    ],
    loinc: ['1558-6', '2345-7', '2339-0', '41653-7'],
  },
  {
    id: 'lipids',
    kind: 'lab',
    label: 'lipid panel',
    terms: [
      'perfil lipidico',
      'lipidograma',
      'lipidos',
      'colesterol',
      'colesterol total',
      'ldl',
      'hdl',
      'trigliceridos',
      'lipid',
      'lipids',
      'lipid panel',
      'lipid profile',
      'fasting lipids',
      'flp',
      'lipid profile',
      'cholesterol',
      'triglyceride',
      'triglycerides',
    ],
    loinc: ['57698-3', '24331-1', '2093-3', '2085-9', '13457-7', '18262-6', '2089-1', '2571-8'],
  },
  {
    id: 'thyroid',
    kind: 'lab',
    label: 'TSH',
    terms: [
      'tsh',
      'perfil tiroideo',
      'pruebas tiroideas',
      'funcion tiroidea',
      'hormona tiroestimulante',
      't4',
      't4 libre',
      't4l',
      't3',
      'thyroid',
      'thyrotropin',
      'thyroxine',
      'free t4',
      'thyroid panel',
      'thyroid function tests',
      'tfts',
    ],
    loinc: ['3016-3', '11580-8', '3024-7', '3026-2', '3051-0', '3053-6'],
  },
  {
    id: 'renal',
    kind: 'lab',
    label: 'creatinine',
    terms: [
      'creatinina',
      'funcion renal',
      'perfil renal',
      'urea',
      'bun',
      'nitrogeno ureico',
      'tfg',
      'filtrado glomerular',
      'creatinine',
      'renal function',
      'kidney function',
      'egfr',
      'gfr',
      'bmp',
      'cmp',
      'basic metabolic panel',
      'comprehensive metabolic panel',
    ],
    loinc: ['2160-0', '38483-4', '33914-3', '48642-3', '48643-1', '62238-1', '3094-0', '3091-6'],
  },
  {
    id: 'urine_albumin',
    kind: 'lab',
    label: 'urine microalbumin',
    terms: [
      'microalbuminuria',
      'microalbumina',
      'albuminuria',
      'relacion albumina creatinina',
      'relacion albumina/creatinina',
      'rac',
      'microalbumin',
      'uacr',
      'urine albumin',
      'albumin creatinine ratio',
      'albumin/creatinine ratio',
      'urine microalbumin',
      'urine albumin/creatinine ratio',
      'umacr',
    ],
    loinc: ['14959-1', '14957-5', '9318-7', '1754-1', '14956-7', '32294-1'],
  },
  {
    id: 'cbc',
    kind: 'lab',
    label: 'complete blood count',
    terms: [
      'hemograma',
      'hematologia',
      'hematologia completa',
      'biometria hematica',
      'hemoglobina',
      'hematocrito',
      'plaquetas',
      'cbc',
      'blood count',
      'complete blood count',
      'hemogram',
      'hemoglobin',
      'hematocrit',
      'platelets',
    ],
    loinc: ['58410-2', '57021-8', '718-7', '4544-3', '777-3', '6690-2'],
  },
  {
    id: 'electrolytes',
    kind: 'lab',
    label: 'electrolytes',
    terms: [
      'electrolitos',
      'potasio',
      'k',
      'k+',
      'kalemia',
      'sodio',
      'na',
      'na+',
      'natremia',
      'electrolyte',
      'electrolytes',
      'potassium',
      'sodium',
    ],
    loinc: ['24326-1', '55231-5', '2823-3', '6298-4', '2951-2', '2947-0'],
  },
  {
    id: 'urinalysis',
    kind: 'lab',
    label: 'urinalysis',
    terms: [
      'examen de orina',
      'examen general de orina',
      'ego',
      'orina completa',
      'uroanalisis',
      'urianalisis',
      'urinalysis',
      'urine test',
      'ua',
      'u/a',
    ],
    loinc: ['24357-6', '24356-8'],
  },
  {
    id: 'urine_culture',
    kind: 'lab',
    label: 'urine culture',
    terms: ['urocultivo', 'cultivo de orina', 'urine culture'],
    loinc: ['630-4'],
  },
  {
    id: 'psa',
    kind: 'lab',
    label: 'PSA',
    terms: ['psa', 'antigeno prostatico', 'antigeno prostatico especifico', 'prostate'],
    loinc: ['2857-1', '10886-0'],
  },
  {
    id: 'iron',
    kind: 'lab',
    label: 'iron studies',
    terms: [
      'ferritina',
      'hierro',
      'hierro serico',
      'ferrocinetica',
      'perfil de hierro',
      'transferrina',
      'ferritin',
      'iron',
      'transferrin',
    ],
    loinc: ['2276-4', '2498-4', '2500-7', '2502-3', '50190-8'],
  },
  {
    id: 'liver',
    kind: 'lab',
    label: 'liver function tests',
    terms: [
      'perfil hepatico',
      'pruebas hepaticas',
      'funcion hepatica',
      'transaminasas',
      'tgo',
      'tgp',
      'ast',
      'alt',
      'bilirrubina',
      'liver',
      'hepatic',
      'transaminase',
      'transaminases',
      'bilirubin',
      'lfts',
      'lft',
      'hepatic panel',
      'liver panel',
    ],
    loinc: ['24325-3', '1742-6', '1920-8', '1975-2', '6768-6'],
  },
  {
    id: 'uric_acid',
    kind: 'lab',
    label: 'uric acid',
    terms: ['acido urico', 'uricemia', 'uric acid', 'urate'],
    loinc: ['3084-1'],
  },
  {
    id: 'vitamin_d',
    kind: 'lab',
    label: 'vitamin D',
    terms: ['vitamina d', '25 oh vitamina d', '25-oh vitamina d', 'vitamin d'],
    loinc: ['1989-3', '62292-8'],
  },
  {
    id: 'vitamin_b12',
    kind: 'lab',
    label: 'vitamin B12',
    terms: ['vitamina b12', 'b12', 'cobalamina', 'vitamin b12', 'cobalamin'],
    loinc: ['2132-9'],
  },
  {
    id: 'hiv',
    kind: 'lab',
    label: 'HIV test',
    terms: ['vih', 'hiv', 'elisa para vih', 'prueba de vih'],
    loinc: ['7918-6', '75622-1', '56888-1', '68961-2'],
  },
  {
    id: 'syphilis',
    kind: 'lab',
    label: 'syphilis serology',
    terms: ['vdrl', 'rpr', 'sifilis', 'syphilis'],
    loinc: ['20507-0', '5292-8'],
  },
  {
    id: 'hepatitis',
    kind: 'lab',
    label: 'hepatitis serology',
    terms: [
      'hepatitis b',
      'hepatitis c',
      'hbsag',
      'antigeno de superficie',
      'anti hcv',
      'anti-hcv',
      'hcv',
      'hepatitis',
    ],
    loinc: ['5196-1', '16128-1'],
  },
  {
    id: 'pap',
    kind: 'lab',
    label: 'Pap smear',
    terms: [
      'citologia',
      'citologia cervical',
      'citologia cervicovaginal',
      'papanicolaou',
      'pap',
      'pap smear',
      'cytology',
      'cervical cytology',
    ],
    loinc: ['10524-7', '19762-4', '47527-7', '47528-5'],
  },
  {
    id: 'pregnancy_test',
    kind: 'lab',
    label: 'pregnancy test',
    terms: [
      'prueba de embarazo',
      'test de embarazo',
      'bhcg',
      'b-hcg',
      'beta hcg',
      'hcg',
      'pregnancy test',
      'upt',
      'urine pregnancy test',
    ],
    loinc: ['2106-3', '21198-7', '19080-1'],
  },
  {
    id: 'coagulation',
    kind: 'lab',
    label: 'INR',
    terms: [
      'inr',
      'tiempo de protrombina',
      'tp',
      'tpt',
      'coagulacion',
      'prothrombin',
      'coagulation',
    ],
    loinc: ['6301-6', '5902-2'],
  },
  {
    id: 'inflammation',
    kind: 'lab',
    label: 'inflammatory markers',
    terms: [
      'pcr',
      'proteina c reactiva',
      'vsg',
      'velocidad de sedimentacion',
      'crp',
      'c-reactive protein',
      'c reactive protein',
      'esr',
      'sedimentation rate',
    ],
    loinc: ['1988-5', '30522-7', '4537-7', '30341-2'],
  },
  {
    id: 'stool',
    kind: 'lab',
    label: 'stool test',
    terms: [
      'coprologico',
      'coproparasitologico',
      'examen de heces',
      'heces',
      'sangre oculta',
      'stool',
      'fecal',
      'occult blood',
    ],
    loinc: ['2335-8'],
  },
  {
    // Colorectal cancer screening: the fecal immunochemical test (FIT).
    id: 'fit',
    kind: 'lab',
    label: 'fecal immunochemical test (FIT)',
    terms: [
      'prueba fit',
      'test fit',
      'fit test',
      'test inmunoquimico fecal',
      'prueba inmunoquimica fecal',
      'sangre oculta inmunologica',
      'sangre oculta en heces inmunologica',
      'fecal immunochemical test',
      'immunochemical fecal occult blood test',
    ],
    loinc: ['29771-3', '57905-2', '56490-6', '56491-4'],
  },
  {
    id: 'colonoscopy',
    kind: 'imaging',
    label: 'colonoscopy',
    terms: ['colonoscopia', 'videocolonoscopia', 'colonoscopy'],
    loinc: ['18746-8'],
  },
  {
    id: 'ultrasound',
    kind: 'imaging',
    label: 'ultrasound',
    terms: [
      'eco',
      'ecografia',
      'ecosonograma',
      'ultrasonido',
      'ecografia obstetrica',
      'eco obstetrico',
      'eco transvaginal',
      'ultrasound',
      'sonography',
      'sono',
    ],
    loinc: ['11525-3'],
  },
  {
    id: 'echocardiogram',
    kind: 'imaging',
    label: 'echocardiogram',
    terms: [
      'ecocardiograma',
      'ecocardio',
      'eco cardiaco',
      'echocardiogram',
      'echocardiography',
      'echo',
      'tte',
    ],
    loinc: [],
  },
  {
    id: 'xray',
    kind: 'imaging',
    label: 'X-ray',
    terms: [
      'rx',
      'radiografia',
      'placa',
      'rayos x',
      'x-ray',
      'xray',
      'radiograph',
      'cxr',
      'chest x-ray',
      'chest xray',
    ],
    loinc: ['36643-5'],
  },
  {
    id: 'ct',
    kind: 'imaging',
    label: 'CT scan',
    terms: ['tac', 'tomografia', 'tc', 'ct', 'ct scan', 'computed tomography', 'cat scan'],
    loinc: [],
  },
  {
    id: 'mri',
    kind: 'imaging',
    label: 'MRI',
    terms: ['rm', 'rmn', 'resonancia', 'resonancia magnetica', 'mri', 'magnetic resonance'],
    loinc: [],
  },
  {
    id: 'mammography',
    kind: 'imaging',
    label: 'mammography',
    terms: ['mamografia', 'mammography', 'mammogram'],
    loinc: ['24606-6'],
  },
  {
    id: 'densitometry',
    kind: 'imaging',
    label: 'bone densitometry',
    terms: [
      'densitometria',
      'densitometria osea',
      'dmo',
      'dexa',
      'densitometry',
      'bone density',
      'dexa scan',
      'bone density scan',
    ],
    loinc: [],
  },
  {
    id: 'fundus',
    kind: 'imaging',
    label: 'eye fundus exam',
    terms: [
      'fondo de ojo',
      'fondo de ojos',
      'fondo de ojo bajo dilatacion',
      'fundoscopia',
      'fondoscopia',
      'retinografia',
      'examen de retina',
      'fundus',
      'fundus exam',
      'fundoscopy',
      'dilated eye exam',
      'retinal exam',
      'retinal photography',
      'eye exam',
    ],
    loinc: [],
    code: { system: 'https://hipocratesalud.com/fhir/CodeSystem/procedure', code: 'fundus-exam' },
  },
  {
    id: 'doppler',
    kind: 'imaging',
    label: 'Doppler ultrasound',
    terms: ['doppler', 'eco doppler', 'ecodoppler'],
    loinc: [],
  },
];

const LOINC = 'http://loinc.org';

const WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_AFTER = '(?![\\p{L}\\p{N}])';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const GROUPS_OF_TERM = new Map<string, TestGroup[]>();
for (const group of TEST_GROUPS) {
  for (const term of group.terms) {
    const key = foldText(term);
    GROUPS_OF_TERM.set(key, [...(GROUPS_OF_TERM.get(key) ?? []), group]);
  }
}
/** Every term, longest first, so "hemoglobina glicosilada" wins over "hemoglobina". */
const TERM_PATTERN = new RegExp(
  `${WORD_BEFORE}(?:${[...GROUPS_OF_TERM.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')})${WORD_AFTER}`,
  'gu',
);

/** The test groups `text` names (any case, accents or not), in the order it names them. */
export function testGroupsNamedIn(text: string, kind?: TestGroup['kind']): TestGroup[] {
  const named: TestGroup[] = [];
  for (const match of foldText(text).replace(/\s+/g, ' ').matchAll(TERM_PATTERN)) {
    for (const group of GROUPS_OF_TERM.get(match[0]) ?? []) {
      if ((kind === undefined || group.kind === kind) && !named.includes(group)) {
        named.push(group);
      }
    }
  }
  return named;
}

/**
 * The test group of a code: by LOINC (any code of the group), or the
 * group's own code (`fundus-exam`).
 */
export function testGroupOfCoding(coding: Pick<Coding, 'system' | 'code'>): TestGroup | undefined {
  return TEST_GROUPS.find((group) =>
    coding.system === LOINC
      ? group.loinc.includes(coding.code)
      : group.code?.system === coding.system && group.code.code === coding.code,
  );
}

/**
 * The code a plan item that names only this test is given when the model
 * left it uncoded: a lab group's usual LOINC order code, or a procedure's
 * own code. An imaging group without its own code gets none (an "eco" may
 * be any ultrasound, so the obstetric LOINC would be a guess).
 */
export function orderCodingOf(group: TestGroup): Coding | undefined {
  if (group.code !== undefined) {
    return { system: group.code.system, code: group.code.code, display: group.label };
  }
  const first = group.loinc[0];
  return group.kind === 'lab' && first !== undefined
    ? { system: LOINC, code: first, display: group.label }
    : undefined;
}
