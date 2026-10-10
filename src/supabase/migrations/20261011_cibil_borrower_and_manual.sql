-- CIBIL now has two kinds of report (src/lib/cibil-actions.server.ts):
--   - borrower pulls by a manager — debtor_id set, ledger row in debtor_traces (trace_id), seen by
--     whoever can see that borrower;
--   - manual pulls by an admin for any person — debtor_id NULL, ledger row in
--     insights_manual_lookups (lookup_id), seen by the company's admins.
-- cibil_reports stays server-only (no policies); the server decides visibility. Idempotent.
ALTER TABLE cibil_reports ALTER COLUMN debtor_id DROP NOT NULL;
ALTER TABLE cibil_reports ADD COLUMN IF NOT EXISTS trace_id UUID
  REFERENCES debtor_traces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cibil_reports_manual_idx
  ON cibil_reports (client_id, created_at DESC) WHERE debtor_id IS NULL;
