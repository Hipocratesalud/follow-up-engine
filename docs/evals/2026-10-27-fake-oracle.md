# Note extraction eval: fake / oracle

- Date: 2026-10-27T15:27:18.949Z
- Provider: `fake`
- Model: `oracle`
- Prompt: `note-extraction@5`
- Notes: 101 (errors: 0)
- Wall time: 0.1 s
- Gold set: `packages/testkit/fixtures/gold-notes (101 of 101 notes)`

> Fake provider in **oracle** mode: it returns the gold answer, so this run checks the harness and the post-checks, not a model. Anything below 100% is a harness or post-check bug.

## Overall

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |  114 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% | 100.0% | 100.0% |   79 / 0 / 0 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |  124 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

| Metric                                                                            |          Value |
| --------------------------------------------------------------------------------- | -------------: |
| hasPlan accuracy                                                                  |         100.0% |
| Discharge accuracy ("se da de alta", "d/c'd from therapy")                        |         100.0% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 334) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        0 / 334 |
| Input tokens per note                                                             |           2294 |
| Output tokens per note                                                            |            127 |
| Cost per note                                                                     |      $0.000000 |
| Total cost                                                                        |      $0.000000 |
| Latency p50                                                                       |           0 ms |
| Latency p95                                                                       |           1 ms |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |    24 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| gynecology        |    26 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| internal_medicine |    32 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |
| psychology        |    19 |        100.0% |         100.0% |        100.0% |       100.0% |      0 |

## By note language

The language each gold note is written in. The eval never tells the extractor: it detects the language (a stopword count, `language.ts`), reads the note with that language's lexicons, and the detection is scored here.

| Language | Notes | Detected right | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Discharge acc. | Errors |
| -------- | ----: | -------------: | ------------: | -------------: | ------------: | -----------: | -------------: | -----: |
| en       |    17 |         100.0% |        100.0% |         100.0% |        100.0% |       100.0% |         100.0% |      0 |
| es       |    84 |          98.8% |        100.0% |         100.0% |        100.0% |       100.0% |         100.0% |      0 |

### en

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   20 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% | 100.0% | 100.0% |   16 / 0 / 0 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |   29 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

### es

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   94 / 0 / 0 |
| Medications (fuzzy drug name)            |    100.0% | 100.0% | 100.0% |   63 / 0 / 0 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |   95 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

## Per note

