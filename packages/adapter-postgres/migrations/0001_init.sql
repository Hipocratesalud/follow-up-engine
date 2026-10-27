-- Follow-up Engine: initial schema.
--
-- The runner executes this file with `search_path` set to the engine schema
-- (default `follow_up`), so table names are unqualified on purpose: the same
-- file installs into an isolated schema in tests.
--
-- Conventions:
--   * every table has `clinic_id text NOT NULL` and every index used by a
--     query leads with it (tenant isolation, see CONTRIBUTING.md);
--   * entity ids are host- or engine-generated strings, unique per clinic,
--     so primary keys are `(clinic_id, id)`;
--   * instants are `timestamptz`; FHIR-shaped or nested values are `jsonb`
--     next to the relational columns that queries filter and sort on;
--   * no cross-aggregate foreign keys: aggregates are written independently
--     (in either order inside a unit of work) and tenancy is the invariant
--     that matters, enforced by `clinic_id` on every key;
--   * only built-ins available on vanilla Postgres 13+ and Supabase
--     (`gen_random_uuid()` is in core since PG 13; no extensions).

-- Tenants -------------------------------------------------------------------

CREATE TABLE clinics (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- Partial `ClinicSettings`; missing keys fall back to engine defaults.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  -- sha256 hex of the clinic's API key. The key itself is never stored.
  api_key_hash text UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinics_id_not_blank CHECK (id <> '' AND id = btrim(id))
);

CREATE INDEX clinics_active_idx ON clinics (id) WHERE active;

-- Clinical record -------------------------------------------------------------

-- Latest version of every FHIR resource the host pushed. History is not kept
-- here: `clinical_events` is the append-only log derived from each version,
-- and the host EHR remains the system of record.
CREATE TABLE clinical_resources (
  clinic_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  -- Engine-assigned, starts at 1 and increments only when content changes.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  patient_id text NOT NULL,
  resource jsonb NOT NULL CHECK (jsonb_typeof(resource) = 'object'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, resource_type, resource_id)
);

CREATE INDEX clinical_resources_patient_idx ON clinical_resources (clinic_id, patient_id);

CREATE TABLE clinical_events (
  -- Insertion order, used to break ties on `occurred_at`.
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id text NOT NULL,
  type text NOT NULL,
  -- Byte order, so `listPatientIds` pages deterministically whatever the database locale.
  patient_id text COLLATE "C" NOT NULL,
  encounter_id text,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  -- The full typed event (dates as ISO 8601 strings).
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinical_events_idempotency_key UNIQUE (clinic_id, idempotency_key)
);

CREATE INDEX clinical_events_patient_idx ON clinical_events (clinic_id, patient_id, occurred_at, seq);
CREATE INDEX clinical_events_encounter_idx ON clinical_events (clinic_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

CREATE TABLE patient_conditions (
  clinic_id text NOT NULL,
  patient_id text NOT NULL,
  code_system text NOT NULL,
  code text NOT NULL,
  code_display text,
  status text NOT NULL CHECK (status IN ('confirmed', 'probable', 'resolved')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_type text NOT NULL CHECK (
    source_type IN (
      'recorded', 'inferred_from_medication', 'inferred_from_result', 'extracted_from_note'
    )
  ),
  source_resource_type text NOT NULL,
  source_resource_id text NOT NULL,
  confirmed_by text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, patient_id, code_system, code)
);

-- Expectations ---------------------------------------------------------------

CREATE TABLE expectations (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  idempotency_key text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  layer text NOT NULL CHECK (layer IN ('universal', 'doctor_plan', 'cadence', 'protocol')),
  source_type text NOT NULL,
  source_id text NOT NULL,
  match_key text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'fulfilled', 'superseded', 'expired', 'cancelled')),
  case_id text,
  closed_reason text,
  closed_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('live', 'backfill')),
  protocol_id text,
  protocol_version text,
  reason_code text NOT NULL,
  reason_label text NOT NULL,
  -- `{ quote, sourceDocumentId }` for doctor_plan expectations.
  evidence jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT expectations_idempotency_key UNIQUE (clinic_id, idempotency_key)
);

-- The watcher's hot path: open expectations by deadline.
CREATE INDEX expectations_open_due_idx ON expectations (clinic_id, due_at, id) WHERE status = 'open';
CREATE INDEX expectations_open_patient_idx ON expectations (clinic_id, patient_id, due_at)
  WHERE status = 'open';
CREATE INDEX expectations_case_idx ON expectations (clinic_id, case_id) WHERE case_id IS NOT NULL;

-- Cases ----------------------------------------------------------------------

