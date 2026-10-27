# Note extraction eval: meta / muse-spark-1.3

- Date: 2026-10-27T15:23:11.297Z
- Provider: `meta`
- Model: `muse-spark-1.3`
- Prompt: `note-extraction@5`
- Notes: 101 (errors: 0)
- Wall time: 126.0 s
- Gold set: `packages/testkit/fixtures/gold-notes (101 of 101 notes)`

> Model replies: 0 replayed from `packages/testkit/fixtures/llm-snapshots/gold-notes.meta.json` (recorded from meta/muse-spark-1.3; tokens and cost are those of the original calls, latency is the replay's), 101 live.

## Overall

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |     96.1% |  86.8% |  91.2% |  99 / 4 / 15 |
| Medications (fuzzy drug name)            |     98.7% |  97.5% |  98.1% |   77 / 1 / 2 |
| Plan items (kind + due ±20%)             |     87.2% |  99.2% |  92.8% | 123 / 18 / 1 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

| Metric                                                                            |          Value |
| --------------------------------------------------------------------------------- | -------------: |
| hasPlan accuracy                                                                  |          98.0% |
| Discharge accuracy ("se da de alta", "d/c'd from therapy")                        |         100.0% |
| Hallucinated-quote rate (items dropped by the verbatim check)                     | 0.0% (0 / 348) |
| Items dropped by the evidence checks (quote in the note but not backing the item) |        1 / 348 |
| Input tokens per note                                                             |           3837 |
| Output tokens per note                                                            |            982 |
| Cost per note                                                                     |      $0.004887 |
| Total cost                                                                        |      $0.493603 |
| Latency p50                                                                       |        3430 ms |
| Latency p95                                                                       |        6847 ms |

## Dropped or demoted by the post-checks

| Field     | Reason            | Items |
| --------- | ----------------- | ----: |
| planItem  | `no_due_date`     |     6 |
| condition | `duplicate`       |     1 |
| planItem  | `duplicate`       |     1 |
| planItem  | `quote_unrelated` |     1 |

## By specialty

| Specialty         | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |
| ----------------- | ----: | ------------: | -------------: | ------------: | -----------: | -----: |
| diabetology       |    24 |        100.0% |         100.0% |         97.8% |       100.0% |      0 |
| gynecology        |    26 |         81.6% |         100.0% |         92.9% |        96.2% |      0 |
| internal_medicine |    32 |         88.2% |          98.4% |         83.6% |        96.9% |      0 |
| psychology        |    19 |         91.7% |          50.0% |        100.0% |       100.0% |      0 |

## By note language

The language each gold note is written in. The eval never tells the extractor: it detects the language (a stopword count, `language.ts`), reads the note with that language's lexicons, and the detection is scored here.

| Language | Notes | Detected right | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Discharge acc. | Errors |
| -------- | ----: | -------------: | ------------: | -------------: | ------------: | -----------: | -------------: | -----: |
| en       |    17 |         100.0% |        100.0% |          90.3% |        100.0% |       100.0% |         100.0% |      0 |
| es       |    84 |          98.8% |         89.3% |         100.0% |         90.8% |        97.6% |         100.0% |      0 |

### en

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |    100.0% | 100.0% | 100.0% |   20 / 0 / 0 |
| Medications (fuzzy drug name)            |     93.3% |  87.5% |  90.3% |   14 / 1 / 2 |
| Plan items (kind + due ±20%)             |    100.0% | 100.0% | 100.0% |   29 / 0 / 0 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    0 / 0 / 0 |

### es

| Field                                    | Precision | Recall |     F1 | TP / FP / FN |
| ---------------------------------------- | --------: | -----: | -----: | -----------: |
| Conditions (ICD-10 category)             |     95.2% |  84.0% |  89.3% |  79 / 4 / 15 |
| Medications (fuzzy drug name)            |    100.0% | 100.0% | 100.0% |   63 / 0 / 0 |
| Plan items (kind + due ±20%)             |     83.9% |  98.9% |  90.8% |  94 / 18 / 1 |
| Pregnancy outcome (kind)                 |    100.0% | 100.0% | 100.0% |    4 / 0 / 0 |
| Pregnancy dating (weeks, LMP, EDD exact) |    100.0% | 100.0% | 100.0% |    6 / 0 / 0 |

## Per note

| Note     | Specialty         | Language (read as) | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out |      Cost | Latency | Error |
| -------- | ----------------- | ------------------ | ------------------: | -------------------: | ------------: | :-----: | -------------: | ------------: | --------: | ------: | ----- |
| gold-001 | diabetology       | es (es)            |           2 / 0 / 0 |            3 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3892/1014 | $0.004967 | 4053 ms |       |
| gold-002 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3853/975 | $0.004893 | 5526 ms |       |
| gold-003 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3903/1850 | $0.008675 | 7668 ms |       |
| gold-004 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3848/802 | $0.004152 | 3826 ms |       |
| gold-005 | diabetology       | es (es)            |           3 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3841/785 | $0.004071 | 3483 ms |       |
| gold-006 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3885/1035 | $0.005188 | 4709 ms |       |
| gold-007 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3869/1064 | $0.005292 | 4496 ms |       |
| gold-008 | diabetology       | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     1 / 2 / 0 |   ok    |              0 |     3851/1053 | $0.005222 | 3534 ms |       |
| gold-009 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3823/869 | $0.004405 | 3957 ms |       |
| gold-010 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3862/1126 | $0.005546 | 4245 ms |       |
| gold-011 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3859/1072 | $0.005313 | 3594 ms |       |
| gold-012 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 3 / 0 |   ok    |              0 |     3863/1441 | $0.006886 | 4834 ms |       |
| gold-013 | internal_medicine | es (es)            |           0 / 1 / 1 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3865/928 | $0.004709 | 3154 ms |       |
| gold-014 | internal_medicine | es (es)            |           3 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3881/1892 | $0.008826 | 6847 ms |       |
| gold-015 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3829/870 | $0.004417 | 3056 ms |       |
| gold-016 | internal_medicine | es (es)            |           0 / 1 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3855/772 | $0.004033 | 3621 ms |       |
| gold-017 | internal_medicine | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3901/1040 | $0.005230 | 3430 ms |       |
| gold-018 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3822/360 | $0.002241 | 2359 ms |       |
| gold-019 | internal_medicine | es (es)            |           2 / 0 / 0 |            1 / 0 / 0 |     1 / 7 / 0 |   ok    |              0 |     3915/2305 | $0.010623 | 7847 ms |       |
| gold-020 | internal_medicine | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3898/1510 | $0.007223 | 4675 ms |       |
| gold-021 | internal_medicine | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3853/771 | $0.004026 | 2756 ms |       |
| gold-022 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3847/2004 | $0.009259 | 6593 ms |       |
| gold-023 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3845/666 | $0.003570 | 3013 ms |       |
| gold-024 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3803/448 | $0.002591 | 2224 ms |       |
| gold-025 | psychology        | es (es)            |           0 / 1 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3825/705 | $0.003711 | 3013 ms |       |
| gold-026 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3811/329 | $0.002095 | 1251 ms |       |
| gold-027 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3830/973 | $0.004856 | 3306 ms |       |
| gold-028 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3796/214 | $0.001588 |  967 ms |       |
| gold-029 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3848/1240 | $0.006013 | 4448 ms |       |
| gold-030 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3820/581 | $0.003178 | 2548 ms |       |
| gold-031 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3814/505 | $0.002847 | 2347 ms |       |
| gold-032 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3810/1503 | $0.007084 | 5310 ms |       |
| gold-033 | psychology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3839/1363 | $0.006525 | 5141 ms |       |
| gold-034 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 1 / 0 |   ok    |              0 |      3855/964 | $0.004849 | 3377 ms |       |
| gold-035 | gynecology        | es (es)            |           0 / 0 / 1 |            2 / 0 / 0 |     2 / 5 / 0 |   ok    |              0 |     3877/1811 | $0.008476 | 6155 ms |       |
| gold-036 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3848/1944 | $0.009005 | 7524 ms |       |
| gold-037 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3823/396 | $0.002395 | 1658 ms |       |
| gold-038 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3836/660 | $0.003533 | 2391 ms |       |
| gold-039 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3852/1067 | $0.005283 | 3914 ms |       |
| gold-040 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3815/548 | $0.003031 | 2281 ms |       |
| gold-041 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3833/1188 | $0.005774 | 4775 ms |       |
| gold-042 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3842/1685 | $0.007897 | 5823 ms |       |
| gold-043 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3829/900 | $0.004545 | 2912 ms |       |
| gold-044 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3824/276 | $0.001886 | 1093 ms |       |
| gold-045 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3821/591 | $0.003221 | 2690 ms |       |
| gold-046 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3810/502 | $0.002829 | 2254 ms |       |
| gold-047 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3848/693 | $0.003548 | 2366 ms |       |
| gold-048 | diabetology       | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3853/797 | $0.004137 | 2399 ms |       |
| gold-049 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3846/785 | $0.004077 | 2706 ms |       |
| gold-050 | gynecology        | es (es)            |           2 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3834/431 | $0.002558 | 1862 ms |       |
| gold-051 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3843/1010 | $0.005030 | 3283 ms |       |
| gold-052 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3868/684 | $0.003675 | 2249 ms |       |
| gold-053 | psychology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3836/593 | $0.003249 | 2326 ms |       |
| gold-054 | gynecology        | es (es)            |           1 / 0 / 0 |            2 / 0 / 0 |     0 / 0 / 0 |  wrong  |              0 |     3830/1373 | $0.006556 | 4411 ms |       |
| gold-055 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3831/699 | $0.003693 | 2326 ms |       |
| gold-056 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3840/720 | $0.003793 | 2907 ms |       |
| gold-057 | internal_medicine | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3826/557 | $0.003083 | 2764 ms |       |
| gold-058 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3809/431 | $0.002526 | 2102 ms |       |
| gold-059 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3817/1715 | $0.007993 | 5852 ms |       |
| gold-060 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3820/667 | $0.003543 | 2060 ms |       |
| gold-061 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3830/566 | $0.003126 | 2134 ms |       |
| gold-062 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3819/547 | $0.003032 | 2689 ms |       |
| gold-063 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3832/968 | $0.004837 | 4286 ms |       |
| gold-064 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3802/430 | $0.002513 | 1973 ms |       |
| gold-065 | internal_medicine | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3802/296 | $0.001944 | 1439 ms |       |
| gold-066 | psychology        | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3793/361 | $0.002209 | 1479 ms |       |
| gold-067 | internal_medicine | es (es)            |           0 / 0 / 1 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3814/1028 | $0.005070 | 4620 ms |       |
| gold-068 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3824/1499 | $0.007084 | 5304 ms |       |
| gold-069 | diabetology       | es (es)            |           2 / 0 / 0 |            2 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |     3881/1954 | $0.009089 | 6461 ms |       |
| gold-070 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3810/914 | $0.004580 | 3247 ms |       |
| gold-071 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3812/648 | $0.003452 | 2287 ms |       |
| gold-072 | diabetology       | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3815/727 | $0.003792 | 2884 ms |       |
| gold-073 | internal_medicine | es (es)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 1 |  wrong  |              0 |      3792/438 | $0.002535 | 2515 ms |       |
| gold-074 | gynecology        | es (?)             |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3795/1000 | $0.004927 | 3986 ms |       |
| gold-075 | internal_medicine | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3816/609 | $0.003292 | 2659 ms |       |
| gold-076 | diabetology       | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3806/691 | $0.003628 | 2272 ms |       |
| gold-077 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3853/1537 | $0.007282 | 5626 ms |       |
| gold-078 | gynecology        | es (es)            |           1 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3851/1566 | $0.007403 | 6178 ms |       |
| gold-079 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3846/997 | $0.004978 | 3758 ms |       |
| gold-080 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3838/1898 | $0.008797 | 6899 ms |       |
| gold-081 | gynecology        | es (es)            |           1 / 0 / 0 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3835/2065 | $0.009503 | 7210 ms |       |
| gold-082 | gynecology        | es (es)            |           0 / 0 / 2 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3863/653 | $0.003537 | 2618 ms |       |
| gold-083 | gynecology        | es (es)            |           2 / 1 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3881/1472 | $0.007041 | 5326 ms |       |
| gold-084 | gynecology        | es (es)            |           0 / 0 / 1 |            0 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3864/1127 | $0.005553 | 4497 ms |       |
| gold-101 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3853/891 | $0.004396 | 3454 ms |       |
| gold-102 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3848/1553 | $0.007203 | 5028 ms |       |
| gold-103 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3834/661 | $0.003394 | 2426 ms |       |
| gold-104 | psychology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3802/335 | $0.002110 | 1629 ms |       |
| gold-105 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |     3800/1199 | $0.005779 | 4546 ms |       |
| gold-106 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     1 / 0 / 0 |   ok    |              0 |      3821/656 | $0.003498 | 2242 ms |       |
| gold-107 | gynecology        | en (en)            |           3 / 0 / 0 |            1 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |     3834/1630 | $0.007513 | 5635 ms |       |
| gold-108 | internal_medicine | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |     3827/1048 | $0.005030 | 4023 ms |       |
| gold-109 | diabetology       | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     4 / 0 / 0 |   ok    |              0 |     3848/1882 | $0.008601 | 6290 ms |       |
| gold-110 | internal_medicine | en (en)            |           0 / 0 / 0 |            0 / 1 / 0 |     0 / 0 / 0 |   ok    |              0 |      3793/868 | $0.004364 | 3792 ms |       |
| gold-111 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 2 |     1 / 0 / 0 |   ok    |              0 |     3826/1004 | $0.004842 | 4201 ms |       |
| gold-112 | internal_medicine | en (en)            |           1 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3830/1211 | $0.005727 | 5089 ms |       |
| gold-113 | diabetology       | en (en)            |           2 / 0 / 0 |            1 / 0 / 0 |     2 / 0 / 0 |   ok    |              0 |      3834/849 | $0.004193 | 3005 ms |       |
| gold-114 | gynecology        | en (en)            |           0 / 0 / 0 |            0 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |     3815/1190 | $0.005760 | 4357 ms |       |
| gold-115 | psychology        | en (en)            |           1 / 0 / 0 |            0 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3796/914 | $0.004563 | 3796 ms |       |
| gold-116 | internal_medicine | en (en)            |           1 / 0 / 0 |            1 / 0 / 0 |     0 / 0 / 0 |   ok    |              0 |      3820/711 | $0.003730 | 2652 ms |       |
| gold-117 | diabetology       | en (en)            |           2 / 0 / 0 |            2 / 0 / 0 |     3 / 0 / 0 |   ok    |              0 |      3833/864 | $0.004256 | 2734 ms |       |

## How to read this

- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.
- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.
- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.
- The evidence checks drop items whose quote is in the note but does not back them: too short ("Plan"), no term linked to the ICD-10 code, no drug name, no plan wording or timing, a denied condition ("niega HTA"), a conditional return ("volver si fiebre"), an interval that contradicts the quoted one, or a measurement listed as a medication.
- Discharge accuracy: the note discharges the patient ("se da de alta") exactly when the gold note says so.
- Pregnancy outcome matches on kind (vaginal, caesarean, loss); an outcome read from obstetric history ("G3P2, cesárea previa") or a planned one is a false positive. Pregnancy dating counts gestational weeks, last menstrual period and estimated delivery date as one item each, matched exactly; dating a note that reports no current pregnancy (a routine "FUM" in an annual control) is a false positive.
- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.
