-- Optional row-level security for Supabase hosts that expose the `follow_up`
-- schema to clinic users through the Data API (PostgREST / supabase-js), for
-- example to render the inbox straight from the database.
--
-- Apply after `migrate()` (see docs/deploy.md); it is idempotent. Requires
-- Supabase's `auth.jwt()` and its `authenticated` / `anon` roles.
--
-- Model:
--   * Every engine table gets RLS. With no policy, a table is invisible to
--     API roles (internal tables: jobs, outbox, backfill progress, migrations).
--   * Clinic users read their clinic's rows only: `clinic_id` must equal the
--     `clinic_id` claim of their JWT (set it with a custom access token hook).
--   * API roles never write. Writes go through the engine API, which applies
--     the business rules and the audit trail.
--   * The engine connects as the role that ran the migrations (`postgres`),
--     which owns the tables and is therefore not subject to these policies.

-- Every table, including internal ones: no policy means no API access.
ALTER TABLE follow_up.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.clinical_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.clinical_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.patient_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.expectations ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.follow_up_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.case_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.quality_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up.backfill_progress ENABLE ROW LEVEL SECURITY;

-- Privileges: anonymous callers get nothing; signed-in users may read.
REVOKE ALL ON ALL TABLES IN SCHEMA follow_up FROM anon, authenticated;
GRANT USAGE ON SCHEMA follow_up TO authenticated;

GRANT SELECT ON
  follow_up.clinical_resources,
  follow_up.clinical_events,
  follow_up.patient_conditions,
  follow_up.expectations,
  follow_up.follow_up_cases,
  follow_up.case_events,
  follow_up.case_feedback,
  follow_up.quality_findings,
  follow_up.llm_calls
TO authenticated;

-- The clinic row without its API key hash.
GRANT SELECT (id, name, active, settings, created_at, updated_at) ON follow_up.clinics TO authenticated;

DROP POLICY IF EXISTS clinic_reads_itself ON follow_up.clinics;
CREATE POLICY clinic_reads_itself ON follow_up.clinics
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.jwt() ->> 'clinic_id'));

-- `(SELECT auth.jwt() ...)` is evaluated once per statement, not per row.
DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.clinical_resources;
CREATE POLICY clinic_reads_own_rows ON follow_up.clinical_resources
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.clinical_events;
CREATE POLICY clinic_reads_own_rows ON follow_up.clinical_events
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.patient_conditions;
CREATE POLICY clinic_reads_own_rows ON follow_up.patient_conditions
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.expectations;
CREATE POLICY clinic_reads_own_rows ON follow_up.expectations
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.follow_up_cases;
CREATE POLICY clinic_reads_own_rows ON follow_up.follow_up_cases
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.case_events;
CREATE POLICY clinic_reads_own_rows ON follow_up.case_events
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.case_feedback;
CREATE POLICY clinic_reads_own_rows ON follow_up.case_feedback
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.quality_findings;
CREATE POLICY clinic_reads_own_rows ON follow_up.quality_findings
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.llm_calls;
CREATE POLICY clinic_reads_own_rows ON follow_up.llm_calls
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));
