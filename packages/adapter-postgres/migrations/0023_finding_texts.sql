-- The clinical reviewer's findings in every review locale (docs/reviewer.md,
-- "Inbox cards per validated category").
--
--   * `clinical_findings.texts`: `{ "en": { summary, rationale, suggestion },
--     "es": { ... } }`. The detectors render each locale from the same
--     templates and the reviewing model returns both languages; the inbox
--     shows the reader's language. `summary`, `rationale` and `suggestion`
--     stay the clinic's locale. Null for findings stored before: readers fall
--     back to those columns. Quotes are never translated.

ALTER TABLE clinical_findings
  ADD COLUMN texts jsonb CHECK (texts IS NULL OR jsonb_typeof(texts) = 'object');
