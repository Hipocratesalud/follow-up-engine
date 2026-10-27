-- Recording order for clinician feedback.
--
-- The latest verdict on a case wins (the inbox and the feedback stats read
-- the last row). `created_at` comes from the engine clock, so two verdicts
-- recorded on the same simulated instant (the demo's fake clock) tie, and
-- the random UUID id is no tiebreaker: changing "No útil" to "Útil" could
-- read back as "No útil". `seq` is a monotonic recording order; readers
-- order by `created_at, seq`. Existing rows are numbered in table order,
-- as good as any for history that already tied.
--
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE case_feedback ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE case_feedback ADD CONSTRAINT case_feedback_seq_key UNIQUE (seq);

DROP INDEX case_feedback_case_idx;
DROP INDEX case_feedback_created_idx;
CREATE INDEX case_feedback_case_idx ON case_feedback (clinic_id, case_id, created_at, seq);
CREATE INDEX case_feedback_created_idx ON case_feedback (clinic_id, created_at, seq);
