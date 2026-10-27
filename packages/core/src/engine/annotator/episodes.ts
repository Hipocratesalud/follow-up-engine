import type { PatientCondition } from '../../domain/condition.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { PatientState } from '../patient-state.ts';
import { itemApplies, protocolEpisode, startsAfter } from '../protocols/episodes.ts';
import { enrollingConditions } from './conditions.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';

/** `Expectation.closedReason` of a protocol expectation whose episode ended (a delivery, a loss). */
export const PROTOCOL_CLOSED = 'protocol_closed';
/**
 * `Expectation.closedReason` of an open protocol expectation replaced by one
 * due sooner: the same item after a treatment change, or the same test
 * another protocol expects earlier.
 */
export const RESCHEDULED_BY_PROTOCOL = 'rescheduled_by_protocol';

/**
 * Episodic protocols (a pregnancy) end with an outcome recorded in the
 * record (a delivery, a loss). Once ended: the conditions that enrolled the
 * patient are resolved (a clinician's confirmation was of that episode, so a
 * later pregnancy enrolls again), and the protocol's live expectations that
 * no longer apply are cancelled (`protocol_closed`): never another prenatal
 * expectation after a delivery or a loss. Run on every batch, so an
 * outcome that arrives late, or a diagnosis of the ended episode re-sent
 * after it, is decided the same way.
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
    if (protocol.closing === undefined) {
      continue;
    }
    const episode = protocolEpisode(protocol, conditions, state.timeline);
    if (episode?.status !== 'ended') {
      continue;
    }
    const closure = episode.endedBy;
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
    for (const expectation of state.live.list()) {
      if (expectation.protocolId !== protocol.id) {
        continue;
      }
      const itemKey = context.catalog.definition(expectation.ruleId)?.protocol?.itemKey;
      const item = protocol.items.find((candidate) => candidate.key === itemKey);
      if (item !== undefined && itemApplies(item, episode)) {
        continue;
      }
      const next = await closeExpectation(
        context.stores,
        expectation,
        'cancelled',
        PROTOCOL_CLOSED,
        context.now,
        closure.source,
      );
      state.live.put(next);
      closed.push({ expectation: next, closedBy: closure.type });
    }
  }
  return { resolved, closed };
}
