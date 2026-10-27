import {
  type ClinicalEvent,
  type PlanExtractedEvent,
  type RecordWithdrawnEvent,
  RETRACTING_WITHDRAWAL_REASONS,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import { sameCoding } from '../matching/match-key.ts';
import type { PatientState } from '../patient-state.ts';
import { type PatientTimeline, refKey } from '../timeline.ts';
import { itemApplies, protocolEpisode } from '../protocols/episodes.ts';
import { mergeCondition, recordedCandidate } from './conditions.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';
import { type ExpectationDraft, movedIdempotencyKey } from './draft.ts';

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
 * A protocol expectation counted from the diagnosis that enrolled the
 * patient: whether it goes depends on the enrollment, not on that one
 * record (another record of the diagnosis may keep the patient enrolled),
 * so {@link withdrawConditions} decides.
 */
function anchoredOnDiagnosis(expectation: Expectation): boolean {
  return expectation.protocolId !== undefined && expectation.source.resourceType === 'Condition';
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
    if (by === undefined || anchoredOnDiagnosis(expectation)) {
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
 * What a patient condition becomes when the record it rested on is
 * withdrawn: re-derived from the records of the same diagnosis that still
 * stand (a duplicate of the diagnosis, a note that mentions it), else
 * `rejected` when the host refuted it (the patient does not have it) or
 * `entered_in_error` when it was entered in error or moved to another
 * patient (it was never this patient's).
 */
function afterWithdrawal(
  condition: PatientCondition,
  withdrawal: RecordWithdrawnEvent,
  timeline: PatientTimeline,
  now: Date,
): PatientCondition {
  const remaining = timeline
    .ofType('condition.recorded')
    .filter((event) => sameCoding(event.code, condition.code))
    .map((event) => recordedCandidate(event, new Map()));
  let next: PatientCondition | undefined;
  for (const candidate of remaining) {
    next = mergeCondition(next, candidate, { ...condition, now }) ?? next;
  }
  if (next !== undefined) {
    return next;
  }
  return {
    ...condition,
    status: withdrawal.reason === 'refuted' ? 'rejected' : 'entered_in_error',
    confidence: 0,
    updatedAt: now,
  };
}

/**
 * A diagnosis refuted or entered in error (or moved to another patient) no
 * longer stands. The condition it recorded is decided again from the
 * records of the same diagnosis that remain (another record of it keeps the
 * patient enrolled, whichever is withdrawn first); with none left it is
 * `rejected` (refuted by the host) or `entered_in_error`. A clinician's
 * review is never overridden by automation. The protocol expectations
 * that no longer apply (the patient is no longer in that protocol) are
 * cancelled (`source_withdrawn`).
 *
 * @returns the conditions it changed and the expectations it cancelled.
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
  const retracted = new Map<string, RecordWithdrawnEvent>();
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
      condition.status === 'resolved' ||
      condition.status === 'rejected' ||
      condition.status === 'entered_in_error'
    ) {
      continue;
    }
    const next = afterWithdrawal(condition, withdrawal, state.timeline, context.now);
    await context.stores.conditions.upsert(context.clinicId, next);
    conditions[index] = next;
    resolved.push(next);
    by = withdrawal;
  }
  if (by === undefined) {
    return { resolved, closed };
  }
  const episodes = new Map(
    context.catalog.protocols.map((protocol) => [
      protocol.id,
      { protocol, episode: protocolEpisode(protocol, conditions, state.timeline) },
    ]),
  );
  for (const expectation of state.live.list()) {
    const entry =
      expectation.protocolId === undefined ? undefined : episodes.get(expectation.protocolId);
    const itemKey = context.catalog.definition(expectation.ruleId)?.protocol?.itemKey;
    const item = entry?.protocol.items.find((candidate) => candidate.key === itemKey);
    if (entry === undefined || item === undefined || itemApplies(item, entry.episode)) {
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
  // What the new plan asks for again stays, also under the key it takes on
  // a patient the note was moved to (its subject was corrected).
  const kept = new Set(
    drafts.flatMap((draft) => [
      draft.idempotencyKey,
      movedIdempotencyKey(draft.idempotencyKey, context.patientId),
    ]),
  );
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
