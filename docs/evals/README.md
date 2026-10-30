# Evals

Every number in this folder, and every Muse Spark number in the READMEs, comes from a command below. The model runs were recorded (`packages/testkit/fixtures/llm-snapshots/`), so each one can be replayed offline, without a key and for free: same replies, same scores, same cost.

| File                                                                                               | What                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [comparison.md](comparison.md)                                                                     | Muse Spark vs the rule-based baseline vs the oracle: per field, specialty, language, cost                     |
| [2026-10-27-meta-muse-spark-1.3.md](2026-10-27-meta-muse-spark-1.3.md)                             | Note extraction on Muse Spark, 101 gold notes, every note                                                     |
| [2026-10-27-fake-fake-extractor.md](2026-10-27-fake-fake-extractor.md)                             | The rule-based baseline (fake provider, no model), the floor a model has to beat                              |
| [2026-10-27-fake-oracle.md](2026-10-27-fake-oracle.md)                                             | The oracle (returns the gold answer): checks the harness and the post-checks, must be 100%                    |
| [reviewer/2026-10-30-meta-muse-spark-1.3.md](reviewer/2026-10-30-meta-muse-spark-1.3.md)           | Clinical reviewer agent on Muse Spark over the planted cohort, shipped prompt `clinical-review@2` (bilingual) |
| [reviewer/2026-10-30-fake-fake-reviewer.md](reviewer/2026-10-30-fake-fake-reviewer.md)             | The scripted reviewer (fake provider), `clinical-review@2`                                                    |
| [reviewer/2026-10-30-detectors-detectors-only.md](reviewer/2026-10-30-detectors-detectors-only.md) | The detectors alone (no agent)                                                                                |
| [reviewer/2026-10-27-meta-muse-spark-1.3.md](reviewer/2026-10-27-meta-muse-spark-1.3.md)           | Superseded: the reviewer at `clinical-review@1` (no longer shipped)                                           |

## Headline (Muse Spark `muse-spark-1.3`, reasoning `low`, prompt `note-extraction@5`, 2026-10-27)

| Field                        |  Muse Spark | Rule-based baseline | Oracle |
| ---------------------------- | ----------: | ------------------: | -----: |
| Conditions F1                |       91.2% |               84.3% |   100% |
| Medications F1               |       98.1% |               81.1% |   100% |
| Plan items F1                |       92.8% |               97.2% |   100% |
| Plan items recall            |       99.2% |               97.6% |   100% |
| Pregnancy outcome and dating |        100% |                100% |   100% |
| hasPlan / discharge accuracy |  98% / 100% |           96% / 99% |   100% |
| Hallucinated quotes          |    0 of 348 |            0 of 303 |      0 |
| Cost per note                |     $0.0049 |                  $0 |     $0 |
| Latency p50 / p95            | 3.4 / 6.8 s |                  ~0 |     ~0 |

The baseline's rules were written while looking at these gold notes, so it overstates how well regexes generalize; its plan precision is high because the gold convention for plan items (below) is the one its rules encode. Muse Spark's plan recall is 99.2% (123 of 124): every one of its 18 plan false positives is a test the note orders without its own timing, which the gold notes do not label and the extraction contract tracks (see "Plan items").

Clinical reviewer on Muse Spark over the 20-patient cohort (10 planted, 10 controls), with the shipped prompt `clinical-review@2` (every finding in English and Spanish), live on 2026-10-30: native tool calling on the Meta Model API, **precision 92.9% (13 of 14), recall 100% (13 of 13)**, 1 control of 10 with a finding, **0 hallucinated citations stored of 43** (0 dropped by the engine either), 14 of 14 stored findings with both languages and 0 submissions refused for a missing translation, 2.5 steps and 1.5 tool calls per review, $0.0164 per review at the gateway's price ($0.021 at list price; the 50 live calls cost $0.33, $0.42 at list price).

The one false positive is control `rev-0017` ("creatinine rising but commented by the doctor, metformin adjusted"): Muse Spark added a `lab_trend` finding of its own ("Creatinina en aumento progresivo con último valor fuera de rango"), with verbatim citations, that the doctor's note already addresses. It is a judgment miss, not an invented citation; the coverage check only knows about open expectations and cases, not about a note that comments on a trend. The same run also showed Muse Spark writing its main fields in Spanish for an English clinic while its `texts.en` was right: since then a model's `texts` win over its main fields.

The previous run (prompt `clinical-review@1`, 2026-10-27, monolingual) scored 100% / 100% and is kept as history; it does not describe the shipped prompt. Earlier live runs before the fixes below: 85.7% / 92.3% and 92.3% / 92.3%.

## How to reproduce every number

