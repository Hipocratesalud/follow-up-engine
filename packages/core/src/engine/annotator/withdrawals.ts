import {
  type ClinicalEvent,
  type PlanExtractedEvent,
  RETRACTING_WITHDRAWAL_REASONS,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { PatientState } from '../patient-state.ts';
import { refKey } from '../timeline.ts';
import { enrollingConditions } from './conditions.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';
import type { ExpectationDraft } from './draft.ts';

/** `Expectation.closedReason` of an expectation whose source was withdrawn (cancelled, revoked, in error). */
export const SOURCE_WITHDRAWN = 'source_withdrawn';
/** `Expectation.closedReason` of a plan item the doctor's amended note no longer asks for. */
export const SUPERSEDED_BY_AMENDED_NOTE = 'superseded_by_amended_note';

/**
 * Resources the batch withdraws, with the event that withdrew each:
 * cancelled, no-show or erroneous bookings, and every `record.withdrawn`.
 */
export function withdrawnSources(events: readonly ClinicalEvent[]): Map<string, ClinicalEvent> {
  const withdrawn = new Map<string, ClinicalEvent>();
  for (const event of events) {
    if (event.type === 'appointment.cancelled' || event.type === 'record.withdrawn') {
      withdrawn.set(refKey(event.source), event);
    }
  }
  return withdrawn;
}

/**
 * Expectations triggered by a withdrawn resource (the result an order no
 * longer waits for, the control after a treatment that was stopped, the
 * protocol's next visit counted from a booking that was cancelled) have
 * nothing to stand on: they are cancelled (`source_withdrawn`). The layers
 * that run next re-create what is still due from what remains.
 */
export async function cancelWithdrawn(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
): Promise<ClosedExpectation[]> {
  const withdrawn = withdrawnSources(events);
  const closed: ClosedExpectation[] = [];
  if (withdrawn.size === 0) {
    return closed;
  }
  for (const expectation of state.live.list()) {
    const by = withdrawn.get(refKey(expectation.source));
    if (by === undefined) {
      continue;
    }
    const next = await closeExpectation(
      context.stores,
      expectation,
      'cancelled',
      SOURCE_WITHDRAWN,
      context.now,
      by.source,
    );
    state.live.put(next);
    closed.push({ expectation: next, closedBy: by.type });
  }
  return closed;
}

/**
 * A diagnosis refuted or entered in error (or moved to another patient)
 * no longer stands: the condition it alone recorded is `resolved` unless a
 * clinician reviewed it (a review is never overridden by automation), and
 * the protocol expectations of every protocol the patient is no longer
 * enrolled in are cancelled (`source_withdrawn`).
 *
 * @returns the conditions it resolved and the expectations it cancelled.
 */
export async function withdrawConditions(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
  conditions: PatientCondition[],
): Promise<{
  readonly resolved: readonly PatientCondition[];
  readonly closed: readonly ClosedExpectation[];
}> {
  const retracted = new Map<string, ClinicalEvent>();
  for (const event of events) {
    if (event.type === 'record.withdrawn' && RETRACTING_WITHDRAWAL_REASONS.has(event.reason)) {
      retracted.set(refKey(event.source), event);
    }
  }
  const resolved: PatientCondition[] = [];
  const closed: ClosedExpectation[] = [];
  if (retracted.size === 0) {
    return { resolved, closed };
  }
  let by: ClinicalEvent | undefined;
  for (const [index, condition] of conditions.entries()) {
    const withdrawal = retracted.get(refKey(condition.source));
    if (
      withdrawal === undefined ||
      condition.confirmedBy !== undefined ||
      condition.status === 'resolved'
    ) {
      continue;
    }
    const next: PatientCondition = {
      ...condition,
      status: 'resolved',
      confidence: 0,
      updatedAt: context.now,
    };
    await context.stores.conditions.upsert(context.clinicId, next);
    conditions[index] = next;
    resolved.push(next);
    by = withdrawal;
  }
  if (by === undefined) {
    return { resolved, closed };
  }
  const enrolled = new Set(
    context.catalog.protocols
      .filter((protocol) => enrollingConditions(protocol, conditions).length > 0)
      .map((protocol) => protocol.id),
  );
  const known = new Set(context.catalog.protocols.map((protocol) => protocol.id));
  for (const expectation of state.live.list()) {
    const protocolId = expectation.protocolId;
    if (protocolId === undefined || !known.has(protocolId) || enrolled.has(protocolId)) {
      continue;
    }
    const next = await closeExpectation(
      context.stores,
      expectation,
      'cancelled',
      SOURCE_WITHDRAWN,
      context.now,
      by.source,
    );
    state.live.put(next);
    closed.push({ expectation: next, closedBy: by.type });
  }
  return { resolved, closed };
}

/**
 * The doctor amended a note (a new version of it, or a note that `replaces`
 * it): its plan is the one that stands. Live plan items of the earlier
 * version that the new plan does not ask for again (same item, same date)
 * are superseded (`superseded_by_amended_note`); the new items were just
 * created by the doctor's-plan layer.
 */
export async function supersedeAmendedPlans(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
  drafts: readonly ExpectationDraft[],
): Promise<ClosedExpectation[]> {
  const plans = events.filter(
    (event): event is PlanExtractedEvent => event.type === 'plan.extracted',
  );
  const closed: ClosedExpectation[] = [];
  if (plans.length === 0) {
    return closed;
  }
  const kept = new Set(drafts.map((draft) => draft.idempotencyKey));
  for (const plan of plans) {
    const replaced = new Set([plan.sourceDocumentId, ...(plan.replacesDocumentIds ?? [])]);
    for (const expectation of state.live.list()) {
      if (
        expectation.layer !== 'doctor_plan' ||
        !replaced.has(expectation.source.id) ||
        expectation.source.resourceType !== plan.source.resourceType ||
        kept.has(expectation.idempotencyKey)
      ) {
        continue;
      }
      const next = await closeExpectation(
        context.stores,
        expectation,
        'superseded',
        SUPERSEDED_BY_AMENDED_NOTE,
        context.now,
        plan.source,
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: plan.type });
    }
  }
  return closed;
}
