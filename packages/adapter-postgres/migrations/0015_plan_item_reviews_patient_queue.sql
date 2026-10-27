-- Clinician review of AI-read plan items, and the patient queue (HIP-141).
--
--   * `expectations.confirmed_by` / `confirmed_at`: a clinician confirmed
--     what the AI read from the note (doctor's plan items). A correction is
--     confirmed by whoever made it.
--   * `expectations.correction_of`: the expectation a clinician's correction
--     replaced (superseded with `corrected_by_clinician`).
--   * `plan_item_reviews`: the append-only audit of those verdicts
--     (`plan_item_confirmed`, `plan_item_corrected`, `plan_item_rejected`):
--     who, when, what the AI read and what the clinician set. Ids, codes and
--     dates only: no note text. Covers items that never became a case.
--   * `follow_up_cases_patient_queue_idx`: the inbox groups active cases by
--     patient and ranks patients by their most urgent case.
--
-- Every table carries `clinic_id` and gets row-level security (0005).
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE expectations
  ADD COLUMN confirmed_by text,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN correction_of text,
  ADD CONSTRAINT expectations_confirmed_consistent
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL));

CREATE TABLE plan_item_reviews (
  clinic_id text NOT NULL,
  id text NOT NULL,
  seq bigserial,
  patient_id text NOT NULL,
  expectation_id text NOT NULL,
  type text NOT NULL CHECK (
    type IN ('plan_item_confirmed', 'plan_item_corrected', 'plan_item_rejected')
  ),
  user_id text NOT NULL CHECK (user_id <> ''),
  at timestamptz NOT NULL,
  case_id text,
  before_kind text NOT NULL,
  before_due_at timestamptz NOT NULL,
  after_kind text,
  after_due_at timestamptz,
  replacement_id text,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT plan_item_reviews_correction_consistent CHECK (
    (type = 'plan_item_corrected') = (after_kind IS NOT NULL)
    AND (after_kind IS NULL) = (after_due_at IS NULL)
    AND (after_kind IS NULL) = (replacement_id IS NULL)
  )
);

CREATE INDEX plan_item_reviews_expectation_idx
  ON plan_item_reviews (clinic_id, expectation_id, at, seq);
CREATE INDEX plan_item_reviews_patient_idx ON plan_item_reviews (clinic_id, patient_id, at, seq);
CREATE INDEX plan_item_reviews_at_idx ON plan_item_reviews (clinic_id, at, seq);

CREATE INDEX follow_up_cases_patient_queue_idx
  ON follow_up_cases (clinic_id, patient_id, priority DESC, created_at, id)
  WHERE status IN ('open', 'notified', 'snoozed', 'escalated');

ALTER TABLE plan_item_reviews ENABLE ROW LEVEL SECURITY;
