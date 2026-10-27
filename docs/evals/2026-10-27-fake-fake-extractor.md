# Note extraction eval: fake / fake-extractor

- Date: 2026-10-27T08:41:52.523Z
- Provider: `fake`
- Model: `fake-extractor`
- Prompt: `note-extraction@3`
- Notes: 76 (errors: 0)
- Wall time: 0.0 s
- Gold set: `packages/testkit/fixtures/gold-notes (76 of 76 notes)`

> Fake provider in **baseline** mode: a deterministic, rule-based extractor (regexes, no model). It runs offline in CI and is the floor a Meta model has to beat. Its rules were written while looking at the gold notes, so it overstates how well regexes generalize. It reads the note the model would see (names masked, capped) and passes the same evidence checks.

## Overall

| Field                         | Precision | Recall |    F1 | TP / FP / FN |
| ----------------------------- | --------: | -----: | ----: | -----------: |
| Conditions (ICD-10 category)  |    100.0% |  66.7% | 80.0% |  56 / 0 / 28 |
| Medications (fuzzy drug name) |     88.7% |  78.3% | 83.2% |  47 / 6 / 13 |
| Plan items (kind + due ±20%)  |     90.2% |  96.1% | 93.1% |   74 / 8 / 3 |

| Metric                                                                            |          Value |
| --------------------------------------------------------------------------------- | -------------: |
| hasPlan accuracy                                                                  |          94.7% |
| Discharge accuracy ("se da de alta")                                              |          98.7% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 205) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        0 / 205 |
| Input tokens per note                                                             |           1713 |
| Output tokens per note                                                            |            105 |
| Cost per note                                                                     |      $0.000000 |
| Total cost                                                                        |      $0.000000 |
| Latency p50                                                                       |           0 ms |
| Latency p95                                                                       |          10 ms |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |    19 |        100.0% |          84.0% |         98.3% |        94.7% |      0 |
| gynecology        |    15 |         33.3% |          40.0% |         87.5% |        86.7% |      0 |
| internal_medicine |    27 |         76.0% |          90.2% |         91.7% |        96.3% |      0 |
| psychology        |    15 |         71.4% |         100.0% |         90.0% |       100.0% |      0 |

## Per note

