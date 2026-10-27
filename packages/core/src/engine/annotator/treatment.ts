import type { Rule, TreatmentCriteria } from '../../config/rule.ts';
import type { MedicationPrescribedEvent } from '../../domain/clinical-event.ts';
import { matchesFilter } from '../matching/filter.ts';
import { atcCodeOf } from '../terminology/atc.ts';
import { containsFragment, containsPhrase } from '../support/text.ts';
import type { PatientTimeline } from '../timeline.ts';

/**
 * Short-treatment criteria (`short_treatment_followup`, config `treatment`).
 * Shared with the cadence layer, which uses them to tell an acute episode
 * from a visit pattern.
 */

/** How a rule's criteria classify a drug: chronic, clearly acute, or neither. */
export type MedicationClass = 'chronic' | 'acute' | 'unclassified';

function hasPrefix(code: string | undefined, prefixes: readonly string[] | undefined): boolean {
  return (
    code !== undefined &&
    (prefixes ?? []).some((prefix) => code.startsWith(prefix.trim().toUpperCase()))
  );
}

/**
 * The drug's class under `criteria`, by its ATC code (the prescription's own,
 * else the one its name maps to): a chronic class (antithrombotics,
 * antihypertensives, inhalers, ...) whatever the dispensed supply, a clearly
 * acute one (antibiotics, NSAIDs, ...), or neither.
 */
export function medicationClass(
  event: MedicationPrescribedEvent,
  criteria: TreatmentCriteria,
): MedicationClass {
  const atc = atcCodeOf(event.medication);
  const text = `${event.medication.text} ${event.medication.code?.display ?? ''}`;
  if (
    hasPrefix(atc, criteria.chronicMedications.codePrefixes) ||
    containsFragment(text, criteria.chronicMedications.text ?? [])
  ) {
    return 'chronic';
  }
  return hasPrefix(atc, criteria.acuteMedications?.codePrefixes) ? 'acute' : 'unclassified';
}

/** A chronic drug class (statins, antidiabetics, antithrombotics, ...), whatever the dispensed supply. */
export function isChronicMedication(
  event: MedicationPrescribedEvent,
  criteria: TreatmentCriteria,
): boolean {
  return medicationClass(event, criteria) === 'chronic';
}

/**
 * A finite course of treatment: within the rule's trigger filter (30 days or
 * less), no more refills than allowed, and either a clearly acute drug class
 * or an explicitly short duration (`unclassifiedMaxDays`) of a drug of no
 * chronic class.
 */
export function isShortCourse(
  rule: Rule,
  criteria: TreatmentCriteria,
  event: MedicationPrescribedEvent,
): boolean {
  if (
    !matchesFilter(rule.trigger.filter, event) ||
    event.durationDays === undefined ||
    (event.refills ?? 0) > criteria.maxRefills
  ) {
    return false;
  }
  switch (medicationClass(event, criteria)) {
    case 'chronic':
      return false;
    case 'acute':
      return true;
    case 'unclassified':
      return (
        criteria.unclassifiedMaxDays === undefined ||
        event.durationDays <= criteria.unclassifiedMaxDays
      );
  }
}

/**
 * Taken only when needed (FHIR `asNeeded`, `PRN`, `SOS`, "por razones
 * necesarias", "si hay dolor", "en caso de crisis"): it never expects a
 * control by itself.
 */
export function isAsNeeded(event: MedicationPrescribedEvent, criteria: TreatmentCriteria): boolean {
  if (event.asNeeded === true) {
    return true;
  }
  const text = `${event.dosageText ?? ''} ${event.medication.text}`;
  const conditions = criteria.asNeededConditions;
  const conditional =
    conditions === undefined
      ? []
      : conditions.leads.flatMap((lead) =>
          conditions.symptoms.map((symptom) => `${lead} ${symptom}`),
        );
  return containsPhrase(text, [...criteria.asNeededPhrases, ...conditional]);
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
