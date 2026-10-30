import type { OutboundSafetyTerms } from '@follow-up-engine/core';
import { DEFAULT_CONDITION_TERMS, ENGLISH_CONDITION_TERMS } from '../extraction/condition-terms.ts';

/**
 * Short entries of the condition tables that are everyday words in a
 * message ("mi" is "my" in Spanish, "ida" a trip, "cold" the weather):
 * left out of the outbound check so it does not refuse ordinary wording.
 */
const EVERYDAY_WORDS = new Set([
  'mi',
  'fa',
  'ic',
  'oa',
  'ida',
  'cold',
  'tina',
  'aco',
  'diu',
  'sop',
  'tos',
  'iup',
  'ira',
  'sii',
  'toc',
  'tag',
  'gota',
  'cpn',
]);

/**
 * The condition names an outbound message must never contain, from the
 * same term tables the note extraction uses (Spanish and English), so the
 * agent's check grows with the lexicon.
 */
export function outboundSafetyTerms(): OutboundSafetyTerms {
  const terms = new Set<string>();
  for (const table of [DEFAULT_CONDITION_TERMS, ENGLISH_CONDITION_TERMS]) {
    for (const list of Object.values(table)) {
      for (const term of list) {
        const normalized = term.trim().toLowerCase();
        if (normalized.length >= 2 && !EVERYDAY_WORDS.has(normalized)) terms.add(normalized);
      }
    }
  }
  return { conditionTerms: [...terms] };
}
