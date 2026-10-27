/**
 * ICD-10 subsumption between a patient's conditions: when the record holds a
 * confirmed diagnosis, a probable one that names the same disease (inferred
 * from a result, read from a note) adds nothing and is noise on the patient
 * page and as evidence. A terminology fact, kept deliberately small: the
 * same three-character category (E11 and E11.9, Z34 and Z34.9), an
 * unspecified code and its specific forms (E14 "diabetes mellitus,
 * unspecified" is E10, E11 or E13 once the doctor codes it), and a few
 * near-synonyms the synthetic clinic's notes produce (acute pharyngitis and
 * pharyngotonsillitis; pregnant state and supervision of a pregnancy).
 */

/** Category of a code: `E11.9` -> `E11`. */
export function icd10Category(code: string): string {
  return code.replace('.', '').trim().toUpperCase().slice(0, 3);
}

/**
 * Categories a probable condition is subsumed by, besides its own: the
 * specific forms of an unspecified code, and near-synonyms. Read as "a
 * confirmed <value> makes a probable <key> redundant".
 */
const SUBSUMED_BY: Readonly<Record<string, readonly string[]>> = {
  // Diabetes mellitus, unspecified (what a high HbA1c or an antidiabetic infers).
  E14: ['E10', 'E11', 'E13'],
  // Acute pharyngitis and acute tonsillitis / pharyngotonsillitis.
  J02: ['J03'],
  J03: ['J02'],
  // Pregnant state and supervision of a normal pregnancy.
  Z33: ['Z34'],
  Z34: ['Z33'],
};

/** Whether the confirmed diagnosis `confirmed` makes the probable diagnosis `probable` redundant. */
export function icd10Subsumes(confirmed: string, probable: string): boolean {
  const covering = icd10Category(confirmed);
  const covered = icd10Category(probable);
  return covering === covered || (SUBSUMED_BY[covered] ?? []).includes(covering);
}

/** The minimal shape the helper reads: a code and a status. */
export interface SubsumableCondition {
  readonly code: { readonly code: string };
  readonly status: string;
}

/**
 * The conditions without the probable ones a confirmed condition of the
 * same disease subsumes (`E14` probable next to `E11.9` confirmed). Order
 * kept; every other status passes through.
 */
export function withoutSubsumedConditions<T extends SubsumableCondition>(
  conditions: readonly T[],
): T[] {
  const confirmed = conditions
    .filter((condition) => condition.status === 'confirmed')
    .map((condition) => condition.code.code);
  return conditions.filter(
    (condition) =>
      condition.status !== 'probable' ||
      !confirmed.some((code) => icd10Subsumes(code, condition.code.code)),
  );
}
