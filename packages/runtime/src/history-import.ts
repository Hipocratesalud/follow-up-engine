import { createHash } from 'node:crypto';
import {
  type BackfillReleasePlan,
  type ClinicId,
  type Clock,
  codeLabReading,
  type FhirResourceJson,
  type LabPhotoReading,
  type MediaReadingCost,
  nameOnReport,
  type OrderAgentMode,
  type PatientId,
  ValidationError,
} from '@follow-up-engine/core';
import {
  buildAgentResultBundle,
  buildConsultationBundle,
  buildPatientBundle,
  type ConsultationDocumentType,
} from '@follow-up-engine/fhir';
import { type DocumentExtractionError, extractDocumentText } from './documents.ts';
import { IngestionService } from './ingestion.ts';
import { patientRedactTerms } from './redaction.ts';
import type { EngineRuntime } from './runtime.ts';

/** Most documents one import takes (a patient's history, read in one request). */
export const MAX_HISTORY_DOCUMENTS = 12;

/** One document of a patient's history, with the date it was written. */
export interface HistoryDocument {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
  /** When the document was written (a consultation, the result's date): the replay's order. */
  readonly documentDate: Date;
  /**
   * `lab_result` (and every photo) is read as a lab report into FHIR
   * Observations; anything else is a clinical note for the note extractor.
   */
  readonly documentType: ConsultationDocumentType;
  readonly specialty?: string;
}

export interface HistoryImportInput {
  readonly clinicId: ClinicId;
  /** The clinic's own clock (a lab clinic's): the replay runs as of its "now". */
  readonly clock: Clock;
  readonly patient: {
    readonly id: PatientId;
    /** A new patient: the Patient resource is staged too. */
    readonly name?: string;
    readonly gender?: 'male' | 'female' | 'other' | 'unknown';
    readonly birthDate?: string;
  };
  readonly documents: readonly HistoryDocument[];
  /** Reading mode of photos and lab reports: `live` is the configured provider (Muse Spark). */
  readonly mode?: OrderAgentMode;
}

export const HISTORY_DOCUMENT_STATUSES = [
  /** Stored for the replay (a note, or a lab report with at least one recognized test). */
  'staged',
  /** The same document (same patient, date, type and bytes) was imported before: nothing read again. */
  'already_imported',
  /** Read, but it is not a lab report, or none of its tests is one the engine knows. */
  'no_results',
  /**
   * Held for the clinic team, nothing staged: the name printed on the report
   * is another person's. A report that may not be this patient's never
   * closes an order.
   */
  'needs_review',
  /** No text could be extracted, or the reading failed. */
  'unreadable',
] as const;
export type HistoryDocumentStatus = (typeof HISTORY_DOCUMENT_STATUSES)[number];

/** What the import did with one document. */
export interface HistoryDocumentOutcome {
  readonly index: number;
  readonly filename: string;
  readonly documentDate: Date;
  readonly documentType: ConsultationDocumentType;
  /** How it was read: the note extractor (during the replay) or the lab-result reading. */
  readonly readAs: 'note' | 'lab_report';
  /** For a lab report: a photo (vision) or the document's text. */
  readonly source: 'photo' | 'text';
  readonly status: HistoryDocumentStatus;
  readonly error?: DocumentExtractionError | 'reading_failed';
  /** Why a report is held (`needs_review`). */
  readonly reviewReason?: 'name_mismatch';
  /** A lab report's name check: the printed name against the patient's, by code. */
  readonly nameOnReport?: 'matches' | 'mismatch' | 'absent';
  /**
   * A lab report's dates: the collection/report date printed on it (when the
   * reader found one), the date the evaluator entered, which one the result
   * is dated with (the printed one, the clinically real date, unless absent
   * or later than today), and whether they differ by more than
   * {@link DATE_TOLERANCE_DAYS} days (flagged for review; the printed one is used).
   */
  readonly dates?: {
    readonly printed?: Date;
    readonly entered: Date;
    readonly used: 'printed' | 'entered';
    readonly mismatch: boolean;
  };
  /** A lab report's recognized tests, as printed (the clinic's own view, never the patient's). */
  readonly results?: readonly {
    /** The test's name as printed on the report (clinical content, in its own language). */
    readonly name: string;
    /** The engine's test group it was coded to. */
    readonly test: string;
    readonly loinc: string;
    readonly value: number;
    readonly unit?: string;
    readonly interpretation?: 'H' | 'L' | 'N';
  }[];
  readonly unrecognizedTests?: readonly string[];
  /** The FHIR resources staged (`Observation/<id>`, `DocumentReference/<id>`). */
  readonly resources: readonly string[];
  /** The lab-result reading's model and cost (as logged by the `llm_gateway`). */
  readonly reading?: MediaReadingCost;
}

