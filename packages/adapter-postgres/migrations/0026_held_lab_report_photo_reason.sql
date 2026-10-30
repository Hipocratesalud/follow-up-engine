-- A photo imported for a clinic that does not send unmasked images to a
-- model provider (`allowUnmaskedImagesToProvider`, off by default) is never
-- read: it is held for the team with reason `photo_not_allowed`, so they
-- read it and enter the result by hand.

ALTER TABLE held_lab_reports DROP CONSTRAINT IF EXISTS held_lab_reports_reason_check;
ALTER TABLE held_lab_reports
  ADD CONSTRAINT held_lab_reports_reason_check
  CHECK (reason IN ('name_mismatch', 'photo_not_allowed'));
