import type { Protocol } from '../../config/protocol.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { PatientState } from '../patient-state.ts';
import {
  itemApplies,
  NEW_EPISODE_MIN_DAYS,
  protocolEpisode,
  startsAfter,
} from '../protocols/episodes.ts';
import { datingOf } from '../protocols/gestational-age.ts';
import { encounterOf } from '../timeline.ts';
import { enrollingConditions, icd10Matches } from './conditions.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';
import { TEST_REQUEST_REASONS } from './test-requests.ts';

/**
 * `Expectation.closedReason` of a protocol expectation whose episode ended
 * (a delivery, a loss), in records written before `pregnancy_ended`.
 */
export const PROTOCOL_CLOSED = 'protocol_closed';
/**
 * `Expectation.closedReason` of everything an episode that ended with an
 * outcome (a delivery, a loss) asked for and that no longer applies: the
 * protocol's prenatal items, and the orders and doctor's-plan items of the
 * pregnancy's own consultations (a first-trimester glucose, a 32-week
 * ultrasound, the next prenatal control).
 */
export const PREGNANCY_ENDED = 'pregnancy_ended';
/**
 * `Expectation.closedReason` of a protocol expectation whose episode a
 * discharge ended (`closesOnDischarge`): the same reason the cadence layer
 * uses for the visit pattern a discharge withdraws.
 */
export const PROTOCOL_DISCHARGED = 'patient_discharged';
/**
 * `Expectation.closedReason` of the expectation of a treatment protocol
 * (`enrollment.activeTreatment`) once the patient has no active
 * prescription of its drugs: the treatment it followed ended.
 */
export const TREATMENT_ENDED = 'treatment_ended';
/**
 * `Expectation.closedReason` of an open protocol expectation replaced by one
 * due sooner: the same item after a treatment change, or the same test
 * another protocol expects earlier.
 */
export const RESCHEDULED_BY_PROTOCOL = 'rescheduled_by_protocol';

/**
 * The consultations of the episode that ended at `closure`: those that
 * recorded a diagnosis enrolling the patient (a prenatal control) or dated
 * the pregnancy (a gestational age read from the note), after the previous
 * episode's end and up to the outcome.
 */
function encountersOfEpisode(
  protocol: Protocol,
  state: PatientState,
  closure: ClinicalEvent,
  since: Date | undefined,
): Set<string> {
  const encounters = new Set<string>();
  for (const event of state.timeline.events) {
    const at = event.occurredAt.getTime();
    const encounter = encounterOf(event);
    const obstetric =
      (event.type === 'condition.recorded' &&
        icd10Matches(event.code, protocol.enrollment.conditionCodes)) ||
      datingOf(event) !== undefined;
    if (
      obstetric &&
      encounter !== undefined &&
      encounter !== encounterOf(closure) &&
      at <= closure.occurredAt.getTime() &&
      (since === undefined || at > since.getTime())
    ) {
      encounters.add(encounter);
    }
  }
  return encounters;
}

/**
 * Whether a doctor's-plan or universal expectation belongs to the episode
 * that ended: triggered before its end by a consultation of the episode
 * (an order, a plan item of a prenatal control), or by a result of an order
 * of one (the abnormal 32-week ultrasound), or by an obstetric record of the
 * episode (an ultrasound of the pregnancy with no order).
 */
function belongsToEpisode(
  protocol: Protocol,
  expectation: Expectation,
  state: PatientState,
  episodeEncounters: ReadonlySet<string>,
  window: { readonly since: Date | undefined; readonly until: number },
): boolean {
  const anchor = state.timeline.bySource(expectation.source);
  if (anchor === undefined) {
    return false;
  }
  const at = anchor.occurredAt.getTime();
  if (at > window.until || (window.since !== undefined && at <= window.since.getTime())) {
    return false;
  }
  const encounter = encounterOf(anchor);
  if (encounter !== undefined && episodeEncounters.has(encounter)) {
    return true;
  }
  if (anchor.type !== 'result.received') {
    return false;
  }
  const order =
    anchor.basedOnOrderId === undefined
      ? undefined
      : state.timeline.bySource({ resourceType: 'ServiceRequest', id: anchor.basedOnOrderId });
  const orderEncounter = order === undefined ? undefined : encounterOf(order);
  if (orderEncounter !== undefined && episodeEncounters.has(orderEncounter)) {
    return true;
  }
  return (protocol.enrollment.records ?? []).some((record) =>
    record.codes.some(
      (code) => code.system === anchor.code.system && code.code === anchor.code.code,
    ),
  );
}

