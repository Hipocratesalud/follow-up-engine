# 0005. HTTP API on Hono, one engine runtime for the API and the worker

- Status: Accepted
- Date: 2026-10-27

## Context

The engine needs an HTTP face (FHIR R4 for the host, a JSON API for the clinic inbox, demo controls) and a background process (jobs, deadline and escalation sweeps, webhook delivery). Both must wire the same adapters from the same configuration, run as two processes in production and as one for a demo, and be testable without sockets.

## Decision

**Hono** for the HTTP layer (`apps/api`), served on Node by `@hono/node-server`.

- Web-standard `Request`/`Response`: `app.request()` exercises the whole app in-process in unit tests (memory adapters, no port), and the same app runs on Node, Bun, Deno or an edge runtime if a host wants it next to Supabase.
- Raw bodies are trivial to read, which signature verification needs (the webhook sink).
- Small and dependency-light. Fastify 5 was the alternative: faster on benchmarks and with a richer plugin ecosystem (pino built in, swagger), but clinic workloads are far below either's limits, and its request model is Node-only.
- Validation and the OpenAPI document both come from the same zod schemas (`z.toJSONSchema` over the schemas registered with `.meta({ id })`), so the published contract cannot drift from the code. Logs are pino JSON with the clinic id and never PHI.

**One runtime, exported by `apps/worker`.** `createRuntime(config)` is the composition root: it reads the environment once and picks Postgres or memory storage (`DATABASE_URL`), the system or a fake clock (`CLOCK`), the LLM provider behind the `llm_gateway` (`LLM_PROVIDER`, no silent fallback to another vendor) and where webhooks go (`WEBHOOK_URL`, else an in-process sink that still signs and verifies). The worker process runs `Worker` loops over it; the API process builds the same runtime and adds HTTP, optionally with the worker embedded (`EMBEDDED_WORKER=true`).

This is the one app-to-app edge in the graph: `apps/api` imports `apps/worker`'s entry point and nothing else from it, enforced by the `api-runs-on-the-worker-runtime` rule in `.dependency-cruiser.cjs`. The alternatives were a shared workspace package that wires adapters (contradicts "only apps wire adapters", ADR 0002) or duplicating the composition root in both apps (two places to keep in sync).

**Ingestion is asynchronous by default.** `POST /fhir` validates and maps the Bundle (pure functions), stores the resources and enqueues a `fhir.ingest_bundle` job in one transaction, and answers `202` in milliseconds; the LLM call happens in the worker. `?sync=true` (or `Prefer: respond-sync`) runs the engine before answering, for demos and tests.

## Consequences

- One image runs every process (`apps/api/Dockerfile`); a demo is one container, production is API + worker on the same Postgres.
- With a fake clock, run the worker embedded: each process has its own fake clock, so a separate worker would not see the API's simulated time.
- Code that belongs in packages lives in the runtime for now and is listed for the integration: the webhook publisher (`adapter-webhook`), the read queries the inbox needs (`ExpectationRepository.listByPatient`, `LlmUsageLog` summaries), and the user-initiated patient contact request (`CaseCommands.requestPatientContact`).
