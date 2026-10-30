# Adjudicator of ambiguous plan items (V2, shadow first)

The extractor reads the doctor's plan out of each note and says how sure it is. Most items are clear ("Solicito HbA1c en 3 meses", confidence 0.9) and some are not: a plan written as a condition ("si persiste el dolor"), a possibility ("eventualmente"), an item the note says is already done, a timing stated somewhere else in the note. Until V2 those items were only flagged for the doctor's one-click review (HIP-141). The adjudicator is a second, narrow decision model that looks **only at those ambiguous items** and answers one question: **does the note really ask for this follow-up?**

It returns a typed decision, never free text:

| Decision      | Meaning                                                            | What changes (`active` mode)                                                 |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `open`        | The note asks for it.                                              | Nothing: it is followed up and opens its case when overdue.                  |
| `discard`     | The note does not ask for it (negated, done, declined, elsewhere). | The expectation stays suppressed (`cancelled`, `discarded_by_adjudicator`).  |
| `needs_human` | The note cannot tell, or the answer failed the engine's checks.    | Nothing is suppressed; the item goes to the doctor's review with the reason. |

Each decision carries a calibrated **probability** that the follow-up is real, **reason codes** from a fixed list, a one- or two-sentence **rationale** (English and Spanish) and the **verbatim quotes** from the note that back it. In `shadow` mode (the default wherever it is on) the decision is recorded and shown, and nothing changes. The doctor can override any decision.

Spec: Linear "5 · PRD V2 Anticipate", workstream E.

## Flow

```
 ingest (a consultation is saved)                ┌──────── packages/core (pure) ────────┐
   doctor's plan item, confidence c              │ isAdjudicationCandidate:              │
   ──▶ expectation { confidence: c }  ──────────▶│  layer doctor_plan, open or overdue,  │
                                                 │  quote present, not reviewed by a     │
                                                 │  clinician, minConfidence ≤ c < max   │
                                                 │  and the clinic's mode ≠ off          │
                                                 └──────────────┬────────────────────────┘
                     same transaction: job `adjudication.run` { expectationId }
                                                                ▼
 worker ──▶ ExpectationAdjudication.adjudicate ── read note, plan, Patient (masking terms)
                │
                │   ┌──────── packages/llm ────────┐
                ├──▶│ ExpectationAdjudicator.decide │  one llm_gateway call, task
                │   │ masked input, strict schema   │  `expectation_adjudication`,
                │   │ quotes mapped back, p shrunk  │  muse-spark-1.3 (or the scripted
                │   └───────────────────────────────┘  adjudicator on the fake provider)
                ▼
   checkDecision: quotes verbatim in the note (none: needs_human, `no_verifiable_quote`);
                  open needs p ≥ minOpenProbability, discard needs p ≤ maxDiscardProbability
                  (else needs_human, `low_probability`)
                ▼
   one transaction: adjudication record (model, prompt version, cost, tokens, latency)
                    + case event `adjudicated`, actor `adjudicator` (when the item is in a case)
                    + `active` and discard: expectation cancelled, case resolved if nothing else is pending
```

- **Only ambiguous items.** Clear items (confidence at or above `maxConfidence`) never reach it. Items below `minPlanItemConfidence` (0.5, `EngineSettings`) are dropped by the extractor before they become expectations, so with the defaults the band in practice is 0.5 to 0.75. Today the extractor gives 0.7 to an item whose timing is written elsewhere in the note (`DETACHED_TIMING_CONFIDENCE`), 0.5 to every item of the rule-based reader, and the model's own (capped at 0.9) number otherwise.
- **One decision per expectation.** A stored decision is never re-run (`ConflictError` on a second insert; the job is idempotent), so a doctor's override is never second-guessed by a later call.
- **Never blocks.** The model is called outside any transaction; a provider failure retries the job (3 attempts), and the item keeps being followed up as it is meanwhile. A clinic whose budget is spent gets no decisions, not a stuck inbox.
- **What triggers it.** A live consultation (`ingest`, and the retry of a failed extraction) queues the job in the same transaction that created the item. The initial backfill does not: a clinic switching it on over its history (and the demo seed) runs `adjudicatePending` once.

## What the model sees

`AdjudicationInput` (`packages/core/src/ports/expectation-adjudicator.ts`): a per-call pseudonym (`ITEM-…`), the item's kind and the extractor's description and quote, its confidence, the note's day, the days from the note to the due date (computed by code; the model never computes dates), the specialty, the other items of the same note, and the note itself.

