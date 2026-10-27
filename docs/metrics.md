# Clinic metrics

What the engine did for a clinic over a period, and what it cost (HIP-141). Served as FHIR-free JSON for the inbox by `GET /api/inbox/metrics?from=&to=` (scope `inbox:read`) and shown in the inbox's **Metrics** view.

```
GET /api/inbox/metrics?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z
```

- `from` (inclusive) and `to` (exclusive) are ISO 8601 date-times. `to` defaults to now included (the engine clock, so the demo's simulated date), `from` to 30 days before `to`. A period that does not start before it ends, or is longer than 800 days, is a `422`.
- `asOf` in the answer is the engine clock when the numbers were computed.

## How it is computed

`engine.metrics(clinicId, period)` loads what it needs through one port, `MetricsReadModel` (`packages/core/src/ports/metrics-read-model.ts`, memory and Postgres adapters, the same contract suite on both), in one read transaction scoped to the clinic, and hands it to a pure function, `computeClinicMetrics` (`packages/core/src/engine/metrics/metrics.ts`): no clock, no I/O, the same input always gives the same numbers. Two kinds of numbers:

- **Cohort numbers** follow the cases that **reached the inbox in the period**: created in it, or, for a backfill case held among the patients to recover, released in it (`releaseAt`). What happened to them counts whenever it happened, up to `asOf`. A case that opened on the last day of January and was booked on February 3 counts as booked in January's numbers once February 3 has passed.
- **Activity numbers** count what happened in the period itself: model calls and their cost, clinical review runs, clinicians' reviews of what the engine read from notes.

A rate is absent (not 0) when its denominator is 0. Money is USD, as the `llm_gateway` accounts it (the `fake` provider is free: the demo shows calls and tokens with $0).

## Attribution of bookings

Every number about bookings rests on the booking's **origin**, which the host states on the FHIR `Appointment` and the engine verifies ([fhir.md](fhir.md#attribution-of-bookings), [integration.md](integration.md#saying-where-a-booking-came-from)):

| Origin            | Meaning                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `follow_up_case`  | booked by the team while working the case                                                                                      |
| `patient_contact` | booked after a contact attempt the engine asked for                                                                            |
| `organic`         | nothing ties it to the case: an unattributed booking that fulfilled one of its reasons, or a claim the engine could not verify |

The case trail records each booking that concerns a case (`appointment_booked`: attributed to it, or fulfilling one of its reasons), the booking that resolved it (`resolved.appointmentOrigin`) and the visit that kept it (`appointment_attended`, decided by the recheck at the appointment date plus `bookingVisitGraceDays`). When a case has several bookings, the strongest origin counts: `patient_contact`, then `follow_up_case`, then `organic`. A contact request made once for the patient from the inbox card names its most urgent case, and every other case of the patient records it (`sharedFromCaseId`): a booking that answers it is `patient_contact` on each of those cases.

## Definitions

### `cases` (cohort)

| Field                                               | Definition                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `opened`                                            | Cases that reached the inbox in the period                                        |
| `live`, `backfill`                                  | `opened` by origin: live traffic, or the initial backfill of the clinic's history |
| `active`, `resolved`, `dismissed`, `lostToFollowUp` | `opened` by status at `asOf` (`active`: open, notified, snoozed or escalated)     |

### `bookings` (cohort)

| Field               | Definition                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booked`            | Cases with at least one `appointment_booked`, split by origin (`followUpCase`, `patientContact`, `organic`; `total` is the sum)                                                                   |
| `attended`          | Cases with at least one `appointment_attended`, split by the origin of the booking it kept                                                                                                        |
| `resolvedByBooking` | Cases resolved `fulfilled` by a booking: the origin named on the resolution, else the strongest booking that fulfilled a reason. An unattributed booking that resolves a case counts as `organic` |
| `bookedRate`        | `booked.total / cases.opened`                                                                                                                                                                     |
| `attendedRate`      | `attended.total / booked.total`                                                                                                                                                                   |
| `attributedShare`   | `(booked.followUpCase + booked.patientContact) / booked.total`: the bookings the engine can claim                                                                                                 |

### `timeToFirstAction` (cohort)

From when the case reached the inbox (`releaseAt` for a held backfill case, else `createdAt`) to its **first action**: the first event on its trail by a clinic user (assign, notify, snooze, call, resolve, dismiss, a verdict) or the first contact request, whoever asked for it (the escalation policy's included).

| Field                                 | Definition                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measured`                            | Cases with a first action                                                                                                                               |
| `pending`                             | Cases with none at `asOf`                                                                                                                               |
| `medianHours`, `p75Hours`, `p90Hours` | Quantiles of the hours to the first action of the `measured` cases, linear interpolation between closest ranks (R type 7, numpy's default), one decimal |

### `feedback` (cohort)

The clinicians' verdicts on the cohort's cases, the **latest verdict per case** (the same rule as the calibration report and the inbox stats: changing one's mind does not count twice).

| Field                 | Definition                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `casesWithFeedback`   | Cases with a verdict                                                                                      |
| `useful`, `notUseful` | By the latest verdict                                                                                     |
| `usefulRate`          | `useful / casesWithFeedback`                                                                              |
| `notUsefulReasons`    | Not-useful verdicts by reason (dismissals included: a dismissal records its reason as the case's verdict) |

### `dismissals` (cohort)

| Field      | Definition                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `total`    | Cases dismissed by the team ("Descartar")                                                                                                                                      |
| `byReason` | By the dismiss reason (`handled_elsewhere`, `already_done`, `not_applicable_to_patient`, `wrong_diagnosis`, `wrong_interval`, `other`). Per rule, `GET /api/inbox/calibration` |

### `extractionReviews` (activity)

What the doctors corrected of what the engine read from notes.

| Field                                          | Definition                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditions.reviewed`                          | Conditions read from a note (`extracted_from_note`) that a clinician confirmed or rejected in the period                                                                                                                                                          |
| `conditions.confirmed`, `rejected`             | `reviewed` by verdict                                                                                                                                                                                                                                             |
| `conditions.pendingReview`                     | Conditions read from notes still `probable` and unreviewed at `asOf`                                                                                                                                                                                              |
| `conditions.confirmRate`, `rejectRate`         | Over `reviewed`. `rejectRate` is the share of extractions the doctor corrected                                                                                                                                                                                    |
| `planItems.confirmed`, `corrected`, `rejected` | Plan item reviews (`plan_item_confirmed`, `plan_item_corrected`, `plan_item_rejected`) recorded in the period, read from the plan item review log (`plan_item_reviews`): it also covers an item reviewed before it became a case, which the case trail never sees |
| `planItems.correctionRate`                     | `(corrected + rejected) / total`                                                                                                                                                                                                                                  |

### `aiCost`

| Field                       | Kind     | Definition                                                                                                                                                                                                                                                                   |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalUsd`, `calls`         | activity | Every model call of the clinic in the period (`llm_calls`, retries and failures included)                                                                                                                                                                                    |
| `byTask`                    | activity | The same by gateway task (`note_extraction`, `clinical_review`, ...): calls, successful calls, input and output tokens, cost                                                                                                                                                 |
| `attributedToCasesUsd`      | cohort   | What reading the notes behind the cohort's cases cost: each note's extraction cost (`plan.extracted.extractor.costUsd`, every version of the note summed) charged once to the cases whose reasons came from it (a doctor's-plan reason, or any reason triggered by the note) |
| `casesWithAttributedCost`   | cohort   | Cases with at least one reason read from a note                                                                                                                                                                                                                              |
| `perCaseUsd`                | cohort   | `attributedToCasesUsd / casesWithAttributedCost`: note reading per case that came from a note                                                                                                                                                                                |
| `allInPerCaseUsd`           | mixed    | `totalUsd / cases.opened`: every call of the period loaded onto the cases it produced (reading notes that opened no case included)                                                                                                                                           |
| `reviewRuns`, `reviewerUsd` | activity | Clinical review runs started in the period and their cost (`clinical_review_runs`)                                                                                                                                                                                           |
| `perReviewRunUsd`           | activity | `reviewerUsd / reviewRuns`                                                                                                                                                                                                                                                   |

### `backfill` (cohort)

| Field               | Definition                                                                   |
| ------------------- | ---------------------------------------------------------------------------- |
| `cases`             | Cohort cases from the initial backfill (released to the inbox in the period) |
| `recoveredCases`    | Of those, resolved `fulfilled`: the overdue visit or test took place         |
| `recoveredPatients` | Distinct patients of `recoveredCases`: patients the backfill brought back    |

## Rule and protocol versions on the case

Every reason of a case says which versioned rule (and protocol) produced it, so a number can be traced back to the configuration that made it: the inbox shows "Rule `protocol_diabetes_hba1c` · version 1.2.0 · Protocol `diabetes` · version 1.2.0" under each reason (`CaseReasonView.ruleVersion`, `protocol.version`), and the case FHIR `Task` carries a `follow-up-reason-rule` extension on each `input` ([fhir.md](fhir.md#case--task)).

## Tests

- `packages/core/src/engine/metrics/metrics.test.ts`: the arithmetic of every field on hand-built fixtures and a fixed fake clock.
- `packages/testkit/src/contracts/metrics-read-model.contract.ts`: the read model's queries, on memory and Postgres.
- `packages/acceptance/test/attribution.test.ts`: FHIR Appointments attributed to a case, to a contact attempt, organic, and an unverifiable claim, end to end on memory and Postgres, down to the metrics.
- `apps/api/src/metrics/metrics-routes.test.ts`: the endpoint, its defaults, validation and scoping.
