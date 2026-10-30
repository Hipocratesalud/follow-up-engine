# Clinical reviewer eval: meta / muse-spark-1.3

- Prompt: `clinical-review@2`
- Date: 2026-10-30
- Cohort: 20 synthetic patients (10 planted, 10 controls), every implemented category enabled

> Agent steps: 50 replayed from `packages/testkit/fixtures/llm-snapshots/reviewer-cohort.meta.json` (tokens and cost of the original calls; latency is the replay's), 0 live.

## Summary

| Metric                                             | Value                     |
| -------------------------------------------------- | ------------------------- |
| Precision                                          | 92.9% (13 of 14 findings) |
| Recall                                             | 100.0% (13 of 13 planted) |
| Hallucinated citations (stored findings)           | **0** of 43               |
| Stored findings in English and Spanish             | 14 of 14                  |
| Submissions refused once for a missing translation | 0                         |
| Controls with any finding                          | 1 of 10                   |
| Reviews degraded to detectors only                 | 0 of 20                   |
| Steps (model calls) per review                     | 2.5                       |
| Tool calls per review                              | 1.5                       |
| Tokens per review (in / out)                       | 12,062 / 1,348            |
| Cost per review                                    | $0.016406                 |
| Projected cost per review at Muse Spark list price | $0.020806                 |
| Proposals dropped by the engine's checks           | none                      |

## By category

| Category                    |  TP |  FP |  FN | Precision | Recall |
| --------------------------- | --: | --: | --: | --------: | -----: |
| pre_visit_question          |   1 |   0 |   0 |    100.0% | 100.0% |
| lab_trend                   |   1 |   1 |   0 |     50.0% | 100.0% |
| vital_trend                 |   2 |   0 |   0 |    100.0% | 100.0% |
| abnormal_result_no_followup |   1 |   0 |   0 |    100.0% | 100.0% |
| drug_interaction            |   3 |   0 |   0 |    100.0% | 100.0% |
| drug_condition_conflict     |   1 |   0 |   0 |    100.0% | 100.0% |
| unaddressed_symptom         |   2 |   0 |   0 |    100.0% | 100.0% |
| missing_screening           |   1 |   0 |   0 |    100.0% | 100.0% |
| record_quality              |   1 |   0 |   0 |    100.0% | 100.0% |

## By patient

| Patient  | Kind    | Planted                                                 | Found                                                   | Tool calls | Status    |
| -------- | ------- | ------------------------------------------------------- | ------------------------------------------------------- | ---------: | --------- |
| rev-0001 | planted | lab_trend:creatinine, drug_condition:metformin_egfr_45  | lab_trend:creatinine, drug_condition:metformin_egfr_45  |          4 | completed |
| rev-0002 | planted | abnormal_result:hba1c                                   | abnormal_result:hba1c                                   |          3 | completed |
| rev-0003 | planted | symptom:headache                                        | symptom:headache                                        |          1 | completed |
| rev-0004 | planted | interaction:nsaid_raas_diuretic                         | interaction:nsaid_raas_diuretic                         |          4 | completed |
| rev-0005 | planted | screening:diabetic_fundus, question:diabetic_neuropathy | screening:diabetic_fundus, question:diabetic_neuropathy |          3 | completed |
| rev-0006 | planted | vital_trend:systolic_bp                                 | vital_trend:systolic_bp                                 |          2 | completed |
| rev-0007 | planted | record_quality:allergies                                | record_quality:allergies                                |          2 | completed |
| rev-0008 | planted | interaction:vka_nsaid                                   | interaction:vka_nsaid                                   |          2 | completed |
| rev-0009 | planted | interaction:ssri_tramadol                               | interaction:ssri_tramadol                               |          2 | completed |
| rev-0010 | planted | vital_trend:weight, symptom:fatigue                     | vital_trend:weight, symptom:fatigue                     |          2 | completed |
| rev-0011 | control | —                                                       | —                                                       |          1 | completed |
| rev-0012 | control | —                                                       | —                                                       |          0 | completed |
| rev-0013 | control | —                                                       | —                                                       |          0 | completed |
| rev-0014 | control | —                                                       | —                                                       |          0 | completed |
| rev-0015 | control | —                                                       | —                                                       |          0 | completed |
| rev-0016 | control | —                                                       | —                                                       |          0 | completed |
| rev-0017 | control | —                                                       | lab_trend (added)                                       |          4 | completed |
| rev-0018 | control | —                                                       | —                                                       |          0 | completed |
| rev-0019 | control | —                                                       | —                                                       |          0 | completed |
| rev-0020 | control | —                                                       | —                                                       |          0 | completed |
