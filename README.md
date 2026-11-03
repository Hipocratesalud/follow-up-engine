# Follow-up Engine

**The agent acts, the engine verifies, the doctor decides.**

An AI-powered patient continuity engine that executes clinician-defined follow-up workflows, coordinates patient outreach, and schedules care without providing autonomous medical advice.

Doctors order tests, studies and control visits every day, and a large share of those orders are never completed. Nothing fails when that happens: the EHR saved the visit, the note was written, the order was printed. The patient simply never booked, never brought the result back, or stopped coming. Nobody is watching the gap between what the doctor ordered and what actually happened. The Follow-up Engine watches it. It reads what an EHR already saves (HL7 FHIR R4), turns each order into a dated expectation, and an agent on WhatsApp works every order with the patient until the deterministic engine says it is done.

Submission to the **Meta AI Developer Hackathon 2026**, built on Meta's Muse Spark.

[Hosted demo](https://follow-up-engine-demo-production.up.railway.app) · [The agent](#order-to-completion-agent) · [Meta AI usage](#meta-ai-usage) · [Architecture](#architecture) · [Built during the hackathon](#built-during-the-hackathon-oct-26--nov-4-2026) · [Walkthrough](#walkthrough-for-judges-about-3-minutes) · [Limitations](#known-limitations)

Video (3 min): <link — to fill>

![The /agent page after María (synthetic) sends a photo of her lab report, scripted mode. Left: the simulated WhatsApp phone, where the agent thanked her and said only that her doctor will review the report. Right: the live agent console, where the engine's events show a new expectation and the clinical reviewer running on the result, and every model and tool step shows its reason and what it read. Below: the doctor's three orders, each "Fulfilled by the engine" with the FHIR Appointment or Observation that closed it; the clinic clock and the stopped no-response ladder; and "For the doctor", with the HbA1c trend 6.6 → 7.1 → 8.4 % and two pre-visit questions, each quote cited with its source and date.](docs/images/agent-maria.jpg)

_María's story on the `/agent` page, scripted mode (no model calls), captured on a local demo server built from this repository. The same loop, tools and guardrails run live on Muse Spark in the [recorded runs](#recorded-live-runs)._

**What the engine executed in a 90-day simulation (synthetic test, not real patients).** Over 20 seeded runs of 400 synthetic patients each (8,000 patients), the order agent ran on the engine's real code ([execution counts](docs/evals/simulation/2026-10-30-execution-counts.md)):

| Step                                                                   |  Count |
| ---------------------------------------------------------------------- | -----: |
| Orders the engine detected                                             |  9,038 |
| Proactive messages sent (first contacts and ladder rungs, capped)      | 19,193 |
| Replies sent to a patient's message                                    |  8,267 |
| Consultations booked                                                   |  3,353 |
| Escalations: tasks for reception                                       |  3,916 |
| Escalations: notices to the doctor                                     |  2,457 |
| Orders the engine closed as fulfilled (the agent never marks one done) |  6,740 |

Against fixed reminders on the same synthetic cohort, orders fulfilled within 90 days went from 50.6 % to 74.6 %: a simulated result whose size depends on stated persona assumptions, not a clinical result ([comparison and assumptions](#simulated-comparison-with-fixed-reminders)).

## Order-to-completion agent

Once it takes ownership of a patient, the agent owns every order the doctor wrote until the engine says it is done (in this build, ownership starts when a patient's story is started on `/agent`; see [Known limitations](#known-limitations)). It talks to the patient on WhatsApp, books what the doctor ordered, collects results the patient already has and hands the rest to the clinic team. It never decides what care a patient needs: it executes the follow-up the clinician defined. Design: [docs/agent/order-to-completion.md](docs/agent/order-to-completion.md), decision record [ADR 0008](docs/adr/0008-order-to-completion-agent.md).

### The loop, step by step

The model chooses one tool per step; code checks every call. Each step is visible in the `/agent` console, which shows for every entry the tool, its arguments, what it read, the model's stated reason and the outcome ([trace format](docs/agent/order-to-completion.md#trace)).

| Step                               | Who decides                                                                                                                                                                         | Where its choice and reason are visible                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Detect the order                | The engine: an expectation of the doctor's plan (read from the note) or a universal rule that is an order ([orders.ts](packages/core/src/engine/order-agent/orders.ts))             | Ladder entry "Took ownership of N doctor's orders (M engine suggestions ignored)"; panel "The doctor's orders"                      |
| 2. Read authorized context         | The model calls `list_open_orders`, `read_patient_summary`, `get_contact_policy`. Pseudonymous: no name, no phone                                                                   | Tool entries with "Read: expectations, appointments" or "Read: messages, conversation"                                              |
| 3. Choose an administrative action | The model picks the next tool; the ladder's timing is code ([ladder.ts](packages/core/src/engine/order-agent/ladder.ts))                                                            | Model entry "The model chose `<tool>`" with model, tokens and cost; ladder entries "Turn started: … (Routine rung, day 0: message)" |
| 4. Contact the patient             | `get_available_slots`, `propose_slots`, `send_message`; slots computed by code, text checked by code                                                                                | Tool entry "Message sent", with the text as an argument and "Read: contact_policy, outbound_safety"                                 |
| 5. Handle the reply                | Text, a voice note (Muse Voice), a photo or PDF of a result (Muse Spark vision); `match_result_to_order` maps a result to a pending order                                           | Entries `voice_transcribed`, `photo_read`, `result_matched`, each with its model and cost                                           |
| 6. Book                            | `create_appointment(orderId, slotId, confirmationMessageId)`, accepted only on the patient's explicit yes ([confirmation.ts](packages/core/src/engine/order-agent/confirmation.ts)) | Tool entry `appointment_booked`, or the refusal reason (`hesitant`, `ambiguous_choice`, `slot_not_offered`)                         |
| 7. Record                          | The agent writes FHIR (an `Appointment`, an `Observation`) through the same ingestion as `POST /fhir`; the engine decides what that fulfils                                         | Engine entry `expectation_fulfilled … by Appointment/…` or `by Observation/…`; the order card shows "Fulfilled by the engine"       |
| 8. Escalate                        | `create_staff_task`, ladder rungs (reception call on day 14), notices to the doctor                                                                                                 | Tool or ladder entry `staff_task_created`; panels "Staff tasks" and "For the doctor"                                                |

Tools: `list_open_orders`, `read_patient_summary`, `get_contact_policy`, `get_available_slots`, `send_message`, `propose_slots`, `create_appointment`, `match_result_to_order`, `submit_fhir_result`, `create_staff_task`, `end_turn` ([tool schemas](packages/core/src/engine/order-agent/tools.ts), [loop](packages/llm/src/agent/order-agent.ts)). A deterministic scripted player and live Muse Spark run the same loop, tools and guardrails.

### Guardrails enforced in code

The model only chooses tools and words. Every rule below is a pure function in `packages/core`, applied by the toolbox to every call ([service.ts](packages/core/src/engine/order-agent/service.ts)); a model mistake costs a refused step, visible in the trace.

- **Slots are computed by code.** Dates come only from the schedule ([slots.ts](packages/core/src/engine/order-agent/slots.ts)); slot ids are validated against it, and every offer carries two or three slots.
- **Booking only on explicit confirmation.** The confirming message must be the patient's latest, the slot must be in the latest offer and still free, and the reply must single out one slot. "Maybe", "let me see" or "ok" to several options never books ([confirmation.ts](packages/core/src/engine/order-agent/confirmation.ts)).
- **No diagnosis, value or test name to the patient.** `checkOutboundText` ([outbound-safety.ts](packages/core/src/engine/order-agent/outbound-safety.ts)) refuses any measured value, verdict on a result, condition name, test or study name, the word diagnosis, or treatment instruction, on the whole text the patient would receive. A property and fuzz test refuses 3,000 generated adversarial messages and reports every leaked kind ([outbound-safety.property.test.ts](packages/llm/src/agent/outbound-safety.property.test.ts)); an adversarial model's leaking messages are refused and never stored ([agent-guardrails.test.ts](apps/api/src/agent-guardrails.test.ts)). Values read from a photo never go back to the model.
- **Opt-out is final and recorded.** Detected by code on every text and transcribed voice note. Nothing goes out again, open calls are withdrawn, the doctor is told, and the engine records a FHIR `Consent` with provision `deny` and category `follow-up-opt-out` ([builders/order-agent.ts](packages/fhir/src/builders/order-agent.ts)).
- **The doctor confirms rule-originated visits.** A visit the engine asked for because a result was abnormal waits as `awaiting_doctor` until the doctor confirms it, recorded with who and when; the agent says nothing about it before ([what the agent owns](docs/agent/order-to-completion.md#what-the-agent-owns)).
- **Only the engine marks an order fulfilled.** The agent has no tool that writes an expectation ([ADR 0008](docs/adr/0008-order-to-completion-agent.md)).
- **At most 2 proactive messages per patient per rolling 7 days**, whatever the number of orders, one message per outreach covering all of them ([contact-policy.ts](packages/core/src/engine/order-agent/contact-policy.ts)).

### The no-response ladder

Timing is code; the model only words a message rung. A patient's reply pauses the ladder ([ladder.ts](packages/core/src/engine/order-agent/ladder.ts)).

| Track       | Rungs                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routine     | day 0 message with two slots · day 4 other times · day 9 remove friction (Saturday) · day 14 call task for reception · day 21 unreachable, retry in 30 days, the doctor is told |
| urgent      | hour 0 slots this week · day 1 other hours · day 2 high-priority call task · day 3 the doctor directly · day 7 unreachable                                                      |
| undelivered | at once: stop messaging, same-day task to update the phone · day 7 call via other contact data · day 14 unreachable                                                             |

### Recorded live runs

Each path ran live on Muse Spark against a demo server on 2026-10-30 and was exported with every model call, tool call and engine event, and the gateway's usage rows ([docs/evidence/agent-runs/2026-10-30](docs/evidence/agent-runs/2026-10-30/)):

| Path                                                                                                                              | Transcript                                                                              | Models                                    | Cost (USD)          |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| "Not Tuesday" → new slots; explicit yes → booked; photo of the report → the engine closes the HbA1c order; findings to the doctor | [booking-photo-doctor](docs/evidence/agent-runs/2026-10-30/booking-photo-doctor.md)     | muse-spark-1.3 (chat and vision)          | 0.127546 (38 calls) |
| A voice note, transcribed and answered                                                                                            | [voice-note](docs/evidence/agent-runs/2026-10-30/voice-note.md)                         | muse-spark-1.3, muse-voice-transcribe-1.0 | 0.020550 (15 calls) |
| No answer: day 4 and day 9 rungs, then a call task for reception on day 14                                                        | [no-response-ladder](docs/evidence/agent-runs/2026-10-30/no-response-ladder.md)         | muse-spark-1.3                            | 0.036521 (26 calls) |
| Undelivered message → messaging stops, a task to fix the phone                                                                    | [undelivered-phone-fix](docs/evidence/agent-runs/2026-10-30/undelivered-phone-fix.md)   | muse-spark-1.3                            | 0.010904 (9 calls)  |
| Abnormal result: the engine's visit waits for the doctor, then the urgent track                                                   | [urgent-doctor-confirms](docs/evidence/agent-runs/2026-10-30/urgent-doctor-confirms.md) | muse-spark-1.3                            | 0.049114 (21 calls) |

## Other agents

All three run through the same `llm_gateway`, return typed output that code checks, and stay in shadow mode or draft until a clinician validates them.

- **Clinical reviewer** ([docs/reviewer.md](docs/reviewer.md), [ADR 0006](docs/adr/0006-clinical-reviewer-agent.md)). A bounded tool-using agent over one patient's dossier that confirms or adds to what deterministic detectors found; every citation is checked word for word against the record. Re-measured live on 2026-10-30 with the shipped prompt over a 20-patient cohort (10 planted, 10 controls): precision 92.9 %, recall 100 %, 0 of 43 stored citations invented, $0.0164 per review ([report](docs/evals/reviewer/2026-10-30-meta-muse-spark-1.3.md), [eval README](docs/evals/README.md)).
- **Adjudicator of ambiguous plan items** (PRD V2, workstream E; [docs/adjudicator.md](docs/adjudicator.md)). Looks only at plan items the extractor was unsure of and answers one question: does the note really ask for this follow-up? Live eval on 20 synthetic items: 19 of 20 correct, 0 open/discard flips, $0.0755 for the 20 calls ([report](docs/evals/adjudicator/2026-10-30-meta-muse-spark-1.3.md)).
- **Rule-authoring agent** ([docs/agent/rule-authoring.md](docs/agent/rule-authoring.md)). A clinician writes a follow-up rule in plain words; the agent drafts it in the engine's own configuration format, code validates every code against the repository's catalogs and dry-runs it over the clinic's records, and it never runs until a clinician enables it. Live on 2026-10-30, the third run produced 3 valid drafts of 3 for $0.085, about $0.03 per draft.

## Meta AI usage

Every model call goes through one `llm_gateway` (`packages/llm`), with a budget cap per clinic, usage rows per call, and a deterministic fake provider plus recorded snapshots so tests and the scripted demo run with no key, no network and no cost ([ADR 0004](docs/adr/0004-llm-gateway-meta-models.md)).

| Model                       | Endpoint                       | Used for                                                                                  | Measured cost (source)                                                                                                                           |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `muse-spark-1.3`            | `POST /v1/chat/completions`    | Order-to-completion agent (tool calling)                                                  | $0.010904 to $0.127546 per recorded run, $0.244635 for the five ([agent runs](docs/evidence/agent-runs/2026-10-30/))                             |
| `muse-spark-1.3`            | same                           | Note extraction: conditions, medications and the doctor's plan with verbatim quotes       | $0.004887 per note over 101 gold notes, 0 of 348 quotes hallucinated ([eval](docs/evals/2026-10-27-meta-muse-spark-1.3.md))                      |
| `muse-spark-1.3`            | same                           | Clinical reviewer                                                                         | $0.016406 per review ([eval](docs/evals/reviewer/2026-10-30-meta-muse-spark-1.3.md))                                                             |
| `muse-spark-1.3`            | same                           | Adjudicator                                                                               | $0.075470 for 20 items ([eval](docs/evals/adjudicator/2026-10-30-meta-muse-spark-1.3.md))                                                        |
| `muse-spark-1.3`            | same                           | Rule authoring                                                                            | $0.083 to $0.088 per run of three drafts ([live results](docs/agent/rule-authoring.md#live-results-2026-10-30-muse-spark-13-the-three-examples)) |
| `muse-spark-1.3`            | same, with image content parts | Vision: reading a photo of a lab report into structured results                           | $0.003069 for one photo read (usage row `6c2726fe…` in [booking-photo-doctor](docs/evidence/agent-runs/2026-10-30/booking-photo-doctor.md))      |
| `muse-spark-1.3`            | same, with a PDF `file` part   | Vision: reading a scanned PDF lab report (no text layer) into the same structured results | $0.005145 for one scanned PDF read on the agent phone, $0.0052 in the Lab import (as logged by the `llm_gateway`, 2026-11-01)                    |
| `muse-voice-transcribe-1.0` | `POST /v1/asr/transcribe`      | Transcribing a patient's voice note                                                       | $0.000648 for a 6.5-second note (usage row `8aea97ff…` in [voice-note](docs/evidence/agent-runs/2026-10-30/voice-note.md))                       |

Muse Spark Open did not run: we had no Baseten credits, so it has no eval and no number in this repository.

Deployment note: the hosted demo runs on Railway, and the Meta Model API did not serve Railway's egress addresses ([docs/deploy.md](docs/deploy.md#hosted-demo)), so the demo reaches it through a small relay in São Paulo set by `META_BASE_URL`. Locally the gateway calls `api.meta.ai` directly.

## Simulated comparison with fixed reminders

> Simulation with synthetic patients and stated assumptions; not a clinical trial, and not a clinical result.

**Orders fulfilled within 90 days: 50.6 % with fixed reminders → 74.6 % with the order agent, +24.0 points (95 % interval +18.5 to +28.6 over 20 seeded runs of 400 synthetic patients per arm).** Source: [docs/evals/simulation/2026-10-30.md](docs/evals/simulation/2026-10-30.md); method: [docs/simulation.md](docs/simulation.md). The agent arm runs the agent's real policy code, and every booking, visit and result goes through the engine's FHIR ingestion; "fulfilled" is the engine's own status at day 90.

The patients' side is a persona model, not a language model. Every persona's probabilities (reply curve, slot fit, self-completion, show-up, call answer, photo) were chosen by the team, cite no study, and live in [config/simulation/simulation.v1.json](config/simulation/simulation.v1.json). **The difference depends on them**: change the config and run `pnpm simulate` to see by how much.

| Persona                     | Share | Behaviour                                                   | Fixed reminders → agent (orders fulfilled) |
| --------------------------- | ----- | ----------------------------------------------------------- | ------------------------------------------ |
| Fast responder              | 30 %  | Answers the first message, takes a slot that fits           | 82.2 % → 93.8 %                            |
| Needs a second try          | 15 %  | Misses the first message, answers a later one               | 51.1 % → 83.7 %                            |
| Only after the time changes | 12 %  | Answers, but weekday mornings never suit                    | 51.1 % → 83.3 %                            |
| Wrong number                | 6 %   | Messages undelivered until reception finds the right number | 30.9 % → 63.2 %                            |
| Reads, never answers        | 10 %  | Never writes back; picks up a call                          | 27.3 % → 57.8 %                            |
| Never answers               | 12 %  | Nothing reaches them                                        | 25.0 % → 22.2 %                            |
| Opts out                    | 3 %   | Asks the clinic to stop writing at the first reply          | 33.6 % → 41.2 % (wide interval)            |
| Test done elsewhere         | 12 %  | Did the test at an outside lab; sends a photo when asked    | 28.5 % → 90.5 %                            |

The agent costs staff time (79.7 staff tasks per 100 patients against none) and sends more messages (3.4 per patient against 1.8), and it changes nothing for patients nobody can reach. The inbox's **Value** page shows the same report next to the demo clinic's real attributed bookings.

![The Value page: orders fulfilled within 90 days, 50.6 % with fixed reminders and 74.6 % with the order agent, with 95 % intervals; an estimate scaled to a clinic's own volume and price; tiles for urgent orders, median days to fulfilment, patients never reached, messages per patient, consultations attended and staff tasks; and the start of the per-persona chart. A banner reads "Simulation with synthetic patients and stated assumptions; not a clinical trial."](docs/images/value-simulation.jpg)

## Built during the hackathon (Oct 26 – Nov 4, 2026)

- **The repository was created for the hackathon.** Its only root commit is `a1166a5`, on 2026-10-26 22:53 -03:00. Verify:

  ```sh
  git rev-list --max-parents=0 HEAD
  # a1166a53eded68ea6e64dc60461a07fc6c7ccf1f
  git log --reverse --format='%h %ad %s' --date=iso | head -1
  # a1166a5 2026-10-26 22:53:17 -0300 Initial commit
  ```

- **Every line in it was written during the building period**: the engine, the agents, the inbox, the evals, the simulation, the evidence and these docs.
- **The only pre-existing thing is the Hipócrates product** (hipocratesalud.com), an EHR the team built before the hackathon. It is the intended future host system: it would receive the engine's signed webhooks and send the real WhatsApp messages. **None of its code is in this repository**, and nothing here depends on it: the demo simulates the host and the WhatsApp channel, and any FHIR R4-capable EHR can be the host.

## Walkthrough for judges, about 3 minutes

**Hosted demo:** https://follow-up-engine-demo-production.up.railway.app (access code shared in the submission form). It runs on a fake clock over a synthetic clinic of 148 patients; the Lab, Agent and Engine tests pages give each evaluator a sandbox clinic of their own.

1. **Sign in** with any email and the access code. Your actions are recorded under that email.
2. **Agent.** Choose "Scripted (offline)", start María's story and play her with the suggested replies: "I can't make it on Tuesday", "Number 2 works for me", then "Sample lab photo". Follow the loop in the console: the order detected (ladder entry), the context read (each tool's "Read:"), the action chosen (each model entry and its reason), the contact (the message and its safety check), the reply handled (the photo read), the booking (`appointment_booked`), the record (the engine's `expectation_fulfilled`), and the escalation ("For the doctor", "Staff tasks"; jump the clock with "+4 days" on a new María who does not answer). Live Muse Spark is also offered, within the demo's budget.
3. **Inbox "Why?"** Open a patient with a "Doctor's plan" reason and click "Why this?": the due date is recomputed from the stored record, the doctor's own words are highlighted in the source note, and you can confirm, correct or reject the AI reading.
4. **Lab.** Upload or paste a note of your own, or use **Import history** to load a patient's past notes and lab reports. A report printed for another person is held for review, never recorded.
5. **Engine tests.** Run a guided test, for example "A repeated order supersedes the one before it", and compare Expected with Observed.
6. **Value.** The simulated comparison above, scaled to a clinic's own volume.

![Inbox case detail on a doctor's-plan reason, "Why this?" open: the verbatim quote "TSH en 6 a 8 semanas" highlighted in the source note, Muse Spark's reading "Lab test · Nov 7, 2025" waiting for Confirm, Correct or Reject, and how the due date was computed: Nov 7, 2025 = the note (Sep 12, 2025) + 56 days.](docs/images/inbox-why-evidence.png)

| Before the visit                                                                                                                                                                                                                                                                                                                    | Lab: a held report                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ![Before the visit, next appointment Jan 6, 2026: two questions for the doctor to ask, about muscle pain since starting a statin and dry cough since starting an ACE inhibitor, each a suggestion not validated yet, quoting the prescription and its date, with Asked and Not relevant buttons.](docs/images/before-the-visit.png) | ![A report for this patient needs review: an imported HbA1c report whose printed name, Laura Beatriz Ortega, does not match the patient in the record, Rafael Antonio Méndez, held until someone chooses "It's this patient" or "Not this patient". Read by meta:muse-spark-1.3.](docs/images/lab-held-report.png) |
| The clinical reviewer's suggestions for the next visit, each with its cited evidence; the doctor marks them asked or not relevant.                                                                                                                                                                                                  | An imported report whose printed name does not match is held: nothing from it reaches the record or closes an order until a person decides.                                                                                                                                                                        |

## Clinical validation

All patients in every session are **synthetic**. No real patient data has been used, stored or committed anywhere in this repository.

On 2026-10-27, practicing physicians reviewed the hosted demo against each synthetic patient's documents. The hosted demo's **Metrics** page, which leaves test and QA accounts out ([config/demo/test-evaluators.json](config/demo/test-evaluators.json), [docs/deploy.md](docs/deploy.md#evaluator-identity-and-tracking)), shows for the doctor's plan items Muse Spark read from notes: **42 confirmed (in 21 confirm actions), 0 corrected, 0 rejected** from that session (the hosted count grows as evaluators keep using the demo: 43 on 2026-11-01); and **6 cases rated, all 6 useful**. That session predates per-evaluator sign-in, so its actions are not attributed to individual physicians.

The diabetes and hypertension protocols are **ready for sign-off**: a generated package lets a physician approve each in one sitting, every number and code read back from config ([diabetes](docs/protocols/signoff/diabetes.md), [hypertension](docs/protocols/signoff/hypertension.md), [docs/protocols.md](docs/protocols.md)). No protocol has been validated by a clinical team yet; until then, every reason a protocol produces is labeled "pending clinical validation".

## Known limitations

- Two patients with the same full name still match (no date of birth read from reports).
- Supabase RLS was verified on Supabase's Postgres 15.8; everything else on 18.6.
- Cap of 2 proactive messages per week instead of the PRD's 1, agreed with the product owner.
- The engine writes no audit event when a single order closes.
- Opt-out by voice note is untested.
- The agent console's model summaries are English on both locales.
- A scanned PDF (no text layer) is read like a photo, so a regular clinic (images not allowed to leave) holds it for the team instead of reading it; a scanned consultation note is not read at all.
- The simulated phone accepts PDF but not DOCX.
- A held report creates no staff task or webhook.
- The findings daily cap releases on read.
- The weekly cap and the simulation use synthetic personas with stated assumptions.
- Muse Spark Open was not evaluated.
- The order agent takes ownership of a patient's orders only when a story is started on the demo's `/agent` page (`POST /api/demo/agent/story`, the only caller of `takeOwnership`). The automatic trigger on case opening is not wired yet: when the engine opens a case, nothing starts the agent; the case goes to the inbox and its webhooks to the host, and the worker's sweep moves the no-response ladder only for conversations a story started.

## Architecture

[![System design: the host EHR sends FHIR R4 transaction Bundles to apps/api, which stores them with a job in one Postgres transaction; the worker runs the deterministic engine in packages/core (versioned config, the annotator, expectations in four layers, the deadline watcher and escalation) and writes signed webhooks through a transactional outbox; the agents call Meta's Muse Spark and Muse Voice only through llm_gateway, inside guardrails written in code. A validation strip lists the evals, the simulation and the test suite. Click for the full-resolution SVG.](docs/images/system-design.png)](docs/images/system-design.svg)

_Full resolution: [system-design.svg](docs/images/system-design.svg)._

### How the engine works

An AI-powered patient continuity engine that executes clinician-defined follow-up workflows, coordinates patient outreach, and schedules care without providing autonomous medical advice. It is a standalone service a clinic's EHR talks to over HL7 FHIR R4:

1. **Consultation saved.** The host sends one FHIR `transaction` Bundle per saved consultation; the API stores it and answers in milliseconds, and the worker runs the engine.
2. **Expectations from four layers.** Structured rules (a lab order needs a result in 15 days), the doctor's plan read from the note by Muse Spark with a verbatim quote per item, the patient's own visit cadence, and condition protocols that only fill what the first three left uncovered.
3. **Fulfilment.** A matching result, visit or booking closes an expectation; a newer order supersedes it; a cancellation reopens it. A nightly reconciliation repairs what a lost or reordered event left inconsistent.
4. **Cases and the agent.** An expectation that expires unmet opens one case per patient in the clinic inbox; the order agent works the doctor's orders with the patient once it takes ownership (started from `/agent` in this build).
5. **Signed webhooks back to the host.** `case.opened`, `case.resolved`, `patient_contact.requested` and more, HMAC-signed, delivered at least once from a transactional outbox ([docs/integration.md](docs/integration.md)).

Hexagonal architecture, enforced by dependency-cruiser on every commit: `packages/core` is pure domain and ports with no I/O; adapters (Postgres and Supabase, in-memory, the LLM gateway) never import each other; only `packages/runtime` wires them ([ADR 0002](docs/adr/0002-hexagonal-architecture.md), [ADR 0005](docs/adr/0005-http-api-and-runtime.md)). The engine's own state is exposed as standard FHIR resources ([ADR 0001](docs/adr/0001-fhir-r4-data-model.md), [docs/fhir.md](docs/fhir.md)). Rules and protocols are versioned JSON ([config/rules](config/rules), [config/protocols](config/protocols)).

**Tests.** 3,109 tests passing, full suite on Postgres 18, 0 failing, at commit `bff7579` (2026-10-30); later commits pass `pnpm verify` (2,543 tests at `dc45cb1`). CI runs `pnpm verify` (lint, typecheck, boundaries, test), an end-to-end run against Postgres with real signed webhooks, and a gitleaks secret scan on every push.

## Run it locally

Node 22 and pnpm 10:

```sh
corepack enable pnpm
pnpm install
pnpm verify                  # lint + typecheck + boundaries + test
pnpm demo                    # API on :3000, in memory, fake clock, the synthetic clinic seeded
pnpm inbox                   # in another terminal: the inbox on :5173
pnpm simulate                # the 90-day simulation (about 25 seconds, deterministic)
```

With `META_API_KEY` set, notes and the agent's live mode call Muse Spark; without it, the fake provider and the scripted agent run the same pipeline at no cost. Postgres, Supabase and the hosted demo: [docs/deploy.md](docs/deploy.md). Every eval and how to reproduce it: [docs/evals/README.md](docs/evals/README.md). Environment variables: [.env.example](.env.example).

```
apps/       api (HTTP, FHIR in and out), worker (jobs, sweeps, outbox), inbox (React UI)
packages/   core, fhir, runtime, adapter-postgres, adapter-memory, llm, simulation, testkit, acceptance
config/     versioned rules, protocols, simulation personas
docs/       ADRs, agent design, evals, evidence, protocols
```

## Team

<!-- Simeón: fill Luis's surname and role -->

- **Simeón Aldana**
- **Luis <SURNAME — to fill>**, physician, co-founder (<role wording — to fill>)

## License

License: to be decided by the authors (placeholder).
