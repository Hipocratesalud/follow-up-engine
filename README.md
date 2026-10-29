# Follow-up Engine

**A submission to the Meta AI Developer Hackathon 2026.**

Patients fall through the cracks silently: a lab order with no result, a care plan nobody completed, a chronic patient who stopped coming back. Nothing alerts the clinic because nothing failed — the EHR did its job, the visit was saved, the note was written. The gap is in what happens _after_.

The Follow-up Engine closes that gap. It is a standalone service a clinic's EHR talks to: the host sends clinical data as it is already produced (orders, prescriptions, notes, results), and the engine turns it into dated expectations, watches them, and surfaces only what is overdue — once, as one card per patient, with the evidence that explains it.

- **Who it's for.** Clinics and the EHRs that serve them. The host owns the patient relationship, the message channel and the UI; the engine does the follow-up bookkeeping and clinical reasoning behind it.
- **What it does.** Reads what the EHR already saves. Builds expectations with due dates from four independent layers (structured rules, the doctor's own plan, the patient's visit cadence, condition protocols). Opens a case when one expires unmet. Escalates and asks the host to contact the patient. Runs a bounded LLM agent in shadow mode that looks for what nobody wrote down. Calls the host back with signed webhooks.
- **What it never does.** It never contacts a patient directly, never gives patients medical advice, and never promotes a finding to clinicians without evidence attached to it.

Hipócrates (hipocratesalud.com) is the first host integration; the engine speaks HL7 FHIR R4 so any FHIR-capable EHR can plug in without engine changes.

## How it works

```mermaid
sequenceDiagram
    participant EHR as Host EHR
    participant API as apps/api
    participant Worker as apps/worker (engine)
    participant Clinic as Clinic inbox

    EHR->>API: POST /fhir (transaction Bundle)
    API-->>EHR: 202, transaction-response (ms)
    API->>Worker: enqueue fhir.ingest_bundle
    Note over Worker: universal rules (structured data)<br/>+ Muse Spark reads the doctor's plan<br/>+ cadence + protocols fill the gaps<br/>+ fulfillment / supersession
    Note over Worker: days later, a deadline passes
    Worker->>Clinic: webhook case.opened
    Worker->>EHR: webhook patient_contact.requested
    EHR->>EHR: sends WhatsApp (its own channel)
    EHR->>API: POST /fhir (Communication: outcome)
    EHR->>API: POST /fhir (result or Appointment)
    Worker->>Clinic: webhook case.resolved
```

1. **Consultation saved.** The host sends one FHIR `transaction` Bundle per saved consultation (`Encounter`, note, orders, prescriptions, diagnoses). The API validates and stores it and answers in milliseconds; the engine runs in the worker.
2. **Expectations, four layers, one precedence order.** Structured data creates `universal` expectations with no model involved (a lab order needs a result in 15 days). Free text is read once, at save time, by **Meta's Muse Spark** behind one `llm_gateway`, which turns the doctor's own words into dated plan items (`doctor_plan`) with a verbatim evidence quote. A break in the patient's own visit pattern creates a `cadence` expectation. Condition protocols (`protocol`) fill only what the first three layers left uncovered — the doctor's plan always wins, and an item a plan already asks for is never duplicated. Every rule and protocol is versioned, and every expectation records the version that created it.
3. **Fulfilment and supersession.** A matching result, visit or booking closes an expectation; a newer order of the same test supersedes it; a cancellation reopens what it closed. This runs on every event, live and in the nightly reconciliation that repairs what a lost or reordered event left inconsistent.
4. **Case.** An expectation that expires unmet opens (or joins) one case per patient and reason group — never a second card for the same patient.
5. **Escalation and the contact loop.** A named, versioned policy raises priority, asks the host to message the patient (a `CommunicationRequest`, generic purpose only, never clinical content), and escalates to a coordinator if nobody answers. The host reports the outcome back; the engine decides whether to wait, call again, or close the case.
6. **Clinician inbox, cited.** One card per patient. Every reason, every due date, opens its evidence in one click — recomputed from the stored record, never invented ("Due Aug 19 = last HbA1c 6.5% [May 21] + 90 days"), with the doctor's own words highlighted in the source note.
7. **Signed webhooks back to the host.** `case.opened`, `case.resolved`, `patient_contact.requested`, `clinical_finding.created`, and more — thin bodies (ids, codes, dates), HMAC-signed, delivered at least once from a transactional outbox.

