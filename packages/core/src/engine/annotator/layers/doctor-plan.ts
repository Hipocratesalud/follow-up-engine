import type {
  ClinicalEvent,
  PlanExtractedEvent,
  PlanItem,
  PlanItemKind,
} from '../../../domain/clinical-event.ts';
import type { Coding } from '../../../domain/resource.ts';
import type { Catalog } from '../../catalog.ts';
import { matchesFilter } from '../../matching/filter.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { dateKey } from '../../support/time.ts';
import { orderCodingOf, type TestGroup, testGroupsNamedIn } from '../../terminology/test-names.ts';
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
        const asked = askedTest(item);
        drafts.push({
          definition,
          source: plan.source,
          matchKey: matchKeyFor(asked.kind, asked.code),
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

/**
 * The test a plan item asks for when the extraction left it uncoded but its
 * quote names it: "pendiente HbA1c, creatinina y microalbuminuria" read as
 * a creatinine item is creatinine (LOINC 2160-0), so only a creatinine
 * result fulfills it and it lines up with the creatinine order of the same
 * note. The model's description picks the test when the quote names
 * several; with no single test it stays uncoded. An eye fundus exam read as
 * "other" ("y fondo de ojo") is the fundus procedure, never fulfilled by a
 * visit.
 */
export function askedTest(item: PlanItem): { readonly kind: PlanItemKind; readonly code?: Coding } {
  if (item.code !== undefined) {
    return { kind: item.kind, code: item.code };
  }
  if (item.kind === 'lab' || item.kind === 'imaging') {
    const named = testGroupsNamedIn(item.evidenceQuote, item.kind);
    const described = testGroupsNamedIn(item.description, item.kind);
    const both = named.filter((group) => described.some((other) => other.id === group.id));
    const code = codeOfSingle(both.length > 0 ? both : named);
    return code === undefined ? { kind: item.kind } : { kind: item.kind, code };
  }
  if (item.kind === 'other') {
    const procedures = testGroupsNamedIn(item.evidenceQuote).filter(
      (group) => group.code !== undefined,
    );
    const [procedure] = procedures;
    const code = codeOfSingle(procedures);
    return procedure === undefined || code === undefined
      ? { kind: item.kind }
      : { kind: procedure.kind, code };
  }
  return { kind: item.kind };
}

function codeOfSingle(groups: readonly TestGroup[]): Coding | undefined {
  const [group] = groups;
  return groups.length === 1 && group !== undefined ? orderCodingOf(group) : undefined;
}

/** Stable across re-extractions that return the same items in another order. */
function planItemDiscriminator(item: PlanItem): string {
  return `${matchKeyFor(item.kind, item.code)}@${dateKey(item.dueAt)}`;
}
