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

-- ────────────────────────────────────────────────────────────
-- Correlate a saved call log back to the provider's own call
-- ────────────────────────────────────────────────────────────
-- recording_url has existed since the original schema but is almost always NULL at the
-- moment an agent dispositions: the provider produces recordings asynchronously and its
-- hangup webhook carries `"recording_url": ""`. Filling it in later means asking the
-- provider about a specific call, and nothing on call_logs identified one — so the id
-- returned when the call was placed (e.g. Exotel's Call Sid) is stored here.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS provider_call_id TEXT;

COMMENT ON COLUMN call_logs.provider_call_id IS
  'Provider''s id for this call (e.g. Exotel Call Sid). Used to backfill recording_url from the CDR.';

-- Supports "find my logs still missing a recording", the backfill's driving query.
CREATE INDEX IF NOT EXISTS idx_call_logs_pending_recording
  ON call_logs(provider_call_id)
  WHERE provider_call_id IS NOT NULL AND recording_url IS NULL;