function sameResource(left: ResourceRef | undefined, right: ResourceRef): boolean {
  return left?.resourceType === right.resourceType && left.id === right.id;
}

/**
 * A doctor's-plan test folded into the order of the same visit
 * (`covered_by_order`, see `oneRequestPerTest`) closed for good before the
 * pregnancy ended: its closure is bookkeeping (the order stands for it), so
 * what became of the test is what became of that order. Only when the end
 * of this episode cancelled the order itself (`pregnancy_ended`, by this
 * outcome's record, in this pass or an earlier run over it) does the plan
 * item read `pregnancy_ended` too. An order that came back (`fulfilled`),
 * was replaced by a later one (`superseded`), or expired and left its case
 * leaves the plan item's closure as it was: the test was done, asked for
 * again, or missed, not dropped because the pregnancy ended.
 *
 * The link to the order is the plan item's `closedBy`: the order's
 * `ServiceRequest`, the `source` of the one order expectation it has (a
 * `ServiceRequest` triggers exactly one universal rule, by category).
 *
 * Never a rewrite: the plan item keeps its `closedReason`, `closedAt` and
 * `closedBy`; the new reading is its `reclassification`, and the change is
 * a `closed_reason_reclassified` entry of the expectation event log.
 */
async function reclassifyCoveredPlanItems(
  context: AnnotationContext,
  protocol: Protocol,
  state: PatientState,
  closure: ClinicalEvent,
  episodeEncounters: ReadonlySet<string>,
  window: { readonly since: Date | undefined; readonly until: number },
): Promise<void> {
  // Both the plan item and the order that carries it over are cancelled.
  const cancelled = await context.stores.expectations.listByPatient(
    context.clinicId,
    context.patientId,
    ['cancelled'],
  );
  for (const planItem of cancelled) {
    if (
      planItem.layer !== 'doctor_plan' ||
      planItem.status !== 'cancelled' ||
      planItem.closedReason !== TEST_REQUEST_REASONS.coveredByOrder ||
      planItem.reclassification !== undefined ||
      planItem.closedBy === undefined ||
      // A replay decides with what was closed up to its instant.
      (planItem.closedAt !== undefined && planItem.closedAt.getTime() > context.now.getTime()) ||
      !belongsToEpisode(protocol, planItem, state, episodeEncounters, window)
    ) {
      continue;
    }
    const order = cancelled.find(
      (candidate) =>
        candidate.layer === 'universal' && sameResource(planItem.closedBy, candidate.source),
    );
    if (order?.closedReason !== PREGNANCY_ENDED || !sameResource(order.closedBy, closure.source)) {
      continue;
    }
    const next: Expectation = {
      ...planItem,
      reclassification: { closedReason: PREGNANCY_ENDED, at: context.now, by: closure.source },
      updatedAt: context.now,
    };
    await context.stores.expectations.update(context.clinicId, next);
    await context.stores.expectationEvents.append(context.clinicId, {
      id: context.ids.next('expectation_event'),
      clinicId: context.clinicId,
      patientId: planItem.patientId,
      expectationId: planItem.id,
      type: 'closed_reason_reclassified',
      actor: 'engine',
      at: context.now,
      fromReason: TEST_REQUEST_REASONS.coveredByOrder,
      toReason: PREGNANCY_ENDED,
      cause: 'episode_ended',
      causedBy: closure.source,
      relatedExpectationId: order.id,
    });
  }
}

