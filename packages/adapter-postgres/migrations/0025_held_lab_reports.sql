-- Imported lab reports held for the clinic team (V1-A, "Import history"):
-- the name printed on the report is not the patient's, so nothing reached
-- the record and no order could close. One row per document per clinic
-- (`document_key`, the import's content key: a re-import never reads it
-- again). "It's this patient" records it like an accepted report;
-- "Not this patient" discards it. Who decided and when is kept.
-- `printed_name` / `record_name` are clinical identifiers: never logged.

CREATE TABLE held_lab_reports (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  document_key text NOT NULL,
  filename text NOT NULL,
  document_date timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  printed_date timestamptz,
  printed_name text,
  record_name text,
  reason text NOT NULL CHECK (reason IN ('name_mismatch')),
  source text NOT NULL CHECK (source IN ('photo', 'text')),
  model text,
  results jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'discarded')),
  created_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT held_lab_reports_document_unique UNIQUE (clinic_id, document_key)
);

CREATE INDEX held_lab_reports_status_idx ON held_lab_reports (clinic_id, status, created_at DESC);

ALTER TABLE held_lab_reports ENABLE ROW LEVEL SECURITY;
