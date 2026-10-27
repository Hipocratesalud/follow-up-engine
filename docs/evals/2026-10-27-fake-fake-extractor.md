# Note extraction eval: fake / fake-extractor

- Date: 2026-10-27T02:58:09.146Z
- Provider: `fake`
- Model: `fake-extractor`
- Prompt: `note-extraction@1`
- Notes: 6 (errors: 0)
- Wall time: 0.0 s
- Gold set: `packages/llm/test/fixtures/gold-notes (6 of 6 notes)`

> Fake provider in **baseline** mode: a deterministic, rule-based extractor (regexes, no model). It runs offline in CI and is the floor a Meta model has to beat. Its rules were written alongside the six seed notes, so on them it overstates how well regexes generalize.

## Overall

| Field                         | Precision | Recall |     F1 | TP / FP / FN |
| ----------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)  |    100.0% |  85.7% |  92.3% |    6 / 0 / 1 |
| Medications (fuzzy drug name) |    100.0% |  87.5% |  93.3% |    7 / 0 / 1 |
| Plan items (kind + due ±20%)  |    100.0% | 100.0% | 100.0% |   10 / 0 / 0 |

| Metric                                                        |         Value |
| ------------------------------------------------------------- | ------------: |
| hasPlan accuracy                                              |        100.0% |
| Hallucinated-quote rate (items dropped by the verbatim check) | 0.0% (0 / 23) |
| Input tokens per note                                         |           970 |
| Output tokens per note                                        |           144 |
| Cost per note                                                 |     $0.000000 |
| Total cost                                                    |     $0.000000 |
| Latency p50                                                   |          7 ms |
| Latency p95                                                   |          7 ms |

## By specialty

| Specialty        | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ---------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| cardiology       |     1 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| diabetology      |     1 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| endocrinology    |     1 |        100.0% |           0.0% |        100.0% |       100.0% |      0 |
| general_practice |     1 |          0.0% |         100.0% |        100.0% |       100.0% |      0 |
| pulmonology      |     1 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| traumatology     |     1 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |

## Per note

| Note         | Specialty        | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| ------------ | ---------------- | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-llm-001 | diabetology      |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |       980/192 | $0.000000 |    7 ms |       |
| gold-llm-002 | cardiology       |           1 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |       973/180 | $0.000000 |    7 ms |       |
| gold-llm-003 | endocrinology    |           1 / 0 / 0 |            0 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |       962/125 | $0.000000 |    7 ms |       |
| gold-llm-004 | pulmonology      |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       980/135 | $0.000000 |    7 ms |       |
| gold-llm-005 | traumatology     |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |       969/212 | $0.000000 |    1 ms |       |
| gold-llm-006 | general_practice |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |        955/17 | $0.000000 |    1 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
