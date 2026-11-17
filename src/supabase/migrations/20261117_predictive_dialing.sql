-- Vendor-side predictive dialling (SkyCRM API v1.2 §24, 2026-11-17). "Productive Dial" now asks
-- SkyCRM to dial the BORROWER first and put whoever answers through to a free extension logged
-- into a queue (login_in_queue1 → predictive_call per borrower → logout_queue1). Code:
-- src/lib/telephony/server.ts predictiveDial(), rules in predictive-rules.ts.
--
-- Code deployed before this file is applied keeps the old click-to-call Productive Dial: every
-- read of these columns falls back when they are missing.

-- 1. Per company: the SkyCRM queue its predictive calls go into. Set by a superadmin on the
--    company's Calling card. NULL = no predictive dialling (click-to-call, one line per agent).
ALTER TABLE telephony_settings ADD COLUMN IF NOT EXISTS predictive_queue TEXT;
ALTER TABLE telephony_settings DROP CONSTRAINT IF EXISTS telephony_settings_predictive_queue_check;
ALTER TABLE telephony_settings ADD CONSTRAINT telephony_settings_predictive_queue_check
  CHECK (predictive_queue IS NULL OR predictive_queue ~ '^[0-9]{3,6}$');

-- 2. Per call (server-only ledger): which queue a predictive call went into, and the extension
--    sent in the request. A predictive row has agent_id/agent_handle NULL until SkyCRM's answer
--    event names the extension that took it, so webhook events are matched to it by the
--    borrower's number (ledgerForWebhook) until SkyCRM's callid is stored.
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS predictive_queue TEXT;
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS request_extension TEXT;

CREATE INDEX IF NOT EXISTS telephony_calls_open_predictive
  ON telephony_calls (started_at DESC)
  WHERE predictive_queue IS NOT NULL AND ended_at IS NULL;
