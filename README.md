# Follow-up Engine

**Finds the patients who silently fell out of care, and shows the clinician why, in the doctor's own words.**

The Follow-up Engine reads every order, result, prescription and note an EHR already saves (HL7 FHIR R4), uses **Meta's Muse Spark** to read the doctor's plan from the free text, and puts one card per patient in front of the clinic team when something the patient needed never happened. Every reason links to the evidence that produced it.

Submission to the **Meta AI Developer Hackathon 2026**.

[Live demo](https://follow-up-engine-demo-production.up.railway.app) · [How it works](#how-it-works) · [Meta AI](#meta-ai-usage) · [Clinical validation](#clinical-validation-with-physicians) · [Architecture](#architecture) · [Run it locally](#run-it-locally)

![Follow-up inbox: a patient card is open on a doctor's-plan reason. The verbatim quote "control en 6 meses" is highlighted in the source note, Muse Spark's reading waits for the clinician to confirm, correct or reject it, and "Why?" shows how the due date was computed.](docs/images/inbox-why-evidence.png)

## Why it matters

- **Physicians agreed with what Muse Spark read.** In a review session on 2026-10-27, practicing physicians checked the hosted demo against 148 synthetic patients' documents: **21 plan items confirmed, 0 corrected, 0 rejected**; **28 cases resolved**; **6 cases rated useful, 0 not useful**. [Details](#clinical-validation-with-physicians)
- **The doctor's plan is read accurately and never invented.** On 101 gold notes, Muse Spark reaches **99.2% plan-item recall** and **98.1% medication F1**, with **0 of 348 quotes hallucinated**, at **$0.0049 per note**. [Eval](docs/evals/2026-10-27-meta-muse-spark-1.3.md)
- **The reviewer agent cites or stays silent.** On a 20-patient cohort it found **13 of 13 planted findings**, flagged **0 of 10 controls**, and stored **0 of 44 hallucinated citations**, at **$0.0132 per review**. [Eval](docs/evals/reviewer/2026-10-27-meta-muse-spark-1.3.md)

## The problem

Patients fall through the cracks without anything failing. A lab order with no result, a control visit nobody booked, a chronic patient who stopped coming back: the EHR did its job, the visit was saved, the note was written. The gap is in what happens _after_, and no system is watching it.

The Follow-up Engine watches it. It is a standalone service a clinic's EHR talks to:

|           |                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **For**   | Clinics and the EHRs that serve them. The host owns the patient relationship, the message channel and the UI; the engine does the follow-up bookkeeping and the clinical reasoning behind it.                                                                                                                                                                                                      |
| **Does**  | Turns what the EHR saves into dated expectations from four layers (structured rules, the doctor's own plan, the patient's visit cadence, condition protocols). Opens one case per patient when an expectation expires unmet. Escalates, asks the host to contact the patient, and calls the host back with signed webhooks. Runs a bounded LLM reviewer in shadow mode for what nobody wrote down. |
| **Never** | Contacts a patient directly, gives patients medical advice, or shows a finding to clinicians without evidence attached.                                                                                                                                                                                                                                                                            |

Hipócrates (hipocratesalud.com) is the first host integration. The engine speaks HL7 FHIR R4, so any FHIR-capable EHR can plug in without engine changes.

## See it

|                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ![Lab page: a consultation note uploaded by the evaluator, read by muse-spark-1.3 in 3.9 seconds for $0.0084. Diagnoses, medications and four plan items are highlighted in the note, each plan item quotes its source sentence, and the expectations it created are listed with their due dates.](docs/images/lab-muse-spark-reading.png) | ![Engine tests page: the guided test "A repeated order supersedes the one before it" after its second step, with the timeline of events read by rules, the expectations diff (Superseded, New) and the Expected and Observed results side by side.](docs/images/engine-test-supersede.png) |
| **Lab.** Upload or paste any note. Muse Spark reads it once, every item quotes the sentence it came from, and the engine shows the expectations it created.                                                                                                                                                                                | **Engine tests.** 19 guided tests, each built live in the evaluator's own sandbox clinic, with an automatic Expected / Observed check.                                                                                                                                                     |
| ![Patient documents drawer: every record the clinic's system sent for one patient, newest first, filterable by results, prescriptions, visits, notes and diagnoses.](docs/images/patient-documents.png)                                                                                                                                    | ![Clinical review page in shadow mode: a high-severity finding "Creatinine rising over the last 4 results with no comment in the notes", with a suggestion for the team and quoted evidence checked word for word against the record.](docs/images/clinical-review-finding.png)            |
| **Documents.** Every record behind a reason, one click away, to check the engine against the source.                                                                                                                                                                                                                                       | **Clinical review.** Reviewer findings with quoted evidence, in shadow mode until a named clinician validates the category.                                                                                                                                                                |

![Metrics page as the synthetic clinic boots: cases opened, ended in a booking, visit attended, median time to first action, usefulness per the team, AI cost per case, and the case-to-visit funnel.](docs/images/metrics.png)

**Metrics.** What the clinic measures: from case to booking to attended visit, time to first action, dismissals by reason, what the doctors corrected, and the AI cost per case. Shown as the synthetic clinic boots, before anyone acts; the seeded notes replay recorded Muse Spark readings, so they cost $0.

## Demo walkthrough for judges

**Hosted demo:** https://follow-up-engine-demo-production.up.railway.app (access code in the submission form). It runs on a fake clock over a synthetic clinic of 148 patients. About three minutes:

1. **Sign in** with any email and the access code. Your actions are recorded under that email.
2. **Inbox.** Open the first patient card. Each card gathers every reason for one patient, sorted by priority, with its escalation step.
3. **Why?** On a "Doctor's plan" reason, open "Why this?": the due date is recomputed from the stored record, and the doctor's own words are highlighted in the source note. Confirm, correct or reject the AI reading.
4. **Lab.** Upload or paste a note of your own. Muse Spark reads it live; each plan item quotes its sentence and becomes a dated expectation. "What happens on a date?" moves your own sandbox clock forward and shows the cases that open.
5. **Engine tests.** Run any of the 19 guided tests, for example "A repeated order supersedes the one before it", and compare Expected with Observed.

The Lab and the Engine tests use a sandbox clinic per evaluator, isolated from the shared demo and from every other evaluator.

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
2. **Expectations: four layers, one precedence order.**
   - `universal`: structured data, no model involved (a lab order needs a result in 15 days).
   - `doctor_plan`: free text is read once, at save time, by **Muse Spark** behind one `llm_gateway`, turning the doctor's own words into dated plan items, each with a verbatim evidence quote.
   - `cadence`: a break in the patient's own visit pattern.
   - `protocol`: condition protocols fill only what the first three left uncovered. The doctor's plan always wins, and an item a plan already asks for is never duplicated.
3. **Fulfilment and supersession.** A matching result, visit or booking closes an expectation; a newer order of the same test supersedes it; a cancellation reopens what it closed. This runs on every event, and again in a nightly reconciliation that repairs what a lost or reordered event left inconsistent.
4. **Case.** An expectation that expires unmet opens (or joins) one case per patient and reason group, never a second card for the same patient.
5. **Escalation and the contact loop.** A named, versioned policy raises priority, asks the host to message the patient (a `CommunicationRequest` with a generic purpose only, never clinical content), and escalates to a coordinator if nobody answers. The host reports the outcome; the engine decides whether to wait, call again, or close the case.
6. **Clinician inbox, cited.** Every reason and every due date opens its evidence in one click, recomputed from the stored record ("Due Aug 19 = last HbA1c 6.5% [May 21] + 90 days"), with the doctor's words highlighted in the source note.
7. **Signed webhooks back to the host.** `case.opened`, `case.resolved`, `patient_contact.requested`, `clinical_finding.created` and more: thin bodies (ids, codes, dates), HMAC-signed, delivered at least once from a transactional outbox.

## Meta AI usage

Every model call goes through one `llm_gateway` (`packages/llm`) to **Meta's Muse Spark** via the Meta Model API, with budget caps per clinic and a swappable provider port: Baseten's Muse Spark Open, an OpenAI-compatible adapter for benchmarking, and a deterministic `fake` provider that runs the same pipeline in CI and demos with no key, no network and no cost ([ADR 0004](docs/adr/0004-llm-gateway-meta-models.md)).

| Use                     | What Muse Spark does                                                                                                                                                                                  | Model            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Note extraction         | Reads the free-text note into conditions (ICD-10), medications and the doctor's follow-up plan, each with a verbatim evidence quote. Runs once, at save time.                                         | `muse-spark-1.3` |
| Clinical reviewer agent | A bounded agent (≤ 8 steps, ≤ 6 read-only tool calls) over one patient's dossier, confirming or adding to findings code already detected. Shadow mode until a named clinician signs the category off. | `muse-spark-1.3` |

Every model call and its reply are recorded (`packages/testkit/fixtures/llm-snapshots/`), so every number below replays offline, for free, from the exact recorded response, with the same score every time. Reproduction steps: [docs/evals/README.md](docs/evals/README.md).

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

The rule-based baseline's regexes were written looking at these same gold notes, so it overstates how well it generalizes; its plan-item precision is high because the gold labeling convention matches its rules exactly. Every Muse Spark miss is catalogued note by note, with the fix applied in code, in the [eval README](docs/evals/README.md#what-each-muse-spark-miss-is).

**Clinical reviewer agent, 20-patient cohort: 10 planted findings, 10 controls** (Muse Spark, shipped prompt `clinical-review@2`, live 2026-10-30, [full report](docs/evals/reviewer/2026-10-30-meta-muse-spark-1.3.md)):

| Metric                          | Value                       |
| ------------------------------- | --------------------------- |
| Precision                       | 92.9% (13 of 14 findings)   |
| Recall                          | 100.0% (13 of 13 planted)   |
| Controls with any finding       | 1 of 10                     |
| Hallucinated citations stored   | **0** of 43                 |
| Findings in English and Spanish | 14 of 14                    |
| Steps / tool calls per review   | 2.5 / 1.5                   |
| Cost per review                 | $0.0164 (list price $0.021) |

The false positive is a control whose note already comments on a creatinine rise: Muse Spark added its own trend finding there (verbatim citations, wrong judgment). Details in the [eval README](docs/evals/README.md).

Both evals gate prompt and model changes: a regression fails the eval. The principle behind the reviewer ([ADR 0006](docs/adr/0006-clinical-reviewer-agent.md)) is **deterministic where it matters, agentic where it helps.** Code computes every trend and runs the curated checks; the model only confirms, discards or adds to what code found; every citation it returns is checked word for word against the stored record. One bad quote drops the whole finding, and it is never silently rewritten.

## Clinical safety and design principles

- **Suggestions to the clinician, never advice to the patient.** Every finding is a suggestion with cited evidence for the clinic team. A patient contact request carries a generic purpose (`schedule_follow_up`, ...) and ids only: never a diagnosis, a test name or free text.
- **Nothing is enabled without clinical validation.** Every care protocol ships `status: draft` until a clinical team signs it off, and the inbox labels every reason from a draft protocol "Draft protocol · pending clinical validation". A reviewer category reaches clinicians only with `validatedBy`, a named clinician, enforced by the API, the domain and a database `CHECK`.
- **Shadow mode is enforced, not cosmetic.** Shadow findings run through the same checks as live ones and appear only in the staff's batch review. They are never exported to FHIR, never sent as a webhook, and Supabase row-level security hides them from clinic users by default.
- **The physician confirms with one click.** A plan item the AI read is a suggestion until a clinician confirms it (`follow-up-confirmed-by`); a correction supersedes it and keeps the evidence; a rejection cancels it. The condition inference pipeline never overwrites a clinician's own verdict.
- **Configuration is versioned, not edited in place.** Every rule and protocol is a versioned JSON file, and every expectation records the version that created it. A per-clinic override is itself versioned and audited: who, when, old value, new value, why.
- **The model sees only what it needs.** Direct identifiers are masked before reaching the reviewer agent (`[REDACTADO]`), host text is escaped so a note cannot forge a prompt delimiter, and the agent's tools are read-only, scoped to one patient's record.

## Clinical validation with physicians

All patients in every validation session are **synthetic**. No real patient data has been used, stored or committed anywhere in this repository.

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

A structured evaluation continues against the clinical team guide: physicians check rule timeframes, the diabetes and hypertension protocols, the AI's extraction against the source notes, and patient message templates, with a target of 100 reviewed test-mode cases. Every evaluator now signs in with their own email, and every action they take is recorded for analysis (the Evaluators page, with CSV export).

| Validation point                                         | Status                |
| -------------------------------------------------------- | --------------------- |
| Hosted-demo review against synthetic patient documents   | Completed, 2026-10-27 |
| Rule timeframes (universal layer deadlines)              | In review             |
| Diabetes and hypertension protocols                      | In review             |
| AI extraction review against the source notes            | In review             |
| Test-mode case review (target: 100 cases)                | Started 2026-10-27    |
| Patient message templates                                | In review             |
| Per-evaluator sign-in and action logging (evaluator lab) | In progress           |

## Architecture

Hexagonal (ports and adapters), enforced by `dependency-cruiser` on every commit ([ADR 0002](docs/adr/0002-hexagonal-architecture.md)).

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

- `packages/core` imports nothing but itself and zod: no `pg`, no vendor SDK, no `node:fs|net|http`. It runs deterministically in a unit test or an in-memory demo with no infrastructure.
- Adapters never import each other. Only `packages/runtime` wires them to ports; only apps (and acceptance tests) import the runtime.
- Every adapter, Postgres and in-memory alike, passes the same contract test suite from `packages/testkit`.
- `packages/adapter-postgres` runs unchanged on vanilla Postgres 15+ and on Supabase (its own `follow_up` schema, row-level security on by default, and an optional policy set for hosts that read the engine's tables through the Supabase Data API).

### FHIR R4 mapping

The engine's own state is exposed as standard FHIR resources ([ADR 0001](docs/adr/0001-fhir-r4-data-model.md), full contract in [docs/fhir.md](docs/fhir.md)). Every resource the package emits is validated in CI against the official FHIR R4 JSON Schema.

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

## Rules as configuration

A rule declares a **trigger**, what **fulfils** it, what **supersedes** it, and an **escalation policy**; a protocol adds enrollment criteria and a schedule. Both are versioned JSON ([config/rules](config/rules), [config/protocols](config/protocols)), validated by zod schemas, never edited by a running process. A per-clinic override (deadline, on/off) is versioned and audited ([integration.md](docs/integration.md#per-clinic-rule-overrides)).

**Precedence:** the doctor's plan beats the protocol and the cadence layer; cadence needs an established pattern (2+ previous visits); one case per patient and reason group.

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

No care protocol is validated by a clinical team yet: every one opts in per clinic and every reason it produces is labeled "pending clinical validation" until a clinical team signs it off ([docs/protocols.md](docs/protocols.md)). Diabetes and hypertension are `ready_for_signoff`: a generated sign-off package lets a physician approve them in one sitting ([docs/protocols/signoff/](docs/protocols/signoff/), `pnpm protocols:signoff`); the rest are plain `draft`.

| Protocol                            | Id                       | Version | Status            | On by default |
| ----------------------------------- | ------------------------ | ------- | ----------------- | ------------- |
| Diabetes                            | `diabetes`               | 1.2.1   | ready_for_signoff | yes (legacy)  |
| Hypertension                        | `hypertension`           | 1.1.1   | ready_for_signoff | yes (legacy)  |
| Pregnancy and postpartum            | `pregnancy`              | 0.1.0   | draft             | no            |
| Depression and anxiety on treatment | `treatment_followup`     | 0.2.0   | draft             | no            |
| Hypothyroidism                      | `hypothyroidism`         | 0.1.0   | draft             | no            |
| Dyslipidemia                        | `dyslipidemia`           | 0.1.0   | draft             | no            |
| Chronic kidney disease              | `chronic_kidney_disease` | 0.1.0   | draft             | no            |

## Run it locally

Node 22, pnpm 10:

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

**Environment variables** (names only; see [.env.example](.env.example) for the annotated list and [docs/deploy.md](docs/deploy.md) for production):

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
  images/     README screenshots
```

## Testing and quality

`pnpm verify` (lint, typecheck, boundaries, test) runs in CI on every push and pull request, together with an end-to-end run against Postgres with real signed webhooks and a gitleaks secret scan. As run for this submission, `pnpm test` reports **2,611 tests across every package** (vitest, one project per package); the Postgres and Supabase adapter suites additionally run with `DATABASE_URL` set and are reported as skipped without it.

## Roadmap

| Version | Theme             | Status in this repository                                                                                                         |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| V1      | Recover           | Implemented: universal rules, the doctor's plan, visit cadence, escalation, the contact loop, backfill and nightly reconciliation |
| V2      | Anticipate        | Implemented: condition protocols that anticipate guideline-driven care, all draft pending clinical sign-off                       |
| V3      | Clinical reviewer | Implemented in shadow mode: deterministic detectors plus a bounded LLM agent, code-checked, live only after sign-off              |
| V4      | Generate demand   | Planned                                                                                                                           |

## License

No license file is included in this submission; no open-source license is granted at this time.

## Acknowledgements

Built on Meta's Muse Spark through the Meta Model API, for note extraction and clinical review.
