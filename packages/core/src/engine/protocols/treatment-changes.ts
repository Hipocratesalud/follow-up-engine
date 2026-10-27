import type { MedicationMatcher } from '../../config/protocol.ts';
import type { ClinicalEvent, MedicationPrescribedEvent } from '../../domain/clinical-event.ts';
import { foldText } from '../support/text.ts';
import { atcCodeOf } from '../terminology/atc.ts';

/**
 * Starts and dose changes of a drug class, read from the prescriptions in
 * the record: what restarts a titration schedule (a new antidepressant, a
 * new levothyroxine dose).
 */

/** Whether a medication belongs to the class: an ATC prefix of its code, or a fragment of its text. */
export function medicationMatches(
  medication: MedicationPrescribedEvent['medication'],
  matcher: MedicationMatcher,
): boolean {
  const atc = atcCodeOf(medication);
  if (atc !== undefined && (matcher.atc ?? []).some((prefix) => atc.startsWith(prefix))) {
    return true;
  }
  const text = foldText(`${medication.text} ${medication.code?.display ?? ''}`);
  return (matcher.match ?? []).some((fragment) => text.includes(foldText(fragment)));
}

/** Which drug a prescription is: its ATC code, else the first word of its name. */
function drugOf(event: MedicationPrescribedEvent): string {
  return atcCodeOf(event.medication) ?? foldText(event.medication.text).split(/\s+/)[0] ?? '';
}

/**
 * The dose a prescription states: every number of its text and dosage, with
 * the unit that follows it ("50 mg", "1 tab", "c/12h"). Two prescriptions
 * of the same drug with a different dose are a dose change; a renewal
 * written the same way is not.
 */
export function doseSignature(event: MedicationPrescribedEvent): string {
  const text = foldText(`${event.medication.text} ${event.dosageText ?? ''}`).replace(
    /(\d),(\d)/gu,
    '$1.$2',
  );
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)?/gu)]
    .map((match) => `${match[1] ?? ''}${match[2] ?? ''}`)
    .join(' ');
}

/** A drug of the class started, or prescribed at a new dose. */
export interface TreatmentChange {
  readonly event: MedicationPrescribedEvent;
  readonly kind: 'started' | 'dose_changed';
}

/**
 * Every start or dose change of a drug of the class, chronological. The
 * first prescription of a drug in the record is its start; a later one
 * whose dose differs from the drug's previous prescription is a change.
 */
export function treatmentChanges(
  events: readonly ClinicalEvent[],
  matcher: MedicationMatcher,
): TreatmentChange[] {
  const changes: TreatmentChange[] = [];
  const lastDose = new Map<string, string>();
  const prescriptions = events
    .filter(
      (event): event is MedicationPrescribedEvent =>
        event.type === 'medication.prescribed' && medicationMatches(event.medication, matcher),
    )
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
  for (const event of prescriptions) {
    const drug = drugOf(event);
    const dose = doseSignature(event);
    const previous = lastDose.get(drug);
    if (previous === undefined) {
      changes.push({ event, kind: 'started' });
    } else if (previous !== dose) {
      changes.push({ event, kind: 'dose_changed' });
    }
    lastDose.set(drug, dose);
  }
  return changes;
}
