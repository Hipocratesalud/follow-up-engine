import {
  ATC_SYSTEM,
  ICD10_SYSTEM,
  isAtcCode,
  knownAtcCodes,
  LOINC_SYSTEM,
  type RuleTerminology,
  TEST_GROUPS,
  type TerminologyEntry,
  type TerminologySystem,
} from '@follow-up-engine/core';
import {
  type ConditionTermTable,
  DEFAULT_CONDITION_TERMS,
  ENGLISH_CONDITION_TERMS,
} from '../extraction/condition-terms.ts';

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function capitalized(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const ICD10_CATEGORY = /^[A-Z]\d{2}$/;
const ICD10_CODE = /^([A-Z]\d{2})(\.[0-9A-Z]{1,4})?$/;

function icd10Entries(
  spanish: ConditionTermTable,
  english: ConditionTermTable,
): readonly TerminologyEntry[] {
  const categories = [...new Set([...Object.keys(spanish), ...Object.keys(english)])].filter(
    (code) => ICD10_CATEGORY.test(code),
  );
  return categories.sort().map((code) => {
    const en = english[code] ?? [];
    const es = spanish[code] ?? [];
    return {
      system: 'icd10',
      code,
      display: capitalized(en[0] ?? es[0] ?? code),
      catalog: 'condition-terms',
      systemUri: ICD10_SYSTEM,
      terms: [...new Set([...en.slice(0, 4), ...es.slice(0, 4)])],
    };
  });
}

function testEntries(): readonly TerminologyEntry[] {
  return TEST_GROUPS.flatMap((group): TerminologyEntry[] => {
    const terms = group.terms.slice(0, 8);
    const base = {
      display: group.label,
      catalog: 'test-names',
      testKind: group.kind,
      group: group.id,
      terms,
    } as const;
    const loinc = group.loinc.map((code): TerminologyEntry => ({
      ...base,
      system: 'loinc',
      code,
      systemUri: LOINC_SYSTEM,
    }));
    const own =
      group.code === undefined
        ? []
        : [
            {
              ...base,
              system: 'procedure' as const,
              code: group.code.code,
              systemUri: group.code.system,
            },
          ];
    return [...loinc, ...own];
  });
}

function atcEntries(): readonly TerminologyEntry[] {
  return knownAtcCodes().map(({ atc, names }) => ({
    system: 'atc',
    code: atc,
    display: names.join(' / '),
    catalog: 'atc-names',
    systemUri: ATC_SYSTEM,
    terms: names,
  }));
}

function score(entry: TerminologyEntry, query: string): number {
  const code = entry.code.toLowerCase();
  if (code === query) return 100;
  if (query.length >= 3 && code.startsWith(query)) return 80;
  const words = [entry.display, ...entry.terms].map(fold);
  if (words.some((word) => word === query)) return 90;
  if (words.some((word) => word.startsWith(query) || query.startsWith(word))) return 70;
  if (query.length >= 4 && words.some((word) => word.includes(query) || query.includes(word)))
    return 55;
  return 0;
}

export interface RepositoryTerminologyOptions {
  /** ICD-10 terms (default: the note extractor's Spanish and English condition tables). */
  readonly spanishConditions?: ConditionTermTable;
  readonly englishConditions?: ConditionTermTable;
}

/**
 * The rule-authoring agent's terminology: the repository's own catalogs
 * and nothing else. ICD-10 categories from the note extractor's condition
 * terms (`extraction/condition-terms.ts`), LOINC tests from the engine's
 * test lexicon (`TEST_GROUPS`; codes of one group are equivalent) and ATC
 * drugs from the engine's medication name table. A code none of them knows
 * is unknown, so the validator refuses it: the model cannot invent one.
 */
export function createRepositoryTerminology(
  options: RepositoryTerminologyOptions = {},
): RuleTerminology {
  const entries: readonly TerminologyEntry[] = [
    ...icd10Entries(
      options.spanishConditions ?? DEFAULT_CONDITION_TERMS,
      options.englishConditions ?? ENGLISH_CONDITION_TERMS,
    ),
    ...testEntries(),
    ...atcEntries(),
  ];
  const bySystem = new Map<TerminologySystem, TerminologyEntry[]>();
  for (const entry of entries) {
    bySystem.set(entry.system, [...(bySystem.get(entry.system) ?? []), entry]);
  }

  return {
    search(query, searchOptions = {}) {
      const folded = fold(query);
      if (folded === '') return [];
      const pool =
        searchOptions.system === undefined ? entries : (bySystem.get(searchOptions.system) ?? []);
      return pool
        .map((entry) => ({ entry, score: score(entry, folded) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, searchOptions.limit ?? 8)
        .map((item) => item.entry);
    },
    find(system, rawCode) {
      const code = rawCode.trim();
      const pool = bySystem.get(system) ?? [];
      if (system === 'icd10') {
        const category = ICD10_CODE.exec(code.toUpperCase())?.[1];
        return category === undefined ? undefined : pool.find((entry) => entry.code === category);
      }
      if (system === 'atc') {
        const atc = code.toUpperCase();
        if (!isAtcCode(atc)) return undefined;
        const exact = pool.find((entry) => entry.code === atc);
        if (exact !== undefined) return exact;
        const members = pool.filter((entry) => entry.code.startsWith(atc));
        if (members.length === 0 || atc.length < 3) return undefined;
        return {
          system: 'atc',
          code: atc,
          display: `class: ${members
            .slice(0, 4)
            .map((entry) => entry.display)
            .join(', ')}`,
          catalog: 'atc-names',
          systemUri: ATC_SYSTEM,
          terms: members.flatMap((entry) => entry.terms).slice(0, 8),
        };
      }
      return pool.find((entry) => entry.code === code);
    },
  };
}
