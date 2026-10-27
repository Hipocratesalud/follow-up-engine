import {
  type ClaimedJob,
  type ClaimOptions,
  type ClinicId,
  type Clock,
  type DomainEvent,
  durationToMilliseconds,
  type EventPublisher,
  type JobId,
  jobId,
  type JobLease,
  type JobQueue,
  type JobRequest,
  type LeaseOutcome,
  type Outbox,
  TenantMismatchError,
} from '@follow-up-engine/core';
import type { JobRecord, MemoryDatabase, OutboxRecord } from './memory-database.ts';

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * In-memory {@link JobQueue} with leases, mirroring the Postgres
 * `FOR UPDATE SKIP LOCKED` semantics: a claimed job is invisible until its
 * lease expires, and only the lease holder can complete or fail it.
 */
export class MemoryJobQueue implements JobQueue {
  readonly #db: MemoryDatabase;
  readonly #clock: Clock;

  constructor(db: MemoryDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  enqueue(clinicId: ClinicId, job: JobRequest): Promise<JobId> {
    const jobs = this.#db.state.jobs;
    if (job.dedupKey !== undefined) {
      const duplicate = [...jobs.values()].find(
        (existing) =>
          existing.clinicId === clinicId &&
          existing.type === job.type &&
          existing.dedupKey === job.dedupKey,
      );
      if (duplicate !== undefined) {
        return Promise.resolve(duplicate.id);
      }
    }
    const id = jobId(`job-${String(this.#db.nextSequence())}`);
    const now = this.#clock.now();
    jobs.set(id, {
      id,
      clinicId,
      type: job.type,
      payload: structuredClone(job.payload),
      ...(job.dedupKey === undefined ? {} : { dedupKey: job.dedupKey }),
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      attempt: 0,
      status: 'pending',
      runAt: job.runAt ?? now,
      createdAt: now,
    });
    return Promise.resolve(id);
  }

  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]> {
    const now = options.now.getTime();
    const claimable = [...this.#db.state.jobs.values()]
      .filter(
        (job) =>
          (options.types === undefined || options.types.includes(job.type)) &&
          ((job.status === 'pending' && job.runAt.getTime() <= now) ||
            (job.status === 'running' && (job.leaseExpiresAt?.getTime() ?? 0) <= now)),
      )
      .sort((left, right) => left.runAt.getTime() - right.runAt.getTime());
    const claimed: ClaimedJob[] = [];
    for (const job of claimable) {
      if (claimed.length >= options.limit) {
        break;
      }
      if (job.attempt >= job.maxAttempts) {
        this.#db.state.jobs.set(job.id, {
          ...job,
          status: 'dead',
          lastError: job.lastError ?? 'lease expired',
        });
        continue;
      }
      const attempt = job.attempt + 1;
      const leaseToken = `${job.id}:${String(attempt)}:${String(this.#db.nextSequence())}`;
      const leaseExpiresAt = new Date(now + durationToMilliseconds(options.leaseFor));
      this.#db.state.jobs.set(job.id, {
        ...job,
        attempt,
        status: 'running',
        leaseToken,
        leaseExpiresAt,
        workerId: options.workerId,
      });
      claimed.push({
        id: job.id,
        clinicId: job.clinicId,
        type: job.type,
        payload: structuredClone(job.payload),
        attempt,
        maxAttempts: job.maxAttempts,
        leaseToken,
        leaseExpiresAt,
      });
    }
    return Promise.resolve(claimed);
  }

  complete(clinicId: ClinicId, lease: JobLease): Promise<LeaseOutcome> {
    const job = this.#held(clinicId, lease);
    if (job instanceof Error) {
      return Promise.reject(job);
    }
    if (job === undefined) {
      return Promise.resolve('lease_lost');
    }
    this.#db.state.jobs.set(job.id, { ...job, status: 'completed' });
    return Promise.resolve('acknowledged');
  }

  fail(
    clinicId: ClinicId,
    lease: JobLease,
    failure: { readonly error: string; readonly retryAt?: Date },
  ): Promise<LeaseOutcome> {
    const job = this.#held(clinicId, lease);
    if (job instanceof Error) {
      return Promise.reject(job);
    }
    if (job === undefined) {
      return Promise.resolve('lease_lost');
    }
    const exhausted = job.attempt >= job.maxAttempts;
    this.#db.state.jobs.set(job.id, {
      ...job,
      status: exhausted ? 'dead' : 'pending',
      runAt: failure.retryAt ?? this.#clock.now(),
      lastError: failure.error,
    });
    return Promise.resolve('acknowledged');
  }

  /** Every job of a clinic, for tests and demos. */
  list(clinicId?: ClinicId): readonly JobRecord[] {
    return [...this.#db.state.jobs.values()].filter(
      (job) => clinicId === undefined || job.clinicId === clinicId,
    );
  }

  #held(clinicId: ClinicId, lease: JobLease): JobRecord | TenantMismatchError | undefined {
    const job = this.#db.state.jobs.get(lease.id);
    if (job === undefined) {
      return undefined;
    }
    if (job.clinicId !== clinicId) {
      return new TenantMismatchError();
    }
    const now = this.#clock.now().getTime();
    const valid =
      job.status === 'running' &&
      job.leaseToken === lease.leaseToken &&
      (job.leaseExpiresAt?.getTime() ?? 0) > now;
    return valid ? job : undefined;
  }
}

/** In-memory transactional {@link Outbox}, with delivery helpers for the worker and tests. */
export class MemoryOutbox implements Outbox {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  add(clinicId: ClinicId, event: DomainEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    this.#db.state.outbox.push({ sequence: this.#db.nextSequence(), clinicId, event });
    return Promise.resolve();
  }

  /** Events in insertion order, optionally only one clinic's. */
  list(clinicId?: ClinicId): readonly DomainEvent[] {
    return this.records(clinicId).map((record) => record.event);
  }

  records(clinicId?: ClinicId): readonly OutboxRecord[] {
    return this.#db.state.outbox.filter(
      (record) => clinicId === undefined || record.clinicId === clinicId,
    );
  }

  /**
   * Delivers undelivered events in order through `publisher`, marking each
   * one delivered only after the publisher succeeded (at least once).
   *
   * @returns how many were delivered.
   */
  async deliverPending(publisher: EventPublisher, now: Date): Promise<number> {
    let delivered = 0;
    for (const record of this.#db.state.outbox.filter((item) => item.deliveredAt === undefined)) {
      await publisher.publish(record.clinicId, record.event);
      const index = this.#db.state.outbox.findIndex((item) => item.sequence === record.sequence);
      this.#db.state.outbox[index] = { ...record, deliveredAt: now };
      delivered += 1;
    }
    return delivered;
  }
}

/** {@link EventPublisher} that keeps what it received, for tests and the demo. */
export class MemoryEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];

  publish(clinicId: ClinicId, event: DomainEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    this.published.push(event);
    return Promise.resolve();
  }
}
