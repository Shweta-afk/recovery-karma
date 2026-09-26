-- The "Lookup data by Loan ID" Excel is request-only for companies: a company admin/manager asks,
-- a superadmin (the platform — Axiotta) approves or rejects, and an approval lets that company
-- download that portfolio's file for 7 days. The file is every field of every lookup — PAN, DOB,
-- father's name, addresses — for a whole portfolio at once, which is why it is gated when viewing
-- one account on screen is not.
--
-- profilex_settings.direct_export lets a superadmin exempt a company (the platform's own) so it
-- downloads straight away. Off by default: a new company requests.
--
-- Enforced server-side (src/lib/insights-export-actions.server.ts): the "All fields" data only
-- comes back from getPortfolioLookupExport, which checks direct_export or an approved, unexpired
-- request for that portfolio. Hiding the button is not the control.

ALTER TABLE profilex_settings ADD COLUMN IF NOT EXISTS direct_export BOOLEAN NOT NULL DEFAULT FALSE;

-- check:sql server-only: insights_export_requests
CREATE TABLE IF NOT EXISTS insights_export_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  portfolio_id   UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  requested_by   UUID REFERENCES agents(id) ON DELETE SET NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by     UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  expires_at     TIMESTAMPTZ,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_download_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open request per portfolio: a second click (or a second manager) is the same request.
CREATE UNIQUE INDEX IF NOT EXISTS insights_export_requests_one_pending_idx
  ON insights_export_requests (portfolio_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS insights_export_requests_status_idx
  ON insights_export_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS insights_export_requests_portfolio_idx
  ON insights_export_requests (portfolio_id, created_at DESC);

-- Server-only: every read and write goes through the service-role actions, after verifyCaller /
-- verifySuperadminCaller. No policies, so a browser session can neither read nor forge an approval.
ALTER TABLE insights_export_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE insights_export_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE insights_export_requests TO service_role;
