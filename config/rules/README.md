# Rules

Versioned JSON rule definitions loaded through the `RuleSource` port.

A rule turns a clinical event into an expectation ("an imaging order should have a result within 30 days") and says what fulfills, supersedes or escalates it. Each file carries an `id` and a `version`; the version is recorded on every expectation the rule creates, so any decision can be traced back to the exact rule text that produced it.

Rules are never enabled for a clinic without clinical team validation.

## Layout

- `universal.json`: deterministic rules over structured data (`lab_order_result_pending`, `imaging_order_result_pending`, `short_treatment_followup`, `abnormal_result_followup`).
- `doctor-plan.json`: `doctor_plan_followup`, one expectation per item of the plan the LLM read from a note.
- `cadence.json`: `cadence_break`, a break in the patient's own visit pattern.
- `escalation/*.json`: named escalation policies (`default_v1`), referenced by id from rules and protocols.

Each file holds a rule or an array of rules validated by `RuleSchema` (`packages/core/src/config/rule.ts`). `reason.code` equals the rule id. See `packages/core/README.md` for layers, precedence and how to add a rule.