Run from the repo root; `pnpm` is pnpm 10. `--offline` replays the committed recordings and never calls the model (no key needed); without it, a request not in the recording calls Muse Spark (`META_API_KEY` in `.env`) and is added to the recording.

```sh
# Note extraction on Muse Spark: the committed report and comparison row.
pnpm --filter @follow-up-engine/llm eval:extraction --provider meta --offline \
  --snapshot ../../packages/testkit/fixtures/llm-snapshots/gold-notes.meta.json
# Rule-based baseline and oracle (offline by nature).
pnpm --filter @follow-up-engine/llm eval:extraction --provider fake
pnpm --filter @follow-up-engine/llm eval:extraction --provider fake --fake-mode oracle
# Side-by-side tables in comparison.md, from the JSON summaries in this folder.
pnpm --filter @follow-up-engine/llm eval:compare && pnpm format

# Clinical reviewer on Muse Spark, and the scripted and detectors-only references.
pnpm --filter @follow-up-engine/llm eval:reviewer --provider meta --offline \
  --snapshot ../../packages/testkit/fixtures/llm-snapshots/reviewer-cohort.meta.json
pnpm --filter @follow-up-engine/llm eval:reviewer --provider fake
pnpm --filter @follow-up-engine/llm eval:reviewer --provider detectors

# A fresh live run (costs about $0.50 for the 101 notes, $0.27 for the 20 reviews).
pnpm --filter @follow-up-engine/llm eval:extraction --provider meta --concurrency 3 \
  --snapshot /tmp/gold-notes.meta.json
```

A replay reports the tokens and cost of the original calls; its latency is the replay's (near zero), so the latencies in the reports are those of the live runs that recorded them. Muse Spark is not deterministic: a fresh live run moves each F1 by about a point (the 84-note runs at prompt `@4` gave plan items 87.0% then 90.8% on the same notes).

The demo's recording (`demo-clinic.meta.json`) is made with `pnpm --filter @follow-up-engine/api demo:record` (see the README, "Notes are read by Muse Spark").

## What each Muse Spark miss is

Every miss of the committed run, read note by note (`--offline` replay plus the gold notes). "Label" means the gold note and the extraction contract disagree, "model" means Muse Spark did not return what the note says, "code" means the post-checks dropped something the note backs (all of those found are fixed, below).

**Conditions: 99 TP, 4 FP, 15 FN.**

| Notes                                                | Kind  | What happened                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 034, 044, 059, 082 (Z01), 058 (Z00), 082 (Z30)       | model | Encounter reasons ("control ginecológico de rutina", "chequeo anual", "DIU de cobre") are labeled as conditions; Muse Spark returns no condition for a healthy check-up. No rule or protocol uses Z00, Z01 or Z30.            |
| 035, 042, 084 (Z34)                                  | model | "Embarazo de N semanas" as a diagnosis is not returned as Z34, but its dating is (100%): the pregnancy protocol enrolls on the gestational-age Observation (LOINC 11884-4) the dating becomes, so nothing is lost downstream. |
| 046, 065 (N39), 067 (J18)                            | label | A treated infection at its control visit ("control post tto por ITU baja", "dado de alta del hospital ... tras neumonía"): the prompt asks for current or chronic conditions, the gold labels the resolved one.               |
| 013 (J03 vs J02), 016 (N39 vs N30), 025 (F51 vs G47) | model | Valid ICD-10 codes of a different category for the same words: "faringoamigdalitis" as pharyngitis, "ITU baja" as cystitis, "insomnio de conciliación" as G47 instead of the nonorganic F51. Each is one FP and one FN.       |
| 083 (N94)                                            | model | "Consulta por dismenorrea": the reason for the visit read as a diagnosis next to the stated ones.                                                                                                                             |

**Medications: 77 TP, 1 FP, 2 FN.** Both are a gold inconsistency in the English notes: gold-111 labels the drugs the patient takes ("on sertraline 100 mg daily per psychiatry", "uses hydroxyzine PRN") and Muse Spark returns none, following the prompt ("prescribed, continued or adjusted in this note"); gold-110 labels none for "Taking lisinopril as prescribed" and Muse Spark returns it. The Spanish gold-015 sides with gold-111.

**Plan items: 123 TP, 18 FP, 1 FN.**

| Notes                                       | Kind  | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 008 (2), 012 (3), 019 (7), 034 (1), 035 (5) | label | Tests ordered without their own timing next to a timed control ("Se solicita creatinina, K+ y perfil lipídico. Control en 4 meses con resultados"). The extraction contract (prompt and post-checks) gives them the control's date, at confidence 0.7 to 0.8; these five gold notes leave them out, while gold-001, 003, 042, 043, 069 and 070 label them when the note ties them to the control. Counted as the contract reads them, plan items score 141 / 0 / 1, F1 99.6%. A decision for the clinical team; the labels were not changed. |
| 073                                         | model | "Control anual." on its own line: Muse Spark returned no plan at all (twice, at `@4` and `@5`), so hasPlan is wrong too. The prompt lists intervals ("en 3 meses") but no frequency word.                                                                                                                                                                                                                                                                                                                                                    |

