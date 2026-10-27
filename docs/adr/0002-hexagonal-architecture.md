# 0002. Hexagonal architecture

- Status: Accepted
- Date: 2026-10-27

## Context

The engine must run on vanilla Postgres and on Supabase, in production and in CI, with real or fake LLMs, against a real or simulated clock. It must stay testable without infrastructure.

## Decision

Ports and adapters (hexagonal architecture), enforced by tooling.

- `packages/core` holds the domain and the ports. It has no I/O and imports only itself and pure libraries (zod).
- Ports: `ClinicalRecordRepository`, `ExpectationRepository`, `CaseRepository`, `FeedbackRepository`, `ConditionRepository`, `AuditLog`, `UnitOfWork`, `JobQueue`/outbox, `Clock`, `EventPublisher`, `LlmProvider`/`LlmGateway`, `RuleSource`, `ProtocolSource`.
- Adapters live in their own packages: `adapter-postgres`, `adapter-memory`, `llm` (Meta, OpenAI-compatible, fake). Clocks (`SystemClock`, `FakeClock`) live in core because they are pure.
- Every adapter passes the same contract test suite from `packages/testkit`, so the memory adapter is a faithful stand-in for Postgres.
- `apps/api` and `apps/worker` are the composition roots: the only place adapters are chosen and wired.
- `dependency-cruiser` (`pnpm boundaries`) fails CI on any boundary violation.

## Consequences

- The full engine runs in-memory in unit tests and demos, deterministically.
- Adding a storage or LLM provider is a new adapter plus the contract suite, with no core change.
- Some indirection cost; accepted.
