import type { Rule, TreatmentCriteria } from '../../config/rule.ts';
import type { MedicationPrescribedEvent } from '../../domain/clinical-event.ts';
import { matchesFilter } from '../matching/filter.ts';
import { containsFragment, containsPhrase } from '../support/text.ts';
import type { PatientTimeline } from '../timeline.ts';

/**
 * Short-treatment criteria (`short_treatment_followup`, config `treatment`).
 * Shared with the cadence layer, which uses them to tell an acute episode
 * from a visit pattern.
 */

/** A chronic drug class (statins, antidiabetics, antihypertensives, ...), whatever the dispensed supply. */
export function isChronicMedication(
  event: MedicationPrescribedEvent,
  criteria: TreatmentCriteria,
): boolean {
  const code = event.medication.code?.code.toUpperCase();
  const prefixes = criteria.chronicMedications.codePrefixes ?? [];
  if (code !== undefined && prefixes.some((prefix) => code.startsWith(prefix.toUpperCase()))) {
    return true;
  }
  const text = `${event.medication.text} ${event.medication.code?.display ?? ''}`;
  return containsFragment(text, criteria.chronicMedications.text ?? []);
}

/**
 * A finite course of treatment: within the rule's trigger filter (30 days or
 * less), no more refills than allowed, not a chronic drug class.
 */
export function isShortCourse(
  rule: Rule,
  criteria: TreatmentCriteria,
  event: MedicationPrescribedEvent,
): boolean {
  return (
    matchesFilter(rule.trigger.filter, event) &&
    event.durationDays !== undefined &&
    (event.refills ?? 0) <= criteria.maxRefills &&
    !isChronicMedication(event, criteria)
  );
}

/** Taken only when needed (`PRN`, `SOS`, FHIR `asNeeded`): it never expects a control by itself. */
export function isAsNeeded(event: MedicationPrescribedEvent, criteria: TreatmentCriteria): boolean {
  return (
    event.asNeeded === true ||
    containsPhrase(`${event.dosageText ?? ''} ${event.medication.text}`, criteria.asNeededPhrases)
  );
}

/**
 * The consultation's note makes the return conditional ("reconsultar si
 * persiste"): the end of the treatment expects nothing.
 */
export function hasConditionalReturn(
  encounterId: string | undefined,
  timeline: PatientTimeline,
  criteria: TreatmentCriteria,
): boolean {
  if (encounterId === undefined) {
    return false;
  }
  return timeline
    .ofType('note.received')
    .some(
      (note) =>
        note.encounterId === encounterId &&
        containsPhrase(note.text, criteria.conditionalReturnPhrases),
    );
}

/** Whether a prescription expects a control visit when it ends, under `rule`'s criteria. */
export function expectsTreatmentControl(
  rule: Rule,
  event: MedicationPrescribedEvent,
  timeline: PatientTimeline,
): boolean {
  const criteria = rule.treatment;
  if (criteria === undefined) {
    return true;
  }
  return (
    isShortCourse(rule, criteria, event) &&
    !isAsNeeded(event, criteria) &&
    !hasConditionalReturn(event.encounterId, timeline, criteria)
  );
}
