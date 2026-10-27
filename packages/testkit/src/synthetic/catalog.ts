/**
 * Terminology used by the synthetic clinic: LOINC orders and analytes,
 * ATC medications and ICD-10 diagnoses. Codes are real public codes; the
 * Spanish labels are what a Latin American clinic would print.
 */

import { SYSTEMS } from '../constants.ts';

export type OrderCategory = 'laboratory' | 'imaging';

export interface Analyte {
  readonly loinc: string;
  readonly display: string;
  readonly unit: string;
  readonly ucum: string;
  readonly low?: number;
  readonly high?: number;
  readonly decimals: number;
}

export interface OrderDefinition {
  readonly key: string;
  /** The order's code: LOINC unless `system` says otherwise. */
  readonly loinc: string;
  /** Code system of `loinc` when it is not LOINC (a local procedure code). */
  readonly system?: string;
  readonly display: string;
  /** Spanish name as written on the order. */
  readonly label: string;
  /** How doctors abbreviate it in notes. */
  readonly noteName: string;
  readonly category: OrderCategory;
  /** Lab panels: the observations reported. Single analytes: one entry with the order's code. */
  readonly analytes?: readonly Analyte[];
  /** Imaging and cytology: textual conclusions (normal first, abnormal second). */
  readonly conclusions?: readonly [normal: string, abnormal: string];
}

const lab = (
  key: string,
  loinc: string,
  display: string,
  label: string,
  noteName: string,
  analytes?: readonly Analyte[],
): OrderDefinition => ({
  key,
  loinc,
  display,
  label,
  noteName,
  category: 'laboratory',
  ...(analytes ? { analytes } : {}),
});