## Meta AI usage

Every model call in this repository goes through one `llm_gateway` (`packages/llm`) to a single provider family: **Meta's Muse Spark**, via the Meta Model API, behind budget caps per clinic and a swappable provider port (Baseten's Muse Spark Open, an OpenAI-compatible adapter for benchmarking, or a deterministic `fake` provider that runs the exact same pipeline in CI and demos with no key, no network and no cost).

| Use                     | What it does                                                                                                                                                                                                         | Model            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Note extraction         | Reads the free-text note into conditions (ICD-10), medications, and the doctor's follow-up plan, each with a verbatim evidence quote. Runs once, at save time.                                                       | `muse-spark-1.3` |
| Clinical reviewer agent | A bounded agent (≤ 8 steps, ≤ 6 read-only tool calls) over one patient's dossier, confirming or adding findings code already detected. Shadow mode: never shown to a clinician until a human signs the category off. | `muse-spark-1.3` |

Every model call and its reply are recorded (`packages/testkit/fixtures/llm-snapshots/`), so every number below replays offline, for free, from the exact recorded response — no key needed, same score every time. How to reproduce each one: [docs/evals/README.md](docs/evals/README.md).

**Note extraction, 101 gold notes** ([full report](docs/evals/2026-10-27-meta-muse-spark-1.3.md), [comparison](docs/evals/comparison.md)):

| Field                        |    Muse Spark | Rule-based baseline | Oracle |
| ---------------------------- | ------------: | ------------------: | -----: |
| Conditions F1                |         91.2% |               84.3% |   100% |
| Medications F1               |         98.1% |               81.1% |   100% |
| Plan items F1 (recall 99.2%) |         92.8% |               97.2% |   100% |
| Pregnancy outcome and dating |          100% |                100% |   100% |
| Hallucinated quotes          |      0 of 348 |            0 of 303 |      0 |
| Cost per note                |       $0.0049 |                  $0 |     $0 |
| Latency p50 / p95            | 3.4 s / 6.8 s |                  ~0 |     ~0 |

The rule-based baseline's regexes were written looking at these same gold notes, so it overstates how well it generalizes; its plan-item precision is high only because the gold labeling convention matches its rules exactly. Every Muse Spark miss — mislabeled encounter reasons as conditions, an ICD-10 category a human might also pick differently, an untimed test next to a timed control — is catalogued note by note, with the fix already applied in code, in the [eval README](docs/evals/README.md#what-each-muse-spark-miss-is).

**Clinical reviewer agent, 20-patient cohort (10 planted findings, 10 controls)** ([full report](docs/evals/reviewer/2026-10-27-meta-muse-spark-1.3.md)):

| Metric                        | Value                      |
| ----------------------------- | -------------------------- |
| Precision                     | 100.0% (13 of 13 findings) |
| Recall                        | 100.0% (13 of 13 planted)  |
| Controls with any finding     | 0 of 10                    |
| Hallucinated citations stored | **0** of 44                |
| Steps / tool calls per review | 2.6 / 1.6                  |
| Cost per review               | $0.0132                    |

Both evals gate prompt and model changes; a regression fails the eval, not a judgment call. The design principle behind the reviewer is explicit in [ADR 0006](docs/adr/0006-clinical-reviewer-agent.md): **deterministic where it matters, agentic where it helps.** Code computes every trend and runs the curated checks; the model only confirms, discards or adds to what code already found; every citation the model returns is checked word-for-word against the stored record before anything is kept — one bad quote drops the whole finding, and it is never silently rewritten.

## Clinical safety and design principles