/** What one import did: per document, and the backfill replay of the patient. */
export interface HistoryImportReport {
  readonly patientId: PatientId;
  readonly documents: readonly HistoryDocumentOutcome[];
  /** Clinical events newly staged (0 on a re-import of the same documents). */
  readonly eventsStaged: number;
  /** The patient's replay: its own run, never the clinic's backfill run. */
  readonly backfill: {
    readonly runId: string;
    readonly status: 'completed' | 'paused_budget';
    readonly expectationsCreated: number;
    readonly expectationsFulfilled: number;
    readonly casesOpened: number;
    readonly notesRead: number;
    readonly notesLlmCostUsd: number;
    /** The release plan (absent when the run paused on the LLM budget). */
    readonly release?: BackfillReleasePlan;
  };
}

/** Days a printed report date may differ from the entered one before it is flagged. */
export const DATE_TOLERANCE_DAYS = 3;
const DAY_MS = 86_400_000;

/** The printed `YYYY-MM-DD` as a date (noon UTC, like every calendar day here). */
function printedDate(value: string | undefined): Date | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The patient's display name in a stored Patient resource (`text`, else given + family). */
function fullNameOf(patient: FhirResourceJson | undefined): string | undefined {
  const names = patient?.['name'];
  if (!Array.isArray(names)) return undefined;
  const first = names[0] as { text?: unknown; given?: unknown; family?: unknown } | undefined;
  if (typeof first?.text === 'string' && first.text.trim() !== '') return first.text;
  const given = Array.isArray(first?.given) ? first.given.filter((g) => typeof g === 'string') : [];
  const family = typeof first?.family === 'string' ? [first.family] : [];
  const joined = [...given, ...family].join(' ').trim();
  return joined === '' ? undefined : joined;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isImage(contentType: string): boolean {
  return contentType.split(';')[0]?.trim().toLowerCase().startsWith('image/') ?? false;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A document's import key: the same patient, date, type and bytes always
 * make the same FHIR ids, so importing them again stages nothing new.
 */
export function historyDocumentKey(patientId: PatientId, document: HistoryDocument): string {
  return sha256(
    [patientId, day(document.documentDate), document.documentType, sha256(document.data)].join('|'),
  ).slice(0, 16);
}

function observationId(key: string, groupId: string): string {
  return `hist-obs-${key}-${groupId}`;
}

/**
 * Imports a patient's history in one go (the lab's "Import history"): every
 * document (PDF, DOCX, TXT, a photo of a result) with its own date. Notes
 * are staged as FHIR DocumentReferences for the note extractor; lab reports
 * (a `lab_result` document, every photo) are read by the same lab-result
 * reading as the order agent's (Muse Spark vision for a photo, the
 * report's text for a PDF) and staged as FHIR Observations, coded like the
 * agent codes them. Then the patient is replayed like the initial backfill
 * (`engine.backfill.replayPatients`, its own run: a clinic-wide backfill is
 * never touched): chronologically, a result as of the date printed on it
 * (the entered date when none was read), so a result dated after an order
 * closes it and one dated before does not; what history left unmet becomes held `backfill`
 * cases, released by the daily cap per owner, never opened at once.
 *
 * A report whose printed name is another person's is held (`needs_review`)
 * and never staged; a report's text is masked like a note before a model
 * reads it (a photo cannot be: its pixels go as they are).
 *
 * Idempotent: the same documents again stage nothing and read nothing
 * (except a report held for review, which is read again).
 */
export async function importPatientHistory(
  runtime: EngineRuntime,
  input: HistoryImportInput,
): Promise<HistoryImportReport> {
  const { clinicId, clock, patient } = input;
  if (input.documents.length === 0 || input.documents.length > MAX_HISTORY_DOCUMENTS) {
    throw new ValidationError('documents', `Between 1 and ${String(MAX_HISTORY_DOCUMENTS)}`);
  }
  const now = clock.now();
  for (const document of input.documents) {
    if (document.documentDate.getTime() > now.getTime()) {
      throw new ValidationError('documentDate', 'A historical document cannot be dated later');
    }
  }
  const ingestion = new IngestionService({
    storage: runtime.storage,
    engine: runtime.engine,
    clock,
  });
  if (patient.name !== undefined) {
    await ingestion.stageHistory(
      clinicId,
      buildPatientBundle({
        id: patient.id,
        name: patient.name,
        ...(patient.gender === undefined ? {} : { gender: patient.gender }),
        ...(patient.birthDate === undefined ? {} : { birthDate: patient.birthDate }),
      }),
      now,
    );
  }
  const { staged, patientResource } = await runtime.storage.unitOfWork.withTransaction(
    clinicId,
    async (stores) => ({
      staged: await stores.clinicalRecords.listEventsForPatient(clinicId, patient.id),
      patientResource: (
        await stores.clinicalRecords.getResource(clinicId, {
          resourceType: 'Patient',
          id: patient.id,
        })
      )?.resource,
    }),
  );
  // Who the reports must be about, and what is masked before a model reads their text.
  const patientName = fullNameOf(patientResource) ?? patient.name;
  const redactTerms = [
    ...new Set([
      ...(patientResource === undefined ? [] : patientRedactTerms(patientResource)),
      ...(patient.name === undefined ? [] : [patient.name]),
    ]),
  ];
  const stagedSources = new Set(staged.map((event) => event.source.id));

  let eventsStaged = 0;
  const outcomes: HistoryDocumentOutcome[] = [];
  for (const [index, document] of input.documents.entries()) {
    const key = historyDocumentKey(patient.id, document);
    const base = {
      index,
      filename: document.filename,
      documentDate: document.documentDate,
      documentType: document.documentType,
    };
    const photo = isImage(document.contentType);
    const readAs = photo || document.documentType === 'lab_result' ? 'lab_report' : 'note';
    const source = photo ? 'photo' : 'text';
    if (readAs === 'lab_report') {
      const prefix = `hist-obs-${key}-`;
      const already = [...stagedSources].filter((id) => id.startsWith(prefix));
      if (already.length > 0) {
        outcomes.push({
          ...base,
          readAs,
          source,
          status: 'already_imported',
          resources: already.map((id) => `Observation/${id}`),
        });
        continue;
      }
      const read = await readLabReport(
        runtime,
        clinicId,
        document,
        input.mode ?? 'live',
        redactTerms,
      );
      if ('error' in read) {
        outcomes.push({
          ...base,
          readAs,
          source,
          status: 'unreadable',
          error: read.error,
          resources: [],
        });
        continue;
      }
      const coded = codeLabReading(read.reading);
      const nameCheck = nameOnReport(read.reading.patientName, patientName);
      // The clinically real date is the one printed on the report (collection
      // or report date); the entered date only when none was read, or when the
      // printed one is after today (a misread). A gap is flagged either way.
      const printed = printedDate(read.reading.reportDate);
      const usePrinted = printed !== undefined && printed.getTime() <= now.getTime();
      const effectiveAt = usePrinted ? printed : document.documentDate;
      const dates = {
        ...(printed === undefined ? {} : { printed }),
        entered: document.documentDate,
        used: usePrinted ? ('printed' as const) : ('entered' as const),
        mismatch:
          printed !== undefined &&
          Math.abs(printed.getTime() - document.documentDate.getTime()) >
            DATE_TOLERANCE_DAYS * DAY_MS,
      };
      const readView = {
        results: coded.results.map((result) => ({
          name: result.reading.name,
          test: result.test,
          loinc: result.code.code,
          value: result.reading.value,
          ...(result.reading.unit === undefined ? {} : { unit: result.reading.unit }),
          ...(result.interpretation === undefined ? {} : { interpretation: result.interpretation }),
        })),
        unrecognizedTests: coded.unrecognized,
        nameOnReport: nameCheck,
        dates,
        reading: { model: read.model, costUsd: read.costUsd, latencyMs: read.latencyMs },
      };
      if (nameCheck === 'mismatch') {
        // Another person's report never reaches the record, so it closes nothing.
        outcomes.push({
          ...base,
          readAs,
          source,
          status: 'needs_review',
          reviewReason: 'name_mismatch',
          resources: [],
          ...readView,
        });
        continue;
      }
      const resources: string[] = [];
      for (const result of coded.results) {
        const id = observationId(key, result.groupId);
        const bundle = buildAgentResultBundle({
          observationId: id,
          patientId: patient.id,
          code: result.code,
          value: result.reading.value,
          ...(result.reading.unit === undefined ? {} : { unit: result.reading.unit }),
          ...(result.reading.referenceLow === undefined
            ? {}
            : { referenceLow: result.reading.referenceLow }),
          ...(result.reading.referenceHigh === undefined
            ? {}
            : { referenceHigh: result.reading.referenceHigh }),
          ...(result.interpretation === undefined ? {} : { interpretation: result.interpretation }),
          effectiveAt,
          receivedAt: effectiveAt,
          note: `Imported from the clinic's history (${photo ? 'a photo of the lab report' : 'a lab report document'}); read by the lab-result reading.`,
        });
        const staging = await ingestion.stageHistory(clinicId, bundle, effectiveAt);
        eventsStaged += staging.staged;
        resources.push(`Observation/${id}`);
      }
      outcomes.push({
        ...base,
        readAs,
        source,
        status: resources.length === 0 ? 'no_results' : 'staged',
        resources,
        ...readView,
      });
      continue;
    }
    const extracted = await extractDocumentText({
      filename: document.filename,
      contentType: document.contentType,
      data: document.data,
    });
    if ('error' in extracted) {
      outcomes.push({
        ...base,
        readAs,
        source,
        status: 'unreadable',
        error: extracted.error,
        resources: [],
      });
      continue;
    }
    const consultationId = `hist-${key}`;
    const bundle = buildConsultationBundle({
      consultationId,
      patient: { id: patient.id },
      specialty: document.specialty ?? 'general_medicine',
      occurredAt: document.documentDate,
      noteText: extracted.text,
      documentType: document.documentType,
    });
    const staging = await ingestion.stageHistory(clinicId, bundle, document.documentDate);
    eventsStaged += staging.staged;
    const noteResource = bundle.entry?.find(
      (entry) => entry.resource?.resourceType === 'DocumentReference',
    )?.resource;
    outcomes.push({
      ...base,
      readAs,
      source,
      status:
        staging.staged === 0 && stagedSources.has(noteResource?.id ?? '')
          ? 'already_imported'
          : 'staged',
      resources: noteResource?.id === undefined ? [] : [`DocumentReference/${noteResource.id}`],
    });
  }

  // The patient's own replay: never resumes, advances or completes the clinic's backfill run.
  const report = await runtime.engine.backfill.replayPatients(clinicId, [patient.id], {
    clock,
    runId: `history-${patient.id}-${now.toISOString()}-${sha256(String(Math.random())).slice(0, 6)}`,
  });
  return {
    patientId: patient.id,
    documents: outcomes,
    eventsStaged,
    backfill: {
      runId: report.runId,
      status: report.status,
      expectationsCreated: report.counts.expectationsCreated,
      expectationsFulfilled: report.counts.expectationsFulfilled,
      casesOpened: report.counts.casesOpened,
      notesRead: report.counts.documentsProcessed,
      notesLlmCostUsd: report.counts.llmCostUsd,
      ...(report.release === undefined ? {} : { release: report.release }),
    },
  };
}

async function readLabReport(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  document: HistoryDocument,
  mode: OrderAgentMode,
  redactTerms: readonly string[],
): Promise<
  | (MediaReadingCost & { readonly reading: LabPhotoReading })
  | { readonly error: DocumentExtractionError | 'reading_failed' }
> {
  try {
    if (isImage(document.contentType)) {
      return await runtime.mediaReader.readLabPhoto(clinicId, {
        mode,
        image: document.data,
        contentType: document.contentType,
      });
    }
    const extracted = await extractDocumentText({
      filename: document.filename,
      contentType: document.contentType,
      data: document.data,
    });
    if ('error' in extracted) return { error: extracted.error };
    return await runtime.mediaReader.readLabDocument(clinicId, {
      mode,
      document: document.data,
      contentType: document.contentType,
      // Masked like a note before Muse Spark reads it (a photo cannot be masked).
      redactTerms,
    });
  } catch (error) {
    runtime.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'history import: lab report not read',
    );
    return { error: 'reading_failed' };
  }
}
