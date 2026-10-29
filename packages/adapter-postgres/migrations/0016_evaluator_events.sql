-- The hosted demo's evaluator lab (docs/deploy.md#hosted-demo): an
-- append-only log of what each evaluator (identified by the email they gave
-- the access gate, never a Supabase user) did, across the shared demo
-- clinic and their own sandbox "lab" clinics. Read by the "Evaluators"
-- admin page and `GET /api/demo/evaluator-events` (the store lives in
-- `@follow-up-engine/runtime`, `src/evaluator-events.ts`, next to the
-- API key store; this migration only owns the table, like `api_keys`
-- in 0005).
--
-- `simulated_at` is the engine clock's `now()` at the time of the action
-- (what the evaluator was looking at); `occurred_at` is the wall clock (when
-- it really happened). Never readable through the Supabase Data API: RLS is
-- on and `supabase/rls.sql` grants it no policy, like `api_keys`.
--
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE TABLE evaluator_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL,
  clinic_id text NOT NULL,
  evaluator_email text NOT NULL CHECK (length(evaluator_email) BETWEEN 3 AND 320),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type text CHECK (entity_type IS NULL OR length(entity_type) BETWEEN 1 AND 100),
  entity_id text,
  patient_id text,
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  simulated_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT evaluator_events_id_unique UNIQUE (id)
);

CREATE INDEX evaluator_events_clinic_idx ON evaluator_events (clinic_id, seq DESC);
CREATE INDEX evaluator_events_evaluator_idx ON evaluator_events (evaluator_email, seq DESC);

ALTER TABLE evaluator_events ENABLE ROW LEVEL SECURITY;
