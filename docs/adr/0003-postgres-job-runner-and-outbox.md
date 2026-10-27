# 0003. Postgres job runner and transactional outbox

- Status: Accepted
- Date: 2026-10-27

## Context

The engine needs background work (deadline sweeps, LLM extraction, webhook delivery) and must never lose or duplicate a case notification when a write and its notification happen together. The usual answer is Redis plus BullMQ.

## Decision

Use Postgres for both, behind the `JobQueue` port:

- Jobs live in a table and are claimed with `SELECT ... FOR UPDATE SKIP LOCKED` and a lease.
- Outbound events are written to the outbox in the same transaction as the domain change (`UnitOfWork`), and the worker delivers them through `EventPublisher`, at least once, with the event id as idempotency key.
- An in-memory adapter implements the same port for tests.

## Consequences

- One less infrastructure piece; works unchanged on Supabase.
- Exactly-once effects for domain state, at-least-once delivery to the host.
- Throughput is bounded by Postgres, far above what clinic workloads need.
