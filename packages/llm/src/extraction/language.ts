import { normalizeLanguageTag, primaryLanguage } from '@follow-up-engine/core';

/**
 * The language a note is written in, and which lexicons the deterministic
 * checks read it with (docs/adr/0007). The host may state it
 * (`DocumentReference.language`); otherwise a small stopword count decides.
 * Quotes are never translated: they stay verbatim in the note's language.
 */

/** Languages the detector can name. */
export const DETECTABLE_NOTE_LANGUAGES = ['es', 'en', 'pt'] as const;
export type DetectedNoteLanguage = (typeof DETECTABLE_NOTE_LANGUAGES)[number];

/**
 * Languages with their own lexicons (negation, discharge, conditional
 * returns, timing, test and condition names). Any other note, Portuguese
 * included, is read with the Spanish lexicons: the closest ones, and the
 * engine's historical default.
 */
export const LEXICON_LANGUAGES = ['es', 'en'] as const;
export type LexiconLanguage = (typeof LEXICON_LANGUAGES)[number];

/**
 * Words that are frequent in one language and rare in the other two, in
 * normalized form (lowercase, no accents). Clinical shorthand counts too
 * ("pcte", "f/u"). Shared words ("de", "a", "no", "para", "se") are left out
 * on purpose: they cannot tell Spanish from Portuguese.
 */
const STOPWORDS: Readonly<Record<DetectedNoteLanguage, ReadonlySet<string>>> = {
  es: new Set([
    'el',
    'la',
    'los',
    'las',
    'del',
    'y',
    'con',
    'en',
    'por',
    'sin',
    'al',
    'es',
    'una',
    'un',
    'pero',
    'muy',
    'cada',
    'meses',
    'semanas',
    'dias',
    'anos',
    'niega',
    'refiere',
    'pcte',
    'ctrl',
    'control',
    'paciente',
    'presenta',
    'indica',
    'solicito',
  ]),
  en: new Set([
    'the',
    'and',
    'of',
    'with',
    'for',
    'to',
    'in',
    'on',
    'is',
    'was',
    'are',
    'not',
    'patient',
    'pt',
    'denies',
    'reports',
    'months',
    'weeks',
    'days',
    'years',
    'return',
    'follow',
    'f/u',
    'rtc',
    'hx',
    'yo',
    'daily',
    'continue',
    'plan',
    'will',
    'today',
    'year',
    'old',
    'as',
    'at',
    'by',
    'from',
    'this',
    'that',
    'he',
    'she',
    'his',
    'her',
    'has',
    'had',
    'be',
    'or',
    'new',
    'home',
    'taking',
  ]),
  pt: new Set([
    'os',
    'da',
    'das',
    'e',
    'com',
    'em',
    'um',
    'uma',
    'nao',
    'sem',
    'ao',
    'muito',
    'nega',
    'refere',
    'exames',
    'meses',
    'semanas',
    'dias',
    'anos',
    'paciente',
    'apresenta',
  ]),
};

/** Fewest stopword hits the winning language needs. */
const MIN_HITS = 3;
/** The winner must have at least this many times the hits of the runner-up. */
const MIN_RATIO = 1.5;

function normalizedWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((word) => word !== '');
}

/**
 * The language a note is written in, from its words alone: `es`, `en` or
 * `pt`, or `undefined` when the note is too short or too mixed to tell.
 * Deterministic and linear in the note length.
 */
export function detectNoteLanguage(text: string): DetectedNoteLanguage | undefined {
  const hits: Record<DetectedNoteLanguage, number> = { es: 0, en: 0, pt: 0 };
  for (const word of normalizedWords(text)) {
    for (const language of DETECTABLE_NOTE_LANGUAGES) {
      if (STOPWORDS[language].has(word)) hits[language] += 1;
    }
  }
  // Letters only one language writes.
  if (/[ñ¿¡]/i.test(text)) hits.es += 2;
  if (/[ãõç]/i.test(text)) hits.pt += 2;
  const ranked = [...DETECTABLE_NOTE_LANGUAGES].sort((a, b) => hits[b] - hits[a]);
  const [first, second] = ranked;
  if (first === undefined || second === undefined) return undefined;
  if (hits[first] < MIN_HITS || hits[first] < hits[second] * MIN_RATIO) return undefined;
  return first;
}

/**
 * The note's language as BCP-47: the host's tag when it sent a valid one
 * (canonicalized, `es-VE`), else the detected primary language (`en`), else
 * `undefined`.
 */
export function resolveNoteLanguage(hostTag: string | undefined, text: string): string | undefined {
  return normalizeLanguageTag(hostTag) ?? detectNoteLanguage(text);
}

/** Which lexicons read a note in `language` (BCP-47): English for `en-*`, Spanish otherwise. */
export function lexiconLanguage(language: string | undefined): LexiconLanguage {
  return primaryLanguage(language) === 'en' ? 'en' : 'es';
}
