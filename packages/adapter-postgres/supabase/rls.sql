-- Optional row-level security for Supabase hosts that expose the `follow_up`
-- schema to clinic users through the Data API (PostgREST / supabase-js), for
-- example to render the inbox straight from the database.
--
-- Apply after `migrate()` (see docs/deploy.md); it is idempotent. Requires
-- Supabase's `auth.jwt()` and its `authenticated` / `anon` roles.
--
-- Model:
--   * Every engine table gets RLS (found in the catalog, not listed by hand).
--     With no policy, a table is invisible to API roles (internal tables:
--     jobs, outbox, backfill progress, migrations, API keys). A test
--     (src/rls.test.ts, runs in CI) fails on any table without RLS, on any
--     policy that is not a read for `authenticated`, and on any table where a
--     clinic's JWT reads a row of another clinic (checked by actually reading
--     synthetic rows of two clinics, with broad grants).
--   * Clinic users read their clinic's rows only: `clinic_id` must equal the
--     `clinic_id` claim of their JWT (set it with a custom access token hook).
--   * API roles never write. Writes go through the engine API, which applies
--     the business rules and the audit trail.
--   * The engine connects as the role that ran the migrations (`postgres`),
--     which owns the tables and is therefore not subject to these policies.

-- Every table, including internal ones and any a later migration adds
-- (migration 0004 already enables RLS on every engine table; this repeats it
-- for databases migrated before): no policy means no API access.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.oid::regclass AS name
    FROM pg_class c
    WHERE c.relnamespace = 'follow_up'::regnamespace AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.name);
  END LOOP;
END
$$;

-- Privileges: anonymous callers get nothing; signed-in users may read. Also
-- for tables created later by this role (the migrations): Supabase's guide
-- to exposing a custom schema grants ALL to anon and authenticated by
-- default; do not follow it for `follow_up`.
REVOKE ALL ON ALL TABLES IN SCHEMA follow_up FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA follow_up FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA follow_up REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA follow_up REVOKE ALL ON SEQUENCES FROM anon, authenticated;
REVOKE ALL ON SCHEMA follow_up FROM anon;
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
  follow_up.llm_calls,
  follow_up.contact_requests,
  follow_up.contact_communications,
  follow_up.patient_contact_flags,
  follow_up.patient_rule_suppressions,
  follow_up.plan_item_reviews
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

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.contact_requests;
CREATE POLICY clinic_reads_own_rows ON follow_up.contact_requests
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.contact_communications;
CREATE POLICY clinic_reads_own_rows ON follow_up.contact_communications
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.patient_contact_flags;
CREATE POLICY clinic_reads_own_rows ON follow_up.patient_contact_flags
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.patient_rule_suppressions;
CREATE POLICY clinic_reads_own_rows ON follow_up.patient_rule_suppressions
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

-- Plan item reviews (migration 0015): the clinicians' verdicts on AI-read plan items.
DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.plan_item_reviews;
CREATE POLICY clinic_reads_own_rows ON follow_up.plan_item_reviews
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));

-- Clinical reviewer (migration 0010). Shadow findings are never readable by
-- clinic users, not even their own clinic's: only the engine API's batch
-- review shows them, to the clinical staff validating the reviewer. Live
-- findings and the flags are readable like every other clinic row. Review
-- runs (cost, tool trace) stay internal.
GRANT SELECT ON follow_up.clinical_findings, follow_up.finding_flags TO authenticated;

DROP POLICY IF EXISTS clinic_reads_own_live_findings ON follow_up.clinical_findings;
CREATE POLICY clinic_reads_own_live_findings ON follow_up.clinical_findings
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id') AND mode <> 'shadow');

DROP POLICY IF EXISTS clinic_reads_own_rows ON follow_up.finding_flags;
CREATE POLICY clinic_reads_own_rows ON follow_up.finding_flags
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT auth.jwt() ->> 'clinic_id'));
