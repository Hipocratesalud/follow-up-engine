# Adjudicator eval: fake / fake-adjudicator

Date: 2026-10-30. Prompt: `adjudicator@1`. Gold set: `packages/testkit/fixtures/adjudicator-gold/gold.json` (20 synthetic ambiguous items).

> Fake provider: the **scripted adjudicator**, deterministic cue words over the item's sentence, through the real gateway and the engine's checks. It was written next to this gold set, so its score shows the protocol and the checks, not clinical judgment.

| Metric                               | Value     |
| ------------------------------------ | --------- |
| Accuracy (after the engine's checks) | 100.0 %   |
| Model accuracy (before the checks)   | 100.0 %   |
| Open ↔ discard flips                 | 0         |
| Brier score (open/discard items)     | 0.0168    |
| Items without a verified quote       | 0         |
| Errors                               | 0         |
| Total cost                           | $0.000000 |
| Mean latency                         | 0 ms      |

Confusion (rows: expected, columns: decided):

| expected    | open | discard | needs_human |
| ----------- | ---- | ------- | ----------- |
| open        | 6    | 0       | 0           |
| discard     | 0    | 7       | 0           |
| needs_human | 0    | 0       | 7           |

| Item    | Expected    | Decided     | Model       | Probability | Reasons                               |
| ------- | ----------- | ----------- | ----------- | ----------- | ------------------------------------- |
| adj-001 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-002 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-003 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-004 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-005 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-006 | open        | open        | open        | 0.86        | explicit_instruction, timing_explicit |
| adj-007 | discard     | discard     | discard     | 0.12        | negated                               |
| adj-008 | discard     | discard     | discard     | 0.12        | already_done                          |
| adj-009 | discard     | discard     | discard     | 0.12        | patient_declined                      |
| adj-010 | discard     | discard     | discard     | 0.12        | deferred_to_other_provider            |
| adj-011 | discard     | discard     | discard     | 0.12        | negated                               |
| adj-012 | discard     | discard     | discard     | 0.12        | already_done                          |
| adj-013 | discard     | discard     | discard     | 0.12        | negated                               |
| adj-014 | needs_human | needs_human | needs_human | 0.45        | conditional_plan                      |
| adj-015 | needs_human | needs_human | needs_human | 0.45        | conditional_plan                      |
| adj-016 | needs_human | needs_human | needs_human | 0.45        | hypothetical_mention                  |
| adj-017 | needs_human | needs_human | needs_human | 0.45        | conditional_plan                      |
| adj-018 | needs_human | needs_human | needs_human | 0.45        | conditional_plan                      |
| adj-019 | needs_human | needs_human | needs_human | 0.55        | explicit_instruction, timing_vague    |
| adj-020 | needs_human | needs_human | needs_human | 0.45        | conditional_plan                      |
