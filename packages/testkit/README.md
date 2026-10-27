# @follow-up-engine/testkit

Contract test suites every adapter must pass, the synthetic demo clinic, the extraction gold set and the PRD acceptance scenarios. Test-only: production code never imports it (`pnpm boundaries` enforces it).

> **Synthetic data — no real patients.** Every patient, clinician, note, result and appointment in this package is fictional and generated or hand-written for testing. Names are random combinations of common Latin American given names and surnames; "Clínica Demo Hipócrates" is not a real clinic. No real clinical data is stored, used or committed here.

## What is inside

| Path                                     | What                                                                                                      | Count                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| `fixtures/clinic/clinic.json`            | Clinic directory: `Organization` `clinic-demo`, 8 `Practitioner`s + `PractitionerRole`s, generation stats | 1                           |
| `fixtures/clinic/patients/pat-NNNN.json` | One patient's history: chronological FHIR R4 transaction Bundles with timestamps                          | 120 patients, 1,647 bundles |
| `fixtures/gold-notes/gold-NNN.json`      | Hand-labeled Spanish notes for the extraction evals                                                       | 44 (11 per specialty)       |
| `fixtures/scenarios/<name>.json`         | PRD acceptance cases, replayable with a fake clock and fake LLM                                           | 9                           |
| `fhir/fhir.schema.json.gz`               | Official FHIR R4 4.0.1 JSON Schema, unmodified, gzipped                                                   | 1                           |

Synthetic clinic: 35 diabetology, 30 internal medicine / hypertension, 30 psychology, 25 gynecology patients; two years of history ending at `BASE_DATE` (2026-01-05T12:00:00Z); 668 consultations (26% of notes without a plan), 487 result bundles, 480 bookings, 12 cancellations. Patterns: adherent chronic patients, dropouts (some cancel their booking), lab orders never resulted and re-ordered, abnormal results with or without a recall visit, short treatments with or without a control, weekly/biweekly/monthly psychotherapy that ends in discharge or stops, annual gynecology controls, pregnancies with or without the 6-week postpartum control.

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

`kind` ∈ `consultation | result | appointment_booked | appointment_cancelled`. `pattern` is for demos and debugging only; the engine must not read it.

FHIR conventions (the `fhir` package maps these):

- Every bundle is a `transaction` with `PUT Type/id` entries and deterministic `urn:uuid` full URLs. References are relative (`Patient/pat-0001`).
- Consultation: `Encounter` (`finished`, class `AMB` or `VR`, `serviceType` coded in `https://hipocratesalud.com/fhir/CodeSystem/specialty` (the engine's base, shared with `@follow-up-engine/fhir`) with `diabetology | internal_medicine | psychology | gynecology`, `appointment` when it fulfils a booking) + `DocumentReference` (LOINC 11506-3, note as base64 `text/plain; charset=utf-8`, `context.encounter`) + `ServiceRequest`s (LOINC; category SNOMED 108252007 laboratory or 363679005 imaging) + `MedicationRequest`s (ATC) + `Condition`s (ICD-10 `http://hl7.org/fhir/sid/icd-10`, encounter diagnoses). The `Patient` is in the first consultation only.
- Short treatments, and only them, carry `MedicationRequest.dispenseRequest.expectedSupplyDuration` (UCUM `d`).
- Result: `DiagnosticReport` (`basedOn` the order when the host links it; category LAB or RAD) + `Observation`s with `interpretation` `H | L | N` (v3-ObservationInterpretation). Imaging reports carry `conclusion` and `conclusionCode` (SNOMED 17621005 normal / 263654008 abnormal).
- Booking: `Appointment` `booked` with `created` = when it was booked; a cancellation re-sends the same `Appointment` as `cancelled`.

### Gold notes (`fixtures/gold-notes/*.json`)

Exactly the shared brief's format (`id`, `specialty`, `authoredAt`, `text`, `expected.{hasPlan, conditions[{icd10, evidenceQuote}], medications[{text, evidenceQuote}], planItems[{kind, dueInDays, evidenceQuote}]}`). Every `evidenceQuote` is an exact substring of `text` (tested). Labeling rules:

- `hasPlan`: the note says what happens next (control, session, tests, treatment, discharge). Notes that end at the diagnosis or only say "se explica condición" have none.
- `conditions`: diagnoses of this patient (Dx, impresión, known chronic conditions), ICD-10 at category level; compared by the first 3 characters. Family history and symptoms that are not a diagnosis are excluded.
- `medications`: drugs prescribed or continued, as written; suspended drugs are excluded.
- `planItems`: only follow-ups with a timeframe, one per dated instruction. Months are 30 days, weeks 7; absolute dates (`dd/mm/yyyy`) count from `authoredAt` (tested). A named test attached to a dated control ("ctrl en 3 meses con HbA1c") is a separate `lab` item with the same due date; generic "con resultados" is not. Orders placed today without a timeframe are not plan items (the universal rules cover the `ServiceRequest`). Kinds: `follow_up_visit`, `session` (psychotherapy), `lab`, `imaging`, `other` (referrals, procedures, specialist controls).

Set: 44 notes, 11 per specialty, 11 without a plan, 15 with two or more plan items, relative dates in days, weeks and months, 5 absolute dates. Psychology notes are clinical and neutral (no crisis content).

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
| `three_layers_one_case`               | Universal (lab), doctor plan and protocol (HbA1c) expire into one case                                   |

## Regenerating

```sh
pnpm --filter @follow-up-engine/testkit generate
```

Rebuilds `fixtures/clinic` and `fixtures/scenarios` from `src/synthetic` and `src/scenarios` (seeded PRNG, no network) and formats them with Prettier. Tests fail if the committed fixtures drift from the generators. Gold notes are hand-written and not touched.

The FHIR schema was downloaded from <https://hl7.org/fhir/R4/fhir.schema.json.zip>; the SHA-256 of the uncompressed file is pinned in `src/fhir/validate.ts` and checked by a test. The file names itself with the draft-04 `id` keyword, which the validator maps to `$id` at load time; nothing else is changed.
