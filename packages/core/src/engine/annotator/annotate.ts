import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Origin } from '../../domain/common.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { type CaseId, type ClinicId, expectationId, type PatientId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import {
  findFulfillment,
  fulfillmentReason,
  supersedes,
  toCorrelationTarget,
} from '../matching/correlation.ts';
import {
  asOpen,
  loadPatientState,
  type LiveExpectations,
  type PatientState,
} from '../patient-state.ts';
import type { EngineSettings } from '../settings.ts';
import { type PatientTimeline, refKey } from '../timeline.ts';
import { conditionCandidates, type ExtractedMedicationHint, mergeCondition } from './conditions.ts';
import { type ExpectationDraft, materializeExpectation } from './draft.ts';
import { cadenceDrafts } from './layers/cadence.ts';
import { doctorPlanDrafts } from './layers/doctor-plan.ts';
import { protocolDrafts } from './layers/protocol.ts';
import { universalDrafts } from './layers/universal.ts';

/** Everything one annotation run needs, bound to an open transaction. */
export interface AnnotationContext {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly stores: TransactionalStores;
  readonly catalog: Catalog;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly now: Date;
  /** Origin of what the run creates: `live` traffic (default) or the initial `backfill`. */
  readonly origin?: Origin;
  /** Replay mode: the patient's timeline only holds events up to this instant. */
  readonly asOf?: Date;
}

/** Side inputs that only exist when the batch came with a freshly read note. */
export interface AnnotationHints {
  /** Model confidence of note-extracted `condition.recorded` events, by idempotency key. */
  readonly extractedConfidence?: ReadonlyMap<string, number>;
  readonly extractedMedications?: readonly ExtractedMedicationHint[];
}

/** An expectation the run closed, and why. */
export interface ClosedExpectation {
  readonly expectation: Expectation;
  readonly closedBy: ClinicalEvent['type'];
}

export interface AnnotationResult {
  readonly expectationsCreated: readonly Expectation[];
  readonly expectationsClosed: readonly ClosedExpectation[];
  /** Fulfilled by an appointment that was then cancelled: open again (or expired, for the watcher). */
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
  const ordered = [...events].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );

  const conditions = await upsertConditions(context, state, ordered, hints);
  const created: Expectation[] = [];
  const firstDrafts = [
    ...universalDrafts(ordered, context.catalog),
    ...doctorPlanDrafts(ordered, context.catalog, context.settings.minPlanItemConfidence),
  ];
  created.push(...(await createExpectations(context, state.live, firstDrafts)));

  const closed = await applyFulfillment(context, state.timeline, state.live, ordered);
  const reopened = await reopenCancelled(context, state, ordered);

  // The doctor's explicit plan beats the inferred visit pattern for what it
  // covers; checked after fulfillment, so a visit that fulfills the plan
  // brings the pattern back.
  const cadence = cadenceDrafts(ordered, state.timeline, context.catalog).filter(
    (draft) => !coveredByPlan(state.live, draft.matchKey),
  );
  created.push(...(await createExpectations(context, state.live, cadence)));

  const protocols = protocolDrafts({
    catalog: context.catalog,
    conditions: conditions.all,
    timeline: state.timeline,
    live: state.live.list(),
    now: context.now,
  });
  created.push(...(await createExpectations(context, state.live, protocols.drafts)));
  closed.push(...(await fulfillFromRecord(context, state, created, ordered)));

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
      })),
    );
  }

  return {
    expectationsCreated: created,
    expectationsClosed: closed,
    expectationsReopened: reopened,
    casesResolved,
    conditionsUpserted: conditions.upserted,
    optedOut: state.timeline.optedOut,
  };
}

/** In a replay, whether `expectation` was created by the step at `asOf` and was still open after it. */
function createdByThisReplayStep(expectation: Expectation, asOf: Date | undefined): boolean {
  const at = asOf?.getTime();
  if (at !== expectation.createdAt.getTime()) {
    return false;
  }
  return expectation.closedAt === undefined || expectation.closedAt.getTime() >= at;
}

/** Whether a live doctor's-plan expectation already asks for the same thing. */
function coveredByPlan(live: LiveExpectations, matchKey: string): boolean {
  return live
    .list()
    .some(
      (expectation) => expectation.layer === 'doctor_plan' && expectation.matchKey === matchKey,
    );
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

async function createExpectations(
  context: AnnotationContext,
  live: LiveExpectations,
  drafts: readonly ExpectationDraft[],
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
      origin: context.origin ?? 'live',
    });
    const result = await context.stores.expectations.upsertByIdempotencyKey(
      context.clinicId,
      candidate,
    );
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
      const target = toCorrelationTarget(expectation, definition, timeline);
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

/**
 * A cancelled appointment fulfills nothing: what its booking fulfilled is
 * open again, unless something else in the record (a visit, a new booking)
 * still fulfills it. A reopened expectation that is already due expires into
 * a case at the next watcher run, like any other.
 */
async function reopenCancelled(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
): Promise<Expectation[]> {
  const cancelled = new Set(
    events.flatMap((event) =>
      event.type === 'appointment.cancelled' ? [refKey(event.source)] : [],
    ),
  );
  if (cancelled.size === 0) {
    return [];
  }
  const fulfilled = await context.stores.expectations.listByPatient(
    context.clinicId,
    context.patientId,
    ['fulfilled'],
  );
  const reopened: Expectation[] = [];
  for (const expectation of fulfilled) {
    const definition = context.catalog.definition(expectation.ruleId);
    if (
      expectation.closedBy === undefined ||
      !cancelled.has(refKey(expectation.closedBy)) ||
      definition === undefined
    ) {
      continue;
    }
    const target = toCorrelationTarget(expectation, definition, state.timeline);
    const stillFulfilled = state.timeline.events.some(
      (event) => findFulfillment(event, target, state.timeline) !== undefined,
    );
    if (stillFulfilled) {
      continue;
    }
    const open: { -readonly [K in keyof Expectation]: Expectation[K] } = {
      ...expectation,
      status: 'open',
      updatedAt: context.now,
    };
    delete open.closedAt;
    delete open.closedReason;
    delete open.closedBy;
    delete open.caseId;
    await context.stores.expectations.update(context.clinicId, open);
    state.live.put(open);
    reopened.push(open);
  }
  return reopened;
}

/**
 * A new expectation may already be met by something in the record that is
 * not part of this batch: typically a follow-up appointment booked before an
 * abnormal result arrived. Correlations still require the event to happen
 * after the expectation's trigger, so past events never count.
 */
async function fulfillFromRecord(
  context: AnnotationContext,
  state: PatientState,
  created: readonly Expectation[],
  batch: readonly ClinicalEvent[],
): Promise<ClosedExpectation[]> {
  const inBatch = new Set(batch.map((event) => event.idempotencyKey));
  const record = state.timeline.events.filter((event) => !inBatch.has(event.idempotencyKey));
  const closed: ClosedExpectation[] = [];
  for (const expectation of created) {
    const definition = context.catalog.definition(expectation.ruleId);
    if (definition === undefined) {
      continue;
    }
    const target = toCorrelationTarget(expectation, definition, state.timeline);
    const event = record.find(
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
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: event.type });
    }
  }
  return closed;
}
