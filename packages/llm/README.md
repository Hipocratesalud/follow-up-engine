# @follow-up-engine/llm

The `llm_gateway`, its providers, the note extractor built on it, and the extraction eval harness.
Every LLM call in the engine goes through this package. Meta models come first: Muse Spark on the
Meta Model API, then Muse Spark Open (open weights) on Baseten as the fallback. Any other
OpenAI-compatible endpoint plugs in the same way, so models can be compared on the same eval.

## Architecture

```
 engine (core)                 this package                                  vendors
 ─────────────                 ────────────                                  ───────
 NoteExtractor.extract ──▶ createNoteExtractor
   (clinicId, note,          │ prepareNote: mask patient names/ids (redactTerms), neutralize
    redactTerms)             │   delimiter-like tags, past 20,000 chars keep head + tail
                             │ prompt note-extraction@3 (metadata and note fenced as data)
                             │ output schema: ModelExtractionSchema (zod)
                             ▼
                        createLlmGateway ── budget check (usage log, UTC month)
                             │  route per task: [primary, ...fallbacks]
                             │  per attempt: timeout + abort, retry 429/5xx/network
                             │  zod validation, one repair round trip
                             │  every call recorded: tokens, cost, latency, ok/error
                             ▼
              ┌──────────────┼───────────────────┬───────────────────┐
     createMetaProvider  createBasetenProvider  createOpenAiCompatibleProvider  createFakeProvider
     (json_schema,       (forced tool call)     (any /chat/completions)        (offline, CI)
      strict)                 │                        │
          └───────────────────┴──── createChatCompletionsProvider ────┘
                                 POST {baseUrl}/chat/completions
                                       │
                             ▼ back in the extractor
                        postProcessExtraction: verbatim and meaningful evidence, negation,
                        ICD-10 and LOINC validation, due dates computed from authoredAt,
                        confidence capped by what the note backs, discharge, dedupe
```

- **Providers** implement core's `LlmProvider` (plus an optional abort `signal` and detailed usage:
  cached prompt tokens, reasoning tokens). They never see a `clinicId`.
- **Gateway** implements core's `LlmGateway`. Config is a typed object; reading env vars and picking
  providers is the job of the composition root (`packages/runtime`).
- **Note extractor** implements the `NoteExtractor` port (`note-extractor.ts` in core).
- **Eval harness** scores the extractor on gold notes and writes Markdown reports to `docs/evals/`.

## Exported API

