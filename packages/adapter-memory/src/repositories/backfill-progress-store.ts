import {
  addBackfillCounts,
  type BackfillCounts,
  type BackfillProgress,
  type BackfillProgressStore,
  type BackfillStatus,
  type ClinicId,
  ConflictError,
  NotFoundError,
  type PatientId,
  UNFINISHED_BACKFILL_STATUSES,
  ZERO_BACKFILL_COUNTS,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

const UNFINISHED: readonly BackfillStatus[] = UNFINISHED_BACKFILL_STATUSES;

function countsOf(progress: BackfillProgress): BackfillCounts {
  return {
    patientsScanned: progress.patientsScanned,
    eventsProcessed: progress.eventsProcessed,
    documentsProcessed: progress.documentsProcessed,
    expectationsCreated: progress.expectationsCreated,
    expectationsFulfilled: progress.expectationsFulfilled,
    casesOpened: progress.casesOpened,
    llmCostUsd: progress.llmCostUsd,
  };
}

/** In-memory {@link BackfillProgressStore}, rolled back with the rest of the database. */
export class MemoryBackfillProgressStore implements BackfillProgressStore {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  start(
    clinicId: ClinicId,
    runId: string,
    options: { readonly now: Date; readonly shadow?: boolean },
  ): Promise<BackfillProgress> {
    const runs = this.#db.state.backfillRuns;
    const busy = [...runs.values()].some(
      (run) => run.clinicId === clinicId && UNFINISHED.includes(run.status),
    );
    if (busy || runs.has(tenantKey(clinicId, runId))) {
      return Promise.reject(new ConflictError('BackfillRun', runId));
    }
    const progress: BackfillProgress = {
      clinicId,
      runId,
      status: 'running',
      shadow: options.shadow ?? false,
      ...ZERO_BACKFILL_COUNTS,
      startedAt: options.now,
      updatedAt: options.now,
    };
    this.#db.setIn(runs, tenantKey(clinicId, runId), progress);
    return Promise.resolve(progress);
  }

  get(clinicId: ClinicId, runId: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#db.state.backfillRuns.get(tenantKey(clinicId, runId)));
  }

  findRunning(clinicId: ClinicId): Promise<BackfillProgress | undefined> {
    return Promise.resolve(
      [...this.#db.state.backfillRuns.values()].find(
        (run) => run.clinicId === clinicId && UNFINISHED.includes(run.status),
      ),
    );
  }

  advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: BackfillCounts; readonly now: Date },
  ): Promise<BackfillProgress> {
    return this.#change(clinicId, runId, ['running'], (run) => ({
      ...run,
      ...addBackfillCounts(countsOf(run), step.delta),
      cursor: step.cursor,
      updatedAt: step.now,
    }));
  }

  pause(
    clinicId: ClinicId,
    runId: string,
    step: { readonly reason: string; readonly now: Date },
  ): Promise<BackfillProgress> {
    return this.#change(clinicId, runId, ['running'], (run) => ({
      ...run,
      status: 'paused_budget',
      lastError: step.reason,
      updatedAt: step.now,
    }));
  }

  resume(clinicId: ClinicId, runId: string, now: Date): Promise<BackfillProgress> {
    return this.#change(clinicId, runId, UNFINISHED, (run) => {
      const resumed: { -readonly [K in keyof BackfillProgress]: BackfillProgress[K] } = {
        ...run,
        status: 'running',
        updatedAt: now,
      };
      delete resumed.lastError;
      return resumed;
    });
  }

  finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<BackfillProgress> {
    return this.#change(clinicId, runId, UNFINISHED, (run) => ({
      ...run,
      status: outcome.status,
      ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
      updatedAt: outcome.now,
      finishedAt: outcome.now,
    }));
  }

  #change(
    clinicId: ClinicId,
    runId: string,
    from: readonly BackfillStatus[],
    next: (run: BackfillProgress) => BackfillProgress,
  ): Promise<BackfillProgress> {
    const key = tenantKey(clinicId, runId);
    const run = this.#db.state.backfillRuns.get(key);
    if (run === undefined || !from.includes(run.status)) {
      return Promise.reject(new NotFoundError('BackfillRun', runId));
    }
    const changed = next(run);
    this.#db.setIn(this.#db.state.backfillRuns, key, changed);
    return Promise.resolve(changed);
  }
}
