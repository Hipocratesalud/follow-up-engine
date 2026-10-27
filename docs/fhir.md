# FHIR R4 contract

The engine speaks HL7 FHIR R4 (4.0.1) in and out ([ADR 0001](adr/0001-fhir-r4-data-model.md)). Any EHR that can produce FHIR can plug in: it sends Bundles, the engine answers with `OperationOutcome`s, and exposes its own objects (expectations, cases, inferred conditions, documentation findings) as standard FHIR resources.

`@follow-up-engine/fhir` holds the whole contract as pure functions (no I/O, no clock, no randomness): it validates and maps inbound Bundles into core `ClinicalBatch`es and turns engine objects back into FHIR. The HTTP API only wires it.

- Inbound validation uses zod schemas typed against `@types/fhir` (`satisfies z.ZodType<Partial<fhir4.X>>`), so a schema that drifts from R4 fails to compile.
- Every resource the package emits, and every fixture it consumes, is validated in CI against the official [FHIR R4 JSON Schema](https://hl7.org/fhir/R4/fhir.schema.json.zip) (`packages/fhir/test/fhir-schema.test.ts`).
- The examples in this document are checked against the code by `packages/fhir/test/docs.test.ts`.

## Inbound

### What the host sends

One `transaction` (or `batch`) Bundle per saved consultation: the `Encounter`, the note (`DocumentReference` or `Composition`), orders (`ServiceRequest`), prescriptions (`MedicationRequest`), diagnoses (`Condition`) and, for a new patient, the `Patient`. Other host events arrive the same way: a result (`DiagnosticReport` and/or `Observation`), an appointment booked or cancelled (`Appointment`), a patient opt-out (`Patient` extension or `Consent`), and what came of a contact attempt the engine asked for (`Communication`, see [Closing the contact loop](#closing-the-contact-loop)). An opt-out stops patient contact only: the clinic keeps following the patient, and escalation goes to the coordinator instead of the patient.

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

| FHIR resource                                                                                                                          | Condition                                                                                                                                                                                                                                                                                                                                     | Clinical event                                                                                   | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `occurredAt`                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `Encounter`                                                                                                                            | `status = finished` (any status still groups the consultation)                                                                                                                                                                                                                                                                                | `encounter.finished`                                                                             | `practitionerId` from `participant.individual` (PPRF, then ATND, SPRF, PART, then any `Practitioner`); `specialty` from `serviceType`, else `type`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `period.end`, `period.start`                                         |
| `Appointment`                                                                                                                          | `status = booked`                                                                                                                                                                                                                                                                                                                             | `appointment.booked`                                                                             | `scheduledFor` = `start` (required); patient and practitioner from `participant.actor`; `specialty` from `specialty`, `serviceType`, `appointmentType`; `recordedAt` = `meta.lastUpdated`, which orders the versions of the Appointment (the latest wins: a reschedule replaces the earlier date, a booking made again after a cancellation stands)                                                                                                                                                                                                                                                                      | `created`, `meta.lastUpdated`                                        |
| `Appointment`                                                                                                                          | `status` in `cancelled`, `noshow`, `entered-in-error`                                                                                                                                                                                                                                                                                         | `appointment.cancelled`                                                                          | `scheduledFor` = `start`; `reason` = `no_show` or `entered_in_error` (absent for a cancellation). Reopens what the booking fulfilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `meta.lastUpdated`                                                   |
| `ServiceRequest`                                                                                                                       | `status = active` and `intent` in the order family (`order`, `original-order`, `reflex-order`, `filler-order`, `instance-order`)                                                                                                                                                                                                              | `service_request.created`                                                                        | `orderId` = resource id; `code`: LOINC coding first, then any coded value, then an uncoded placeholder (warning); `category`: SNOMED CT `108252007` laboratory, `363679005` imaging, else keywords in the category text, else `other`                                                                                                                                                                                                                                                                                                                                                                                    | `authoredOn`                                                         |
| `DiagnosticReport`                                                                                                                     | `status` in `final`, `amended`, `corrected`, `appended`                                                                                                                                                                                                                                                                                       | `result.received`                                                                                | `code` as above; `basedOnOrderId` from `basedOn` (ServiceRequest); `interpretation` combines the in-Bundle `Observation`s it lists (any abnormal wins, all normal gives normal); `value` is the `valueQuantity` of its single listed `Observation` of the same code, when there is one                                                                                                                                                                                                                                                                                                                                   | `issued`, `effectiveDateTime`, `effectivePeriod`                     |
| `Observation`                                                                                                                          | `status` in `final`, `amended`, `corrected`                                                                                                                                                                                                                                                                                                   | `result.received`                                                                                | `interpretation` from v3 ObservationInterpretation: `A`, `AA`, `H`, `HH`, `HU`, `L`, `LL`, `LU` abnormal; `N` normal; else unknown. `severity` of an abnormal result: `critical` for `AA`, `HH`, `LL` or an interpretation labelled critical / panic (also abnormal), else `mild`; a `DiagnosticReport` takes the worst of its listed `Observation`s. `value` from `valueQuantity` (`value`, `unit` else UCUM `code`). Without its own `basedOn`, inherits the order of the in-Bundle `DiagnosticReport` that lists it                                                                                                   | `issued`, `effectiveDateTime`, `effectiveInstant`, `effectivePeriod` |
| `MedicationRequest`                                                                                                                    | `status` in `active`, `completed`; `intent` in the order family or `plan`                                                                                                                                                                                                                                                                     | `medication.prescribed`                                                                          | `medication.text` from the concept text, display or code (or the `medicationReference` display / in-Bundle `Medication`); `medication.code` = first coded value, optional; `durationDays` from `dispenseRequest.expectedSupplyDuration`, else `timing.repeat.boundsDuration`, else the span of `boundsPeriod`; `refills` = `dispenseRequest.numberOfRepeatsAllowed`; `asNeeded` when a dosage has `asNeededBoolean: true` or `asNeededCodeableConcept`; `dosageText` = the `dosageInstruction.text` values; `startAt` = `boundsPeriod.start`, `validityPeriod.start`, `authoredOn`                                       | `authoredOn`                                                         |
| `Condition`                                                                                                                            | not `refuted`/`entered-in-error` (see `record.withdrawn`), not `inactive`/`resolved`/`remission`, has an ICD-10 or ICD-10-CM coding                                                                                                                                                                                                           | `condition.recorded`                                                                             | `code` under `http://hl7.org/fhir/sid/icd-10`; `verification`: `provisional`, `differential`, `unconfirmed` give provisional, anything else (including absent) confirmed                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `recordedDate`, `onsetDateTime`                                      |
| `DocumentReference`                                                                                                                    | `status = current`, `docStatus` not `preliminary`                                                                                                                                                                                                                                                                                             | `note.received`                                                                                  | text from inline `attachment.data` (base64, in the `charset` of `contentType`, UTF-8 by default; HTML reduced to text), else the narrative, else `description`; URLs are never fetched; `specialty` from `context.practiceSetting`, else the consultation's Encounter; `language` (BCP-47) from the read attachment's `language`, else the resource's `language` (invalid tag: warning, ignored; absent: the extractor detects it)                                                                                                                                                                                       | `date`, `context.period`                                             |
| `Composition`                                                                                                                          | `status` in `final`, `amended`                                                                                                                                                                                                                                                                                                                | `note.received`                                                                                  | `title` and every `section` (recursive) as plain text; `language` from `Composition.language`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `date`                                                               |
| `Patient`                                                                                                                              | engine opt-out extension with `valueBoolean: true`                                                                                                                                                                                                                                                                                            | `patient.opted_out`                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `meta.lastUpdated`                                                   |
| `Patient`                                                                                                                              | has `communication` (an empty list clears the language)                                                                                                                                                                                                                                                                                       | `patient.language_recorded`                                                                      | `language` = BCP-47 tag of the `preferred` communication, else of the first one with a tag: a `urn:ietf:bcp:47` coding, else any coding or text that is a tag (`es-VE`, `pt-BR`); none: warning, no language. The latest event wins; contact requests carry it                                                                                                                                                                                                                                                                                                                                                           | `meta.lastUpdated`                                                   |
| `Consent`                                                                                                                              | `status = active`, `provision.type = deny`, `category` has `https://hipocratesalud.com/fhir/CodeSystem/follow-up-consent#follow-up-opt-out`                                                                                                                                                                                                   | `patient.opted_out`                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `dateTime`                                                           |
| `Communication`                                                                                                                        | `basedOn` a `CommunicationRequest` of the clinic about the same patient (else an error, `not-found` / `value`)                                                                                                                                                                                                                                | a contact outcome (no clinical event): see [Closing the contact loop](#closing-the-contact-loop) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                      |
| `ServiceRequest`, `MedicationRequest`, `Condition`, `DocumentReference`, `Composition`, `DiagnosticReport`, `Observation`, `Encounter` | a later version that withdraws the resource: order `revoked`/`entered-in-error`; prescription `stopped`/`cancelled`/`entered-in-error`; diagnosis verification `refuted`/`entered-in-error`; note `entered-in-error` (status or `docStatus`) or `superseded`; result `cancelled`/`entered-in-error`; encounter `entered-in-error`/`cancelled` | `record.withdrawn`                                                                               | `reason`: `revoked`, `stopped`, `cancelled`, `refuted`, `superseded`, `entered_in_error`. The engine cancels the expectations the resource triggered (`closedReason: source_withdrawn`, their cases resolve as `not_needed`), reopens what it fulfilled, decides the condition it recorded again from the records of the diagnosis that remain (none left: `rejected` when refuted, `entered_in_error` otherwise), and ignores its earlier events. A withdrawn `DiagnosticReport` also withdraws the `Observation`s it lists (one event each), or, re-sent without its `result` list, the ones it listed when it arrived | `meta.lastUpdated`                                                   |

Missing clinical times fall back to the `receivedAt` the caller passes. `Medication`, `Practitioner`, `PractitionerRole`, `Organization`, `Location`, `Device`, `Specimen`, `RelatedPerson` and `HealthcareService` are context: resolved by reference, never reported, and returned as `contextResources` (references resolved) so the API can keep the host's directory of practitioners and organizations. Other resource types are ignored with an `information` issue.

### Robustness

One bad field never costs the host the rest of the consultation:

- Control characters (NUL, BEL, ...) and invalid Unicode in any string are removed, with a `warning` at the string's path; the same goes for text decoded from a base64 attachment. Postgres would refuse them, and they are never part of clinical text.
- A base64 attachment is decoded in the charset its `contentType` declares (`text/plain; charset=ISO-8859-1`, `windows-1252`, ...; UTF-8 when none). Bytes that are not valid in that charset become U+FFFD, with a `warning` at `attachment.data`, and the rest of the note is read; an unknown charset is read as UTF-8 with a `warning` at `attachment.contentType`. Only data that is not base64 at all leaves the note without text.
- `Bundle.entry.request.method` must be `POST` or `PUT` (or absent). `DELETE`, `GET`, `HEAD` and `PATCH` are an `error` (`not-supported`) for their entry, never carried out and never read as a create: `405 Method Not Allowed` in a `batch-response`, the whole `transaction` rejected. To cancel an order or withdraw a note, send its new version with `status` `revoked` / `entered-in-error` (see `record.withdrawn` above).
- A string over 1 MB (FHIR's limit; attachment `data` excepted) is an `error` for its entry.
- Clinical dates must fall between 1900 and 2200 (`error` otherwise: a year-9999 typo would give due dates that are not valid FHIR). On live ingestion (`receivedAt` is the real receipt time) an event dated more than a year after receipt is an `error`, more than a day after it a `warning`; scheduled dates (an appointment) may be up to five years ahead.
- A `ServiceRequest` without a recognizable `category` takes `laboratory` from a well-known LOINC laboratory code (HbA1c, glucose, lipids, creatinine, TSH, CBC, ...; the list is `LABORATORY_LOINC_CODES`) or `imaging` from a LOINC imaging study name (`XR`, `CT`, `MR`, `US`, ...), with a `warning`; otherwise it stays `other` (no result expectation), also with a `warning` that says so.

The API also caps request bodies at 5 MB (`413`, an `OperationOutcome` with code `too-costly`).

### Idempotency

Every event carries `idempotencyKey = <resourceType>/<id>/<version>#<event type>`, where `<version>` is `meta.versionId`, else `meta.lastUpdated`, else a 64-bit FNV-1a hash of the canonical JSON of the resource (keys sorted, `meta` excluded, references already rewritten). Re-sending the same Bundle yields the same keys; changing a resource changes only its own key.

### Updates to resources already sent

Delivery is at least once and may reorder. A resource older than the stored one (lower numeric `meta.versionId`, else earlier `meta.lastUpdated`) is not stored and its events are not ingested: its transaction-response entry is `200 OK` with a `warning` (`conflict`, `details.coding.code = stale`) in `response.outcome`, the response carries `X-FollowUp-Stale: <count>` and `X-FollowUp-Summary` says how many versions were stale (a single-resource `POST`/`PUT` answers `200` with the newer stored resource and `X-FollowUp-Stale: true`). A new version can withdraw the resource (`record.withdrawn`, above). A note's new version (an amendment, `docStatus = amended`) is read again unless its text did not change, and its plan replaces the earlier version's: plan items the new version no longer asks for are superseded (`superseded_by_amended_note`); a `DocumentReference` whose `relatesTo` `replaces` another does the same for the replaced note (`note.received.replacesDocumentIds`). A resource re-sent with another `subject` moves: the old patient gets a `record.withdrawn` (`subject_changed`) that withdraws what was derived there, and the new patient gets its own expectations.

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

| Severity      | Meaning                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error`       | The entry cannot be mapped (rejects a `transaction`).                                                                                                                                                                              |
| `warning`     | Mapped with a stated assumption (uncoded order, Condition without ICD-10, unreadable attachment, control characters removed, order category inferred, date in the future, follow-up event dated more than 90 days before receipt). |
| `information` | No event by design (status, unsupported type, entry without resource).                                                                                                                                                             |

## Outbound

### Expectation → `Task`

| Element                       | Value                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                          | expectation id                                                                                                                                   |
| `intent`                      | `plan`                                                                                                                                           |
| `code`                        | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation#<ruleId>`, text = Spanish reason label                                         |
| `status`                      | `open` → `requested`, `fulfilled` → `completed`, `superseded`/`cancelled` → `cancelled`, `expired` → `failed`                                    |
| `businessStatus`              | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation-status#<exact engine status>`                                                  |
| `statusReason`                | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-closed-reason#<closedReason>`; always `expired_unmet` for an `expired` one                 |
| `focus`                       | the triggering resource; also `basedOn` when it is a request (`ServiceRequest`, `MedicationRequest`, `CarePlan`, `Appointment`, `DeviceRequest`) |
| `for`                         | `Patient/<patientId>`                                                                                                                            |
| `partOf`                      | `Task/<caseId>` once grouped into a case                                                                                                         |
| `restriction.period.end`      | `dueAt`                                                                                                                                          |
| `executionPeriod`             | `createdAt` to `closedAt` (an `expired` one: to when it expired)                                                                                 |
| `authoredOn` / `lastModified` | `createdAt` / `updatedAt`                                                                                                                        |
| `reasonCode`                  | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason#<reason.code>`, text = label                                                        |
| `identifier`                  | `https://hipocratesalud.com/fhir/NamingSystem/follow-up-expectation-key` = idempotency key                                                       |
| extensions                    | layer, rule version, protocol id and version, origin, match key, evidence (quote + source document)                                              |

### Case → `Task`

| Element           | Value                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | case id                                                                                                                                                                          |
| `intent`          | `proposal` (the engine suggests; the clinic decides)                                                                                                                             |
| `code`            | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-task-type#follow-up-case`                                                                                                  |
| `status`          | `open`/`notified` → `ready`, `snoozed` → `on-hold`, `escalated` → `in-progress`, `resolved` → `completed`, `dismissed` → `cancelled`, `lost_to_follow_up` → `failed`             |
| `businessStatus`  | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-status#<exact engine status>`                                                                                         |
| `priority`        | numeric priority ≥ 90 `stat`, ≥ 75 `asap`, ≥ 60 `urgent`, else `routine` (`CASE_PRIORITY_THRESHOLDS`); the number itself in the priority-score extension                         |
| `owner`           | the assignee as a logical reference (`https://hipocratesalud.com/fhir/NamingSystem/host-user`)                                                                                   |
| `input[]`         | one per reason: `type` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-reason#<reasonCode>`, `valueReference` = `Task/<expectationId>`                                   |
| `statusReason`    | `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-resolution#<resolution kind>`; a dismissed case: `.../follow-up-dismiss-reason#<reason>`                              |
| `executionPeriod` | `createdAt` to `resolution.resolvedAt`                                                                                                                                           |
| extensions        | escalation step, escalation policy, priority score, dedup key, origin, release at, next action at, snoozed until, resolution (kind, resolvedAt, resolvedBy, note, dismissReason) |

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

`status = preliminary`, `severity = low`, `code` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-quality-finding#note-without-plan` (the note has no follow-up plan) or `#note-truncated` (the note was longer than the extractor reads: its head and its tail were read, its middle was not, so the plan may be incomplete), `patient`, `identifiedDateTime` = `detectedAt`, `implicated` = the document. A suggestion to the clinician, never to the patient.

### Clinical finding → `DetectedIssue`

Only **live** findings (a category the clinical team validated) are in `GET /fhir/DetectedIssue?patient=`; shadow findings are never exported to the host. The staff's batch review reads any finding with `GET /api/inbox/findings/{id}/fhir`. See [reviewer.md](reviewer.md).

- `code`: `https://hipocratesalud.com/fhir/CodeSystem/clinical-finding-category#<category>` (`lab-trend`, `drug-interaction`, ...), with `text` the one-line summary.
- `severity`: `high`, `moderate` or `low`.
- `status`: `preliminary` until reviewed, `final` when marked relevant or already known, `cancelled` when not relevant or expired.
- `patient`, `identifiedDateTime`, and `author`: a `Device`, the clinical reviewer.
- `implicated`: the cited resources (`Observation/...`, `DocumentReference/...`, `MedicationRequest/...`, `Condition/...`).
- `evidence[0].detail[]`: one reference per citation, its `display` the verbatim quote (checked against the document before the finding was stored).
- `detail`: the rationale.
- `mitigation[0].action.text`: the suggestion; with `date` and `author` once a clinician reviewed it.
- Extensions: `clinical-finding-mode` (`valueCode` `shadow` or `live`), `clinical-finding-already-covered` (`valueBoolean`: an open expectation or case already covers it), `clinical-finding-origin` (`valueCode` `confirmed`, `added` or `fallback`), `clinical-finding-model` (`valueString`: model and prompt version).

A suggestion to the clinician, never to the patient.

### Case event → `Provenance`

`target` = the case `Task`; `recorded` and `occurredDateTime` = `at`; `activity` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-case-event#<type>`; one `agent` (type `performer`): a user is a logical reference in `https://hipocratesalud.com/fhir/NamingSystem/host-user`, a patient is `Patient/<id>`, a rule is a `Device` identified in `https://hipocratesalud.com/fhir/NamingSystem/follow-up-rule`, the engine is a `Device` in `https://hipocratesalud.com/fhir/NamingSystem/follow-up-engine`. The structured payload (ids and codes only) is JSON in the case-event-payload extension. Case events have no id of their own, so the id is derived from case, type, time and a hash of actor and payload.

### Closing the contact loop

Each attempt to reach a patient is a `CommunicationRequest`; what came of it is a `Communication`. The engine writes the first, the host (or the clinic team, for a call recorded in the inbox) the second. Examples in [Example: closing the contact loop](#example-closing-the-contact-loop); the host side, message by message, in [integration.md](integration.md#4-closing-the-loop).

**Contact attempt → `CommunicationRequest`** (`contactRequestToFhir`):

| Element              | Value                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basedOn`            | the case `Task`                                                                                                                                                                        |
| `language`           | the patient's preferred language when it was asked (`Patient.communication`, BCP-47): the host writes the message in it; absent when the host never stated one                         |
| `status`             | `active` while waiting; `completed` once an outcome concluded it (answered, or no answer / wrong number); `revoked` when its case closed before that                                   |
| `category`           | `https://hipocratesalud.com/fhir/CodeSystem/contact-purpose#<purpose>` (`schedule_follow_up`, `complete_pending_test`, `review_results`, `medication_review`)                          |
| `medium`             | the channel hint: `.../CodeSystem/contact-channel#<whatsapp\|phone_call\|sms\|email>` plus the HL7 v3 ParticipationMode (`ONLINEWRIT`, `PHONE`, `EMAILWRIT`); absent: the host chooses |
| `payload`            | one generic sentence of the purpose (`CONTACT_PURPOSE_TEXT`): never a diagnosis, a test or a note                                                                                      |
| `occurrenceDateTime` | the answer deadline (`dueBy`): no answer by then counts as unanswered                                                                                                                  |
| `authoredOn`         | when the engine (or a user) asked                                                                                                                                                      |
| `requester`          | the engine (`Device`, `NamingSystem/follow-up-engine`) for a policy step, else the user (`NamingSystem/host-user`)                                                                     |
| extensions           | `contact-attempt` (1-based number in the case), `contact-trigger` (`policy`, `user`, `wrong_number`), `follow-up-escalation-step` (the policy step)                                    |

**Contact outcome ← `Communication`** (inbound, then `communicationToFhir` outbound):

| Element                                                  | Read as                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basedOn`                                                | required: `CommunicationRequest/<id>` of the clinic. Unknown or another clinic's: `not-found` at `basedOn` (a transaction is rejected, a batch entry answered `400`); another patient's: `value` at `subject`                |
| `extension:contact-outcome`                              | `valueCodeableConcept` in `https://hipocratesalud.com/fhir/CodeSystem/contact-outcome`: `delivered`, `read`, `replied`, `booked`, `declined`, `treated_elsewhere`, `wrong_number`, `no_answer` (an unknown code is an error) |
| `statusReason`                                           | the same codes, accepted when the extension is absent                                                                                                                                                                        |
| `status`                                                 | any R4 event status; `not-done` without an outcome = `no_answer`; `entered-in-error` withdraws what that Communication said; a status-only update (`in-progress`) records nothing new                                        |
| `medium`                                                 | the channel (engine code or ParticipationMode `PHONE` / `EMAILWRIT`); else the attempt's                                                                                                                                     |
| `sent`, `received`, `meta.versionId`, `meta.lastUpdated` | kept; versions follow the same order as every resource: an older version is ignored, the same one again changes nothing                                                                                                      |

The strongest outcome of an attempt decides it (`delivered` < `read` < `no_answer` < `wrong_number` < `replied` < `booked` = `declined` = `treated_elsewhere`), so the host may send one `Communication` per update or new versions of one. Outbound, a `Communication` also has `about` = the case `Task`, the outcome in `statusReason` when it did not reach the patient, and `sender` = the clinic user for a call recorded in the inbox.

**Rule suppressed for a patient → `Flag`** (`suppressionToFlag`): `category` = `https://hipocratesalud.com/fhir/CodeSystem/follow-up-flag-category#follow-up-suppression`; `code` = the rule in `CodeSystem/follow-up-expectation` (with its label); `status` `active`, `inactive` once reactivated ("Volver a activar"), with `period.start` / `period.end`; `author` = the user; extensions `follow-up-dismiss-reason`, `follow-up-source-case` (the dismissed case `Task`), `follow-up-note`, `follow-up-revoked-by`. `GET /fhir/Flag?patient=` lists them.

### Searchset

`toSearchsetBundle(resources, { baseUrl, total, selfUrl, nextUrl, previousUrl, timestamp, outcome })` wraps any list: `type = searchset`, `search.mode = match`, absolute `fullUrl` when `baseUrl` is given, an `OperationOutcome` entry with `search.mode = outcome` when the search has issues (an ignored parameter), no `entry` when empty.

## Engine terminology

Base: `https://hipocratesalud.com/fhir`. Every engine-defined CodeSystem, NamingSystem and extension lives under it, including the codes used by `config/` (protocols) and the synthetic fixtures of `@follow-up-engine/testkit` (`ENGINE_FHIR_BASE` in both packages, checked by a test).

| CodeSystem                                | Codes                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodeSystem/follow-up-expectation`        | rule ids (`lab_order_result_pending`, `doctor_plan_followup`, `protocol_diabetes_hba1c`, ...)                                                                                                                                                           |
| `CodeSystem/follow-up-task-type`          | `follow-up-case`                                                                                                                                                                                                                                        |
| `CodeSystem/follow-up-expectation-status` | `open`, `fulfilled`, `superseded`, `expired`, `cancelled`                                                                                                                                                                                               |
| `CodeSystem/follow-up-case-status`        | `open`, `notified`, `snoozed`, `escalated`, `resolved`, `dismissed`, `lost_to_follow_up`                                                                                                                                                                |
| `CodeSystem/follow-up-closed-reason`      | the engine's `closedReason` codes                                                                                                                                                                                                                       |
| `CodeSystem/follow-up-case-resolution`    | `fulfilled`, `handled_outside`, `not_needed`, `patient_declined`, `patient_unreachable`                                                                                                                                                                 |
| `CodeSystem/follow-up-reason`             | reason codes from rules and protocols                                                                                                                                                                                                                   |
| `CodeSystem/follow-up-quality-finding`    | `note-without-plan`, `note-truncated`                                                                                                                                                                                                                   |
| `CodeSystem/clinical-finding-category`    | `pre-visit-question`, `lab-trend`, `vital-trend`, `abnormal-result-no-followup`, `drug-interaction`, `drug-condition-conflict`, `unaddressed-symptom`, `missing-screening`, `record-quality`, `utilization-change`, `similar-patients`                  |
| `CodeSystem/follow-up-case-event`         | `opened`, `reason_added`, `released`, `notified`, `assigned`, `snoozed`, `escalated`, `patient_contact_requested`, `contact_attempt_skipped`, `contact_outcome_recorded`, `resolved`, `dismissed`, `reopened`, `lost_to_follow_up`, `feedback_recorded` |
| `CodeSystem/specialty`                    | specialty codes a host may send (`diabetology`, `cardiology`, `psychology`, `gynecology`, ...)                                                                                                                                                          |
| `CodeSystem/follow-up-consent`            | `follow-up-opt-out`                                                                                                                                                                                                                                     |
| `CodeSystem/uncoded`                      | slug of the text of an order or result that arrived without a code                                                                                                                                                                                      |
| `CodeSystem/procedure`                    | local procedure codes protocols expect when no standard code fits (`fundus-exam`)                                                                                                                                                                       |
| `CodeSystem/contact-outcome`              | `delivered`, `read`, `replied`, `booked`, `declined`, `treated_elsewhere`, `wrong_number`, `no_answer`                                                                                                                                                  |
| `CodeSystem/contact-channel`              | `whatsapp`, `phone_call`, `sms`, `email`                                                                                                                                                                                                                |
| `CodeSystem/contact-purpose`              | `schedule_follow_up`, `complete_pending_test`, `review_results`, `medication_review`                                                                                                                                                                    |
| `CodeSystem/follow-up-dismiss-reason`     | `handled_elsewhere`, `already_done`, `not_applicable_to_patient`, `wrong_diagnosis`, `wrong_interval`, `other`                                                                                                                                          |
| `CodeSystem/follow-up-flag-category`      | `follow-up-suppression`                                                                                                                                                                                                                                 |

| Extension (`StructureDefinition/...`) | On                            | Value                                                                                                                                              |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follow-up-opt-out`                   | Patient (inbound)             | `valueBoolean`                                                                                                                                     |
| `follow-up-layer`                     | Task (expectation)            | `valueCode`: `universal`, `doctor_plan`, `cadence`, `protocol`                                                                                     |
| `follow-up-rule-version`              | Task (expectation)            | `valueString`                                                                                                                                      |
| `follow-up-protocol-id`               | Task (expectation)            | `valueString`                                                                                                                                      |
| `follow-up-protocol-version`          | Task (expectation)            | `valueString`                                                                                                                                      |
| `follow-up-match-key`                 | Task (expectation)            | `valueString`                                                                                                                                      |
| `follow-up-origin`                    | Task                          | `valueCode`: `live`, `backfill`                                                                                                                    |
| `follow-up-evidence`                  | Task (expectation), Condition | complex: `quote` (`valueString`), `source` (`valueReference` DocumentReference)                                                                    |
| `follow-up-escalation-step`           | Task (case)                   | `valueInteger`                                                                                                                                     |
| `follow-up-priority-score`            | Task (case)                   | `valueInteger`                                                                                                                                     |
| `follow-up-dedup-key`                 | Task (case)                   | `valueString`                                                                                                                                      |
| `follow-up-release-at`                | Task (case)                   | `valueDateTime`                                                                                                                                    |
| `follow-up-next-action-at`            | Task (case)                   | `valueDateTime`                                                                                                                                    |
| `follow-up-snoozed-until`             | Task (case)                   | `valueDateTime`                                                                                                                                    |
| `follow-up-escalation-policy`         | Task (case)                   | `valueString`: the named, versioned policy the case follows (`default_v2`)                                                                         |
| `follow-up-case-resolution`           | Task (case)                   | complex: `kind` (`valueCode`), `resolvedAt` (`valueDateTime`), `resolvedBy` (`valueString`), `note` (`valueString`), `dismissReason` (`valueCode`) |
| `contact-outcome`                     | Communication                 | `valueCodeableConcept` in `CodeSystem/contact-outcome`                                                                                             |
| `contact-attempt`                     | CommunicationRequest          | `valueInteger`: attempt number within the case                                                                                                     |
| `contact-trigger`                     | CommunicationRequest          | `valueCode`: `policy`, `user`, `wrong_number`                                                                                                      |
| `follow-up-dismiss-reason`            | Flag                          | `valueCode` in `CodeSystem/follow-up-dismiss-reason`                                                                                               |
| `follow-up-source-case`               | Flag                          | `valueReference`: the dismissed case `Task`                                                                                                        |
| `follow-up-note`                      | Flag                          | `valueString`: the team's internal note                                                                                                            |
| `follow-up-revoked-by`                | Flag                          | `valueString` (host user id who reactivated the rule)                                                                                              |
| `follow-up-confidence`                | Condition                     | `valueDecimal` 0..1                                                                                                                                |
| `follow-up-condition-source`          | Condition                     | `valueCode`: `recorded`, `inferred_from_medication`, `inferred_from_result`, `extracted_from_note`                                                 |
| `follow-up-confirmed-by`              | Condition                     | `valueString` (host user id)                                                                                                                       |
| `follow-up-refuted-by`                | Condition (`refuted`)         | `valueString` (host user id of the clinician who rejected it)                                                                                      |
| `follow-up-case-event-payload`        | Provenance                    | `valueString` (JSON)                                                                                                                               |
| `clinical-finding-mode`               | DetectedIssue (clinical)      | `valueCode`: `shadow` or `live`                                                                                                                    |
| `clinical-finding-already-covered`    | DetectedIssue (clinical)      | `valueBoolean`: an open expectation or case already covers it                                                                                      |
| `clinical-finding-origin`             | DetectedIssue (clinical)      | `valueCode`: `confirmed`, `added` or `fallback`                                                                                                    |
| `clinical-finding-model`              | DetectedIssue (clinical)      | `valueString`: model and prompt version                                                                                                            |

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
      "language": "es",
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
    "text": "Follow-up the doctor ordered"
  },
  "description": "Follow-up the doctor ordered",
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
    "text": "Follow-up the doctor ordered"
  },
  "restriction": {
    "period": {
      "end": "2026-04-05T12:00:00.000Z"
    }
  }
}
```

## Example: closing the contact loop

The `default_v2` WhatsApp attempt of a case (`contactRequestToFhir`, `packages/fhir/test/domain-fixtures.ts`):

```json
{
  "resourceType": "CommunicationRequest",
  "id": "cr-0001",
  "extension": [
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/contact-attempt",
      "valueInteger": 1
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/contact-trigger",
      "valueCode": "policy"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-escalation-step",
      "valueInteger": 2
    }
  ],
  "basedOn": [
    {
      "reference": "Task/case-0001",
      "type": "Task"
    }
  ],
  "status": "active",
  "category": [
    {
      "coding": [
        {
          "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-purpose",
          "code": "schedule_follow_up"
        }
      ]
    }
  ],
  "priority": "routine",
  "medium": [
    {
      "coding": [
        {
          "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-channel",
          "code": "whatsapp"
        },
        {
          "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationMode",
          "code": "ONLINEWRIT"
        }
      ]
    }
  ],
  "subject": {
    "reference": "Patient/pat-dm-0001",
    "type": "Patient"
  },
  "recipient": [
    {
      "reference": "Patient/pat-dm-0001",
      "type": "Patient"
    }
  ],
  "payload": [
    {
      "contentString": "Ask the patient to schedule their follow-up visit."
    }
  ],
  "occurrenceDateTime": "2026-04-27T12:00:00.000Z",
  "authoredOn": "2026-04-20T12:00:00.000Z",
  "requester": {
    "type": "Device",
    "identifier": {
      "system": "https://hipocratesalud.com/fhir/NamingSystem/follow-up-engine",
      "value": "follow-up-engine"
    },
    "display": "Follow-up Engine"
  }
}
```

The host reports that the message reached a wrong number (a `not-done` `Communication`, as `communicationToFhir` returns it): the engine flags the patient's contact data and moves the front-desk call forward.

```json
{
  "resourceType": "Communication",
  "id": "wa-msg-0002",
  "meta": {
    "versionId": "1",
    "lastUpdated": "2026-04-20T13:00:00.000Z"
  },
  "extension": [
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/contact-outcome",
      "valueCodeableConcept": {
        "coding": [
          {
            "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-outcome",
            "code": "wrong_number"
          }
        ]
      }
    }
  ],
  "basedOn": [
    {
      "reference": "CommunicationRequest/cr-0001",
      "type": "CommunicationRequest"
    }
  ],
  "status": "not-done",
  "statusReason": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-outcome",
        "code": "wrong_number"
      }
    ]
  },
  "medium": [
    {
      "coding": [
        {
          "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-channel",
          "code": "whatsapp"
        },
        {
          "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationMode",
          "code": "ONLINEWRIT"
        }
      ]
    }
  ],
  "subject": {
    "reference": "Patient/pat-dm-0001",
    "type": "Patient"
  },
  "about": [
    {
      "reference": "Task/case-0001",
      "type": "Task"
    }
  ],
  "sent": "2026-04-20T12:01:00.000Z"
}
```

The team dismissed a case as not applicable to the patient and stopped the reminder for them (`suppressionToFlag`):

```json
{
  "resourceType": "Flag",
  "id": "sup-0001",
  "extension": [
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-dismiss-reason",
      "valueCode": "not_applicable_to_patient"
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-source-case",
      "valueReference": {
        "reference": "Task/case-0004",
        "type": "Task"
      }
    },
    {
      "url": "https://hipocratesalud.com/fhir/StructureDefinition/follow-up-note",
      "valueString": "Paciente con enucleación bilateral."
    }
  ],
  "status": "active",
  "category": [
    {
      "coding": [
        {
          "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-flag-category",
          "code": "follow-up-suppression"
        }
      ],
      "text": "Follow-up reminder suppressed for this patient"
    }
  ],
  "code": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation",
        "code": "protocol_diabetes_fundus",
        "display": "Yearly eye fundus exam due"
      }
    ],
    "text": "Yearly eye fundus exam due"
  },
  "subject": {
    "reference": "Patient/pat-dm-0001",
    "type": "Patient"
  },
  "period": {
    "start": "2026-04-15T10:00:00.000Z"
  },
  "author": {
    "type": "Practitioner",
    "identifier": {
      "system": "https://hipocratesalud.com/fhir/NamingSystem/host-user",
      "value": "user-doctor-7"
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
  communications: readonly BundleCommunication[]; // contact outcomes, checked and recorded by the runtime
  issues: OperationOutcome | undefined;
};
validateBundle(bundle: unknown): { ok: boolean; outcome: OperationOutcome | undefined };
buildConsultationBundle(input: ConsultationInput): Bundle; // what a host sends; used by the demo endpoint

// Outbound
expectationToTask(expectation: Expectation): Task;
caseToTask(followUpCase: FollowUpCase): Task;
patientConditionToFhir(condition: PatientCondition & { id?: string; evidence?: Evidence }): Condition;
qualityFindingToDetectedIssue(finding: QualityFinding): DetectedIssue;
clinicalFindingToDetectedIssue(finding: ClinicalFinding): DetectedIssue;
caseEventToProvenance(event: CaseEvent): Provenance;
contactRequestToFhir(request: ContactRequest, context?: { communications?; caseStatus? }): CommunicationRequest;
communicationToFhir(communication: ContactCommunication): Communication;
suppressionToFlag(suppression: RuleSuppression): Flag;
toSearchsetBundle(resources: readonly FhirResource[], options?: SearchsetOptions): Bundle;
toOperationOutcome(issues: readonly MappingIssue[]): OperationOutcome | undefined;

// Readers (lossless round trip)
taskToExpectation(task: Task, clinicId: ClinicId | string): Expectation;
taskToCase(task: Task, clinicId: ClinicId | string): FollowUpCase;
fhirToPatientCondition(condition: Condition, clinicId: ClinicId | string): PatientCondition & { id?: string; evidence?: Evidence };
```
