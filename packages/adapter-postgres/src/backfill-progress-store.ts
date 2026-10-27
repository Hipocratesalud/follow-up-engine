import {
  ConflictError,
  NotFoundError,
  type ClinicId,
  type PatientId,
} from '@follow-up-engine/core';
import type {
  BackfillCounts,
  BackfillProgress,
  BackfillProgressStore,
  BackfillStatus,
} from './local-ports.ts';
import { isUniqueViolation, optional, type RepositoryContext } from './sql.ts';

interface ProgressRow {
  readonly clinic_id: string;
  readonly run_id: string;
  readonly status: BackfillStatus;
  readonly patient_cursor: string | null;
  readonly patients_scanned: number;
  readonly expectations_created: number;
  readonly cases_opened: number;
  readonly last_error: string | null;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
}

const COLUMNS = `clinic_id, run_id, status, patient_cursor, patients_scanned, expectations_created,
  cases_opened, last_error, started_at, updated_at, finished_at`;

function toProgress(row: ProgressRow): BackfillProgress {
  return {
    clinicId: row.clinic_id as ClinicId,
    runId: row.run_id,
    status: row.status,
    ...optional('cursor', row.patient_cursor as PatientId | null),
    patientsScanned: row.patients_scanned,
    expectationsCreated: row.expectations_created,
    casesOpened: row.cases_opened,
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

  async start(clinicId: ClinicId, runId: string, now: Date): Promise<BackfillProgress> {
    const { rows } = await this.#ctx
      .db()
      .query<ProgressRow>(
        `INSERT INTO ${this.#ctx.tables.backfill_progress} (clinic_id, run_id, started_at, updated_at)
         VALUES ($1, $2, $3, $3)
         RETURNING ${COLUMNS}`,
        [clinicId, runId, now],
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
       WHERE clinic_id = $1 AND status = 'running'`,
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
    const { rows } = await this.#ctx.db().query<ProgressRow>(
      `UPDATE ${this.#ctx.tables.backfill_progress} SET
         patient_cursor = $3,
         patients_scanned = patients_scanned + $4,
         expectations_created = expectations_created + $5,
         cases_opened = cases_opened + $6,
         updated_at = $7
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [
        clinicId,
        runId,
        step.cursor,
        step.delta.patientsScanned,
        step.delta.expectationsCreated,
        step.delta.casesOpened,
        step.now,
      ],
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
         status = $3, last_error = $4, updated_at = $5, finished_at = $5
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
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
