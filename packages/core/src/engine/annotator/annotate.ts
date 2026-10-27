import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Origin } from '../../domain/common.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { type CaseId, type ExpectationId, expectationId } from '../../domain/ids.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import {
  findFulfillment,
  fulfillmentReason,
  type MatchContext,
  supersedes,
  toCorrelationTarget,
} from '../matching/correlation.ts';
import {
  asOpen,
  loadPatientState,
  type LiveExpectations,
  type PatientState,
} from '../patient-state.ts';
import { type PatientTimeline, refKey } from '../timeline.ts';
import { conditionCandidates, mergeCondition } from './conditions.ts';
import type { AnnotationContext, AnnotationHints, ClosedExpectation } from './context.ts';
import { endEpisodes, RESCHEDULED_BY_PROTOCOL } from './episodes.ts';
import { type ExpectationDraft, materializeExpectation, movedIdempotencyKey } from './draft.ts';
import { cadenceDrafts } from './layers/cadence.ts';
import { doctorPlanDrafts } from './layers/doctor-plan.ts';
import { protocolDrafts } from './layers/protocol.ts';
import { plannedItems, universalDrafts } from './layers/universal.ts';
import { suppressedRuleIds } from '../suppression/active.ts';
import { recheckAtFor, recheckFulfilled } from './recheck.ts';
import { bookingOriginsOf, recordCaseBookings } from '../attribution/attribution.ts';
import { retractByLaterInformation } from './retract.ts';
import { oneRequestPerTest } from './test-requests.ts';
import {
  cancelWithdrawn,
  supersedeAmendedPlans,
  withdrawConditions,
  withdrawnSources,
} from './withdrawals.ts';

export type { AnnotationContext, AnnotationHints, ClosedExpectation } from './context.ts';

export interface AnnotationResult {
  readonly expectationsCreated: readonly Expectation[];
  readonly expectationsClosed: readonly ClosedExpectation[];
  /**
   * Fulfilled by something the batch withdrew or changed (a booking
   * cancelled or rescheduled, a visit or result withdrawn): open again (or
   * expired, for the watcher).
   */
  readonly expectationsReopened: readonly Expectation[];
  readonly casesResolved: readonly CaseId[];
  readonly conditionsUpserted: readonly PatientCondition[];
  /**
   * The patient opted out of being contacted. Follow-up goes on for the
   * clinic team; only patient contact stops (see escalation).
   */
  readonly optedOut: boolean;
}

/**
 * Applies a batch of clinical events to a patient, in the order the PRD
 * fixes: conditions → universal rules and doctor's plan → fulfillment and
 * supersession of what was already expected → cadence where no live plan
 * covers it → protocols fill only the gaps left → cases whose reasons all
 * closed are resolved.
 * Idempotent: the same events twice change nothing the second time.
 */