**hasPlan: 99 of 101.** gold-073 (above) and gold-054: a prescription plus "Volver en caso de persistir los síntomas" read as no plan (model; the prompt says a follow-up instruction counts).

**Dropped by the post-checks (9 of 348 items, none wrong):** 6 untimed referrals or therapies with no date to anchor ("Referir a nutrición.", "Valoración por ginecología", "start CBT"; `no_due_date`, by design), a duplicate condition and a duplicate plan item, and "Registro domiciliario de TA por 1 semana" (a home blood-pressure log, not a follow-up; `quote_unrelated`). 0 hallucinated quotes.

## What was fixed

In code, each with a test reproducing what Muse Spark returned (`packages/llm/src/extraction/muse-spark-phrasing.test.ts`, `packages/llm/src/reviewer/*.test.ts`, `packages/llm/src/eval/reviewer/eval.test.ts`):

- **Reviewer, Meta Model API:** `tool_choice` accepts only `"auto"` (HTTP 400 for `"required"`); every review degraded to detectors-only before the fix. Muse Spark writes a nullable tool argument as the string `"null"` (`{"docIds":"null"}`), which failed validation four times in a row on rev-0005 until the step budget ran out on the planted question; arguments are now validated once more with `"null"` read as `null`.
- **Reviewer eval:** a blood pressure panel is one Observation with a systolic and a diastolic document; the eval looked a stored citation up by its Observation only and counted a diastolic quote as hallucinated (4 on rev-0006) although the engine had verified it. It now checks every document of the cited resource.
- **Post-checks** dropped items the note backs: a test quoted by its bare abbreviation from a list ("K+", "HIV", "ECG": `quote_too_short`); a test named in the lexicon but not in the plan wording ("curva de tolerancia glucosada": `quote_unrelated`); referrals by "ref a" and specialty names; N30 quoted as "ITU baja". Also read from the quote: "Próx. sesión en 1 semana" is a session whatever the model called it, and a study due "a las 20 semanas" in a note at week 12 is due in 8 weeks, computed in code (the model never does date arithmetic).
- On the same 84 recorded replies at `@4`, these fixes and the label changes below moved plan items F1 from 87.0% to 89.4%, the rest unchanged.

### Gold label changes

Only labels that contradict the documented contract were changed (HIP-106):

| Note                    | Change                                                                                                                        | Why                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| gold-003, 014, 022, 039 | "Perfil lipídico y creatinina antes de la próxima cita" (and the like): one lab item per named test, two items instead of one | One item per test is the extraction contract since QA round 1 (each test is fulfilled by its own result); gold-069 and 083 were already labeled that way, and `packages/llm/README.md` listed these four as stale. |

The untimed tests of gold-008, 012, 019, 034 and 035 and the medications of gold-110 and 111 were left as they are (see above): they are conventions to decide, not clear errors.

## Prompt improvements proposed (for the prompt owner; prompt text not changed here)

1. **Encounter reasons as conditions.** Either say "a routine check-up, a normal pregnancy or contraception is a condition: Z00/Z01, Z34, Z30" or decide they are not and relabel; today the gold and the prompt disagree on 10 items.
2. **Frequency words.** Add "control anual" (1 year), "semestral" (6 months), "trimestral", "mensual" to the timing examples: "Control anual." alone returned no plan twice.
3. **hasPlan.** "A prescription, or a conditional return ('volver si...'), is a plan: hasPlan true" (gold-054).
4. **Current medications.** State whether drugs the patient is taking but this note does not prescribe count ("on sertraline per psychiatry", "taking lisinopril as prescribed"), and align gold-110/111/015.
5. **Tests ordered without timing.** The contract already dates them with the next control; saying so in the gold guide (or the opposite in the prompt) would remove the 18 plan disagreements.
6. **Resolved conditions at a control visit** ("control post tratamiento de ITU"): say whether to report them.
7. **ICD-10 category hints** for the frequent ambiguities: insomnia in psychology F51, pharyngotonsillitis J03, lower UTI N39 or N30.
8. Reviewer: tell the model that a pre-visit question is cheap and should be kept when its signal is confirmed by an absence (rev-0005 once dropped it), and to check the notes for a clinician's comment before flagging a trend (rev-0017, a control whose rising creatinine the doctor had addressed, was flagged in two of the three live runs).
