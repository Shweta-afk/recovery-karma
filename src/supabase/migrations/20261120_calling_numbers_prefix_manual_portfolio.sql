-- Calling numbers: which number a borrower sees (user, 2026-11-20).
--
-- SkyCRM shows the borrower the number whose PREFIX is sent with the call (prefix 3701 → DID
-- 079 6926 3701; list from SkyCRM, 2026-11-20). Until now every call sent the agent's extension
-- as the prefix, so each agent always showed the same number. Now:
--   * a superadmin gives each company its numbers (telephony_dids, unchanged) with their prefixes;
--   * the company ADMIN marks which of them are for Manual Dial — Manual Dial uses only those;
--   * a MANAGER picks, per portfolio, which of the other numbers its Call Queue calls use
--     (click-to-call, Progressive and Productive Dial). A portfolio with none picked can't dial.
--   * every call rotates: the least-used allowed number today (did-rules.ts pickCallerNumber).
-- A company that holds no numbers at all keeps the old behaviour (vendor default).
-- Code: src/lib/calling-numbers.server.ts, telephony/guard.server.ts chooseDid.

-- 1. The prefix SkyCRM dials with to show this number (3–6 digits).
ALTER TABLE telephony_dids ADD COLUMN IF NOT EXISTS prefix TEXT;
ALTER TABLE telephony_dids DROP CONSTRAINT IF EXISTS telephony_dids_prefix_check;
ALTER TABLE telephony_dids ADD CONSTRAINT telephony_dids_prefix_check
  CHECK (prefix IS NULL OR prefix ~ '^[0-9]{3,6}$');
CREATE UNIQUE INDEX IF NOT EXISTS telephony_dids_prefix_unique
  ON telephony_dids (prefix) WHERE prefix IS NOT NULL;

-- 2. Kept for Manual Dial by the company's admin. A manual number is never on a portfolio list.
ALTER TABLE telephony_dids ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;

-- 3. Which numbers each portfolio's Call Queue calls go out on. One number may serve several
--    portfolios of its company. Server-only: written and read through the service role after
--    the caller is checked (calling-numbers.server.ts).
-- check:sql server-only: portfolio_dids
CREATE TABLE IF NOT EXISTS portfolio_dids (
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  did_id       UUID NOT NULL REFERENCES telephony_dids(id) ON DELETE CASCADE,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  chosen_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (portfolio_id, did_id)
);
CREATE INDEX IF NOT EXISTS portfolio_dids_did ON portfolio_dids (did_id);

ALTER TABLE portfolio_dids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE portfolio_dids FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE portfolio_dids TO service_role;

-- telephony_dids.portfolio_id (one portfolio per number, superadmin-set) is superseded by
-- portfolio_dids. Carry over anything set there, then stop using it.
INSERT INTO portfolio_dids (portfolio_id, did_id, client_id)
SELECT d.portfolio_id, d.id, d.client_id
FROM telephony_dids d
WHERE d.portfolio_id IS NOT NULL AND d.client_id IS NOT NULL AND d.status = 'assigned'
ON CONFLICT DO NOTHING;
