import type { Protocol, ProtocolItem } from '../../../config/protocol.ts';
import type { PatientCondition } from '../../../domain/condition.ts';
import type { Expectation } from '../../../domain/expectation.ts';
import { type Catalog, protocolRuleId } from '../../catalog.ts';
import { codeMatchKey, matchKeyFor } from '../../matching/match-key.ts';
import { type ProtocolEpisode, protocolEpisode } from '../../protocols/episodes.ts';
import { scheduleItem } from '../../protocols/schedule.ts';
import { containsPhrase } from '../../support/text.ts';
import type { PatientTimeline } from '../../timeline.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';

/** Layers whose expectations are explicit enough to make a protocol item redundant. */
const COVERING_LAYERS: ReadonlySet<Expectation['layer']> = new Set(['doctor_plan', 'universal']);

/**
 * Match keys that ask for the same test as a protocol item: its own code and
 * every code its `fulfilledBy` filters accept (the item's equivalence group:
 * any lipid panel LOINC covers the lipid item).
 */
export function equivalentMatchKeys(item: ProtocolItem, matchKey: string): Set<string> {
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

/**
 * Why a protocol item did not produce an expectation. Useful in reports and
 * tests. `covered_by_protocol`: another protocol already expects the same
 * test no later (a diabetic on a statin gets one lipid panel, not two).
 */
export type ProtocolSkipReason = 'already_expected' | 'covered_by_plan' | 'covered_by_protocol';

export interface ProtocolEvaluation {
  readonly drafts: readonly ExpectationDraft[];
  readonly skipped: readonly { readonly ruleId: string; readonly reason: ProtocolSkipReason }[];
  /**
   * Open protocol expectations a draft replaces because it is due sooner:
   * the same item after a treatment change (a new dose restarts the 2-4
   * week control), or the same test another protocol expected later. The
   * annotator supersedes them (`rescheduled_by_protocol`).
   */
  readonly replaced: readonly Expectation[];
}

/** A protocol expectation in play during one evaluation: live, or drafted by it. */
interface PlannedTest {
  readonly ruleId: string;
  readonly protocolId: string | undefined;
  readonly matchKey: string;
  readonly dueAt: Date;
  /** Every match key asking for the same test (its equivalence group). */
  readonly keys: ReadonlySet<string>;
  /** The live expectation, absent for a draft of this evaluation. */
  readonly expectation?: Expectation;
}

/** The protocol item behind a protocol rule id, if still in the catalog. */
function itemOfRule(catalog: Catalog, ruleId: string): ProtocolItem | undefined {
  const origin = catalog.definition(ruleId)?.protocol;
  return catalog.protocols
    .find((protocol) => protocol.id === origin?.id)
    ?.items.find((item) => item.key === origin?.itemKey);
}

/**
 * Protocol layer, applied after the doctor's plan: for each protocol the
 * patient is in (an active episode, or an ended one for its after-outcome
 * items), each item is expected when its schedule says (see
 * `scheduleItem`). An item is skipped when it is already expected, when
 * the doctor's plan or a universal rule already asks for the same thing
 * (same match key, a code of the item's equivalence group, or an uncoded
 * plan item that names the test): the protocol only fills gaps; and when
 * another protocol expects the same test no later.
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
  const replaced = new Map<string, Expectation>();
  const planned: PlannedTest[] = input.live.flatMap((expectation) => {
    const item =
      expectation.layer === 'protocol' ? itemOfRule(input.catalog, expectation.ruleId) : undefined;
    return item?.code === undefined
      ? []
      : [
          {
            ruleId: expectation.ruleId,
            protocolId: expectation.protocolId,
            matchKey: expectation.matchKey,
            dueAt: expectation.dueAt,
            keys: equivalentMatchKeys(item, expectation.matchKey),
            expectation,
          },
        ];
  });
  for (const protocol of input.catalog.protocols) {
    const episode = protocolEpisode(protocol, input.conditions, input.timeline);
    if (episode === undefined) {
      continue;
    }
    for (const item of protocol.items) {
      const draft = itemDraft(protocol, item, episode, input);
      if (draft === undefined) {
        continue;
      }
      const ruleId = draft.definition.ruleId;
      const sameItem = input.live.filter((expectation) => expectation.ruleId === ruleId);
      const sooner = sameItem.every(
        (expectation) =>
          expectation.status === 'open' &&
          expectation.idempotencyKey !== draft.idempotencyKey &&
          draft.dueAt.getTime() < expectation.dueAt.getTime(),
      );
      if (sameItem.length > 0 && !sooner) {
        skipped.push({ ruleId, reason: 'already_expected' });
        continue;
      }
      if (input.live.some((expectation) => coversItem(expectation, item, draft.matchKey))) {
        skipped.push({ ruleId, reason: 'covered_by_plan' });
        continue;
      }
      const keys = equivalentMatchKeys(item, draft.matchKey);
      const others =
        item.code === undefined
          ? []
          : planned.filter(
              (other) =>
                other.protocolId !== protocol.id &&
                (keys.has(other.matchKey) || other.keys.has(draft.matchKey)),
            );
      if (
        others.some(
          (other) =>
            other.dueAt.getTime() <= draft.dueAt.getTime() ||
            other.expectation?.status === 'expired',
        )
      ) {
        skipped.push({ ruleId, reason: 'covered_by_protocol' });
        continue;
      }
      for (const expectation of sameItem) {
        replaced.set(expectation.id, expectation);
        const index = planned.findIndex((test) => test.expectation === expectation);
        if (index >= 0) {
          planned.splice(index, 1);
        }
      }
      for (const other of others) {
        if (other.expectation === undefined) {
          dropDraft(drafts, other.ruleId);
        } else {
          replaced.set(other.expectation.id, other.expectation);
        }
        planned.splice(planned.indexOf(other), 1);
      }
      drafts.push(draft);
      if (item.code !== undefined) {
        planned.push({
          ruleId,
          protocolId: protocol.id,
          matchKey: draft.matchKey,
          dueAt: draft.dueAt,
          keys,
        });
      }
    }
  }
  return { drafts, skipped, replaced: [...replaced.values()] };
}

/** Removes this evaluation's draft of a rule (another protocol's draft due sooner replaces it). */
function dropDraft(drafts: ExpectationDraft[], ruleId: string): void {
  const index = drafts.findIndex((draft) => draft.definition.ruleId === ruleId);
  if (index >= 0) {
    drafts.splice(index, 1);
  }
}

function itemDraft(
  protocol: Protocol,
  item: ProtocolItem,
  episode: ProtocolEpisode,
  input: {
    readonly catalog: Catalog;
    readonly conditions: readonly PatientCondition[];
    readonly timeline: PatientTimeline;
    readonly now: Date;
  },
): ExpectationDraft | undefined {
  const definition = input.catalog.definition(protocolRuleId(protocol, item));
  if (definition === undefined) {
    return undefined;
  }
  const scheduled = scheduleItem({
    item,
    definition,
    episode,
    conditions: input.conditions,
    timeline: input.timeline,
    now: input.now,
  });
  if (scheduled === undefined) {
    return undefined;
  }
  return {
    definition,
    source: scheduled.anchor,
    matchKey: matchKeyFor(item.kind, definition.code),
    dueAt: scheduled.dueAt,
    idempotencyKey: expectationIdempotencyKey(scheduled.anchor, definition.ruleId),
  };
}
