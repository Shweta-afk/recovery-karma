-- Let call_logs record a call to someone who is not (yet) a debtor.
--
-- Manual Dial lets an agent ring an arbitrary number. That call had nowhere to go:
-- call_logs.debtor_id is `UUID REFERENCES debtors(id)`, and the UI passes a synthetic
-- id like `manual-1785496287078`, so every save was rejected with a 400 and no manual
-- call ever appeared in history.
--
-- debtor_id is already nullable, so an ad-hoc call can simply leave it NULL. These two
-- columns keep the who/what-number that would otherwise have been lost with it.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_name  TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_phone TEXT;

COMMENT ON COLUMN call_logs.contact_name IS
  'Name for a call not tied to a debtor row (Manual Dial). NULL when debtor_id is set.';
COMMENT ON COLUMN call_logs.contact_phone IS
  'Number dialled for a call not tied to a debtor row (Manual Dial).';

-- Ad-hoc calls are looked up by number when reconciling them against a debtor later.
CREATE INDEX IF NOT EXISTS idx_call_logs_contact_phone
  ON call_logs(contact_phone) WHERE contact_phone IS NOT NULL;
