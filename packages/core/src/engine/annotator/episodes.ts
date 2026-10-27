import type { Protocol } from '../../config/protocol.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { PatientState } from '../patient-state.ts';
import { itemApplies, protocolEpisode, startsAfter } from '../protocols/episodes.ts';
import { encounterOf } from '../timeline.ts';
import { enrollingConditions, icd10Matches } from './conditions.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';

/** `Expectation.closedReason` of a protocol expectation whose episode ended (a delivery, a loss). */
export const PROTOCOL_CLOSED = 'protocol_closed';
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
 * recorded a diagnosis enrolling the patient (a prenatal control), after the
 * previous episode's end and before this one's.
 */
function encountersOfEpisode(
  protocol: Protocol,
  state: PatientState,
  closure: ClinicalEvent,
  since: Date | undefined,
): Set<string> {
  const encounters = new Set<string>();
  for (const event of state.timeline.ofType('condition.recorded')) {
    const at = event.occurredAt.getTime();
    const encounter = encounterOf(event);
    if (
      encounter !== undefined &&
      encounter !== encounterOf(closure) &&
      at <= closure.occurredAt.getTime() &&
      (since === undefined || at > since.getTime()) &&
      icd10Matches(event.code, protocol.enrollment.conditionCodes)
    ) {
      encounters.add(encounter);
    }
  }
  return encounters;
}

/**
 * Episodic protocols (a pregnancy) end with an outcome recorded in the
 * record (a delivery, a loss). Once ended: the conditions that enrolled the
 * patient are resolved (a clinician's confirmation was of that episode, so a
 * later pregnancy enrolls again), and the protocol's live expectations that
 * no longer apply are cancelled (`protocol_closed`), with what the doctor
 * planned in the episode's consultations (the next prenatal control): never
 * another prenatal expectation after a delivery or a loss.
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
        if (startsAfter(condition, closure, state.timeline)) {
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
    for (const expectation of state.live.list()) {
      if (expectation.layer === 'doctor_plan') {
        // What the doctor planned in a prenatal consultation (the next
        // control, the next ultrasound) has nothing left to follow.
        const anchor = state.timeline.bySource(expectation.source);
        const encounter = anchor === undefined ? undefined : encounterOf(anchor);
        if (encounter === undefined || !episodeEncounters.has(encounter)) {
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
        discharge ? PROTOCOL_DISCHARGED : PROTOCOL_CLOSED,
        context.now,
        closure.source,
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: discharge ? 'plan.extracted' : closure.type });
    }
  }
  return { resolved, closed };
}