/**
 * Episodic protocols (a pregnancy) end with an outcome recorded in the
 * record (a delivery, a loss). Once ended: the conditions that enrolled the
 * patient are resolved (a clinician's confirmation was of that episode, so a
 * later pregnancy enrolls again), and the protocol's live expectations that
 * no longer apply are cancelled, with everything the episode's
 * consultations asked for (the next prenatal control, the
 * first-trimester labs, the obstetric ultrasounds: `pregnancy_ended`):
 * never another prenatal expectation after a delivery or a loss. A plan
 * item already folded into the order of its visit reads `pregnancy_ended`
 * when that order did (a reclassification, never a rewrite of its closure).
 *
 * A protocol that `closesOnDischarge` ends at a discharge from one of its
 * specialties: its live expectations are cancelled (`patient_discharged`);
 * the diagnosis stands. A treatment protocol (`enrollment.activeTreatment`)
 * whose patient is no longer on an active prescription of its drugs cancels
 * them too (`treatment_ended`).
 *
 * Run on every batch, so an outcome that arrives late, or a diagnosis of the
 * ended episode re-sent after it, is decided the same way.
 *
 * @returns the conditions it resolved and the expectations it cancelled.
 */
export async function endEpisodes(
  context: AnnotationContext,
  state: PatientState,
  conditions: PatientCondition[],
): Promise<{
  readonly resolved: readonly PatientCondition[];
  readonly closed: readonly ClosedExpectation[];
}> {
  const resolved: PatientCondition[] = [];
  const closed: ClosedExpectation[] = [];
  for (const protocol of context.catalog.protocols) {
    const ends =
      protocol.closing !== undefined ||
      protocol.closesOnDischarge === true ||
      protocol.enrollment.activeTreatment !== undefined;
    if (!ends) {
      continue;
    }
    const episode = protocolEpisode(protocol, conditions, state.timeline, context.now);
    if (episode?.status === 'active') {
      continue;
    }
    if (episode === undefined) {
      // A treatment protocol whose patient is off treatment: what it expected goes.
      if (protocol.enrollment.activeTreatment === undefined) {
        continue;
      }
      for (const expectation of state.live.list()) {
        if (expectation.protocolId !== protocol.id) {
          continue;
        }
        const next = await closeExpectation(
          context.stores,
          expectation,
          'cancelled',
          TREATMENT_ENDED,
          context.now,
        );
        state.live.put(next);
        closed.push({ expectation: next, closedBy: 'medication.prescribed' });
      }
      continue;
    }
    const closure = episode.endedBy;
    const discharge = episode.outcome === 'discharge';
    if (!discharge) {
      for (const condition of enrollingConditions(protocol, conditions)) {
        if (startsAfter(condition, closure, state.timeline, NEW_EPISODE_MIN_DAYS)) {
          continue;
        }
        const next: PatientCondition = { ...condition, status: 'resolved', updatedAt: context.now };
        delete (next as { confirmedBy?: string }).confirmedBy;
        await context.stores.conditions.upsert(context.clinicId, next);
        conditions[conditions.indexOf(condition)] = next;
        resolved.push(next);
      }
    }
    const episodeEncounters = discharge
      ? new Set<string>()
      : encountersOfEpisode(protocol, state, closure, episode.since);
    const window = {
      since: episode.since,
      until: closure.occurredAt.getTime(),
    };
    for (const expectation of state.live.list()) {
      if (expectation.layer === 'doctor_plan' || expectation.layer === 'universal') {
        // What the pregnancy's consultations asked for (the next prenatal
        // control, a first-trimester lab, the next ultrasound) has nothing
        // left to follow once it ended; the postpartum plan stays.
        if (
          discharge ||
          !belongsToEpisode(protocol, expectation, state, episodeEncounters, window)
        ) {
          continue;
        }
      } else if (expectation.protocolId === protocol.id) {
        const itemKey = context.catalog.definition(expectation.ruleId)?.protocol?.itemKey;
        const item = protocol.items.find((candidate) => candidate.key === itemKey);
        if (item !== undefined && itemApplies(item, episode)) {
          continue;
        }
      } else {
        continue;
      }
      const next = await closeExpectation(
        context.stores,
        expectation,
        'cancelled',
        discharge ? PROTOCOL_DISCHARGED : PREGNANCY_ENDED,
        context.now,
        closure.source,
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: discharge ? 'plan.extracted' : closure.type });
    }
    if (!discharge) {
      // After the orders are decided: a plan item folded into one reads as its order does.
      await reclassifyCoveredPlanItems(
        context,
        protocol,
        state,
        closure,
        episodeEncounters,
        window,
      );
    }
  }
  return { resolved, closed };
}
