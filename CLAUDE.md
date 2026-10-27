# Follow-up Engine — agent rules

Source of truth for scope and specs: Linear project "Follow-up Engine AI"
(https://linear.app/hipocratesalud/project/follow-up-engine-ai-46b01fccf6bd). Read in order:
0 Hackathon context → 1 Roadmap → 2 PRD MVP → 3 Initial backfill → 4–7 PRDs V1–V4 → 8 Clinical team guide.

- Each PRD assumes the previous versions are implemented.
- Code, identifiers, enums, comments, tests and docs in English. Only user-facing UI copy for clinics and patients is in Spanish (neutral Spanish, "tú").
- `clinic_id` on every table and query.
- Every LLM call goes through `llm_gateway`; Meta models are the primary provider (Muse Spark via Meta Model API, or Muse Spark Open via Baseten `meta-models/muse-spark-open-1026`).
- This repo will be public: no proprietary Hipócrates code, no credentials, no real patient data. Synthetic data only.
- Never phrase output as medical advice to patients; findings are suggestions to the clinician with cited evidence.
- Nothing is enabled for a clinic without clinical team validation.
