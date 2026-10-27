# 0005. HTTP API on Hono, one engine runtime for the API and the worker

- Status: Accepted; amended 2026-10-27 (the runtime moved from `apps/worker` to `packages/runtime`, see [Amendment](#amendment-the-runtime-is-a-package))
- Date: 2026-10-27

## Context

The engine needs an HTTP face (FHIR R4 for the host, a JSON API for the clinic inbox, demo controls) and a background process (jobs, deadline and escalation sweeps, webhook delivery). Both must wire the same adapters from the same configuration, run as two processes in production and as one for a demo, and be testable without sockets.

## Decision

**Hono** for the HTTP layer (`apps/api`), served on Node by `@hono/node-server`.

- Web-standard `Request`/`Response`: `app.request()` exercises the whole app in-process in unit tests (memory adapters, no port), and the same app runs on Node, Bun, Deno or an edge runtime if a host wants it next to Supabase.
- Raw bodies are trivial to read, which signature verification needs (the webhook sink).
- Small and dependency-light. Fastify 5 was the alternative: faster on benchmarks and with a richer plugin ecosystem (pino built in, swagger), but clinic workloads are far below either's limits, and its request model is Node-only.
- Validation and the OpenAPI document both come from the same zod schemas (`z.toJSONSchema` over the schemas registered with `.meta({ id })`), so the published contract cannot drift from the code. Logs are pino JSON with the clinic id and never PHI.

**One runtime, shared by every process.** `createRuntime(config)` is the composition root: it reads the environment once and picks Postgres or memory storage (`DATABASE_URL`), the system or a fake clock (`CLOCK`), the LLM provider behind the `llm_gateway` (`LLM_PROVIDER`, no silent fallback to another vendor) and where webhooks go (`WEBHOOK_URL`, else an in-process sink that still signs and verifies). The worker process runs `Worker` loops over it; the API process builds the same runtime and adds HTTP, optionally with the worker embedded (`EMBEDDED_WORKER=true`).

It lives in `packages/runtime` (`@follow-up-engine/runtime`); `apps/api` and `apps/worker` are thin process entry points over it. Originally it was exported by `apps/worker` and imported by `apps/api`, the one app-to-app edge in the graph; the amendment below removed that exception.

**Ingestion is asynchronous by default.** `POST /fhir` validates and maps the Bundle (pure functions), stores the resources and enqueues a `fhir.ingest_bundle` job in one transaction, and answers `202` in milliseconds; the LLM call happens in the worker. `?sync=true` (or `Prefer: respond-sync`) runs the engine before answering, for demos and tests.

## Consequences

- One image runs every process (`apps/api/Dockerfile`); a demo is one container, production is API + worker on the same Postgres.
- With a fake clock, run the worker embedded: each process has its own fake clock, so a separate worker would not see the API's simulated time.
- The inbox reads through the core ports (`ExpectationRepository.listByPatient`, `LlmUsageLog.summary`, `CaseRepository.list` with `unreleasedAsOf`) and "Pedir contacto" is the engine's `cases.requestPatientContact`. The one read query left in the runtime is the patient search by name (`ReadModel.searchPatients`): the engine never searches patients, so no port offers it.

## Amendment: the runtime is a package

- Date: 2026-10-27
- Supersedes: "the one app-to-app edge" (`apps/api` importing `apps/worker`) and the `api-runs-on-the-worker-runtime` rule.

The shared composition root moved to `packages/runtime`: adapter wiring from the environment (`createRuntime`, `loadRuntimeConfig`), the ingestion service (live and backfill import), the `Worker` loops, and the signed webhook publisher and development sink. The apps keep only what is specific to a process: `apps/api` the HTTP layer, `apps/worker` the worker and webhook-sink entry points.

Why: an app importing another app made "apps are leaves" a rule with an exception, and the worker app was a library in disguise. A package states what it is. This amends ADR 0002 on one point: adapters are wired in exactly one place, `packages/runtime`, instead of in each app; adapters still never import each other, and domain packages never see the runtime.

Enforced by `.dependency-cruiser.cjs`:

- `runtime-is-the-composition-root`: `packages/runtime` imports only core, fhir, llm and the adapters.
- `only-apps-use-the-runtime`: no domain or adapter package imports it (the acceptance tests may).
- `nothing-imports-apps`: no exceptions. Apps are leaves.
