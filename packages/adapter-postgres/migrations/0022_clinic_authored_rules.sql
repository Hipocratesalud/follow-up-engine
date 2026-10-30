-- Clinic-authored rules (V1 workstream C, the rule-authoring agent;
-- docs/agent/rule-authoring.md).
--
--   * `rule_overrides.authored`: a rule or protocol a clinic wrote for itself
--     in plain words and the agent drafted in the engine's config format,
--     with its status (`draft` never runs; `enabled` once a clinician enabled
--     it, `validatedBy`/`validatedAt`), the clinician's request, the inbox
--     labels, and its provenance (model, prompt version, cost, the agent's
--     step trace with ids and codes only, the engine's dry-run counts with
--     pseudonymous patient handles, the terminology it cites). Its override
--     row (and the history's `previous`/`next`, which already hold the whole
--     override as jsonb) version and audit it like any other override.
--
-- No identifiers beyond the engine's own ids. Runs with `search_path` set to
-- the engine schema, like 0001.

ALTER TABLE rule_overrides
  ADD COLUMN authored jsonb CHECK (authored IS NULL OR jsonb_typeof(authored) = 'object');

ALTER TABLE rule_overrides DROP CONSTRAINT rule_overrides_not_empty;
ALTER TABLE rule_overrides ADD CONSTRAINT rule_overrides_not_empty
  CHECK (due_in_days IS NOT NULL OR enabled IS NOT NULL OR authored IS NOT NULL);
