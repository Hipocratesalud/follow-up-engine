-- A scanned PDF lab report (no usable text layer: each page an image) is
-- read like a photo, from its pixels, by the vision model: source `scan`.
-- For a clinic that does not send unmasked images to a model provider
-- (`allowUnmaskedImagesToProvider`, off by default) it is never read: it is
-- held for the team with reason `scan_not_allowed`, like a photo.

ALTER TABLE held_lab_reports DROP CONSTRAINT IF EXISTS held_lab_reports_reason_check;
ALTER TABLE held_lab_reports
  ADD CONSTRAINT held_lab_reports_reason_check
  CHECK (reason IN ('name_mismatch', 'photo_not_allowed', 'scan_not_allowed'));

ALTER TABLE held_lab_reports DROP CONSTRAINT IF EXISTS held_lab_reports_source_check;
ALTER TABLE held_lab_reports
  ADD CONSTRAINT held_lab_reports_source_check
  CHECK (source IN ('photo', 'text', 'scan'));
