# Follow-up Engine

Clinical follow-up engine by [Hipócrates](https://hipocratesalud.com). It reads what already exists in a patient's record (orders, prescriptions, progress notes, reports) and turns it into expectations: "this should happen before this date". When an expectation expires unmet, the clinic sees one case per patient so nobody falls through the cracks.

It is an operational, continuity-of-care tool for the clinic. It never gives patients medical advice: every finding is a suggestion to the clinician, with cited evidence.

## Status

Built from scratch during the Meta AI Developer Hackathon 2026 (October 27 – November 4, 2026). Everything in this repository is new work; it is an independent module with clear interfaces for later integration into Hipócrates, and contains no preexisting Hipócrates code.

## Principles

- All AI runs on Meta models, through a single `llm_gateway`.
- Multi-tenant: `clinic_id` on every table and query.
- Synthetic patients only. No real clinical data in this repository, ever.
