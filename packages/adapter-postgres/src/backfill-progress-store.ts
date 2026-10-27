import {
  ConflictError,
  NotFoundError,
  type BackfillCounts,
  type BackfillProgress,
  type BackfillProgressStore,
  type BackfillStatus,
  type ClinicId,
  type PatientId,
} from '@follow-up-engine/core';
import { isUniqueViolation, optional, type RepositoryContext } from './sql.ts';

interface ProgressRow {
  readonly clinic_id: string;
  readonly run_id: string;
  readonly status: BackfillStatus;
  readonly shadow: boolean;
  readonly patient_cursor: string | null;
  readonly patients_scanned: number;
  readonly events_processed: number;
  readonly documents_processed: number;
  readonly expectations_created: number;
  readonly expectations_fulfilled: number;
  readonly cases_opened: number;
  /** `numeric` comes back as text, so sums never drift. */
  readonly llm_cost_usd: string;
  readonly last_error: string | null;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
}

const COLUMNS = `clinic_id, run_id, status, shadow, patient_cursor, patients_scanned, events_processed,
  documents_processed, expectations_created, expectations_fulfilled, cases_opened, llm_cost_usd,
  last_error, started_at, updated_at, finished_at`;
const UNFINISHED = `status IN ('running', 'paused_budget')`;

function toProgress(row: ProgressRow): BackfillProgress {
  return {
    clinicId: row.clinic_id as ClinicId,
    runId: row.run_id,
    status: row.status,
    shadow: row.shadow,
    ...optional('cursor', row.patient_cursor as PatientId | null),
    patientsScanned: row.patients_scanned,
    eventsProcessed: row.events_processed,
    documentsProcessed: row.documents_processed,
    expectationsCreated: row.expectations_created,
    expectationsFulfilled: row.expectations_fulfilled,
    casesOpened: row.cases_opened,
    llmCostUsd: Number(row.llm_cost_usd),
    ...optional('lastError', row.last_error),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...optional('finishedAt', row.finished_at),
  };
}

/** Resumable progress of the initial backfill (`backfill_progress`). */
export class PostgresBackfillProgressStore implements BackfillProgressStore {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async start(
    clinicId: ClinicId,
    runId: string,
    options: { readonly now: Date; readonly shadow?: boolean },
  ): Promise<BackfillProgress> {
    const { rows } = await this.#ctx
      .db()
      .query<ProgressRow>(
        `INSERT INTO ${this.#ctx.tables.backfill_progress} (clinic_id, run_id, shadow, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING ${COLUMNS}`,
        [clinicId, runId, options.shadow ?? false, options.now],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('BackfillRun', runId) : error;
      });
    return this.#one(rows, runId);
  }

  async get(clinicId: ClinicId, runId: string): Promise<BackfillProgress | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<ProgressRow>(
        `SELECT ${COLUMNS} FROM ${this.#ctx.tables.backfill_progress} WHERE clinic_id = $1 AND run_id = $2`,
        [clinicId, runId],
      );
    const [row] = rows;
    return row === undefined ? undefined : toProgress(row);
  }

  async findRunning(clinicId: ClinicId): Promise<BackfillProgress | undefined> {
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.backfill_progress}
       WHERE clinic_id = $1 AND ${UNFINISHED}`,
      [clinicId],
    );
    const [row] = rows;
    return row === undefined ? undefined : toProgress(row);
  }

  async advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: BackfillCounts; readonly now: Date },
  ): Promise<BackfillProgress> {
    const { delta } = step;
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `UPDATE ${this.#ctx.tables.backfill_progress} SET
         patient_cursor = $3,
         patients_scanned = patients_scanned + $4,
         events_processed = events_processed + $5,
         documents_processed = documents_processed + $6,
         expectations_created = expectations_created + $7,
         expectations_fulfilled = expectations_fulfilled + $8,
         cases_opened = cases_opened + $9,
         llm_cost_usd = llm_cost_usd + $10,
         updated_at = $11
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [
        clinicId,
        runId,
        step.cursor,
        delta.patientsScanned,
        delta.eventsProcessed,
        delta.documentsProcessed,
        delta.expectationsCreated,
        delta.expectationsFulfilled,
        delta.casesOpened,
        delta.llmCostUsd,
        step.now,
      ],
    );
    return this.#one(rows, runId);
  }

  async pause(
    clinicId: ClinicId,
    runId: string,
    step: { readonly reason: string; readonly now: Date },
  ): Promise<BackfillProgress> {
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `UPDATE ${this.#ctx.tables.backfill_progress} SET
         status = 'paused_budget', last_error = $3, updated_at = $4
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [clinicId, runId, step.reason, step.now],
    );
    return this.#one(rows, runId);
  }

  async resume(clinicId: ClinicId, runId: string, now: Date): Promise<BackfillProgress> {
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `UPDATE ${this.#ctx.tables.backfill_progress} SET
         status = 'running', last_error = NULL, updated_at = $3
       WHERE clinic_id = $1 AND run_id = $2 AND ${UNFINISHED}
       RETURNING ${COLUMNS}`,
      [clinicId, runId, now],
    );
    return this.#one(rows, runId);
  }

  async finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<BackfillProgress> {
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `UPDATE ${this.#ctx.tables.backfill_progress} SET
         status = $3, last_error = COALESCE($4, last_error), updated_at = $5, finished_at = $5
       WHERE clinic_id = $1 AND run_id = $2 AND ${UNFINISHED}
       RETURNING ${COLUMNS}`,
      [clinicId, runId, outcome.status, outcome.error ?? null, outcome.now],
    );
    return this.#one(rows, runId);
  }

  #one(rows: readonly ProgressRow[], runId: string): BackfillProgress {
    const [row] = rows;
    if (row === undefined) {
      throw new NotFoundError('BackfillRun', runId);
    }
    return toProgress(row);
  }
}