CREATE TABLE follow_up_cases (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  dedup_key text NOT NULL,
  -- `[{ expectationId, reasonCode }]`
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  status text NOT NULL CHECK (
    status IN ('open', 'notified', 'snoozed', 'escalated', 'resolved', 'dismissed', 'lost_to_follow_up')
  ),
  priority integer NOT NULL,
  assignee text,
  escalation_step integer NOT NULL DEFAULT 0 CHECK (escalation_step >= 0),
  next_action_at timestamptz,
  snoozed_until timestamptz,
  release_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('live', 'backfill')),
  -- `{ kind, resolvedAt, resolvedBy?, note? }`
  resolution jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

-- At most one active case per dedup key (ACTIVE_CASE_STATUSES in core).
CREATE UNIQUE INDEX follow_up_cases_active_dedup_key ON follow_up_cases (clinic_id, dedup_key)
  WHERE status IN ('open', 'notified', 'snoozed', 'escalated');
CREATE INDEX follow_up_cases_inbox_idx ON follow_up_cases (clinic_id, status, priority DESC, created_at, id);
CREATE INDEX follow_up_cases_patient_idx ON follow_up_cases (clinic_id, patient_id);
CREATE INDEX follow_up_cases_next_action_idx ON follow_up_cases (clinic_id, next_action_at)
  WHERE status IN ('open', 'notified', 'snoozed', 'escalated') AND next_action_at IS NOT NULL;
CREATE INDEX follow_up_cases_snoozed_idx ON follow_up_cases (clinic_id, snoozed_until)
  WHERE status = 'snoozed';

-- Append-only audit trail.
CREATE TABLE case_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id text NOT NULL,
  case_id text NOT NULL,
  type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('rule', 'user', 'patient', 'system')),
  actor_id text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  at timestamptz NOT NULL
);

CREATE INDEX case_events_case_idx ON case_events (clinic_id, case_id, at, seq);

CREATE TABLE case_feedback (
  clinic_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  useful boolean NOT NULL,
  reason text CHECK (
    reason IN ('wrong_rule', 'wrong_interval', 'bad_extraction', 'already_handled', 'other')
  ),
  comment text,
  author_id text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX case_feedback_case_idx ON case_feedback (clinic_id, case_id, created_at);
CREATE INDEX case_feedback_created_idx ON case_feedback (clinic_id, created_at, id);

CREATE TABLE quality_findings (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  kind text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  detected_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX quality_findings_patient_idx ON quality_findings (clinic_id, patient_id, detected_at);

-- LLM accounting -------------------------------------------------------------

CREATE TABLE llm_calls (
  clinic_id text NOT NULL,
  call_id text NOT NULL,
  task text NOT NULL,
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cost_usd numeric(20, 10) NOT NULL CHECK (cost_usd >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  ok boolean NOT NULL,
  error text,
  at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, call_id)
);

CREATE INDEX llm_calls_at_idx ON llm_calls (clinic_id, at);

-- Transactional outbox -------------------------------------------------------

CREATE TABLE outbox (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  -- The full `DomainEvent` (dates as ISO 8601 strings).
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_event_id UNIQUE (clinic_id, event_id)
);

CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at, seq) WHERE status = 'pending';

-- Job queue (claimed with FOR UPDATE SKIP LOCKED, see ADR 0003) ---------------

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'dead')),
  run_at timestamptz NOT NULL,
  -- Number of times the job was leased; 1 during the first run.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_token uuid,
  lease_expires_at timestamptz,
  leased_by text,
  last_error text,
  dedup_key text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  CONSTRAINT jobs_lease_consistent CHECK ((status = 'running') = (lease_token IS NOT NULL))
);

-- Claim path: runnable pending jobs by run_at, and running jobs whose lease expired.
CREATE INDEX jobs_pending_idx ON jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX jobs_running_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_clinic_idx ON jobs (clinic_id, status);
-- A dedup key is unique among unfinished jobs: enqueueing it again while the
-- first one is pending or running is a no-op; once finished, it can run again.
CREATE UNIQUE INDEX jobs_dedup_key ON jobs (clinic_id, type, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('pending', 'running');

-- Initial backfill -----------------------------------------------------------

CREATE TABLE backfill_progress (
  clinic_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  -- Last patient id fully processed (`listPatientIds` cursor); null before the first page.
  patient_cursor text,
  patients_scanned integer NOT NULL DEFAULT 0 CHECK (patients_scanned >= 0),
  expectations_created integer NOT NULL DEFAULT 0 CHECK (expectations_created >= 0),
  cases_opened integer NOT NULL DEFAULT 0 CHECK (cases_opened >= 0),
  last_error text,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (clinic_id, run_id)
);

-- At most one running backfill per clinic.
CREATE UNIQUE INDEX backfill_progress_one_running ON backfill_progress (clinic_id)
  WHERE status = 'running';
