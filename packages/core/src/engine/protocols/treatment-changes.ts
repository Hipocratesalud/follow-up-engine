import type { MedicationMatcher } from '../../config/protocol.ts';
import type {
  ClinicalEvent,
  MedicationPrescribedEvent,
  NoteReceivedEvent,
} from '../../domain/clinical-event.ts';
import { containsPhrase, foldText } from '../support/text.ts';
import { atcCodeOf, atcNamesOf } from '../terminology/atc.ts';
import { encounterOf } from '../timeline.ts';

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
 * Words that say the prescriber starts the drug now ("Se inicia sertralina",
 * "se indica atorvastatina", "nuevo: losartán", "started atorvastatin").
 * Read in the clause of the note that names the drug, or in the dosage.
 */
export const TREATMENT_START_PHRASES: readonly string[] = [
  'inicia',
  'iniciar',
  'se inicia',
  'inicio',
  'se indica',
  'indico',
  'se agrega',
  'agregar',
  'se anade',
  'nuevo',
  'nueva',
  'comienza',
  'comenzar',
  'start',
  'starts',
  'started',
  'starting',
  'initiate',
  'initiated',
  'new',
];

/**
 * Words that say the patient already takes the drug ("en tto con
 * atorvastatina", "toma losartán", "continuar levotiroxina"): the
 * prescription renews a treatment in course.
 */
export const TREATMENT_CONTINUATION_PHRASES: readonly string[] = [
  'en tto con',
  'en tratamiento con',
  'tratamiento con',
  'toma',
  'tomando',
  'continuar',
  'continua',
  'continue',
  'continues',
  'mantener',
  'mantiene',
  'misma conducta',
  'mismo tratamiento',
  'ya recibe',
  'already on',
  'takes',
];

/** Sentences of a note (a list item or a line counts as one). */
function sentences(text: string): string[] {
  return foldText(text)
    .split(/[.;:\n]/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where each phrase starts as whole words in a folded sentence. */
function phrasePositions(sentence: string, phrases: readonly string[], prefix = false): number[] {
  return phrases.flatMap((phrase) =>
    [...sentence.matchAll(phrasePattern(phrase, prefix))].map(
      (match) => match.index + (match[1]?.length ?? 0),
    ),
  );
}

const PHRASE_PATTERNS = new Map<string, RegExp>();

/** A phrase as whole words (or, with `prefix`, at a word start) in folded text; compiled once. */
function phrasePattern(phrase: string, prefix: boolean): RegExp {
  const key = `${prefix ? 'prefix' : 'word'}:${phrase}`;
  let pattern = PHRASE_PATTERNS.get(key);
  if (pattern === undefined) {
    const end = prefix ? '' : '($|[^\\p{L}\\p{N}])';
    pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldText(phrase))}${end}`, 'gu');
    PHRASE_PATTERNS.set(key, pattern);
  }
  return pattern;
}

/** Where a sentence names the prescribed drug (its name, or a name of its ATC code), or -1. */
function drugPosition(sentence: string, event: MedicationPrescribedEvent): number {
  const name = foldText(event.medication.text).split(/\s+/)[0] ?? '';
  const atc = atcCodeOf(event.medication);
  const stems = [
    ...(name.length >= 4 ? [name] : []),
    ...(atc === undefined ? [] : atcNamesOf(atc)),
  ];
  const positions = phrasePositions(sentence, stems, true);
  return positions.length === 0 ? -1 : Math.min(...positions);
}

/**
 * What a sentence that names the drug says about it: the start or
 * continuation phrase nearest before the drug's name ("Continuar metformina
 * y se inicia atorvastatina": atorvastatin starts), else the nearest after
 * it ("atorvastatina 20 mg: continuar").
 */
function courseIn(sentence: string, at: number): 'started' | 'continued' | undefined {
  const marks = [
    ...phrasePositions(sentence, TREATMENT_START_PHRASES).map((index) => ({
      index,
      course: 'started' as const,
    })),
    ...phrasePositions(sentence, TREATMENT_CONTINUATION_PHRASES).map((index) => ({
      index,
      course: 'continued' as const,
    })),
  ];
  const before = marks.filter((mark) => mark.index < at).sort((a, b) => b.index - a.index)[0];
  const after = marks.filter((mark) => mark.index > at).sort((a, b) => a.index - b.index)[0];
  return (before ?? after)?.course;
}

/** What the record says about whether the drug is new: started, in course, or nothing. */
function statedCourse(
  event: MedicationPrescribedEvent,
  notes: readonly ClinicalEvent[],
): 'started' | 'continued' | undefined {
  if (containsPhrase(event.dosageText ?? '', TREATMENT_START_PHRASES)) {
    return 'started';
  }
  const encounter = encounterOf(event);
  const day = event.occurredAt.toISOString().slice(0, 10);
  const courses = notes
    .filter(
      (note): note is NoteReceivedEvent =>
        note.type === 'note.received' &&
        (encounter === undefined
          ? note.occurredAt.toISOString().slice(0, 10) === day
          : encounterOf(note) === encounter),
    )
    .flatMap((note) => sentences(note.text))
    .flatMap((sentence) => {
      const at = drugPosition(sentence, event);
      const course = at < 0 ? undefined : courseIn(sentence, at);
      return course === undefined ? [] : [course];
    });
  if (courses.includes('continued')) {
    return 'continued';
  }
  return courses.includes('started') ? 'started' : undefined;
}

/** Whether the record saw the patient before `event`, at another consultation. */
function seenBefore(event: MedicationPrescribedEvent, events: readonly ClinicalEvent[]): boolean {
  const encounter = encounterOf(event);
  return events.some(
    (other) =>
      (other.type === 'encounter.finished' || other.type === 'note.received') &&
      other.occurredAt.getTime() < event.occurredAt.getTime() &&
      (encounter === undefined || encounterOf(other) !== encounter),
  );
}

/**
 * Every start or dose change of a drug of the class, chronological. A later
 * prescription whose dose differs from the drug's previous one is a change.
 * The first prescription of a drug is a start when the record says so (the
 * note's clause that names it says "se inicia", "se indica", "started", or
 * the dosage does), or when the record had seen the patient before without
 * it and nothing says it was already in course ("en tto con", "continuar").
 * A drug first seen at the first consultation the record has (the initial
 * import of a patient's history, or a new patient's first visit) without a
 * start phrase is a treatment already in course: not a start.
 *
 * `since` (the end of a previous episode): only prescriptions after it
 * count, and the first one of a drug after it is read as a first
 * prescription with an earlier record (a restart).
 */
export function treatmentChanges(
  events: readonly ClinicalEvent[],
  matcher: MedicationMatcher,
  since?: Date,
): TreatmentChange[] {
  const changes: TreatmentChange[] = [];
  const lastDose = new Map<string, string>();
  const notes = events.filter((event) => event.type === 'note.received');
  const prescriptions = events
    .filter(
      (event): event is MedicationPrescribedEvent =>
        event.type === 'medication.prescribed' &&
        (since === undefined || event.occurredAt.getTime() > since.getTime()) &&
        medicationMatches(event.medication, matcher),
    )
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
  for (const event of prescriptions) {
    const drug = drugOf(event);
    const dose = doseSignature(event);
    const previous = lastDose.get(drug);
    if (previous === undefined) {
      const course = statedCourse(event, notes);
      if (course === 'started' || (course === undefined && seenBefore(event, events))) {
        changes.push({ event, kind: 'started' });
      }
    } else if (previous !== dose) {
      changes.push({ event, kind: 'dose_changed' });
    }
    lastDose.set(drug, dose);
  }
  return changes;
}
