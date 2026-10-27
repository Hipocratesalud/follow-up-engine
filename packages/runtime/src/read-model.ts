import type { MemoryDatabase } from '@follow-up-engine/adapter-memory';
import { DEFAULT_SCHEMA, type Queryable } from '@follow-up-engine/adapter-postgres';
import type { ClinicId, FhirResourceJson } from '@follow-up-engine/core';

/** A background job as the clinic that enqueued it may see it (no payload). */
export interface JobView {
  readonly id: string;
  readonly type: string;
  /** `failed`: no attempts left (dead letter). */
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  /** Runs so far (1 during the first run). */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Why the last attempt failed, when it did. */
  readonly lastError?: string;
  readonly createdAt: Date;
  /** When a pending job runs next. */
  readonly runAt: Date;
}

const JOB_STATUS = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  dead: 'failed',
} as const;

/** Error text a host may see: first line, bounded. */
function publicError(error: string | null | undefined): Partial<Pick<JobView, 'lastError'>> {
  const line = error?.split('\n')[0]?.slice(0, 300);
  return line === undefined || line === '' ? {} : { lastError: line };
}

/** A stored `Patient` resource. */
export interface PatientRecord {
  readonly id: string;
  readonly resource: FhirResourceJson;
}

/**
 * The one read query the inbox needs that no core port offers: a search over
 * the stored `Patient` resources by id or name. The engine never searches
 * patients (it works per patient id), so this stays next to the adapters it
 * reads instead of widening `ClinicalRecordRepository`. Everything else the
 * API reads goes through the ports (`ExpectationRepository.listByPatient`,
 * `LlmUsageLog.summary`, `CaseRepository.list`).
 */
export interface ReadModel {
  /** Stored `Patient` resources whose id or name contains `query` (case and accent insensitive in memory). */
  searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]>;
  /** A job of this clinic (`X-FollowUp-Job`); `undefined` for an unknown id or another clinic's. */
  getJob(clinicId: ClinicId, jobId: string): Promise<JobView | undefined>;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchesPatient(record: PatientRecord, query: string | undefined): boolean {
  if (query === undefined || query === '') {
    return true;
  }
  const needle = normalize(query);
  return normalize(`${record.id} ${JSON.stringify(record.resource['name'] ?? '')}`).includes(
    needle,
  );
}

/** {@link ReadModel} over the memory adapters' database. */
export class MemoryReadModel implements ReadModel {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]> {
    const records = [...this.#db.state.resources.values()]
      .filter((row) => row.clinicId === clinicId && row.resource.resourceType === 'Patient')
      .map((row) => ({ id: row.resource.id, resource: structuredClone(row.resource) }))
      .filter((record) => matchesPatient(record, options.query))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, options.limit);
    return Promise.resolve(records);
  }

  getJob(clinicId: ClinicId, jobId: string): Promise<JobView | undefined> {
    const job = [...this.#db.state.jobs.values()].find(
      (candidate) => candidate.id === jobId && candidate.clinicId === clinicId,
    );
    return Promise.resolve(
      job === undefined
        ? undefined
        : {
            id: job.id,
            type: job.type,
            status: JOB_STATUS[job.status],
            attempts: job.attempt,
            maxAttempts: job.maxAttempts,
            ...publicError(job.status === 'completed' ? undefined : job.lastError),
            createdAt: job.createdAt,
            runAt: job.runAt,
          },
    );
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** {@link ReadModel} over the Postgres adapter's tables (schema `follow_up` by default). */
export class PostgresReadModel implements ReadModel {
  readonly #db: () => Queryable;
  readonly #schema: string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(`Invalid schema name: ${schema}`);
    }
    this.#db = db;
    this.#schema = `"${schema}"`;
  }

  async searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]> {
    const query = options.query === undefined || options.query === '' ? null : options.query;
    const { rows } = await this.#db().query<{ resource_id: string; resource: FhirResourceJson }>(
      `SELECT resource_id, resource FROM ${this.#schema}.clinical_resources
       WHERE clinic_id = $1 AND resource_type = 'Patient'
         AND ($2::text IS NULL
              OR resource_id ILIKE '%' || $2 || '%'
              OR (resource -> 'name')::text ILIKE '%' || $2 || '%')
       ORDER BY resource_id LIMIT $3`,
      [clinicId, query, options.limit],
    );
    return rows.map((row) => ({ id: row.resource_id, resource: row.resource }));
  }

  async getJob(clinicId: ClinicId, jobId: string): Promise<JobView | undefined> {
    if (!UUID.test(jobId)) {
      return undefined;
    }
    const { rows } = await this.#db().query<{
      id: string;
      type: string;
      status: keyof typeof JOB_STATUS;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: Date;
      run_at: Date;
    }>(
      `SELECT id, type, status, attempts, max_attempts, last_error, created_at, run_at
       FROM ${this.#schema}.jobs WHERE clinic_id = $1 AND id = $2`,
      [clinicId, jobId],
    );
    const [row] = rows;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          type: row.type,
          status: JOB_STATUS[row.status],
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          ...publicError(row.status === 'completed' ? undefined : row.last_error),
          createdAt: row.created_at,
          runAt: row.run_at,
        };
  }
}
