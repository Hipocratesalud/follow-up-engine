import {
  addReconciliationCounts,
  type ClinicId,
  ConflictError,
  NotFoundError,
  type PatientId,
  type ReconciliationCounts,
  type ReconciliationRepair,
  type ReconciliationRun,
  type ReconciliationScope,
  type ReconciliationStore,
  ZERO_RECONCILIATION_COUNTS,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

function countsOf(run: ReconciliationRun): ReconciliationCounts {
  return addReconciliationCounts(ZERO_RECONCILIATION_COUNTS, run);
}

/** In-memory {@link ReconciliationStore}, rolled back with the rest of the database. */
export class MemoryReconciliationStore implements ReconciliationStore {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  start(
    clinicId: ClinicId,
    runId: string,
    options: {
      readonly scope: ReconciliationScope;
      readonly since?: string;
      readonly watermark?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun> {
    const runs = this.#db.state.reconciliationRuns;
    const busy = [...runs.values()].some(
      (run) => run.clinicId === clinicId && run.status === 'running',
    );
    if (busy || runs.has(tenantKey(clinicId, runId))) {
      return Promise.reject(new ConflictError('ReconciliationRun', runId));
    }
    const run: ReconciliationRun = {
      clinicId,
      runId,
      scope: options.scope,
      status: 'running',
      ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...ZERO_RECONCILIATION_COUNTS,
      startedAt: options.now,
      updatedAt: options.now,
    };
    this.#db.setIn(runs, tenantKey(clinicId, runId), run);
    return Promise.resolve(run);
  }

  get(clinicId: ClinicId, runId: string): Promise<ReconciliationRun | undefined> {
    return Promise.resolve(this.#db.state.reconciliationRuns.get(tenantKey(clinicId, runId)));
  }

  findRunning(clinicId: ClinicId): Promise<ReconciliationRun | undefined> {
    return Promise.resolve(this.#runs(clinicId).find((run) => run.status === 'running'));
  }

  lastCompleted(clinicId: ClinicId): Promise<ReconciliationRun | undefined> {
    return Promise.resolve(this.#runs(clinicId).find((run) => run.status === 'completed'));
  }

  list(
    clinicId: ClinicId,
    query: { readonly limit: number },
  ): Promise<readonly ReconciliationRun[]> {
    return Promise.resolve(this.#runs(clinicId).slice(0, query.limit));
  }

  advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: ReconciliationCounts; readonly now: Date },
  ): Promise<ReconciliationRun> {
    return this.#change(clinicId, runId, (run) => ({
      ...run,
      ...addReconciliationCounts(countsOf(run), step.delta),
      cursor: step.cursor,
      updatedAt: step.now,
    }));
  }

  finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun> {
    return this.#change(clinicId, runId, (run) => ({
      ...run,
      status: outcome.status,
      ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
      updatedAt: outcome.now,
      finishedAt: outcome.now,
    }));
  }

  recordRepairs(clinicId: ClinicId, repairs: readonly ReconciliationRepair[]): Promise<void> {
    for (const repair of repairs) {
      if (repair.clinicId !== clinicId) {
        return Promise.reject(new Error('Repair of another clinic'));
      }
      this.#db.pushTo(this.#db.state.reconciliationRepairs, repair);
    }
    return Promise.resolve();
  }

  listRepairs(
    clinicId: ClinicId,
    query: { readonly runId?: string; readonly patientId?: PatientId; readonly limit: number },
  ): Promise<readonly ReconciliationRepair[]> {
    return Promise.resolve(
      this.#db.state.reconciliationRepairs
        .filter(
          (repair) =>
            repair.clinicId === clinicId &&
            (query.runId === undefined || repair.runId === query.runId) &&
            (query.patientId === undefined || repair.patientId === query.patientId),
        )
        .slice(0, query.limit),
    );
  }

  /** Most recently started first; runs started at the same instant, the later start first. */
  #runs(clinicId: ClinicId): ReconciliationRun[] {
    return [...this.#db.state.reconciliationRuns.values()]
      .map((run, order) => ({ run, order }))
      .filter(({ run }) => run.clinicId === clinicId)
      .sort(
        (left, right) =>
          right.run.startedAt.getTime() - left.run.startedAt.getTime() || right.order - left.order,
      )
      .map(({ run }) => run);
  }

  #change(
    clinicId: ClinicId,
    runId: string,
    next: (run: ReconciliationRun) => ReconciliationRun,
  ): Promise<ReconciliationRun> {
    const key = tenantKey(clinicId, runId);
    const run = this.#db.state.reconciliationRuns.get(key);
    if (run?.status !== 'running') {
      return Promise.reject(new NotFoundError('ReconciliationRun', runId));
    }
    const changed = next(run);
    this.#db.setIn(this.#db.state.reconciliationRuns, key, changed);
    return Promise.resolve(changed);
  }
}