export const ORDERS = {
  hba1c: lab(
    'hba1c',
    '4548-4',
    'Hemoglobin A1c/Hemoglobin.total in Blood',
    'Hemoglobina glicosilada (HbA1c)',
    'HbA1c',
    [
      {
        loinc: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        unit: '%',
        ucum: '%',
        high: 5.7,
        decimals: 1,
      },
    ],
  ),
  lipidPanel: lab(
    'lipidPanel',
    '57698-3',
    'Lipid panel with direct LDL - Serum or Plasma',
    'Perfil lipídico',
    'perfil lipídico',
    [
      {
        loinc: '2093-3',
        display: 'Cholesterol [Mass/volume] in Serum or Plasma',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        high: 200,
        decimals: 0,
      },
      {
        loinc: '2571-8',
        display: 'Triglyceride [Mass/volume] in Serum or Plasma',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        high: 150,
        decimals: 0,
      },
      {
        loinc: '2085-9',
        display: 'Cholesterol in HDL [Mass/volume] in Serum or Plasma',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        low: 40,
        decimals: 0,
      },
      {
        loinc: '18262-6',
        display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Direct assay',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        high: 130,
        decimals: 0,
      },
    ],
  ),
  creatinine: lab(
    'creatinine',
    '2160-0',
    'Creatinine [Mass/volume] in Serum or Plasma',
    'Creatinina sérica',
    'creatinina',
    [
      {
        loinc: '2160-0',
        display: 'Creatinine [Mass/volume] in Serum or Plasma',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        low: 0.5,
        high: 1.2,
        decimals: 2,
      },
    ],
  ),
  potassium: lab(
    'potassium',
    '2823-3',
    'Potassium [Moles/volume] in Serum or Plasma',
    'Potasio sérico',
    'K+',
    [
      {
        loinc: '2823-3',
        display: 'Potassium [Moles/volume] in Serum or Plasma',
        unit: 'mmol/L',
        ucum: 'mmol/L',
        low: 3.5,
        high: 5.1,
        decimals: 1,
      },
    ],
  ),
  tsh: lab('tsh', '3016-3', 'Thyrotropin [Units/volume] in Serum or Plasma', 'TSH', 'TSH', [
    {
      loinc: '3016-3',
      display: 'Thyrotropin [Units/volume] in Serum or Plasma',
      unit: 'mUI/L',
      ucum: 'm[IU]/L',
      low: 0.4,
      high: 4.0,
      decimals: 2,
    },
  ]),
  glucose: lab(
    'glucose',
    '1558-6',
    'Fasting glucose [Mass/volume] in Serum or Plasma',
    'Glicemia en ayunas',
    'glicemia en ayunas',
    [
      {
        loinc: '1558-6',
        display: 'Fasting glucose [Mass/volume] in Serum or Plasma',
        unit: 'mg/dL',
        ucum: 'mg/dL',
        low: 70,
        high: 100,
        decimals: 0,
      },
    ],
  ),
  microalbumin: lab(
    'microalbumin',
    '14959-1',
    'Microalbumin/Creatinine [Mass Ratio] in Urine',
    'Microalbuminuria (relación albúmina/creatinina)',
    'microalbuminuria',
    [
      {
        loinc: '14959-1',
        display: 'Microalbumin/Creatinine [Mass Ratio] in Urine',
        unit: 'mg/g',
        ucum: 'mg/g',
        high: 30,
        decimals: 0,
      },
    ],
  ),
  cbc: lab(
    'cbc',
    '58410-2',
    'CBC panel - Blood by Automated count',
    'Hematología completa',
    'hematología completa',
    [
      {
        loinc: '718-7',
        display: 'Hemoglobin [Mass/volume] in Blood',
        unit: 'g/dL',
        ucum: 'g/dL',
        low: 12,
        high: 16,
        decimals: 1,
      },
      {
        loinc: '6690-2',
        display: 'Leukocytes [#/volume] in Blood by Automated count',
        unit: '10*3/uL',
        ucum: '10*3/uL',
        low: 4.5,
        high: 11,
        decimals: 1,
      },
    ],
  ),
  urinalysis: lab(
    'urinalysis',
    '24357-6',
    'Urinalysis macro (dipstick) panel - Urine',
    'Examen de orina',
    'examen de orina',
    [
      {
        loinc: '5811-5',
        display: 'Specific gravity of Urine by Test strip',
        unit: '{SG}',
        ucum: '{SG}',
        low: 1.005,
        high: 1.03,
        decimals: 3,
      },
    ],
  ),
  pap: {
    key: 'pap',
    loinc: '10524-7',
    display: 'Microscopic observation [Identifier] in Cervix by Cyto stain',
    label: 'Citología cervicovaginal (Papanicolaou)',
    noteName: 'citología',
    category: 'laboratory',
    conclusions: [
      'Negativo para lesión intraepitelial o malignidad (NILM).',
      'ASC-US: células escamosas atípicas de significado indeterminado.',
    ],
  },
  obstetricUs: {
    key: 'obstetricUs',
    loinc: '11525-3',
    display: 'US Pelvis Fetus for pregnancy',
    label: 'Ecografía obstétrica',
    noteName: 'eco obstétrico',
    category: 'imaging',
    conclusions: [
      'Embarazo único, intrauterino, activo. Biometría acorde a edad gestacional. Líquido amniótico normal.',
      'Embarazo único activo. Biometría por debajo del percentil 10 para edad gestacional. Sugiere control.',
    ],
  },
  mammography: {
    key: 'mammography',
    loinc: '24606-6',
    display: 'MG Breast Screening',
    label: 'Mamografía bilateral de pesquisa',
    noteName: 'mamografía',
    category: 'imaging',
    conclusions: [
      'BI-RADS 1. Estudio negativo.',
      'BI-RADS 3. Hallazgo probablemente benigno; se sugiere control a corto plazo.',
    ],
  },
  ecg: {
    key: 'ecg',
    loinc: '11524-6',
    display: 'EKG study',
    label: 'Electrocardiograma',
    noteName: 'ECG',
    category: 'imaging',
    conclusions: [
      'Ritmo sinusal, FC 72 lpm. Sin alteraciones agudas de la repolarización.',
      'Ritmo sinusal. Criterios de hipertrofia ventricular izquierda.',
    ],
  },
  fundusExam: {
    key: 'fundusExam',
    loinc: 'fundus-exam',
    system: SYSTEMS.procedure,
    display: 'Fundus exam',
    label: 'Fondo de ojo (referencia a oftalmología)',
    noteName: 'fondo de ojo',
    category: 'imaging',
    conclusions: [
      'Fondo de ojo sin signos de retinopatía diabética.',
      'Retinopatía diabética no proliferativa leve. Control oftalmológico en 6 meses.',
    ],
  },
  chestXray: {
    key: 'chestXray',
    loinc: '36643-5',
    display: 'XR Chest 2 Views',
    label: 'Radiografía de tórax PA y lateral',
    noteName: 'rx de tórax',
    category: 'imaging',
    conclusions: [
      'Campos pulmonares bien ventilados. Silueta cardíaca normal.',
      'Índice cardiotorácico aumentado. Sin consolidaciones.',
    ],
  },
} as const satisfies Record<string, OrderDefinition>;

