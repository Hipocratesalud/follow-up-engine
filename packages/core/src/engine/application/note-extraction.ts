import type {
  ClinicalEvent,
  ClinicalEventBase,
  ConditionRecordedEvent,
  NoteReceivedEvent,
  PlanExtractedEvent,
  ResultReceivedEvent,
} from '../../domain/clinical-event.ts';
import { type Coding, ICD10_SYSTEM } from '../../domain/resource.ts';
import type { QualityFinding } from '../../domain/quality-finding.ts';
import type {
  ExtractedPregnancy,
  NoteExtraction,
  PregnancyOutcomeKind,
} from '../../ports/note-extractor.ts';
import type { ExtractedMedicationHint } from '../annotator/conditions.ts';
import { codeMatchKey } from '../matching/match-key.ts';
import { LOINC_SYSTEM } from '../terminology/loinc.ts';
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
  readonly findings: readonly QualityFinding[];
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
 * `note_without_plan` quality finding when the doctor wrote no plan and a
 * `note_truncated` one when the extractor read only part of the note.
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
    extractor: {
      model: extraction.model,
      promptVersion: extraction.promptVersion,
      // What reading the note cost: attributed to the cases its plan opens (metrics).
      costUsd: extraction.costUsd,
    },
    ...(extraction.noteLanguage === undefined ? {} : { noteLanguage: extraction.noteLanguage }),
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
  const finding = (kind: QualityFinding['kind']): QualityFinding => ({
    id: `${kind}:${note.documentId}`,
    clinicId: note.clinicId,
    patientId: note.patientId,
    kind,
    source: note.source,
    detectedAt: now,
  });
  const findings: QualityFinding[] = [
    ...(extraction.hasPlan ? [] : [finding('note_without_plan')]),
    ...(extraction.truncated === true ? [finding('note_truncated')] : []),
  ];
  const pregnancy = pregnancyEvents(note, extraction.pregnancy, base, confidence);
  return {
    events: [plan, ...conditions, ...pregnancy],
    extractedConfidence: confidence,
    extractedMedications: extraction.medications.map((medication) => ({
      text: `${medication.text} ${medication.code?.display ?? ''}`.trim(),
      source: note.source,
    })),
    findings,
  };
}

/** Confidence given to a pregnancy outcome read from a note. */
const PREGNANCY_OUTCOME_CONFIDENCE = 0.8;

/** ICD-10 code of a pregnancy outcome read from a note. */
const OUTCOME_CODES: Readonly<Record<PregnancyOutcomeKind, Coding>> = {
  vaginal_delivery: {
    system: ICD10_SYSTEM,
    code: 'O80',
    display: 'Single spontaneous delivery',
  },
  cesarean_delivery: {
    system: ICD10_SYSTEM,
    code: 'O82',
    display: 'Single delivery by caesarean section',
  },
  loss: { system: ICD10_SYSTEM, code: 'O03', display: 'Spontaneous abortion' },
};

const loinc = (code: string, display: string): Coding => ({ system: LOINC_SYSTEM, code, display });

/**
 * A note's reading of a pregnancy as facts of the record, the same ones a
 * host sends: Observations of gestational age (LOINC 11884-4), last
 * menstrual period (8665-2) and estimated delivery date (11778-8), and a
 * provisional diagnosis of the outcome (O80 vaginal delivery, O82
 * caesarean, O03 loss) dated when it happened, which ends the pregnancy
 * protocol's episode.
 */
function pregnancyEvents(
  note: NoteReceivedEvent,
  pregnancy: ExtractedPregnancy | undefined,
  base: Omit<ClinicalEventBase, 'idempotencyKey'>,
  confidence: Map<string, number>,
): ClinicalEvent[] {
  if (pregnancy === undefined) {
    return [];
  }
  const result = (
    suffix: string,
    code: Coding,
    value: Pick<ResultReceivedEvent, 'value' | 'valueDate'>,
  ): ResultReceivedEvent => ({
    ...base,
    type: 'result.received',
    idempotencyKey: derivedKey(note, `pregnancy:${suffix}`),
    code,
    interpretation: 'unknown',
    ...value,
  });
  const events: ClinicalEvent[] = [];
  if (pregnancy.gestationalWeeks !== undefined) {
    const weeks = pregnancy.gestationalWeeks + (pregnancy.gestationalDays ?? 0) / 7;
    events.push(
      result('gestational_age', loinc('11884-4', 'Gestational age Estimated'), {
        value: { value: Math.round(weeks * 100) / 100, unit: 'wk' },
      }),
    );
  }
  if (pregnancy.lastMenstrualPeriod !== undefined) {
    events.push(
      result('last_menstrual_period', loinc('8665-2', 'Last menstrual period start date'), {
        valueDate: pregnancy.lastMenstrualPeriod,
      }),
    );
  }
  if (pregnancy.estimatedDeliveryDate !== undefined) {
    events.push(
      result('estimated_delivery_date', loinc('11778-8', 'Delivery date Estimated'), {
        valueDate: pregnancy.estimatedDeliveryDate,
      }),
    );
  }
  const outcome = pregnancy.outcome;
  if (outcome !== undefined) {
    const code = OUTCOME_CODES[outcome.kind];
    const idempotencyKey = derivedKey(note, `condition:${codeMatchKey(code)}`);
    confidence.set(idempotencyKey, PREGNANCY_OUTCOME_CONFIDENCE);
    events.push({
      ...base,
      type: 'condition.recorded',
      idempotencyKey,
      // When the delivery or loss happened, not when the note told it.
      occurredAt:
        outcome.date !== undefined && outcome.date.getTime() <= note.occurredAt.getTime()
          ? outcome.date
          : note.occurredAt,
      code,
      verification: 'provisional',
      evidence: { quote: outcome.evidenceQuote, sourceDocumentId: note.documentId },
    });
  }
  return events;
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
