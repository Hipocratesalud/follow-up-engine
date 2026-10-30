-- A closed expectation's closure reclassified after the fact, never rewritten.
--
--   * `expectations.reclassified_reason` / `reclassified_at` /
--     `reclassified_by_type` / `reclassified_by_id`: what the closure reads
--     as now, when a later fact changed its meaning (a doctor's-plan test
--     folded into the order of the same visit, `covered_by_order`, whose
--     order the end of the pregnancy then cancelled reads
--     `pregnancy_ended`). `closed_reason`, `closed_at` and `closed_by_*`
--     keep the original closure. Null for every other expectation.
--   * `expectation_events`: the append-only audit of those changes
--     (`closed_reason_reclassified`): when, from which reason to which, why
--     (`episode_ended`), the resource that caused it and the expectation
--     that carried it over (the order). Engine-written; ids, codes and
--     dates only. Covers expectations that never became a case.
--
-- Every table carries `clinic_id` and gets row-level security (0005).
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE expectations
  ADD COLUMN reclassified_reason text,
  ADD COLUMN reclassified_at timestamptz,
  ADD COLUMN reclassified_by_type text,
  ADD COLUMN reclassified_by_id text,
  ADD CONSTRAINT expectations_reclassified_consistent CHECK (
    (reclassified_reason IS NULL) = (reclassified_at IS NULL)
    AND (reclassified_reason IS NULL) = (reclassified_by_type IS NULL)
    AND (reclassified_reason IS NULL) = (reclassified_by_id IS NULL)
    AND (reclassified_reason IS NULL OR closed_reason IS NOT NULL)
  );

CREATE TABLE expectation_events (
  clinic_id text NOT NULL,
  id text NOT NULL,
  seq bigserial,
  patient_id text NOT NULL,
  expectation_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('closed_reason_reclassified')),
  actor text NOT NULL CHECK (actor IN ('engine')),
  at timestamptz NOT NULL,
  from_reason text NOT NULL CHECK (from_reason <> ''),
  to_reason text NOT NULL CHECK (to_reason <> ''),
  cause text NOT NULL CHECK (cause IN ('episode_ended')),
  caused_by_type text NOT NULL,
  caused_by_id text NOT NULL,
  related_expectation_id text,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT expectation_events_reason_changes CHECK (from_reason <> to_reason)
);

CREATE INDEX expectation_events_expectation_idx
  ON expectation_events (clinic_id, expectation_id, at, seq);
CREATE INDEX expectation_events_patient_idx ON expectation_events (clinic_id, patient_id, at, seq);

ALTER TABLE expectation_events ENABLE ROW LEVEL SECURITY;
