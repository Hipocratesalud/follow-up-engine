import type { PlanItemKind } from '../../domain/clinical-event.ts';
import { type Coding, ICD10_SYSTEM } from '../../domain/resource.ts';

/** Short names of well-known terminologies used in match keys (`loinc:4548-4`). */
const SYSTEM_ALIASES: Readonly<Record<string, string>> = {
  loinc: 'http://loinc.org',
  icd10: ICD10_SYSTEM,
  snomed: 'http://snomed.info/sct',
  cpt: 'http://www.ama-assn.org/go/cpt',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
};
const ALIAS_BY_SYSTEM = new Map(Object.entries(SYSTEM_ALIASES).map(([alias, uri]) => [uri, alias]));
const GENERIC_PREFIX = 'code:';

/** Match key of uncoded expectations of each kind. */
const KIND_MATCH_KEYS: Readonly<Record<PlanItemKind, string>> = {
  follow_up_visit: 'visit',
  session: 'session',
  lab: 'lab',
  imaging: 'imaging',
  other: 'other',
};
const KIND_BY_MATCH_KEY = new Map(
  Object.entries(KIND_MATCH_KEYS).map(([kind, key]) => [key, kind as PlanItemKind]),
);

/** `loinc:4548-4` for well-known systems, `code:<system>|<code>` otherwise. */
export function codeMatchKey(coding: Pick<Coding, 'system' | 'code'>): string {
  const alias = ALIAS_BY_SYSTEM.get(coding.system);
  return alias === undefined
    ? `${GENERIC_PREFIX}${coding.system}|${coding.code}`
    : `${alias}:${coding.code}`;
}

/** The code encoded in a match key, or `undefined` for uncoded keys such as `visit`. */
export function parseCodeMatchKey(matchKey: string): Coding | undefined {
  if (matchKey.startsWith(GENERIC_PREFIX)) {
    const body = matchKey.slice(GENERIC_PREFIX.length);
    const separator = body.lastIndexOf('|');
    return separator <= 0
      ? undefined
      : { system: body.slice(0, separator), code: body.slice(separator + 1) };
  }
  const separator = matchKey.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const system = SYSTEM_ALIASES[matchKey.slice(0, separator)];
  return system === undefined ? undefined : { system, code: matchKey.slice(separator + 1) };
}

/**
 * The match key of an expectation of `kind`: the test code for coded labs
 * and imaging, else a kind key (`visit`, `session`, ...). Two expectations
 * with the same match key ask for the same thing, which is how the protocol
 * layer detects that the doctor's plan already covered an item.
 */
export function matchKeyFor(kind: PlanItemKind, code: Coding | undefined): string {
  if ((kind === 'lab' || kind === 'imaging') && code !== undefined) {
    return codeMatchKey(code);
  }
  return KIND_MATCH_KEYS[kind];
}

/** The kind an expectation asks for, read back from its match key (coded keys are tests: `lab`). */
export function kindOfMatchKey(matchKey: string): PlanItemKind {
  return KIND_BY_MATCH_KEY.get(matchKey) ?? 'lab';
}

/** Same terminology and code. */
export function sameCoding(
  left: Pick<Coding, 'system' | 'code'>,
  right: Pick<Coding, 'system' | 'code'>,
): boolean {
  return left.system === right.system && left.code === right.code;
}
