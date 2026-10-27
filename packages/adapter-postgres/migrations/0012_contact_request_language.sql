-- Language model (HIP-138, docs/adr/0006).
--
--   * `contact_requests.language`: the patient's preferred language (BCP-47,
--     from FHIR `Patient.communication`) when the attempt was asked. Sent on
--     `patient_contact.requested` and as `CommunicationRequest.language`, so
--     the host writes its message in it. NULL: the host never stated one.
--
-- The clinic locale (`ClinicSettings.locale`) lives in `clinics.settings`
-- (jsonb, default `en-US`) and the patient's language in `clinical_events`
-- (`patient.language_recorded`), so neither needs a column.
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE contact_requests ADD COLUMN language text
  CHECK (language IS NULL OR language ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$');
