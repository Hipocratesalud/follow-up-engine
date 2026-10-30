# Adjudicator eval: meta / muse-spark-1.3

Date: 2026-10-30. Prompt: `adjudicator@1`. Gold set: `packages/testkit/fixtures/adjudicator-gold/gold.json` (20 synthetic ambiguous items).

| Metric                               | Value     |
| ------------------------------------ | --------- |
| Accuracy (after the engine's checks) | 95.0 %    |
| Model accuracy (before the checks)   | 95.0 %    |
| Open ↔ discard flips                 | 0         |
| Brier score (open/discard items)     | 0.0152    |
| Items without a verified quote       | 0         |
| Errors                               | 0         |
| Total cost                           | $0.075470 |
| Mean latency                         | 2810 ms   |

Confusion (rows: expected, columns: decided):

| expected    | open | discard | needs_human |
| ----------- | ---- | ------- | ----------- |
| open        | 6    | 0       | 0           |
| discard     | 0    | 7       | 0           |
| needs_human | 1    | 0       | 6           |

| Item    | Expected    | Decided     | Model       | Probability | Reasons                                |
| ------- | ----------- | ----------- | ----------- | ----------- | -------------------------------------- |
| adj-001 | open        | open        | open        | 0.88        | explicit_instruction, timing_explicit  |
| adj-002 | open        | open        | open        | 0.88        | explicit_instruction, timing_explicit  |
| adj-003 | open        | open        | open        | 0.88        | explicit_instruction, timing_explicit  |
| adj-004 | open        | open        | open        | 0.88        | explicit_instruction, timing_explicit  |
| adj-005 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit  |
| adj-006 | open        | open        | open        | 0.88        | explicit_instruction, timing_explicit  |
| adj-007 | discard     | discard     | discard     | 0.12        | negated, conditional_plan              |
| adj-008 | discard     | discard     | discard     | 0.12        | already_done                           |
| adj-009 | discard     | discard     | discard     | 0.12        | patient_declined                       |
| adj-010 | discard     | discard     | discard     | 0.16        | deferred_to_other_provider             |
| adj-011 | discard     | discard     | discard     | 0.12        | negated                                |
| adj-012 | discard     | discard     | discard     | 0.12        | already_done                           |
| adj-013 | discard     | discard     | discard     | 0.12        | negated, patient_declined              |
| adj-014 | needs_human | needs_human | needs_human | 0.46        | conditional_plan                       |
| adj-015 | needs_human | needs_human | needs_human | 0.41        | conditional_plan, hypothetical_mention |
| adj-016 | needs_human | needs_human | needs_human | 0.37        | hypothetical_mention, timing_vague     |
| adj-017 | needs_human | needs_human | needs_human | 0.37        | conditional_plan                       |
| adj-018 | needs_human | needs_human | needs_human | 0.37        | conditional_plan, timing_vague         |
| adj-019 | needs_human | open        | open        | 0.76        | explicit_instruction, timing_vague     |
| adj-020 | needs_human | needs_human | needs_human | 0.50        | conditional_plan, timing_vague         |
