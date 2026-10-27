import {
  addBackfillCounts,
  type BackfillCounts,
  ZERO_BACKFILL_COUNTS,
} from '../../domain/backfill.ts';
import type {
  ClinicalBatch,
  ClinicalEvent,
  NoteReceivedEvent,
} from '../../domain/clinical-event.ts';
import { TenantMismatchError, ValidationError } from '../../domain/errors.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { BackfillProgress } from '../../ports/backfill-progress.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import { LlmBudgetExceededError } from '../../ports/llm.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import {
  applyInTransaction,
  extractNotes,
  type ExtractionPass,
  type IngestDeps,
} from '../application/ingest.ts';
import {
  type DerivedFromNote,
  extractedNotes,
  noteKeyOfPlan,
  NOTE_EXTRACTION_JOB,
  type NoteExtractionJobPayload,
} from '../application/note-extraction.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import type { Catalog } from '../catalog.ts';
import { expirePatient, recheckPatientBookings } from '../watcher/watcher.ts';
import {
  type BackfillReleasePlan,
  planBackfillRelease,
  releaseDueBackfillCases,
} from './release.ts';

export interface BackfillDeps extends IngestDeps {
  readonly clinics: ClinicDirectory;
}

export interface BackfillOptions {
  /** Id of a new run; default `backfill-<ISO instant>`. Ignored when an unfinished run resumes. */
  readonly runId?: string;
  /** Compute and store everything, release nothing (review before showing it to the clinic). */
  readonly shadow?: boolean;
  /** Patients per page of `listPatientIds`; default `EngineSettings.backfillPageSize`. */
  readonly pageSize?: number;
}

/** Outcome of one call to {@link runBackfill}. */
export interface BackfillReport {
  readonly progress: BackfillProgress;
  /** True when an unfinished (crashed or budget-paused) run was continued. */
  readonly resumed: boolean;
  /** The release plan made when the run completed (absent in shadow mode or when paused). */
  readonly release?: BackfillReleasePlan;
}

/** Whether an error means the clinic's LLM budget is spent (also across module copies). */
export function isBudgetExceeded(error: unknown): boolean {
  return (
    error instanceof LlmBudgetExceededError ||
    (error instanceof Error && error.name === 'LlmBudgetExceededError')
  );
}

/** Facts the engine derived itself (a note's plan and conditions), as opposed to what the host sent. */
function isDerived(event: ClinicalEvent): boolean {
  return event.type === 'plan.extracted' || event.idempotencyKey.includes('::');
}

/** One step of the replay: the events of one consultation, or of one instant, and when they happened. */
export interface ReplayBatch {
  readonly at: Date;
  readonly events: readonly ClinicalEvent[];
}

/**
 * Groups a patient's stored history into the batches the host would have
 * sent: one per consultation (`encounterId`), else one per instant (a
 * result report and its observations, a booking), merged when they end at
 * the same instant. Chronological; each batch happens at its latest event.
 */
