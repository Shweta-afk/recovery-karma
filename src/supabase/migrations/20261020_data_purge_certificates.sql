-- Data purging certificates (user, 2026-10-20). A company admin/manager requests one for a
-- portfolio; a superadmin (SamvadX) fills in the letter and issues it; the company then opens and
-- prints it. The letter is FROM SamvadX TO the company and states that the portfolio's borrower
-- data was purged. Issuing it deletes nothing — a document only (user's decision, 2026-10-20).
--
-- The allocation table (accounts and outstanding by DPD bucket) and both parties' details are
-- frozen into the row when it is issued, so the certificate never changes afterwards — not when
-- debtors are later stripped or archived, nor when either side edits its billing details.
--
-- Server-only, like insights_export_requests: every read and write goes through the service-role
-- actions in src/lib/data-purge.server.ts after verifyCaller / verifySuperadminCaller.

-- check:sql server-only: data_purge_requests
CREATE TABLE IF NOT EXISTS data_purge_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  portfolio_id    UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  requested_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'issued', 'declined')),
  decided_by      UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  -- The issued certificate: letter fields, parties and allocation (see src/lib/data-purge.ts).
  certificate     JSONB,
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open request per portfolio: a second click (or a second manager) is the same request.
CREATE UNIQUE INDEX IF NOT EXISTS data_purge_requests_one_pending_idx
  ON data_purge_requests (portfolio_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS data_purge_requests_status_idx
  ON data_purge_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS data_purge_requests_portfolio_idx
  ON data_purge_requests (portfolio_id, created_at DESC);

ALTER TABLE data_purge_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE data_purge_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE data_purge_requests TO service_role;
