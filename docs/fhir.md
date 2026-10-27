# FHIR R4 contract

The engine speaks HL7 FHIR R4 (4.0.1) in and out ([ADR 0001](adr/0001-fhir-r4-data-model.md)). Any EHR that can produce FHIR can plug in: it sends Bundles, the engine answers with `OperationOutcome`s, and exposes its own objects (expectations, cases, inferred conditions, documentation findings) as standard FHIR resources.

`@follow-up-engine/fhir` holds the whole contract as pure functions (no I/O, no clock, no randomness): it validates and maps inbound Bundles into core `ClinicalBatch`es and turns engine objects back into FHIR. The HTTP API only wires it.

- Inbound validation uses zod schemas typed against `@types/fhir` (`satisfies z.ZodType<Partial<fhir4.X>>`), so a schema that drifts from R4 fails to compile.
- Every resource the package emits, and every fixture it consumes, is validated in CI against the official [FHIR R4 JSON Schema](https://hl7.org/fhir/R4/fhir.schema.json.zip) (`packages/fhir/test/fhir-schema.test.ts`).
- The examples in this document are checked against the code by `packages/fhir/test/docs.test.ts`.

## Inbound

### What the host sends

One `transaction` (or `batch`) Bundle per saved consultation: the `Encounter`, the note (`DocumentReference` or `Composition`), orders (`ServiceRequest`), prescriptions (`MedicationRequest`), diagnoses (`Condition`) and, for a new patient, the `Patient`. Other host events arrive the same way: a result (`DiagnosticReport` and/or `Observation`), an appointment booked or cancelled (`Appointment`), a patient opt-out (`Patient` extension or `Consent`). An opt-out stops patient contact only: the clinic keeps following the patient, and escalation goes to the coordinator instead of the patient.

| Bundle `type` | Semantics                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction` | All or nothing, as in FHIR: any `error` issue rejects the whole Bundle; no batch is produced and the outcome ends with a `processing` error at `Bundle`. |
| `batch`       | Entry by entry: invalid entries are reported and skipped, the rest is mapped.                                                                            |
| anything else | Rejected at `Bundle.type`.                                                                                                                               |

### Entry identity and references

Each entry gets a stable identity, in this order: `resource.id`; else the `fullUrl` (`urn:uuid:<uuid>` gives the uuid, `urn:oid:<oid>` the oid, an absolute `.../Type/id` URL its id); else the `request.url` of a `PUT Type/id`. An entry with none of them is an error at `Bundle.entry[i]`; the same `Type/id` twice is a `duplicate` error.

References resolve against the Bundle first (`urn:uuid:` and absolute `fullUrl`s), then as literal `Type/id` (relative or absolute, `/_history/n` allowed). Contained (`#id`) and identifier-only references cannot be followed. The resources returned for storage have their `id` filled in and every Bundle-local reference rewritten to `Type/id`, as a FHIR server does when it processes a transaction.

### Mapping

Validation is tolerant (unknown elements are accepted and kept in the stored resource) and strict on what the mapping needs (an invalid status, a missing `subject` or `code`, a malformed `dateTime` is an error at its exact path). Resources whose status does not produce an event are reported as `information`.

| FHIR resource                                                                                                                          | Condition                                                                                                                                                                                                                                                                                                                                     | Clinical event            | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `occurredAt`                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Encounter`                                                                                                                            | `status = finished` (any status still groups the consultation)                                                                                                                                                                                                                                                                                | `encounter.finished`      | `practitionerId` from `participant.individual` (PPRF, then ATND, SPRF, PART, then any `Practitioner`); `specialty` from `serviceType`, else `type`                                                                                                                                                                                                                                                                                                                                                                                                                                 | `period.end`, `period.start`                                         |
| `Appointment`                                                                                                                          | `status = booked`                                                                                                                                                                                                                                                                                                                             | `appointment.booked`      | `scheduledFor` = `start` (required); patient and practitioner from `participant.actor`; `specialty` from `specialty`, `serviceType`, `appointmentType`; `recordedAt` = `meta.lastUpdated`, which orders the versions of the Appointment (the latest wins: a reschedule replaces the earlier date, a booking made again after a cancellation stands)                                                                                                                                                                                                                                | `created`, `meta.lastUpdated`                                        |
| `Appointment`                                                                                                                          | `status` in `cancelled`, `noshow`, `entered-in-error`                                                                                                                                                                                                                                                                                         | `appointment.cancelled`   | `scheduledFor` = `start`; `reason` = `no_show` or `entered_in_error` (absent for a cancellation). Reopens what the booking fulfilled                                                                                                                                                                                                                                                                                                                                                                                                                                               | `meta.lastUpdated`                                                   |
| `ServiceRequest`                                                                                                                       | `status = active` and `intent` in the order family (`order`, `original-order`, `reflex-order`, `filler-order`, `instance-order`)                                                                                                                                                                                                              | `service_request.created` | `orderId` = resource id; `code`: LOINC coding first, then any coded value, then an uncoded placeholder (warning); `category`: SNOMED CT `108252007` laboratory, `363679005` imaging, else keywords in the category text, else `other`                                                                                                                                                                                                                                                                                                                                              | `authoredOn`                                                         |
| `DiagnosticReport`                                                                                                                     | `status` in `final`, `amended`, `corrected`, `appended`                                                                                                                                                                                                                                                                                       | `result.received`         | `code` as above; `basedOnOrderId` from `basedOn` (ServiceRequest); `interpretation` combines the in-Bundle `Observation`s it lists (any abnormal wins, all normal gives normal); `value` is the `valueQuantity` of its single listed `Observation` of the same code, when there is one                                                                                                                                                                                                                                                                                             | `issued`, `effectiveDateTime`, `effectivePeriod`                     |
| `Observation`                                                                                                                          | `status` in `final`, `amended`, `corrected`                                                                                                                                                                                                                                                                                                   | `result.received`         | `interpretation` from v3 ObservationInterpretation: `A`, `AA`, `H`, `HH`, `HU`, `L`, `LL`, `LU` abnormal; `N` normal; else unknown. `severity` of an abnormal result: `critical` for `AA`, `HH`, `LL` or an interpretation labelled critical / panic (also abnormal), else `mild`; a `DiagnosticReport` takes the worst of its listed `Observation`s. `value` from `valueQuantity` (`value`, `unit` else UCUM `code`). Without its own `basedOn`, inherits the order of the in-Bundle `DiagnosticReport` that lists it                                                             | `issued`, `effectiveDateTime`, `effectiveInstant`, `effectivePeriod` |
| `MedicationRequest`                                                                                                                    | `status` in `active`, `completed`; `intent` in the order family or `plan`                                                                                                                                                                                                                                                                     | `medication.prescribed`   | `medication.text` from the concept text, display or code (or the `medicationReference` display / in-Bundle `Medication`); `medication.code` = first coded value, optional; `durationDays` from `dispenseRequest.expectedSupplyDuration`, else `timing.repeat.boundsDuration`, else the span of `boundsPeriod`; `refills` = `dispenseRequest.numberOfRepeatsAllowed`; `asNeeded` when a dosage has `asNeededBoolean: true` or `asNeededCodeableConcept`; `dosageText` = the `dosageInstruction.text` values; `startAt` = `boundsPeriod.start`, `validityPeriod.start`, `authoredOn` | `authoredOn`                                                         |
| `Condition`                                                                                                                            | not `refuted`/`entered-in-error` (see `record.withdrawn`), not `inactive`/`resolved`/`remission`, has an ICD-10 or ICD-10-CM coding                                                                                                                                                                                                           | `condition.recorded`      | `code` under `http://hl7.org/fhir/sid/icd-10`; `verification`: `provisional`, `differential`, `unconfirmed` give provisional, anything else (including absent) confirmed                                                                                                                                                                                                                                                                                                                                                                                                           | `recordedDate`, `onsetDateTime`                                      |
| `DocumentReference`                                                                                                                    | `status = current`, `docStatus` not `preliminary`                                                                                                                                                                                                                                                                                             | `note.received`           | text from inline `attachment.data` (base64 UTF-8; HTML reduced to text), else the narrative, else `description`; URLs are never fetched; `specialty` from `context.practiceSetting`, else the consultation's Encounter                                                                                                                                                                                                                                                                                                                                                             | `date`, `context.period`                                             |
| `Composition`                                                                                                                          | `status` in `final`, `amended`                                                                                                                                                                                                                                                                                                                | `note.received`           | `title` and every `section` (recursive) as plain text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `date`                                                               |
| `Patient`                                                                                                                              | engine opt-out extension with `valueBoolean: true`                                                                                                                                                                                                                                                                                            | `patient.opted_out`       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `meta.lastUpdated`                                                   |
| `Consent`                                                                                                                              | `status = active`, `provision.type = deny`, `category` has `https://hipocratesalud.com/fhir/CodeSystem/follow-up-consent#follow-up-opt-out`                                                                                                                                                                                                   | `patient.opted_out`       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `dateTime`                                                           |
| `ServiceRequest`, `MedicationRequest`, `Condition`, `DocumentReference`, `Composition`, `DiagnosticReport`, `Observation`, `Encounter` | a later version that withdraws the resource: order `revoked`/`entered-in-error`; prescription `stopped`/`cancelled`/`entered-in-error`; diagnosis verification `refuted`/`entered-in-error`; note `entered-in-error` (status or `docStatus`) or `superseded`; result `cancelled`/`entered-in-error`; encounter `entered-in-error`/`cancelled` | `record.withdrawn`        | `reason`: `revoked`, `stopped`, `cancelled`, `refuted`, `superseded`, `entered_in_error`. The engine cancels the expectations the resource triggered (`closedReason: source_withdrawn`, their cases resolve as `not_needed`), reopens what it fulfilled, decides the condition it recorded again from the records of the diagnosis that remain (none left: `rejected` when refuted, `entered_in_error` otherwise), and ignores its earlier events. A withdrawn `DiagnosticReport` also withdraws the `Observation`s it lists (one event each)                                      | `meta.lastUpdated`                                                   |

Missing clinical times fall back to the `receivedAt` the caller passes. `Medication`, `Practitioner`, `PractitionerRole`, `Organization`, `Location`, `Device`, `Specimen`, `RelatedPerson` and `HealthcareService` are context: resolved by reference, never reported, and returned as `contextResources` (references resolved) so the API can keep the host's directory of practitioners and organizations. Other resource types are ignored with an `information` issue.

### Robustness

One bad field never costs the host the rest of the consultation:

- Control characters (NUL, BEL, ...) and invalid Unicode in any string are removed, with a `warning` at the string's path; the same goes for text decoded from a base64 attachment. Postgres would refuse them, and they are never part of clinical text.
- A string over 1 MB (FHIR's limit; attachment `data` excepted) is an `error` for its entry.
- Clinical dates must fall between 1900 and 2200 (`error` otherwise: a year-9999 typo would give due dates that are not valid FHIR). On live ingestion (`receivedAt` is the real receipt time) an event dated more than a year after receipt is an `error`, more than a day after it a `warning`; scheduled dates (an appointment) may be up to five years ahead.
- A `ServiceRequest` without a recognizable `category` takes `laboratory` from a well-known LOINC laboratory code (HbA1c, glucose, lipids, creatinine, TSH, CBC, ...; the list is `LABORATORY_LOINC_CODES`) or `imaging` from a LOINC imaging study name (`XR`, `CT`, `MR`, `US`, ...), with a `warning`; otherwise it stays `other` (no result expectation), also with a `warning` that says so.

The API also caps request bodies at 5 MB (`413`, an `OperationOutcome` with code `too-costly`).

### Idempotency

Every event carries `idempotencyKey = <resourceType>/<id>/<version>#<event type>`, where `<version>` is `meta.versionId`, else `meta.lastUpdated`, else a 64-bit FNV-1a hash of the canonical JSON of the resource (keys sorted, `meta` excluded, references already rewritten). Re-sending the same Bundle yields the same keys; changing a resource changes only its own key.

### Updates to resources already sent

Delivery is at least once and may reorder. A resource older than the stored one (lower numeric `meta.versionId`, else earlier `meta.lastUpdated`) is not stored (`stale` in the transaction-response entry) and its events are not ingested. A new version can withdraw the resource (`record.withdrawn`, above). A note's new version (an amendment, `docStatus = amended`) is read again unless its text did not change, and its plan replaces the earlier version's: plan items the new version no longer asks for are superseded (`superseded_by_amended_note`); a `DocumentReference` whose `relatesTo` `replaces` another does the same for the replaced note (`note.received.replacesDocumentIds`). A resource re-sent with another `subject` moves: the old patient gets a `record.withdrawn` (`subject_changed`) that withdraws what was derived there, and the new patient gets its own expectations.

### Batching

Events are grouped into one `ClinicalBatch` per patient (the `subject`, `patient` or Patient participant) and consultation, in Bundle order. With at most one `Encounter` for the patient in the Bundle, every resource belongs to it and `encounterId` is set on the batch and on every event. With several, each resource joins the Encounter it references; the rest form a batch without `encounterId`. Patients with no event produce no batch, but their resources are still returned for storage.

### Issues

Problems come back as one `OperationOutcome`, ordered by entry, each issue with a FHIRPath-like `expression`:

```json
{
  "resourceType": "OperationOutcome",
  "issue": [
    {
      "severity": "error",
      "code": "not-found",
      "diagnostics": "cannot resolve reference \"urn:uuid:00000000-0000-4000-8000-0000000000ff\"",
      "expression": ["Bundle.entry[0].resource.subject"]
    },
    {
      "severity": "error",
      "code": "value",
      "diagnostics": "expected a reference to Patient, got Group",
      "expression": ["Bundle.entry[2].resource.subject"]
    },
    {
      "severity": "error",
      "code": "processing",
      "diagnostics": "transaction rejected: fix the errors above; nothing was processed",
      "expression": ["Bundle"]
    }
  ]
}
```

| Severity      | Meaning                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error`       | The entry cannot be mapped (rejects a `transaction`).                                                                                                                      |
| `warning`     | Mapped with a stated assumption (uncoded order, Condition without ICD-10, unreadable attachment, control characters removed, order category inferred, date in the future). |
| `information` | No event by design (status, unsupported type, entry without resource).                                                                                                     |

## Outbound

### Expectation → `Task`

| Element                       | Value                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                          | expectation id                                                                                                                                   |
| `intent`                      | `plan`                                                                                                                                           |
| `code`                        | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation#<ruleId>`, text = Spanish reason label                                         |
| `status`                      | `open` → `requested`, `fulfilled` → `completed`, `superseded`/`cancelled` → `cancelled`, `expired` → `failed`                                    |
| `businessStatus`              | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation-status#<exact engine status>`                                                  |
| `statusReason`                | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-closed-reason#<closedReason>`                                                              |
| `focus`                       | the triggering resource; also `basedOn` when it is a request (`ServiceRequest`, `MedicationRequest`, `CarePlan`, `Appointment`, `DeviceRequest`) |
| `for`                         | `Patient/<patientId>`                                                                                                                            |
| `partOf`                      | `Task/<caseId>` once grouped into a case                                                                                                         |
| `restriction.period.end`      | `dueAt`                                                                                                                                          |
| `executionPeriod`             | `createdAt` to `closedAt`                                                                                                                        |
| `authoredOn` / `lastModified` | `createdAt` / `updatedAt`                                                                                                                        |
| `reasonCode`                  | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason#<reason.code>`, text = label                                                        |
| `identifier`                  | `https://hipocratesalud.com/fhir/NamingSystem/follow-up-expectation-key` = idempotency key                                                       |
| extensions                    | layer, rule version, protocol id and version, origin, match key, evidence (quote + source document)                                              |

### Case → `Task`

| Element           | Value                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | case id                                                                                                                                                              |
| `intent`          | `proposal` (the engine suggests; the clinic decides)                                                                                                                 |
| `code`            | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-task-type#follow-up-case`                                                                                      |
| `status`          | `open`/`notified` → `ready`, `snoozed` → `on-hold`, `escalated` → `in-progress`, `resolved` → `completed`, `dismissed` → `cancelled`, `lost_to_follow_up` → `failed` |
| `businessStatus`  | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-status#<exact engine status>`                                                                             |
| `priority`        | numeric priority ≥ 90 `stat`, ≥ 75 `asap`, ≥ 60 `urgent`, else `routine` (`CASE_PRIORITY_THRESHOLDS`); the number itself in the priority-score extension             |
| `owner`           | the assignee as a logical reference (`https://hipocratesalud.com/fhir/NamingSystem/host-user`)                                                                       |
| `input[]`         | one per reason: `type` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason#<reasonCode>`, `valueReference` = `Task/<expectationId>`                       |
| `statusReason`    | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-resolution#<resolution kind>`                                                                             |
| `executionPeriod` | `createdAt` to `resolution.resolvedAt`                                                                                                                               |
| extensions        | escalation step, priority score, dedup key, origin, release at, next action at, snoozed until, resolution (kind, resolvedAt, resolvedBy, note)                       |

`taskToExpectation`, `taskToCase` and `fhirToPatientCondition` read these resources back; round-trip tests prove the representation is lossless.

### Patient condition → `Condition`

`category` = `problem-list-item`; `code` = the ICD-10 coding; `evidence.detail` → the source resource (the `DocumentReference` for conditions extracted from a note); `meta.lastUpdated` = `updatedAt`. Extensions: confidence (`valueDecimal`), condition source, confirmed by (or refuted by), evidence (quote + source document). The default id is `<patientId>-<code>`.

| Engine status      | `verificationStatus` | `clinicalStatus` | Meaning                                                                                                                                                                                                         |
| ------------------ | -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`        | `confirmed`          | `active`         | Recorded by a clinician, or confirmed in the inbox (`follow-up-confirmed-by`)                                                                                                                                   |
| `probable`         | `provisional`        | `active`         | Inferred or read from a note; waiting for a clinician                                                                                                                                                           |
| `resolved`         | `confirmed`          | `resolved`       | The patient had it and no longer does                                                                                                                                                                           |
| `rejected`         | `refuted`            | `inactive`       | A clinician said the patient does not have it (`follow-up-refuted-by`); never inferred again. Without `follow-up-refuted-by`, the host refuted the diagnosis it had recorded (the inbox's `rejectedBy: 'host'`) |
| `entered_in_error` | `entered-in-error`   | (none)           | The host's record was entered in error or moved to another patient: never this patient's; left out of the inbox                                                                                                 |

`GET /fhir/Condition` leaves out a `provisional` ICD-10 code when a `confirmed` code of the same or a more specific concept exists (the note says "DM2" → provisional `E11`; the chart records confirmed `E11.9`): the host sees the clinician's diagnosis, not an unconfirmed duplicate. The inbox hides the same duplicates.

### Quality finding → `DetectedIssue`

`status = preliminary`, `severity = low`, `code` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-quality-finding#note-without-plan`, `patient`, `identifiedDateTime` = `detectedAt`, `implicated` = the document. A suggestion to the clinician, never to the patient.

### Case event → `Provenance`

`target` = the case `Task`; `recorded` and `occurredDateTime` = `at`; `activity` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-event#<type>`; one `agent` (type `performer`): a user is a logical reference in `https://hipocratesalud.com/fhir/NamingSystem/host-user`, a patient is `Patient/<id>`, a rule is a `Device` identified in `https://hipocratesalud.com/fhir/NamingSystem/follow-up-rule`, the engine is a `Device` in `https://hipocratesalud.com/fhir/NamingSystem/follow-up-engine`. The structured payload (ids and codes only) is JSON in the case-event-payload extension. Case events have no id of their own, so the id is derived from case, type, time and a hash of actor and payload.

### Searchset

`toSearchsetBundle(resources, { baseUrl, total, selfUrl, nextUrl, previousUrl, timestamp, outcome })` wraps any list: `type = searchset`, `search.mode = match`, absolute `fullUrl` when `baseUrl` is given, an `OperationOutcome` entry with `search.mode = outcome` when the search has issues (an ignored parameter), no `entry` when empty.

## Engine terminology

Base: `https://hipocratesalud.com/fhir`. Every engine-defined CodeSystem, NamingSystem and extension lives under it, including the codes used by `config/` (protocols) and the synthetic fixtures of `@follow-up-engine/testkit` (`ENGINE_FHIR_BASE` in both packages, checked by a test).

| CodeSystem                                | Codes                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CodeSystem/follow-up-expectation`        | rule ids (`lab_order_result_pending`, `doctor_plan_followup`, `protocol_diabetes_hba1c`, ...)                                                                                                    |
| `CodeSystem/follow-up-task-type`          | `follow-up-case`                                                                                                                                                                                 |
| `CodeSystem/follow-up-expectation-status` | `open`, `fulfilled`, `superseded`, `expired`, `cancelled`                                                                                                                                        |
| `CodeSystem/follow-up-case-status`        | `open`, `notified`, `snoozed`, `escalated`, `resolved`, `dismissed`, `lost_to_follow_up`                                                                                                         |
| `CodeSystem/follow-up-closed-reason`      | the engine's `closedReason` codes                                                                                                                                                                |
| `CodeSystem/follow-up-case-resolution`    | `fulfilled`, `handled_outside`, `not_needed`, `patient_declined`, `patient_unreachable`                                                                                                          |
| `CodeSystem/follow-up-reason`             | reason codes from rules and protocols                                                                                                                                                            |
| `CodeSystem/follow-up-quality-finding`    | `note-without-plan`                                                                                                                                                                              |
| `CodeSystem/follow-up-case-event`         | `opened`, `reason_added`, `released`, `notified`, `assigned`, `snoozed`, `escalated`, `patient_contact_requested`, `resolved`, `dismissed`, `reopened`, `lost_to_follow_up`, `feedback_recorded` |
| `CodeSystem/specialty`                    | specialty codes a host may send (`diabetology`, `cardiology`, `psychology`, `gynecology`, ...)                                                                                                   |
| `CodeSystem/follow-up-consent`            | `follow-up-opt-out`                                                                                                                                                                              |
| `CodeSystem/uncoded`                      | slug of the text of an order or result that arrived without a code                                                                                                                               |
| `CodeSystem/procedure`                    | local procedure codes protocols expect when no standard code fits (`fundus-exam`)                                                                                                                |

| Extension (`StructureDefinition/...`) | On                            | Value                                                                                                               |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `follow-up-opt-out`                   | Patient (inbound)             | `valueBoolean`                                                                                                      |
| `follow-up-layer`                     | Task (expectation)            | `valueCode`: `universal`, `doctor_plan`, `cadence`, `protocol`                                                      |
| `follow-up-rule-version`              | Task (expectation)            | `valueString`                                                                                                       |
| `follow-up-protocol-id`               | Task (expectation)            | `valueString`                                                                                                       |
| `follow-up-protocol-version`          | Task (expectation)            | `valueString`                                                                                                       |
| `follow-up-match-key`                 | Task (expectation)            | `valueString`                                                                                                       |
| `follow-up-origin`                    | Task                          | `valueCode`: `live`, `backfill`                                                                                     |
| `follow-up-evidence`                  | Task (expectation), Condition | complex: `quote` (`valueString`), `source` (`valueReference` DocumentReference)                                     |
| `follow-up-escalation-step`           | Task (case)                   | `valueInteger`                                                                                                      |
| `follow-up-priority-score`            | Task (case)                   | `valueInteger`                                                                                                      |
| `follow-up-dedup-key`                 | Task (case)                   | `valueString`                                                                                                       |
| `follow-up-release-at`                | Task (case)                   | `valueDateTime`                                                                                                     |
| `follow-up-next-action-at`            | Task (case)                   | `valueDateTime`                                                                                                     |
| `follow-up-snoozed-until`             | Task (case)                   | `valueDateTime`                                                                                                     |
| `follow-up-case-resolution`           | Task (case)                   | complex: `kind` (`valueCode`), `resolvedAt` (`valueDateTime`), `resolvedBy` (`valueString`), `note` (`valueString`) |
| `follow-up-confidence`                | Condition                     | `valueDecimal` 0..1                                                                                                 |
| `follow-up-condition-source`          | Condition                     | `valueCode`: `recorded`, `inferred_from_medication`, `inferred_from_result`, `extracted_from_note`                  |
| `follow-up-confirmed-by`              | Condition                     | `valueString` (host user id)                                                                                        |
| `follow-up-refuted-by`                | Condition (`refuted`)         | `valueString` (host user id of the clinician who rejected it)                                                       |
| `follow-up-case-event-payload`        | Provenance                    | `valueString` (JSON)                                                                                                |

All URLs are exported as constants (`ENGINE_CODE_SYSTEMS`, `ENGINE_EXTENSIONS`, `ENGINE_IDENTIFIER_SYSTEMS`); never hard-code them.

## Example: a diabetology consultation

The host saves a consultation and sends this `transaction` (synthetic data; `packages/fhir/fixtures/bundles/consultation-diabetology.json`). The note is base64 in `attachment.data`; it reads: "Paciente femenina de 58 años con DM2 [...] Plan: continuar metformina 850 mg c/12h. Solicito HbA1c y perfil lipídico. Control en 3 meses con resultados."

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "timestamp": "2026-01-05T14:30:00-04:00",
  "entry": [
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "resource": {
        "resourceType": "Patient",
        "identifier": [
          {
            "system": "https://ehr.example.org/patients",
            "value": "DM-0001"
          }
        ],
        "name": [
          {
            "family": "Prueba",
            "given": ["Ana"]
          }
        ],
        "gender": "female",
        "birthDate": "1967-08-14"
      },
      "request": {
        "method": "POST",
        "url": "Patient"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02",
      "resource": {
        "resourceType": "Practitioner",
        "name": [
          {
            "family": "Sintético",
            "given": ["Luis"],
            "prefix": ["Dr."]
          }
        ]
      },
      "request": {
        "method": "POST",
        "url": "Practitioner"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03",
      "resource": {
        "resourceType": "Encounter",
        "status": "finished",
        "class": {
          "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          "code": "AMB",
          "display": "ambulatory"
        },
        "serviceType": {
          "coding": [
            {
              "system": "https://hipocratesalud.com/fhir/CodeSystem/specialty",
              "code": "diabetology",
              "display": "Diabetology"
            }
          ],
          "text": "Diabetología"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "participant": [
          {
            "type": [
              {
                "coding": [
                  {
                    "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
                    "code": "PPRF",
                    "display": "primary performer"
                  }
                ]
              }
            ],
            "individual": {
              "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
            }
          }
        ],
        "period": {
          "start": "2026-01-05T14:00:00-04:00",
          "end": "2026-01-05T14:30:00-04:00"
        }
      },
      "request": {
        "method": "POST",
        "url": "Encounter"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e04",
      "resource": {
        "resourceType": "DocumentReference",
        "status": "current",
        "docStatus": "final",
        "type": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "11506-3",
              "display": "Progress note"
            }
          ]
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "date": "2026-01-05T14:30:00-04:00",
        "author": [
          {
            "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
          }
        ],
        "content": [
          {
            "attachment": {
              "contentType": "text/plain; charset=utf-8",
              "language": "es",
              "data": "UGFjaWVudGUgZmVtZW5pbmEgZGUgNTggYcOxb3MgY29uIERNMiBkaWFnbm9zdGljYWRhIGhhY2UgNiBhw7Fvcy4gUmVmaWVyZSBidWVuYSBhZGhlcmVuY2lhIGEgbWV0Zm9ybWluYS4KR2x1Y2VtaWEgZW4gYXl1bmFzIDE2OCBtZy9kTC4gUEEgMTI4LzgyIG1tSGcsIElNQyAzMS4KSW1wcmVzacOzbjogRE0yIG5vIGNvbnRyb2xhZGEuClBsYW46IGNvbnRpbnVhciBtZXRmb3JtaW5hIDg1MCBtZyBjLzEyaC4gU29saWNpdG8gSGJBMWMgeSBwZXJmaWwgbGlww61kaWNvLiBDb250cm9sIGVuIDMgbWVzZXMgY29uIHJlc3VsdGFkb3Mu"
            }
          }
        ],
        "context": {
          "encounter": [
            {
              "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
            }
          ],
          "practiceSetting": {
            "coding": [
              {
                "system": "https://hipocratesalud.com/fhir/CodeSystem/specialty",
                "code": "diabetology"
              }
            ]
          }
        }
      },
      "request": {
        "method": "POST",
        "url": "DocumentReference"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05",
      "resource": {
        "resourceType": "ServiceRequest",
        "status": "active",
        "intent": "order",
        "category": [
          {
            "coding": [
              {
                "system": "http://snomed.info/sct",
                "code": "108252007",
                "display": "Laboratory procedure"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "4548-4",
              "display": "Hemoglobin A1c/Hemoglobin.total in Blood"
            }
          ],
          "text": "HbA1c"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        }
      },
      "request": {
        "method": "POST",
        "url": "ServiceRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06",
      "resource": {
        "resourceType": "ServiceRequest",
        "status": "active",
        "intent": "order",
        "category": [
          {
            "coding": [
              {
                "system": "http://snomed.info/sct",
                "code": "108252007",
                "display": "Laboratory procedure"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "57698-3",
              "display": "Lipid panel with direct LDL - Serum or Plasma"
            }
          ],
          "text": "Perfil lipídico"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        }
      },
      "request": {
        "method": "POST",
        "url": "ServiceRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e07",
      "resource": {
        "resourceType": "MedicationRequest",
        "status": "active",
        "intent": "order",
        "medicationCodeableConcept": {
          "coding": [
            {
              "system": "http://www.nlm.nih.gov/research/umls/rxnorm",
              "code": "861004",
              "display": "metformin hydrochloride 850 MG Oral Tablet"
            }
          ],
          "text": "metformina 850 mg"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        },
        "dosageInstruction": [
          {
            "text": "1 tableta cada 12 horas con las comidas",
            "timing": {
              "repeat": {
                "frequency": 1,
                "period": 12,
                "periodUnit": "h"
              }
            }
          }
        ],
        "dispenseRequest": {
          "numberOfRepeatsAllowed": 2,
          "expectedSupplyDuration": {
            "value": 90,
            "unit": "days",
            "system": "http://unitsofmeasure.org",
            "code": "d"
          }
        }
      },
      "request": {
        "method": "POST",
        "url": "MedicationRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e08",
      "resource": {
        "resourceType": "Condition",
        "clinicalStatus": {
          "coding": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
              "code": "active"
            }
          ]
        },
        "verificationStatus": {
          "coding": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
              "code": "confirmed"
            }
          ]
        },
        "category": [
          {
            "coding": [
              {
                "system": "http://terminology.hl7.org/CodeSystem/condition-category",
                "code": "encounter-diagnosis"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://hl7.org/fhir/sid/icd-10",
              "code": "E11.9",
              "display": "Type 2 diabetes mellitus without complications"
            }
          ],
          "text": "DM2"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "recordedDate": "2026-01-05T14:30:00-04:00"
      },
      "request": {
        "method": "POST",
        "url": "Condition"
      }
    }
  ]
}
```

`mapBundleToBatches(bundle, { clinicId: 'clinic-demo', receivedAt: new Date('2026-01-05T18:31:00Z') })` returns no issues and one `ClinicalBatch` (dates shown as ISO strings):

```json
{
  "clinicId": "clinic-demo",
  "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
  "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03",
  "receivedAt": "2026-01-05T18:31:00.000Z",
  "events": [
    {
      "type": "encounter.finished",
      "source": {
        "resourceType": "Encounter",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "Encounter/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03/88f8d72d796484a1#encounter.finished",
      "practitionerId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02",
      "specialty": "diabetology",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    },
    {
      "type": "note.received",
      "source": {
        "resourceType": "DocumentReference",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e04"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "DocumentReference/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e04/305870aead8f7df2#note.received",
      "documentId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e04",
      "text": "Paciente femenina de 58 años con DM2 diagnosticada hace 6 años. Refiere buena adherencia a metformina.\nGlucemia en ayunas 168 mg/dL. PA 128/82 mmHg, IMC 31.\nImpresión: DM2 no controlada.\nPlan: continuar metformina 850 mg c/12h. Solicito HbA1c y perfil lipídico. Control en 3 meses con resultados.",
      "authoredAt": "2026-01-05T18:30:00.000Z",
      "specialty": "diabetology",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    },
    {
      "type": "service_request.created",
      "source": {
        "resourceType": "ServiceRequest",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "ServiceRequest/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05/70d7e3d923c8d1b1#service_request.created",
      "orderId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05",
      "code": {
        "system": "http://loinc.org",
        "code": "4548-4",
        "display": "Hemoglobin A1c/Hemoglobin.total in Blood"
      },
      "category": "laboratory",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    },
    {
      "type": "service_request.created",
      "source": {
        "resourceType": "ServiceRequest",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "ServiceRequest/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06/527ddafd67af69c6#service_request.created",
      "orderId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06",
      "code": {
        "system": "http://loinc.org",
        "code": "57698-3",
        "display": "Lipid panel with direct LDL - Serum or Plasma"
      },
      "category": "laboratory",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    },
    {
      "type": "medication.prescribed",
      "source": {
        "resourceType": "MedicationRequest",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e07"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "MedicationRequest/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e07/ee5f18fe6ae20959#medication.prescribed",
      "medication": {
        "code": {
          "system": "http://www.nlm.nih.gov/research/umls/rxnorm",
          "code": "861004",
          "display": "metformin hydrochloride 850 MG Oral Tablet"
        },
        "text": "metformina 850 mg"
      },
      "startAt": "2026-01-05T18:30:00.000Z",
      "durationDays": 90,
      "refills": 2,
      "dosageText": "1 tableta cada 12 horas con las comidas",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    },
    {
      "type": "condition.recorded",
      "source": {
        "resourceType": "Condition",
        "id": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e08"
      },
      "occurredAt": "2026-01-05T18:30:00.000Z",
      "idempotencyKey": "Condition/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e08/8227a9fff90786a6#condition.recorded",
      "code": {
        "system": "http://hl7.org/fhir/sid/icd-10",
        "code": "E11.9",
        "display": "Type 2 diabetes mellitus without complications"
      },
      "verification": "confirmed",
      "clinicId": "clinic-demo",
      "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "encounterId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
    }
  ]
}
```

The engine then reads the plan out of the note (the LLM gateway), creates expectations and, when they expire unmet, a case. That case, as the host receives it:

```json
{
  "resourceType": "Task",
  "id": "case-0001",
  "extension": [
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-escalation-step",
      "valueInteger": 1
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-priority-score",
      "valueInteger": 70
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-dedup-key",
      "valueString": "pat-dm-0001:diabetes_control"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-origin",
      "valueCode": "backfill"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-release-at",
      "valueDateTime": "2026-04-06T12:00:00.000Z"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-next-action-at",
      "valueDateTime": "2026-04-13T12:00:00.000Z"
    }
  ],
  "status": "in-progress",
  "businessStatus": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-status",
        "code": "escalated"
      }
    ],
    "text": "escalated"
  },
  "intent": "proposal",
  "priority": "urgent",
  "code": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-task-type",
        "code": "follow-up-case",
        "display": "Follow-up case"
      }
    ]
  },
  "for": {
    "reference": "Patient/pat-dm-0001",
    "type": "Patient"
  },
  "executionPeriod": {
    "start": "2026-04-06T00:00:00.000Z"
  },
  "authoredOn": "2026-04-06T00:00:00.000Z",
  "lastModified": "2026-04-13T00:00:00.000Z",
  "owner": {
    "type": "Practitioner",
    "identifier": {
      "system": "https://hipocratesalud.com/fhir/NamingSystem/host-user",
      "value": "user-reception-1"
    }
  },
  "input": [
    {
      "type": {
        "coding": [
          {
            "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason",
            "code": "doctor_plan_followup"
          }
        ]
      },
      "valueReference": {
        "reference": "Task/exp-plan-0002",
        "type": "Task"
      }
    },
    {
      "type": {
        "coding": [
          {
            "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason",
            "code": "lab_order_result_pending"
          }
        ]
      },
      "valueReference": {
        "reference": "Task/exp-hba1c-0001",
        "type": "Task"
      }
    }
  ]
}
```

And one of its expectations, from the doctor's plan:

```json
{
  "resourceType": "Task",
  "id": "exp-plan-0002",
  "extension": [
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-layer",
      "valueCode": "doctor_plan"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-rule-version",
      "valueString": "1.2.0"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-protocol-id",
      "valueString": "diabetes"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-protocol-version",
      "valueString": "1.0.0"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-origin",
      "valueCode": "backfill"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-match-key",
      "valueString": "specialty:diabetology"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-evidence",
      "extension": [
        {
          "url": "quote",
          "valueString": "Control en 3 meses con resultados."
        },
        {
          "url": "source",
          "valueReference": {
            "reference": "DocumentReference/note-1",
            "type": "DocumentReference"
          }
        }
      ]
    }
  ],
  "identifier": [
    {
      "system": "https://hipocratesalud.com/fhir/NamingSystem/follow-up-expectation-key",
      "value": "DocumentReference/note-1#doctor_plan_followup#specialty:diabetology@2026-04-05"
    }
  ],
  "partOf": [
    {
      "reference": "Task/case-0001",
      "type": "Task"
    }
  ],
  "status": "failed",
  "statusReason": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-closed-reason",
        "code": "expired_unmet"
      }
    ]
  },
  "businessStatus": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation-status",
        "code": "expired"
      }
    ],
    "text": "expired"
  },
  "intent": "plan",
  "code": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation",
        "code": "doctor_plan_followup"
      }
    ],
    "text": "Seguimiento indicado por el médico"
  },
  "description": "Seguimiento indicado por el médico",
  "focus": {
    "reference": "DocumentReference/note-1",
    "type": "DocumentReference"
  },
  "for": {
    "reference": "Patient/pat-dm-0001",
    "type": "Patient"
  },
  "executionPeriod": {
    "start": "2026-01-05T12:00:00.000Z",
    "end": "2026-04-06T00:00:00.000Z"
  },
  "authoredOn": "2026-01-05T12:00:00.000Z",
  "lastModified": "2026-04-06T00:00:00.000Z",
  "reasonCode": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason",
        "code": "doctor_plan_followup"
      }
    ],
    "text": "Seguimiento indicado por el médico"
  },
  "restriction": {
    "period": {
      "end": "2026-04-05T12:00:00.000Z"
    }
  }
}
```

## Package API

```ts
// Inbound
mapBundleToBatches(bundle: unknown, options: { clinicId: ClinicId | string; receivedAt: Date }): {
  batches: readonly ClinicalBatch[];
  resources: readonly { patientId: PatientId; resource: FhirResourceJson }[]; // for ClinicalRecordRepository.saveResource
  contextResources: readonly FhirResourceJson[]; // Practitioner, Organization, ...: not patient-scoped
  issues: OperationOutcome | undefined;
};
validateBundle(bundle: unknown): { ok: boolean; outcome: OperationOutcome | undefined };
buildConsultationBundle(input: ConsultationInput): Bundle; // what a host sends; used by the demo endpoint

// Outbound
expectationToTask(expectation: Expectation): Task;
caseToTask(followUpCase: FollowUpCase): Task;
patientConditionToFhir(condition: PatientCondition & { id?: string; evidence?: Evidence }): Condition;
qualityFindingToDetectedIssue(finding: QualityFinding): DetectedIssue;
caseEventToProvenance(event: CaseEvent): Provenance;
toSearchsetBundle(resources: readonly FhirResource[], options?: SearchsetOptions): Bundle;
toOperationOutcome(issues: readonly MappingIssue[]): OperationOutcome | undefined;

// Readers (lossless round trip)
taskToExpectation(task: Task, clinicId: ClinicId | string): Expectation;
taskToCase(task: Task, clinicId: ClinicId | string): FollowUpCase;
fhirToPatientCondition(condition: Condition, clinicId: ClinicId | string): PatientCondition & { id?: string; evidence?: Evidence };
```
