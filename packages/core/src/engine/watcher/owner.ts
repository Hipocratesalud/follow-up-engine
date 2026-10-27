import type { Expectation } from '../../domain/expectation.ts';
import { encounterOf, type PatientTimeline } from '../timeline.ts';

/**
 * Who works a case: the practitioner who treated the patient in the
 * encounter that created the expectation, when the record says so; the
 * front desk otherwise.
 */
export function caseOwner(
  expectation: Expectation,
  timeline: PatientTimeline,
  frontDesk: string,
): string {
  const anchor = timeline.bySource(expectation.source);
  const encounterId = anchor === undefined ? undefined : encounterOf(anchor);
  const encounter = encounterId === undefined ? undefined : timeline.encounter(encounterId);
  return encounter?.practitionerId ?? frontDesk;
}