- **Suggestions to the clinician, never advice to the patient.** Every finding is a suggestion with cited evidence for the clinic team. A patient contact request carries a generic purpose (`schedule_follow_up`, ...) and ids only — never a diagnosis, a test name or free text; the engine never phrases anything for the patient to read.
- **Nothing is enabled without clinical validation.** Every care protocol ships `status: draft` until a clinical team signs it off, and the inbox marks every reason from a draft protocol "Draft protocol · pending clinical validation." The clinical reviewer starts every category off and in shadow; a category reaches clinicians only with `validatedBy`, a named clinician, enforced by the API, the domain and a database `CHECK` — not a convention.
- **Shadow mode is not a demo mode.** Shadow findings are stored, run through the same checks as a live finding, and shown only in the staff's batch review ("Clinical review"). They are never exported to FHIR, never sent as a webhook, and Supabase row-level security hides them from clinic users by default.
- **The physician confirms, with one click.** A doctor's-plan item the AI read from a note is a suggestion until a clinician confirms it (`follow-up-confirmed-by`); a correction supersedes it and keeps the evidence; a rejection cancels it. The condition inference pipeline never overwrites a clinician's own verdict.
- **Rule configuration is versioned, not edited in place.** Every rule and protocol is a versioned JSON file; every expectation records the exact version that created it. A per-clinic override (a different deadline, a rule switched off) is itself versioned and audited — who, when, old value, new value, why.
- **The model never sees more than it needs.** Direct identifiers are masked before reaching the reviewer agent (`[REDACTADO]`), host text is escaped so a note cannot forge a prompt delimiter, and the agent's tools are read-only, scoped to one patient's record.

## Architecture

Hexagonal (ports and adapters), enforced by `dependency-cruiser` on every commit, not left to convention ([ADR 0002](docs/adr/0002-hexagonal-architecture.md)).

```mermaid
flowchart TB
    subgraph apps["apps (process entry points)"]
        API[api]
        Worker[worker]
        Inbox[inbox — React UI]
    end
    Runtime["packages/runtime<br/>(composition root — the only place that wires adapters)"]
    Core["packages/core<br/>pure domain + ports, zero I/O, zero vendor SDKs"]
    FHIR["packages/fhir<br/>FHIR R4 ⇄ domain, pure functions"]
    PG["packages/adapter-postgres<br/>Postgres / Supabase, SKIP LOCKED jobs, outbox, RLS"]
    Mem["packages/adapter-memory<br/>tests, demos"]
    LLM["packages/llm<br/>llm_gateway: Meta, Baseten, OpenAI-compatible, fake"]

    Inbox -. HTTP .-> API
    API --> Runtime
    Worker --> Runtime
    Runtime --> Core
    Runtime --> PG
    Runtime --> Mem
    Runtime --> LLM
    FHIR --> Core
    PG --> Core
    PG --> FHIR
    Mem --> Core
    LLM --> Core
```

