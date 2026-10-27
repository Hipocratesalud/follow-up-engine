import {
  TenantMismatchError,
  durationToMilliseconds,
  type ClinicId,
  type DomainEvent,
  type Duration,
  type EventPublisher,
  type Outbox,
} from '@follow-up-engine/core';
import { decodeDomainEvent } from './codec.ts';
import { jsonParam, type RepositoryContext } from './sql.ts';

/**
 * Transactional outbox (`outbox`). Used through `UnitOfWork`, an event row
 * exists if and only if the domain change that caused it committed.
 */
export class PostgresOutbox implements Outbox {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  /** Idempotent on `event.id`: adding the same event twice stores it once. */
  async add(clinicId: ClinicId, event: DomainEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.outbox} (clinic_id, event_id, type, event, occurred_at, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (clinic_id, event_id) DO NOTHING`,
      [clinicId, event.id, event.type, jsonParam(event), event.occurredAt, this.#ctx.clock.now()],
    );
  }

  /** Events of a clinic not delivered yet (pending or retrying), in insertion order. Not part of the port. */
  async pending(clinicId: ClinicId): Promise<readonly DomainEvent[]> {
    const { rows } = await this.#ctx.db().query<{ event: Parameters<typeof decodeDomainEvent>[0] }>(
      `SELECT event FROM ${this.#ctx.tables.outbox}
       WHERE clinic_id = $1 AND status = 'pending'
       ORDER BY seq`,
      [clinicId],
    );
    return rows.map((row) => decodeDomainEvent(row.event));
  }
}

/** Exponential backoff between delivery attempts: 5 s, 10 s, 20 s, ... capped at 1 h. */
export const DEFAULT_OUTBOX_BACKOFF = { baseMs: 5_000, capMs: 3_600_000 } as const;

/** With the default backoff, about 20 hours of retries before an event is dead-lettered. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 25;

export interface DrainOutboxOptions {
  readonly publisher: EventPublisher;
  /** From the `Clock`. */
  readonly now: Date;
  /** Events to claim in this pass. */
  readonly limit: number;
  /** A claimed event that is neither delivered nor failed within this is claimable again. */
  readonly leaseFor: Duration;
  readonly maxAttempts?: number;
}

export interface DrainOutboxResult {
  readonly delivered: number;
  /** Failed and scheduled for retry. */
  readonly retrying: number;
  /** Failed for the last time; left in the outbox with `status = 'dead'`. */
  readonly dead: number;
}

interface ClaimedEventRow {
  readonly seq: string;
  readonly clinic_id: string;
  readonly event: Parameters<typeof decodeDomainEvent>[0];
  readonly lease_token: string;
  readonly attempts: number;
}

/**
 * Delivers outbox events through an `EventPublisher` (the worker's
 * `outbox.deliver` loop).
 *
 * Claims a batch with `FOR UPDATE SKIP LOCKED` and a short lease in its own
 * statement, then publishes outside any transaction (no row locks are held
 * across network calls). Several relays can drain concurrently without
 * delivering the same event at the same time; a relay that dies mid-batch
 * leaves leases that expire, so delivery is at least once and the host
 * deduplicates on `event.id`. Within a batch, events are published in
 * insertion order.
 */
export class PostgresOutboxRelay {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async drain(options: DrainOutboxOptions): Promise<DrainOutboxResult> {
    const { outbox } = this.#ctx.tables;
    const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
    const claimed = await this.#ctx.db().query<ClaimedEventRow>(
      `UPDATE ${outbox} SET
         lease_token = gen_random_uuid(),
         lease_expires_at = $1::timestamptz + $3 * interval '1 millisecond',
         attempts = attempts + 1
       WHERE seq IN (
         SELECT seq FROM ${outbox}
         WHERE status = 'pending' AND next_attempt_at <= $1
           AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
         ORDER BY seq
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING seq, clinic_id, event, lease_token, attempts`,
      [options.now, options.limit, durationToMilliseconds(options.leaseFor)],
    );
    const batch = [...claimed.rows].sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)));
    let delivered = 0;
    let retrying = 0;
    let dead = 0;
    for (const row of batch) {
      try {
        await options.publisher.publish(row.clinic_id as ClinicId, decodeDomainEvent(row.event));
      } catch (error) {
        const final = row.attempts >= maxAttempts;
        await this.#ctx.db().query(
          `UPDATE ${outbox} SET
             status = CASE WHEN $3 THEN 'dead' ELSE 'pending' END,
             next_attempt_at = $4::timestamptz + LEAST($5 * power(2, attempts - 1), $6) * interval '1 millisecond',
             last_error = $7, lease_token = NULL, lease_expires_at = NULL
           WHERE seq = $1 AND lease_token = $2`,
          [
            row.seq,
            row.lease_token,
            final,
            options.now,
            DEFAULT_OUTBOX_BACKOFF.baseMs,
            DEFAULT_OUTBOX_BACKOFF.capMs,
            error instanceof Error ? error.message : String(error),
          ],
        );
        if (final) {
          dead += 1;
        } else {
          retrying += 1;
        }
        continue;
      }
      await this.#ctx.db().query(
        `UPDATE ${outbox} SET status = 'delivered', delivered_at = $3, lease_token = NULL,
           lease_expires_at = NULL, last_error = NULL
         WHERE seq = $1 AND lease_token = $2`,
        [row.seq, row.lease_token, options.now],
      );
      delivered += 1;
    }
    return { delivered, retrying, dead };
  }
}
