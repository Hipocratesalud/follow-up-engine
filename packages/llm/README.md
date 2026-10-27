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
   (clinicId, note)          │ prompt note-extraction@1 (note fenced as data)
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
                        postProcessExtraction: verbatim-quote check, ICD-10 and LOINC
                        validation, due dates computed from authoredAt, clamp, dedupe
```

- **Providers** implement core's `LlmProvider` (plus an optional abort `signal` and detailed usage:
  cached prompt tokens, reasoning tokens). They never see a `clinicId`.
- **Gateway** implements core's `LlmGateway`. Config is a typed object; reading env vars and picking
  providers is the job of the composition root (`packages/runtime`).
- **Note extractor** implements the `NoteExtractor` port (`note-extractor.ts` in core).
- **Eval harness** scores the extractor on gold notes and writes Markdown reports to `docs/evals/`.

## Exported API

| Area       | Exports                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway    | `createLlmGateway(config)`, `LlmGatewayConfig`, `TaskConfig`, `RouteTarget`, `GatewayResult`, `DEFAULT_RETRY_POLICY`, `backoffDelayMs`, `startOfUtcMonth`, `repairInstruction`                                                                                                                               |
| Providers  | `createMetaProvider`, `createBasetenProvider`, `createOpenAiCompatibleProvider`, `createChatCompletionsProvider`, `createFakeProvider`, `fakeRequestKey`, `isContributorModel`, `META_API_BASE_URL`, `META_DEFAULT_MODEL`, `BASETEN_BASE_URL`, `BASETEN_MUSE_SPARK_OPEN_MODEL`, `STRUCTURED_OUTPUT_MODES`    |
| Pricing    | `DEFAULT_PRICING`, `priceFor`, `costOf`, `ModelPrice`, `PricingTable`                                                                                                                                                                                                                                        |
| Usage log  | `LlmUsageLog`, `LlmCallRecord` (structural copies of the core port), `InMemoryLlmUsageLog`                                                                                                                                                                                                                   |
| Errors     | `LlmProviderError` (status, code, retryable, retryAfterMs), `LlmTimeoutError`, `LlmSchemaError` (raw output, issues, usage, repairable), `LlmUnavailableError`, `LlmConfigError`; core's `LlmBudgetExceededError` and `LlmOutputError` are thrown as is                                                      |
| Extraction | `createNoteExtractor`, `NOTE_EXTRACTION_PROMPT_VERSION`, `NOTE_EXTRACTION_TASK`, `buildExtractionMessages`, `ModelExtractionSchema`, `postProcessExtraction`, `resolveDueAt`, `addInterval`, `locateQuote`, `isValidLoinc`, port types (`NoteExtractor`, `NoteExtraction`, ...) and `DetailedNoteExtraction` |
| Fixtures   | `createNoteFixtureResponder`, `chainResponders`, `modelOutputFromExpected` (gold `expected`), `modelOutputFromExtraction` (scenario `llmFixture`), `heuristicExtraction` / `heuristicResponder` (rule-based baseline)                                                                                        |
| Evals      | `loadGoldNotes`, `runExtractionEval`, `compareExtraction`, `scores`, `renderReport`, `renderComparison`                                                                                                                                                                                                      |

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
  document ids. Contributor-mode Meta models (`*-contributor`, Meta may train on the data) are refused
  unless `allowContributorMode` is set, which only the eval CLI exposes (`--allow-contributor`).
- **Extraction safety.** The prompt frames the task as extraction, never advice, and fences the note in
  `<clinical_note>` with an instruction to ignore instructions inside it (a closing tag inside the note
  is defanged). The model never computes dates: it returns `{ amount, unit }` or an ISO date and
  `resolveDueAt` computes `dueAt` from `authoredAt` (calendar months, clamped at month end; explicit
  dates before the note are rejected). Items whose quote is not in the note are dropped and counted as
  hallucinated quotes. Untimed lab/imaging items inherit the earliest follow-up visit of the same note
  ("traer HbA1c al próximo control"); other untimed items are dropped. LOINC codes are kept only on lab
  items and only when the check digit is valid.

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
date within ±20%, medications by fuzzy drug name), `hasPlan` accuracy, hallucinated-quote rate, results
per specialty, tokens and cost per note, latency p50/p95. Extraction errors count as misses.

Real-network smoke test, never run by `pnpm verify`:

```sh
RUN_LLM_SMOKE=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project @follow-up-engine/llm meta.smoke
```

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