export type OrderKey = keyof typeof ORDERS;

export interface MedicationDefinition {
  readonly atc: string;
  readonly display: string;
  /** As written in a note or prescription. */
  readonly text: string;
  readonly dosage: string;
  /** Short treatments only: days of treatment, sent as `expectedSupplyDuration`. */
  readonly durationDays?: number;
}

const med = (
  atc: string,
  display: string,
  text: string,
  dosage: string,
  durationDays?: number,
): MedicationDefinition => ({
  atc,
  display,
  text,
  dosage,
  ...(durationDays === undefined ? {} : { durationDays }),
});

export const MEDICATIONS = {
  metformin850: med('A10BA02', 'metformin', 'Metformina 850 mg', '1 tab VO c/12h con las comidas'),
  metformin1000: med('A10BA02', 'metformin', 'Metformina 1000 mg', '1 tab VO c/12h'),
  glibenclamide: med(
    'A10BB01',
    'glibenclamide',
    'Glibenclamida 5 mg',
    '1 tab VO antes del desayuno',
  ),
  sitagliptin: med('A10BH01', 'sitagliptin', 'Sitagliptina 100 mg', '1 tab VO OD'),
  empagliflozin: med('A10BK03', 'empagliflozin', 'Empagliflozina 10 mg', '1 tab VO OD'),
  glargine: med('A10AE04', 'insulin glargine', 'Insulina glargina 100 UI/mL', '14 UI SC HS'),
  atorvastatin: med('C10AA05', 'atorvastatin', 'Atorvastatina 20 mg', '1 tab VO HS'),
  losartan: med('C09CA01', 'losartan', 'Losartán 50 mg', '1 tab VO c/12h'),
  amlodipine: med('C08CA01', 'amlodipine', 'Amlodipino 5 mg', '1 tab VO OD'),
  enalapril: med('C09AA02', 'enalapril', 'Enalapril 10 mg', '1 tab VO c/12h'),
  hydrochlorothiazide: med(
    'C03AA03',
    'hydrochlorothiazide',
    'Hidroclorotiazida 25 mg',
    '1 tab VO OD AM',
  ),
  levothyroxine: med(
    'H03AA01',
    'levothyroxine sodium',
    'Levotiroxina 50 mcg',
    '1 tab VO en ayunas',
  ),
  omeprazole: med('A02BC01', 'omeprazole', 'Omeprazol 20 mg', '1 cáps VO en ayunas', 14),
  nitrofurantoin: med('J01XE01', 'nitrofurantoin', 'Nitrofurantoína 100 mg', '1 cáps VO c/12h', 7),
  amoxicillin: med('J01CA04', 'amoxicillin', 'Amoxicilina 500 mg', '1 cáps VO c/8h', 7),
  azithromycin: med('J01FA10', 'azithromycin', 'Azitromicina 500 mg', '1 tab VO OD', 3),
  ibuprofen: med('M01AE01', 'ibuprofen', 'Ibuprofeno 400 mg', '1 tab VO c/8h PRN dolor', 5),
  metronidazole: med(
    'G01AF01',
    'metronidazole',
    'Metronidazol óvulos 500 mg',
    '1 óvulo vaginal HS',
    7,
  ),
  fluconazole: med('J02AC01', 'fluconazole', 'Fluconazol 150 mg', 'dosis única VO', 1),
  folicAcid: med('B03BB01', 'folic acid', 'Ácido fólico 5 mg', '1 tab VO OD'),
  ferrousSulfate: med('B03AA07', 'ferrous sulfate', 'Sulfato ferroso 300 mg', '1 tab VO OD'),
  sertraline: med('N06AB06', 'sertraline', 'Sertralina 50 mg', '1 tab VO OD AM'),
  combinedPill: med(
    'G03AA12',
    'drospirenone and ethinylestradiol',
    'Drospirenona/etinilestradiol',
    '1 tab VO OD por 21 días',
  ),
} as const satisfies Record<string, MedicationDefinition>;

