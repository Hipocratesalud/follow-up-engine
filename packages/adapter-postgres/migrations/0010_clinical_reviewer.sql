-- Clinical reviewer (PRD V3, HIP-112): findings, review runs and the
-- per-category flags that keep every category off and in shadow mode until
-- the clinical team validates it.
--
--   * `clinical_findings`: one suggestion to the clinician with verbatim
--     citations (`citations` jsonb, checked by the engine before insert).
--     `mode` is `shadow` (batch review by clinical staff only) or `live`.
--     `dedup_key` is `<category>|<cited sources>`: the engine does not store
--     a finding with the same key open or reviewed in the last 90 days.
--   * `clinical_review_runs`: one review of one patient, with what it cost
--     (tokens, USD), how many tool calls the agent made, what was kept,
--     discarded and deduplicated, and the tool trace (ids and codes only,
--     never note text).
--   * `finding_flags`: one row per clinic, category and specialty (`''` is
--     every specialty). `live` requires `validated_by` (CHECK).
--
-- Ids are engine-generated strings, unique per clinic, like every other
-- table. RLS is enabled on the new tables, as on every engine table.
--
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE TABLE clinical_findings (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'pre_visit_question', 'lab_trend', 'vital_trend', 'abnormal_result_no_followup',
    'drug_interaction', 'drug_condition_conflict', 'unaddressed_symptom',
    'missing_screening', 'record_quality', 'utilization_change', 'similar_patients'
  )),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 240),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 800),
  suggestion text NOT NULL CHECK (length(suggestion) BETWEEN 1 AND 400),
  -- [{ source: { resourceType, id }, kind, quote, occurredAt }], at least one.
  citations jsonb NOT NULL CHECK (jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0),
  already_covered boolean NOT NULL,
  covered_by jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(covered_by) = 'array'),
  specialty text,
  mode text NOT NULL CHECK (mode IN ('shadow', 'live')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'relevant', 'already_known', 'not_relevant', 'expired')),
  origin text NOT NULL CHECK (origin IN ('confirmed', 'added', 'fallback')),
  dedup_key text NOT NULL,
  run_id text NOT NULL,
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  review_reason text CHECK (review_reason IS NULL OR length(review_reason) <= 1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT clinical_findings_review_complete CHECK (
    (status IN ('open', 'expired')) OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

-- The batch review list: newest first within a mode, filtered by status and category.
CREATE INDEX clinical_findings_list_idx ON clinical_findings (clinic_id, mode, created_at DESC, id DESC);
CREATE INDEX clinical_findings_patient_idx ON clinical_findings (clinic_id, patient_id, created_at DESC);
CREATE INDEX clinical_findings_dedup_idx ON clinical_findings (clinic_id, patient_id, dedup_key);

CREATE TABLE clinical_review_runs (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  trigger_event text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'degraded', 'skipped', 'failed')),
  signals_count integer NOT NULL CHECK (signals_count >= 0),
  findings_count integer NOT NULL CHECK (findings_count >= 0),
  discarded_count integer NOT NULL CHECK (discarded_count >= 0),
  duplicate_count integer NOT NULL CHECK (duplicate_count >= 0),
  discarded jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(discarded) = 'array'),
  steps integer NOT NULL CHECK (steps >= 0),
  tool_calls integer NOT NULL CHECK (tool_calls >= 0),
  trace jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trace) = 'array'),
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cost_usd numeric(12, 6) NOT NULL CHECK (cost_usd >= 0),
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  stop_reason text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX clinical_review_runs_patient_idx
  ON clinical_review_runs (clinic_id, patient_id, started_at DESC);
CREATE INDEX clinical_review_runs_started_idx ON clinical_review_runs (clinic_id, started_at);

CREATE TABLE finding_flags (
  clinic_id text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'pre_visit_question', 'lab_trend', 'vital_trend', 'abnormal_result_no_followup',
    'drug_interaction', 'drug_condition_conflict', 'unaddressed_symptom',
    'missing_screening', 'record_quality', 'utilization_change', 'similar_patients'
  )),
  -- '' = every specialty (a primary key column cannot be null).
  specialty text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  validated_by text,
  validated_at timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, category, specialty),
  -- Live only with the clinical team's sign-off.
  CONSTRAINT finding_flags_live_validated CHECK (
    mode = 'shadow' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL)
  ),
  -- `similar_patients` is reserved: it cannot be turned on in V3.
  CONSTRAINT finding_flags_reserved_off CHECK (category <> 'similar_patients' OR NOT enabled)
);

ALTER TABLE clinical_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_review_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_flags ENABLE ROW LEVEL SECURITY;
