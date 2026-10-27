/**
 * BCP-47 language tags (`en-US`, `es`, `pt-BR`). Four sources carry one
 * (docs/adr/0007): the clinic's locale, the inbox user's `Accept-Language`,
 * the patient's preferred language (FHIR `Patient.communication`) and the
 * language a note is written in (FHIR `DocumentReference.language`, else
 * detected). They are independent: an English-speaking team can follow up
 * Spanish-speaking patients from Spanish notes.
 */

/**
 * Canonical form of a BCP-47 tag (`EN-us` → `en-US`), or `undefined` when it
 * is not one. The primary language must be an ISO 639 code (2 or 3
 * letters): BCP-47 syntax also admits 5 to 8 letters, which would read a
 * word such as "Spanish" as a tag.
 */
export function normalizeLanguageTag(tag: string | undefined): string | undefined {
  const trimmed = tag?.trim().replaceAll('_', '-');
  if (trimmed === undefined || trimmed === '') return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)[0];
    return canonical !== undefined && /^[a-z]{2,3}(-|$)/.test(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Primary language subtag of a tag (`es-VE` → `es`), lower case; `undefined` for an invalid tag. */
export function primaryLanguage(tag: string | undefined): string | undefined {
  return normalizeLanguageTag(tag)?.split('-')[0]?.toLowerCase();
}

/** The clinic locale when none is configured. */
export const DEFAULT_CLINIC_LOCALE = 'en-US';
