import {
  durationToMilliseconds,
  type ClaimedJob,
  type ClaimOptions,
  type ClinicId,
  type JobId,
  type JobLease,
  type JobQueue,
  type JobRequest,
  type JsonObject,
  type LeaseOutcome,
} from '@follow-up-engine/core';
import { jsonParam, optional, type RepositoryContext } from './sql.ts';

export const DEFAULT_MAX_ATTEMPTS = 5;

/** Exponential backoff used when `fail` gets no `retryAt`: 10 s, 20 s, 40 s, ... capped at 1 h. */
export const DEFAULT_JOB_BACKOFF = { baseMs: 10_000, capMs: 3_600_000 } as const;

export type JobStatus = 'pending' | 'running' | 'completed' | 'dead';

/** A job as stored, for operators and tests (not part of the port). */
export interface JobSnapshot {
  readonly id: JobId;
  readonly clinicId: ClinicId;
  readonly type: string;
  readonly payload: JsonObject;
  readonly status: JobStatus;
  readonly runAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly dedupKey?: string;
  readonly lastError?: string;
  readonly leaseExpiresAt?: Date;
  readonly finishedAt?: Date;
}

interface ClaimedRow {
  readonly id: string;
  readonly clinic_id: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_token: string;
  readonly lease_expires_at: Date;
  readonly run_at: Date;
}

