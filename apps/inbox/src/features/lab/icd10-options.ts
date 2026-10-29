/**
 * A short, curated list for the lab's diagnosis picker: common chronic
 * conditions the engine's protocols key off (`CLAUDE.md`: Code in English;
 * these display names are the UI's own copy, not clinical content, so they
 * stay out of the i18n catalogs the same way `consultation.labs` does).
 */
export interface Icd10Option {
  readonly code: string;
  readonly display: string;
}

export const ICD10_OPTIONS: readonly Icd10Option[] = [
  { code: 'E11', display: 'Type 2 diabetes mellitus' },
  { code: 'E10', display: 'Type 1 diabetes mellitus' },
  { code: 'I10', display: 'Essential (primary) hypertension' },
  { code: 'E78', display: 'Disorders of lipoprotein metabolism' },
  { code: 'N18', display: 'Chronic kidney disease' },
  { code: 'E03', display: 'Hypothyroidism' },
  { code: 'J45', display: 'Asthma' },
  { code: 'F32', display: 'Depressive episode' },
  { code: 'F41', display: 'Anxiety disorder' },
  { code: 'O24', display: 'Gestational diabetes mellitus' },
  { code: 'Z34', display: 'Supervision of normal pregnancy' },
];

/** The sentinel the diagnosis `<select>` uses for "type the code myself". */
export const ICD10_OTHER = '__other__';
