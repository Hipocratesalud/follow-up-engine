import type { ApiMessages } from '../i18n/index.ts';

/*
 * Display names for the codes the clinic inbox shows, in the request's
 * language (`loinc` and `icd10` of the catalogs in `src/i18n`). Hosts send
 * standard codes with their own displays: known codes get a short name, and
 * anything else falls back to the host's own text. Not a terminology
 * server: a small table of the codes the engine's rules and protocols use
 * and the synthetic clinic sends.
 */

/** Name of a LOINC (or engine procedure) code, if known. */
export function loincLabel(t: ApiMessages, code: string): string | undefined {
  return t.loinc[code];
}

/** Name of an ICD-10 code (exact code, then its category), else the host's display, else the code. */
export function icd10Label(t: ApiMessages, code: string, display: string | undefined): string {
  return t.icd10[code] ?? t.icd10[code.slice(0, 3)] ?? display ?? code;
}
