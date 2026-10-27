# Clinical reviewer (V3, shadow mode)

The engine's earlier layers are literal: a rule, a protocol or the doctor's own plan says "if A, expect B". The clinical reviewer looks for what nobody wrote down. A creatinine rising over three results that no note mentions. A drug that does not suit the patient's kidneys. A headache noted in three visits that nobody worked up.

It answers one question per patient: **is there anything here that deserves the doctor's attention and is not already covered by an open follow-up?** The answer is a list of **findings**. Each finding is a suggestion to the clinical team with cited evidence, never a decision, never a diagnosis, never a message to the patient.

The design rests on one rule: **deterministic where it matters, agentic where it helps.** Code computes the trends, runs the curated checks, verifies every citation word for word and decides coverage. An LLM agent, behind `llm_gateway` and limited to read-only tools over one patient's record, confirms, discards or merges what the code found and adds what it missed. Whatever the model says is checked again before anything is stored.

Spec: Linear "PRD V3 Clinical reviewer", ticket HIP-112. Decision record: [ADR 0006](adr/0006-clinical-reviewer-agent.md).

## Pipeline

```
 trigger (result / note / prescription, debounced 10 min;   ┌──────────── packages/core (pure) ────────────┐
          daily sweep of stale high-priority patients;      │                                               │
          "review now" in the demo)                         │  1 snapshot  events, conditions, open         │
            │                                               │              expectations and cases, Patient  │
            ▼                                               │  2 dossier   documents with handles (N1, R4,  │
   ClinicalReviewer.reviewPatient ─────────────────────────▶│              M2, C1), trends computed by code │
            │                                               │  3 detectors deterministic signals (S1, S2)   │
            │                                               │              with verbatim evidence           │
            │       ┌──────── packages/llm ─────────┐       │                                               │
            │       │ 4 agent loop (≤ 8 steps,      │◀──────│  ReviewInput (pseudonymous) + read-only tools │
            │       │   ≤ 6 tool calls, token cap)  │       │                                               │
            │       │   each step = 1 llm_gateway   │──────▶│  5 checks    every citation verbatim, category │
            │       │   call → 1 tool call          │       │              enabled, not patient-directed,    │
            │       └───────────────────────────────┘       │              merged; coverage by code          │
            ▼                                               └───────────────────────────────────────────────┘
   6 store: dedup (90 days), shadow or live by flag, review run (cost, tokens, steps, trace)
            live only → outbox `clinical_finding.created` → signed webhook → host reads FHIR DetectedIssue
```