| Area       | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway    | `createLlmGateway(config)`, `LlmGatewayConfig`, `TaskConfig`, `RouteTarget`, `GatewayResult`, `DEFAULT_RETRY_POLICY`, `backoffDelayMs`, `startOfUtcMonth`, `repairInstruction`                                                                                                                                                                                                                                                                                                                                            |
| Providers  | `createMetaProvider`, `createBasetenProvider`, `createOpenAiCompatibleProvider`, `createChatCompletionsProvider`, `createFakeProvider`, `fakeRequestKey`, `isContributorModel`, `META_API_BASE_URL`, `META_DEFAULT_MODEL`, `BASETEN_BASE_URL`, `BASETEN_MUSE_SPARK_OPEN_MODEL`, `STRUCTURED_OUTPUT_MODES`                                                                                                                                                                                                                 |
| Pricing    | `DEFAULT_PRICING`, `priceFor`, `costOf`, `ModelPrice`, `PricingTable`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Usage log  | `LlmUsageLog`, `LlmCallRecord` (structural copies of the core port), `InMemoryLlmUsageLog`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Errors     | `LlmProviderError` (status, code, retryable, retryAfterMs), `LlmTimeoutError`, `LlmSchemaError` (raw output, issues, usage, repairable), `LlmUnavailableError`, `LlmConfigError`; core's `LlmBudgetExceededError` and `LlmOutputError` are thrown as is                                                                                                                                                                                                                                                                   |
| Extraction | `createNoteExtractor`, `NOTE_EXTRACTION_PROMPT_VERSION`, `NOTE_EXTRACTION_TASK`, `buildExtractionMessages`, `sanitizeSpecialty`, `ModelExtractionSchema`, `postProcessExtraction`, `MAX_ITEM_CONFIDENCE`, `prepareNote`, `MAX_NOTE_CHARS`, `REDACTION_PLACEHOLDER`, `DEFAULT_CONDITION_TERMS`, `resolveDueAt`, `addInterval`, `createQuoteIndex`, `locateQuote`, `isValidLoinc`, port types (`NoteExtractor`, `NoteExtraction`, ...) and `DetailedNoteExtraction` (with `rejected`, `warnings`, `dischargeEvidenceQuote`) |
| Fixtures   | `createNoteFixtureResponder`, `chainResponders`, `modelOutputFromExpected` (gold `expected`), `modelOutputFromExtraction` (scenario `llmFixture`), `heuristicExtraction` / `heuristicResponder` (rule-based baseline)                                                                                                                                                                                                                                                                                                     |
| Reviewer   | `createReviewAgent` (the `ClinicalReviewAgent` port: a bounded tool-calling loop on the gateway), `CLINICAL_REVIEW_TASK`, `CLINICAL_REVIEW_PROMPT_VERSION`, `ReviewerActionSchema`, `reviewerSystemPrompt`, `scriptedReviewerResponder` + `FAKE_REVIEWER_MODEL` (deterministic agent for CI and the demo), `quoteFromOriginal`, `inertJson`, `maskStrings`; the `eval:reviewer` harness                                                                                                                                   |
| Evals      | `loadGoldNotes`, `runExtractionEval`, `compareExtraction`, `scores`, `renderReport`, `renderComparison`                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Wiring example (in an app)

```ts
const gateway = createLlmGateway({
  providers: {
    meta: createMetaProvider({
      apiKey: env.META_API_KEY,
      promptCacheKey: NOTE_EXTRACTION_PROMPT_VERSION,
    }),
    baseten: createBasetenProvider({ apiKey: env.BASETEN_API_KEY }),
  },
  tasks: {
    [NOTE_EXTRACTION_TASK]: {
      route: [
        { provider: 'meta', model: 'muse-spark-1.3' },
        { provider: 'baseten', model: 'meta-models/muse-spark-open' },
      ],
      maxOutputTokens: 8_000,
    },
  },
  usageLog, // Postgres adapter in production
  monthlyBudgetUsd: async (clinicId) => (await clinics.get(clinicId))?.settings.llmMonthlyBudgetUsd,
  clock,
});
const extractor = createNoteExtractor({ gateway });
// packages/runtime wraps it with withPatientRedaction(extractor, clinicalRecords), which looks up
// the note's Patient resource and passes its names and identifiers as redactTerms.
```

With no key (CI, demo), route the task to `{ provider: 'fake', model: 'fake-extractor' }` with
`createFakeProvider({ respond: chainResponders(createNoteFixtureResponder(fixtures), heuristicResponder) })`.
Scenario `llmFixture` entries convert with `modelOutputFromExtraction`, so even scripted runs go through
the real gateway, validation and post-checks.

## Behavior worth knowing

- **Budget.** Checked before the first provider call: spend since the start of the current UTC month
  (from the usage log) `>=` the clinic's budget throws `LlmBudgetExceededError`. `undefined` budget means
  no cap. A routed model without a price fails at construction, so a budget can never be bypassed by an
  unpriced model.
- **Accounting.** One usage record per provider call, including retries, the repair call and failed
  attempts (a schema-invalid reply still costs tokens). `GatewayResult.costUsd` is the successful call;
  `totalCostUsd` is everything spent on the request, and the extractor reports the total.
- **Retries.** 408/409/425/429/5xx/529, network errors and timeouts; `Retry-After` honored; exponential
  backoff plus jitter, capped (Meta's guidance: start 0.5 to 1 s, double, add up to 1 s jitter, 3 to 5
  attempts). 400/401/402/403/404/413 are not retried, but do fall through to the next provider.
