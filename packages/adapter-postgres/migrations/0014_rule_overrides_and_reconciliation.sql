-- Per-clinic rule overrides and the nightly reconciliation (HIP-141).
--
--   * `rule_overrides`: the override in force for a clinic and rule (a
--     different deadline, or the rule switched off). `version` is the rule's
--     change counter for the clinic: expectations created under the override
--     carry it in their rule version (`1.0.0+clinic.3`).
--   * `rule_override_history`: append-only, one row per change (a reset
--     included): who, when, the override before and after, and why. Its row
--     count per clinic is the revision a cached rule set is validated
--     against, also across processes.
--   * `reconciliation_runs`: resumable runs of the nightly reconciliation:
--     scope, the event watermark the next `recent` run starts from, cursor
--     and counters (`repairs_by_kind` as a jsonb object of counts).
--   * `reconciliation_repairs`: append-only audit of every repair a run made
--     (actor `system`, reason `reconciliation`). Ids and codes only.
--   * `clinical_events (clinic_id, seq)`: the reconciliation's `recent`
--     scope reads the patients with events stored after a watermark.
--   * `api_keys.scopes` accepts `admin:rules` (the rule configuration API).
--
-- None of the new tables is readable by clinic users through Supabase: RLS
-- is on and supabase/rls.sql grants no policy (configuration and audit stay
-- behind the engine API).
--
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE TABLE rule_overrides (
  clinic_id text NOT NULL,
  rule_id text NOT NULL CHECK (rule_id <> ''),
  due_in_days integer CHECK (due_in_days IS NULL OR due_in_days BETWEEN 1 AND 3650),
  enabled boolean,
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (clinic_id, rule_id),
  CONSTRAINT rule_overrides_not_empty CHECK (due_in_days IS NOT NULL OR enabled IS NOT NULL)
);

CREATE TABLE rule_override_history (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id text NOT NULL,
  rule_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  action text NOT NULL CHECK (action IN ('set', 'reset')),
  -- `{ dueInDays?, enabled? }` before and after; NULL when there was none.
  previous jsonb CHECK (previous IS NULL OR jsonb_typeof(previous) = 'object'),
  next jsonb CHECK (next IS NULL OR jsonb_typeof(next) = 'object'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  at timestamptz NOT NULL,
  CONSTRAINT rule_override_history_version UNIQUE (clinic_id, rule_id, version),
  CONSTRAINT rule_override_history_shape CHECK (
    (action = 'set' AND next IS NOT NULL) OR (action = 'reset' AND next IS NULL)
  )
);

CREATE INDEX rule_override_history_clinic_idx ON rule_override_history (clinic_id, seq DESC);

CREATE TABLE reconciliation_runs (
  clinic_id text NOT NULL,
  run_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('recent', 'all')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  watermark text,
  since text,
  patient_cursor text,
  patients_scanned integer NOT NULL DEFAULT 0 CHECK (patients_scanned >= 0),
  patients_repaired integer NOT NULL DEFAULT 0 CHECK (patients_repaired >= 0),
  patients_skipped integer NOT NULL DEFAULT 0 CHECK (patients_skipped >= 0),
  repairs integer NOT NULL DEFAULT 0 CHECK (repairs >= 0),
  repairs_by_kind jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(repairs_by_kind) = 'object'),
  last_error text,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (clinic_id, run_id)
);

-- At most one unfinished run per clinic.
CREATE UNIQUE INDEX reconciliation_runs_one_running ON reconciliation_runs (clinic_id)
  WHERE status = 'running';
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (clinic_id, started_at DESC, run_id DESC);

CREATE TABLE reconciliation_repairs (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id text NOT NULL,
  run_id text NOT NULL,
  patient_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'expectation_created', 'expectation_fulfilled', 'expectation_superseded',
    'expectation_cancelled', 'expectation_reopened', 'expectation_unlinked',
    'condition_recorded', 'case_opened', 'case_resolved'
  )),
  entity_id text NOT NULL,
  rule_id text,
  from_status text,
  to_status text,
  detail text,
  actor_type text NOT NULL CHECK (actor_type = 'system'),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (reason = 'reconciliation'),
  at timestamptz NOT NULL
);

CREATE INDEX reconciliation_repairs_run_idx ON reconciliation_repairs (clinic_id, run_id, seq);
CREATE INDEX reconciliation_repairs_patient_idx ON reconciliation_repairs (clinic_id, patient_id, seq);

-- The `recent` scope: patients with events stored after a watermark (a `seq`).
CREATE INDEX clinical_events_clinic_seq_idx ON clinical_events (clinic_id, seq);

ALTER TABLE rule_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_override_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_repairs ENABLE ROW LEVEL SECURITY;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) > 0
  AND scopes <@ ARRAY[
    'fhir:write', 'inbox:read', 'inbox:act', 'demo:clock', 'demo:ingest', 'admin:rules'
  ]::text[]
);
