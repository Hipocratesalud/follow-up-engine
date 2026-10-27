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
   (clinicId, note,          │ note language: the host's (DocumentReference.language), else detected
    redactTerms, language)   │ prepareNote: mask patient names/ids (redactTerms), neutralize
                             │   delimiter-like tags, past 20,000 chars keep head + tail
                             │ prompt note-extraction@5 (metadata and note fenced as data)
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
                        postProcessExtraction (note's lexicons): verbatim and meaningful evidence, negation,
                        ICD-10 and LOINC validation, due dates computed from authoredAt,
                        confidence capped by what the note backs, discharge, pregnancy
                        dating and outcome (postProcessPregnancy), dedupe
```

- **Providers** implement core's `LlmProvider` (plus an optional abort `signal` and detailed usage:
  cached prompt tokens, reasoning tokens). They never see a `clinicId`.
- **Gateway** implements core's `LlmGateway`. Config is a typed object; reading env vars and picking
  providers is the job of the composition root (`packages/runtime`).
- **Note extractor** implements the `NoteExtractor` port (`note-extractor.ts` in core).
- **Eval harness** scores the extractor on gold notes and writes Markdown reports to `docs/evals/`.

## Exported API

| Area       | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway    | `createLlmGateway(config)`, `LlmGatewayConfig`, `TaskConfig`, `RouteTarget`, `GatewayResult`, `DEFAULT_RETRY_POLICY`, `backoffDelayMs`, `startOfUtcMonth`, `repairInstruction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Providers  | `createMetaProvider`, `createBasetenProvider`, `createOpenAiCompatibleProvider`, `createChatCompletionsProvider`, `createFakeProvider`, `fakeRequestKey`, `isContributorModel`, `META_API_BASE_URL`, `META_DEFAULT_MODEL`, `BASETEN_BASE_URL`, `BASETEN_MUSE_SPARK_OPEN_MODEL`, `STRUCTURED_OUTPUT_MODES`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pricing    | `DEFAULT_PRICING`, `priceFor`, `costOf`, `ModelPrice`, `PricingTable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Usage log  | `LlmUsageLog`, `LlmCallRecord` (structural copies of the core port), `InMemoryLlmUsageLog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Errors     | `LlmProviderError` (status, code, retryable, retryAfterMs), `LlmTimeoutError`, `LlmSchemaError` (raw output, issues, usage, repairable), `LlmUnavailableError`, `LlmConfigError`; core's `LlmBudgetExceededError` and `LlmOutputError` are thrown as is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Extraction | `createNoteExtractor`, `NOTE_EXTRACTION_PROMPT_VERSION`, `NOTE_EXTRACTION_TASK`, `buildExtractionMessages`, `sanitizeSpecialty`, `ModelExtractionSchema`, `ModelPregnancySchema`, `PREGNANCY_OUTCOME_KINDS`, `postProcessExtraction`, `postProcessPregnancy`, `MAX_ITEM_CONFIDENCE`, `prepareNote`, `MAX_NOTE_CHARS`, `REDACTION_PLACEHOLDER`, `DEFAULT_CONDITION_TERMS`, `ENGLISH_CONDITION_TERMS`, `conditionTermsFor`, `detectNoteLanguage`, `resolveNoteLanguage`, `lexiconLanguage`, `resolveDueAt`, `addInterval`, `createQuoteIndex`, `locateQuote`, `isValidLoinc`, port types (`NoteExtractor`, `NoteExtraction`, `ExtractedPregnancy`, ...) and `DetailedNoteExtraction` (with `rejected`, `warnings`, `dischargeEvidenceQuote`) |
| Snapshots  | `createSnapshotProvider` (replays recorded replies, records misses from a live provider), `snapshotKey`, `emptySnapshot`, `parseSnapshot`, `serializeSnapshot`, `mergeSnapshots`, `LlmSnapshot`, `LlmSnapshotEntry`, `SnapshotProvider`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Fixtures   | `createNoteFixtureResponder`, `chainResponders`, `ExpectedPregnancySchema`, `modelOutputFromExpected` (gold `expected`), `modelOutputFromExtraction` (scenario `llmFixture`), `heuristicExtraction` / `heuristicResponder` (rule-based baseline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Reviewer   | `createReviewAgent` (the `ClinicalReviewAgent` port: a bounded tool-calling loop on the gateway), `CLINICAL_REVIEW_TASK`, `CLINICAL_REVIEW_PROMPT_VERSION`, `ReviewerActionSchema`, `reviewerSystemPrompt`, `scriptedReviewerResponder` + `FAKE_REVIEWER_MODEL` (deterministic agent for CI and the demo), `quoteFromOriginal`, `inertJson`, `maskStrings`; the `eval:reviewer` harness                                                                                                                                                                                                                                                                                                                                                    |
| Evals      | `loadGoldNotes`, `runExtractionEval`, `compareExtraction`, `pregnancyOutcomeCounts`, `pregnancyDatingCounts`, `scores`, `renderReport`, `renderComparison`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
- **Pregnancy.** `pregnancy` in the model schema (prompt `note-extraction@4`): the current
  pregnancy's dating (`gestationalWeeks`, `gestationalDays`, `lastMenstrualPeriod`,
  `estimatedDeliveryDate` as written, `datingEvidenceQuote`) and its `outcome` (`kind`
  `vaginal_delivery` | `cesarean_delivery` | `loss`, `date` only when written, `daysAgo` only when the
  note says "hace 10 días" or "puérpera de 10 días", `evidenceQuote`), or null. The model never
  computes weeks or dates; core turns the result into LOINC Observations (11884-4, 8665-2, 11778-8)
  and a provisional O80/O82/O03 dated `outcome.date`, which ends the pregnancy protocol's episode,
  so `pregnancy.ts` is strict about false positives. An outcome survives only when its quote names
  a delivery or a loss of this pregnancy: never the obstetric formula ("G2P1"), history
  ("cesárea previa", "parto anterior", "antecedente de aborto", "2 partos", "cesárea hace 3 años",
  "parto vaginal en 2019", under "AGO:"), all `not_current`; nor a denied (`negated`), planned or
  threatened one ("cesárea programada", "amenaza de aborto", "vía del parto", "control posparto",
  `quote_unrelated`). Its kind is what the quote says ("cesárea" is a caesarean whatever the model
  said; "puérpera" alone backs a delivery, never a loss). Its date must be written in the quoted
  sentence, else its "hace N días" must be (then `date` = note day minus N, computed here); else the
  date is dropped (`timing_unsupported`) and core dates the outcome with the note. After the note,
  or more than 300 days before it, the outcome is `out_of_range`. Dating needs a note that states
  a current pregnancy ("embarazo", "gestante", "EG", "FPP", "control prenatal", a gestational age
  such as "G2P1, 20 sem"), not denied, wished or tested ("niega embarazo", "desea embarazo", "prueba
  de embarazo negativa"): a routine "FUM: 12/12/2025" in an annual control is `not_current`, and so
  is the dating of a pregnancy the same note ends. Each value must be written in the note: weeks 0
  to 45 and days 0 to 6 as a gestational age ("embarazo de 20 semanas y 3 días", "EG: 20+3", "20
  sem"; not "control en 4 semanas", "eco a las 20 semanas" or "dolor de 2 semanas"), the last
  period after "FUM"/"FUR" within 45 weeks before the note, the delivery date after "FPP" from 4
  weeks before to 45 weeks after it (dates `dd/mm/yyyy`, a missing year inferred). Each value
  that fails is dropped alone, with its reason under `field: 'pregnancy'` in `rejected`. The
  heuristic reader shares these readers (`pregnancy-signals.ts`) and keeps "FUM"/"FPP" dates out of
  the plan. The ICD-10 terms back Z33/Z34/Z35, Z39, O00/O02/O03 and O80/O82; a past delivery or
  loss read as a condition ("cesárea previa" as O82) is `not_current` too.
- **Long notes.** Past `MAX_NOTE_CHARS` (20,000 UTF-16 units, `maxNoteChars` to change) the model reads
  the first 40% and the last 60% of the budget (about 8,000 + 12,000 characters, cut at whitespace),
  with an elision marker between them, since the plan is usually at the end. The result carries the
  `note_truncated` warning in `DetailedNoteExtraction.warnings` (also `names_masked`,
  `tags_neutralized`) and `truncated: true` on the engine's `NoteExtraction`: the engine records a
  `note_truncated` quality finding (inbox "Note read in part", FHIR `DetectedIssue`
  `note-truncated`), because the middle of the note was not read. Quote matching is linear in the note length and works on UTF-16
  offsets that emoji and other astral characters cannot shift.
- **Log-safe errors.** Error messages never contain model output (a reply can quote the note): an
  invalid reply is reported as "reply is not valid JSON" or as schema paths and issue codes
  (`LlmSchemaError.summary`); refusal text is dropped. The raw reply and the full zod issues stay on
  the error object for the repair round trip only. These messages are what `llm_calls.error`,
  `jobs.error` and the logs store.

## Note language

Notes are not always Spanish: the language model of the engine (docs/adr/0007) has four independent
sources, and this package owns one of them, the language each note is written in.

- **Which language.** The host's when it says (`DocumentReference.language` or its attachment's
  `language`, `Composition.language`, travelling as `NoteExtractionInput.language`); otherwise
  `detectNoteLanguage` (`language.ts`): a count of words frequent in one of Spanish, English and
  Portuguese and rare in the other two ("el", "niega", "pcte"; "the", "denies", "f/u"; "com", "nao",
  "nega"), plus letters only one of them writes (ñ; ã, ç). At least 3 hits and 1.5 times the
  runner-up, else `undefined`. Deterministic, linear, no model. The result is `noteLanguage` on the
  extraction (and on the engine's `plan.extracted` event), BCP-47: `en-US` when the host said so,
  `en` when detected.
- **What it changes.** The model is told (`Note language:` in the fenced metadata; prompt
  `note-extraction@5`) and keeps quotes verbatim in that language. Every deterministic check reads the
  note with the lexicons of its language (`signals.ts`, `lab-tests.ts`, `condition-terms.ts`, the
  rule-based reader): English notes with English ones, any other language with the Spanish ones
  (Portuguese has no lexicon of its own yet). The Spanish patterns are the original ones, unchanged:
  on the 84 Spanish gold notes the baseline scores exactly as before, note by note.
- **English lexicons** (US-style writing): negation ("denies DM/HTN", "no history of", "negative for",
  a "no"/"not" in the same list item), hedging ("possible", "r/o", "concern for"), family history
  ("FHx: mother with T2DM", "DM2 (father)"), risk and gestational diabetes; discharge ("d/c'd from
  therapy", "discharged from PT", "no further follow-up needed", "therapy completed"; never
  "discharged from the hospital 5 days ago" nor "d/c metformin"); conditional returns ("return if
  worse", "RTC in 1 week only if symptoms persist", "PRN", "call if"; "f/u in 1 month or sooner if
  worse" stays scheduled); cancelled follow-ups ("cancel the 1-month f/u"); timing ("f/u in 3 months",
  "RTC 6 wks", "q3 months", "3-month follow-up", "next month", "annually", "before the next visit",
  "May 4, 2026", US dates `mm/dd/yyyy`; not "for 10 days", "x 4 days", "45 years old", "2 weeks
  ago"); plan wording ("f/u", "RTC", "recheck", "A1c", "BMP", "CMP", "LFTs", "UA", "CXR", "echo",
  "DEXA", "CBT", "refer"); condition terms ("T2DM", "HTN", "HLD", "CKD 3a", "GERD", "MDD, recurrent")
  and measurements ("A1c 7.4%", "Hgb 10.2"). Test names share one bilingual table (a test is the same
  test in both languages and the English shorthand never occurs in Spanish notes).
- **Outside the extractor.** The engine's short-treatment rule (`config/rules/universal.json`) also
  reads English as-needed and conditional-return phrases ("as needed", "if pain", "return if",
  "only if"), and the ATC name table (`packages/core/src/engine/terminology/atc.ts`) matches English
  INN names ("metformin", "glipizide").
- **Not yet in English.** Pregnancy dating and outcomes (`pregnancy-signals.ts`) are read in Spanish
  notes only; patient-name masking keeps its Spanish everyday-word list.

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

# One language, or a reproducible subset (the Muse Spark run below).
pnpm --filter @follow-up-engine/llm eval:extraction --provider fake --language en
pnpm --filter @follow-up-engine/llm eval:extraction --provider meta --concurrency 3 \
  --ids gold-001,gold-026,gold-047,gold-062,gold-071,gold-101,gold-102,gold-103,gold-104,gold-105,gold-106,gold-107,gold-108,gold-109,gold-110,gold-111,gold-112,gold-113,gold-114,gold-115,gold-116,gold-117

# Side-by-side table of every run in docs/evals.
pnpm --filter @follow-up-engine/llm eval:compare
pnpm format   # reports are Markdown; let Prettier align the tables before committing
```

Gold notes come from `packages/testkit/fixtures/gold-notes/` when it has notes, otherwise from the six
seed notes in `packages/llm/test/fixtures/gold-notes/`; `--gold <dir>` overrides. Each run writes
`docs/evals/<date>-<provider>-<model>.md` plus a `.json` summary (no note text) that `eval:compare` reads.

Metrics: precision, recall and F1 per field (conditions by ICD-10 category, plan items by kind and due
date within ±20%, medications by fuzzy drug name, pregnancy outcome by kind, pregnancy dating with
weeks, last period and delivery date one item each, matched exactly), `hasPlan` accuracy, discharge accuracy,
hallucinated-quote rate, items dropped by the evidence checks, results per specialty, tokens and cost
per note, latency p50/p95, and everything again per note language (with the share of notes whose
language was detected right: the eval never tells the extractor the language). Extraction errors
count as misses.

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
The older gold notes labeled "perfil lipídico y creatinina" as one lab item; the extractor returns
one item per test (each with its own code, so each is fulfilled by its own result). Their labels were
corrected to one item per test in HIP-106 (gold-003, 014, 022 and 039), see
[docs/evals/README.md](../../docs/evals/README.md#gold-label-changes).

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

HIP-137 added the pregnancy reading and gold-077 to 084, and labeled `expected.pregnancy` on
gold-035, 036 and 042: dating by FUM (077) and by "20 sem" (078), a vaginal delivery with its date
(079), a caesarean "hace 10 días" (080), a miscarriage (081), and two traps without a pregnancy
label: an annual control with a routine FUM (082, like 034) and a G3P2 with "cesárea previa" and a
FUM (083); 084 is a current pregnancy next to "cesárea previa" and "parto vaginal anterior".
Heuristic baseline, before (no pregnancy reading) and after: pregnancy outcome 0 of 4 → precision
and recall 100% (4 / 0 / 0), dating 0 of 6 values → 100% (6 / 0 / 0). On the 76 older notes
conditions F1 goes 80.0% → 80.9% (puerperium and loss terms), the rest is unchanged; on all 84
notes: conditions 80.3%, medications 80.7% (two-word drug names, "ácido fólico"), plan items 94.1%,
hasPlan 95.2%, discharge 98.8%. The oracle scores 100% on every field, pregnancy included (tested
on the shared set).

HIP-138 added 17 English gold notes, gold-101 to 117 (`"language": "en"`), written the way US
clinicians write: "f/u in 3 months", "RTC 6 wks", "denies DM/HTN", "FHx: mother with T2DM", "d/c'd from
therapy", "no further follow-up needed", "PRN", "A1c q3 months", "Labs (A1c, lipid panel, UACR)
before next visit", "RTC on 06/15/2026", "Follow-up visit on May 4, 2026", a cancelled f/u, a hospital
discharge that is not one, a conditional return with a time ("Return in 1 week only if symptoms
persist"), and a telephone note without plan. Prompt `note-extraction@5` (the note language in the
metadata). On the 101 notes ([report](../../docs/evals/2026-10-27-fake-fake-extractor.md)), the
heuristic baseline:

| Language | Notes | Detected | Conditions F1 | Medications F1 | Plan items F1 | hasPlan | Discharge |
| -------- | ----: | -------: | ------------: | -------------: | ------------: | ------: | --------: |
| es       |    84 |    98.8% |         80.3% |          80.7% |         94.1% |   95.2% |     98.8% |
| en       |    17 |   100.0% |        100.0% |          82.8% |        100.0% |  100.0% |    100.0% |

Spanish is unchanged, note by note, from before HIP-138 (the one undetected Spanish note, gold-074,
is read with the Spanish lexicons anyway). The English rules were written while looking at the
English notes, so the English column overstates how well they generalize. The oracle scores 100% in
both languages.

First real Muse Spark run (`muse-spark-1.3`, reasoning `low`, 2026-10-27,
[report](../../docs/evals/2026-10-27-meta-muse-spark-1.3.md)), on the 17 English notes plus five
Spanish ones (gold-001, 026, 047, 062, 071): conditions F1 100% (25/0/0), medications 95.2%, plan items
97.1%, hasPlan and discharge 100%, no hallucinated quote, language detected right on all 22; English
alone: medications 93.3%, plan items 96.6%, the rest 100%. About 3,850 input and 350 to 1,600 output
tokens per note (reasoning included), $0.0049 per note, $0.11 for the run, p50 3.3 s, p95 6.2 s.

Every Muse Spark number in `docs/evals` can be reproduced offline: the eval CLIs take
`--snapshot <file>` (replay the replies recorded in it, record the rest live into it) and
`--offline` (never call the model). The committed recordings are in
`packages/testkit/fixtures/llm-snapshots/`; a post-processing change is re-scored on the same
model replies for free. [docs/evals/README.md](../../docs/evals/README.md) lists the command
behind every number.

```sh
pnpm --filter @follow-up-engine/llm eval:extraction --provider meta --offline \
  --snapshot ../../packages/testkit/fixtures/llm-snapshots/gold-notes.meta.json --no-report
```

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

On the Meta Model API and Baseten, a step uses **native tool calling** (`tools`; `tool_choice: "auto"` on Meta, which rejects `"required"` with a 400, `"required"` elsewhere). `toolCalling: 'structured'` sends the same action as strict structured output instead, for endpoints without tools. The fake provider runs `scriptedReviewerResponder`: a deterministic agent that speaks the same protocol (it checks each detector signal with the tools and submits the confirmed ones), so CI and the demo run the real loop.

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

## What was verified about the vendors (2026-10-26, live runs 2026-10-27)

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
- Live with the hackathon key (2026-10-27, billing enabled; until 2026-10-26 every inference call
  was HTTP 402 `billing_not_configured`, which the adapter still maps to a non-retryable
  `LlmProviderError`):
  - strict `json_schema` with `ModelExtractionSchema` is accepted: 84 of 84 gold notes parsed, no
    repair round trip, no truncation (largest reply 2,028 completion tokens of the 8,000 allowed);
  - `prompt_cache_key` works: 94% of the extraction prompt tokens come back as
    `cached_tokens` (3,442 of 3,676 per note);
  - `completion_tokens` includes the reasoning tokens (`reasoning_tokens` 767 of 976 per note at
    `reasoning_effort: 'low'`), as assumed in the pricing;
  - native tool calling works, but **`tool_choice` accepts only `"auto"`**: `"required"`, `"none"`
    and named choices are HTTP 400 ("only `auto` is supported for `tool_choice`"). The Meta
    provider sends `auto`; a text reply without a call is repaired by the gateway;
  - Muse Spark sometimes writes a nullable tool argument as the string `"null"`; the reviewer
    agent reads it as `null` when that makes the arguments valid.
  - Latency at `reasoning_effort: 'low'`: extraction p50 3.2 s, p95 6.6 s; reviewer steps p50
    2.4 s, p95 5.1 s.

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

## Still to validate

- Baseten (no key yet): the exact slug (`GET https://inference.baseten.co/v1/models`), that a
  forced `tool_choice` works for Muse Spark Open, and whether its usage includes reasoning tokens.
  Then `eval:extraction --provider baseten` and `eval:reviewer --provider baseten`.
