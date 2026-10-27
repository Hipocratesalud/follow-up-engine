-- Follow-up Engine: appointment and visit lifecycle v2, result severity,
-- withdrawn diagnoses.
--
--   * `expectations.recheck_at`: fulfilled by a booking, when to check the
--     visit took place (the appointment date plus the grace days). The
--     watcher re-decides the expectation then; a booking with no visit no
--     longer fulfills it.
--   * `expectations.severity`: `critical` for the follow-up of a panic
--     result (due sooner, ranked above every other reason).
--   * `patient_conditions.status` `entered_in_error`: a diagnosis the host
--     entered in error or moved to another patient was never this
--     patient's (exported as FHIR `entered-in-error`).
--   * A diagnosis the host refuted is `rejected` with no reviewer. Until now
--     every host withdrawal was stored as `resolved` with confidence 0 and no
--     reviewer, which the FHIR export read as "confirmed, then resolved";
--     those rows become `rejected` (the patient does not have it).
--
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE expectations
  ADD COLUMN recheck_at timestamptz,
  ADD COLUMN severity text CHECK (severity IS NULL OR severity IN ('critical'));

-- The watcher's recheck sweep: fulfilled by a booking, by recheck date.
CREATE INDEX expectations_recheck_idx ON expectations (clinic_id, recheck_at, id)
  WHERE status = 'fulfilled' AND recheck_at IS NOT NULL;

ALTER TABLE patient_conditions DROP CONSTRAINT IF EXISTS patient_conditions_status_check;
ALTER TABLE patient_conditions
  ADD CONSTRAINT patient_conditions_status_check
  CHECK (status IN ('confirmed', 'probable', 'resolved', 'rejected', 'entered_in_error'));

UPDATE patient_conditions
SET status = 'rejected'
WHERE status = 'resolved' AND confidence = 0 AND confirmed_by IS NULL;
