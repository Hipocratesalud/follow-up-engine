-- The order agent accepts a lab report the patient sends as a PDF (V1-A,
-- "PDF/Word in historical mode"): `order_agent_messages.kind` gains
-- `document`. Its bytes live in `order_agent_media` like a photo's; its
-- reading (`reading`) is the same lab-result reading as a photo's.

ALTER TABLE order_agent_messages DROP CONSTRAINT IF EXISTS order_agent_messages_kind_check;
ALTER TABLE order_agent_messages
  ADD CONSTRAINT order_agent_messages_kind_check
  CHECK (kind IN ('text', 'voice', 'image', 'document'));
