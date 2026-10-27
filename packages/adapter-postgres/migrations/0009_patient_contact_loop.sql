-- Patient-contact loop and dismissals that stick (HIP-136).
--
--   * `contact_requests`: one row per attempt to reach a patient about a
--     case (exported as FHIR `CommunicationRequest`): channel hint, generic
--     purpose, why it exists (policy step, user, wrong number), attempt
--     number within the case and the end of its answer window.
--   * `contact_communications`: what came of an attempt (FHIR
--     `Communication`), stored at its latest version per id: an older
--     version is never written over a newer one.
--   * `patient_contact_flags`: the patient's contact data looks wrong (a
--     wrong number); one row per patient and issue, cleared when a later
--     attempt reaches the patient.
--   * `patient_rule_suppressions`: a rule or protocol item stopped for one
--     patient ("not applicable"), audited and reversible; at most one active
--     per patient and rule. Revoked rows stay as history.
--   * `follow_up_cases.escalation_policy_id`: the named, versioned policy a
--     case opened with (`default_v2`), so a clinic switching policies does
--     not move the steps of cases in progress.
--   * `case_feedback.reason`: a dismissal records its reason as the case's
--     feedback, so the dismissal reasons join the feedback reasons.
--
-- Every table carries `clinic_id` and gets row-level security (0005).
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE follow_up_cases ADD COLUMN escalation_policy_id text;

ALTER TABLE case_feedback DROP CONSTRAINT IF EXISTS case_feedback_reason_check;
ALTER TABLE case_feedback
  ADD CONSTRAINT case_feedback_reason_check
  CHECK (
    reason IN (
      'wrong_rule', 'wrong_interval', 'bad_extraction', 'already_handled', 'other',
      'handled_elsewhere', 'already_done', 'not_applicable_to_patient', 'wrong_diagnosis'
    )
  );

CREATE TABLE contact_requests (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  case_id text NOT NULL,
  channel text CHECK (channel IS NULL OR channel IN ('whatsapp', 'phone_call', 'sms', 'email')),
  purpose text NOT NULL CHECK (
    purpose IN ('schedule_follow_up', 'complete_pending_test', 'review_results', 'medication_review')
  ),
  trigger text NOT NULL CHECK (trigger IN ('policy', 'user', 'wrong_number')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  policy_step integer CHECK (policy_step IS NULL OR policy_step >= 0),
  requested_by text,
  requested_at timestamptz NOT NULL,
  due_by timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX contact_requests_patient_idx ON contact_requests (clinic_id, patient_id, requested_at, id);
CREATE INDEX contact_requests_case_idx ON contact_requests (clinic_id, case_id, requested_at, id);

CREATE TABLE contact_communications (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  case_id text NOT NULL,
  request_id text NOT NULL,
  channel text CHECK (channel IS NULL OR channel IN ('whatsapp', 'phone_call', 'sms', 'email')),
  status text NOT NULL CHECK (
    status IN (
      'preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed',
      'entered-in-error', 'unknown'
    )
  ),
  outcome text CHECK (
    outcome IS NULL OR outcome IN (
      'delivered', 'read', 'replied', 'booked', 'declined', 'treated_elsewhere',
      'wrong_number', 'no_answer'
    )
  ),
  sent_at timestamptz,
  received_at timestamptz,
  sender_type text NOT NULL CHECK (sender_type IN ('host', 'user')),
  sender_id text,
  version_id text,
  last_updated timestamptz,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id)
);

CREATE INDEX contact_communications_patient_idx
  ON contact_communications (clinic_id, patient_id, recorded_at, id);
CREATE INDEX contact_communications_case_idx
  ON contact_communications (clinic_id, case_id, recorded_at, id);

CREATE TABLE patient_contact_flags (
  clinic_id text NOT NULL,
  patient_id text NOT NULL,
  issue text NOT NULL CHECK (issue IN ('wrong_number')),
  raised_at timestamptz NOT NULL,
  communication_id text NOT NULL,
  channel text CHECK (channel IS NULL OR channel IN ('whatsapp', 'phone_call', 'sms', 'email')),
  cleared_at timestamptz,
  PRIMARY KEY (clinic_id, patient_id, issue)
);

CREATE TABLE patient_rule_suppressions (
  clinic_id text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  rule_id text NOT NULL,
  -- `{ code, label }`: the rule's reason when it was suppressed.
  reason jsonb NOT NULL CHECK (jsonb_typeof(reason) = 'object'),
  dismiss_reason text NOT NULL CHECK (
    dismiss_reason IN (
      'handled_elsewhere', 'already_done', 'not_applicable_to_patient', 'wrong_diagnosis',
      'wrong_interval', 'other'
    )
  ),
  note text,
  case_id text,
  created_by text,
  created_at timestamptz NOT NULL,
  revoked_by text,
  revoked_at timestamptz,
  PRIMARY KEY (clinic_id, id)
);

-- At most one active suppression per patient and rule.
CREATE UNIQUE INDEX patient_rule_suppressions_active_key
  ON patient_rule_suppressions (clinic_id, patient_id, rule_id)
  WHERE revoked_at IS NULL;
CREATE INDEX patient_rule_suppressions_patient_idx
  ON patient_rule_suppressions (clinic_id, patient_id, created_at);

ALTER TABLE contact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_contact_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_rule_suppressions ENABLE ROW LEVEL SECURITY;
