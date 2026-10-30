-- The order-to-completion agent (docs/agent/order-to-completion.md): its own
-- records next to the engine's. The agent never writes an expectation: it
-- talks to the patient, books and submits results through FHIR ingestion,
-- and the engine alone marks what is fulfilled.
--
--   * `order_agent_conversations`: one per patient the agent owns orders
--     for: mode, language, ladder state, per-order progress.
--   * `order_agent_messages`: the simulated WhatsApp thread, with delivery
--     status, offered slots, transcripts and photo readings.
--   * `order_agent_media`: the bytes of voice notes and photos.
--   * `order_agent_runs` and `order_agent_steps`: the trace of every turn
--     (model calls, tool calls, engine events), ordered by `seq`.
--   * `order_agent_tasks`: staff tasks for reception and the doctor.
--   * `order_agent_appointments`: bookings, one per confirming message and
--     one per slot (unique constraints, the idempotency the agent relies on).
--
-- Every table carries `clinic_id` and gets row-level security (0005); none
-- is exposed through the Supabase Data API (no policy in supabase/rls.sql).
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE TABLE order_agent_conversations (
  clinic_id text NOT NULL,
  patient_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('scripted', 'live')),
  language text NOT NULL CHECK (language IN ('en', 'es')),
  status text NOT NULL CHECK (status IN ('active', 'done', 'unreachable', 'opted_out')),
  phone_status text NOT NULL CHECK (phone_status IN ('ok', 'undelivered')),
  ladder jsonb NOT NULL CHECK (jsonb_typeof(ladder) = 'object'),
  orders jsonb NOT NULL CHECK (jsonb_typeof(orders) = 'array'),
  retry_at timestamptz,
  flag_at_next_contact boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, patient_id)
);

CREATE TABLE order_agent_messages (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  kind text NOT NULL CHECK (kind IN ('text', 'voice', 'image')),
  text text NOT NULL,
  at timestamptz NOT NULL,
  delivery_status text CHECK (
    delivery_status IS NULL OR delivery_status IN ('sent', 'delivered', 'read', 'undelivered')
  ),
  status_at timestamptz,
  offered_slots jsonb,
  media jsonb,
  transcript text,
  reading jsonb,
  rung text,
  run_id text,
  proactive boolean,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX order_agent_messages_patient_idx ON order_agent_messages (clinic_id, patient_id, at);

CREATE TABLE order_agent_media (
  clinic_id text NOT NULL,
  id text NOT NULL,
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 100),
  data bytea NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE TABLE order_agent_runs (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  mode text NOT NULL CHECK (mode IN ('scripted', 'live')),
  model text,
  inbound_message_id text,
  rung text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  model_calls integer NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  stop_reason text,
  error text,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX order_agent_runs_patient_idx ON order_agent_runs (clinic_id, patient_id, started_at);
CREATE INDEX order_agent_runs_inbound_idx
  ON order_agent_runs (clinic_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

CREATE TABLE order_agent_steps (
  seq bigserial,
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  run_id text,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  tool text,
  arguments jsonb,
  read text[],
  reason text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error', 'info')),
  event text NOT NULL,
  params jsonb,
  model text,
  cost_usd numeric(12, 6),
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX order_agent_steps_patient_idx ON order_agent_steps (clinic_id, patient_id, seq);

CREATE TABLE order_agent_tasks (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('call_patient', 'update_phone', 'call_other_contact', 'doctor_notice')
  ),
  priority text NOT NULL CHECK (priority IN ('normal', 'high')),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  status text NOT NULL CHECK (status IN ('open', 'done')),
  rung text,
  created_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX order_agent_tasks_patient_idx ON order_agent_tasks (clinic_id, patient_id, created_at);

CREATE TABLE order_agent_appointments (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  order_id text NOT NULL,
  slot_id text NOT NULL,
  slot jsonb NOT NULL CHECK (jsonb_typeof(slot) = 'object'),
  confirmation_message_id text NOT NULL,
  booked_at timestamptz NOT NULL,
  fhir_appointment_id text,
  origin_case_id text,
  PRIMARY KEY (clinic_id, id),
  CONSTRAINT order_agent_appointments_confirmation_unique UNIQUE (clinic_id, confirmation_message_id),
  CONSTRAINT order_agent_appointments_slot_unique UNIQUE (clinic_id, slot_id)
);

ALTER TABLE order_agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_agent_appointments ENABLE ROW LEVEL SECURITY;
