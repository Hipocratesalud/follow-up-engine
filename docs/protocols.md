# Care protocols

A protocol is a versioned JSON file in [`config/protocols/`](../config/protocols) that turns a condition into a cadence of expectations ("a TSH 6 to 8 weeks after the dose changed"). Protocols are the last layer of the engine: they only fill what the doctor's plan, the universal rules and the visit cadence did not already ask for. This page is the reference for clinicians and for the clinical team that validates them (Clinical team guide, point 2).

**Every protocol is a draft.** None has been validated by a clinical team yet. A draft protocol runs only for a clinic that enables it, and the inbox marks each of its reasons with "Draft protocol · pending clinical validation" ("Protocolo en borrador · pendiente de validación clínica" in Spanish).

| Protocol                                                                    | Id                       | Version | Status | On by default |
| --------------------------------------------------------------------------- | ------------------------ | ------- | ------ | ------------- |
| [Diabetes](#diabetes)                                                       | `diabetes`               | 1.2.1   | draft  | yes (legacy)  |
| [Hypertension](#hypertension)                                               | `hypertension`           | 1.1.1   | draft  | yes (legacy)  |
| [Pregnancy and postpartum](#pregnancy-and-postpartum)                       | `pregnancy`              | 0.1.0   | draft  | no            |
| [Depression and anxiety on treatment](#depression-and-anxiety-on-treatment) | `treatment_followup`     | 0.2.0   | draft  | no            |
| [Hypothyroidism](#hypothyroidism)                                           | `hypothyroidism`         | 0.1.0   | draft  | no            |
| [Dyslipidemia](#dyslipidemia)                                               | `dyslipidemia`           | 0.1.0   | draft  | no            |
| [Chronic kidney disease](#chronic-kidney-disease)                           | `chronic_kidney_disease` | 0.1.0   | draft  | no            |

## How a clinic enables a protocol

1. The clinic's clinical team reviews the protocol on this page (criteria, intervals, sources, open questions) and answers the open questions, or asks for changes. A change is a new `version` of the JSON file; every expectation records the `protocolId` and `protocolVersion` that created it.
2. The clinic lists the ids it runs in its settings, `ClinicSettings.enabledProtocols`:

   ```json
   { "enabledProtocols": ["diabetes", "hypertension", "pregnancy", "hypothyroidism"] }
   ```

   Stored in `clinics.settings` (Postgres `jsonb`, no migration), set with `runtime.registerClinic({ ..., settings })` or `pnpm --filter @follow-up-engine/api clinic:create`. Absent, the clinic runs `diabetes` and `hypertension`, the two protocols that ran before protocols needed opting in, so existing clinics keep their behavior. The synthetic demo clinic enables every protocol.

3. Once a clinical team signs a protocol off, its `status` becomes `validated` and the inbox badge goes away. Enabling it is still a per-clinic decision.

A protocol that is disabled later stops creating expectations for that clinic.

## What every protocol does, and never does

- **Fills gaps only.** An item is skipped when a live doctor's-plan or universal expectation asks for the same thing (same code, a code of the item's equivalence group, or an uncoded plan item whose quote names the test: `planTerms`), and a later order or plan item withdraws it (`covered_by_later_request`). The doctor's plan always beats the protocol.
- **One test, one expectation.** When two protocols expect the same test (a diabetic on a statin: the diabetes yearly lipid panel and the dyslipidemia post-start panel), the one due first is kept and the other is skipped or superseded (`rescheduled_by_protocol`).
- **Counts from what happened.** An item is due a number of days after the last visit or result that fulfills it, or after enrollment. A booking fulfills a visit item while it stands but never anchors the next one.
- **Results under any equivalent code.** LOINC equivalence groups (`packages/core/src/engine/terminology/loinc.ts`): every HbA1c method, every lipid panel and its components, every eGFR equation (MDRD, CKD-EPI 2009 and 2021), creatinine in mg/dL or µmol/L, urine albumin/creatinine ratio in mg/g or mg/mmol, TSH in mIU/L or µIU/mL, gestational age in weeks or days.
- **A start is a start only when the record says so.** Titration items (a control after an antidepressant, levothyroxine or a statin is started or its dose changes) need to know when a drug started. A dose different from the drug's previous prescription is always a change. The first prescription of a drug is a start when the note's sentence that names it says so ("se inicia", "se indica", "se agrega", "nuevo", "started", "initiate") or the dosage does, or when the record had already seen the patient at an earlier consultation without it and nothing says it was in course. A drug first seen at the first consultation the record has (the initial backfill of a patient's history, or a new patient's first visit), or whose sentence says the patient already takes it ("en tto con", "toma", "continuar", "mantiene"), is a treatment in course: its item counts from the last time it happened or from enrollment, never 4 to 12 weeks after a start that is years old. The phrases are in `packages/core/src/engine/protocols/treatment-changes.ts`. FHIR R4 has no field that says a prescription starts a therapy (`intent` is about authority, `courseOfTherapyType` is continuous, acute or seasonal), so the engine reads the note.
- **Due at the end of the guideline's window.** "TSH 6 to 8 weeks after a change" is due at 8 weeks: the engine flags what is late, never what is early. Where a guideline gives a range of months (TSH every 6 to 12 months), the protocol uses its upper bound.
- **Never advice to patients.** A protocol produces reasons for the clinic team and, when the clinic allows it, a request to contact the patient with a generic purpose (`schedule_follow_up`, `complete_pending_test`): never a diagnosis, a test name or free text.
- **Never on its own.** Nothing runs for a clinic that did not enable it.

## Diabetes

- **Enrollment:** ICD-10 E10, E11, E13, E14 (confirmed or probable); an antidiabetic drug (metformin, insulin, sulfonylureas, DPP-4, SGLT2, GLP-1, pioglitazone) or an HbA1c of 6.5 % or more (48 mmol/mol) without a coded diagnosis.
- **Items:** a control visit every 6 months (diabetology, endocrinology, internal medicine, general or family practice); HbA1c every 3 months; lipid panel yearly; fundus exam yearly (an ophthalmology visit counts).
- **Source:** Standards of Care in Diabetes 2025, American Diabetes Association.
- **Open questions:** HbA1c every 6 months for patients at target (ADA allows it)? Is a yearly fundus exam right for patients with two normal exams (ADA allows every 1 to 2 years)?

## Hypertension

- **Enrollment:** ICD-10 I10 to I13, I15; an antihypertensive drug without a coded diagnosis.
- **Items:** a control visit every 6 months; creatinine and potassium yearly.
- **Sources:** 2023 ESH Guidelines for the management of arterial hypertension; WHO Guideline for the pharmacological treatment of hypertension in adults (2021).
- **Open questions:** monthly visits until blood pressure is controlled after a start or change (WHO 2021)? That needs blood pressure readings, which the engine does not receive today.

## Pregnancy and postpartum

- **Enrollment:** ICD-10 Z33, Z34, Z35, ICD-10-CM Z3A, O09 to O48 (confirmed or probable); an obstetric ultrasound (LOINC 11525-3), an estimated delivery date (11778-8) or a gestational age (11884-4) in the record.
- **Gestational age** (`packages/core/src/engine/protocols/gestational-age.ts`): from the latest dating fact of the current pregnancy: an estimated delivery date, a last menstrual period (Naegele: delivery 280 days later), a gestational age at a date (an Observation, or "embarazo de 20 semanas", "G2P1, 20 sem", "FUM 03/04/2026", "FPP 10/01/2027" read from the note), or an ICD-10-CM Z3A.xx code. The clinician's latest estimate wins (an ultrasound that corrects the dates replaces the LMP). Implausible values are ignored.
- **Items:**
  - Prenatal visit: every 4 weeks up to week 28, every 2 weeks up to 36, weekly after (the interval depends on the gestational age at the last visit), never due past week 42; every 4 weeks when the pregnancy is not dated. Gynecology, obstetrics, general or family practice.
  - Oral glucose tolerance test (LOINC 1504-0, 1518-0, 20436-2): expected once week 24 is reached, due at week 28; only a test done from week 24 counts. Never expected for an undated pregnancy.
  - Postpartum visit: within 6 weeks (42 days) of a delivery. A puerperal visit that records the outcome (Z39 postpartum care, O85 to O92) is itself that visit.
- **Closing:** the episode ends on a delivery (O80 to O84, Z37; Z39 and O85 to O92 recorded at a puerperal visit; or "parto vaginal el 02/03", "cesárea hace 10 días" read from a note, dated when it happened) or a loss (O00 to O08, O36.4; "aborto espontáneo" read from a note). At that point the pregnancy condition is resolved, every live prenatal expectation is cancelled (`protocol_closed`, before anything else, so the delivery's own encounter is never read as a prenatal visit), and only the postpartum visit is expected after a delivery. Only a pregnancy diagnosis recorded after the end, in another consultation, starts a new episode.
- **Sources:** Guidelines for Perinatal Care, 8th edition, AAP and ACOG (2017); WHO recommendations on antenatal care for a positive pregnancy experience (2016); USPSTF Gestational Diabetes: Screening (2021); ACOG Committee Opinion 736, Optimizing Postpartum Care (2018).
- **Never:** a prenatal expectation after a delivery or a loss; a postpartum visit after a loss; a dating fact of a previous pregnancy.
- **Open questions:**
  1. The visit schedule is the classic one (AAP/ACOG). WHO 2016 recommends 8 contacts (12, 20, 26, 30, 34, 36, 38, 40 weeks). Which one does the clinic follow?
  2. Should a follow-up visit after a loss be expected (2 to 6 weeks)?
  3. A pregnancy past week 42 with no outcome recorded (delivered elsewhere?): today nothing more is expected. Should the clinic be told the outcome is missing?
  4. Is a glucose challenge done before week 24 (early screening for high-risk patients) enough, or is the 24 to 28 week test always expected?
  5. Confirm the LOINC list of the glucose tolerance test with the clinic's laboratory.
  6. A last menstrual period alone (8665-2) dates a pregnancy but does not enroll the patient, since gynecology records it for every woman. Agreed?
  7. The guideline URL of Guidelines for Perinatal Care could not be checked automatically (the publisher blocks robots).

## Depression and anxiety on treatment

The id `treatment_followup` and every label are deliberately neutral, in every language ("Treatment follow-up", "Follow-up visit due"; "Seguimiento de tratamiento", "Control de seguimiento pendiente"): the protocol is `sensitive`, so nothing it shows in the inbox or sends in a webhook or a patient contact request names the condition, the drug or the specialty, and its contact purpose is only `schedule_follow_up` (the schema refuses anything else).

- **Enrollment:** a patient on an active antidepressant, anxiolytic or hypnotic (ATC N06A, N05B, N05C, mapped from the drug name when the host sends free text; `enrollment.activeTreatment`) with ICD-10 F32, F33 or F41 (confirmed or probable); an antidepressant without a coded diagnosis enrolls as F32 (probable). **A diagnosis alone does not enroll**: a patient in psychotherapy with no prescription is followed by the doctor's plan ("próxima sesión en 1 semana") and, when they stop coming, by the visit cadence, which reports the dropout once. Active: not stopped or cancelled by the host and, when the prescription states its supply (`expectedSupplyDuration`, refills), not over yet. When the treatment ends, the protocol's live expectations are cancelled (`treatment_ended`).
- **Discharge** (`closesOnDischarge`): a visit of one of the protocol's specialties whose note discharges the patient ("se da de alta", "se cierra el proceso terapéutico", read by the note extraction) ends the episode. Its live expectations are cancelled (`patient_discharged`, the same reason the cadence layer uses) and nothing more is expected. A diagnosis of the protocol or a prescription of its drugs at a later consultation starts a new episode; its first prescription is read as a restart (the early control again).
- **Item:** a control visit 2 to 4 weeks (due at 28 days) after an antidepressant is started or its dose changes (a later prescription of the same drug whose dose differs, or another antidepressant), then monthly until 3 consecutive controls without a change, then every 3 months. A change sent without a control (a phone adjustment) replaces a later expectation with the 28-day one. Psychiatry, psychology, general or family practice, internal medicine: a psychotherapy session counts as the control. Without any antidepressant in the record, every 3 months after the last visit.
- **Sources:** NICE NG222 Depression in adults: treatment and management (2022); NICE CG113 Generalised anxiety disorder and panic disorder in adults (2011).
- **Never:** a reason, suggested action or contact purpose that reveals the condition.
- **Open questions:**
  1. NICE asks for a review within 1 week of starting an antidepressant for people under 25 or at risk of suicide. Should the protocol read age or risk?
  2. Should a psychotherapy session count as the medication control, or only a visit with the prescriber?
  3. Low-dose amitriptyline or trazodone for pain or sleep are N06A too: exclude them from enrollment?
  4. A drug already in course the first time the record sees the patient is not a start (no early control; the 3-month control counts from the last visit). Acceptable?
  5. Should stopping an antidepressant also restart the early control (discontinuation symptoms, relapse)?
  6. **Enrollment needs an active treatment** (decided for the draft, HIP-139). A coded F32/F41 with only psychotherapy is not enrolled: the doctor's plan and the visit cadence already follow those patients, and enrolling them added a second, 3-monthly reminder to every psychotherapy dropout. Should an explicit, active psychotherapy plan in the note enroll too (for example, a clinic without a reliable session cadence)?
  7. Anxiolytics and hypnotics (N05B, N05C) keep a patient with F32/F33/F41 in the protocol, but never enroll one without the diagnosis. Clonazepam is N03AE01 (an antiepileptic in ATC) and does not count: add it?
  8. A discharge from psychotherapy ends the protocol even when another clinician keeps prescribing the antidepressant; the next prescription starts a new episode. Should only the prescriber's discharge count?

## Hypothyroidism

- **Enrollment:** ICD-10 E03, E89.0; levothyroxine or liothyronine (ATC H03AA) without a coded diagnosis.
- **Items:** TSH (LOINC 3016-3, 11580-8, 11579-0) 6 to 8 weeks (due at 56 days) after levothyroxine is started or its dose changes; a TSH sooner than 6 weeks does not count (not at steady state yet), then yearly. A control visit yearly.
- **Sources:** American Thyroid Association Guidelines for the Treatment of Hypothyroidism (2014); NICE NG145 Thyroid disease: assessment and management (2019).
- **Open questions:** TSH every 6 or every 12 months once stable (the protocol flags at 12)? NICE asks for a TSH every 3 months until two similar results: adopt it? Pregnancy changes the targets: should a pregnant patient on levothyroxine get a TSH every 4 weeks?

## Dyslipidemia

- **Enrollment:** ICD-10 E78; a statin, ezetimibe or fibrate (ATC C10) without a coded diagnosis.
- **Item:** a lipid panel (any panel or component LOINC) 4 to 12 weeks (due at 84 days) after a lipid-lowering drug is started or its dose changes, not sooner than 4 weeks, then yearly. Shares the test with the diabetes protocol: one lipid panel is expected, the one due first.
- **Sources:** 2019 ESC/EAS Guidelines for the management of dyslipidaemias; 2018 AHA/ACC Guideline on the Management of Blood Cholesterol.
- **Open questions:** ALT and CK at the start of a statin (ESC 2019) are not expected today: add them? A yearly control visit as well?

## Chronic kidney disease

- **Enrollment:** ICD-10 N18 (confirmed or probable); or, without a coded diagnosis, an eGFR below 60 mL/min/1.73 m² (LOINC 33914-3, 48642-3, 48643-1, 62238-1, 77147-7, 88293-6, 88294-4, 98979-8) or a urine albumin/creatinine ratio of 30 mg/g or more (9318-7, 14959-1, 32294-1, 13705-9) on two results at least 90 days apart (inferred as N18.9, probable). One low result never enrolls.
- **Stage** (`packages/core/src/engine/protocols/kidney.ts`): the KDIGO GFR category of the latest eGFR (G1 ≥ 90, G2 60 to 89, G3a 45 to 59, G3b 30 to 44, G4 15 to 29, G5 < 15) and the albuminuria category of the latest ratio (A1 < 30, A2 30 to 300, A3 > 300 mg/g); without an eGFR, the category an N18 code states (N18.3 is read as G3a).
- **Items:** creatinine/eGFR and urine albumin/creatinine ratio as often as the KDIGO 2012 heat map asks for the stage: G1-G2 yearly (twice a year with A3), G3a yearly (A2 twice, A3 three times a year), G3b twice a year (A2-A3 three times), G4 three times a year (A3 four), G5 four times a year; twice a year when the stage is unknown. A control visit every 6 months up to G3a, every 4 months at G3b, every 3 months at G4-G5. The hypertension protocol's yearly creatinine and this one never both: the one due first wins.
- **Sources:** KDIGO 2012 Clinical Practice Guideline for the Evaluation and Management of CKD; KDIGO 2024 Clinical Practice Guideline for the Evaluation and Management of CKD.
- **Open questions:**
  1. Many laboratories report creatinine without an eGFR. Should the engine compute the eGFR (CKD-EPI 2021 needs age and sex, which the host sends)?
  2. With an unknown albuminuria the protocol uses the A1 row and expects the ratio: right?
  3. Referral to nephrology at G4 or A3 (KDIGO) is not expected today: add it as an item?
  4. Potassium is no longer asked for separately when the kidney protocol takes over the hypertension creatinine: acceptable?

## Where things are

| What                                                    | Where                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Protocol files                                          | `config/protocols/*.json`, validated by `ProtocolSchema`                            |
| Schema (schedules, closing, sources, status)            | `packages/core/src/config/protocol.ts`                                              |
| Protocol layer                                          | `packages/core/src/engine/annotator/layers/protocol.ts`                             |
| Schedules, episodes, gestational age, KDIGO, treatments | `packages/core/src/engine/protocols/`                                               |
| Enrollment (codes, drugs by ATC, repeated results)      | `packages/core/src/engine/annotator/conditions.ts`                                  |
| Pregnancy facts read from notes                         | `ExtractedPregnancy` in `packages/core/src/ports/note-extractor.ts`, `packages/llm` |
| Acceptance scenarios (memory and Postgres)              | `packages/acceptance/test/protocol-library.test.ts`                                 |
