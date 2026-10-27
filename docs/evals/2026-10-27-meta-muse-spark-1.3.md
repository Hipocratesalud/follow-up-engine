# Note extraction eval: meta / muse-spark-1.3

- Date: 2026-10-27T14:22:31.110Z
- Provider: `meta`
- Model: `muse-spark-1.3`
- Prompt: `note-extraction@5`
- Notes: 22 (errors: 0)
- Wall time: 28.6 s
- Gold set: `packages/testkit/fixtures/gold-notes (22 of 101 notes: --ids gold-001,gold-026,gold-047,gold-062,gold-071,gold-101,gold-102,gold-103,gold-104,gold-105,gold-106,gold-107,gold-108,gold-109,gold-110,gold-111,gold-112,gold-113,gold-114,gold-115,gold-116,gold-117)`

## Overall

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   25 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% |  90.9% |  95.2% |   20 / 0 / 2 |
| Plan items (kind + due ±20%)             |     97.1% |  97.1% |  97.1% |   33 / 1 / 1 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

| Metric                                                                            |         Value |
| --------------------------------------------------------------------------------- | ------------: |
| hasPlan accuracy                                                                  |        100.0% |
| Discharge accuracy ("se da de alta", "d/c'd from therapy")                        |        100.0% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 83) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        0 / 83 |
| Input tokens per note                                                             |          3827 |
| Output tokens per note                                                            |           954 |
| Cost per note                                                                     |     $0.004949 |
| Total cost                                                                        |     $0.108871 |
| Latency p50                                                                       |       3313 ms |
| Latency p95                                                                       |       6217 ms |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |     6 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| gynecology        |     3 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| internal_medicine |     8 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| psychology        |     5 |        100.0% |           0.0% |         50.0% |       100.0% |      0 |

## By note language

The language each gold note is written in. The eval never tells the extractor: it detects the language (a stopword count, `language.ts`), reads the note with that language's lexicons, and the detection is scored here.

| Language | Notes | Detected right | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Discharge acc. | Errors |
| -------- | ----: | -------------: | ------------: | -------------: | ------------: | -----------: | -------------: | -----: |
| en       |    17 |         100.0% |        100.0% |          93.3% |         96.6% |       100.0% |         100.0% |      0 |
| es       |     5 |         100.0% |        100.0% |         100.0% |        100.0% |       100.0% |         100.0% |      0 |

### en

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   20 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% |  87.5% |  93.3% |   14 / 0 / 2 |
| Plan items (kind + due ±20%)             |     96.6% |  96.6% |  96.6% |   28 / 1 / 1 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

### es

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |    5 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |    5 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

## Per note

| Note     | Specialty         | Language (read as) | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------ | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       | es (es)            |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3892/1569 | $0.007326 | 6578 ms |       |
| gold-026 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3811/490 | $0.006846 | 3033 ms |       |
| gold-047 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3848/682 | $0.003642 | 3718 ms |       |
| gold-062 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3819/650 | $0.003470 | 4316 ms |       |
| gold-071 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3812/698 | $0.003665 | 2641 ms |       |
| gold-101 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3853/889 | $0.004528 | 2651 ms |       |
| gold-102 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3848/1507 | $0.007148 | 5641 ms |       |
| gold-103 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3834/776 | $0.004024 | 3387 ms |       |
| gold-104 | psychology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3802/349 | $0.002169 | 2354 ms |       |
| gold-105 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 1 / 1 |   ok    |              0 |     3800/1204 | $0.005800 | 5094 ms |       |
| gold-106 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3821/585 | $0.003196 | 2804 ms |       |
| gold-107 | gynecology        | en (en)            |           3 / 0 / 0 |            1 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |     3834/1161 | $0.005660 | 4367 ms |       |
| gold-108 | internal_medicine | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3827/884 | $0.004474 | 3420 ms |       |
| gold-109 | diabetology       | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |     3848/1870 | $0.008691 | 5817 ms |       |
| gold-110 | internal_medicine | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3793/841 | $0.004249 | 3114 ms |       |
| gold-111 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 2 |     1 / 0 / 0 |   ok    |              0 |     3826/1629 | $0.007639 | 6217 ms |       |
| gold-112 | internal_medicine | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      3830/831 | $0.004253 | 2387 ms |       |
| gold-113 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3834/814 | $0.004185 | 3351 ms |       |
| gold-114 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3815/1008 | $0.004986 | 3169 ms |       |
| gold-115 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3796/929 | $0.004627 | 3263 ms |       |
| gold-116 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3820/686 | $0.003624 | 3064 ms |       |
| gold-117 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      3833/928 | $0.004669 | 3313 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Pregnancy outcome matches on kind (vaginal, caesarean, loss); an outcome read from obstetric history ("G3P2, cesárea previa") or a planned one is a false positive. Pregnancy dating counts gestational weeks, last menstrual period and estimated delivery date as one item each, matched exactly; dating a note that reports no current pregnancy (a routine "FUM" in an annual control) is a false positive.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
