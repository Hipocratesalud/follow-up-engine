import type { Protocol } from '../../../config/protocol.ts';
import type { ClinicalEvent } from '../../../domain/clinical-event.ts';
import type { PatientCondition } from '../../../domain/condition.ts';
import type { Expectation } from '../../../domain/expectation.ts';
import { type Catalog, type ExpectationDefinition, protocolRuleId } from '../../catalog.ts';
import { matchesShape } from '../../matching/correlation.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
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
    const matches = definition.fulfilledBy.some((correlation) =>
      matchesShape(correlation, event, definition.code),
    );
    if (matches && (latest === undefined || eventInstant(event) >= eventInstant(latest))) {
      latest = event;
    }
  }
  return latest;
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
 * match key): the protocol only fills gaps.
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
      } else if (
        input.live.some(
          (expectation) =>
            COVERING_LAYERS.has(expectation.layer) && expectation.matchKey === draft.matchKey,
        )
      ) {
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
