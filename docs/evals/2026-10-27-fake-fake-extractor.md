# Note extraction eval: fake / fake-extractor

- Date: 2026-10-27T15:27:18.250Z
- Provider: `fake`
- Model: `fake-extractor`
- Prompt: `note-extraction@5`
- Notes: 101 (errors: 0)
- Wall time: 0.1 s
- Gold set: `packages/testkit/fixtures/gold-notes (101 of 101 notes)`

> Fake provider in **baseline** mode: a deterministic, rule-based extractor (regexes, no model). It runs offline in CI and is the floor a Meta model has to beat. Its rules were written while looking at the gold notes, so it overstates how well regexes generalize. It reads the note the model would see (names masked, capped) and passes the same evidence checks.

## Overall

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% |  72.8% |  84.3% |  83 / 0 / 31 |
| Medications (fuzzy drug name)            |     87.0% |  75.9% |  81.1% |  60 / 9 / 19 |
| Plan items (kind + due ±20%)             |     96.8% |  97.6% |  97.2% |  121 / 4 / 3 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

| Metric                                                                            |          Value |
| --------------------------------------------------------------------------------- | -------------: |
| hasPlan accuracy                                                                  |          96.0% |
| Discharge accuracy ("se da de alta", "d/c'd from therapy")                        |          99.0% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 303) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        0 / 303 |
| Input tokens per note                                                             |           2294 |
| Output tokens per note                                                            |            122 |
| Cost per note                                                                     |      $0.000000 |
| Total cost                                                                        |      $0.000000 |
| Latency p50                                                                       |           1 ms |
| Latency p95                                                                       |          15 ms |

## Dropped or demoted by the post-checks

| Field      | Reason            | Items |
| ---------- | ----------------- | ----: |
| medication | `duplicate`       |     6 |
| planItem   | `due_before_note` |     2 |
| planItem   | `test_not_named`  |     1 |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |    24 |        100.0% |          82.5% |        100.0% |        95.8% |      0 |
| gynecology        |    26 |         63.4% |          33.3% |         96.1% |        92.3% |      0 |
| internal_medicine |    32 |         80.0% |          91.8% |         96.7% |        96.9% |      0 |
| psychology        |    19 |         80.0% |         100.0% |         91.7% |       100.0% |      0 |

## By note language

The language each gold note is written in. The eval never tells the extractor: it detects the language (a stopword count, `language.ts`), reads the note with that language's lexicons, and the detection is scored here.

| Language | Notes | Detected right | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Discharge acc. | Errors |
| -------- | ----: | -------------: | ------------: | -------------: | ------------: | -----------: | -------------: | -----: |
| en       |    17 |         100.0% |        100.0% |          82.8% |        100.0% |       100.0% |         100.0% |      0 |
| es       |    84 |          98.8% |         80.3% |          80.7% |         96.3% |        95.2% |          98.8% |      0 |

### en

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   20 / 0 / 0 |
| Medications (fuzzy drug name)            |     92.3% |  75.0% |  82.8% |   12 / 1 / 4 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |   29 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

### es

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% |  67.0% |  80.3% |  63 / 0 / 31 |
| Medications (fuzzy drug name)            |     85.7% |  76.2% |  80.7% |  48 / 8 / 15 |
| Plan items (kind + due ±20%)             |     95.8% |  96.8% |  96.3% |   92 / 4 / 3 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

## Per note