export async function annotate(
  context: AnnotationContext,
  events: readonly ClinicalEvent[],
  hints: AnnotationHints = {},
): Promise<AnnotationResult> {
  const state = await loadPatientState(
    context.stores,
    context.clinicId,
    context.patientId,
    context.asOf,
  );
  const writer = new CaseWriter(context.stores, context.ids, context.clinicId);
  // Rules a clinic user stopped for this patient ("not applicable") create
  // nothing in any layer, live or replayed by the backfill.
  const suppressed = await suppressedRuleIds(context.stores, context.clinicId, context.patientId);
  const create = (drafts: readonly ExpectationDraft[], lateHistory: boolean) =>
    createExpectations(
      context,
      state.live,
      drafts.filter((draft) => !suppressed.has(draft.definition.ruleId)),
      lateHistory,
    );
  // An event of a resource the record withdrew later (a booking cancelled,
  // an order revoked) triggers and fulfills nothing, even delivered again.
  const ordered = [...events]
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .filter((event) => !state.timeline.isWithdrawn(event));

  const conditions = await upsertConditions(context, state, ordered, hints);
  const created: Expectation[] = [];
  const planDrafts = doctorPlanDrafts(
    ordered,
    context.catalog,
    context.settings.minPlanItemConfidence,
  );
  const firstDrafts = [
    ...universalDrafts({
      events: ordered,
      catalog: context.catalog,
      timeline: state.timeline,
      conditions: conditions.all,
      planned: plannedItems(state.live.list(), planDrafts),
    }),
    ...planDrafts,
  ];
  const lateHistory = isLateHistory(context, ordered);
  created.push(...(await create(firstDrafts, lateHistory)));

  // An amended note's plan replaces the earlier version's.
  const closed = await supersedeAmendedPlans(context, state, ordered, firstDrafts);
  // A delivery or a loss ends a pregnancy: nothing prenatal is expected
  // after it (decided before fulfillment, so the delivery's own encounter
  // is never read as the prenatal visit).
  const ended = await endEpisodes(context, state, conditions.all);
  closed.push(...ended.closed);
  closed.push(...(await applyFulfillment(context, state.timeline, state.live, ordered)));
  // One test, one pending request: a plan item and the order of the same
  // visit are one (a newer order of the same
  // test already superseded the old one, `superseded_by_new_order`), and a test asked for again replaces what was asked before.
  closed.push(...(await oneRequestPerTest(context, state.timeline, state.live)));
  // What withdrawn resources triggered goes; what they fulfilled is open again.
  closed.push(...(await cancelWithdrawn(context, state, ordered)));
  const unenrolled = await withdrawConditions(context, state, ordered, conditions.all);
  closed.push(...unenrolled.closed);
  const reopened = await recheckTouched(context, state, ordered);
  // Information that arrives after what it decides (a discharge or a
  // conditional return in a later note, the doctor's own control, an order
  // of the test a protocol expected) withdraws it, as if it came together.
  closed.push(
    ...(await retractByLaterInformation({
      stores: context.stores,
      catalog: context.catalog,
      now: context.now,
      timeline: state.timeline,
      live: state.live,
      batch: ordered,
    })),
  );

  // The doctor's explicit plan beats the inferred visit pattern for what it
  // covers; checked after fulfillment, so a visit that fulfills the plan
  // brings the pattern back.
  const cadence = cadenceDrafts(ordered, state.timeline, context.catalog).filter(
    (draft) => !coveredByPlan(state.live, draft.matchKey),
  );
  const afterFulfillment = await create(cadence, lateHistory);

  const protocols = protocolDrafts({
    catalog: context.catalog,
    conditions: conditions.all,
    timeline: state.timeline,
    live: state.live.list(),
    now: context.now,
  });
  // A protocol schedule moved (gestational age, a dose change): what it
  // replaces closes; the new dates are drafted like any other protocol item
  // and respect this patient's suppressions.
  for (const expectation of protocols.replaced) {
    state.live.put(
      await closeExpectation(
        context.stores,
        expectation,
        'superseded',
        RESCHEDULED_BY_PROTOCOL,
        context.now,
      ),
    );
  }
  afterFulfillment.push(...(await create(protocols.drafts, lateHistory)));
  created.push(...afterFulfillment);
  closed.push(
    ...(await fulfillFromRecord(
      context,
      state,
      created,
      ordered,
      new Set(afterFulfillment.map((expectation) => expectation.id)),
    )),
  );

  // Bookings that concern a case (attributed to it, or fulfilling one of
  // its reasons) go on its trail before it resolves (HIP-141).
  await recordCaseBookings({
    stores: context.stores,
    clinicId: context.clinicId,
    events: ordered,
    closed,
    now: context.now,
  });
  const bookingOrigins = bookingOriginsOf(ordered);

  const casesResolved: CaseId[] = [];
  for (const { expectation } of closed) {
    if (expectation.caseId === undefined) {
      continue;
    }
    casesResolved.push(
      ...(await resolveSatisfiedCases({
        stores: context.stores,
        writer,
        clinicId: context.clinicId,
        caseIds: [expectation.caseId],
        actor: { type: 'rule', id: expectation.ruleId },
        now: context.now,
        bookingOrigins,
      })),
    );
  }

  return {
    expectationsCreated: created,
    expectationsClosed: closed,
    expectationsReopened: reopened,
    casesResolved,
    conditionsUpserted: [...conditions.upserted, ...unenrolled.resolved, ...ended.resolved],
    optedOut: state.timeline.optedOut,
  };
}

/**
 * In a replay, whether `expectation`, drafted again by the step at `asOf`,
 * was created by that step (or, live, only once its batch arrived, which is
 * stamped later than the batch's clinical time) and was still open after it.
 */
function createdByThisReplayStep(expectation: Expectation, asOf: Date | undefined): boolean {
  if (asOf === undefined) {
    return false;
  }
  const at = asOf.getTime();
  if (expectation.createdAt.getTime() < at) {
    return false;
  }
  return expectation.closedAt === undefined || expectation.closedAt.getTime() >= at;
}

/**
 * Whether a live doctor's-plan expectation already asks for the same thing.
 * A planned session (psychology, physiotherapy) is the patient's next visit.
 */
function coveredByPlan(live: LiveExpectations, matchKey: string): boolean {
  const asked = matchKey === 'visit' ? new Set(['visit', 'session']) : new Set([matchKey]);
  return live
    .list()
    .some((expectation) => expectation.layer === 'doctor_plan' && asked.has(expectation.matchKey));
}

