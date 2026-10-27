# @follow-up-engine/testkit

Contract test suites every adapter must pass, the synthetic demo clinic, the extraction gold set and the PRD acceptance scenarios. Test-only: production code never imports it (`pnpm boundaries` enforces it).

> **Synthetic data — no real patients.** Every patient, clinician, note, result and appointment in this package is fictional and generated or hand-written for testing. Names are random combinations of common Latin American given names and surnames; "Clínica Demo Hipócrates" is not a real clinic. No real clinical data is stored, used or committed here.

## What is inside

| Path                                     | What                                                                                                      | Count                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| `fixtures/clinic/clinic.json`            | Clinic directory: `Organization` `clinic-demo`, 8 `Practitioner`s + `PractitionerRole`s, generation stats | 1                           |
| `fixtures/clinic/patients/pat-NNNN.json` | One patient's history: chronological FHIR R4 transaction Bundles with timestamps                          | 148 patients, 2,268 bundles |
| `fixtures/gold-notes/gold-NNN.json`      | Hand-labeled Spanish notes for the extraction evals                                                       | 84 (15 to 27 per specialty) |
| `fixtures/scenarios/<name>.json`         | PRD acceptance cases, replayable with a fake clock and fake LLM                                           | 9                           |
| `fhir/fhir.schema.json.gz`               | Official FHIR R4 4.0.1 JSON Schema, unmodified, gzipped                                                   | 1                           |

