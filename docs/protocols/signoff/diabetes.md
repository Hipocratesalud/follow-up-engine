# Diabetes follow-up — clinical sign-off package

**Status:** Ready for sign-off — not yet validated by the clinic’s clinical team

**Protocol id:** `diabetes` · **Version:** `1.2.1`

This page is generated from `config/protocols/diabetes.json` (and, for a shared test, from the other protocol file named below) plus the engine’s reason-and-action catalog (`apps/api/src/i18n`). Regenerate it with `pnpm protocols:signoff` after changing either; `pnpm test` fails if a committed page no longer matches a fresh generation. Nothing on this page is free text: every number, code and citation below is read back from config, so it cannot say something the engine does not do.

## To answer first

These points have no specific guideline section cited (see Guidelines cited below): the physician confirms these before anything else.

- `visit` — Schedule a diabetes visit

## Guidelines cited

- Standards of Care in Diabetes—2025 — American Diabetes Association (2025). <https://diabetesjournals.org/care/issue/48/Supplement_1>

## Who this protocol applies to

- An ICD-10 diagnosis of E10, E11, E13, E14 (or a more specific code under one of them, for example E10.9) at a confirmed diagnosis, or one the record only makes probable.
- A prescription matching: metformin, insulin, glibenclamid, glimepirid, gliclazid, sitagliptin, vildagliptin, linagliptin, empagliflozin, dapagliflozin, liraglutid, semaglutid, dulaglutid, pioglitazon — read as E14 when the record has no coded diagnosis.
- A LOINC 4548-4 result of 6.5 or more — read as E14 when the record has no coded diagnosis.

## What is expected, and how often

| #   | Item     | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                      | How often       | Due date rule                                                                                                                                                                                                                                                           | Guideline                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `visit`  | **Schedule a diabetes visit**<br>No diabetes visit in 6 months                                                                                                                                                                                                                                                                                                                                                                                                | Every 180 days. | Due 180 days after the last qualifying visit or result; without one yet, 180 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened. | Not itemized for this point — see Guidelines cited above; physician to confirm it applies.                                                                                                                                                                                                                                                                     |
| 2   | `hba1c`  | **Order HbA1c**<br>No recent HbA1c (every 3 months)<br>Accepted evidence (codes the engine treats as fulfilling this item): 4548-4, 17856-6, 4549-2, 62388-4, 59261-8<br>Also covered by an uncoded plan item whose quote names: hba1c, hb a1c, a1c, hemoglobina glicosilada, hemoglobina glucosilada, hemoglobina glicada, glycated hemoglobin, hemoglobin a1c                                                                                               | Every 90 days.  | Due 90 days after the last qualifying visit or result; without one yet, 90 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened.   | **Standards of Care in Diabetes—2025, Section 6: Glycemic Goals and Hypoglycemia** — “Recommends regular A1C testing to track glycemic control, done more often (for example every 3 months) when the patient is not at target or after a treatment change, and at least twice a year otherwise.” (paraphrase, not a quote — to be confirmed by the physician) |
| 3   | `lipids` | **Order a lipid panel**<br>Yearly lipid panel due<br>Accepted evidence (codes the engine treats as fulfilling this item): 24331-1, 57698-3, 57696-7, 2093-3, 2085-9, 13457-7, 18262-6, 2089-1, 2571-8<br>Also covered by an uncoded plan item whose quote names: perfil lipidico, lipidograma, lipidos, colesterol, trigliceridos, lipid panel<br>Shares this test with: Dyslipidemia follow-up (`lipids`). One test, one expectation — see Exceptions below. | Every 365 days. | Due 365 days after the last qualifying visit or result; without one yet, 365 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened. | **Standards of Care in Diabetes—2025, Section 10: Cardiovascular Disease and Risk Management** — “Recommends an annual lipid profile for adults with diabetes as part of cardiovascular risk assessment, more often when risk or treatment changes call for it.” (paraphrase, not a quote — to be confirmed by the physician)                                  |
| 4   | `fundus` | **Refer to ophthalmology for a fundus exam**<br>Yearly eye fundus exam due<br>Also covered by an uncoded plan item whose quote names: fondo de ojo, oftalmologia, oftalmologo, retinografia, fundus                                                                                                                                                                                                                                                           | Every 365 days. | Due 365 days after the last qualifying visit or result; without one yet, 365 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened. | **Standards of Care in Diabetes—2025, Section 12: Retinopathy, Neuropathy, and Foot Care** — “Recommends an initial dilated eye exam at diagnosis and annually after, with longer intervals possible after one or more normal exams at the treating clinician's judgment.” (paraphrase, not a quote — to be confirmed by the physician)                        |

