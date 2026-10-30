import type {
  ClinicalBatch,
  ClinicalEvent,
  NoteReceivedEvent,
  RecordWithdrawnEvent,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { TenantMismatchError, ValidationError } from '../../domain/errors.ts';
import type { Expectation } from '../../domain/expectation.ts';
import {
  type CaseId,
  type ClinicId,
  type JobId,
  type PatientId,
  patientId as toPatientId,
} from '../../domain/ids.ts';
import type { Origin } from '../../domain/common.ts';
import type { QualityFinding } from '../../domain/quality-finding.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { NoteExtraction, NoteExtractor } from '../../ports/note-extractor.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { ExtractedMedicationHint } from '../annotator/conditions.ts';
import { annotate, type ClosedExpectation } from '../annotator/annotate.ts';
import type { Catalog } from '../catalog.ts';
import type { EngineSettings } from '../settings.ts';
import { refKey } from '../timeline.ts';
import {
  deriveFromExtraction,
  type DerivedFromNote,
  type ExtractedNotes,
  extractedNotes,
  NOTE_EXTRACTION_JOB,
  NOTE_EXTRACTION_MAX_ATTEMPTS,
  type NoteExtractionJobPayload,
} from './note-extraction.ts';
import { scheduleReviewAfterIngest } from '../reviewer/service.ts';
import { scheduleAdjudications } from '../adjudicator/service.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import { withListedResultWithdrawals } from './report-withdrawals.ts';
import { verifyAppointmentOrigins } from '../attribution/attribution.ts';

export interface IngestDeps {
  readonly unitOfWork: UnitOfWork;
  readonly noteExtractor: NoteExtractor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
  /** The clinic's settings: an ambiguous plan item queues the adjudicator when it is on. */
  readonly clinics?: ClinicDirectory;
}

/** What happened to one note of the batch. */
export interface NoteExtractionOutcome {
  readonly documentId: string;
  /** `already_extracted`: the plan was read before (re-delivery); the extractor was not called. */
  readonly status: 'extracted' | 'already_extracted' | 'failed';
  readonly extraction?: NoteExtraction;
  readonly latencyMs?: number;
  /** Set when the extractor failed: the job that will retry it. */
  readonly retryJobId?: JobId;
  readonly error?: string;
}

/** Result of ingesting one batch. */
export interface IngestReport {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly eventsReceived: number;
  /** Events stored for the first time (0 on a re-delivery). */
  readonly eventsInserted: number;
  /** `plan.extracted` and provisional `condition.recorded` events produced from notes. */
  readonly derivedEvents: readonly ClinicalEvent[];
  readonly expectationsCreated: readonly Expectation[];
  readonly expectationsClosed: readonly ClosedExpectation[];
  /** Fulfilled by an appointment that was then cancelled, open again. */
  readonly expectationsReopened: readonly Expectation[];
  readonly casesResolved: readonly CaseId[];
  readonly conditionsUpserted: readonly PatientCondition[];
  readonly qualityFindings: readonly QualityFinding[];
  readonly notes: readonly NoteExtractionOutcome[];
  /** The patient opted out of contact: follow-up continues for the clinic, never toward the patient. */
  readonly optedOut: boolean;
}

function validateBatch(batch: ClinicalBatch): void {
  for (const event of batch.events) {
    if (event.clinicId !== batch.clinicId) {
      throw new TenantMismatchError();
    }
    if (event.patientId !== batch.patientId) {
      throw new ValidationError(
        'events',
        `Event ${event.idempotencyKey} belongs to another patient than the batch`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

export interface ExtractionPass {
  readonly outcomes: NoteExtractionOutcome[];
  readonly derived: DerivedFromNote[];
  readonly failed: NoteReceivedEvent[];
}

/**
 * Reads the notes of a batch with the `NoteExtractor`, outside any
 * transaction (an LLM call must not hold database locks). A failure never
 * fails the batch: the note is queued for retry instead.
 */
export async function extractNotes(
  deps: IngestDeps,
  clinicId: ClinicId,
  notes: readonly NoteReceivedEvent[],
  alreadyExtracted: ExtractedNotes,
  options: {
    /** Errors that must stop the caller instead of queuing a retry (the backfill's budget). */
    readonly propagate?: (error: unknown) => boolean;
    /** When the derived facts happened (the note's time during a replay); default now. */
    readonly at?: (note: NoteReceivedEvent) => Date;
  } = {},
): Promise<ExtractionPass> {
  const pass: ExtractionPass = { outcomes: [], derived: [], failed: [] };
  for (const note of notes) {
    if (alreadyExtracted.has(note)) {
      pass.outcomes.push({ documentId: note.documentId, status: 'already_extracted' });
      continue;
    }
    const startedAt = deps.clock.now();
    try {
      const extraction = await deps.noteExtractor.extract(clinicId, {
        documentId: note.documentId,
        text: note.text,
        authoredAt: note.authoredAt,
        ...(note.specialty === undefined ? {} : { specialty: note.specialty }),
        ...(note.language === undefined ? {} : { language: note.language }),
      });
      pass.derived.push(
        deriveFromExtraction(
          note,
          extraction,
          deps.settings,
          options.at?.(note) ?? deps.clock.now(),
        ),
      );
      pass.outcomes.push({
        documentId: note.documentId,
        status: 'extracted',
        extraction,
        latencyMs: extraction.latencyMs ?? deps.clock.now().getTime() - startedAt.getTime(),
      });
    } catch (error) {
      if (options.propagate?.(error) === true) {
        throw error;
      }
      pass.failed.push(note);
      pass.outcomes.push({
        documentId: note.documentId,
        status: 'failed',
        error: errorMessage(error),
      });
    }
  }
  return pass;
}

/** One batch to store and annotate inside an open transaction. */
export interface ApplyBatchInput {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly catalog: Catalog;
  readonly events: readonly ClinicalEvent[];
  readonly derived: readonly DerivedFromNote[];
  /** The annotation's "now": the clock in steady state, the batch's time in a replay. */
  readonly now?: Date;
  readonly origin?: Origin;
  /** Replay mode: annotate against the patient's history up to this instant only. */
  readonly asOf?: Date;
}

/**
 * The host corrected the subject of a resource it sent before (an order
 * re-sent for another patient): the old patient gets a `record.withdrawn`
 * (`subject_changed`) for it and is annotated with it, so what the engine
 * derived there (the expectation, a case, a protocol enrollment) is
 * withdrawn. The new patient's own annotation then creates what is due.
 * Not done in a replay, whose patients are processed one at a time.
 */
async function withdrawFromOtherPatients(
  deps: IngestDeps,
  stores: TransactionalStores,
  input: ApplyBatchInput,
  now: Date,
): Promise<void> {
  const sources = new Map(
    input.events
      .filter(
        (event) =>
          event.type !== 'record.withdrawn' &&
          event.type !== 'patient.opted_out' &&
          event.source.resourceType !== 'Patient',
      )
      .map((event) => [refKey(event.source), event.source]),
  );
  if (sources.size === 0) {
    return;
  }
  const moved = await stores.clinicalRecords.findOtherPatientsWithSources(
    input.clinicId,
    input.patientId,
    [...sources.values()],
  );
  for (const { source, patientId } of moved) {
    const withdrawal: RecordWithdrawnEvent = {
      type: 'record.withdrawn',
      clinicId: input.clinicId,
      patientId,
      source,
      occurredAt: now,
      idempotencyKey: `${refKey(source)}#record.withdrawn:subject_changed@${patientId}->${input.patientId}`,
      reason: 'subject_changed',
    };
    const { inserted } = await stores.clinicalRecords.appendEvents(input.clinicId, [withdrawal]);
    if (inserted === 0) {
      continue;
    }
    await annotate(
      {
        clinicId: input.clinicId,
        patientId,
        stores,
        catalog: input.catalog,
        ids: deps.ids,
        settings: deps.settings,
        now,
      },
      [withdrawal],
    );
  }
}

/** Stores derived facts and annotates, inside the caller's transaction. */
export async function applyInTransaction(
  deps: IngestDeps,
  stores: TransactionalStores,
  input: ApplyBatchInput,
): Promise<Omit<IngestReport, 'notes' | 'eventsReceived'>> {
  const derivedEvents = input.derived.flatMap((derived) => derived.events);
  // A booking's claimed origin (case, contact attempt) is verified before
  // it is stored (HIP-141 attribution).
  const all = await verifyAppointmentOrigins(
    stores,
    input.clinicId,
    await withListedResultWithdrawals(stores, input.clinicId, input.patientId, [
      ...input.events,
      ...derivedEvents,
    ]),
  );
  const now = input.now ?? deps.clock.now();
  if (input.asOf === undefined) {
    await withdrawFromOtherPatients(deps, stores, input, now);
  }
  const { inserted } = await stores.clinicalRecords.appendEvents(input.clinicId, all);
  const findings = input.derived.flatMap((derived) => derived.findings);
  for (const finding of findings) {
    await stores.qualityFindings.save(input.clinicId, finding);
  }
  const extractedConfidence = new Map(
    input.derived.flatMap((derived) => [...derived.extractedConfidence.entries()]),
  );
  const extractedMedications: ExtractedMedicationHint[] = input.derived.flatMap(
    (derived) => derived.extractedMedications,
  );
  const result = await annotate(
    {
      clinicId: input.clinicId,
      patientId: input.patientId,
      stores,
      catalog: input.catalog,
      ids: deps.ids,
      settings: deps.settings,
      now,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
    },
    all,
    { extractedConfidence, extractedMedications },
  );
  return {
    clinicId: input.clinicId,
    patientId: input.patientId,
    eventsInserted: inserted,
    derivedEvents,
    qualityFindings: findings,
    ...result,
  };
}

/**
 * The single entry point for "a consultation was saved". Processes a batch
 * as a unit: reads the notes (doctor's plan), stores events, then rules →
 * doctor's plan → cadence → fulfillment/supersession → protocols → quality
 * findings, in one transaction. Idempotent: re-delivering the same batch
 * neither calls the extractor again nor duplicates expectations or cases.
 */
export async function ingest(deps: IngestDeps, batch: ClinicalBatch): Promise<IngestReport> {
  validateBatch(batch);
  const { clinicId, patientId } = batch;
  const catalog = await deps.loadCatalog(clinicId);
  const notes = batch.events.filter(
    (event): event is NoteReceivedEvent => event.type === 'note.received',
  );
  const alreadyExtracted =
    notes.length === 0
      ? extractedNotes([])
      : await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
          const history = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
            types: ['plan.extracted', 'note.received'],
          });
          return extractedNotes([...history, ...batch.events]);
        });
  const pass = await extractNotes(deps, clinicId, notes, alreadyExtracted);
  const adjudicator = (await deps.clinics?.get(clinicId))?.settings.adjudicator;

  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const outcomes = [...pass.outcomes];
    for (const note of pass.failed) {
      const payload: NoteExtractionJobPayload = { patientId, documentId: note.documentId };
      const retryJobId = await stores.jobs.enqueue(clinicId, {
        type: NOTE_EXTRACTION_JOB,
        payload: { ...payload },
        dedupKey: `${NOTE_EXTRACTION_JOB}:${note.documentId}`,
        maxAttempts: NOTE_EXTRACTION_MAX_ATTEMPTS,
      });
      const index = outcomes.findIndex((outcome) => outcome.documentId === note.documentId);
      const failed = outcomes[index];
      if (failed !== undefined) {
        outcomes[index] = { ...failed, retryJobId };
      }
    }
    const applied = await applyInTransaction(deps, stores, {
      clinicId,
      patientId,
      catalog,
      events: batch.events,
      derived: pass.derived,
    });
    if (applied.eventsInserted > 0) {
      // New results, notes or prescriptions queue a (debounced) clinical review.
      await scheduleReviewAfterIngest(stores, {
        clinicId,
        patientId,
        events: batch.events,
        now: deps.clock.now(),
      });
    }
    // Ambiguous plan items get the adjudicator's decision (when the clinic runs it).
    await scheduleAdjudications(stores, {
      clinicId,
      settings: adjudicator,
      expectations: applied.expectationsCreated,
    });
    return { ...applied, eventsReceived: batch.events.length, notes: outcomes };
  });
}