export type MedicationKey = keyof typeof MEDICATIONS;

export interface ConditionDefinition {
  readonly icd10: string;
  readonly display: string;
  /** How doctors write it in a note. */
  readonly noteName: string;
}

export const CONDITIONS = {
  dm2: {
    icd10: 'E11.9',
    display: 'Type 2 diabetes mellitus without complications',
    noteName: 'DM2',
  },
  prediabetes: {
    icd10: 'R73.0',
    display: 'Abnormal glucose tolerance test',
    noteName: 'prediabetes',
  },
  dyslipidemia: {
    icd10: 'E78.5',
    display: 'Hyperlipidaemia, unspecified',
    noteName: 'dislipidemia',
  },
  obesity: { icd10: 'E66.9', display: 'Obesity, unspecified', noteName: 'obesidad' },
  hypothyroidism: {
    icd10: 'E03.9',
    display: 'Hypothyroidism, unspecified',
    noteName: 'hipotiroidismo',
  },
  hypertension: { icd10: 'I10', display: 'Essential (primary) hypertension', noteName: 'HTA' },
  ckd3: { icd10: 'N18.3', display: 'Chronic kidney disease, stage 3', noteName: 'ERC estadio 3' },
  uti: { icd10: 'N39.0', display: 'Urinary tract infection, site not specified', noteName: 'ITU' },
  uri: {
    icd10: 'J06.9',
    display: 'Acute upper respiratory infection, unspecified',
    noteName: 'IRA alta',
  },
  gastritis: { icd10: 'K29.7', display: 'Gastritis, unspecified', noteName: 'gastritis' },
  fatigue: { icd10: 'R53', display: 'Malaise and fatigue', noteName: 'astenia' },
  lowBackPain: { icd10: 'M54.5', display: 'Low back pain', noteName: 'lumbalgia' },
  pharyngitis: {
    icd10: 'J02.9',
    display: 'Acute pharyngitis, unspecified',
    noteName: 'faringoamigdalitis',
  },
  anxiety: { icd10: 'F41.1', display: 'Generalized anxiety disorder', noteName: 'TAG' },
  depression: {
    icd10: 'F32.0',
    display: 'Mild depressive episode',
    noteName: 'episodio depresivo leve',
  },
  adjustment: { icd10: 'F43.2', display: 'Adjustment disorders', noteName: 'trastorno adaptativo' },
  insomnia: { icd10: 'F51.0', display: 'Nonorganic insomnia', noteName: 'insomnio' },
  panic: { icd10: 'F41.0', display: 'Panic disorder', noteName: 'trastorno de pánico' },
  gynExam: {
    icd10: 'Z01.4',
    display: 'Gynaecological examination (general)(routine)',
    noteName: 'control ginecológico',
  },
  pregnancy: {
    icd10: 'Z34.9',
    display: 'Supervision of normal pregnancy, unspecified',
    noteName: 'embarazo',
  },
  postpartum: { icd10: 'Z39.2', display: 'Routine postpartum follow-up', noteName: 'puerperio' },
  vaginitis: { icd10: 'N76.0', display: 'Acute vaginitis', noteName: 'vaginitis' },
  candidiasis: {
    icd10: 'B37.3',
    display: 'Candidiasis of vulva and vagina',
    noteName: 'candidiasis vaginal',
  },
  pcos: { icd10: 'E28.2', display: 'Polycystic ovarian syndrome', noteName: 'SOP' },
  menopause: {
    icd10: 'N95.1',
    display: 'Menopausal and female climacteric states',
    noteName: 'climaterio',
  },
  contraception: {
    icd10: 'Z30.0',
    display: 'General counselling and advice on contraception',
    noteName: 'anticoncepción',
  },
} as const satisfies Record<string, ConditionDefinition>;

export type ConditionKey = keyof typeof CONDITIONS;