No clinic, patient, case or expectation id is sent. The note and every string of the input are masked with the patient's names, document numbers, phones and emails (`patientRedactTerms`, the same `prepareNote` masking the extractor and the reviewer use), delimiter-shaped tags are neutralized, and the JSON is inert (`<` and `>` escaped). Quotes the model copies from the masked note are mapped back to the original text (`quoteFromOriginal`) before the engine checks them with `locateVerbatim`.

## Reason codes

The model picks one to four from the first eleven; the engine adds the last two.

| Code                         | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `explicit_instruction`       | The doctor plainly orders it.                                 |
| `timing_explicit`            | The timing is written next to the instruction.                |
| `timing_vague`               | The timing is vague or missing ("más adelante").              |
| `conditional_plan`           | Only if something happens ("si persiste", "según evolución"). |
| `hypothetical_mention`       | A possibility, not an order ("evaluar", "considerar").        |
| `already_done`               | The note says it is done or the result is in.                 |
| `negated`                    | The note says it is not needed.                               |
| `patient_declined`           | The patient declined it.                                      |
| `deferred_to_other_provider` | Another doctor or clinic will do it.                          |
| `contradictory_signals`      | The note is contradictory about it.                           |
| `insufficient_context`       | The note does not say enough.                                 |
| `no_verifiable_quote`        | Engine: none of the model's quotes is in the note.            |
| `low_probability`            | Engine: the probability does not back the decision.           |

## Probability and calibration

