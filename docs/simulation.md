# 90-day outcome simulation: the order agent against fixed reminders

> Simulation with synthetic patients and stated assumptions; not a clinical trial.

## Headline (draft for the README)

**Orders fulfilled within 90 days: 50.6% with fixed reminders → 74.6% with the order agent, +24.0 points (95% interval +18.5 to +28.6 over 20 seeded runs of 400 synthetic patients per arm).**

Urgent orders (an abnormal result that asks for a visit within 7 days) are done within 7 days in 60.5% of cases with the agent against 3.4% with fixed reminders. Outside lab results the clinic never received go from 28.5% to 90.5% once someone asks for a photo. For a clinic with 200 patients a month leaving with orders, that is about 26 more attended consultations a month (95% interval 15 to 39), roughly USD 1,050 at an assumed USD 40 per consultation. Where nobody can be reached, the agent changes nothing: patients who never answer a message or a call finish 22.2% of their orders with the agent and 25.0% without it (the difference is noise around zero).

Full numbers: [docs/evals/simulation/2026-10-30.md](evals/simulation/2026-10-30.md). The inbox's **Value** page shows the same report, scaled to a clinic's own volume and price, next to that clinic's real attributed bookings.

Reproduce: `pnpm simulate` (about 25 seconds; deterministic, the same config and code give the same numbers).

## Method

