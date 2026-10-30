# Hypertension follow-up — clinical sign-off package

**Status:** Ready for sign-off — not yet validated by the clinic’s clinical team

**Protocol id:** `hypertension` · **Version:** `1.1.1`

This page is generated from `config/protocols/hypertension.json` (and, for a shared test, from the other protocol file named below) plus the engine’s reason-and-action catalog (`apps/api/src/i18n`). Regenerate it with `pnpm protocols:signoff` after changing either; `pnpm test` fails if a committed page no longer matches a fresh generation. Nothing on this page is free text: every number, code and citation below is read back from config, so it cannot say something the engine does not do.

## To answer first

These points have no specific guideline section cited (see Guidelines cited below): the physician confirms these before anything else.

- `visit` — Schedule a hypertension visit
- `labs` — Order creatinine and potassium

## Guidelines cited

- 2023 ESH Guidelines for the management of arterial hypertension — European Society of Hypertension (2023). <https://doi.org/10.1097/HJH.0000000000003480>
- Guideline for the pharmacological treatment of hypertension in adults — World Health Organization (2021). <https://www.who.int/publications/i/item/9789240033986>

## Who this protocol applies to

- An ICD-10 diagnosis of I10, I11, I12, I13, I15 (or a more specific code under one of them, for example I10.9) at a confirmed diagnosis, or one the record only makes probable.
- A prescription matching: losartan, enalapril, amlodipin, valsartan, hydrochlorothiazide, hidroclorotiazida, captopril, lisinopril, irbesartan, telmisartan, candesartan, nifedipin, chlorthalidone, clortalidona — read as I10 when the record has no coded diagnosis.

## What is expected, and how often

| #   | Item    | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                    | How often       | Due date rule                                                                                                                                                                                                                                                           | Guideline                                                                                  |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `visit` | **Schedule a hypertension visit**<br>No hypertension visit in 6 months                                                                                                                                                                                                                                                                                                                                                                                      | Every 180 days. | Due 180 days after the last qualifying visit or result; without one yet, 180 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened. | Not itemized for this point — see Guidelines cited above; physician to confirm it applies. |
| 2   | `labs`  | **Order creatinine and potassium**<br>Yearly labs due (creatinine, potassium)<br>Accepted evidence (codes the engine treats as fulfilling this item): 2160-0, 2823-3<br>Also covered by an uncoded plan item whose quote names: creatinina, potasio, funcion renal, quimica sanguinea, electrolitos, creatinine, potassium<br>Shares this test with: Chronic kidney disease follow-up (`renal_function`). One test, one expectation — see Exceptions below. | Every 365 days. | Due 365 days after the last qualifying visit or result; without one yet, 365 days after the patient enrolled in the protocol. A booking fulfills the open expectation but never anchors the next one: the next item still counts from something that actually happened. | Not itemized for this point — see Guidelines cited above; physician to confirm it applies. |

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

| Item                                    | Approve   | Needs changes   | Comment |
| --------------------------------------- | --------- | --------------- | ------- |
| `visit` — Schedule a hypertension visit | ☐ Approve | ☐ Needs changes |         |
| `labs` — Order creatinine and potassium | ☐ Approve | ☐ Needs changes |         |

**Overall protocol decision:** ☐ Approve ☐ Needs changes

**Physician name:**

**Date:**

**Signature:**

## Appendix: point → test

Generated from `tests.ts`; `generate.test.ts` fails if a title below is not the exact name of a test in the file it cites.

| Item    | Reason code                   | Fires (correct due date)                                                                                                                                                                                                             | Suppressed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit` | `protocol_hypertension_visit` | `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed point fires, due the day the config says › protocol_hypertension_visit fires 180 days after enrollment, then 180 days after the next visit | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `labs`  | `protocol_hypertension_labs`  | `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed point fires, due the day the config says › protocol_hypertension_labs fires 365 days after enrollment, then 365 days after the last result | covered_by_plan: `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed exception suppresses the item › protocol_hypertension_labs covered_by_plan: an open creatinine order suppresses the protocol item<br>covered_by_protocol: `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed exception suppresses the item › protocol_hypertension_labs covered_by_protocol: chronic kidney disease expects creatinine no later |
