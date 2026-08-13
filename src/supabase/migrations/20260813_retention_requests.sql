-- Retention requests: an agent asks to keep working a specific debtor account into the next
-- portfolio cycle (e.g. an active PTP, mid-negotiation) instead of it being recalled once the
-- bank's next file replaces the current portfolio. A manager reviews and, if they agree, the
-- account gets bundled into an export sent to the bank asking them to include it again.
--
-- Approval is NOT a guarantee — the bank decides what actually comes back in its next file, so
-- 'sent_to_bank' has two possible outcomes once that next portfolio is uploaded and linked via
-- portfolios.replaces_portfolio_id (see reconcileRetentionRequests in portfolio-store.ts):
--   'carried'      the account showed up in the new file and was carried forward
--   'not_honored'  the bank did not include it — request lapses, account stays in the closed
--                  old portfolio like any other recalled one
--
-- Full state machine: pending_manager -> approved -> sent_to_bank -> {carried | not_honored}
--                                      -> rejected (manager declines, never goes to the bank)
CREATE TABLE IF NOT EXISTS retention_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id       UUID NOT NULL REFERENCES debtors(id),
  -- The portfolio the account was requested FROM (the old/closing one) — not where it ends up.
  portfolio_id    UUID NOT NULL REFERENCES portfolios(id),
  requested_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending_manager' CHECK (status IN (
                    'pending_manager', 'approved', 'rejected', 'sent_to_bank',
                    'carried', 'not_honored'
                  )),
  reviewed_by     UUID REFERENCES agents(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  sent_to_bank_at TIMESTAMPTZ,
  carried_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retention_requests_portfolio_id ON retention_requests(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_retention_requests_debtor_id ON retention_requests(debtor_id);

ALTER TABLE retention_requests ENABLE ROW LEVEL SECURITY;

-- Same tenant scoping + role gate as settlement_requests (20260730_harden_rls.sql): any
-- agent/manager/admin at the company can read and raise a request; only a manager/admin can
-- move it out of pending_manager. debtor_id is NOT NULL here (unlike call_logs etc.) since a
-- retention request only ever makes sense against a real uploaded debtor row, so this skips
-- the "debtor_id IS NULL OR" clause those tables needed for ad-hoc manual-dial rows.
CREATE POLICY retention_requests_select ON retention_requests FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY retention_requests_insert ON retention_requests FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY retention_requests_update ON retention_requests FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
    AND auth_role() IN ('admin', 'manager')
  )
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

-- Links a new portfolio upload to the old cycle it continues, so createPortfolio() knows whose
-- sent_to_bank retention_requests to reconcile and which portfolio to close out afterward.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS replaces_portfolio_id UUID REFERENCES portfolios(id);
-- Stamped on the OLD portfolio once its replacement has been uploaded and linked — queue-building
-- excludes debtors left in a closed portfolio (carried-forward ones have already been moved to
-- the new portfolio_id by then, so they keep showing up as normal).
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Stamped on a debtor row the moment it's carried forward via a 'carried' retention request —
-- the UI badge ("Retained · from {old portfolio}") reads this plus portfolios.name.
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS retained_from_portfolio_id UUID REFERENCES portfolios(id);