async function upsertConditions(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
  hints: AnnotationHints,
): Promise<{ readonly all: PatientCondition[]; readonly upserted: PatientCondition[] }> {
  const upserted: PatientCondition[] = [];
  const byKey = new Map(
    state.conditions.map((condition) => [
      `${condition.code.system}|${condition.code.code}`,
      condition,
    ]),
  );
  const candidates = conditionCandidates({
    events,
    protocols: context.catalog.protocols,
    existing: state.conditions,
    extractedConfidence: hints.extractedConfidence ?? new Map(),
    extractedMedications: hints.extractedMedications ?? [],
    history: state.timeline.events,
  });
  for (const candidate of candidates) {
    const key = `${candidate.code.system}|${candidate.code.code}`;
    const merged = mergeCondition(byKey.get(key), candidate, context);
    if (merged !== undefined) {
      await context.stores.conditions.upsert(context.clinicId, merged);
      byKey.set(key, merged);
      upserted.push(merged);
    }
  }
  return { all: [...byKey.values()], upserted };
}

const MS_PER_DAY = 86_400_000;

/** Facts the engine derived itself (a note's plan and conditions), not dated by the host. */
function isDerived(event: ClinicalEvent): boolean {
  return event.type === 'plan.extracted' || event.idempotencyKey.includes('::');
}

/**
 * Facts about the patient rather than their care (a preferred language, an
 * opt-out): dated by the Patient's `meta.lastUpdated`, else by when the
 * Bundle arrived, so they never tell how old the clinical history is.
 */
function isPatientProfile(event: ClinicalEvent): boolean {
  return event.type === 'patient.language_recorded' || event.type === 'patient.opted_out';
}

/**
 * Whether a live batch is old history (its newest clinical date is more than
 * `lateHistoryDays` before it arrived): a two-year-old order sent today.
 */
function isLateHistory(context: AnnotationContext, batch: readonly ClinicalEvent[]): boolean {
  if ((context.origin ?? 'live') !== 'live' || context.asOf !== undefined) {
    return false;
  }
  const dated = batch.filter((event) => !isDerived(event) && !isPatientProfile(event));
  if (dated.length === 0) {
    return false;
  }
  const newest = Math.max(...dated.map((event) => event.occurredAt.getTime()));
  return context.now.getTime() - newest > context.settings.lateHistoryDays * MS_PER_DAY;
}

/**
 * Origin of a new expectation: the run's, except that what old history sent
 * through live ingestion leaves already overdue is routed like the backfill
 * (`backfill`): it never contacts the patient automatically and, overdue
 * beyond the clinic's notify window, is held among the patients to recover
 * (see the watcher).
 */
function originOf(
  context: AnnotationContext,
  draft: ExpectationDraft,
  lateHistory: boolean,
): Origin {
  const origin = context.origin ?? 'live';
  return lateHistory && draft.dueAt.getTime() <= context.now.getTime() ? 'backfill' : origin;
}

async function createExpectations(
  context: AnnotationContext,
  live: LiveExpectations,
  drafts: readonly ExpectationDraft[],
  lateHistory = false,
): Promise<Expectation[]> {
  const created: Expectation[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.idempotencyKey)) {
      continue;
    }
    seen.add(draft.idempotencyKey);
    const candidate = materializeExpectation(draft, {
      id: expectationId(context.ids.next('expectation')),
      clinicId: context.clinicId,
      patientId: context.patientId,
      now: context.now,
      origin: originOf(context, draft, lateHistory),
    });
    let result = await context.stores.expectations.upsertByIdempotencyKey(
      context.clinicId,
      candidate,
    );
    if (!result.created && result.expectation.patientId !== context.patientId) {
      // The resource was first sent for another patient and its subject was
      // corrected since (that patient's expectation was withdrawn): this
      // patient gets an expectation of its own.
      result = await context.stores.expectations.upsertByIdempotencyKey(context.clinicId, {
        ...candidate,
        idempotencyKey: movedIdempotencyKey(draft.idempotencyKey, context.patientId),
      });
    }
    if (result.created) {
      created.push(result.expectation);
      live.put(result.expectation);
    } else if (createdByThisReplayStep(result.expectation, context.asOf)) {
      // Replaying again: this step created it the first time, so the rest of
      // the step must see it in play, exactly as it did then.
      live.put(asOpen(result.expectation));
    }
  }
  return created;
}

/**
 * Closes live expectations the batch satisfies or replaces. Supersession is
 * checked first: a newer order of the same test retires the old expectation
 * (and its case) and starts a new clock through its own expectation.
 */
