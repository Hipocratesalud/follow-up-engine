# Note extraction eval: fake / fake-extractor (before the QA round 2 fixes, same 70 notes)

- Date: 2026-10-27T07:11:16.643Z
- Provider: `fake`
- Model: `fake-extractor`
- Prompt: `note-extraction@2`
- Notes: 70 (errors: 0)
- Wall time: 0.0 s
- Gold set: `packages/testkit/fixtures/gold-notes (70 of 70 notes)`

> Fake provider in **baseline** mode: a deterministic, rule-based extractor (regexes, no model). It runs offline in CI and is the floor a Meta model has to beat. Its rules were written while looking at the gold notes, so it overstates how well regexes generalize. It reads the note the model would see (names masked, capped) and passes the same evidence checks.

## Overall

| Field                         | Precision | Recall |    F1 | TP / FP / FN |
| ----------------------------- | --------: | -----: | ----: | -----------: |
| Conditions (ICD-10 category)  |     82.0% |  62.5% | 70.9% | 50 / 11 / 30 |
| Medications (fuzzy drug name) |     88.0% |  77.2% | 82.2% |  44 / 6 / 13 |
| Plan items (kind + due ±20%)  |     90.8% |  86.8% | 88.7% |   59 / 6 / 9 |

| Metric                                                                            |          Value |
| --------------------------------------------------------------------------------- | -------------: |
| hasPlan accuracy                                                                  |          91.4% |
| Discharge accuracy ("se da de alta")                                              |          92.9% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 188) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        0 / 188 |
| Input tokens per note                                                             |           1298 |
| Output tokens per note                                                            |            103 |
| Cost per note                                                                     |      $0.000000 |
| Total cost                                                                        |      $0.000000 |
| Latency p50                                                                       |           0 ms |
| Latency p95                                                                       |           5 ms |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |    17 |         90.9% |          83.3% |         88.9% |        94.1% |      0 |
| gynecology        |    14 |         30.0% |          40.0% |         89.7% |        85.7% |      0 |
| internal_medicine |    24 |         65.4% |          89.4% |         87.2% |        95.8% |      0 |
| psychology        |    15 |         71.4% |         100.0% |         90.0% |        86.7% |      0 |

## Per note