| Note     | Specialty         | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1737/260 | $0.000000 |   10 ms |       |
| gold-002 | diabetology       |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1718/86 | $0.000000 |   10 ms |       |
| gold-003 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 1 / 0 |   ok    |              0 |      1749/233 | $0.000000 |   10 ms |       |
| gold-004 | diabetology       |           2 / 0 / 0 |            1 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      1711/162 | $0.000000 |   10 ms |       |
| gold-005 | diabetology       |           3 / 0 / 0 |            1 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |      1707/108 | $0.000000 |    1 ms |       |
| gold-006 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      1731/247 | $0.000000 |    1 ms |       |
| gold-007 | diabetology       |           2 / 0 / 0 |            1 / 0 / 1 |     2 / 0 / 0 |   ok    |              0 |      1723/172 | $0.000000 |    1 ms |       |
| gold-008 | diabetology       |           2 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1725/111 | $0.000000 |    1 ms |       |
| gold-009 | diabetology       |           1 / 0 / 0 |            0 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |       1695/44 | $0.000000 |    1 ms |       |
| gold-010 | diabetology       |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1721/202 | $0.000000 |    1 ms |       |
| gold-011 | diabetology       |           1 / 0 / 0 |            0 / 1 / 1 |     1 / 0 / 0 |   ok    |              0 |      1730/115 | $0.000000 |    1 ms |       |
| gold-012 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 1 |     1 / 0 / 0 |   ok    |              0 |      1725/123 | $0.000000 |    1 ms |       |
| gold-013 | internal_medicine |           0 / 0 / 1 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1726/75 | $0.000000 |    0 ms |       |
| gold-014 | internal_medicine |           2 / 0 / 1 |            1 / 1 / 0 |     2 / 1 / 0 |   ok    |              0 |      1737/237 | $0.000000 |    0 ms |       |
| gold-015 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1705/62 | $0.000000 |    0 ms |       |
| gold-016 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      1722/164 | $0.000000 |    0 ms |       |
| gold-017 | internal_medicine |           1 / 0 / 1 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1762/147 | $0.000000 |    1 ms |       |
| gold-018 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1697/21 | $0.000000 |    0 ms |       |
| gold-019 | internal_medicine |           2 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1774/128 | $0.000000 |    0 ms |       |
| gold-020 | internal_medicine |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1744/223 | $0.000000 |    1 ms |       |
| gold-021 | internal_medicine |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      1725/100 | $0.000000 |    0 ms |       |
| gold-022 | internal_medicine |           1 / 0 / 0 |            0 / 1 / 1 |     2 / 1 / 0 |   ok    |              0 |      1716/196 | $0.000000 |    0 ms |       |
| gold-023 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1743/88 | $0.000000 |    0 ms |       |
| gold-024 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1699/21 | $0.000000 |    0 ms |       |
| gold-025 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1712/63 | $0.000000 |    1 ms |       |
| gold-026 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1709/28 | $0.000000 |    1 ms |       |
| gold-027 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1722/90 | $0.000000 |    1 ms |       |
| gold-028 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1684/21 | $0.000000 |    1 ms |       |
| gold-029 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1747/113 | $0.000000 |    0 ms |       |
| gold-030 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1716/64 | $0.000000 |    0 ms |       |
| gold-031 | psychology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1713/21 | $0.000000 |    0 ms |       |
| gold-032 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1705/66 | $0.000000 |    0 ms |       |
| gold-033 | psychology        |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      1723/170 | $0.000000 |    1 ms |       |
| gold-034 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1724/115 | $0.000000 |    1 ms |       |
| gold-035 | gynecology        |           1 / 0 / 0 |            0 / 2 / 2 |     1 / 0 / 1 |   ok    |              0 |      1742/127 | $0.000000 |    1 ms |       |
| gold-036 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1728/67 | $0.000000 |    1 ms |       |
| gold-037 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1698/21 | $0.000000 |    0 ms |       |
| gold-038 | gynecology        |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1706/94 | $0.000000 |    0 ms |       |
| gold-039 | gynecology        |           0 / 0 / 1 |            0 / 0 / 1 |     2 / 1 / 0 |   ok    |              0 |      1717/149 | $0.000000 |    0 ms |       |
| gold-040 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1695/21 | $0.000000 |    0 ms |       |
| gold-041 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 1 / 1 |   ok    |              0 |      1707/113 | $0.000000 |    0 ms |       |
| gold-042 | gynecology        |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1716/133 | $0.000000 |    0 ms |       |
| gold-043 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1714/115 | $0.000000 |    0 ms |       |
| gold-044 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |       1704/21 | $0.000000 |    0 ms |       |
| gold-045 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1714/53 | $0.000000 |    0 ms |       |
| gold-046 | internal_medicine |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1695/50 | $0.000000 |    0 ms |       |
| gold-047 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1724/97 | $0.000000 |    0 ms |       |
| gold-048 | diabetology       |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1716/158 | $0.000000 |    0 ms |       |
| gold-049 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1719/54 | $0.000000 |    4 ms |       |
| gold-050 | gynecology        |           1 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1713/40 | $0.000000 |    4 ms |       |
| gold-051 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1701/176 | $0.000000 |    4 ms |       |
| gold-052 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      1738/167 | $0.000000 |    4 ms |       |
| gold-053 | psychology        |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1721/95 | $0.000000 |    0 ms |       |
| gold-054 | gynecology        |           0 / 0 / 1 |            1 / 0 / 1 |     0 / 0 / 0 |  wrong  |              0 |       1706/48 | $0.000000 |    0 ms |       |
| gold-055 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1704/54 | $0.000000 |    0 ms |       |
| gold-056 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1713/120 | $0.000000 |    0 ms |       |
| gold-057 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1706/21 | $0.000000 |    1 ms |       |
| gold-058 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1694/64 | $0.000000 |    1 ms |       |
| gold-059 | gynecology        |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1698/107 | $0.000000 |    1 ms |       |
| gold-060 | diabetology       |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1702/85 | $0.000000 |    1 ms |       |
| gold-061 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1696/105 | $0.000000 |    0 ms |       |
| gold-062 | internal_medicine |           0 / 0 / 1 |            0 / 0 / 1 |     0 / 0 / 0 |   ok    |              0 |       1699/21 | $0.000000 |    0 ms |       |
| gold-063 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1702/54 | $0.000000 |    0 ms |       |
| gold-064 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1696/33 | $0.000000 |    0 ms |       |
| gold-065 | internal_medicine |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1695/57 | $0.000000 |    0 ms |       |
| gold-066 | psychology        |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |       1685/30 | $0.000000 |    0 ms |       |
| gold-067 | internal_medicine |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1697/99 | $0.000000 |    0 ms |       |
| gold-068 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      1702/189 | $0.000000 |    0 ms |       |
| gold-069 | diabetology       |           2 / 0 / 0 |            1 / 0 / 1 |     4 / 0 / 0 |   ok    |              0 |      1739/260 | $0.000000 |    0 ms |       |
| gold-070 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1688/159 | $0.000000 |    0 ms |       |
| gold-071 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1689/150 | $0.000000 |    0 ms |       |
| gold-072 | diabetology       |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1682/150 | $0.000000 |    0 ms |       |
| gold-073 | internal_medicine |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1679/64 | $0.000000 |    0 ms |       |
| gold-074 | gynecology        |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |       1678/65 | $0.000000 |    0 ms |       |
| gold-075 | internal_medicine |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      1692/109 | $0.000000 |    0 ms |       |
| gold-076 | diabetology       |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      1680/127 | $0.000000 |    0 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