## Exceptions and suppressions

### Already covered by the doctor's plan or an open order

If a live doctor's-plan or universal-layer expectation already asks for the same test (the same code, a code of the item's equivalence group, or an uncoded plan item whose quote names the test — see `planTerms` below), the protocol never adds a second one: the doctor's plan always wins.

### Shared with another protocol, due no later

One test, one expectation: when another protocol the clinic also runs expects the same test (same code or an equivalent one) no later than this item, only the one due first is kept.

### Not declared for this protocol

- No episode closing (pregnancy-style): this protocol is chronic, not episodic. It never ends on an outcome diagnosis, and nothing like the postpartum visit applies.
- No discharge closing: a note that discharges the patient from another protocol (treatment follow-up) does not end this one. There is no condition this protocol's own notes discharge from.
- Not sensitive: the condition this protocol tracks can be named in its reasons, suggested actions and patient-contact purpose (unlike treatment follow-up's mental-health masking).
- No repeated-result confirmation window (unlike chronic kidney disease, which needs two qualifying results at least 90 days apart): one qualifying result or diagnosis enrolls the patient.
- No active-treatment-only gate (unlike treatment follow-up): a diagnosis alone, without an active prescription, is enough to enroll.

## Sign-off

One row per point above. A point not approved keeps running as written until a new version of the config file changes it — this page does not change behavior by itself.

| Item                                                | Approve   | Needs changes   | Comment |
| --------------------------------------------------- | --------- | --------------- | ------- |
| `visit` — Schedule a diabetes visit                 | ☐ Approve | ☐ Needs changes |         |
| `hba1c` — Order HbA1c                               | ☐ Approve | ☐ Needs changes |         |
| `lipids` — Order a lipid panel                      | ☐ Approve | ☐ Needs changes |         |
| `fundus` — Refer to ophthalmology for a fundus exam | ☐ Approve | ☐ Needs changes |         |

**Overall protocol decision:** ☐ Approve ☐ Needs changes

**Physician name:**

**Date:**

**Signature:**

## Appendix: point → test

Generated from `tests.ts`; `generate.test.ts` fails if a title below is not the exact name of a test in the file it cites.

| Item     | Reason code                | Fires (correct due date)                                                                                                                                                                                                      | Suppressed by                                                                                                                                                                                                                         |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit`  | `protocol_diabetes_visit`  | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_visit fires 180 days after enrollment, then 180 days after the next visit  | —                                                                                                                                                                                                                                     |
| `hba1c`  | `protocol_diabetes_hba1c`  | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_hba1c fires 90 days after enrollment, then 90 days after the last HbA1c    | covered_by_plan: `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed exception suppresses the item › protocol_diabetes_hba1c covered_by_plan: an open HbA1c order suppresses the protocol item      |
| `lipids` | `protocol_diabetes_lipids` | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_lipids fires 365 days after enrollment, then 365 days after the last panel | covered_by_protocol: `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed exception suppresses the item › protocol_diabetes_lipids covered_by_protocol: dyslipidemia expects the same panel no later |
| `fundus` | `protocol_diabetes_fundus` | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_fundus fires 365 days after enrollment, then 365 days after the eye exam   | —                                                                                                                                                                                                                                     |