- **Cohort.** Each seeded run draws synthetic patients one by one: a persona (below), an order set and a consultation day in the first 30 days. Order sets come from the engine's own catalog: a lab test (HbA1c, lipids, thyroid, renal panel, CBC, urinalysis, liver panel; the first LOINC code of the group in `TEST_GROUPS`), an imaging study (ultrasound, X-ray, mammography), a control visit the doctor wrote in the note ("control en 4 semanas", read by the engine's rule-based note reader), a lab test plus a control, or an abnormal result (the engine's `abnormal_result_followup`: a visit within 7 days, the agent's urgent track). Due dates are the engine's.
- **Arms.** Each patient goes to an arm by a hash of their id (50/50 here; the V2 PRD's production default is 10% control). What a patient is like never depends on the arm.
  - **Control (usual care with fixed reminders):** one generic message when an order is due and one 7 days later, under the same contact cap. No booking help, no ladder, no staff task, no way to send a result back. A patient who engages books or does the test on their own, with their persona's probability.
  - **Agent:** the order agent's real policy code from `packages/core/src/engine/order-agent`: the no-response ladder (`LADDER`, `dueRungs`, `startTrack`; routine 0/4/9 days, reception call at 14, unreachable at 21 and a retry 30 days later), the urgent track (0 h, 1 day, high-priority call at 2 days, notice to the doctor at 3), the undelivered track (update the phone, then another contact), the contact cap (`contactPolicy`: at most 2 proactive messages per 7 days, replies inside 24 hours do not count), slots from the synthetic schedule (`availableSlots`: earliest, another time of day, Saturday), booking on the patient's "yes", results from a photo, and the rule that a booked or answered order is no longer chased.
- **The patient's side of the conversation** is a persona model, not a language model: whether the patient replies to the k-th message, whether an offered slot fits, whether they opt out, send a photo, answer a call or show up.
- **Fulfilment is the engine's.** Every booking, visit and result is a FHIR R4 `transaction` Bundle (`Appointment`, `Encounter`, `Observation`) through the same ingestion as `POST /fhir`, on the engine's memory adapters with a fake clock; the engine's deadline watcher runs every simulated day. At day 90 the simulation reads each order's expectation back: "fulfilled" is the engine's status. The resource that closed it (its id carries the path: agent booking, staff call, photo, reminder, or the patient on their own) says how. A test drops every write and checks that nothing is then fulfilled.
- **Intervals.** 20 seeds; every metric is the mean over seeds with the 2.5th and 97.5th percentiles across seeds. Differences are paired by seed (both arms share the clinic and the engine of a run).

## Personas

| Persona                     | Share | Behaviour                                                                     | Control → agent (orders fulfilled) |
| --------------------------- | ----- | ----------------------------------------------------------------------------- | ---------------------------------- |
| Fast responder              | 30%   | Answers the first message, takes a slot that fits                             | 82.2% → 93.8%                      |
| Needs a second try          | 15%   | Misses the first message, answers a later one                                 | 51.1% → 83.7%                      |
| Only after the time changes | 12%   | Answers, but weekday mornings never suit; books on another time or a Saturday | 51.1% → 83.3%                      |
| Wrong number                | 6%    | Messages undelivered until reception finds the right number                   | 30.9% → 63.2%                      |
| Reads, never answers        | 10%   | Never writes back; picks up a call                                            | 27.3% → 57.8%                      |
| Never answers               | 12%   | Nothing reaches them                                                          | 25.0% → 22.2%                      |
| Opts out                    | 3%    | Asks the clinic to stop writing at the first reply                            | 33.6% → 41.2% (wide interval)      |
| Test done elsewhere         | 12%   | Did the test at an outside lab; sends a photo when asked                      | 28.5% → 90.5%                      |

Every number of a persona (reply curve, slot fit, self-completion, show-up, call answer, photo) is in [`config/simulation/simulation.v1.json`](../config/simulation/simulation.v1.json) next to its rationale.

## Assumptions (all of them are assumptions, none is a measurement)

- The persona mix and every probability are plausible values chosen by the team; no study is cited for them. A clinic's own control group (V2 PRD, workstream B) replaces them with measured outcomes.
- Without any contact, 10% to 60% of patients (by persona) complete an order on their own; urgent visits half as often, because the patient does not know the result is abnormal. The same draw applies in both arms, so an agent booking can only move a patient who would have done it anyway earlier, not count them twice.
- Reception completes 90% of the call tasks on their due day; 80% of the patients who answer a call book on it. Clinic capacity is not a constraint.
- Every result is normal: a result never opens a new abnormal follow-up during the window.
- The agent takes a test or an urgent visit at once and a control visit 14 days before it is due (the order agent has no start rule of its own yet).
- Recovered revenue counts only extra attended consultations at the configured price (USD 40 by default); lab and imaging revenue is not counted.

## What to read carefully

- **A booking closes a visit order.** That is the engine's rule (a booking made in time fulfils a control; it opens again when the date passes with no visit). So "urgent orders done within 7 days" and the agent's median days to fulfilment (7.8 against 23.3) count the booking. Attended consultations are reported separately: 40.5 against 27.4 per 100 patients.
- **No-shows are not recovered by the agent,** exactly as the agent behaves today: once an order is booked it is no longer chased. That costs the agent arm part of its gain.
- **The agent costs staff time:** about 80 staff tasks per 100 patients (41 reception calls, 31 notices to the doctor, 5 phone updates, 3 calls to another contact) and 3.4 messages per patient against 1.8. No patient ever gets more than 2 proactive messages in 7 days (checked on every run).
- **The intervals are run-to-run variation of a 400-per-arm cohort,** not uncertainty about the assumptions. Different assumptions give different numbers; change the config and run `pnpm simulate` to see by how much.

## Where it lives

- `packages/simulation`: the model (cohort, personas, arms, report). Depends on core only (dependency-cruiser rule `simulation-depends-only-on-core`); the engine is a port.
- `packages/runtime/src/simulation.ts`: the port over the real FHIR ingestion and memory adapters, the config loader and the server's report cache.
- `apps/api`: `pnpm simulate` (writes `docs/evals/simulation/<date>.md` and `.json`, the snapshot the API serves and the inbox mock's copy) and `GET /api/inbox/value/simulation` (the snapshot at once; another size computed in the background, `?patientsPerArm=&seeds=`).
- `apps/inbox/src/features/value`: the Value page.
- Tests: `packages/simulation/src/simulation.test.ts` (randomness, assignment, cohort, agenda), `packages/runtime/src/simulation.test.ts` (determinism, the cap, no agent action in the control arm, engine-only fulfilment, persona sanity, the snapshot reruns seed 1 to the same numbers), `apps/api/src/value/value-routes.test.ts`, `apps/inbox/src/value.test.tsx`.
