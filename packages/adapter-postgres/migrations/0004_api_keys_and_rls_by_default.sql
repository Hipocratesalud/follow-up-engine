-- Scoped API keys, and row-level security on by default.
--
--   * `api_keys`: a clinic can hold several keys, each with the least scopes
--     for its job (`fhir:write` for the host integration, `inbox:read` /
--     `inbox:act` for the inbox, `demo` for the demo controls). Keys are
--     stored as sha256 hex, never in clear. The clinic's original key
--     (`clinics.api_key_hash`) keeps working as an integration key.
--   * Row-level security is enabled on every engine table, now and in every
--     later migration (a test fails on a table without it). The engine owns
--     the tables and is not subject to RLS; any other role (Supabase's
--     `anon` / `authenticated`, given broad grants by mistake) sees nothing
--     until supabase/rls.sql grants a policy.
--
-- Runs with `search_path` set to the engine schema, like 0001.

CREATE TABLE api_keys (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  clinic_id text NOT NULL REFERENCES clinics (id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['fhir:write', 'inbox:read', 'inbox:act', 'demo']::text[]
  ),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX api_keys_clinic_idx ON api_keys (clinic_id, label);

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.oid::regclass AS name
    FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.name);
  END LOOP;
END
$$;
