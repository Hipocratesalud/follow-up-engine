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
                  │     apps/api     │  │   apps/worker    │   composition roots
                  └────────┬─────────┘  └────────┬─────────┘
                           │   wire adapters to ports
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
  api/                HTTP API, FHIR in and out (composition root)
  worker/             job runner, outbox delivery, deadline sweeps (composition root)
  inbox/              clinic inbox UI (placeholder)
packages/
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
docker compose up -d postgres   # Postgres 16 on localhost:54329, for integration tests
cp .env.example .env
```

| Command           | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `pnpm verify`     | Everything CI runs, in order                                     |
| `pnpm lint`       | ESLint (typescript-eslint strict, type-checked) + Prettier check |
| `pnpm typecheck`  | `tsc` in every package                                           |
| `pnpm boundaries` | dependency-cruiser: hexagonal import rules, no cycles            |
| `pnpm test`       | Vitest, every package as a project                               |
| `pnpm format`     | Prettier write                                                   |

## Architecture decisions

- [0001 FHIR R4 as the data model](docs/adr/0001-fhir-r4-data-model.md)
- [0002 Hexagonal architecture](docs/adr/0002-hexagonal-architecture.md)
- [0003 Postgres job runner and transactional outbox](docs/adr/0003-postgres-job-runner-and-outbox.md)
- [0004 Single llm_gateway, Meta models first](docs/adr/0004-llm-gateway-meta-models.md)

## Principles

- All AI runs on Meta models, through a single `llm_gateway`.
- Multi-tenant: `clinic_id` on every table and query.
- Synthetic patients only. No real clinical data in this repository, ever.

## Provenance

All code in this repository was written during the Meta AI Developer Hackathon 2026 (October 27 – November 4, 2026). It is an independent module with clear interfaces for later integration into Hipócrates, and contains no preexisting Hipócrates code.

## Data

Every patient, note and result in this repository (fixtures, tests, demos, evals) is synthetic. No real patient data is stored, used or committed here.