export function replayBatches(events: readonly ClinicalEvent[]): ReplayBatch[] {
  const groups = new Map<string, ClinicalEvent[]>();
  for (const event of [...events].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  )) {
    const key =
      event.encounterId === undefined
        ? `at:${event.occurredAt.toISOString()}`
        : `encounter:${event.encounterId}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  // Batches that end at the same instant are one step: the state "just
  // before" a step is then well defined, which keeps a replay repeatable.
  const byInstant = new Map<number, ClinicalEvent[]>();
  for (const group of groups.values()) {
    const at = Math.max(...group.map((event) => event.occurredAt.getTime()));
    byInstant.set(at, [...(byInstant.get(at) ?? []), ...group]);
  }
  return [...byInstant.entries()]
    .sort(([left], [right]) => left - right)
    .map(([at, group]) => ({ at: new Date(at), events: group }));
}

/**
 * Stores a historical batch without annotating it: how a clinic's history is
 * imported before the backfill replays it. Idempotent on event keys.
 */
export async function stageHistory(
  deps: Pick<IngestDeps, 'unitOfWork'>,
  batch: ClinicalBatch,
): Promise<{ readonly inserted: number }> {
  for (const event of batch.events) {
    if (event.clinicId !== batch.clinicId) {
      throw new TenantMismatchError();
    }
    if (event.patientId !== batch.patientId) {
      throw new ValidationError(
        'events',
        `Event ${event.idempotencyKey} belongs to another patient`,
      );
    }
  }
  return deps.unitOfWork.withTransaction(batch.clinicId, (stores) =>
    stores.clinicalRecords.appendEvents(batch.clinicId, batch.events),
  );
}

interface PatientTotals {
  readonly expectations: number;
  readonly fulfilled: number;
  readonly cases: number;
}

/** What the backfill owns for a patient: counted before and after, so totals are what is stored. */
async function patientTotals(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<PatientTotals> {
  const expectations = (await stores.expectations.listByPatient(clinicId, patientId)).filter(
    (expectation) => expectation.origin === 'backfill',
  );
  const cases = await stores.cases.list(clinicId, { patientId, origin: 'backfill', limit: 10_000 });
  return {
    expectations: expectations.length,
    fulfilled: expectations.filter((expectation) => expectation.status === 'fulfilled').length,
    cases: cases.items.length,
  };
}

function extractionCost(pass: ExtractionPass): number {
  return pass.outcomes.reduce((total, outcome) => total + (outcome.extraction?.costUsd ?? 0), 0);
}

/**
 * Replays one patient's history through the steady-state annotator: notes
 * first (outside the transaction, the budget error propagates), then one
 * transaction that annotates every batch "as of" its own time, expires what
 * history left unmet into held backfill cases, and advances the run's cursor
 * past the patient. A crash rolls the whole patient back.
 */
async function replayPatient(
  deps: BackfillDeps,
  input: {
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly runId: string;
    readonly catalog: Catalog;
  },
): Promise<BackfillProgress> {
  const { clinicId, patientId } = input;
  const events = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
    stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
  );
  const notes = events.filter(
    (event): event is NoteReceivedEvent => event.type === 'note.received',
  );
  const pass = await extractNotes(deps, clinicId, notes, extractedNotes(events), {
    propagate: isBudgetExceeded,
    at: (note) => note.occurredAt,
  });
  const derivedByNote = new Map<string, DerivedFromNote>();
  pass.derived.forEach((derived) => {
    const plan = derived.events.find((event) => event.type === 'plan.extracted');
    if (plan?.type === 'plan.extracted') {
      derivedByNote.set(noteKeyOfPlan(plan), derived);
    }
  });
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const before = await patientTotals(stores, clinicId, patientId);
    for (const note of pass.failed) {
      const payload: NoteExtractionJobPayload = { patientId, documentId: note.documentId };
      await stores.jobs.enqueue(clinicId, {
        type: NOTE_EXTRACTION_JOB,
        payload: { ...payload },
        dedupKey: `${NOTE_EXTRACTION_JOB}:${note.documentId}`,
      });
    }
    for (const batch of replayBatches(events)) {
      const derived = batch.events.flatMap((event) =>
        event.type === 'note.received' ? (derivedByNote.get(event.idempotencyKey) ?? []) : [],
      );
      await applyInTransaction(deps, stores, {
        clinicId,
        patientId,
        catalog: input.catalog,
        events: batch.events,
        derived,
        now: batch.at,
        origin: 'backfill',
        asOf: batch.at,
      });
    }
    // A booking of history whose date passed with no visit fulfills nothing.
    await recheckPatientBookings({
      stores,
      settings: deps.settings,
      catalog: input.catalog,
      clinicId,
      patientId,
      now: deps.clock.now(),
    });
    await expirePatient(
      { stores, deps, catalog: input.catalog, clinicId, patientId, now: deps.clock.now() },
      'backfill',
    );
    const after = await patientTotals(stores, clinicId, patientId);
    const delta: BackfillCounts = {
      patientsScanned: 1,
      eventsProcessed: events.filter((event) => !isDerived(event)).length,
      documentsProcessed: notes.length,
      expectationsCreated: after.expectations - before.expectations,
      expectationsFulfilled: after.fulfilled - before.fulfilled,
      casesOpened: after.cases - before.cases,
      llmCostUsd: extractionCost(pass),
    };
    return stores.backfillProgress.advance(clinicId, input.runId, {
      cursor: patientId,
      delta,
      now: deps.clock.now(),
    });
  });
}

function countsOf(progress: BackfillProgress): BackfillCounts {
  return addBackfillCounts(ZERO_BACKFILL_COUNTS, progress);
}

async function startOrResume(
  deps: BackfillDeps,
  clinicId: ClinicId,
  options: BackfillOptions,
): Promise<{ readonly progress: BackfillProgress; readonly resumed: boolean }> {
  const now = deps.clock.now();
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const unfinished = await stores.backfillProgress.findRunning(clinicId);
    if (unfinished !== undefined) {
      const progress =
        unfinished.status === 'running'
          ? unfinished
          : await stores.backfillProgress.resume(clinicId, unfinished.runId, now);
      return { progress, resumed: true };
    }
    const runId = options.runId ?? `backfill-${now.toISOString()}`;
    const progress = await stores.backfillProgress.start(clinicId, runId, {
      now,
      ...(options.shadow === undefined ? {} : { shadow: options.shadow }),
    });
    return { progress, resumed: false };
  });
}

/**
 * The initial backfill of a clinic (PRD "Initial backfill"): every patient's
 * stored history is replayed chronologically through the same annotator as
 * steady state, as if each document had just arrived. What history already
 * fulfilled closes without a case, supersession applies, and what expired
 * unmet becomes held `backfill` cases, released later in prioritized daily
 * batches ({@link planBackfillRelease}).
 *
 * - Resumable: progress is stored per patient in the same transaction as the
 *   patient's writes; calling it again continues an unfinished run.
 * - Idempotent: replaying again creates nothing new (keys by source and rule).
 * - Budget: when the `NoteExtractor` throws `LlmBudgetExceededError`, the run
 *   pauses (`paused_budget`) at the last finished patient and emits
 *   `backfill.paused`; calling it again once there is budget resumes it.
 * - Emits `backfill.completed` with every counter; in shadow mode nothing is
 *   scheduled for release.
 */
export async function runBackfill(
  deps: BackfillDeps,
  clinicId: ClinicId,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const catalog = await deps.loadCatalog(clinicId);
  const pageSize = options.pageSize ?? deps.settings.backfillPageSize;
  const started = await startOrResume(deps, clinicId, options);
  let progress = started.progress;
  for (;;) {
    const page = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.clinicalRecords.listPatientIds(clinicId, {
        ...(progress.cursor === undefined ? {} : { after: progress.cursor }),
        limit: pageSize,
      }),
    );
    for (const patientId of page.patientIds) {
      try {
        progress = await replayPatient(deps, {
          clinicId,
          patientId,
          runId: progress.runId,
          catalog,
        });
      } catch (error) {
        if (!isBudgetExceeded(error)) {
          throw error;
        }
        return { progress: await pause(deps, progress), resumed: started.resumed };
      }
    }
    if (page.next === undefined) {
      break;
    }
  }
  return complete(deps, progress, catalog, started.resumed);
}

async function pause(deps: BackfillDeps, progress: BackfillProgress): Promise<BackfillProgress> {
  const now = deps.clock.now();
  return deps.unitOfWork.withTransaction(progress.clinicId, async (stores) => {
    const paused = await stores.backfillProgress.pause(progress.clinicId, progress.runId, {
      reason: 'llm_budget_exceeded',
      now,
    });
    await new CaseWriter(stores, deps.ids, progress.clinicId).emit('backfill.paused', now, {
      runId: paused.runId,
      reason: 'llm_budget_exceeded',
      ...countsOf(paused),
    });
    return paused;
  });
}

/**
 * The backfill replayed every patient through the same annotator the
 * reconciliation replays them through: as of now the clinic is reconciled.
 * Recorded as a completed full run (scanning nobody) at the current event
 * watermark, so the first nightly reconciliation looks only at what arrives
 * after the backfill instead of replaying the whole clinic again.
 */
async function recordReconciliationBaseline(
  stores: TransactionalStores,
  clinicId: ClinicId,
  backfillRunId: string,
  now: Date,
): Promise<void> {
  const runId = `baseline-${backfillRunId}`;
  if (
    (await stores.reconciliation.findRunning(clinicId)) !== undefined ||
    (await stores.reconciliation.get(clinicId, runId)) !== undefined
  ) {
    return;
  }
  const watermark = await stores.clinicalRecords.eventWatermark(clinicId);
  await stores.reconciliation.start(clinicId, runId, {
    scope: 'all',
    now,
    ...(watermark === undefined ? {} : { watermark }),
  });
  await stores.reconciliation.finish(clinicId, runId, { status: 'completed', now });
}

async function complete(
  deps: BackfillDeps,
  progress: BackfillProgress,
  catalog: Catalog,
  resumed: boolean,
): Promise<BackfillReport> {
  const now = deps.clock.now();
  const { clinicId } = progress;
  const release = progress.shadow ? undefined : await planBackfillRelease(deps, clinicId, now);
  const finished = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const done = await stores.backfillProgress.finish(clinicId, progress.runId, {
      status: 'completed',
      now,
    });
    await recordReconciliationBaseline(stores, clinicId, done.runId, now);
    await new CaseWriter(stores, deps.ids, clinicId).emit('backfill.completed', now, {
      runId: done.runId,
      shadow: done.shadow,
      ...countsOf(done),
      casesScheduled: release?.scheduled ?? 0,
      casesNotNotified: release?.notNotified ?? 0,
    });
    return done;
  });
  if (release !== undefined) {
    await releaseDueBackfillCases(deps, clinicId, now, catalog);
  }
  return { progress: finished, resumed, ...(release === undefined ? {} : { release }) };
}