interface JobRow extends Omit<ClaimedRow, 'lease_token' | 'lease_expires_at'> {
  readonly status: JobStatus;
  readonly dedup_key: string | null;
  readonly last_error: string | null;
  readonly lease_expires_at: Date | null;
  readonly finished_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unfinished jobs, the scope in which a dedup key is unique (see the `jobs_dedup_key` index). */
const UNFINISHED = `status IN ('pending', 'running')`;

/**
 * Durable job queue on a Postgres table (ADR 0003).
 *
 * - `claim` leases jobs with `FOR UPDATE SKIP LOCKED`, so concurrent workers
 *   never get the same job and never wait on each other.
 * - A lease that expires (worker crashed or hung) makes the job claimable
 *   again; the stale holder's `complete`/`fail` then returns `lease_lost`.
 * - Each lease counts as an attempt. After `maxAttempts`, a failed job (or
 *   one whose final lease expired) moves to dead letter (`status = 'dead'`).
 *
 * Scheduling compares against the `now` the caller passes (from the `Clock`),
 * never the database clock, so a fake clock drives the queue in tests.
 */
export class PostgresJobQueue implements JobQueue {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async enqueue(clinicId: ClinicId, job: JobRequest): Promise<JobId> {
    const now = this.#ctx.clock.now();
    const { jobs } = this.#ctx.tables;
    // Two rounds at most: if the conflicting job finished between the insert
    // and the lookup, the second insert succeeds.
    for (let round = 0; round < 2; round += 1) {
      const inserted = await this.#ctx.db().query<{ id: string }>(
        `INSERT INTO ${jobs} (clinic_id, type, payload, run_at, max_attempts, dedup_key, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $7)
         ON CONFLICT (clinic_id, type, dedup_key) WHERE dedup_key IS NOT NULL AND ${UNFINISHED}
         DO NOTHING
         RETURNING id`,
        [
          clinicId,
          job.type,
          jsonParam(job.payload),
          job.runAt ?? now,
          job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          job.dedupKey ?? null,
          now,
        ],
      );
      const [created] = inserted.rows;
      if (created !== undefined) {
        return created.id as JobId;
      }
      const existing = await this.#ctx.db().query<{ id: string }>(
        `SELECT id FROM ${jobs}
         WHERE clinic_id = $1 AND type = $2 AND dedup_key = $3 AND ${UNFINISHED}`,
        [clinicId, job.type, job.dedupKey ?? null],
      );
      const [found] = existing.rows;
      if (found !== undefined) {
        return found.id as JobId;
      }
    }
    throw new Error(`Could not enqueue job ${job.type} (dedup key ${job.dedupKey ?? ''})`);
  }

  async claim(options: ClaimOptions): Promise<readonly ClaimedJob[]> {
    const { jobs } = this.#ctx.tables;
    const leaseMs = durationToMilliseconds(options.leaseFor);
    const { rows } = await this.#ctx.db().query<ClaimedRow>(
      `WITH exhausted AS (
         -- Final attempt's lease expired: dead letter instead of another run.
         UPDATE ${jobs} SET status = 'dead', lease_token = NULL, lease_expires_at = NULL,
           last_error = COALESCE(last_error, 'lease expired on the final attempt'),
           finished_at = $1, updated_at = $1
         WHERE id IN (
           SELECT id FROM ${jobs}
           WHERE status = 'running' AND lease_expires_at <= $1 AND attempts >= max_attempts
           FOR UPDATE SKIP LOCKED
         )
       ),
       candidates AS (
         SELECT id FROM ${jobs}
         WHERE ((status = 'pending' AND run_at <= $1)
             OR (status = 'running' AND lease_expires_at <= $1 AND attempts < max_attempts))
           AND ($2::text[] IS NULL OR type = ANY($2::text[]))
         ORDER BY run_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${jobs} AS j SET
         status = 'running',
         attempts = j.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = $1::timestamptz + $4 * interval '1 millisecond',
         leased_by = $5,
         updated_at = $1
       FROM candidates
       WHERE j.id = candidates.id
       RETURNING j.id, j.clinic_id, j.type, j.payload, j.attempts, j.max_attempts,
                 j.lease_token, j.lease_expires_at, j.run_at`,
      [options.now, options.types ?? null, options.limit, leaseMs, options.workerId],
    );
    return [...rows]
      .sort((a, b) => a.run_at.getTime() - b.run_at.getTime() || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id as JobId,
        clinicId: row.clinic_id as ClinicId,
        type: row.type,
        payload: row.payload,
        attempt: row.attempts,
        maxAttempts: row.max_attempts,
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at,
      }));
  }

  async complete(clinicId: ClinicId, lease: JobLease): Promise<LeaseOutcome> {
    if (!isLease(lease)) {
      return 'lease_lost';
    }
    const now = this.#ctx.clock.now();
    const result = await this.#ctx.db().query(
      `UPDATE ${this.#ctx.tables.jobs} SET
         status = 'completed', lease_token = NULL, lease_expires_at = NULL,
         finished_at = $4, updated_at = $4
       WHERE clinic_id = $1 AND id = $2 AND status = 'running' AND lease_token = $3`,
      [clinicId, lease.id, lease.leaseToken, now],
    );
    return result.rowCount === 1 ? 'acknowledged' : 'lease_lost';
  }

  async fail(
    clinicId: ClinicId,
    lease: JobLease,
    failure: { readonly error: string; readonly retryAt?: Date },
  ): Promise<LeaseOutcome> {
    if (!isLease(lease)) {
      return 'lease_lost';
    }
    const now = this.#ctx.clock.now();
    const result = await this.#ctx.db().query(
      `UPDATE ${this.#ctx.tables.jobs} SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE COALESCE(
           $5::timestamptz,
           $4::timestamptz + LEAST($6 * power(2, attempts - 1), $7) * interval '1 millisecond'
         ) END,
         finished_at = CASE WHEN attempts >= max_attempts THEN $4::timestamptz END,
         last_error = $8,
         lease_token = NULL, lease_expires_at = NULL, leased_by = NULL,
         updated_at = $4
       WHERE clinic_id = $1 AND id = $2 AND status = 'running' AND lease_token = $3`,
      [
        clinicId,
        lease.id,
        lease.leaseToken,
        now,
        failure.retryAt ?? null,
        DEFAULT_JOB_BACKOFF.baseMs,
        DEFAULT_JOB_BACKOFF.capMs,
        failure.error,
      ],
    );
    return result.rowCount === 1 ? 'acknowledged' : 'lease_lost';
  }

  /** Reads a job as stored (operators, tests). Not part of the port. */
  async inspect(clinicId: ClinicId, id: JobId): Promise<JobSnapshot | undefined> {
    if (!UUID.test(id)) {
      return undefined;
    }
    const { rows } = await this.#ctx.db().query<JobRow>(
      `SELECT id, clinic_id, type, payload, status, run_at, attempts, max_attempts, dedup_key,
              last_error, lease_expires_at, finished_at
       FROM ${this.#ctx.tables.jobs} WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const [row] = rows;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as JobId,
      clinicId: row.clinic_id as ClinicId,
      type: row.type,
      payload: row.payload,
      status: row.status,
      runAt: row.run_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      ...optional('dedupKey', row.dedup_key),
      ...optional('lastError', row.last_error),
      ...optional('leaseExpiresAt', row.lease_expires_at),
      ...optional('finishedAt', row.finished_at),
    };
  }
}

/** Ids and tokens are uuids; anything else cannot hold a lease (and must not reach a uuid cast). */
function isLease(lease: JobLease): boolean {
  return UUID.test(lease.id) && UUID.test(lease.leaseToken);
}
