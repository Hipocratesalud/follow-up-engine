-- Follow-up Engine: fields the core added after 0001.
--
--   * `patient_conditions.evidence`: the verbatim quote behind a condition read
--     from a note (`PatientCondition.evidence`).
--   * `backfill_progress`: the full `BackfillProgress` of the core port: a
--     `paused_budget` status (the clinic's LLM budget ran out; the run resumes
--     from its cursor), shadow runs, and every counter the run reports in
--     `backfill.completed`.
--
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE patient_conditions ADD COLUMN evidence jsonb
  CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object');

ALTER TABLE backfill_progress DROP CONSTRAINT backfill_progress_status_check;
ALTER TABLE backfill_progress ADD CONSTRAINT backfill_progress_status_check
  CHECK (status IN ('running', 'paused_budget', 'completed', 'failed'));

ALTER TABLE backfill_progress
  ADD COLUMN shadow boolean NOT NULL DEFAULT false,
  ADD COLUMN events_processed integer NOT NULL DEFAULT 0 CHECK (events_processed >= 0),
  ADD COLUMN documents_processed integer NOT NULL DEFAULT 0 CHECK (documents_processed >= 0),
  ADD COLUMN expectations_fulfilled integer NOT NULL DEFAULT 0 CHECK (expectations_fulfilled >= 0),
  ADD COLUMN llm_cost_usd numeric(20, 10) NOT NULL DEFAULT 0 CHECK (llm_cost_usd >= 0);

-- At most one unfinished (running or paused) backfill per clinic.
DROP INDEX backfill_progress_one_running;
CREATE UNIQUE INDEX backfill_progress_one_unfinished ON backfill_progress (clinic_id)
  WHERE status IN ('running', 'paused_budget');

-- `ExpectationRepository.listByPatient`: every expectation of a patient, any status.
CREATE INDEX expectations_patient_idx ON expectations (clinic_id, patient_id, due_at, id);
