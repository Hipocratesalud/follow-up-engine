import type { z } from 'zod';
import type { EventCorrelation, EventFilter, EventMatcher } from '../../config/common.ts';
import { type Protocol, ProtocolSchema } from '../../config/protocol.ts';
import { type Rule, RuleSchema } from '../../config/rule.ts';
import {
  AUTHORED_ID_PREFIX,
  type AuthoredDefinition,
  type TerminologyCitation,
} from '../../domain/authored-rule.ts';
import type { ClinicalEventType } from '../../domain/clinical-event.ts';
import type {
  RuleTerminology,
  TerminologyEntry,
  TerminologySystem,
} from '../../ports/rule-authoring.ts';
import type { Catalog } from '../catalog.ts';

/** Shortest and longest interval (days) a clinic-authored rule may ask for. */
export const AUTHORED_MIN_DAYS = 1;
export const AUTHORED_MAX_DAYS = 1095;
/** A periodic protocol item more frequent than this is a typo, not a follow-up cadence. */
export const AUTHORED_MIN_EVERY_DAYS = 7;

/**
 * The guideline source a clinic-authored protocol cites when the clinic's
 * criterion adapts no existing protocol: this repository's own page on
 * clinic-authored rules, so no URL is ever invented.
 */
export const CLINIC_CRITERION_SOURCE = {
  title: 'Clinic-authored follow-up criterion (validated by the clinic, not a guideline)',
  organization: 'Clinic',
  url: 'https://github.com/Hipocratesalud/follow-up-engine/blob/main/docs/agent/rule-authoring.md',
} as const;

/**
 * Event fields a clinic-authored filter may test, per event type: the
 * fields the engine's own rules filter on, nothing a host could leave
 * unset by accident. `code.code` values are checked against the catalogs.
 */
const FILTER_PATHS: Readonly<Partial<Record<ClinicalEventType, readonly string[]>>> = {
  'result.received': ['code.code', 'code.system', 'interpretation', 'severity', 'value.value'],
  'service_request.created': ['code.code', 'code.system', 'category'],
  'medication.prescribed': ['medication.code.code', 'durationDays', 'refills', 'asNeeded'],
  'condition.recorded': ['code.code', 'verification'],
  'encounter.finished': ['specialty'],
  'appointment.booked': ['specialty'],
  'appointment.cancelled': ['specialty'],
};

/** Fixed vocabularies of filterable fields. */
const FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
  interpretation: ['normal', 'abnormal', 'unknown'],
  severity: ['critical', 'mild'],
  category: ['laboratory', 'imaging', 'other'],
  verification: ['confirmed', 'provisional'],
};

/** Layers a clinic-authored rule may sit in: the doctor's plan and cadence rules are engine internals. */
const AUTHORED_RULE_LAYERS = new Set<Rule['layer']>(['universal']);

export interface ValidationContext {
  readonly terminology: RuleTerminology;
  /** The clinic's current catalog: ids already taken, named escalation policies, suggested actions. */
  readonly catalog: Catalog;
  /** Ids of the clinic's own authored rules (a draft may be replaced under the same id). */
  readonly authoredIds: ReadonlySet<string>;
  /** Guideline sources of the existing protocols: the only ones a draft may cite. */
  readonly knownSources: readonly Protocol['sources'][number][];
  /** For the clinic-criterion source year. */
  readonly now: Date;
}

export interface DraftValidation {
  readonly ok: boolean;
  /** Human-readable, one per problem, each with the JSON path it is about. */
  readonly issues: readonly string[];
  readonly definition?: AuthoredDefinition;
  /** The codes the draft uses, as the catalogs know them. */
  readonly terminology: readonly TerminologyCitation[];
}

function zodIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map(
    (issue) =>
      `${prefix}${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
  );
}

const SYSTEM_URIS: Readonly<Record<string, TerminologySystem>> = {
  'http://loinc.org': 'loinc',
  'http://hl7.org/fhir/sid/icd-10': 'icd10',
  'http://www.whocc.no/atc': 'atc',
  'https://hipocratesalud.com/fhir/CodeSystem/procedure': 'procedure',
};

class Checker {
  readonly issues: string[] = [];
  readonly #citations = new Map<string, TerminologyCitation>();
  readonly #terminology: RuleTerminology;

  constructor(terminology: RuleTerminology) {
    this.#terminology = terminology;
  }

  get citations(): TerminologyCitation[] {
    return [...this.#citations.values()];
  }

  issue(path: string, message: string): void {
    this.issues.push(`${path}: ${message}`);
  }

  /** The catalog entry of a code, or an issue naming the code as unknown. */
  code(path: string, system: TerminologySystem, code: string): TerminologyEntry | undefined {
    const entry = this.#terminology.find(system, code);
    if (entry === undefined) {
      this.issue(
        path,
        `unknown ${system.toUpperCase()} code "${code}": use lookup_terminology and only codes it returns`,
      );
      return undefined;
    }
    this.#citations.set(`${system}|${code}`, {
      system,
      code,
      display: entry.display,
      ...(entry.displayEs === undefined ? {} : { displayEs: entry.displayEs }),
      catalog: entry.catalog,
    });
    return entry;
  }

  /** Every code of a filter value (`"3016-3"` or `["3016-3", "11580-8"]`). */
  codes(path: string, system: TerminologySystem, value: unknown): TerminologyEntry[] {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item, index) => {
      if (typeof item !== 'string') {
        this.issue(`${path}[${String(index)}]`, 'a code must be a string');
        return [];
      }
      const entry = this.code(
        Array.isArray(value) ? `${path}[${String(index)}]` : path,
        system,
        item,
      );
      return entry === undefined ? [] : [entry];
    });
  }

  /** The code system a filter's codes belong to, from the event type. */
  #filterSystem(event: ClinicalEventType, filter: EventFilter): TerminologySystem {
    const declared = filter['code.system'];
    if (typeof declared === 'string' && SYSTEM_URIS[declared] !== undefined) {
      return SYSTEM_URIS[declared];
    }
    if (event === 'condition.recorded') return 'icd10';
    if (event === 'medication.prescribed') return 'atc';
    return 'loinc';
  }

  /** Field paths, vocabularies and codes of a matcher; the test entries it names. */
  matcher(path: string, matcher: EventMatcher | EventCorrelation): TerminologyEntry[] {
    const filter = matcher.filter;
    if (filter === undefined) return [];
    const allowed = FILTER_PATHS[matcher.event] ?? [];
    const named: TerminologyEntry[] = [];
    for (const [field, value] of Object.entries(filter)) {
      const where = `${path}.filter.${field}`;
      if (!allowed.includes(field)) {
        this.issue(
          where,
          `a ${matcher.event} filter may only test ${allowed.length === 0 ? 'nothing' : allowed.join(', ')}`,
        );
        continue;
      }
      if (field === 'code.code' || field === 'medication.code.code') {
        named.push(...this.codes(where, this.#filterSystem(matcher.event, filter), value));
        continue;
      }
      if (field === 'code.system') {
        if (typeof value !== 'string' || SYSTEM_URIS[value] === undefined) {
          this.issue(where, `unknown code system; one of ${Object.keys(SYSTEM_URIS).join(', ')}`);
        }
        continue;
      }
      const vocabulary = FIELD_VALUES[field];
      if (vocabulary !== undefined) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          if (typeof item !== 'string' || !vocabulary.includes(item)) {
            this.issue(where, `expected one of ${vocabulary.join(', ')}`);
          }
        }
      }
      if (field === 'value.value' && (typeof value !== 'object' || Array.isArray(value))) {
        this.issue(where, 'a value threshold is a condition such as { "gt": 9 }');
      }
    }
    return named;
  }
}

function checkDays(checker: Checker, path: string, days: number, minimum: number): void {
  if (days < minimum || days > AUTHORED_MAX_DAYS) {
    checker.issue(
      path,
      `${String(days)} days is outside the sane range ${String(minimum)} to ${String(AUTHORED_MAX_DAYS)}`,
    );
  }
}

/** The test groups a set of catalog entries belong to. */
function groupsOf(entries: readonly TerminologyEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => (entry.group === undefined ? [] : [entry.group])));
}

/** Whether a correlation can be the test the expectation asks for, and names it. */
function answersTest(
  checker: Checker,
  path: string,
  correlations: readonly EventCorrelation[],
  groups: ReadonlySet<string>,
): void {
  const answering = correlations.filter(
    (correlation) => correlation.event === 'result.received' && correlation.filter !== undefined,
  );
  if (answering.length === 0) {
    checker.issue(path, 'a test is fulfilled by a result.received filtered by the test codes');
    return;
  }
  if (groups.size === 0) return;
  for (const [index, correlation] of correlations.entries()) {
    if (correlation.event !== 'result.received' || correlation.filter === undefined) continue;
    const codes = correlation.filter['code.code'];
    if (codes === undefined) continue;
    const entries = (Array.isArray(codes) ? codes : [codes]).flatMap((code) => {
      const entry =
        typeof code === 'string'
          ? checker.code(`${path}[${String(index)}]`, 'loinc', code)
          : undefined;
      return entry === undefined ? [] : [entry];
    });
    if (!entries.every((entry) => entry.group !== undefined && groups.has(entry.group))) {
      checker.issue(
        `${path}[${String(index)}].filter.code.code`,
        `fulfillment must be a result of the expected test (${[...groups].join(', ')})`,
      );
    }
  }
}

function checkCommon(
  checker: Checker,
  context: ValidationContext,
  id: string,
  suggestedActions: readonly { readonly path: string; readonly code: string }[],
): void {
  if (!id.startsWith(AUTHORED_ID_PREFIX)) {
    checker.issue('id', `a clinic rule id starts with "${AUTHORED_ID_PREFIX}"`);
  }
  const taken =
    context.catalog.rules.some((rule) => rule.id === id) ||
    context.catalog.protocols.some((protocol) => protocol.id === id);
  if (taken && !context.authoredIds.has(id)) {
    checker.issue('id', `"${id}" is an existing rule; choose a new id`);
  }
  const knownActions = new Set(
    context.catalog.definitions().map((definition) => definition.suggestedAction.code),
  );
  for (const action of suggestedActions) {
    if (!knownActions.has(action.code)) {
      checker.issue(
        action.path,
        `unknown suggested action "${action.code}"; one of ${[...knownActions].sort().join(', ')}`,
      );
    }
  }
}

function checkRule(checker: Checker, context: ValidationContext, rule: Rule): void {
  checkCommon(checker, context, rule.id, [
    { path: 'suggestedAction.code', code: rule.suggestedAction.code },
  ]);
  if (!AUTHORED_RULE_LAYERS.has(rule.layer)) {
    checker.issue('layer', 'a clinic rule is a universal rule (protocols cover cadences)');
  }
  if (rule.reason.code !== rule.id) {
    checker.issue('reason.code', 'equals the rule id');
  }
  checkDays(checker, 'dueInDays', rule.dueInDays, AUTHORED_MIN_DAYS);
  const triggerTests = checker.matcher('trigger', rule.trigger);
  if (rule.trigger.event === 'result.received' && triggerTests.length === 0) {
    checker.issue('trigger.filter.code.code', 'name the result codes that trigger the rule');
  }
  const fulfilledTests = rule.fulfilledBy.flatMap((correlation, index) =>
    checker.matcher(`fulfilledBy[${String(index)}]`, correlation),
  );
  for (const [index, correlation] of (rule.supersededBy ?? []).entries()) {
    checker.matcher(`supersededBy[${String(index)}]`, correlation);
  }
  for (const [index, matcher] of (rule.notFulfilledBy ?? []).entries()) {
    checker.matcher(`notFulfilledBy[${String(index)}]`, matcher);
  }
  const expects = rule.expects;
  if (expects === 'lab' || expects === 'imaging') {
    const usesTrigger = rule.fulfilledBy.some(
      (correlation) => correlation.match === 'same_order' || correlation.match === 'same_code',
    );
    if (!usesTrigger || rule.trigger.event !== 'service_request.created') {
      answersTest(checker, 'fulfilledBy', rule.fulfilledBy, groupsOf(fulfilledTests));
    }
    const wrongKind = fulfilledTests.filter(
      (entry) => entry.testKind !== undefined && entry.testKind !== expects,
    );
    if (wrongKind.length > 0) {
      checker.issue(
        'expects',
        `the fulfilling test is ${wrongKind[0]?.testKind ?? ''}, not ${expects}`,
      );
    }
  } else if (expects === undefined || expects === 'follow_up_visit') {
    if (
      !rule.fulfilledBy.some(
        (correlation) =>
          correlation.event === 'encounter.finished' || correlation.event === 'appointment.booked',
      )
    ) {
      checker.issue(
        'fulfilledBy',
        'a visit is fulfilled by encounter.finished or appointment.booked',
      );
    }
  }
}

function checkProtocol(checker: Checker, context: ValidationContext, protocol: Protocol): void {
  checkCommon(
    checker,
    context,
    protocol.id,
    protocol.items.map((item, index) => ({
      path: `items[${String(index)}].suggestedAction.code`,
      code: item.suggestedAction.code,
    })),
  );
  if (protocol.status !== 'draft') {
    checker.issue('status', 'a clinic protocol is a draft until a clinician enables it');
  }
  if (protocol.reason.code !== `protocol_${protocol.id}`) {
    checker.issue('reason.code', `equals "protocol_${protocol.id}"`);
  }
  const knownUrls = new Set([
    ...context.knownSources.map((source) => source.url),
    CLINIC_CRITERION_SOURCE.url,
  ]);
  for (const [index, source] of protocol.sources.entries()) {
    if (!knownUrls.has(source.url)) {
      checker.issue(
        `sources[${String(index)}].url`,
        'cite only a source list_existing_rules returned (or none: code adds the clinic criterion)',
      );
    }
  }
  const enrollment = protocol.enrollment;
  for (const [index, code] of enrollment.conditionCodes.entries()) {
    checker.code(`enrollment.conditionCodes[${String(index)}]`, 'icd10', code);
  }
  for (const [index, rule] of (enrollment.medications ?? []).entries()) {
    for (const [position, atc] of (rule.atc ?? []).entries()) {
      checker.code(`enrollment.medications[${String(index)}].atc[${String(position)}]`, 'atc', atc);
    }
    checker.code(
      `enrollment.medications[${String(index)}].conditionCode`,
      'icd10',
      rule.conditionCode,
    );
  }
  for (const [position, atc] of (enrollment.activeTreatment?.atc ?? []).entries()) {
    checker.code(`enrollment.activeTreatment.atc[${String(position)}]`, 'atc', atc);
  }
  for (const [index, result] of (enrollment.results ?? []).entries()) {
    checker.code(`enrollment.results[${String(index)}].code.code`, 'loinc', result.code.code);
    checker.code(
      `enrollment.results[${String(index)}].conditionCode`,
      'icd10',
      result.conditionCode,
    );
  }
  for (const [index, item] of protocol.items.entries()) {
    const path = `items[${String(index)}]`;
    if (item.reason.code !== `protocol_${protocol.id}_${item.key}`) {
      checker.issue(`${path}.reason.code`, `equals "protocol_${protocol.id}_${item.key}"`);
    }
    if (item.everyDays !== undefined) {
      checkDays(checker, `${path}.everyDays`, item.everyDays, AUTHORED_MIN_EVERY_DAYS);
    } else if (item.schedule?.type === 'interval') {
      checkDays(
        checker,
        `${path}.schedule.everyDays`,
        item.schedule.everyDays,
        AUTHORED_MIN_EVERY_DAYS,
      );
    } else {
      checker.issue(
        `${path}.schedule`,
        'a clinic protocol item repeats on an interval (everyDays)',
      );
    }
    const fulfilled = item.fulfilledBy.flatMap((correlation, position) =>
      checker.matcher(`${path}.fulfilledBy[${String(position)}]`, correlation),
    );
    if (item.kind === 'lab' || item.kind === 'imaging') {
      if (item.code === undefined) {
        checker.issue(`${path}.code`, `a ${item.kind} item names its test code`);
        continue;
      }
      const system = SYSTEM_URIS[item.code.system] ?? 'loinc';
      const entry = checker.code(`${path}.code.code`, system, item.code.code);
      if (entry?.testKind !== undefined && entry.testKind !== item.kind) {
        checker.issue(`${path}.kind`, `${item.code.code} is ${entry.testKind}, not ${item.kind}`);
      }
      answersTest(
        checker,
        `${path}.fulfilledBy`,
        item.fulfilledBy,
        groupsOf(entry === undefined ? fulfilled : [entry]),
      );
    } else if (
      !item.fulfilledBy.some(
        (correlation) =>
          correlation.event === 'encounter.finished' || correlation.event === 'appointment.booked',
      )
    ) {
      checker.issue(
        `${path}.fulfilledBy`,
        'a visit is fulfilled by encounter.finished or appointment.booked',
      );
    }
  }
}

/** The named escalation policy a draft references by id, resolved; unknown ids are an issue. */
function resolvePolicy(
  value: Record<string, unknown>,
  catalog: Catalog,
  issues: string[],
): Record<string, unknown> {
  const reference = value['escalationPolicy'];
  if (typeof reference !== 'string') return value;
  const policy = catalog.policy(reference);
  if (policy === undefined) {
    issues.push(`escalationPolicy: unknown escalation policy "${reference}" (use "default_v1")`);
    return value;
  }
  return { ...value, escalationPolicy: policy };
}

/** Adds the clinic-criterion source to a protocol that cites none. */
function withSources(value: Record<string, unknown>, now: Date): Record<string, unknown> {
  const sources = value['sources'];
  if (Array.isArray(sources) && sources.length > 0) return value;
  return { ...value, sources: [{ ...CLINIC_CRITERION_SOURCE, year: now.getUTCFullYear() }] };
}

/**
 * Validates a draft the way code, not the model, decides it is valid: the
 * engine's own zod schema (`RuleSchema` or `ProtocolSchema`), then
 * engine-level checks: a clinic id that collides with nothing, every code
 * known to the repository's catalogs, intervals in a sane range, filters
 * only on fields the engine fills, fulfillment and supersession by the test
 * the rule asks for, suggested actions and escalation policies that exist,
 * sources the repository already cites.
 */
export function validateAuthoredDraft(input: unknown, context: ValidationContext): DraftValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, issues: ['draft: expected { kind, definition }'], terminology: [] };
  }
  const { kind, definition } = input as { kind?: unknown; definition?: unknown };
  if (
    (kind !== 'rule' && kind !== 'protocol') ||
    typeof definition !== 'object' ||
    definition === null
  ) {
    return {
      ok: false,
      issues: ['draft: expected kind "rule" or "protocol" and a definition object'],
      terminology: [],
    };
  }
  const issues: string[] = [];
  let resolved = resolvePolicy(definition as Record<string, unknown>, context.catalog, issues);
  if (kind === 'protocol') resolved = withSources(resolved, context.now);
  const checker = new Checker(context.terminology);
  let parsedDefinition: AuthoredDefinition | undefined;
  if (kind === 'rule') {
    const parsed = RuleSchema.safeParse(resolved);
    if (parsed.success) {
      checkRule(checker, context, parsed.data);
      parsedDefinition = { kind: 'rule', rule: parsed.data };
    } else {
      issues.push(...zodIssues(parsed.error, 'definition'));
    }
  } else {
    const parsed = ProtocolSchema.safeParse(resolved);
    if (parsed.success) {
      checkProtocol(checker, context, parsed.data);
      parsedDefinition = { kind: 'protocol', protocol: parsed.data };
    } else {
      issues.push(...zodIssues(parsed.error, 'definition'));
    }
  }
  issues.push(...checker.issues.map((issue) => `definition.${issue}`));
  const ok = issues.length === 0 && parsedDefinition !== undefined;
  return {
    ok,
    issues,
    ...(ok && parsedDefinition !== undefined ? { definition: parsedDefinition } : {}),
    terminology: checker.citations,
  };
}
