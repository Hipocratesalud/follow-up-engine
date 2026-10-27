import type { Protocol, ProtocolItem } from '../../../config/protocol.ts';
import type { ClinicalEvent } from '../../../domain/clinical-event.ts';
import type { PatientCondition } from '../../../domain/condition.ts';
import type { Expectation } from '../../../domain/expectation.ts';
import { type Catalog, type ExpectationDefinition, protocolRuleId } from '../../catalog.ts';
import { definitionVisitFits, matchesShape } from '../../matching/correlation.ts';
import { codeMatchKey, matchKeyFor } from '../../matching/match-key.ts';
import { containsPhrase } from '../../support/text.ts';
import { addDays } from '../../support/time.ts';
import { eventInstant, type PatientTimeline } from '../../timeline.ts';
import { enrollingConditions } from '../conditions.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';

/** Layers whose expectations are explicit enough to make a protocol item redundant. */
const COVERING_LAYERS: ReadonlySet<Expectation['layer']> = new Set(['doctor_plan', 'universal']);

function latestFulfillingEvent(
  definition: ExpectationDefinition,
  timeline: PatientTimeline,
): ClinicalEvent | undefined {
  let latest: ClinicalEvent | undefined;
  for (const event of timeline.events) {
    const matches =
      definition.fulfilledBy.some((correlation) =>
        matchesShape(correlation, event, definition.code),
      ) && definitionVisitFits(definition, event, timeline);
    if (matches && (latest === undefined || eventInstant(event) >= eventInstant(latest))) {
      latest = event;
    }
  }
  return latest;
}

/**
 * Match keys that ask for the same test as a protocol item: its own code and
 * every code its `fulfilledBy` filters accept (the item's equivalence group:
 * any lipid panel LOINC covers the lipid item).
 */
function equivalentMatchKeys(item: ProtocolItem, matchKey: string): Set<string> {
  const keys = new Set([matchKey]);
  if (item.code === undefined) {
    return keys;
  }
  for (const correlation of item.fulfilledBy) {
    const codes = correlation.filter?.['code.code'];
    for (const code of Array.isArray(codes) ? codes : []) {
      if (typeof code === 'string') {
        keys.add(codeMatchKey({ system: item.code.system, code }));
      }
    }
  }
  return keys;
}

/**
 * Whether a live doctor's-plan or universal expectation already asks for
 * what the protocol item would: the same match key or an equivalent code, or
 * an uncoded plan item of the same kind whose quote names the test
 * ("control en 3 meses con HbA1c").
 */
export function coversItem(
  expectation: Expectation,
  item: ProtocolItem,
  matchKey: string,
): boolean {
  if (!COVERING_LAYERS.has(expectation.layer)) {
    return false;
  }
  if (equivalentMatchKeys(item, matchKey).has(expectation.matchKey)) {
    return true;
  }
  const uncodedKey = matchKeyFor(item.kind, undefined);
  return (
    item.planTerms !== undefined &&
    expectation.layer === 'doctor_plan' &&
    uncodedKey !== matchKey &&
    expectation.matchKey === uncodedKey &&
    containsPhrase(expectation.evidence?.quote ?? '', item.planTerms)
  );
}

/**
 * Whether a live protocol expectation is now covered by something asked for
 * after it (the doctor ordered the overdue test, or planned the visit): the
 * protocol only fills gaps, so it steps back.
 */
export function protocolExpectationCovered(
  expectation: Expectation,
  live: readonly Expectation[],
  catalog: Catalog,
): boolean {
  const origin = catalog.definition(expectation.ruleId)?.protocol;
  const item = catalog.protocols
    .find((protocol) => protocol.id === origin?.id)
    ?.items.find((candidate) => candidate.key === origin?.itemKey);
  return (
    item !== undefined &&
    live.some(
      (other) => other.id !== expectation.id && coversItem(other, item, expectation.matchKey),
    )
  );
}

/** Why a protocol item did not produce an expectation. Useful in reports and tests. */
export type ProtocolSkipReason = 'already_expected' | 'covered_by_plan';

export interface ProtocolEvaluation {
  readonly drafts: readonly ExpectationDraft[];
  readonly skipped: readonly { readonly ruleId: string; readonly reason: ProtocolSkipReason }[];
}

/**
 * Protocol layer, applied after the doctor's plan: for each protocol the
 * patient is enrolled in (by a confirmed or probable condition), each item
 * is expected `everyDays` after the last time it happened (or after
 * enrollment). An item is skipped when it is already expected, or when the
 * doctor's plan or a universal rule already asks for the same thing (same
 * match key, a code of the item's equivalence group, or an uncoded plan item
 * that names the test): the protocol only fills gaps.
 */
export function protocolDrafts(input: {
  readonly catalog: Catalog;
  readonly conditions: readonly PatientCondition[];
  readonly timeline: PatientTimeline;
  readonly live: readonly Expectation[];
  readonly now: Date;
}): ProtocolEvaluation {
  const drafts: ExpectationDraft[] = [];
  const skipped: { ruleId: string; reason: ProtocolSkipReason }[] = [];
  for (const protocol of input.catalog.protocols) {
    const [enrolledBy] = enrollingConditions(protocol, input.conditions).sort(
      (left, right) => Number(right.status === 'confirmed') - Number(left.status === 'confirmed'),
    );
    if (enrolledBy === undefined) {
      continue;
    }
    for (const item of protocol.items) {
      const draft = itemDraft(protocol, item.key, enrolledBy, input);
      if (draft === undefined) {
        continue;
      }
      const ruleId = draft.definition.ruleId;
      if (input.live.some((expectation) => expectation.ruleId === ruleId)) {
        skipped.push({ ruleId, reason: 'already_expected' });
      } else if (input.live.some((expectation) => coversItem(expectation, item, draft.matchKey))) {
        skipped.push({ ruleId, reason: 'covered_by_plan' });
      } else {
        drafts.push(draft);
      }
    }
  }
  return { drafts, skipped };
}

function itemDraft(
  protocol: Protocol,
  itemKey: string,
  enrolledBy: PatientCondition,
  input: { readonly catalog: Catalog; readonly timeline: PatientTimeline; readonly now: Date },
): ExpectationDraft | undefined {
  const item = protocol.items.find((candidate) => candidate.key === itemKey);
  const definition = item && input.catalog.definition(protocolRuleId(protocol, item));
  if (definition === undefined || item === undefined) {
    return undefined;
  }
  const last = latestFulfillingEvent(definition, input.timeline);
  const enrollment = input.timeline.bySource(enrolledBy.source);
  const anchorAt = last === undefined ? (enrollment?.occurredAt ?? input.now) : eventInstant(last);
  const source = last?.source ?? enrolledBy.source;
  return {
    definition,
    source,
    matchKey: matchKeyFor(item.kind, definition.code),
    dueAt: addDays(anchorAt, item.everyDays),
    idempotencyKey: expectationIdempotencyKey(source, definition.ruleId),
  };
}
