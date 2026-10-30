-- The adjudicator of ambiguous plan items (PRD V2, workstream E;
-- docs/adjudicator.md).
--
--   * `expectations.confidence`: how confidently the extractor read a
--     doctor's plan item (0 to 1). An item inside the clinic's ambiguous
--     band (`clinics.settings.adjudicator`, default 0.4 to 0.75) goes to the
--     adjudicator. Null for every other layer and for items stored before.
--   * `adjudications`: one decision per expectation (`open`, `discard`,
--     `needs_human`), the calibrated probability, the reason codes (a fixed
--     list), a short rationale (en, es), the verbatim quotes the engine
--     checked, and its provenance (provider, model, prompt version, cost).
--     A doctor's override is the only column written after creation. No
--     identifiers beyond the engine's own ids.
--   * `case_events.actor_type` gains `adjudicator`: every decision on a
--     case's reason is a case event with that actor.
--
-- Every table carries `clinic_id` and gets row-level security (0005).
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE expectations
  ADD COLUMN confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

ALTER TABLE case_events DROP CONSTRAINT case_events_actor_type_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_actor_type_check
  CHECK (actor_type IN ('rule', 'user', 'patient', 'system', 'adjudicator'));

CREATE TABLE adjudications (
  clinic_id text NOT NULL,
  id text NOT NULL,
  seq bigserial,
  patient_id text NOT NULL,
  expectation_id text NOT NULL,
  case_id text,
  decision text NOT NULL CHECK (decision IN ('open', 'discard', 'needs_human')),
  model_decision text NOT NULL CHECK (model_decision IN ('open', 'discard', 'needs_human')),
  probability double precision NOT NULL CHECK (probability >= 0 AND probability <= 1),
  reason_codes text[] NOT NULL,
  rationale jsonb NOT NULL CHECK (jsonb_typeof(rationale) = 'object'),
  quotes jsonb NOT NULL CHECK (jsonb_typeof(quotes) = 'array'),
  input_confidence double precision NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow', 'active')),
  applied boolean NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  override_decision text CHECK (override_decision IN ('open', 'discard')),
  override_by text,
  override_at timestamptz,
  override_note text,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT adjudications_one_per_expectation UNIQUE (clinic_id, expectation_id),
  CONSTRAINT adjudications_override_consistent CHECK (
    (override_decision IS NULL) = (override_by IS NULL)
    AND (override_decision IS NULL) = (override_at IS NULL)
  )
);

CREATE INDEX adjudications_created_idx ON adjudications (clinic_id, created_at DESC, seq DESC);
CREATE INDEX adjudications_patient_idx ON adjudications (clinic_id, patient_id, created_at DESC);

ALTER TABLE adjudications ENABLE ROW LEVEL SECURITY;
