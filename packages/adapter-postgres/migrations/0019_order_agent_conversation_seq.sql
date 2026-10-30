-- The order agent's conversations in the order they were started.
--
-- `listConversations` is oldest first and the agent page shows the last
-- one. A story restarted on a lab clock that has not moved starts at the
-- same `created_at` as the one before, and ordering the tie by
-- `patient_id` (a random suffix) showed an older Maria instead of the new
-- one. `seq` records the order rows were first inserted (an upsert keeps
-- it); rows that exist before this migration get one in arbitrary order.
-- Runs with `search_path` set to the engine schema, like 0001.

ALTER TABLE order_agent_conversations ADD COLUMN seq bigserial;