1. **Snapshot** (`service.ts`). Read in one transaction: the patient's events, conditions, open expectations (including expired ones in an active case), active released cases, and the stored Patient resource for age, sex and the names to mask. The model is called outside any transaction.
2. **Dossier** (`dossier.ts`). Withdrawn records are dropped and the lookback is three years. Every citable record gets a **handle**: notes `N1…`, results `R1…`, medications `M1…`, coded diagnoses `C1…`. The model only ever sees handles, never host ids. Each document has the text a quote is checked against: the note itself, or a canonical line the engine renders from structured data (`Creatinine: 1.75 mg/dL`, `Metformina 850 mg — 1 tab VO c/12h`, `E11.9 Type 2 diabetes…`). Trends are computed here by code (`trends.ts`): least-squares slope per year, percent change, the run of consecutive worsening steps that ends at the latest value, and whether the latest value is out of range. Units are converted (µmol/L creatinine, IFCC HbA1c). Blood pressure panels (`85354-9`) are split into systolic and diastolic. A DiagnosticReport that lists its Observations is not counted twice.
3. **Detectors** (`detectors.ts`, table below) produce **signals**: candidate findings with their evidence (handles plus verbatim quotes). Only enabled categories are detected.
4. **Agent** (`packages/llm/src/reviewer/agent.ts`, [Agent loop](#agent-loop-and-tool-protocol)).
5. **Checks** (`validation.ts`, `coverage.ts`). These are where safety lives:
   - Every citation must name a document of this patient and quote it **verbatim**. Only whitespace may differ, since a model may re-flow a line break. One bad citation drops the whole finding: `unknown_document`, `quote_not_found` or `quote_too_short` (under 4 letters or digits).
   - The category must be implemented and enabled for the patient's specialty. `similar_patients` is reserved (`category_reserved`).
   - A finding addressed to the patient is dropped (`patient_directed`). The check looks for "Estimado paciente", "envíale un mensaje", "WhatsApp", "dear patient", "message the patient".
   - Findings with the same category and the same cited sources are merged.
   - **`alreadyCovered` is computed by code** from the engine's own state. An open expectation (or one expired into an active case) covers a finding when it was triggered by the cited result, asks for the same test (any LOINC code of the measurement, matched against every code that fulfills the expectation in the clinic's catalog: a creatinine trend is covered by the CKD protocol's renal function item, which an eGFR or a creatinine fulfills) or is the protocol item of the same check-up (`protocol_diabetes_fundus`). The model's opinion on coverage is never asked for and never used.
6. **Store** (`service.ts`).
   - Deduplication: no finding is stored if one with the same key (`<category>|<cited sources, sorted>`) is open, or was created or reviewed in the last 90 days.
   - The finding's mode comes from its category flag: `shadow`, or `live` only for a validated category.
   - Every review stores a **run** (`clinical_review_runs`): trigger, status, signals, findings, what was discarded and why, duplicates, steps, tool calls, tokens, cost, model, prompt version, stop reason, and the tool trace (tool names and short arguments, never note text).
   - A live finding adds `clinical_finding.created` to the outbox in the same transaction. A shadow finding adds nothing.

If the agent cannot finish, the detector signals go through the same checks and are stored with `origin: 'fallback'`. The run is then `degraded`, with stop reason `llm_budget`, `error`, `step_limit` or `token_budget`. A spent LLM budget or a provider outage never blocks the review.

## Detectors

| Category                      | Detector rule (examples)                                                                | Fires when                                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lab_trend`                   | `lab_trend:creatinine`, `:egfr`, `:hba1c`, `:ldl`, `:potassium`, `:hemoglobin`, `:uacr` | ≥ 3 results with ≥ 2 consecutive worsening steps, the change over the run at least the measurement's threshold (15 % for creatinine), and the latest out of range or twice the threshold. **Silent only**: no later note names the test (whole-word lexicon, Spanish and English). |
| `abnormal_result_no_followup` | `abnormal_result:hba1c`                                                                 | Latest value ≥ 1.25 × the upper limit or ≤ 0.75 × the lower one, at least 14 days old, with no visit after it, no appointment within 30 days and no note about it. A value already in a trend finding is not reported twice. HbA1c ≥ 9 % is `high`.                                |
| `vital_trend`                 | `vital_trend:systolic_bp`, `:weight`                                                    | Systolic: ≥ 3 readings in 18 months rising, the latest ≥ 140 or a rise ≥ 15 mmHg. Weight: ≥ 3 readings moving the same way, ≥ 5 % (≥ 10 % is `medium`).                                                                                                                            |
| `drug_interaction`            | `interaction:nsaid_raas_diuretic`, `vka_nsaid`, `ssri_tramadol`, `doac_nsaid`, …        | Active drugs (no end date, or a course not yet over) of every class in a curated rule. Drugs are classed by ATC code, or by name through the engine's ATC name table. The triple combination suppresses its own pairs.                                                             |
| `drug_condition_conflict`     | `drug_condition:metformin_egfr_30` / `_45`, `nsaid_egfr_60`, `nsaid_heart_failure`, …   | eGFR measured, or **estimated from the latest creatinine with the race-free CKD-EPI 2021 equation** when the host sends none. Or a coded diagnosis (I50, J45, M10…).                                                                                                               |
| `unaddressed_symptom`         | `symptom:headache`, `dizziness`, `chest_pain`, `fatigue`, …                             | A symptom affirmed in ≥ 3 notes of the last year, or in 2 notes from different specialties. Negated mentions ("niega cefalea", "sin disnea", "denies") do not count, nor does a sentence that orders a test or a referral.                                                         |
| `missing_screening`           | `screening:diabetic_fundus`, `diabetic_foot`, `diabetic_albuminuria`                    | A diabetic (diagnosis or A10 drug), seen in the last 18 months, with no note, order or result of the check-up in its interval.                                                                                                                                                     |
| `record_quality`              | `record_quality:allergies`, `uncoded_diagnosis`                                         | A prescription in the last 90 days while no note ever recorded the allergy status. Or a diagnosis read from a note that was never coded.                                                                                                                                           |
| `utilization_change`          | `utilization:frequent_visits`                                                           | ≥ 4 visits in 90 days and ≥ 3 × the patient's own rate over the year before.                                                                                                                                                                                                       |
| `pre_visit_question`          | `question:diabetic_neuropathy`, `statin_myalgia`, `ace_cough`                           | Only with a visit booked in the next 60 days, and when no recent note answers it (neuropathy symptoms in 180 days, tolerance in 365). At most 2 per patient.                                                                                                                       |

Every threshold and table (interactions, drug-condition rules, symptom lexicon, check-ups) lives in `packages/core/src/engine/reviewer/knowledge.ts`: curated, small and readable by a clinician. The words shown to the clinic live in `copy.ts`, per locale (`en`, `es`).

## Agent loop and tool protocol

One review is a bounded loop of `llm_gateway` calls (task `clinical_review`, prompt `clinical-review@1`). Each call returns exactly **one tool call**:

```json
{
  "thought": "Check S1 with the creatinine series.",
  "tool": "get_lab_trend",
  "arguments": "{\"test\":\"creatinine\"}"
}
```

The loop validates `arguments` against the tool's zod schema. A malformed or unknown call (invalid JSON, unknown tool, a schema violation) gets an error back as the observation and **costs a step**. Read-only tools run over the dossier of this patient only:

| Tool                  | Arguments                                          | Returns                                                                                                                    |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `get_lab_trend`       | `test` (key, name in Spanish or English, or LOINC) | Every value with handle and date, range, change, slope, consecutive worsening                                              |
| `get_notes`           | `query` (search) or `docIds` (whole notes)         | Matching sentences, or notes trimmed head and tail                                                                         |
| `get_medications`     | none                                               | Every drug with dose, start date, ATC, drug classes, whether active                                                        |
| `get_open_follow_ups` | none                                               | Open expectations and active cases (what the engine already follows)                                                       |
| `check_interaction`   | `drugA`, `drugB`                                   | The curated rule for the pair (or the triple it belongs to)                                                                |
| `submit_findings`     | `findings[]`                                       | Ends the review. Each finding: category, severity, summary, rationale, suggestion, citations `{docId, quote}`, `signalIds` |

**Limits** (`DEFAULT_REVIEW_LIMITS`):

- 8 model calls.
- 6 read-only tool calls. Past them every further call gets `tool_budget_exhausted: call submit_findings now`.
- 60,000 tokens per review, checked before each call. Every call is also accounted and capped by the clinic's monthly LLM budget in the gateway.

**What reaches the model** is the PRD's `ReviewInput` and nothing else: a per-review pseudonym (`P-<run>`), age, sex, coded conditions, medications, trends with handles, the last 6 notes trimmed head and tail, open expectations and cases, and the signals.

- Names, identifiers and phones are masked as `[REDACTADO]` in the input and in every tool result, with the same masking as note extraction.
- Every `<` and `>` from the record is JSON-escaped (`<`), so a note can never close `<review_input>` or forge a `<tool_result>`. The prompt states that text inside them is data, never instructions.
- Quotes the model copies from masked text are mapped back to the original before the verbatim check.

**Locale.** Findings are written in the clinic's locale (`localeOf`, default `en`). The detectors use `copy.ts`, and the prompt asks the model for the same language. Quotes stay verbatim in the language of the record.

### Providers

| Provider                       | How a step is sent                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta` (Muse Spark)            | **Native tool calling** over the OpenAI-compatible Chat Completions API: every tool as `tools[]` with its JSON Schema, `tool_choice: "auto"` (the only value the Meta Model API accepts: `"required"` and named choices are an HTTP 400), `parallel_tool_calls: false`. The first tool call comes back as the action object. |
| `baseten` (Muse Spark Open)    | Native tool calling (Baseten supports tool calling on every Model API).                                                                                                                                                                                                                                                                                                                               |
| endpoints without tool calling | `toolCalling: 'structured'`: the same action object as structured output (`response_format: json_schema`, strict). The prompt lists the tools with their schemas. Same validation either way.                                                                                                                                                                                                         |
| `fake` (`fake-reviewer`)       | The **scripted reviewer**: a deterministic agent speaking the real protocol through the real gateway and loop. It reads the input, calls the tools that can check each signal (follow-ups, trends, interactions, notes), drops a signal a tool contradicts, and submits the rest with the detectors' evidence. It never invents a finding. CI, the demo and the eval exercise the whole loop with it. |

A text reply without a tool call is a repairable schema error: the gateway asks once more. Tool arguments that fail their schema are validated once more with every `"null"` string read as `null` (Muse Spark writes nullable fields that way: `{"query":"fondo","docIds":"null"}`); only a retry that validates is accepted.

On Muse Spark (`muse-spark-1.3`, 2026-10-27, [eval report](evals/reviewer/2026-10-27-meta-muse-spark-1.3.md), [how to reproduce](evals/README.md)): native tool calling works, 3.0 steps and 1.9 tool calls per review, 0 hallucinated citations stored, about $0.012 per review. The demo replays the reviews recorded from it (see the README).

## Shadow mode, flags and going live

`finding_flags` holds one row per clinic, category and specialty (`specialty = ''` for every specialty). A specialty's own flag wins over the clinic-wide one.

- **Every category starts off and in shadow.** A clinic starting its pilot turns categories on in shadow (`shadowPilotFlags`). The demo clinic starts that way.
- **Shadow findings** are stored and listed only in the inbox's batch review ("Clinical review", `GET /api/inbox/findings?mode=shadow`), for the clinical staff validating the reviewer. They are never exported to `/fhir/DetectedIssue`, never sent as a webhook and never shown to doctors or patients. With Supabase, `supabase/rls.sql` exposes only live findings (`mode <> 'shadow'`) to clinic users.
- **Verdicts.** Staff mark each finding _Relevant_, _Already knew_ or _Not relevant_; "Not relevant" requires a reason. The flags page shows each category's shadow precision (relevant / reviewed), which is the evidence for going live.
- **Live.** A category goes live only with `validatedBy`, the clinician who signs it off. Without it the API answers 422, the domain throws `ValidationError` and the database rejects the row (CHECK). A live flag that somehow lacks a sign-off is still treated as shadow. Live findings emit `clinical_finding.created`, a signed webhook with ids and severity only, and appear in `/fhir/DetectedIssue`. Live `pre_visit_question` findings appear on the patient page as "To ask at the next visit".

## Triggers and cost

- **Events.** A batch that stores a new `result.received`, `note.received` or `medication.prescribed` queues `clinical_review.run` for the patient, in the ingest transaction.
  - The job runs 10 minutes later, and its dedup key is the patient. A consultation saved with its note, orders and prescriptions, or several results arriving together, gives one review. The job reads the record when it runs.
  - Nothing is queued while every category is off.
  - The backfill replay queues nothing. The initial pilot run reviews each patient once instead (the demo seed does this).
- **Daily sweep.** Every sweep of the worker looks for patients with an active released case of priority ≥ 75 (the inbox's "high") whose last review is older than 30 days, and queues at most 50 per clinic. V2's risk tier does not exist yet, so the case priority stands in for it. A stale review whose patient was reviewed meanwhile is skipped.
- **Demo.** `POST /api/demo/review/:patientId` reviews now, without the debounce.

Cost per review (scripted reviewer on the cohort): 2.5 model calls and 1.4 tool calls on average. That is about 5,900 input and 150 output tokens, about **$0.008 per review at Muse Spark list price** ($1.25 / $4.25 per 1M tokens). A real model reasons, so its output tokens will be higher. Every call is in `llm_calls`, and every review's total is in `clinical_review_runs.cost_usd`.

## API

| Endpoint                              | Scope        | What it does                                                                                                                                                                                                         |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/inbox/findings`             | `inbox:read` | `mode` (`shadow` by default, or `live`), `status` (`open`, a verdict, `expired` or `reviewed`), `category` and `severity` as comma lists, `patientId`, `limit`, `cursor`. Newest first, with `counts` over the mode. |
| `GET /api/inbox/findings/metrics`     | `inbox:read` | Last 90 days: runs, patients reviewed, findings per 100 patients, discarded, duplicates, degraded, tool calls and cost per review, precision so far.                                                                 |
| `GET /api/inbox/findings/:id`         | `inbox:read` | The finding: citations with titles (a cited note's full text, to highlight the quote), the cited measurement's whole series, coverage, and the run with its tool trace.                                              |
| `GET /api/inbox/findings/:id/fhir`    | `inbox:read` | The finding as a FHIR R4 `DetectedIssue`, shadow ones included, for the staff.                                                                                                                                       |
| `POST /api/inbox/findings/:id/review` | `inbox:act`  | `{ verdict: relevant \| already_known \| not_relevant, reason? }`. The reason is required for `not_relevant` (422). The reviewer is `X-FollowUp-User`.                                                               |
| `GET /api/inbox/finding-flags`        | `inbox:read` | Every category: on or off, mode, sign-off, shadow review stats and precision.                                                                                                                                        |
| `PUT /api/inbox/finding-flags`        | `inbox:act`  | `{ category, specialty?, enabled, mode, validatedBy? }`. Going live needs `validatedBy` (422). `similar_patients` cannot be turned on (422).                                                                         |
| `POST /api/demo/review/:patientId`    | `demo:clock` | Fake clock only: review now, return the run and the findings.                                                                                                                                                        |
| `GET /fhir/DetectedIssue?patient=`    | `fhir:write` | Quality findings plus **live** clinical findings.                                                                                                                                                                    |

**FHIR export** (`clinicalFindingToDetectedIssue`, validated against the official R4 schema in tests):

- `code`: the category, in the engine CodeSystem `clinical-finding-category`, with `text` = summary.
- `severity`: `high`, `moderate` or `low`.
- `status`: `preliminary` until reviewed, `final` when relevant or already known, `cancelled` when not relevant or expired.
- `implicated` and `evidence[0].detail[]`: references to the cited resources, each detail's `display` carrying the verbatim quote.
- `detail`: the rationale. `mitigation[0].action.text`: the suggestion (with the reviewer and date once reviewed).
- `author`: the reviewer device.
- Extensions: `clinical-finding-mode`, `clinical-finding-already-covered`, `clinical-finding-origin`, `clinical-finding-model`.

## Persistence (migration `0010_clinical_reviewer.sql`)

- `clinical_findings` (`clinic_id`, `id`): category, severity, texts, `citations` (jsonb, at least one), `already_covered`, `covered_by`, specialty, mode, status, origin, `dedup_key`, run, model, prompt version, verdict (`reviewed_by`, `reviewed_at`, `review_reason`).
- `clinical_review_runs` (`clinic_id`, `id`): trigger, status, counts, discarded by reason, steps, tool calls, trace, tokens, `cost_usd numeric(12,6)`, stop reason, error.
- `finding_flags` (`clinic_id`, `category`, `specialty`): CHECKs that live has a sign-off and that `similar_patients` stays off.

Every table has `clinic_id` in its key and RLS enabled. The ports are `ClinicalFindingRepository`, `ClinicalReviewRunRepository` and `FindingFlagRepository`, in `TransactionalStores`, with memory and Postgres adapters. Both adapters pass the testkit contract suites.

## Eval

```sh
pnpm --filter @follow-up-engine/llm eval:reviewer --provider fake        # scripted agent, offline
pnpm --filter @follow-up-engine/llm eval:reviewer --provider detectors   # no agent (baseline)
pnpm --filter @follow-up-engine/llm eval:reviewer --provider meta        # Muse Spark (META_API_KEY)
```

The eval runs the whole pipeline (FHIR mapping with `@follow-up-engine/fhir`, dossier, detectors, the agent through the gateway, the checks) over the **reviewer cohort**. The cohort is 20 synthetic patients in `packages/testkit/fixtures/reviewer-cohort`, generated by `pnpm --filter @follow-up-engine/testkit generate:reviewer`, with every bundle FHIR R4-validated.

The ten **planted** patients:

- creatinine rising on metformin, with an eGFR under 45 by CKD-EPI;
- HbA1c 9.2 % that the lab did not flag, with nothing after it;
- headache in three notes;
- NSAID + ARB + diuretic;
- diabetic without a fundus exam, with a visit booked;
- systolic pressure creeping up;
- allergies never recorded;
- warfarin + diclofenac;
- sertraline + tramadol;
- weight loss and tiredness in three notes.

Ten **controls** look alike and must produce nothing:

- a creatinine rise the doctor commented on;
- a high HbA1c acted on at the next visit;
- a single headache, later denied;
- warfarin with paracetamol only;
- an ARB and a thiazide without an NSAID;
- a note carrying a prompt injection;
- and others.

The eval reports precision and recall per category, controls with findings, **hallucinated citations** (every stored quote re-checked independently, which must be 0; the CLI fails otherwise), steps, tool calls, tokens and cost per review, and the projected Muse Spark cost.

Reports: [docs/evals/reviewer/](evals/reviewer/). On the cohort the scripted reviewer and the detectors alone both score 100 % precision and 100 % recall, with 0 hallucinated citations. The cohort was built by hand alongside the detectors, so this shows that the pipeline, the protocol and the checks work end to end, not how a model generalizes. The measure that counts is the shadow review of real findings (the flags page's precision per category). The demo's 140 synthetic patients give a first one.

## Where it lives

| Area             | Files                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain and ports | `packages/core/src/domain/clinical-finding.ts`, `ports/clinical-finding-repository.ts`, `ports/clinical-review-agent.ts`                                        |
| Engine (pure)    | `packages/core/src/engine/reviewer/` (`dossier`, `trends`, `knowledge`, `copy`, `detectors`, `tools`, `validation`, `coverage`, `pipeline`, `flags`, `service`) |
| Agent            | `packages/llm/src/reviewer/` (`agent`, `prompt`, `scripted`), native tool calling in `providers/chat-completions.ts`                                            |
| Adapters         | `packages/adapter-memory/src/repositories/clinical-finding-repositories.ts`, `packages/adapter-postgres/src/clinical-finding-repositories.ts`, migration 0010   |
| FHIR             | `packages/fhir/src/outbound/clinical-finding.ts`                                                                                                                |
| Runtime and API  | `packages/runtime` (wiring, `clinical_review.run` job, daily sweep, webhook), `apps/api/src/http/reviewer-*.ts`, `apps/api/src/inbox/reviewer-*.ts`             |
| Inbox            | `apps/inbox/src/features/reviewer/` ("Clinical review", finding detail with highlighted quotes and trend chart, agent trace, flags page)                        |
| Cohort and eval  | `packages/testkit/src/reviewer/`, `packages/llm/src/eval/reviewer/`                                                                                             |

## Not done yet

- `similar_patients`: reserved by the PRD for after V3 (cross-clinic data and validation).
- A per-doctor daily cap on live findings (PRD risk "fatigue") and expiry of open findings: the status `expired` exists, nothing sets it yet.
- Clinic locale setting: `localeOf` defaults to `en` until clinics have a locale.
- Muse Spark Open on Baseten: no key yet; the provider is ready (`--provider baseten`, `LLM_PROVIDER=baseten`).