function parseJobPayload(payload: Readonly<Record<string, unknown>>): NoteExtractionJobPayload {
  const { patientId, documentId } = payload;
  if (typeof patientId !== 'string' || typeof documentId !== 'string') {
    throw new ValidationError('payload', `Invalid ${NOTE_EXTRACTION_JOB} payload`);
  }
  return { patientId, documentId };
}

/**
 * Handler of {@link NOTE_EXTRACTION_JOB}: retries reading a note whose
 * extraction failed during ingest and applies the plan it contains. Throws
 * when the extractor fails again, so the job queue retries it later.
 * Idempotent: a note whose plan is already stored is not read again.
 */
export async function runNoteExtractionJob(
  deps: IngestDeps,
  clinicId: ClinicId,
  rawPayload: Readonly<Record<string, unknown>>,
): Promise<IngestReport> {
  const payload = parseJobPayload(rawPayload);
  const patientId = toPatientId(payload.patientId);
  const catalog = await deps.loadCatalog(clinicId);
  const history = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
    stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
      types: ['note.received', 'plan.extracted'],
    }),
  );
  const note = history
    .filter((event): event is NoteReceivedEvent => event.type === 'note.received')
    .filter((event) => event.documentId === payload.documentId)
    .at(-1);
  if (note === undefined) {
    throw new ValidationError(
      'documentId',
      `Note ${payload.documentId} is not in the clinical record`,
    );
  }
  const pass = await extractNotes(deps, clinicId, [note], extractedNotes(history));
  const [failure] = pass.failed;
  if (failure !== undefined) {
    throw new Error(pass.outcomes[0]?.error ?? `Extraction of ${failure.documentId} failed`);
  }
  const adjudicator = (await deps.clinics?.get(clinicId))?.settings.adjudicator;
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const applied = await applyInTransaction(deps, stores, {
      clinicId,
      patientId,
      catalog,
      events: [],
      derived: pass.derived,
    });
    await scheduleAdjudications(stores, {
      clinicId,
      settings: adjudicator,
      expectations: applied.expectationsCreated,
    });
    return { ...applied, eventsReceived: 0, notes: pass.outcomes };
  });
}
