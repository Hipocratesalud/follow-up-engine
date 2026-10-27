import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import type { LiveExpectations } from '../patient-state.ts';
import { encounterOf, type PatientTimeline } from '../timeline.ts';
import { dischargedEncounters } from './layers/cadence.ts';
import { protocolExpectationCovered } from './layers/protocol.ts';
import { coveredByPlannedItem, plannedItems } from './layers/universal.ts';
import { hasConditionalReturn } from './treatment.ts';

/** Machine reasons (`closedReason`) of an expectation withdrawn by information that came after it. */
export const RETRACTION_REASONS = {
  /** The note discharged the patient: no visit pattern after it. */
  discharged: 'patient_discharged',
  /** The note makes the return conditional ("reconsultar si persiste"). */
  conditionalReturn: 'conditional_return',
  /** The doctor's plan asks for the same thing (it beats the generic rule). */
  coveredByPlan: 'covered_by_plan',
  /** A later order or plan item asks for what the protocol expected: it only fills gaps. */
  coveredByLaterRequest: 'covered_by_later_request',
} as const;

/** Why `expectation` no longer applies given what the record says now, if it does not. */
function retractionReason(
  expectation: Expectation,
  catalog: Catalog,
  timeline: PatientTimeline,
  discharged: ReadonlySet<string>,
  planned: ReturnType<typeof plannedItems>,
  live: readonly Expectation[],
): string | undefined {
  if (expectation.layer === 'protocol') {
    return protocolExpectationCovered(expectation, live, catalog)
      ? RETRACTION_REASONS.coveredByLaterRequest
      : undefined;
  }
  const anchor = timeline.bySource(expectation.source);
  if (anchor === undefined) {
    return undefined;
  }
  if (expectation.layer === 'cadence') {
    const encounterId = encounterOf(anchor);
    return encounterId !== undefined && discharged.has(encounterId)
      ? RETRACTION_REASONS.discharged
      : undefined;
  }
  if (expectation.layer !== 'universal') {
    return undefined;
  }
  const rule = catalog.rules.find((candidate) => candidate.id === expectation.ruleId);
  if (rule === undefined) {
    return undefined;
  }
  if (
    rule.treatment !== undefined &&
    anchor.type === 'medication.prescribed' &&
    hasConditionalReturn(anchor.encounterId, timeline, rule.treatment)
  ) {
    return RETRACTION_REASONS.conditionalReturn;
  }
  return rule.coveredByPlan === true && coveredByPlannedItem(expectation, anchor, planned)
    ? RETRACTION_REASONS.coveredByPlan
    : undefined;
}

/**
 * The same decisions the layers take when everything arrives together,
 * applied when the deciding information comes later (a note sent after its
 * consultation, a plan read by a retried extraction, a later order): a
 * discharge withdraws the visit pattern it anchored, a conditional return or
 * the doctor's own plan withdraws the generic control, and an order or plan
 * item of the same test or visit withdraws the protocol item (protocols only
 * fill gaps). Only runs for batches that bring a note, a plan or an order;
 * withdrawn expectations are `cancelled` and their cases resolve like any
 * other closed reason.
 */
export async function retractByLaterInformation(input: {
  readonly stores: TransactionalStores;
  readonly catalog: Catalog;
  readonly now: Date;
  readonly timeline: PatientTimeline;
  readonly live: LiveExpectations;
  readonly batch: readonly ClinicalEvent[];
}): Promise<{ readonly expectation: Expectation; readonly closedBy: ClinicalEvent['type'] }[]> {
  const bringsRequest = input.batch.some(
    (event) =>
      event.type === 'note.received' ||
      event.type === 'plan.extracted' ||
      event.type === 'service_request.created',
  );
  if (!bringsRequest) {
    return [];
  }
  const current = input.live.list();
  const discharged = dischargedEncounters(input.timeline);
  const planned = plannedItems(current, []);
  const ordered = input.batch.some((event) => event.type === 'service_request.created');
  const closed: { expectation: Expectation; closedBy: ClinicalEvent['type'] }[] = [];
  for (const expectation of current) {
    const reason = retractionReason(
      expectation,
      input.catalog,
      input.timeline,
      discharged,
      planned,
      current,
    );
    if (reason === undefined) {
      continue;
    }
    const next = await closeExpectation(input.stores, expectation, 'cancelled', reason, input.now);
    input.live.put(next);
    closed.push({
      expectation: next,
      closedBy:
        reason === RETRACTION_REASONS.conditionalReturn
          ? 'note.received'
          : reason === RETRACTION_REASONS.coveredByLaterRequest && ordered
            ? 'service_request.created'
            : 'plan.extracted',
    });
  }
  return closed;
}
