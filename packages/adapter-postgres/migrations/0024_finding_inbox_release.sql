-- The daily cap of live clinical-reviewer finding cards per doctor (PRD V3,
-- alert fatigue; docs/reviewer.md "Inbox cards per validated category").
--
--   * `clinical_findings.released_at` / `released_to`: when a live finding
--     reached the doctor's inbox and whose daily quota it took (the patient's
--     owner, or `unassigned`). Null while it waits for a later day's slot.
--     Nothing is dropped: a finding over the cap stays open and queued.

ALTER TABLE clinical_findings
  ADD COLUMN released_at timestamptz,
  ADD COLUMN released_to text CHECK (released_to IS NULL OR length(released_to) BETWEEN 1 AND 200),
  ADD CONSTRAINT clinical_findings_release_complete
    CHECK ((released_at IS NULL) = (released_to IS NULL));

CREATE INDEX clinical_findings_released_idx
  ON clinical_findings (clinic_id, released_at)
  WHERE released_at IS NOT NULL;
