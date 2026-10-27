-- Attribution of bookings and clinic metrics (HIP-141).
--
--   * `clinical_events.origin_type` / `origin_case_id`: where a booking came
--     from, for `appointment.booked` events. The engine verifies the origin
--     the host claims on the FHIR Appointment (the case Task, the
--     CommunicationRequest it answers) and stores it in the event payload
--     (`origin.type`, `origin.caseId`); these columns are generated from that
--     payload, so the adapter writes nothing new and old rows read `organic`.
--     `follow_up_case`: booked while the team worked the case;
--     `patient_contact`: booked after a contact attempt; `organic`: neither.
--   * Indexes for the metrics read model: bookings by origin case, cases by
--     the instant they reached the inbox (`release_at` for a held backfill
--     case), case events by type (plan-item reviews, attribution events).
--
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE clinical_events
  ADD COLUMN origin_type text GENERATED ALWAYS AS (
    CASE
      WHEN type = 'appointment.booked' THEN COALESCE(payload #>> '{origin,type}', 'organic')
    END
  ) STORED,
  ADD COLUMN origin_case_id text GENERATED ALWAYS AS (
    CASE WHEN type = 'appointment.booked' THEN payload #>> '{origin,caseId}' END
  ) STORED;

ALTER TABLE clinical_events
  ADD CONSTRAINT clinical_events_origin_type_check CHECK (
    origin_type IS NULL OR origin_type IN ('follow_up_case', 'patient_contact', 'organic')
  ),
  -- An attributed booking names its case; an organic one names none.
  ADD CONSTRAINT clinical_events_origin_case_check CHECK (
    origin_type IS NULL
    OR (origin_type = 'organic' AND origin_case_id IS NULL)
    OR (origin_type <> 'organic' AND origin_case_id IS NOT NULL)
  );

CREATE INDEX clinical_events_origin_case_idx ON clinical_events (clinic_id, origin_case_id)
  WHERE origin_case_id IS NOT NULL;

-- Plan extractions by note (the extraction cost of the notes behind a case).
CREATE INDEX clinical_events_plan_note_idx
  ON clinical_events (clinic_id, (payload->>'sourceDocumentId'))
  WHERE type = 'plan.extracted';

CREATE INDEX follow_up_cases_opened_idx
  ON follow_up_cases (clinic_id, (GREATEST(created_at, COALESCE(release_at, created_at))), id);

CREATE INDEX case_events_type_idx ON case_events (clinic_id, type, at);
