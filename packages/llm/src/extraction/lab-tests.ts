import { normalizeForMatch } from './quote.ts';
import { termsPattern } from './signals.ts';
import { TEST_GROUPS, type TestGroup } from '@follow-up-engine/core';

/*
 * The test lexicon lives in core (`TEST_GROUPS`, shared with the engine,
 * which codes and matches plan items by it); this module adds the
 * extraction's readers over normalized note text.
 */
export { TEST_GROUPS, type TestGroup } from '@follow-up-engine/core';

const GROUP_BY_ID = new Map(TEST_GROUPS.map((group) => [group.id, group]));
const GROUP_BY_LOINC = new Map(
  TEST_GROUPS.flatMap((group) => group.loinc.map((code) => [code, group] as const)),
);

/** One whole-word regex per test term, longest first, so "hemoglobina glicosilada" wins over "hemoglobina". */
const TERM_PATTERN = termsPattern(
  TEST_GROUPS.flatMap((group) => group.terms.map(normalizeForMatch)),
);
const GROUP_OF_TERM = new Map<string, TestGroup[]>();
for (const group of TEST_GROUPS) {
  for (const term of group.terms) {
    const key = normalizeForMatch(term);
    GROUP_OF_TERM.set(key, [...(GROUP_OF_TERM.get(key) ?? []), group]);
  }
}

/** A test named in a text, with where it starts and ends. */
export interface NamedTest {
  readonly group: TestGroup;
  readonly start: number;
  readonly end: number;
}

/** Every test named in `text` (normalized), in order. */
export function namedTests(text: string): NamedTest[] {
  const out: NamedTest[] = [];
  TERM_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TERM_PATTERN)) {
    for (const group of GROUP_OF_TERM.get(match[0]) ?? []) {
      out.push({ group, start: match.index, end: match.index + match[0].length });
    }
  }
  return out;
}

/** The ids of the test groups named in `text` (normalized). */
export function testGroupsIn(text: string, kind?: TestGroup['kind']): Set<string> {
  return new Set(
    namedTests(text)
      .filter((test) => kind === undefined || test.group.kind === kind)
      .map((test) => test.group.id),
  );
}

export function testGroup(id: string): TestGroup | undefined {
  return GROUP_BY_ID.get(id);
}

/** The test group a LOINC code belongs to, if the lexicon knows it. */
export function testGroupOfLoinc(code: string): TestGroup | undefined {
  return GROUP_BY_LOINC.get(code);
}

/** Every term of the lexicon, normalized (used to tell clinical words from names). */
export function testVocabulary(): Iterable<string> {
  return GROUP_OF_TERM.keys();
}
