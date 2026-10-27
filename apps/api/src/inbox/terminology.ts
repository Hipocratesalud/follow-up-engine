/*
 * Spanish display names for the codes the clinic inbox shows. Hosts send
 * standard codes with English displays (LOINC, ICD-10): the inbox is Spanish
 * UI copy, so known codes get a short Spanish name and anything else falls
 * back to the host's own text. Not a terminology server: a small table of
 * the codes the engine's rules and protocols use and the synthetic clinic
 * sends.
 */

/** LOINC (and engine procedure codes) → Spanish display. */
export const LOINC_LABELS: Readonly<Record<string, string>> = {
  '4548-4': 'Hemoglobina glicosilada (HbA1c)',
  '57698-3': 'Perfil lipídico',
  '24331-1': 'Perfil lipídico',
  '2093-3': 'Colesterol total',
  '2571-8': 'Triglicéridos',
  '2085-9': 'Colesterol HDL',
  '18262-6': 'Colesterol LDL',
  '13457-7': 'Colesterol LDL',
  '2160-0': 'Creatinina sérica',
  '2823-3': 'Potasio sérico',
  '3016-3': 'TSH',
  '1558-6': 'Glicemia en ayunas',
  '2345-7': 'Glicemia',
  '14959-1': 'Microalbuminuria (relación albúmina/creatinina)',
  '14957-5': 'Microalbuminuria',
  '718-7': 'Hemoglobina',
  '6690-2': 'Leucocitos',
  '58410-2': 'Hematología completa',
  '24357-6': 'Examen de orina',
  '5811-5': 'Densidad urinaria',
  '10524-7': 'Citología cervicovaginal (Papanicolaou)',
  '11525-3': 'Ecografía obstétrica',
  '24606-6': 'Mamografía bilateral de pesquisa',
  '11524-6': 'Electrocardiograma',
  '36643-5': 'Radiografía de tórax',
  'fundus-exam': 'Fondo de ojo',
};

/** ICD-10 code or 3-character category → short Spanish name. */
export const ICD10_LABELS: Readonly<Record<string, string>> = {
  E10: 'Diabetes mellitus tipo 1',
  E11: 'Diabetes mellitus tipo 2',
  R73: 'Prediabetes',
  E66: 'Obesidad',
  E78: 'Dislipidemia',
  E03: 'Hipotiroidismo',
  E28: 'Síndrome de ovario poliquístico',
  I10: 'Hipertensión arterial',
  N18: 'Enfermedad renal crónica',
  'N18.3': 'Enfermedad renal crónica estadio 3',
  N39: 'Infección urinaria',
  J02: 'Faringitis aguda',
  J06: 'Infección respiratoria alta',
  K29: 'Gastritis',
  M54: 'Lumbalgia',
  R53: 'Astenia',
  F32: 'Episodio depresivo',
  F41: 'Trastorno de ansiedad',
  'F41.0': 'Trastorno de pánico',
  'F41.1': 'Trastorno de ansiedad generalizada',
  F43: 'Trastorno adaptativo',
  F51: 'Insomnio',
  O80: 'Parto',
  Z01: 'Control ginecológico',
  Z30: 'Anticoncepción',
  Z34: 'Control de embarazo',
  Z39: 'Control posparto',
  D25: 'Mioma uterino',
  N76: 'Vaginitis',
  B37: 'Candidiasis vulvovaginal',
  N95: 'Climaterio',
};

/** Spanish name of a LOINC code, if known. */
export function loincLabel(code: string): string | undefined {
  return LOINC_LABELS[code];
}

/** Spanish name of an ICD-10 code (exact code, then its category), else the host's display, else the code. */
export function icd10Label(code: string, display: string | undefined): string {
  return ICD10_LABELS[code] ?? ICD10_LABELS[code.slice(0, 3)] ?? display ?? code;
}
