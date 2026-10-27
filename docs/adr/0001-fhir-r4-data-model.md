# 0001. FHIR R4 as the data model

- Status: Accepted
- Date: 2026-10-27

## Context

The engine must plug into any EHR, not only Hipócrates. A private schema would force every host to write a bespoke mapping and would make the engine's output hard to consume.

## Decision

The engine speaks HL7 FHIR R4 (4.0.1) in and out of its HTTP API.

- Hosts push `Encounter`, `Appointment`, `ServiceRequest`, `DiagnosticReport`/`Observation`, `MedicationRequest`, `Condition` and `DocumentReference`.
- Expectations and cases are FHIR `Task`s. FHIR's `status` keeps its standard meaning; engine-specific states (`open`, `expired`, `escalated`, `lost_to_follow_up`, ...) go in `businessStatus`.
- Inferred diagnoses are `Condition`s with a verification status; documentation-quality findings are `DetectedIssue`s; every engine-produced resource carries a `Provenance` that cites the source resources and the rule or model version.
- `packages/fhir` maps FHIR resources to normalized domain events; `packages/core` never depends on FHIR types.

R4 over R5: it is what EHRs, servers, validators and the US Core / IPS ecosystems actually ship today.

## Consequences

- Any FHIR-capable EHR can integrate without engine changes.
- Mapping lives in one package and is tested with synthetic bundles.
- R5-only features (for example `Task.requestedPerformer` refinements) are not used.
