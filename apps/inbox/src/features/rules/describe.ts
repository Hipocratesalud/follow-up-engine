import type { DefinitionJson, TerminologyCitationView } from '../../api/rules-contract.ts';
import type { Locale, Messages } from '../../i18n/index.ts';

/**
 * The human-readable rule: sentences written by code from the draft's
 * structured fields (never the model's prose), in the UI language. Codes
 * are named as the repository's catalogs name them.
 */
export interface DescribedLine {
  readonly label: string;
  readonly text: string;
}

type Copy = Messages['rules']['describe'];

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string');
}

/** `TSH (3016-3, 11580-8)`: the catalog's name, then the codes. */
function namedCodes(
  codes: readonly string[],
  citations: readonly TerminologyCitationView[],
  locale: Locale,
): string {
  const names: string[] = [];
  for (const code of codes) {
    const citation = citations.find((item) => item.code === code);
    const name =
      citation === undefined
        ? code
        : locale === 'es' && citation.displayEs !== undefined
          ? citation.displayEs
          : citation.display;
    if (!names.includes(name)) names.push(name);
  }
  return codes.length === 0 ? '' : `${names.join(' / ')} (${codes.join(', ')})`;
}

function days(copy: Copy, n: number): string {
  const text = copy.days(n);
  return n >= 60 ? copy.aboutMonths(text, Math.round(n / 30.44)) : text;
}

function conditionText(copy: Copy, condition: Readonly<Record<string, unknown>>): string[] {
  const parts: string[] = [];
  const bound = (key: string, render: (n: number) => string): void => {
    const value = condition[key];
    if (typeof value === 'number') parts.push(render(value));
  };
  bound('gt', copy.above);
  bound('gte', copy.atLeast);
  bound('lt', copy.below);
  bound('lte', copy.atMost);
  return parts;
}

/** "a result of FIT (29771-3), abnormal". */
function matcherText(
  copy: Copy,
  matcher: Readonly<Record<string, unknown>>,
  citations: readonly TerminologyCitationView[],
  locale: Locale,
): string {
  const event = typeof matcher['event'] === 'string' ? matcher['event'] : '';
  const what = copy.events[event] ?? event;
  const filter = record(matcher['filter']);
  const codes = strings(filter['code.code'] ?? filter['medication.code.code']);
  const parts = [codes.length === 0 ? what : copy.of(what, namedCodes(codes, citations, locale))];
  for (const value of strings(filter['interpretation'])) {
    parts.push(value === 'abnormal' ? copy.abnormal : value === 'normal' ? copy.normal : value);
  }
  parts.push(...conditionText(copy, record(filter['value.value'])));
  return parts.join(', ');
}

function matchersText(
  copy: Copy,
  matchers: unknown,
  citations: readonly TerminologyCitationView[],
  locale: Locale,
): string {
  return list(matchers)
    .map((matcher) => matcherText(copy, record(matcher), citations, locale))
    .join(copy.or);
}

function describeRule(
  copy: Copy,
  rule: DefinitionJson,
  citations: readonly TerminologyCitationView[],
  locale: Locale,
): DescribedLine[] {
  const expects = typeof rule['expects'] === 'string' ? rule['expects'] : 'follow_up_visit';
  const dueInDays = typeof rule['dueInDays'] === 'number' ? rule['dueInDays'] : 0;
  const lines: DescribedLine[] = [
    { label: copy.when, text: matcherText(copy, record(rule['trigger']), citations, locale) },
    {
      label: copy.expects,
      text: copy.within(copy.kinds[expects] ?? expects, days(copy, dueInDays)),
    },
    { label: copy.fulfilledBy, text: matchersText(copy, rule['fulfilledBy'], citations, locale) },
  ];
  if (list(rule['supersededBy']).length > 0) {
    lines.push({
      label: copy.replacedBy,
      text: matchersText(copy, rule['supersededBy'], citations, locale),
    });
  }
  return lines;
}

function describeProtocol(
  copy: Copy,
  protocol: DefinitionJson,
  citations: readonly TerminologyCitationView[],
  locale: Locale,
): DescribedLine[] {
  const enrollment = record(protocol['enrollment']);
  const who = [
    copy.withConditions(namedCodes(strings(enrollment['conditionCodes']), citations, locale)),
  ];
  const treatment = strings(record(enrollment['activeTreatment'])['atc']);
  if (treatment.length > 0) who.push(copy.onTreatment(namedCodes(treatment, citations, locale)));
  const lines: DescribedLine[] = [{ label: copy.patients, text: who.join(', ') }];
  for (const item of list(protocol['items']).map(record)) {
    const kind = typeof item['kind'] === 'string' ? item['kind'] : 'other';
    const code = record(item['code'])['code'];
    const what =
      typeof code === 'string'
        ? namedCodes([code], citations, locale)
        : kind === 'follow_up_visit'
          ? copy.visit
          : (copy.kinds[kind] ?? kind);
    const schedule = record(item['schedule']);
    const every =
      typeof item['everyDays'] === 'number'
        ? item['everyDays']
        : typeof schedule['everyDays'] === 'number'
          ? schedule['everyDays']
          : 0;
    lines.push({ label: copy.items, text: copy.every(what, days(copy, every)) });
    lines.push({
      label: copy.fulfilledBy,
      text: matchersText(copy, item['fulfilledBy'], citations, locale),
    });
  }
  return lines;
}

/** The draft as sentences: what triggers it (or whom it enrolls), what it expects, what closes it. */
export function describeDefinition(
  t: Messages,
  locale: Locale,
  kind: 'rule' | 'protocol',
  definition: DefinitionJson,
  citations: readonly TerminologyCitationView[],
): { readonly lines: readonly DescribedLine[]; readonly notes: readonly string[] } {
  const copy = t.rules.describe;
  const lines =
    kind === 'rule'
      ? describeRule(copy, definition, citations, locale)
      : describeProtocol(copy, definition, citations, locale);
  const notes: string[] = [];
  if (definition['coveredByPlan'] === true) notes.push(copy.coveredByPlan);
  const policy = definition['escalationPolicy'];
  const policyId = typeof policy === 'string' ? policy : record(policy)['id'];
  if (typeof policyId === 'string') notes.push(copy.escalation(policyId));
  return { lines, notes };
}
