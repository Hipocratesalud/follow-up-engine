# 0008. Order-to-completion agent: the agent acts, the engine verifies

- Status: Accepted
- Date: 2026-10-30

## Context

The engine finds what a patient still owes their doctor's plan and opens a
case for the clinic team. Most of these cases end in the same chores: write
to the patient, find a time, book it, chase a result the patient already has
in a drawer. A conversational agent on WhatsApp can do the chores. It can
also invent goals, promise things, read a result to a patient, book a slot
nobody confirmed or spam a patient who stopped answering. Prompt
instructions do not prevent any of that.

## Decision

- **Ownership, not generation.** The agent owns only the doctor's orders
  (`doctor_plan` expectations and the universal rules that are orders or
  their consequence), never protocol or cadence suggestions.
- **The engine stays the only judge.** The agent never writes an
  expectation. Bookings and results go in as FHIR `Appointment` and
  `Observation` through the same ingestion as `POST /fhir`; the deterministic
  engine decides what they fulfill, and the trace shows it.
- **Guardrails in code, around a model that only chooses.** Slots, the
  contact cap, the ladder's timing, the booking confirmation, opt-out and
  the outbound safety check are pure functions in `packages/core`, applied
  by the toolbox to every tool call. The model picks tools and words.
- **Pseudonymous, budgeted model calls.** The model context has no name and
  no phone; result values from a photo stay with code. Every call (chat,
  vision, speech to text) goes through `llm_gateway`. Speech to text became
  a gateway capability with its own pricing and fake.
- **Two modes with one loop.** A deterministic scripted player and live
  Muse Spark run the same loop, tools and guardrails; the scripted player
  makes the demo work without a key and when the budget runs out.
- **Its own store.** Conversations, messages, media, runs, steps, staff
  tasks and bookings live in `order_agent_*` tables (migration 0017, RLS by
  clinic), outside the engine's unit of work: the agent's records are not
  clinical state, and bookings are idempotent by unique constraints.
- **Time is the clinic's.** Every agent decision takes the clinic's clock;
  an evaluator's lab clinic has its own, so the ladder can be shown by
  jumping days.

## Consequences

- A model mistake costs a refused step, visible in the trace, never a wrong
  booking or a result read to a patient.
- The agent depends on the engine's matching: a result the engine does not
  accept as fulfilling leaves the order open (`expectation_still_open`),
  which is correct but can surprise.
- The schedule is synthetic; a real deployment replaces `availableSlots`
  with the host's calendar behind the same port shape.
- The reviewer's lab-trend detector now treats a trend as commented only
  when a note follows its latest value, and gained a pre-visit question for
  a rising HbA1c; both are suggestions to the doctor, shadow until a clinic
  validates them.
