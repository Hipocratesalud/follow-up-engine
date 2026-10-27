import type { DomainEvent } from '../domain/domain-event.ts';
import type { ClinicId, JobId } from '../domain/ids.ts';
import type { Duration } from '../shared/duration.ts';
import type { JsonObject } from '../shared/json.ts';

export interface JobRequest {
  /** Handler key, for example `note.extract_plan` or `outbox.deliver`. */
  readonly type: string;
  readonly payload: JsonObject;
  /** Not before this instant. Defaults to now (from the adapter's `Clock`). */
  readonly runAt?: Date;
  /** When set, enqueueing a second job with the same type and key in the clinic is a no-op. */
  readonly dedupKey?: string;
  /** Default 5. */
  readonly maxAttempts?: number;
}

export interface ClaimedJob {
  readonly id: JobId;
  readonly clinicId: ClinicId;
  readonly type: string;
  readonly payload: JsonObject;
  /** 1 on the first run. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Proves ownership; required to complete or fail the job. */
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface ClaimOptions {
  readonly workerId: string;
  /** Only these job types; all when absent. */
  readonly types?: readonly string[];
  readonly limit: number;
  /** After this, an unfinished job can be claimed again. */
  readonly leaseFor: Duration;
  /** From the `Clock`, so a fake clock drives scheduling in tests and demos. */
  readonly now: Date;
}

/** Identifies a claimed job and proves the caller still holds its lease. */
export type JobLease = Pick<ClaimedJob, 'id' | 'leaseToken'>;

/** `lease_lost`: the lease expired and the job was reclaimed; the call changed nothing. */
export type LeaseOutcome = 'acknowledged' | 'lease_lost';

/**
 * Durable background jobs (Postgres `FOR UPDATE SKIP LOCKED`, see ADR 0003).
 * Delivery is at least once, so handlers must be idempotent.
 */
export interface JobQueue {
  /** Inside `UnitOfWork.withTransaction`, the job commits or rolls back with the domain change. */
  enqueue(clinicId: ClinicId, job: JobRequest): Promise<JobId>;

  /**
   * Leases up to `limit` runnable jobs across all clinics: the one
   * deliberately cross-tenant operation, since a worker serves every clinic.
   * Each job carries its `clinicId` and is handled scoped to it.
   */
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;

  complete(clinicId: ClinicId, lease: JobLease): Promise<LeaseOutcome>;

  /**
   * Records a failed attempt. Retried at `retryAt` if attempts remain,
   * otherwise moved to dead letter.
   */
  fail(
    clinicId: ClinicId,
    lease: JobLease,
    failure: { readonly error: string; readonly retryAt?: Date },
  ): Promise<LeaseOutcome>;
}

/**
 * Transactional outbox for outbound domain events. Used inside
 * `UnitOfWork.withTransaction` so an event exists if and only if the domain
 * change that caused it committed. The worker delivers it through
 * `EventPublisher`.
 */
export interface Outbox {
  add(clinicId: ClinicId, event: DomainEvent): Promise<void>;
}
