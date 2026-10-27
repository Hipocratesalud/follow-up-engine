-- A clinician's rejection is its own condition status (`rejected`, exported as
-- FHIR verificationStatus `refuted`). Until now a rejection was stored as
-- `resolved` with confidence 0 and the reviewer in `confirmed_by`, which the
-- FHIR export read as "confirmed, then resolved".

ALTER TABLE patient_conditions DROP CONSTRAINT IF EXISTS patient_conditions_status_check;
ALTER TABLE patient_conditions
  ADD CONSTRAINT patient_conditions_status_check
  CHECK (status IN ('confirmed', 'probable', 'resolved', 'rejected'));

UPDATE patient_conditions
SET status = 'rejected'
WHERE status = 'resolved' AND confidence = 0 AND confirmed_by IS NOT NULL;
