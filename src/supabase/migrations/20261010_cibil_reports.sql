-- CIBIL credit reports through PayPrime (b2b.payprime.in) — an Insights service for company
-- ADMINS only (src/lib/cibil-actions.server.ts).
--
-- Two things live here:
--
-- 1. The consent agreement. Every PayPrime request asserts `user_consent_data_share: true` on
--    the borrower's behalf, so a superadmin may only put CIBIL on a company's plan after
--    recording that the company has confirmed (contractually) that it holds borrower consent.
--    runCibilReport refuses while cibil_consent_at is NULL; turning the agreement off clears it.
--
-- 2. The reports themselves. A credit report is far more sensitive than a skip-trace result, and
--    debtor_traces is readable by the assigned AGENT (debtor_traces_select). So the ledger row in
--    debtor_traces carries no report data — only status/txn id/cost, which keeps billing, usage
--    and every Insights report working unchanged — and the report goes here, server-only, read
--    by admins through getCibilReport after verifyCaller. No RLS policy was changed for this.

ALTER TABLE profilex_settings ADD COLUMN IF NOT EXISTS cibil_consent_at TIMESTAMPTZ;
ALTER TABLE profilex_settings ADD COLUMN IF NOT EXISTS cibil_consent_by UUID
  REFERENCES superadmins(id) ON DELETE SET NULL;
ALTER TABLE profilex_settings ADD COLUMN IF NOT EXISTS cibil_consent_note TEXT;

-- check:sql server-only: cibil_reports
CREATE TABLE IF NOT EXISTS cibil_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  debtor_id     UUID NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  -- The billing ledger row for this pull.
  trace_id      UUID REFERENCES debtor_traces(id) ON DELETE SET NULL,
  requested_by  UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- What was sent (never the API token): name, PAN, DOB, address... as typed by the admin.
  request       JSONB NOT NULL,
  txn_id        TEXT,
  html_url      TEXT,
  score         INTEGER,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cibil_reports_debtor_idx ON cibil_reports (debtor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cibil_reports_client_idx ON cibil_reports (client_id, created_at DESC);

ALTER TABLE cibil_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cibil_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cibil_reports TO service_role;
