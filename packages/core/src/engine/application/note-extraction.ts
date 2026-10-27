import type {
  ClinicalEvent,
  ConditionRecordedEvent,
  NoteReceivedEvent,
  PlanExtractedEvent,
} from '../../domain/clinical-event.ts';
import type { QualityFinding } from '../../domain/quality-finding.ts';
import type { NoteExtraction } from '../../ports/note-extractor.ts';
import type { ExtractedMedicationHint } from '../annotator/conditions.ts';
import { codeMatchKey } from '../matching/match-key.ts';
import type { EngineSettings } from '../settings.ts';

/** Job type of a note extraction to retry later (the extractor failed during ingest). */
export const NOTE_EXTRACTION_JOB = 'note.extract_plan';

/**
 * Attempts of a {@link NOTE_EXTRACTION_JOB} before it is dead-lettered. With
 * the worker's backoff (5 s doubling, capped at 1 h) this keeps retrying for
 * about 20 hours, long enough to outlast a provider outage instead of
 * silently losing the doctor's plan.
 */
export const NOTE_EXTRACTION_MAX_ATTEMPTS = 30;

/** Payload of a {@link NOTE_EXTRACTION_JOB} job. Ids only: the note text stays in the clinical record. */
export interface NoteExtractionJobPayload {
  readonly patientId: string;
  readonly documentId: string;
}

/** What one note extraction adds to a batch. */
export interface DerivedFromNote {
  readonly events: readonly ClinicalEvent[];
  readonly extractedConfidence: ReadonlyMap<string, number>;
  readonly extractedMedications: readonly ExtractedMedicationHint[];
  readonly finding?: QualityFinding;
}

/** Idempotency key of an event derived from a note: `<note key>::<suffix>`. */
function derivedKey(note: NoteReceivedEvent, suffix: string): string {
  return `${note.idempotencyKey}::${suffix}`;
}

const PLAN_SUFFIX = '::plan.extracted';

/** The idempotency key of the note version a `plan.extracted` event was read from. */
export function noteKeyOfPlan(plan: PlanExtractedEvent): string {
  return plan.idempotencyKey.endsWith(PLAN_SUFFIX)
    ? plan.idempotencyKey.slice(0, -PLAN_SUFFIX.length)
    : plan.idempotencyKey;
}

/**
 * Turns the extractor's reading of a note into domain facts: one
 * `plan.extracted` event (also when the plan is empty, so the note is never
 * read twice), provisional `condition.recorded` events for confident
 * conditions, medication hints for protocol enrollment, and a
 * `note_without_plan` quality finding when the doctor wrote no plan.
 */
export function deriveFromExtraction(
  note: NoteReceivedEvent,
  extraction: NoteExtraction,
  settings: EngineSettings,
  now: Date,
): DerivedFromNote {
  const base = {
    clinicId: note.clinicId,
    patientId: note.patientId,
    source: note.source,
    occurredAt: note.occurredAt,
    ...(note.encounterId === undefined ? {} : { encounterId: note.encounterId }),
  };
  const plan: PlanExtractedEvent = {
    ...base,
    type: 'plan.extracted',
    idempotencyKey: derivedKey(note, 'plan.extracted'),
    sourceDocumentId: note.documentId,
    ...(note.replacesDocumentIds === undefined
      ? {}
      : { replacesDocumentIds: note.replacesDocumentIds }),
    items: extraction.planItems,
    ...(extraction.discharged === true ? { discharged: true } : {}),
    extractor: { model: extraction.model, promptVersion: extraction.promptVersion },
  };
  const confidence = new Map<string, number>();
  const conditions = extraction.conditions
    .filter((condition) => condition.confidence >= settings.minExtractedConditionConfidence)
    .map((condition): ConditionRecordedEvent => {
      const idempotencyKey = derivedKey(note, `condition:${codeMatchKey(condition.code)}`);
      confidence.set(idempotencyKey, condition.confidence);
      return {
        ...base,
        type: 'condition.recorded',
        idempotencyKey,
        code: condition.code,
        verification: 'provisional',
        evidence: { quote: condition.evidenceQuote, sourceDocumentId: note.documentId },
      };
    });
  const finding: QualityFinding | undefined = extraction.hasPlan
    ? undefined
    : {
        id: `note_without_plan:${note.documentId}`,
        clinicId: note.clinicId,
        patientId: note.patientId,
        kind: 'note_without_plan',
        source: note.source,
        detectedAt: now,
      };
  return {
    events: [plan, ...conditions],
    extractedConfidence: confidence,
    extractedMedications: extraction.medications.map((medication) => ({
      text: `${medication.text} ${medication.code?.display ?? ''}`.trim(),
      source: note.source,
    })),
    ...(finding === undefined ? {} : { finding }),
  };
}

/** Which notes of a patient were already read. */
export interface ExtractedNotes {
  has(note: NoteReceivedEvent): boolean;
}

/**
 * Notes whose plan was already extracted, by version: a new version of a
 * note (an amendment) is read again, a re-delivery is not. A new version
 * whose text did not change is not read again either.
 */
export function extractedNotes(events: readonly ClinicalEvent[]): ExtractedNotes {
  const read = new Set(
    events.flatMap((event) => (event.type === 'plan.extracted' ? [noteKeyOfPlan(event)] : [])),
  );
  const textKey = (note: NoteReceivedEvent): string => `${note.documentId}\u0000${note.text}`;
  const texts = new Set(
    events.flatMap((event) =>
      event.type === 'note.received' && read.has(event.idempotencyKey) ? [textKey(event)] : [],
    ),
  );
  return { has: (note) => read.has(note.idempotencyKey) || texts.has(textKey(note)) };
}
