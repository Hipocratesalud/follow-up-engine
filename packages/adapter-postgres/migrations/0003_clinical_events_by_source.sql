-- Follow-up Engine: look up a resource's events across patients.
--
-- When the host corrects the subject of a resource it already sent (an order
-- re-sent for another patient), the engine withdraws what it derived for the
-- old patient (`ClinicalRecordRepository.findOtherPatientsWithSources`).
--
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE INDEX clinical_events_source_idx ON clinical_events (clinic_id, source_type, source_id);