Synthetic clinic: 35 diabetology, 43 internal medicine, 35 psychology, 35 gynecology patients; two years of history ending at `BASE_DATE` (2026-01-05T12:00:00Z); 867 consultations (23% of notes without a plan), 648 result bundles, 651 bookings, 17 cancellations, 2 diagnoses entered outside a visit. Patterns: adherent chronic patients (with the yearly ophthalmology referral for the fundus exam, coded `fundus-exam` in the engine's procedure CodeSystem), dropouts (some cancel their booking), lab orders never resulted and re-ordered, abnormal results with or without a recall visit, short treatments with or without a control, weekly/biweekly/monthly psychotherapy that ends in discharge or stops, annual gynecology controls, pregnancies with or without the 6-week postpartum control. Allergy status (HIP-139): 83 patients have an `AllergyIntolerance` recorded at intake, in a bundle of its own (`<patient>-allergy01`, kind `allergy`) sent two minutes after their first consultation: 69 "no known allergy" (SNOMED CT 716186003), 14 a drug allergy (penicillin, sulfonamides or NSAIDs, with the reaction); the other 65 have none (internal medicine and diabetology record it 80 % of the time, gynecology 60 %, psychology 30 %). It comes from a generator forked per patient, so every other bundle stayed byte-identical.

Protocol patients (`pat-0121` to `pat-0148`, appended after the original 120, which stay byte-identical: each patient comes from its own forked generator). Each pattern has fixed variants, picked by the patient's position in the pattern:

| Pattern               | Patients  | Variants (protocol item exercised)                                                                                                                                                                                                                                                                        |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pregnancy_ongoing`   | 0121–0125 | 29-31 weeks, OGTT never ordered (glucose tolerance overdue); 30-32 weeks, OGTT done at 24-27; 12-14 weeks with no Z34 code, enrolled and dated by the ultrasound's EDD; 34-35 weeks, stopped coming after week 30 (prenatal visit overdue); 21-23 weeks dated only by the note ("embarazo de 22 semanas") |
| `pregnancy_delivered` | 0126–0128 | Puerperal visit at 7-12 days coding O80.9 + Z39.2 ("parto vaginal el dd/mm/aaaa"), then the 6-week control; cesarean O82.9 on the problem list 2 months ago, no puerperal visit (postpartum visit overdue); delivery O80.9 on the problem list last week, 6-week control booked                           |
| `pregnancy_loss`      | 0129–0130 | Miscarriage O03.9 at 8-10 weeks and a post-loss control (nothing prenatal expected after it); miscarriage a year ago, no control, pregnant again at 15-17 weeks (a new episode)                                                                                                                           |
| `ssri_stable`         | 0131–0132 | Psychotherapy plus an internist (`prac-im-0N`, `internal_medicine` encounters) who starts sertraline 50 mg / escitalopram 10 mg: controls at 4 weeks, monthly until 3 without a change, then every 3 months                                                                                               |
| `ssri_dose_change`    | 0133–0135 | Sertraline 50 → 100 mg at 4 weeks ("Se aumenta sertralina a 100 mg/día, control en 3 semanas"), controls kept; same change, then the patient stops coming (control after the change overdue); escitalopram 10 → 20 mg 2 weeks ago, control booked                                                         |
| `hypothyroidism`      | 0136–0139 | E03.9 + levothyroxine 50 → 75 mcg with the TSH 6-8 weeks after each change, yearly since; raised to 75 mcg 4 months ago, no TSH since; TSH taken 3 weeks after the change (too soon to count); stable on 50 mcg, yearly control and TSH overdue                                                           |
| `dyslipidemia_statin` | 0140–0142 | E78.0 + atorvastatin 20 mg, lipid panel at 8 weeks, yearly since; E78.5 + rosuvastatin 10 mg 4 months ago, no panel; atorvastatin 20 → 40 mg with a panel 10 weeks after the change                                                                                                                       |
| `ckd_g3`              | 0143–0144 | N18.3, G3a A2 every 6 months on track; N18.3, G3b A2 every 4 months, stopped coming (labs and visit overdue)                                                                                                                                                                                              |
| `ckd_g4`              | 0145–0146 | N18.4, G4 A3 every 3 months on track; N18.4, G4 A2, stopped coming 5 months ago                                                                                                                                                                                                                           |
| `ckd_uncoded`         | 0147–0148 | Hypertensive, never coded N18: eGFR below 60 on 6-monthly labs (enrolled by eGFR); normal eGFR, urine albumin/creatinine 30 mg/g or more twice (enrolled by albuminuria)                                                                                                                                  |

Labs of these patients mostly arrive from an outside lab a few days before the visit that reviews them (`DiagnosticReport` without `basedOn`): eGFR LOINC 62238-1 (CKD-EPI 2021, consistent with the creatinine, age and sex), urine albumin/creatinine 9318-7, TSH 3016-3, lipid panel 57698-3; the OGTT (1558-6 + 1518-0) is ordered and linked.

## API

```ts
import {
  BASE_DATE,
  dayToDate,
  DEMO_CLINIC_ID,
  RULE_IDS,
  ALL_RULE_IDS,
  SPECIALTIES,
  SYSTEMS,
  validateFhirR4,
  assertValidFhirR4,
  loadGoldNotes,
  loadScenarios,
  loadSyntheticClinic,
  generateSyntheticClinic,
  noteTextOf,
  describeExpectationRepositoryContract,
  describeCaseRepositoryContract,
  describeClinicalRecordRepositoryContract,
  describeFeedbackRepositoryContract,
  describeConditionRepositoryContract,
  describeQualityFindingRepositoryContract,
  describeAuditLogContract,
  describeJobQueueContract,
  describeOutboxContract,
  describeUnitOfWorkContract,
  describeClinicDirectoryContract,
  describeLlmUsageLogContract,
  describeBackfillProgressStoreContract,
  describeClockContract,
  contractBuilders,
} from '@follow-up-engine/testkit';
```

- `validateFhirR4(resource)` → `{ valid, resourceType?, issues: { path, message }[] }`. Validates any R4 resource, and a Bundle entry by entry (readable paths such as `/entry/2/resource/status`), against the official schema with Ajv. Structural only: types, cardinality, primitive formats, enum bindings, unknown properties; no terminology or FHIRPath invariants. `assertValidFhirR4` throws instead.
- `loadGoldNotes()`, `loadScenarios()`, `loadSyntheticClinic()` read and validate the committed fixtures.
- `RULE_IDS` holds every rule id the scenarios use: `lab_order_result_pending`, `imaging_order_result_pending`, `short_treatment_followup`, `abnormal_result_followup`, `cadence_break`, `doctor_plan_followup`, `protocol_diabetes_visit`, `protocol_diabetes_hba1c`, `protocol_diabetes_lipids`, `protocol_diabetes_fundus`, `protocol_hypertension_visit`, `protocol_hypertension_labs`.

### Contract suites

Register a suite from the adapter's own test file. `makeSubject` runs before every test; `cleanup` after it.

```ts
describeExpectationRepositoryContract('postgres', async () => {
  const pool = await createTestPool();
  return { subject: new PgExpectationRepository(pool), cleanup: () => pool.end() };
});
describeOutboxContract('memory', async () => {
  const outbox = new MemoryOutbox();
  return {
    subject: outbox,
    pending: (clinicId) => outbox.pending(clinicId),
    cleanup: async () => {},
  };
});
describeClinicDirectoryContract('memory', async (seed) => ({
  subject: new MemoryClinicDirectory(seed),
  cleanup: async () => {},
}));
```

Every suite checks clinic isolation (nothing of clinic A is visible or writable from clinic B, and writing an entity of another clinic rejects with `TenantMismatchError`). Others: idempotent upsert, `findDue` ordering and limit, a single active case per `dedupKey`, cursor paging, job leases (expiry, reclaim with a new token, `lease_lost` for the stale holder, retry at `retryAt`, dead letter after `maxAttempts`, dedup per clinic while the first job is unfinished), backfill runs (one unfinished run per clinic, cursor and counters, budget pause and resume), and `UnitOfWork` rollback leaving no partial writes in any store, jobs and outbox included. Each test uses fresh random clinic ids and job types, so suites also run against a persistent database that is not truncated. Ports must reject, not throw synchronously. Every port type comes from `@follow-up-engine/core`; `packages/acceptance` runs every suite against `adapter-memory` and `adapter-postgres`.

## Fixture formats

### Synthetic patient (`fixtures/clinic/patients/*.json`)

```json
{
  "clinicId": "clinic-demo",
  "patientId": "pat-0001",
  "name": "…",
  "gender": "female",
  "birthDate": "1965-03-02",
  "specialty": "diabetology",
  "pattern": "adherent",
  "entries": [
    {
      "at": "2024-02-01T14:30:00.000Z",
      "kind": "consultation",
      "bundle": { "resourceType": "Bundle", "type": "transaction", "entry": [] }
    }
  ]
}
```

`kind` ∈ `consultation | result | appointment_booked | appointment_cancelled | diagnosis`. `pattern` is for demos and debugging only; the engine must not read it.

FHIR conventions (the `fhir` package maps these):

- Every bundle is a `transaction` with `PUT Type/id` entries and deterministic `urn:uuid` full URLs. References are relative (`Patient/pat-0001`).
- Consultation: `Encounter` (`finished`, class `AMB` or `VR`, `serviceType` coded in `https://hipocratesalud.com/fhir/CodeSystem/specialty` (the engine's base, shared with `@follow-up-engine/fhir`) with `diabetology | internal_medicine | psychology | gynecology`, `appointment` when it fulfils a booking) + `DocumentReference` (LOINC 11506-3, note as base64 `text/plain; charset=utf-8`, `context.encounter`) + `ServiceRequest`s (LOINC; category SNOMED 108252007 laboratory or 363679005 imaging) + `MedicationRequest`s (ATC) + `Condition`s (ICD-10 `http://hl7.org/fhir/sid/icd-10`, encounter diagnoses). The `Patient` is in the first consultation only. A patient's encounters are with their specialty's practitioner, except the internist consults of the psychology patients on an antidepressant (`serviceType` `internal_medicine`).
- First prenatal visit: also `Observation`s (category `exam`, `valueDateTime` `YYYY-MM-DD`) of the last menstrual period (LOINC 8665-2) and the estimated delivery date (11778-8). A dating ultrasound report carries the estimated delivery date the same way.
- Diagnosis (`kind: diagnosis`): a `Condition` entered outside a visit (category `problem-list-item`, no `encounter`, `onsetDateTime` when it happened, `recordedDate` when it was entered): the delivery a hospital reported.
- Short treatments, and only them, carry `MedicationRequest.dispenseRequest.expectedSupplyDuration` (UCUM `d`).
- Result: `DiagnosticReport` (`basedOn` the order when the host links it; category LAB or RAD) + `Observation`s with `interpretation` `H | L | N` (v3-ObservationInterpretation). Imaging reports carry `conclusion` and `conclusionCode` (SNOMED 17621005 normal / 263654008 abnormal).
- Booking: `Appointment` `booked` with `created` = when it was booked; a cancellation re-sends the same `Appointment` as `cancelled`.

### Gold notes (`fixtures/gold-notes/*.json`)

Exactly the shared brief's format (`id`, `specialty`, `authoredAt`, `text`, `expected.{hasPlan, conditions[{icd10, evidenceQuote}], medications[{text, evidenceQuote}], planItems[{kind, dueInDays, evidenceQuote}]}`), plus optional `expected.discharge` (`{evidenceQuote}`) and `expected.pregnancy` (`{gestationalWeeks?, gestationalDays?, lastMenstrualPeriod?, estimatedDeliveryDate?, datingEvidenceQuote?, outcome?: {kind, date?, daysAgo?, evidenceQuote}}`). Every `evidenceQuote` is an exact substring of `text` (tested). Labeling rules:

- `hasPlan`: the note says what happens next (control, session, tests, treatment, discharge). Notes that end at the diagnosis or only say "se explica condición" have none.
- `conditions`: diagnoses of this patient (Dx, impresión, known chronic conditions), ICD-10 at category level; compared by the first 3 characters. Family history and symptoms that are not a diagnosis are excluded.
- `medications`: drugs prescribed or continued, as written; suspended drugs are excluded.
- `planItems`: only follow-ups with a timeframe, one per dated instruction. Months are 30 days, weeks 7; absolute dates (`dd/mm/yyyy`) count from `authoredAt` (tested). A named test attached to a dated control ("ctrl en 3 meses con HbA1c") is a separate `lab` item with the same due date; generic "con resultados" is not. Orders placed today without a timeframe are not plan items (the universal rules cover the `ServiceRequest`). Kinds: `follow_up_visit`, `session` (psychotherapy), `lab`, `imaging`, `other` (referrals, procedures, specialist controls).

- `pregnancy`: only a current pregnancy, or one this note reports ended. Dating as written (weeks, `dd/mm/yyyy` dates as `YYYY-MM-DD`), never computed; an outcome (`vaginal_delivery`, `cesarean_delivery`, `loss`) with `date` or `daysAgo` only when the note writes them, and no dating in the same note. Obstetric history ("G3P2", "cesárea previa") and a routine FUM in a control are not labeled: they are the traps.

Set: 84 notes (19 diabetology, 27 internal medicine, 15 psychology, 23 gynecology), 12 without a plan, 28 with two or more plan items, relative dates in days, weeks and months, 5 absolute dates, 9 with a pregnancy label (5 dated, 4 outcomes of every kind) and 3 traps with a FUM or obstetric history and no label (034, 082, 083). Psychology notes are clinical and neutral (no crisis content).

### Scenarios (`fixtures/scenarios/*.json`)

The shared brief's format plus `specialty`. Every bundle of `day: d` is stamped at exactly `BASE_DATE + d`, so due dates are whole days. `llmFixture` maps every `DocumentReference` id to the `NoteExtraction` the fake LLM must return (`dueAt` resolved against the note's `authoredAt`; `model: "fixture"`, `costUsd: 0`).

A checkpoint describes the scenario patient's state at `BASE_DATE + day`, after ingesting every step with `step.day <= day` and running the watcher:

- `openExpectations` + `absentRuleIds`: for every rule id named in either, the open expectations of that rule are exactly the listed ones. Rules not named are unconstrained, so adding protocol items does not break old scenarios. `matchKey` (`<system-short>:<code>`, e.g. `loinc:4548-4`) and `dueDay` are compared only when present.
- `activeCases`: exact number of active cases; each case's reasons must include the listed rule ids.
- `resolvedCases`, `closedExpectations`: must be present.
- `qualityFindings`: exact list of finding kinds.

Rules the expected outcomes follow: lab result 15 days, imaging 30, short treatment end + 3, abnormal result 7, cadence 3x the usual interval once there are 2 visits, diabetes protocol visit every 180 days and HbA1c every 90 (from the last HbA1c result, or enrollment), the doctor's plan beats the protocol **and the cadence** for the need it covers, a newer order of the same test supersedes the old expectation (a different test does not), a booked appointment resolves a visit case as `fulfilled`, and one active case per patient merges every expired expectation regardless of layer. Annual protocol items (`protocol_diabetes_lipids`, `protocol_diabetes_fundus`) are assumed to be yearly and are never asserted.

| Scenario                              | Checks                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `diabetic_6_months_no_plan`           | No-plan note → quality finding; HbA1c results restart the HbA1c protocol; visit protocol case at day 180 |
| `diabetic_single_visit_plan_3_months` | Plan covers visit and HbA1c → no protocol expectations; one case at day 90                               |
| `lab_order_repeated_same_test`        | Re-ordered HbA1c supersedes the first; case only after day 25                                            |
| `lab_order_repeated_different_test`   | TSH + lipid panel both open; one merged case                                                             |
| `psychology_monthly_dropout`          | Cadence 120 then 150 days; case at day 150                                                               |
| `short_treatment_no_followup`         | 7-day antibiotic → case at day 10                                                                        |
| `gynecology_postpartum_6_weeks`       | Plan "control puerperal en 6 semanas" → case at day 42                                                   |
| `postpartum_booked_resolves`          | Booking on day 45 resolves the case as fulfilled                                                         |
| `three_layers_one_case`               | Universal (short treatment), doctor plan and protocol (HbA1c) expire into one follow-up case             |

## Regenerating

```sh
pnpm --filter @follow-up-engine/testkit generate
```

Rebuilds `fixtures/clinic` and `fixtures/scenarios` from `src/synthetic` and `src/scenarios` (seeded PRNG, no network) and formats them with Prettier. Tests fail if the committed fixtures drift from the generators. Gold notes are hand-written and not touched.

The FHIR schema was downloaded from <https://hl7.org/fhir/R4/fhir.schema.json.zip>; the SHA-256 of the uncompressed file is pinned in `src/fhir/validate.ts` and checked by a test. The file names itself with the draft-04 `id` keyword, which the validator maps to `$id` at load time; nothing else is changed.
