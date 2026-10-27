import type { Rule } from '../../../config/rule.ts';
import type { ClinicalEvent } from '../../../domain/clinical-event.ts';
import type { Catalog, ExpectationDefinition } from '../../catalog.ts';
import { matchesFilter } from '../../matching/filter.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { codeOfEvent } from '../../matching/correlation.ts';
import { addDays } from '../../support/time.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';

function dueAtFor(rule: Rule, event: ClinicalEvent): Date | undefined {
  if (rule.dueFrom === 'treatment_end') {
    if (event.type !== 'medication.prescribed' || event.durationDays === undefined) {
      return undefined;
    }
    return addDays(event.startAt, event.durationDays + rule.dueInDays);
  }
  return addDays(event.occurredAt, rule.dueInDays);
}

function draftFor(
  rule: Rule,
  definition: ExpectationDefinition,
  event: ClinicalEvent,
): ExpectationDraft | undefined {
  const dueAt = dueAtFor(rule, event);
  if (dueAt === undefined) {
    return undefined;
  }
  return {
    definition,
    source: event.source,
    matchKey: matchKeyFor(definition.expects ?? 'follow_up_visit', codeOfEvent(event)),
    dueAt,
    idempotencyKey: expectationIdempotencyKey(event.source, rule.id),
  };
}

/**
 * Universal layer: deterministic rules over structured data, no LLM. An
 * order expects its result, a short treatment expects a control visit, an
 * abnormal result expects a consultation.
 */
export function universalDrafts(
  events: readonly ClinicalEvent[],
  catalog: Catalog,
): ExpectationDraft[] {
  const drafts: ExpectationDraft[] = [];
  for (const rule of catalog.rulesOfLayer('universal')) {
    const definition = catalog.definition(rule.id);
    if (definition === undefined) {
      continue;
    }
    for (const event of events) {
      if (event.type !== rule.trigger.event || !matchesFilter(rule.trigger.filter, event)) {
        continue;
      }
      const draft = draftFor(rule, definition, event);
      if (draft !== undefined) {
        drafts.push(draft);
      }
    }
  }
  return drafts;
}
