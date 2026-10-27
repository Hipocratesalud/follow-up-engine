-- The `demo` scope is split in two (HIP-129):
--
--   * `demo:clock`: move the shared fake clock and read the demo webhook feed.
--   * `demo:ingest`: save demo consultations, only into the demo clinic.
--
-- A key that had `demo` keeps only `demo:clock` (the least privilege); the
-- demo clinic's inbox key gets both again the next time the demo boots.
--
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;

UPDATE api_keys
SET scopes = array_append(array_remove(scopes, 'demo'), 'demo:clock')
WHERE 'demo' = ANY (scopes) AND NOT 'demo:clock' = ANY (scopes);

UPDATE api_keys SET scopes = array_remove(scopes, 'demo') WHERE 'demo' = ANY (scopes);

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) > 0
  AND scopes <@ ARRAY['fhir:write', 'inbox:read', 'inbox:act', 'demo:clock', 'demo:ingest']::text[]
);