| Note     | Specialty         | Language (read as) | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------ | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       | es (es)            |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2319/211 | $0.000000 |    3 ms |       |
| gold-002 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2300/92 | $0.000000 |    3 ms |       |
| gold-003 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2331/259 | $0.000000 |    3 ms |       |
| gold-004 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2293/151 | $0.000000 |    3 ms |       |
| gold-005 | diabetology       | es (es)            |           3 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      2289/129 | $0.000000 |    1 ms |       |
| gold-006 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2313/237 | $0.000000 |    1 ms |       |
| gold-007 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2305/202 | $0.000000 |    1 ms |       |
| gold-008 | diabetology       | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2307/110 | $0.000000 |    1 ms |       |
| gold-009 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/73 | $0.000000 |    1 ms |       |
| gold-010 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2303/202 | $0.000000 |    1 ms |       |
| gold-011 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2312/127 | $0.000000 |    1 ms |       |
| gold-012 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2307/135 | $0.000000 |    1 ms |       |
| gold-013 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      2308/104 | $0.000000 |    0 ms |       |
| gold-014 | internal_medicine | es (es)            |           3 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2319/236 | $0.000000 |    0 ms |       |
| gold-015 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2287/64 | $0.000000 |    0 ms |       |
| gold-016 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2304/121 | $0.000000 |    0 ms |       |
| gold-017 | internal_medicine | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2344/175 | $0.000000 |    0 ms |       |
| gold-018 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2279/45 | $0.000000 |    0 ms |       |
| gold-019 | internal_medicine | es (es)            |           2 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2356/133 | $0.000000 |    0 ms |       |
| gold-020 | internal_medicine | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2326/199 | $0.000000 |    0 ms |       |
| gold-021 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      2307/105 | $0.000000 |    0 ms |       |
| gold-022 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2298/206 | $0.000000 |    0 ms |       |
| gold-023 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2325/91 | $0.000000 |    0 ms |       |
| gold-024 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2281/25 | $0.000000 |    0 ms |       |
| gold-025 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2294/89 | $0.000000 |    0 ms |       |
| gold-026 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2291/35 | $0.000000 |    0 ms |       |
| gold-027 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2304/94 | $0.000000 |    0 ms |       |
| gold-028 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2266/25 | $0.000000 |    0 ms |       |
| gold-029 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2329/132 | $0.000000 |    0 ms |       |
| gold-030 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2298/90 | $0.000000 |    0 ms |       |
| gold-031 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2295/47 | $0.000000 |    0 ms |       |
| gold-032 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2287/66 | $0.000000 |    0 ms |       |
| gold-033 | psychology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2305/152 | $0.000000 |    1 ms |       |
| gold-034 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2306/96 | $0.000000 |    1 ms |       |
| gold-035 | gynecology        | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2324/226 | $0.000000 |    1 ms |       |
| gold-036 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2310/156 | $0.000000 |    1 ms |       |
| gold-037 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2280/47 | $0.000000 |    0 ms |       |
| gold-038 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2288/119 | $0.000000 |    0 ms |       |
| gold-039 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2299/212 | $0.000000 |    0 ms |       |
| gold-040 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/46 | $0.000000 |    0 ms |       |
| gold-041 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2289/131 | $0.000000 |    0 ms |       |
| gold-042 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2298/171 | $0.000000 |    0 ms |       |
| gold-043 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2296/140 | $0.000000 |    0 ms |       |
| gold-044 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2286/48 | $0.000000 |    0 ms |       |
| gold-045 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2296/57 | $0.000000 |    0 ms |       |
| gold-046 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/50 | $0.000000 |    0 ms |       |
| gold-047 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2306/119 | $0.000000 |    0 ms |       |
| gold-048 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2298/134 | $0.000000 |    0 ms |       |
| gold-049 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2301/74 | $0.000000 |    0 ms |       |
| gold-050 | gynecology        | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2295/63 | $0.000000 |    0 ms |       |
| gold-051 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2283/148 | $0.000000 |    0 ms |       |
| gold-052 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2320/109 | $0.000000 |    0 ms |       |
| gold-053 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2303/89 | $0.000000 |    0 ms |       |
| gold-054 | gynecology        | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      2288/105 | $0.000000 |    0 ms |       |
| gold-055 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2286/73 | $0.000000 |    0 ms |       |
| gold-056 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2295/118 | $0.000000 |    0 ms |       |
| gold-057 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2288/45 | $0.000000 |    0 ms |       |
| gold-058 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2276/88 | $0.000000 |    0 ms |       |
| gold-059 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2280/139 | $0.000000 |    0 ms |       |
| gold-060 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2284/87 | $0.000000 |    0 ms |       |
| gold-061 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2278/108 | $0.000000 |    0 ms |       |
| gold-062 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2281/71 | $0.000000 |    0 ms |       |
| gold-063 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2284/73 | $0.000000 |    0 ms |       |
| gold-064 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2278/37 | $0.000000 |    0 ms |       |
| gold-065 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2277/56 | $0.000000 |    0 ms |       |
| gold-066 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2267/34 | $0.000000 |    0 ms |       |
| gold-067 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2279/116 | $0.000000 |    0 ms |       |
| gold-068 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2284/207 | $0.000000 |    0 ms |       |
| gold-069 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |      2321/305 | $0.000000 |    0 ms |       |
| gold-070 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2270/160 | $0.000000 |    0 ms |       |
| gold-071 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2271/149 | $0.000000 |    0 ms |       |
| gold-072 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2264/147 | $0.000000 |    0 ms |       |
| gold-073 | internal_medicine | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2261/68 | $0.000000 |    0 ms |       |
| gold-074 | gynecology        | es (?)             |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2261/69 | $0.000000 |    0 ms |       |
| gold-075 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2274/108 | $0.000000 |    0 ms |       |
| gold-076 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2262/124 | $0.000000 |    0 ms |       |
| gold-077 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2300/197 | $0.000000 |    1 ms |       |
| gold-078 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2299/199 | $0.000000 |    1 ms |       |
| gold-079 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2301/154 | $0.000000 |    1 ms |       |
| gold-080 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2300/153 | $0.000000 |    1 ms |       |
| gold-081 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2300/192 | $0.000000 |    0 ms |       |
| gold-082 | gynecology        | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2309/112 | $0.000000 |    0 ms |       |
| gold-083 | gynecology        | es (es)            |           2 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2320/220 | $0.000000 |    0 ms |       |
| gold-084 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2311/177 | $0.000000 |    0 ms |       |
| gold-101 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2298/198 | $0.000000 |    0 ms |       |
| gold-102 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2309/227 | $0.000000 |    0 ms |       |
| gold-103 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2301/79 | $0.000000 |    0 ms |       |
| gold-104 | psychology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2274/33 | $0.000000 |    0 ms |       |
| gold-105 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2273/89 | $0.000000 |    0 ms |       |
| gold-106 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       2285/70 | $0.000000 |    0 ms |       |
| gold-107 | gynecology        | en (en)            |           3 / 0 / 0 |            1 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |      2295/289 | $0.000000 |    0 ms |       |
| gold-108 | internal_medicine | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2281/167 | $0.000000 |    0 ms |       |
| gold-109 | diabetology       | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |      2305/276 | $0.000000 |    0 ms |       |
| gold-110 | internal_medicine | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2268/25 | $0.000000 |    0 ms |       |
| gold-111 | psychology        | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      2296/135 | $0.000000 |    0 ms |       |
| gold-112 | internal_medicine | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2289/216 | $0.000000 |    0 ms |       |
| gold-113 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      2285/177 | $0.000000 |    0 ms |       |
| gold-114 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2281/161 | $0.000000 |    0 ms |       |
| gold-115 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2276/56 | $0.000000 |    0 ms |       |
| gold-116 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       2290/78 | $0.000000 |    0 ms |       |
| gold-117 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      2286/229 | $0.000000 |    0 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Pregnancy outcome matches on kind (vaginal, caesarean, loss); an outcome read from obstetric history ("G3P2, cesárea previa") or a planned one is a false positive. Pregnancy dating counts gestational weeks, last menstrual period and estimated delivery date as one item each, matched exactly; dating a note that reports no current pregnancy (a routine "FUM" in an annual control) is a false positive.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