| Note     | Specialty         | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1320/261 | $0.000000 |    6 ms |       |
| gold-002 | diabetology       |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1301/86 | $0.000000 |    5 ms |       |
| gold-003 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 1 |   ok    |              0 |      1332/163 | $0.000000 |    5 ms |       |
| gold-004 | diabetology       |           2 / 0 / 0 |            1 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      1294/162 | $0.000000 |    5 ms |       |
| gold-005 | diabetology       |           3 / 0 / 0 |            1 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |      1289/108 | $0.000000 |    1 ms |       |
| gold-006 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      1314/248 | $0.000000 |    1 ms |       |
| gold-007 | diabetology       |           2 / 0 / 0 |            1 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      1306/174 | $0.000000 |    1 ms |       |
| gold-008 | diabetology       |           1 / 1 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1308/111 | $0.000000 |    1 ms |       |
| gold-009 | diabetology       |           1 / 0 / 0 |            0 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |       1278/44 | $0.000000 |    1 ms |       |
| gold-010 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1304/201 | $0.000000 |    0 ms |       |
| gold-011 | diabetology       |           1 / 0 / 0 |            0 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      1313/115 | $0.000000 |    0 ms |       |
| gold-012 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 1 |     1 / 0 / 0 |   ok    |              0 |      1308/123 | $0.000000 |    0 ms |       |
| gold-013 | internal_medicine |           0 / 0 / 1 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1309/75 | $0.000000 |    0 ms |       |
| gold-014 | internal_medicine |           2 / 0 / 1 |            1 / 1 / 0 |     2 / 0 / 0 |   ok    |              0 |      1319/194 | $0.000000 |    0 ms |       |
| gold-015 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1287/62 | $0.000000 |    0 ms |       |
| gold-016 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      1305/164 | $0.000000 |    0 ms |       |
| gold-017 | internal_medicine |           1 / 0 / 1 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1345/147 | $0.000000 |    0 ms |       |
| gold-018 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1279/21 | $0.000000 |    0 ms |       |
| gold-019 | internal_medicine |           2 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1357/128 | $0.000000 |    0 ms |       |
| gold-020 | internal_medicine |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1327/225 | $0.000000 |    0 ms |       |
| gold-021 | internal_medicine |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      1308/100 | $0.000000 |    0 ms |       |
| gold-022 | internal_medicine |           1 / 0 / 0 |            0 / 1 / 1 |     2 / 0 / 0 |   ok    |              0 |      1298/155 | $0.000000 |    0 ms |       |
| gold-023 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1326/88 | $0.000000 |    0 ms |       |
| gold-024 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1282/21 | $0.000000 |    0 ms |       |
| gold-025 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1295/63 | $0.000000 |    0 ms |       |
| gold-026 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1292/28 | $0.000000 |    0 ms |       |
| gold-027 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1305/90 | $0.000000 |    0 ms |       |
| gold-028 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1267/21 | $0.000000 |    0 ms |       |
| gold-029 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1329/113 | $0.000000 |    0 ms |       |
| gold-030 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1298/64 | $0.000000 |    0 ms |       |
| gold-031 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1296/21 | $0.000000 |    0 ms |       |
| gold-032 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1287/66 | $0.000000 |    0 ms |       |
| gold-033 | psychology        |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      1306/170 | $0.000000 |    0 ms |       |
| gold-034 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1307/115 | $0.000000 |    0 ms |       |
| gold-035 | gynecology        |           1 / 0 / 0 |            0 / 2 / 2 |     1 / 0 / 1 |   ok    |              0 |      1325/127 | $0.000000 |    0 ms |       |
| gold-036 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1310/67 | $0.000000 |    0 ms |       |
| gold-037 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1281/21 | $0.000000 |    0 ms |       |
| gold-038 | gynecology        |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1289/94 | $0.000000 |    0 ms |       |
| gold-039 | gynecology        |           0 / 0 / 1 |            0 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      1300/112 | $0.000000 |    0 ms |       |
| gold-040 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1277/21 | $0.000000 |    0 ms |       |
| gold-041 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      1289/114 | $0.000000 |    0 ms |       |
| gold-042 | gynecology        |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1299/131 | $0.000000 |    0 ms |       |
| gold-043 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1297/113 | $0.000000 |    0 ms |       |
| gold-044 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1287/21 | $0.000000 |    0 ms |       |
| gold-045 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1297/53 | $0.000000 |    0 ms |       |
| gold-046 | internal_medicine |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1277/50 | $0.000000 |    0 ms |       |
| gold-047 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1306/97 | $0.000000 |    0 ms |       |
| gold-048 | diabetology       |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1299/159 | $0.000000 |    0 ms |       |
| gold-049 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1302/54 | $0.000000 |    2 ms |       |
| gold-050 | gynecology        |           1 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1296/40 | $0.000000 |    2 ms |       |
| gold-051 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1284/177 | $0.000000 |    2 ms |       |
| gold-052 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      1321/188 | $0.000000 |    2 ms |       |
| gold-053 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1304/95 | $0.000000 |    0 ms |       |
| gold-054 | gynecology        |           0 / 0 / 1 |            1 / 0 / 1 |     0 / 0 / 0 |  wrong  |              0 |       1289/48 | $0.000000 |    0 ms |       |
| gold-055 | internal_medicine |           0 / 3 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      1286/120 | $0.000000 |    0 ms |       |
| gold-056 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1296/120 | $0.000000 |    0 ms |       |
| gold-057 | internal_medicine |           0 / 2 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1288/67 | $0.000000 |    0 ms |       |
| gold-058 | internal_medicine |           0 / 1 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1277/87 | $0.000000 |    0 ms |       |
| gold-059 | gynecology        |           0 / 2 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1281/154 | $0.000000 |    0 ms |       |
| gold-060 | diabetology       |           1 / 1 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1284/109 | $0.000000 |    0 ms |       |
| gold-061 | diabetology       |           0 / 1 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1279/109 | $0.000000 |    0 ms |       |
| gold-062 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 1 |     0 / 1 / 0 |   ok    |              0 |       1282/64 | $0.000000 |    0 ms |       |
| gold-063 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 1 / 0 |   ok    |              0 |       1285/97 | $0.000000 |    0 ms |       |
| gold-064 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1279/21 | $0.000000 |    0 ms |       |
| gold-065 | internal_medicine |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1278/47 | $0.000000 |    0 ms |       |
| gold-066 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1268/21 | $0.000000 |    0 ms |       |
| gold-067 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1280/106 | $0.000000 |    0 ms |       |
| gold-068 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 1 |   ok    |              0 |      1285/150 | $0.000000 |    0 ms |       |
| gold-069 | diabetology       |           2 / 0 / 0 |            1 / 0 / 1 |     2 / 0 / 2 |   ok    |              0 |      1322/187 | $0.000000 |    0 ms |       |
| gold-070 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 2 |   ok    |              0 |       1270/64 | $0.000000 |    0 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