async function applyFulfillment(
  context: AnnotationContext,
  timeline: PatientTimeline,
  live: LiveExpectations,
  events: readonly ClinicalEvent[],
): Promise<ClosedExpectation[]> {
  const closed: ClosedExpectation[] = [];
  for (const event of events) {
    for (const expectation of live.list()) {
      const definition = context.catalog.definition(expectation.ruleId);
      if (definition === undefined) {
        continue;
      }
      const target = toCorrelationTarget(expectation, definition, timeline, matchContext(context));
      let next: Expectation | undefined;
      if (supersedes(event, target, timeline)) {
        next = await closeExpectation(
          context.stores,
          expectation,
          'superseded',
          'superseded_by_new_order',
          context.now,
          event.source,
        );
      } else if (findFulfillment(event, target, timeline) !== undefined) {
        next = await closeExpectation(
          context.stores,
          expectation,
          'fulfilled',
          fulfillmentReason(event),
          context.now,
          event.source,
          recheckAtFor(event, context.settings.bookingVisitGraceDays),
        );
      }
      if (next !== undefined) {
        live.put(next);
        closed.push({ expectation: next, closedBy: event.type });
      }
    }
  }
  return closed;
}

/** What a match needs from the annotation: its "now" and the booking grace days. */
function matchContext(context: AnnotationContext): MatchContext {
  return { now: context.now, bookingGraceDays: context.settings.bookingVisitGraceDays };
}

/**
 * Resources the batch changes the standing of: withdrawn (a cancelled,
 * no-show or erroneous booking, any `record.withdrawn`) or replaced by a
 * new version (a rescheduled booking).
 */
function touchedSources(events: readonly ClinicalEvent[]): Set<string> {
  const touched = new Set(withdrawnSources(events).keys());
  for (const event of events) {
    if (event.type === 'appointment.booked') {
      touched.add(refKey(event.source));
    }
  }
  return touched;
}

/**
 * What a withdrawn or changed resource fulfilled is decided again against
 * the record: a cancelled booking, a booking rescheduled past the due date,
 * a visit or result withdrawn fulfill nothing, so the expectation is open
 * again unless something else in the record (a visit, a new booking,
 * another result) still fulfills it. A reopened expectation that is already
 * due expires into a case at the next watcher run, like any other.
 */
async function recheckTouched(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
): Promise<Expectation[]> {
  const touched = touchedSources(events);
  if (touched.size === 0) {
    return [];
  }
  const fulfilled = await context.stores.expectations.listByPatient(
    context.clinicId,
    context.patientId,
    ['fulfilled'],
  );
  const reopened: Expectation[] = [];
  for (const expectation of fulfilled) {
    if (expectation.closedBy === undefined || !touched.has(refKey(expectation.closedBy))) {
      continue;
    }
    const outcome = await recheckFulfilled({
      stores: context.stores,
      catalog: context.catalog,
      timeline: state.timeline,
      expectation,
      now: context.now,
      graceDays: context.settings.bookingVisitGraceDays,
    });
    if (outcome.kind === 'reopened') {
      state.live.put(outcome.expectation);
      reopened.push(outcome.expectation);
    }
  }
  return reopened;
}

/**
 * A new expectation may already be met by something in the record that is
 * not part of this batch: typically a follow-up appointment booked before an
 * abnormal result arrived. Correlations still require the event to happen
 * after the expectation's trigger, so past events never count. Cadence and
 * protocol expectations (`afterFulfillment`) are drafted once the batch's
 * events were matched, so the batch counts for them too: the next control
 * booked in the Bundle that fulfilled the doctor's plan (which is what
 * opened the protocol's gap) also brings in the protocol visit.
 */
async function fulfillFromRecord(
  context: AnnotationContext,
  state: PatientState,
  created: readonly Expectation[],
  batch: readonly ClinicalEvent[],
  afterFulfillment: ReadonlySet<ExpectationId>,
): Promise<ClosedExpectation[]> {
  const inBatch = new Set(batch.map((event) => event.idempotencyKey));
  const record = state.timeline.events.filter((event) => !inBatch.has(event.idempotencyKey));
  const closed: ClosedExpectation[] = [];
  for (const expectation of created) {
    const definition = context.catalog.definition(expectation.ruleId);
    if (definition === undefined) {
      continue;
    }
    const target = toCorrelationTarget(
      expectation,
      definition,
      state.timeline,
      matchContext(context),
    );
    const candidates = afterFulfillment.has(expectation.id) ? state.timeline.events : record;
    const event = candidates.find(
      (candidate) => findFulfillment(candidate, target, state.timeline) !== undefined,
    );
    if (event !== undefined) {
      const next = await closeExpectation(
        context.stores,
        expectation,
        'fulfilled',
        fulfillmentReason(event),
        context.now,
        event.source,
        recheckAtFor(event, context.settings.bookingVisitGraceDays),
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: event.type });
    }
  }
  return closed;
}
