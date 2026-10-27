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

- `short_treatment_followup.treatment`: what makes a prescription a short treatment. `maxRefills` (0: a refillable prescription is chronic); drug classes by ATC code prefix, from the prescription's ATC code or, for an uncoded or otherwise coded drug, the engine's Spanish/INN name table (`packages/core/src/engine/terminology/atc.ts`): `chronicMedications` (never a short treatment, whatever the dispensed supply: `B01` antithrombotics, `C` cardiovascular, `R03` inhalers, `M04` antigout, `G04C` BPH, `N06D` anti-dementia, ...; optional `text` stems for names the table does not know), `acuteMedications` (clearly acute: `J01` antibiotics, `M01A` NSAIDs, `N02` analgesics, ...) and `unclassifiedMaxDays` (14: any other drug only when explicitly that short); `asNeededPhrases` and `asNeededConditions` (dosage text meaning "only when needed": "PRN", "por razones necesarias", "en caso necesario", and a lead plus a symptom, "si hay dolor", "en caso de crisis"; FHIR `asNeeded` counts too) and `conditionalReturnPhrases` (note text that makes the control conditional, "reconsultar si persiste"). One control per consultation, when its longest treatment ends.
- `abnormal_result_followup.resultTargets`: condition-aware targets. A result of `code` in a patient already known to have one of `conditionCodes` (not inferred from that same result) is at target while its value satisfies `atTarget` (HbA1c 4–8 % in a known diabetic), whatever the lab flag. Any LOINC code of the same measurement counts, its value read in the target's unit (IFCC HbA1c 59261-8 in mmol/mol is converted to %: 8 % is about 64 mmol/mol; see `packages/core/src/engine/terminology/loinc.ts`).
- `lab_order_result_pending` (and every `same_code` correlation): a result answers an order under any equivalent LOINC code (HbA1c 17856-6 or IFCC 59261-8 for a 4548-4 order; a lipid panel by its components; LDL calculated or direct), see `packages/core/src/engine/terminology/loinc.ts`.
- `coveredByPlan`: a universal visit expectation is not added (or is withdrawn) when a live doctor's-plan visit is due by then, the same day included.
- `cadence_break.cadence.episodes` and `acuteEpisode`: visits of closed episodes leave the visit pattern (a pregnancy once a postpartum `Z39` visit came; an acute visit that started a short course, as `treatmentRule` defines it, and the next visit within the course plus `controlWithinDays`). `plannedControl`: the control a single visit's plan asked for (the next visit by the planned date plus the larger of `withinDays` and the planned interval) leaves the pattern when it plans nothing further, so a visit and its own control are an episode; three or more visits chained by their plans are a routine pattern. A discharge ("se da de alta") closes everything before it.

Each file holds a rule or an array of rules validated by `RuleSchema` (`packages/core/src/config/rule.ts`). `reason.code` equals the rule id. See `packages/core/README.md` for layers, precedence and how to add a rule.
