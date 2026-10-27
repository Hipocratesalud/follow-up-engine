import type {
  ClinicalEvent,
  PlanExtractedEvent,
  PlanItem,
} from '../../../domain/clinical-event.ts';
import type { Catalog } from '../../catalog.ts';
import { matchesFilter } from '../../matching/filter.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { dateKey } from '../../support/time.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';

/**
 * Doctor's plan layer: one expectation per item of the plan the doctor wrote
 * ("control en 3 meses"), due when the note says. The item's kind and code
 * decide what fulfills it; a doctor's-plan rule's trigger filter applies to
 * the plan item (`{ "kind": "lab" }`).
 */
export function doctorPlanDrafts(
  events: readonly ClinicalEvent[],
  catalog: Catalog,
  minConfidence: number,
): ExpectationDraft[] {
  const plans = events.filter(
    (event): event is PlanExtractedEvent => event.type === 'plan.extracted',
  );
  const drafts: ExpectationDraft[] = [];
  for (const rule of catalog.rulesOfLayer('doctor_plan')) {
    const definition = catalog.definition(rule.id);
    if (definition === undefined || rule.trigger.event !== 'plan.extracted') {
      continue;
    }
    for (const plan of plans) {
      for (const item of plan.items) {
        if (item.confidence < minConfidence || !matchesFilter(rule.trigger.filter, item)) {
          continue;
        }
        drafts.push({
          definition,
          source: plan.source,
          matchKey: matchKeyFor(item.kind, item.code),
          dueAt: item.dueAt,
          idempotencyKey: expectationIdempotencyKey(
            plan.source,
            rule.id,
            planItemDiscriminator(item),
          ),
          evidence: { quote: item.evidenceQuote, sourceDocumentId: plan.sourceDocumentId },
        });
      }
    }
  }
  return drafts;
}

/** Stable across re-extractions that return the same items in another order. */
function planItemDiscriminator(item: PlanItem): string {
  return `${matchKeyFor(item.kind, item.code)}@${dateKey(item.dueAt)}`;
}