- `packages/core` imports nothing but itself and zod: no `pg`, no vendor SDK, no `node:fs|net|http`, no other workspace package. It runs, deterministically, in a unit test or an in-memory demo with no infrastructure.
- Adapters never import each other. Only `packages/runtime` wires them to ports; only apps (and acceptance tests) import the runtime.
- Every adapter — Postgres and in-memory alike — passes the same contract test suite from `packages/testkit`, so the memory adapter is a faithful, fast stand-in for Postgres in tests.
- `packages/adapter-postgres` runs unchanged on vanilla Postgres 15+ and on Supabase (its own schema, `follow_up`, with row-level security on by default and an optional policy set for hosts that read the engine's tables directly through the Supabase Data API).

### FHIR R4 mapping

The engine's own state is exposed as standard FHIR resources ([ADR 0001](docs/adr/0001-fhir-r4-data-model.md), full contract in [docs/fhir.md](docs/fhir.md)):

| Domain object                    | FHIR resource               | Notes                                                                                                                                               |
| -------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expectation                      | `Task` (`intent: plan`)     | `businessStatus` = exact engine status; due date in `restriction.period.end`; layer, rule and protocol version, evidence as extensions              |
| Case                             | `Task` (`intent: proposal`) | `businessStatus`, numeric priority, `owner`, one `input[]` per reason with its rule and protocol version                                            |
| Inferred condition               | `Condition`                 | `verificationStatus` / `clinicalStatus` per engine status; confidence and evidence as extensions                                                    |
| Documentation / clinical finding | `DetectedIssue`             | shadow findings never exported; live ones carry cited evidence (`evidence[].detail[].display` = verbatim quote) and a suggestion, never a diagnosis |
| Case audit trail                 | `Provenance`                | one entry per case event, `agent` = user, patient, rule or the engine itself                                                                        |
| Contact attempt                  | `CommunicationRequest`      | generic purpose only, patient's preferred language forwarded, never clinical content                                                                |
| Contact outcome                  | `Communication`             | `basedOn` the attempt; strongest outcome wins when several arrive                                                                                   |
| Rule suppressed for a patient    | `Flag`                      | one per clinic, patient and rule; reversible ("Turn back on")                                                                                       |
| Booking attribution              | `Appointment` (inbound)     | the host names the case or contact attempt it answers; the engine verifies the claim before trusting it, else stores it `organic`                   |

Every resource the package emits is validated in CI against the official FHIR R4 JSON Schema.

## Rules as configuration

A rule declares a **trigger**, what **fulfils** it, what **supersedes** it, and an **escalation policy**; a protocol adds enrollment criteria and a schedule. Both are versioned JSON ([config/rules](config/rules), [config/protocols](config/protocols)), validated by zod schemas, never edited by a running process. Every expectation a rule or protocol creates records the exact version that produced it, and a per-clinic override (deadline, on/off) is itself versioned and audited (who, when, old → new, why) — [integration.md](docs/integration.md#per-clinic-rule-overrides).

**Precedence:** the doctor's plan beats the protocol and the cadence layer; cadence needs an established pattern (2+ previous visits); one case per patient and reason group, never a second card for the same patient.

| Rule id                           | Layer       | Version | Deadline                                                  |
| --------------------------------- | ----------- | ------- | --------------------------------------------------------- |
| `lab_order_result_pending`        | universal   | 1.2.0   | 15 days                                                   |
| `imaging_order_result_pending`    | universal   | 1.1.0   | 30 days                                                   |
| `short_treatment_followup`        | universal   | 1.3.0   | end of treatment + 3 days                                 |
| `abnormal_result_followup`        | universal   | 1.3.0   | 7 days, unless the patient is already at target           |
| `abnormal_imaging_followup_study` | universal   | 1.0.0   | what the report's own conclusion calls for (e.g. BI-RADS) |
| `doctor_plan_followup`            | doctor_plan | 1.1.0   | the plan item's own date                                  |
| `cadence_break`                   | cadence     | 1.2.0   | 3× the patient's own median visit interval                |

Escalation policies are named and versioned too: `default_v1` (notify day 0, contact day 14, coordinator day 21, lost day 35) and `default_v2` (the demo clinic's: WhatsApp day 14, front-desk call day 21 if unanswered, coordinator day 21, second WhatsApp day 28, lost day 35). A case keeps the policy it opened with.

Every care protocol is a `draft` today — a deliberate state, not a gap: a draft runs only for a clinic that opts in, and every reason it produces is labeled "pending clinical validation" until a clinical team signs it off ([docs/protocols.md](docs/protocols.md)).

| Protocol                            | Id                       | Version | Status | On by default |
| ----------------------------------- | ------------------------ | ------- | ------ | ------------- |
| Diabetes                            | `diabetes`               | 1.2.1   | draft  | yes (legacy)  |
| Hypertension                        | `hypertension`           | 1.1.1   | draft  | yes (legacy)  |
| Pregnancy and postpartum            | `pregnancy`              | 0.1.0   | draft  | no            |
| Depression and anxiety on treatment | `treatment_followup`     | 0.2.0   | draft  | no            |
| Hypothyroidism                      | `hypothyroidism`         | 0.1.0   | draft  | no            |
| Dyslipidemia                        | `dyslipidemia`           | 0.1.0   | draft  | no            |
| Chronic kidney disease              | `chronic_kidney_disease` | 0.1.0   | draft  | no            |

## Clinical validation with physicians

All patients in every validation session below are **synthetic**. No real patient data has been used, stored or committed anywhere in this repository.

On 2026-10-27, a team of practicing physicians reviewed the hosted demo against each synthetic patient's documents: 148 synthetic patients, 2,268 FHIR bundles, 867 clinical documents read by Muse Spark. Recorded in the engine's own case log during that session:

| Metric                                       | Result       |
| -------------------------------------------- | ------------ |
| Extracted plan items confirmed by physicians | 21           |
| Extracted plan items corrected               | 0            |
| Extracted plan items rejected                | 0            |
| Cases resolved as handled                    | 28           |
| Cases rated useful                           | 6            |
| Cases rated not useful                       | 0            |
| Session lead's overall verdict               | Satisfactory |

This was a first pass, not the finished protocol. A structured evaluation continues against the clinical team guide, which asks physicians to check rule timeframes, the diabetes and hypertension protocols, the AI's extraction against the source notes, and patient message templates, aiming at a review of 100 test-mode cases. Every evaluator now signs in with their own email, and every action they take is recorded for later analysis — an evaluator lab purpose-built for this is being added.

| Validation point                                         | Status                |
| -------------------------------------------------------- | --------------------- |
| Hosted-demo review against synthetic patient documents   | Completed, 2026-10-27 |
| Rule timeframes (universal layer deadlines)              | In review             |
| Diabetes and hypertension protocols                      | In review             |
| AI extraction review against the source notes            | In review             |
| Test-mode case review (target: 100 cases)                | Started 2026-10-27    |
| Patient message templates                                | In review             |
| Per-evaluator sign-in and action logging (evaluator lab) | In progress           |

## Try it

**Hosted demo:** https://follow-up-engine-demo-production.up.railway.app — a shared access code is required; it is provided to judges in the hackathon submission form. The demo runs on a fake clock over a synthetic clinic; "+1 day" advances it for everyone watching.

**Local quickstart** (Node 22, pnpm 10):

```sh
corepack enable pnpm        # or: npm i -g pnpm@10 — an older global pnpm is rejected by `engines`
pnpm install
pnpm verify                 # lint + typecheck + boundaries + test
pnpm demo                    # API on :3000, in memory, fake clock, embedded worker, 148-patient clinic seeded
pnpm inbox                   # in another terminal — inbox on :5173
```

With Postgres (vanilla or Supabase-shaped), docker included:

```sh
docker compose up -d postgres                                   # Postgres 16 on localhost:54329
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine
pnpm demo                    # migrates, seeds, serves
pnpm e2e                      # end-to-end: API + worker against Postgres, real signed webhooks
```

| Command           | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `pnpm verify`     | Everything CI runs: lint, typecheck, boundaries, test      |
| `pnpm lint`       | ESLint (type-checked, strict) + Prettier check             |
| `pnpm typecheck`  | `tsc` in every package                                     |
| `pnpm boundaries` | dependency-cruiser: hexagonal import rules, no cycles      |
| `pnpm test`       | Vitest, every package as a project                         |
| `pnpm e2e`        | End-to-end suite against `DATABASE_URL`                    |
| `pnpm demo`       | API + embedded worker, fake clock, synthetic clinic seeded |
| `pnpm inbox`      | The clinic inbox (Vite dev server)                         |
| `pnpm format`     | Prettier write                                             |

**Environment variables** (names only — see [.env.example](.env.example) for the full annotated list and [docs/deploy.md](docs/deploy.md) for production):

| Variable                                                                                            | Purpose                                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_SCHEMA`                                                                   | Postgres connection; unset = in-memory storage (demo only)                                  |
| `LLM_PROVIDER`, `META_API_KEY`, `META_MODEL`                                                        | Which provider behind `llm_gateway`, and Muse Spark's key and model                         |
| `BASETEN_API_KEY`, `BASETEN_MODEL`                                                                  | Muse Spark Open via Baseten                                                                 |
| `OPENAI_COMPATIBLE_BASE_URL` / `_API_KEY` / `_MODEL` / `_PRICE_IN_PER_MTOK` / `_PRICE_OUT_PER_MTOK` | Benchmarking-only provider                                                                  |
| `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_SINK_URL`                                                 | Where signed webhooks go, their HMAC secret, and the dev sink                               |
| `CLOCK`, `FAKE_CLOCK_START`                                                                         | `system` in production; `fake` enables the demo endpoints                                   |
| `DEMO_API_KEY`, `DEMO_INBOX_API_KEY`, `DEMO_CLINIC`                                                 | Synthetic demo clinic keys and whether it may run on a real clock                           |
| `PORT`, `EMBEDDED_WORKER`, `CORS_ORIGINS`                                                           | API process, single-container mode, allowed browser origins                                 |
| `WORKER_POLL_MS`, `OUTBOX_POLL_MS`, `SWEEP_INTERVAL_MS`                                             | Worker loop intervals                                                                       |
| `LOG_LEVEL`                                                                                         | Logging verbosity                                                                           |
| `INBOX_DIST_DIR`, `DEMO_ACCESS_CODE`, `DEFAULT_UI_LOCALE`, `DEMO_LLM_MONTHLY_BUDGET_USD`            | Hosted-demo-only: serving the built inbox, the access code gate, default locale, LLM budget |

## Repository layout

```
apps/
  api/        HTTP API: FHIR in and out, clinic inbox JSON API, demo controls
  worker/     background process: jobs, deadline sweeps, escalation, outbox delivery, dev webhook sink
  inbox/      clinic inbox UI (React; talks to apps/api over HTTP, or an in-browser mock)
packages/
  runtime/    composition root: adapters from env, ingestion, worker loops, webhooks
  core/       pure domain + ports + the engine itself, zero I/O
  fhir/       FHIR R4 types, validation, mapping to and from domain events
  adapter-postgres/  Postgres adapters (vanilla Postgres and Supabase)
  adapter-memory/    in-memory adapters (tests, demos)
  llm/        llm_gateway and its providers (Meta, Baseten, OpenAI-compatible, fake)
  testkit/    contract tests every adapter must pass, synthetic fixtures
  acceptance/ tests only: contract suites on every adapter, FHIR scenarios end to end, backfill
config/
  rules/      versioned JSON rules
  protocols/  versioned JSON care protocols
docs/
  adr/        architecture decision records
  evals/      every model eval, how to reproduce it, what every miss was and why
```

## Testing and quality

`pnpm verify` — lint, typecheck, boundaries, test — is what CI runs on every push and pull request, plus an end-to-end run against Postgres and real signed webhooks, plus a gitleaks secret scan. As run for this submission, `pnpm test` reports **2,611 tests across every package** (vitest, one project per package); the Postgres and Supabase adapter suites additionally run with `DATABASE_URL` set, and are reported as skipped — not failed — without it.

## Roadmap

| Version | Theme             | Status in this repository                                                                                                         |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| V1      | Recover           | Implemented: universal rules, the doctor's plan, visit cadence, escalation, the contact loop, backfill and nightly reconciliation |
| V2      | Anticipate        | Implemented: condition protocols that anticipate guideline-driven care, all draft pending clinical sign-off                       |
| V3      | Clinical reviewer | Implemented, shadow mode: deterministic detectors plus a bounded LLM agent, code-checked, live only after sign-off                |
| V4      | Generate demand   | Not started in this repository                                                                                                    |

## License

Not yet decided. No license file is included in this submission.

## Acknowledgements

Built on Meta's Muse Spark through the Meta Model API for note extraction and clinical review.