`probability` is the probability that the note really asks for the follow-up (1 = open, 0 = discard). Language models are over-confident, so the adapter pulls a provider's number toward 0.5 (`p' = 0.5 + (p − 0.5) · k`, `k = 0.85`, `PROBABILITY_SHRINK` in `packages/llm/src/adjudicator/agent.ts`); the scripted adjudicator's numbers are kept as they are. `eval:adjudicator` reports the Brier score on the gold set's open and discard items. Twenty synthetic items are not enough to fit a calibration curve: the factor is a placeholder until doctors' overrides give real outcomes (every override is a label), and is then refitted from them.

## Settings (per clinic)

`ClinicSettings.adjudicator` (stored in the clinic's `settings` JSON, no migration needed):

| Field                   | Default | Meaning                                                    |
| ----------------------- | ------- | ---------------------------------------------------------- |
| `mode`                  | `off`   | `off`, `shadow` (record only) or `active` (apply discard). |
| `minConfidence`         | 0.4     | Extraction confidence from which an item is ambiguous.     |
| `maxConfidence`         | 0.75    | Extraction confidence from which an item is clear.         |
| `minOpenProbability`    | 0.7     | `open` below it becomes `needs_human`.                     |
| `maxDiscardProbability` | 0.3     | `discard` above it becomes `needs_human`.                  |

Real clinics keep it **off** until their clinical team validated it (CLAUDE.md: nothing is enabled without clinical validation), then run it in `shadow` and compare the decisions with the doctors' reviews before `active`. The demo clinic and every evaluator lab sandbox run it in **shadow** (`DEMO_ADJUDICATOR_SETTINGS` in `packages/runtime/src/runtime.ts`).

## The doctor's override

`POST /api/inbox/adjudications/{id}/override` with `{ "decision": "open" | "discard", "note"? }`, in any mode, once per decision (409 after):

- `open` ("Keep it"): an item the adjudicator suppressed is back in play (open again; if overdue, the next watcher sweep opens its case), and the item is confirmed by the doctor (`plan_item_confirmed` in the plan item review log, which the extraction metrics count).
- `discard`: the item is rejected (`rejected_by_clinician`, `plan_item_rejected`), and a case left without pending reasons resolves.

Both record the override on the decision and, when the item belongs to an active case, a case event `adjudication_overridden` with the doctor as actor.

## Audit and cost

Every decision is stored in `adjudications` (migration `0018_adjudications.sql`: one row per expectation, `clinic_id` first, row-level security on) with the provider, model, prompt version (`adjudicator@1`), cost in USD, tokens and latency. When the item is in a case, the case trail gets an `adjudicated` event with actor `{ type: 'adjudicator', id: '<provider>:<model>' }` and the same provenance in its payload (exported to the host as a FHIR `Provenance` whose agent is the engine's adjudicator device). The gateway also logs every call in the clinic's LLM usage log under task `expectation_adjudication`, so the cost counts against the clinic's monthly budget.

## API

| Method | Path                                                   | What                                                                    |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| GET    | `/api/inbox/adjudications?caseId=`                     | The decisions on a case's reasons (decided before the case opened too). |
| GET    | `/api/inbox/adjudications?patientId=&decision=&limit=` | The clinic's decisions, newest first, filtered.                         |
| POST   | `/api/inbox/adjudications/{id}/override`               | The doctor's override.                                                  |

zod-validated and in the OpenAPI document (`Adjudication`, `AdjudicationList`, `AdjudicationOverrideRequest`, `AdjudicationOverrideResponse`). Labels and the rationale come in the request's language (`Accept-Language`, English or Spanish). Scopes: `inbox:read` and `inbox:act`.

## Inbox

Under each ambiguous plan item, in the case view and on the patient page, next to its plan item review: the decision badge, "Shadow mode" when nothing was applied, the probability, the reasons, the rationale, the quotes from the note highlighted, the model, and **Keep it** / **Discard** (discard asks for confirmation). The case timeline shows the decision and the override with the adjudicator's own actor label. English and Spanish catalogs (`apps/inbox/src/i18n`).

## Eval

`packages/testkit/fixtures/adjudicator-gold/gold.json`: 20 synthetic ambiguous items (fictional notes in Spanish) labeled with the decision a clinician would make (6 open, 7 discard, 7 needs_human). The eval runs each item through the real adapter, the gateway and the engine's checks (`checkDecision`).

```
pnpm --filter @follow-up-engine/llm eval:adjudicator                      # scripted, offline (CI runs it as a test)
META_API_KEY=... pnpm --filter @follow-up-engine/llm eval:adjudicator --provider meta
```

| Run (2026-10-30)                             | Accuracy | Open ↔ discard flips | Brier  | Unverified quotes | Cost (20 calls) | Mean latency |
| -------------------------------------------- | -------- | -------------------- | ------ | ----------------- | --------------- | ------------ |
| Scripted adjudicator (`fake`)                | 100 %    | 0                    | 0.0168 | 0                 | $0              | 0 ms         |
| Muse Spark `muse-spark-1.3`, `adjudicator@1` | 95 %     | 0                    | 0.0152 | 0                 | $0.0755         | 2.8 s        |

Reports: [`docs/evals/adjudicator/`](evals/adjudicator/). Muse Spark's one miss was `adj-019` ("control más adelante para ver evolución"), labeled `needs_human` for its vague timing and decided `open` at 0.76. The scripted adjudicator was written next to this gold set (cue words over the item's sentence), so its score shows the protocol and the engine's checks, not clinical judgment; it is what CI and the key-less demo run.

## Demo

`pnpm demo` seeds the synthetic clinic through the backfill, then the adjudicator's shadow pilot (`apps/api/src/test/seed-adjudicator.ts`, `SEED_ADJUDICATOR=false` skips it): three fictional consultations written ambiguously on purpose (a conditional control, a lipid panel "eventualmente", an HbA1c "ya se realizó") and the ambiguous items of the inbox's first patients, up to 12 decisions. While the demo seeds, a Muse Spark runtime answers with the scripted adjudicator (labeled `fake`), so seeding never spends; afterwards a new consultation from the Demo page or the lab is decided by Muse Spark.

## Where the code is

| Piece                          | File                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Domain, settings, reason codes | `packages/core/src/domain/adjudication.ts`                                             |
| Port (`DecisionProvider`)      | `packages/core/src/ports/expectation-adjudicator.ts`                                   |
| Repository port                | `packages/core/src/ports/adjudication-repository.ts`                                   |
| Service, checks, job           | `packages/core/src/engine/adjudicator/service.ts`                                      |
| Muse Spark adapter, prompt     | `packages/llm/src/adjudicator/`                                                        |
| Eval                           | `packages/llm/src/eval/adjudicator/`                                                   |
| Storage                        | `packages/adapter-{memory,postgres}/src/**/adjudication-repository.ts`, migration 0018 |
| Wiring, worker job             | `packages/runtime/src/{llm,runtime,worker}.ts`                                         |
| API                            | `apps/api/src/http/adjudication-{routes,schemas}.ts`                                   |
| Inbox                          | `apps/inbox/src/features/adjudication/adjudication-panel.tsx`                          |

## Not done yet

- Ambiguous **conditions** (a diagnosis read as probable) are not adjudicated: only doctor's plan items carry a confidence on their expectation today.
- Items between 0.4 and `minPlanItemConfidence` (0.5) are still dropped by the extractor; letting the adjudicator rescue them needs the annotator to keep them, held, when the clinic runs it.
- `needs_human` does not hold the patient's contact; the case follows its escalation policy like any other.
- The calibration factor is not fitted on real outcomes yet (see above).
