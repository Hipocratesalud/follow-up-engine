# 0006. Clinical reviewer: deterministic detectors, a bounded LLM agent, code-checked findings, shadow first

- Status: Accepted
- Date: 2026-10-27

## Context

PRD V3 asks for a reviewer that reads a patient's record and points out what deserves the doctor's attention and is not already covered: silent lab trends, risky drug combinations, symptoms never worked up, missing check-ups. It is the engine's first output that is clinical judgment rather than bookkeeping. Three risks dominate:

- A model can invent evidence.
- A model can be steered by text inside a note.
- Unvalidated suggestions reaching doctors erode trust, and they create liability.

The reviewer must also be cheap enough to run on every new result, must work with no model at all (CI, demos, a spent budget), and must stay inside the hexagon.

## Decision

1. **Deterministic first.** Code builds the patient's dossier and computes every trend: slope, percent change, consecutive worsening, out of range, with unit conversion and CKD-EPI 2021 when only creatinine exists. Curated detectors (interaction and drug-condition tables, a symptom lexicon with negation, check-up rules, utilization) emit signals with verbatim evidence. They are small tables a clinician can read and correct, in `packages/core`.
2. **Then an agent, bounded.** An LLM behind `llm_gateway` gets the PRD's pseudonymous `ReviewInput` and the signals, plus six read-only tools over that patient's dossier only. It may confirm, discard, merge or add findings.
   - One tool call per step: native tool calling on the Meta Model API and Baseten, or the same action object as strict structured output elsewhere.
   - Arguments are validated with zod; a malformed call costs a step.
   - Limits: 8 steps, 6 tool calls, 60k tokens, the clinic's monthly budget.
   - Host ids never reach the model (handles `N1`, `R4`). Names are masked, and host text is JSON-escaped so it cannot forge a delimiter.
3. **The model is untrusted; code decides.** Every citation is checked verbatim against the stored document; one bad citation drops the finding. Findings addressed to the patient are dropped. `alreadyCovered` is computed by code from open expectations and cases and is not part of the model's output. Identical findings are deduplicated over 90 days. The independent re-check of stored citations is an automated test and an eval gate (0 hallucinated citations).
4. **Shadow first, live by sign-off.** Every category is a flag per clinic and specialty, off and in shadow by default. Shadow findings exist only for the clinical staff's batch review: never exported, never a webhook, hidden from Supabase clinic users by RLS. A category goes live only with `validatedBy`, enforced by the API, the domain and a database CHECK, after the flags page shows its shadow precision.
5. **Never blocks.** When the agent cannot finish (budget, provider, step limit), the detector signals go through the same checks and are stored as `fallback`. The CI and demo provider is a scripted agent that speaks the real protocol through the real gateway, so tests exercise the loop, not a mock of it.

## Consequences

- Recall of the obvious is guaranteed by code and measurable offline (`eval:reviewer --provider detectors | fake`). A model's value is what it adds beyond the detectors, measured on the same cohort and in the shadow review.
- Hallucinated evidence cannot be stored, whatever the model does. A prompt-injected or confused model can only waste its own steps.
- The knowledge tables are deliberately narrow. Anything beyond them depends on the model, and live use depends on the clinical team's validation, which is the point of shadow mode.
- Cost is bounded per review, about $0.008 at Muse Spark prices on the cohort. Every call is accounted per clinic in `llm_calls` and every review in `clinical_review_runs`.
- V2's risk tier does not exist yet: the daily sweep uses the case priority (≥ 75) as its stand-in.