- **Repair.** One re-ask with the model's previous reply and the zod error. Truncated replies, refusals
  and content-filter stops are not repaired.
- **Fallback.** After a provider's retries are exhausted, the next route entry runs. With one entry the
  original error is rethrown; with several, `LlmUnavailableError` lists every failure.
- **Privacy.** Only the note text, its specialty and its date go to a model. No clinic, patient or
  document ids. The patient's names, identifiers and phone numbers (`NoteExtractionInput.redactTerms`,
  filled by `packages/runtime` from the Patient resource of the Bundle) are replaced by `[REDACTADO]`
  before the call (`masking.ts`). Matching is on tokens of the normalized note: no case, accents,
  invisible characters (soft hyphens, zero-width spaces), compatibility forms (fullwidth) or
  Cyrillic/Greek look-alikes, at word boundaries. Name parts next to each other ("Julio César
  Rangel", "Pérez-Gómez", "Alta Gracia") are masked as one span; a lone part is masked only when it
  is distinctive ("Rangel", "Gómez"). A part that is also an everyday or clinical word (months,
  weekdays, "Alta", "Dolores", "Delgado", "HTA", any condition, plan or test term) is masked alone only
  when capitalized right after a form of address ("Sra. Alta", "Paciente Julio"), so "se da de alta"
  and "control el 15 de julio" reach the model intact. Identifiers are masked as whole numbers
  however punctuated ("V-15.120.850", "15,120,850", "15120850"; a comma only before three digits, so
  "2,5 mg" is a dose); phones also in national or international format
  ("0412-555-1234" for "+58 412 555 1234" and the reverse). Loose digit groups are never masked:
  "TA 120/80" and "metformina 850 mg" stay. Identifiers with letters ("SECMARK-77") and emails are
  masked as their whole token sequence. Quotes the model copies from the masked text are mapped back
  to the original note. Contributor-mode Meta models (`*-contributor`, Meta may train on the data) are
  refused unless `allowContributorMode` is set, which only the eval CLI exposes (`--allow-contributor`).
- **Prompt injection.** The prompt frames the task as extraction, never advice. Every piece of host
  text is fenced as data: the note in `<clinical_note>`, the date and specialty in `<note_metadata>`,
  with an instruction to ignore instructions inside them. The specialty is reduced to its first line,
  letters, digits, spaces, `_` and `-`, 40 characters at most. Anything a model could read as one of
  the delimiters is replaced by `[etiqueta]`: an opening bracket (raw, fullwidth `＜` or an HTML entity
  `&lt;` / `&#60;`) followed by "clinical" or "note", through its closing bracket, in any case or
  spacing, with attributes, zero-width characters or look-alike letters inside, or without `>` at all.
- **Evidence checks.** A model (hallucinating, or obeying an injected instruction) is untrusted, so an
  item survives only when the note backs it (`post-process.ts`): its quote is in the note (normalized
  match, else `quote_not_found`), has at least 2 letters or digits (4 for medications and plan items,
  else `quote_too_short`), and says something about the item, else `quote_unrelated`: a condition quote
  contains a term linked to its ICD-10 category in `condition-terms.ts` (Spanish terms and
  abbreviations: "DM2", "diabetes", "HTA", "hipertensión"...; a category missing from the table is
  never accepted from free text, add it there with a gold note), a medication quote contains the drug
  name, a plan quote contains the item's wording ("ctrl", "HbA1c", "eco", "sesión") or its timing.
  Conditions: denied ones ("niega HTA y diabetes", "sin antecedentes de DM2", checklist answers
  "Diabetes: no", "DM: negativo", "sin DM ni HTA") are `negated`; a relative's ("madre con DM2", "AHF:
  diabetes (madre), HTA (padre)", "antecedentes familiares de HTA") is `family_history`; a risk
  ("riesgo de desarrollar diabetes"), gestational diabetes or "pre-diabetes" read as diabetes, and a
  past pregnancy read as a current one ("diabetes gestacional en embarazo previo") are `not_current`.
  When a short quote ("HTA") occurs more than once, the first occurrence about the patient backs it.
  Measurements ("Hemoglobina 10,8 g/dL", "HbA1c 7.4%") are `not_a_medication`. Conditional returns in
  any word order ("volver si fiebre", "ctrl en 1 semana solo si persisten los síntomas", "volver en 1
  mes si no mejora", "si no mejora en 1 semana, reconsultar") are `conditional`, while "control en 1
  mes o antes si empeora" stays. A follow-up the note cancels ("se suspende el control en 1 mes que
  estaba previsto", "el control queda suspendido") is `cancelled`, read within the list item the quote
  ends in, so "se suspende metformina, control en 3 meses" keeps the control.
- **What a plan item is.** Decided by its quote, not by the model's word (`lab-tests.ts`, a lexicon of
  Spanish test names and abbreviations, the English words a model writes, and LOINC codes per test).
  A lab or imaging item keeps the model's description only when it names tests the quote names
  ("Solicito HbA1c" backs "repeat HbA1c"), else it gets the label of the tests the quote names, or a
  generic one; its LOINC code is kept only when well formed (check digit) and of a test the quote
  names. A lab or imaging item whose quote has no test wording at all ("HIV-1/2 antibody", 7918-6,
  quoted as "Control en 3 meses"), or an `other` item whose quote names no referral or procedure,
  becomes a generic follow-up visit without code (`test_not_named` in `rejected`). Lab and imaging
  items are deduplicated by test, follow-up visits by day.
- **Confidence.** The model's number is self-reported: it is clamped to `MAX_ITEM_CONFIDENCE` (0.9),
  then capped by what the code checked: a suspected condition ("sospecha de", "probable", "en
  estudio") gets 0.4, below every engine threshold; a plan item whose timing is only stated elsewhere
  in the note gets 0.7; an untimed lab or imaging item that inherits the next visit gets 0.8.
- **Dates.** The model never computes dates: it returns `{ amount, unit }` or an ISO date and
  `resolveDueAt` computes `dueAt` from `authoredAt` (calendar months, clamped at month end; explicit
  dates before the note are rejected). The timing must be the one written where the item is quoted
  (its sentence): an interval ("en 3 meses", "próximo mes", "mensual"), a day ("15/04/2026", "15 de
  julio", year inferred) or a month ("en abril"). An interval that contradicts it is
  `timing_mismatch` ("HIV test in 1 day" quoting "Control en 3 meses"); an explicit date that is
  neither written there nor follows from the interval written there is `timing_unsupported`
  ("Control en 3 meses" due 2031-01-01 or tomorrow), and so is a date written nowhere in the note.
  Timing stated only elsewhere in the note is kept with a lower confidence; otherwise the item is
  untimed. Untimed lab/imaging items, and those due "antes de la próxima consulta" or "al próximo
  control", inherit the earliest follow-up visit of the same note; other untimed items are dropped.
- **Discharge.** `discharge: { evidenceQuote } | null` in the model schema. `discharged` is set only
  when the quote states a discharge ("se da de alta", "alta médica", "alta de psicoterapia", "se
  cierra el proceso terapéutico", "cierre del proceso", "fin del tratamiento", "no requiere más
  controles"); not "IRA alta", "no se da de alta", nor a past hospital discharge ("dado de alta del
  hospital hace 5 días", "alta hospitalaria", "dado de alta hace 3 días"). A discharge counts as a
  plan (`hasPlan`). The engine then anchors no visit cadence on that note.
- **Long notes.** Past `MAX_NOTE_CHARS` (20,000 UTF-16 units, `maxNoteChars` to change) the model reads
  the first 40% and the last 60% of the budget (about 8,000 + 12,000 characters, cut at whitespace),
  with an elision marker between them, since the plan is usually at the end. The result carries the
  `note_truncated` warning in `DetailedNoteExtraction.warnings` (also `names_masked`,
  `tags_neutralized`) and `truncated: true` on the engine's `NoteExtraction`: the engine records a
  `note_truncated` quality finding (inbox "Nota leída en parte", FHIR `DetectedIssue`
  `note-truncated`), because the middle of the note was not read. Quote matching is linear in the note length and works on UTF-16
  offsets that emoji and other astral characters cannot shift.
- **Log-safe errors.** Error messages never contain model output (a reply can quote the note): an
  invalid reply is reported as "reply is not valid JSON" or as schema paths and issue codes
  (`LlmSchemaError.summary`); refusal text is dropped. The raw reply and the full zod issues stay on
  the error object for the repair round trip only. These messages are what `llm_calls.error`,
  `jobs.error` and the logs store.

## Running evals

```sh
# Offline, no key: rule-based baseline (CI-safe), or the oracle that must score 100%.
pnpm --filter @follow-up-engine/llm eval:extraction --provider fake
pnpm --filter @follow-up-engine/llm eval:extraction --provider fake --fake-mode oracle --no-report

# Muse Spark (reads META_API_KEY, or MODEL_API_KEY, from the env or the repo's .env).
pnpm --filter @follow-up-engine/llm eval:extraction --provider meta --limit 6 --concurrency 2

# Muse Spark Open on Baseten (BASETEN_API_KEY).
pnpm --filter @follow-up-engine/llm eval:extraction --provider baseten

# Any OpenAI-compatible model, to compare.
pnpm --filter @follow-up-engine/llm eval:extraction --provider openai-compatible --name together \
  --base-url https://api.together.xyz/v1 --api-key-env TOGETHER_API_KEY \
  --model meta-models/muse-spark-open --price-in 1.25 --price-out 4.25

# Side-by-side table of every run in docs/evals.
pnpm --filter @follow-up-engine/llm eval:compare
pnpm format   # reports are Markdown; let Prettier align the tables before committing
```

Gold notes come from `packages/testkit/fixtures/gold-notes/` when it has notes, otherwise from the six
seed notes in `packages/llm/test/fixtures/gold-notes/`; `--gold <dir>` overrides. Each run writes
`docs/evals/<date>-<provider>-<model>.md` plus a `.json` summary (no note text) that `eval:compare` reads.

Metrics: precision, recall and F1 per field (conditions by ICD-10 category, plan items by kind and due
date within ±20%, medications by fuzzy drug name), `hasPlan` accuracy, discharge accuracy,
hallucinated-quote rate, items dropped by the evidence checks, results per specialty, tokens and cost
per note, latency p50/p95. Extraction errors count as misses.

The gold set includes adversarial notes from QA round 1: discharge ("se da de alta", gold-026, 045,
046), negation (047, 048), as-needed and conditional phrasing (048, 049, 054), a lab value in a note
without plan (050), emoji (051) and prompt injection with fake closing tags (052, 053). Heuristic baseline
before and after HIP-121/122 on the same 54 notes: conditions F1 72.1% → 78.9%, medications 75.3% →
80.9%, plan items 75.7% → 92.3%, hasPlan 87.0% → 92.6%, discharge 94.4% → 98.1% (the miss is the
injected "dado de alta" in gold-053, which only a model can see through).

QA round 2 added gold-055 to 070: checklist negation ("Diabetes: no", "DM: negativo", "sin DM ni
HTA"), family history (057, 058, 061), past gestational diabetes (059), risk of diabetes (060),
prediabetes (061, R73.03), conditional returns in any word order (062, 063), new discharge wording
(064 to 066), hospital discharges that are not discharges (067, 068), one lab item per named test
(068, 069, the "Diabetes con plan" demo note) and a written date with a month name (070). Heuristic
baseline on the 70 notes, before and after the round-2 fixes: conditions F1 70.9% → 78.8%,
medications 82.2% → 82.2%, plan items 88.7% → 92.2%, hasPlan 91.4% → 94.3%, discharge 92.9% → 98.6%.
The older gold notes label "perfil lipídico y creatinina" as one lab item; the extractor now returns
one item per test (each with its own code, so each is fulfilled by its own result), which shows as
four plan false positives on gold-003, 014, 022 and 039.

QA round 3 added gold-071 to 076: two intervals in one sentence ("TSH en 6 semanas, control en 3
meses" and the reverse, "HbA1c en 1 mes y control en 3 meses"), frequency words ("Control anual",
"Control semestral") and a suspended control ("Se suspende el control en 1 mes que estaba previsto;
control en 6 meses"). The heuristic reader now binds each plan item to its nearest interval (its own
list item, else the next one, else the previous one), quotes a test by its own words when the timing
belongs to the list ("perfil lipídico" and "microalbuminuria antes de la próxima consulta", never one
quote inside the other), reads frequency words except next to a dose or in a description of today's
visit ("acude a control anual", "sesión de seguimiento mensual"), and skips cancelled follow-ups. The
post-checks drop a model item whose list item cancels it (`cancelled`). Heuristic baseline on the 76
notes, before and after: plan items F1 87.3% → 93.1%; conditions 80.0%, medications 83.2%, hasPlan
94.7% and discharge 98.7% unchanged (the 70 older notes score exactly as before).

Real-network smoke test, never run by `pnpm verify`:

```sh
RUN_LLM_SMOKE=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project @follow-up-engine/llm meta.smoke
```

## Clinical reviewer agent

`createReviewAgent({ gateway })` implements core's `ClinicalReviewAgent`.

- Each step is one gateway call (task `clinical_review`, prompt `clinical-review@1`) that returns one tool call `{ thought, tool, arguments }`.
- Arguments are validated with the tool's zod schema; a malformed or unknown call gets an error back and costs a step.
- Limits: at most 8 steps, 6 read-only tool calls and 60k tokens, plus the gateway's budget and accounting on every call.
- Tools run over one patient's dossier and return document handles (`N1`, `R4`), never host ids.
- The patient's names and identifiers are masked in the input and every tool result, and host text is JSON-escaped so it cannot forge `</review_input>`.
- Quotes copied from masked text are mapped back to the original before the engine checks them verbatim.

On the Meta Model API and Baseten, a step uses **native tool calling** (`tools`, `tool_choice: "required"`). `toolCalling: 'structured'` sends the same action as strict structured output instead, for endpoints without tools. The fake provider runs `scriptedReviewerResponder`: a deterministic agent that speaks the same protocol (it checks each detector signal with the tools and submits the confirmed ones), so CI and the demo run the real loop.

```sh
pnpm --filter @follow-up-engine/llm eval:reviewer --provider fake        # scripted agent, offline
pnpm --filter @follow-up-engine/llm eval:reviewer --provider detectors   # no agent
pnpm --filter @follow-up-engine/llm eval:reviewer --provider meta        # Muse Spark (META_API_KEY)
```

The eval reviews the testkit's reviewer cohort (10 planted, 10 controls) through the whole pipeline. It reports precision and recall per category, hallucinated citations (which must be 0; the CLI fails otherwise), steps, tool calls, tokens and cost per review. Reports go to `docs/evals/reviewer/`. See [docs/reviewer.md](../../docs/reviewer.md).

## Adding a provider

1. If the vendor speaks OpenAI Chat Completions, no code is needed: use
   `createOpenAiCompatibleProvider({ name, baseUrl, apiKey, outputMode })` and pick the output mode the
   endpoint supports (`json_schema`, `tool`, `json_object` or `prompt`; zod validates in every mode).
2. Otherwise implement `StructuredLlmProvider` (`complete(request)`): honor `request.signal`, map HTTP
   failures to `LlmProviderError` with `retryable`, return detailed usage, and validate with
   `parseStructuredOutput` so invalid replies become repairable `LlmSchemaError`s. Test it with a mocked
   `fetch` like `providers/chat-completions.test.ts`.
3. Add its price to `DEFAULT_PRICING` (`<provider>:<model>`, with `source` and `verifiedAt`).
4. Route a task to it in the app and run the eval against it.

## What was verified about the vendors (2026-10-26)

Meta Model API ([quickstart](https://dev.meta.ai/docs/quickstart),
[models](https://dev.meta.ai/docs/models), [authentication](https://dev.meta.ai/docs/authentication),
[chat completions](https://dev.meta.ai/docs/protocols/chat-completions),
[schemas](https://dev.meta.ai/docs/api-reference/chat-completions/schemas),
[structured output](https://dev.meta.ai/docs/structured-output),
[errors](https://dev.meta.ai/docs/error-handling),
[pricing and limits](https://dev.meta.ai/docs/pricing-rate-limits),
[cookbook](https://github.com/meta-models/meta-model-cookbook)):

- Base URL `https://api.meta.ai/v1`, `Authorization: Bearer <key>`. OpenAI-compatible: `/responses`
  (default in the quickstart), `/chat/completions` (used here, so one client serves Meta and Baseten)
  and `/messages`.
- Structured output: `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }`;
  strict requires closed objects and every key required, no root `anyOf`, no `allOf`/`oneOf`.
  `ModelExtractionSchema` is strict-compatible (tested). `json_object` and tool calling also exist.
- Usage: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`. `max_completion_tokens` caps visible plus reasoning
  tokens. Muse Spark always reasons (`reasoning_effort: 'none'` is a 400); default here is `low`.
- Errors: `{ error: { message, type, param, code } }`; retry 429/500/503 (with `Retry-After`), not
  400/401/402/403/404/413. Rate limits 3,000 RPM / 4M TPM (contributor models 150 RPM).
- Prices (USD per 1M tokens, standard): Muse Spark 1.3/1.2 $1.25 in, $0.15 cached in, $4.25 out;
  Muse Wonder $4 / $0.20 / $20. Contributor mode $0.10 / $0.002 / $0.20, in exchange for training rights.
- Live check with the hackathon key: `GET /v1/models` returned 200 with `muse-spark-1.3`,
  `muse-spark-1.2`, `muse-spark-1.1`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`,
  `muse-wonder-1.0` and others. Every inference call (`/chat/completions` and `/responses`, standard and
  contributor models) returned **HTTP 402** `{"error":{"code":"billing_not_configured","type":"billing_error",...}}`:
  the key authenticates, but the team has no billing set up yet. The adapter maps that body to a
  non-retryable `LlmProviderError` with `code: 'billing_not_configured'` (tested with the observed body).

Baseten ([Model APIs overview](https://docs.baseten.co/development/model-apis/overview),
[Muse Spark Open](https://www.baseten.co/library/muse-spark-open/),
[tool calling](https://docs.baseten.co/inference/function-calling),
[Meta's list of hosts](https://dev.meta.ai/docs/muse-spark-open/deploy)):

- `https://inference.baseten.co/v1/chat/completions`, `Authorization: Bearer <BASETEN_API_KEY>`.
- Model slug documented as `meta-models/muse-spark-open`. The dated id `meta-models/muse-spark-open-1026`
  from the hackathon brief appears in no public page; both are priced, the documented one is the default.
- Baseten states that every Model API supports tool calling, and every one **except Muse Spark Open**
  supports structured outputs and JSON mode. Hence the Baseten provider forces a single tool call whose
  parameters are the schema, and zod validates the arguments.
- Price $1.25 in, $0.15 cached in, $4.25 out per 1M tokens. `n > 1` is rejected; `seed` and
  `temperature: 0` do not guarantee determinism.

## Still to validate with working keys

- One real Muse Spark extraction: strict `json_schema` accepted with this schema (descriptions and
  `anyOf` with `null` below the root), `cached_tokens` reported with `prompt_cache_key`, real latency
  with `reasoning_effort: 'low'` vs `minimal`, and whether 8k `max_completion_tokens` is enough.
- The exact Baseten slug (`GET https://inference.baseten.co/v1/models`), that a forced `tool_choice`
  works for Muse Spark Open, and whether its usage includes reasoning tokens.
- Whether `completion_tokens` includes reasoning tokens on both vendors (assumed, as in OpenAI's
  convention; cost would be understated otherwise).
- Then run the eval on both and on the full testkit gold set, and commit the reports.
