# Follow-up Engine

Clinical follow-up engine by [Hipócrates](https://hipocratesalud.com). It reads what already exists in a patient's record (orders, prescriptions, progress notes, reports) and turns it into expectations: "this should happen before this date". When an expectation expires unmet, the clinic sees one card per patient, every reason grouped, so nobody falls through the cracks.

It is an operational, continuity-of-care tool for the clinic. It never gives patients medical advice: every finding is a suggestion to the clinician, with cited evidence.

## How it works

A host EHR (Hipócrates today, any EHR tomorrow) pushes clinical data as HL7 FHIR R4 through an HTTP API. The engine normalizes it into clinical events, applies versioned rules, protocols and an LLM reading of the doctor's plan to create expectations (FHIR `Task`), watches their deadlines, opens and escalates cases (also `Task`), and calls the host back through signed webhooks. Each attempt to reach a patient is a `CommunicationRequest` and the host answers with a `Communication` (replied, booked, wrong number, ...), so the engine knows when to wait, call, try again or close the case.

Each clinic can run a rule with its own deadline, or switch it off, without a new rule version: overrides are versioned and audited (who, when, old → new, why), apply to expectations created afterwards and are managed with `clinic:rules` or `GET/PUT /api/admin/rules` (scope `admin:rules`). Every night a **reconciliation** replays the stored record of the patients with new events through the same annotator, in a transaction it rolls back, and repairs only what a lost or out-of-order event left inconsistent (a missing expectation, a closure the record calls for, a case that should be resolved or opened), each repair audited as `system` / `reconciliation`; a clean clinic is a no-op ([integration.md](docs/integration.md#nightly-reconciliation)).

On top, a **clinical reviewer** looks for what nobody wrote down ([docs/reviewer.md](docs/reviewer.md)): a creatinine rising over three results that no note mentions, metformin with a falling eGFR, a headache in three notes never worked up.

- Deterministic detectors compute trends and run curated checks.
- An LLM agent behind `llm_gateway`, limited to read-only tools over one patient's record (`get_lab_trend`, `get_notes`, `check_interaction`, ...), confirms, discards or adds findings.
- Code then checks every citation word for word against the record and decides what is already covered.
- Findings are suggestions to the clinical team with cited evidence (FHIR `DetectedIssue`). They start in **shadow mode**, reviewed in batches by clinical staff, and a category reaches doctors only after the team signs it off.

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

The demo clinic has two keys, both synthetic and refused on a real clock: `demo-clinic-key`, the host integration key (`fhir:write`, the inbox and the demo controls), and `demo-inbox-key` for the inbox (`inbox:read`, `inbox:act`, `demo:clock`, `demo:ingest`; it cannot ingest FHIR, and demo consultations only go to the synthetic demo clinic). Set `DEMO_API_KEY` / `DEMO_INBOX_API_KEY` to change them. In production each clinic gets its own scoped keys from `pnpm --filter @follow-up-engine/api clinic:create` and the inbox runs behind the host's login ([deploy.md](docs/deploy.md#security-checklist-production)); `clinic:rules` changes a clinic's rule deadlines and `clinic:reconcile` runs the nightly reconciliation by hand ([deploy.md](docs/deploy.md#rule-overrides)).

`pnpm demo` loads the synthetic clinic (148 fictional patients, two years of history) through the initial backfill, the way a real clinic is switched on: about 5 s in memory. The demo clinic runs every care protocol, the drafts included ([docs/protocols.md](docs/protocols.md); a real clinic runs diabetes and hypertension until its clinical team enables more), and its host sends every patient's allergy list (`recordCapabilities: ['allergies']`). It ends with 101 cases with origin `backfill` for 91 patients (at most 2 per patient). The demo clinic releases at most 5 of them per owner and day (`dailyCaseCapPerOwner`, 20 for real clinics), so the inbox starts with 45, 56 wait in "To recover" with their release day, and "+1 day" on the Demo page lets in the next batch (39 on day 1, the last 17 on day 2). By layer (a case can have reasons of several): 40 doctor's plan, 37 protocol, 33 universal, 9 cadence. By protocol: 17 diabetes, 9 hypertension, 5 chronic kidney disease, 5 dyslipidemia, 4 pregnancy, 2 hypothyroidism; the patients on an antidepressant all keep their controls, so treatment follow-up opens none (psychotherapy alone does not enroll, and a discharge ends it). By the patient's specialty: 35 diabetology, 26 internal medicine, 23 gynecology, 17 psychology. By priority: 6 high, 21 medium, 74 low.

The clinical reviewer's shadow pilot runs on top. Twenty more synthetic patients, the reviewer cohort, join through the same backfill: ten with planted findings, ten controls. Their 10 cases add 9 to the inbox on day 0 (54 in all) and 1 to "To recover" (57, the last 18 released on day 2). The inbox shows them as 53 patient cards: one card per patient, every reason grouped (one patient has two cases on day 0) (the engine still escalates, deduplicates and audits each case on its own). Then every one of the 168 patients gets one review: 69 shadow findings, about 41 per 100 patients, 19 of them already covered by an open expectation or case (`alreadyCovered`):

- 25 questions for the next visit
- 17 missing check-ups
- 14 record quality (allergy status missing while prescribing: 13 patients without an `AllergyIntolerance`, and the cohort's planted one)
- 3 drug interactions, 3 lab trends and 3 unaddressed symptoms
- 2 vital-sign trends
- 1 drug-condition conflict and 1 abnormal result without follow-up

Visits a plan or a protocol asked for (a near-term pregnancy seen weekly, the controls after a dose change) are not a change in utilization: none is reported.

"Clinical review" lists them for the clinical staff's verdicts. `SEED_REVIEWER=false` skips the cohort and the reviews. "Categories" turns each category live once someone signs it off.

**Metrics** (`GET /api/inbox/metrics`, [docs/metrics.md](docs/metrics.md)) tells what the engine did for the clinic over a period: cases opened, how many ended in a booking and in a visit, split by whether the booking came from working the case, from a contact request or on its own (the host names the case `Task` or `CommunicationRequest` on the FHIR `Appointment`, and the engine verifies it), the time from a case reaching the inbox to the team's first action, feedback, dismissals, the conditions doctors confirmed or rejected, and AI cost per task, per case and per review. Every case reason also says which rule and protocol version produced it.

The Demo page saves a consultation, shows how the note was read (and in which language) and moves the simulated clock; signed webhooks land in an in-process sink. The numbers above are those of the fake provider (no key, and always in CI); with a Meta key the notes are read by Muse Spark (below).

### Notes are read by Muse Spark

Every LLM call goes through one `llm_gateway`, and the model behind it is Meta's: **Muse Spark** (`muse-spark-1.3`) on the Meta Model API, reasoning `low`. Put `META_API_KEY` in `.env` and it is the default (`LLM_PROVIDER` empty): the API, the worker and `pnpm demo` read notes and run the clinical reviewer on it. Without a key, and always in CI, the fake provider runs instead (a rule-based reader and a scripted reviewer, through the same gateway and checks). `LLM_PROVIDER=baseten` selects Muse Spark Open on Baseten (ready, no key yet); `openai-compatible` exists only to benchmark other models on the same evals.

On the 101 gold notes Muse Spark scores conditions F1 91.2%, medications 98.1%, plan items 92.8% (recall 99.2%), pregnancy 100%, with 0 hallucinated quotes, $0.0049 and 3.4 s (p50) per note; as the clinical reviewer it finds all 13 planted findings of the cohort with no false positive and 0 hallucinated citations, at $0.013 per review. Every number, every miss and how to reproduce them offline: [docs/evals](docs/evals/README.md).

`pnpm demo` with a key boots in about 11 s: the seed never calls the model. It replays the readings Muse Spark gave once for the synthetic clinic (`packages/testkit/fixtures/llm-snapshots/demo-clinic.meta.json`, 867 notes, recorded with `pnpm --filter @follow-up-engine/api demo:record`), so the inbox is built from Muse Spark's reading of every doctor's plan, the same on every boot and at no cost. A seed request the recording does not hold (the reviewer cohort's notes and most shadow-pilot reviews, left out to keep the hackathon's model budget; any request after a prompt change) is read by the fake provider instead, labeled `fake` in the usage log and in the review run's model, never passed off as Muse Spark. Once the seed is done, every request calls Muse Spark live: a consultation from the Demo page (about 6 s end to end, $0.008) or a Bundle sent to `POST /fhir` (about 4 s with `?sync=true`); the Demo page shows the model, its cost and its latency next to each item and its verbatim evidence quote. With Muse Spark the seeded clinic opens 113 backfill cases instead of 101 (45 released, 68 held for "To recover") and the inbox starts with 54 cases on 52 patient cards after the reviewer pilot.

The inbox's stats bar names the reader ("Muse Spark · Meta") and shows the month's LLM cost, the notes read and the cost per note, from the per-clinic usage log (`llm_calls`). Replayed readings are accounted at what Muse Spark charged when they were recorded (after the seed the bar shows about $4.77 for the month, 954 note readings, $0.0050 per note), so the figures are those of reading the clinic with Muse Spark; live calls add to them. Re-record after a prompt change: `pnpm --filter @follow-up-engine/api demo:record` (about $7.3 and 25 min for the whole clinic and its 185 reviews; `--max-usd` caps it, `--no-reviews` records the backfill only).

### Languages

The inbox reads in English by default; the EN / ES switch in its header turns every screen and every label the API returns to Spanish (remembered per browser, sent as `Accept-Language`). Clinical content is never translated: the synthetic notes are Spanish, the evidence quotes stay Spanish under an English UI, and an English note (the Demo page has one) is read with English lexicons. The demo clinic's locale is `en-US`, its synthetic patients prefer Spanish (`Patient.communication` `es-VE`, forwarded on every contact request so the host writes the message in it). Four independent languages (user, clinic, patient, note): [ADR 0007](docs/adr/0007-language-model.md), [integration.md](docs/integration.md#languages).

### On Postgres

```sh
docker compose up -d postgres                                   # Postgres 16 on localhost:54329
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine
pnpm demo                 # migrates, seeds through the backfill and the reviewer pilot (about 45 s; a no-op once seeded), serves
pnpm e2e                  # end-to-end suite: API + worker against Postgres, real signed webhooks
pnpm test                 # with DATABASE_URL set, the contract and acceptance suites also run on Postgres
```

`DEMO_API_KEY=demo-clinic-key pnpm seed` seeds without serving (and registers `demo-inbox-key`, or `DEMO_INBOX_API_KEY`, for the inbox). The fake clock lives in the API process: restarting the demo starts again on the seed date (2026-01-05).

### Docker

```sh
docker compose --profile demo up --build      # Postgres + the demo (API, worker, seed) on http://localhost:3000
docker compose --profile app up --build       # production-like split: API, worker and a webhook sink, system clock
```

To put the demo on a public URL (API and inbox on one origin, a shared access code, Spanish by default if you want it): [deploy.md](docs/deploy.md#hosted-demo).

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `pnpm verify`      | Everything CI runs, in order                                        |
| `pnpm lint`        | ESLint (typescript-eslint strict, type-checked) + Prettier check    |
| `pnpm typecheck`   | `tsc` in every package                                              |
| `pnpm boundaries`  | dependency-cruiser: hexagonal import rules, no cycles               |
| `pnpm test`        | Vitest, every package as a project                                  |
| `pnpm e2e`         | End-to-end suite against `DATABASE_URL`                             |
| `pnpm demo`        | API + embedded worker on a fake clock, synthetic clinic seeded      |
| `pnpm inbox`       | The clinic inbox (Vite dev server)                                  |
| `pnpm deploy:demo` | Redeploys the hosted demo ([deploy.md](docs/deploy.md#hosted-demo)) |
| `pnpm format`      | Prettier write                                                      |

## Architecture decisions

- [0001 FHIR R4 as the data model](docs/adr/0001-fhir-r4-data-model.md)
- [0002 Hexagonal architecture](docs/adr/0002-hexagonal-architecture.md)
- [0003 Postgres job runner and transactional outbox](docs/adr/0003-postgres-job-runner-and-outbox.md)
- [0004 Single llm_gateway, Meta models first](docs/adr/0004-llm-gateway-meta-models.md)
- [0005 HTTP API on Hono, one engine runtime for the API and the worker](docs/adr/0005-http-api-and-runtime.md) (amended: the runtime is `packages/runtime`)
- [0006 Clinical reviewer: deterministic detectors, a bounded LLM agent, code-checked findings, shadow first](docs/adr/0006-clinical-reviewer-agent.md)
- [0007 Language model: clinic, user, patient and note languages](docs/adr/0007-language-model.md)

## Principles

- All AI runs on Meta models, through a single `llm_gateway`.
- Multi-tenant: `clinic_id` on every table and query.
- English UI by default, Spanish as second locale, typed catalogs; clinical text is never translated.
- Synthetic patients only. No real clinical data in this repository, ever.

## Provenance

All code in this repository was written during the Meta AI Developer Hackathon 2026 (October 27 – November 4, 2026). It is an independent module with clear interfaces for later integration into Hipócrates, and contains no preexisting Hipócrates code.

## Data

Every patient, note and result in this repository (fixtures, tests, demos, evals) is synthetic. No real patient data is stored, used or committed here.
