# Follow-up Engine

Clinical follow-up engine by [Hipócrates](https://hipocratesalud.com). It reads what already exists in a patient's record (orders, prescriptions, progress notes, reports) and turns it into expectations: "this should happen before this date". When an expectation expires unmet, the clinic sees one case per patient so nobody falls through the cracks.

It is an operational, continuity-of-care tool for the clinic. It never gives patients medical advice: every finding is a suggestion to the clinician, with cited evidence.

## How it works

A host EHR (Hipócrates today, any EHR tomorrow) pushes clinical data as HL7 FHIR R4 through an HTTP API. The engine normalizes it into clinical events, applies versioned rules, protocols and an LLM reading of the doctor's plan to create expectations (FHIR `Task`), watches their deadlines, opens and escalates cases (also `Task`), and calls the host back through signed webhooks.

```
              FHIR R4 (HTTP)                          webhooks (signed)
  Host EHR ─────────────────┐                ┌──────────────────────▶ Host EHR
                            ▼                │
                  ┌──────────────────┐  ┌──────────────────┐
                  │     apps/api     │  │   apps/worker    │   process entry points
                  └────────┬─────────┘  └────────┬─────────┘
                           │  packages/runtime: wires adapters to ports
        ┌──────────────────┼─────────────────────┼──────────────────┐
        │                  ▼   packages/core     ▼                  │
        │   domain: clinical events, expectations, cases, rules     │
        │   ports:  repositories · AuditLog · UnitOfWork · JobQueue │
        │           Clock · EventPublisher · LlmGateway · RuleSource│
        └───────▲──────────────────▲──────────────────▲─────────────┘
                │                  │                  │
     adapter-postgres       adapter-memory          llm (Meta models,
     (Postgres/Supabase,    (tests, demos)          OpenAI-compatible, fake)
      SKIP LOCKED jobs,
      outbox)                      fhir: FHIR R4 ⇄ domain events
```

## Repository layout

```
apps/
  api/                HTTP API: FHIR in and out, clinic inbox JSON API, demo controls
  worker/             worker process (jobs, sweeps, outbox delivery) and dev webhook sink
  inbox/              clinic inbox UI (React; talks to apps/api over HTTP, or an in-browser mock)
packages/
  runtime/            composition root: adapters from env, ingestion, worker loops, webhooks
  core/               pure domain + ports, zero I/O
  fhir/               FHIR R4 types, validation, mapping to domain events
  adapter-postgres/   Postgres adapters (vanilla Postgres and Supabase)
  adapter-memory/     in-memory adapters
  llm/                llm_gateway and providers
  testkit/            contract tests every adapter must pass, synthetic fixtures
  acceptance/         tests only: contract suites on every adapter, FHIR scenarios end to end, backfill
config/
  rules/              versioned JSON rules
  protocols/          versioned JSON care protocols
docs/adr/             architecture decision records
```

## Quickstart

Requires Node 22 (`.nvmrc`) and pnpm 10 (pinned in `package.json` through `packageManager`).

```sh
corepack enable pnpm      # or: npm i -g pnpm@10 (an older global pnpm is rejected by engines)
pnpm install
pnpm verify               # lint + typecheck + boundaries + test
```

### The demo in one command

```sh
pnpm demo                 # API on http://localhost:3000, in memory, fake clock, embedded worker
pnpm inbox                # in another terminal, with the variables below; inbox on http://localhost:5173
```

Run the inbox against the API with `VITE_API_URL=http://localhost:3000 VITE_API_KEY=demo-inbox-key pnpm inbox` (the demo prints both demo keys at startup). Without those variables it opens on an in-browser mock instead.

The demo clinic has two keys, both synthetic and refused on a real clock: `demo-clinic-key`, the host integration key (`fhir:write`, the inbox and the demo controls), and `demo-inbox-key` for the inbox (`inbox:read`, `inbox:act`, `demo:clock`, `demo:ingest`; it cannot ingest FHIR, and demo consultations only go to the synthetic demo clinic). Set `DEMO_API_KEY` / `DEMO_INBOX_API_KEY` to change them. In production each clinic gets its own scoped keys from `pnpm --filter @follow-up-engine/api clinic:create` and the inbox runs behind the host's login ([deploy.md](docs/deploy.md#security-checklist-production)).

`pnpm demo` loads the synthetic clinic (148 fictional patients, two years of history) through the initial backfill, the way a real clinic is switched on: about 3 s in memory. The demo clinic runs every care protocol, the drafts included ([docs/protocols.md](docs/protocols.md); a real clinic runs diabetes and hypertension until its clinical team enables more). It ends with 104 cases with origin `backfill` for 94 patients (at most 2 per patient). The demo clinic releases at most 5 of them per owner and day (`dailyCaseCapPerOwner`, 20 for real clinics), so the inbox starts with 45, 59 wait in "Por recuperar" with their release day, and "+1 día" on the Demo page lets in the next batch (41 on day 1, 16 on day 2, the last 2 on day 3). By layer (a case can have reasons of several): 33 universal, 40 doctor's plan, 44 protocol, 9 cadence. By protocol: 17 diabetes, 9 hypertension, 7 dyslipidemia, 7 treatment follow-up, 5 chronic kidney disease, 4 pregnancy, 2 hypothyroidism. By the patient's specialty: 35 diabetology, 26 internal medicine, 23 gynecology, 20 psychology. By priority: 6 high, 21 medium, 77 low. The Demo page saves a consultation, shows how the note was read and moves the simulated clock; signed webhooks land in an in-process sink. Notes are read by the fake provider (rules, no model) unless you set `LLM_PROVIDER=meta` and `META_API_KEY` (see `.env.example`).

### On Postgres

```sh
docker compose up -d postgres                                   # Postgres 16 on localhost:54329
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine
pnpm demo                 # migrates, seeds through the backfill (about 11 s; a no-op once seeded), serves
pnpm e2e                  # end-to-end suite: API + worker against Postgres, real signed webhooks
pnpm test                 # with DATABASE_URL set, the contract and acceptance suites also run on Postgres
```

`DEMO_API_KEY=demo-clinic-key pnpm seed` seeds without serving (and registers `demo-inbox-key`, or `DEMO_INBOX_API_KEY`, for the inbox). The fake clock lives in the API process: restarting the demo starts again on the seed date (2026-01-05).

### Docker

```sh
docker compose --profile demo up --build      # Postgres + the demo (API, worker, seed) on http://localhost:3000
docker compose --profile app up --build       # production-like split: API, worker and a webhook sink, system clock
```

| Command           | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `pnpm verify`     | Everything CI runs, in order                                     |
| `pnpm lint`       | ESLint (typescript-eslint strict, type-checked) + Prettier check |
| `pnpm typecheck`  | `tsc` in every package                                           |
| `pnpm boundaries` | dependency-cruiser: hexagonal import rules, no cycles            |
| `pnpm test`       | Vitest, every package as a project                               |
| `pnpm e2e`        | End-to-end suite against `DATABASE_URL`                          |
| `pnpm demo`       | API + embedded worker on a fake clock, synthetic clinic seeded   |
| `pnpm inbox`      | The clinic inbox (Vite dev server)                               |
| `pnpm format`     | Prettier write                                                   |

## Architecture decisions

- [0001 FHIR R4 as the data model](docs/adr/0001-fhir-r4-data-model.md)
- [0002 Hexagonal architecture](docs/adr/0002-hexagonal-architecture.md)
- [0003 Postgres job runner and transactional outbox](docs/adr/0003-postgres-job-runner-and-outbox.md)
- [0004 Single llm_gateway, Meta models first](docs/adr/0004-llm-gateway-meta-models.md)
- [0005 HTTP API on Hono, one engine runtime for the API and the worker](docs/adr/0005-http-api-and-runtime.md) (amended: the runtime is `packages/runtime`)

## Principles

- All AI runs on Meta models, through a single `llm_gateway`.
- Multi-tenant: `clinic_id` on every table and query.
- Synthetic patients only. No real clinical data in this repository, ever.

## Provenance

All code in this repository was written during the Meta AI Developer Hackathon 2026 (October 27 – November 4, 2026). It is an independent module with clear interfaces for later integration into Hipócrates, and contains no preexisting Hipócrates code.

## Data

Every patient, note and result in this repository (fixtures, tests, demos, evals) is synthetic. No real patient data is stored, used or committed here.