| Note     | Specialty         | Language (read as) | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------ | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       | es (es)            |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2319/264 | $0.000000 |   17 ms |       |
| gold-002 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       2300/90 | $0.000000 |   17 ms |       |
| gold-003 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2331/237 | $0.000000 |   17 ms |       |
| gold-004 | diabetology       | es (es)            |           2 / 0 / 0 |            1 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      2293/166 | $0.000000 |   17 ms |       |
| gold-005 | diabetology       | es (es)            |           3 / 0 / 0 |            1 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |      2289/112 | $0.000000 |    3 ms |       |
| gold-006 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2313/251 | $0.000000 |    2 ms |       |
| gold-007 | diabetology       | es (es)            |           2 / 0 / 0 |            1 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      2305/177 | $0.000000 |    2 ms |       |
| gold-008 | diabetology       | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2307/115 | $0.000000 |    2 ms |       |
| gold-009 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |       2277/48 | $0.000000 |    2 ms |       |
| gold-010 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2303/206 | $0.000000 |    2 ms |       |
| gold-011 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      2312/119 | $0.000000 |    2 ms |       |
| gold-012 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 1 |     1 / 0 / 0 |   ok    |              0 |      2307/128 | $0.000000 |    2 ms |       |
| gold-013 | internal_medicine | es (es)            |           0 / 0 / 1 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       2308/79 | $0.000000 |    1 ms |       |
| gold-014 | internal_medicine | es (es)            |           2 / 0 / 1 |            1 / 1 / 0 |     3 / 0 / 0 |   ok    |              0 |      2319/241 | $0.000000 |    1 ms |       |
| gold-015 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2287/66 | $0.000000 |    1 ms |       |
| gold-016 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      2304/168 | $0.000000 |    1 ms |       |
| gold-017 | internal_medicine | es (es)            |           1 / 0 / 1 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2344/152 | $0.000000 |    1 ms |       |
| gold-018 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2279/25 | $0.000000 |    1 ms |       |
| gold-019 | internal_medicine | es (es)            |           2 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2356/132 | $0.000000 |    1 ms |       |
| gold-020 | internal_medicine | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2326/227 | $0.000000 |    1 ms |       |
| gold-021 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      2307/105 | $0.000000 |    1 ms |       |
| gold-022 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 1 / 1 |     3 / 0 / 0 |   ok    |              0 |      2298/201 | $0.000000 |    1 ms |       |
| gold-023 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2325/93 | $0.000000 |    1 ms |       |
| gold-024 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2281/25 | $0.000000 |    1 ms |       |
| gold-025 | psychology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2294/67 | $0.000000 |    1 ms |       |
| gold-026 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2291/32 | $0.000000 |    1 ms |       |
| gold-027 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2304/95 | $0.000000 |    1 ms |       |
| gold-028 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2266/25 | $0.000000 |    1 ms |       |
| gold-029 | psychology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2329/118 | $0.000000 |    1 ms |       |
| gold-030 | psychology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2298/68 | $0.000000 |    1 ms |       |
| gold-031 | psychology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2295/25 | $0.000000 |    1 ms |       |
| gold-032 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2287/70 | $0.000000 |    1 ms |       |
| gold-033 | psychology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      2305/174 | $0.000000 |    5 ms |       |
| gold-034 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2306/72 | $0.000000 |    5 ms |       |
| gold-035 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 2 / 2 |     1 / 0 / 1 |   ok    |              0 |      2324/170 | $0.000000 |    5 ms |       |
| gold-036 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2310/155 | $0.000000 |    5 ms |       |
| gold-037 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2280/25 | $0.000000 |    1 ms |       |
| gold-038 | gynecology        | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2288/98 | $0.000000 |    1 ms |       |
| gold-039 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 1 |     3 / 0 / 0 |   ok    |              0 |      2299/154 | $0.000000 |    1 ms |       |
| gold-040 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/25 | $0.000000 |    1 ms |       |
| gold-041 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      2289/118 | $0.000000 |    1 ms |       |
| gold-042 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2298/176 | $0.000000 |    1 ms |       |
| gold-043 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2296/120 | $0.000000 |    1 ms |       |
| gold-044 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       2286/25 | $0.000000 |    1 ms |       |
| gold-045 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2296/57 | $0.000000 |    1 ms |       |
| gold-046 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/55 | $0.000000 |    1 ms |       |
| gold-047 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2306/102 | $0.000000 |    1 ms |       |
| gold-048 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2298/162 | $0.000000 |    1 ms |       |
| gold-049 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2301/58 | $0.000000 |    6 ms |       |
| gold-050 | gynecology        | es (es)            |           1 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2295/44 | $0.000000 |    6 ms |       |
| gold-051 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2283/180 | $0.000000 |    6 ms |       |
| gold-052 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      2320/171 | $0.000000 |    6 ms |       |
| gold-053 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2303/100 | $0.000000 |    1 ms |       |
| gold-054 | gynecology        | es (es)            |           0 / 0 / 1 |            1 / 0 / 1 |     0 / 0 / 0 |  wrong  |              0 |       2288/53 | $0.000000 |    1 ms |       |
| gold-055 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2286/59 | $0.000000 |    1 ms |       |
| gold-056 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2295/124 | $0.000000 |    1 ms |       |
| gold-057 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2288/25 | $0.000000 |    1 ms |       |
| gold-058 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2276/69 | $0.000000 |    1 ms |       |
| gold-059 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2280/111 | $0.000000 |    1 ms |       |
| gold-060 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2284/89 | $0.000000 |    1 ms |       |
| gold-061 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2278/110 | $0.000000 |    1 ms |       |
| gold-062 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |       2281/25 | $0.000000 |    1 ms |       |
| gold-063 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2284/58 | $0.000000 |    1 ms |       |
| gold-064 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2278/37 | $0.000000 |    1 ms |       |
| gold-065 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/61 | $0.000000 |    1 ms |       |
| gold-066 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2267/34 | $0.000000 |    1 ms |       |
| gold-067 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2279/103 | $0.000000 |    1 ms |       |
| gold-068 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2284/194 | $0.000000 |    1 ms |       |
| gold-069 | diabetology       | es (es)            |           2 / 0 / 0 |            1 / 0 / 1 |     4 / 0 / 0 |   ok    |              0 |      2321/264 | $0.000000 |    1 ms |       |
| gold-070 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2270/163 | $0.000000 |    1 ms |       |
| gold-071 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2271/154 | $0.000000 |    1 ms |       |
| gold-072 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2264/154 | $0.000000 |    1 ms |       |
| gold-073 | internal_medicine | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2261/68 | $0.000000 |    1 ms |       |
| gold-074 | gynecology        | es (?)             |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2261/69 | $0.000000 |    1 ms |       |
| gold-075 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2274/114 | $0.000000 |    1 ms |       |
| gold-076 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2262/131 | $0.000000 |    1 ms |       |
| gold-077 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 1 / 1 |     2 / 0 / 0 |   ok    |              0 |      2300/195 | $0.000000 |    2 ms |       |
| gold-078 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 1 / 1 |     2 / 0 / 0 |   ok    |              0 |      2299/193 | $0.000000 |    2 ms |       |
| gold-079 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2301/199 | $0.000000 |    2 ms |       |
| gold-080 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2300/149 | $0.000000 |    2 ms |       |
| gold-081 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2300/193 | $0.000000 |    1 ms |       |
| gold-082 | gynecology        | es (es)            |           0 / 0 / 2 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2309/69 | $0.000000 |    1 ms |       |
| gold-083 | gynecology        | es (es)            |           0 / 0 / 2 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2320/194 | $0.000000 |    1 ms |       |
| gold-084 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2311/178 | $0.000000 |    1 ms |       |
| gold-101 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      2298/180 | $0.000000 |   15 ms |       |
| gold-102 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2309/218 | $0.000000 |   15 ms |       |
| gold-103 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2301/83 | $0.000000 |   15 ms |       |
| gold-104 | psychology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2274/33 | $0.000000 |   15 ms |       |
| gold-105 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2273/94 | $0.000000 |    1 ms |       |
| gold-106 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2285/111 | $0.000000 |    1 ms |       |
| gold-107 | gynecology        | en (en)            |           3 / 0 / 0 |            0 / 1 / 1 |     4 / 0 / 0 |   ok    |              0 |      2295/294 | $0.000000 |    1 ms |       |
| gold-108 | internal_medicine | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2281/177 | $0.000000 |    1 ms |       |
| gold-109 | diabetology       | en (en)            |           1 / 0 / 0 |            1 / 0 / 1 |     4 / 0 / 0 |   ok    |              0 |      2305/221 | $0.000000 |    1 ms |       |
| gold-110 | internal_medicine | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2268/25 | $0.000000 |    1 ms |       |
| gold-111 | psychology        | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2296/151 | $0.000000 |    1 ms |       |
| gold-112 | internal_medicine | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2289/217 | $0.000000 |    1 ms |       |
| gold-113 | diabetology       | en (en)            |           2 / 0 / 0 |            0 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      2285/159 | $0.000000 |    1 ms |       |
| gold-114 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2281/152 | $0.000000 |    1 ms |       |
| gold-115 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2276/61 | $0.000000 |    1 ms |       |
| gold-116 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2290/84 | $0.000000 |    1 ms |       |
| gold-117 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2286/241 | $0.000000 |    1 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Pregnancy outcome matches on kind (vaginal, caesarean, loss); an outcome read from obstetric history ("G3P2, cesárea previa") or a planned one is a false positive. Pregnancy dating counts gestational weeks, last menstrual period and estimated delivery date as one item each, matched exactly; dating a note that reports no current pregnancy (a routine "FUM" in an annual control) is a false positive.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
