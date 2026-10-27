# Rules

Versioned JSON rule definitions loaded through the `RuleSource` port.

A rule turns a clinical event into an expectation ("an imaging order should have a result within 30 days") and says what fulfills, supersedes or escalates it. Each file carries an `id` and a `version`; the version is recorded on every expectation the rule creates, so any decision can be traced back to the exact rule text that produced it.

Rules are never enabled for a clinic without clinical team validation.

## Layout

- `universal.json`: deterministic rules over structured data (`lab_order_result_pending`, `imaging_order_result_pending`, `short_treatment_followup`, `abnormal_result_followup`).
- `doctor-plan.json`: `doctor_plan_followup`, one expectation per item of the plan the LLM read from a note.
- `cadence.json`: `cadence_break`, a break in the patient's own visit pattern.
- `escalation/*.json`: named escalation policies (`default_v1`), referenced by id from rules and protocols.

## Clinical criteria (calibrated with the clinical review, HIP-123)

- `short_treatment_followup.treatment`: what makes a prescription a short treatment. `maxRefills` (0: a refillable prescription is chronic), `chronicMedications` (ATC code prefixes and accent-insensitive name stems that are never a short treatment, whatever the dispensed supply), `asNeededPhrases` (dosage text meaning "only when needed"; FHIR `asNeeded` counts too) and `conditionalReturnPhrases` (note text that makes the control conditional, "reconsultar si persiste"). One control per consultation, when its longest treatment ends.
- `abnormal_result_followup.resultTargets`: condition-aware targets. A result of `code` in a patient already known to have one of `conditionCodes` (not inferred from that same result) is at target while its value satisfies `atTarget` (HbA1c 4–8 % in a known diabetic), whatever the lab flag.
- `coveredByPlan`: a universal visit expectation is not added (or is withdrawn) when a live doctor's-plan visit is due by then, the same day included.
- `cadence_break.cadence.episodes` and `acuteEpisode`: visits of closed episodes leave the visit pattern (a pregnancy once a postpartum `Z39` visit came; an acute visit that started a short course, as `treatmentRule` defines it, and the next visit within the course plus `controlWithinDays`). A discharge ("se da de alta") closes everything before it.

Each file holds a rule or an array of rules validated by `RuleSchema` (`packages/core/src/config/rule.ts`). `reason.code` equals the rule id. See `packages/core/README.md` for layers, precedence and how to add a rule.
