-- Dead-account archiving (decided 2026-09-23): once a portfolio has been closed for 60 days,
-- each account with nothing still open on it (no recent PTP/callback, no retention request in
-- flight) is written to a slim Excel file in Supabase Storage — name, loan ID, phone, every call
-- with its disposition and feedback, every Insights result — and then STRIPPED, not deleted:
-- its bank-file `extra` columns and email are cleared and `archived_at` is stamped.
--
-- Why strip, not delete: call_logs, payments, disputes and settlement_requests all reference
-- debtors with no ON DELETE, and Reports' past months are computed from payments — deleting
-- would either fail or silently rewrite history. The thin row that remains keeps every one of
-- those links intact, keeps phone_primary so Insights lookup reuse still finds the borrower,
-- and sheds the ~1.4KB/row `extra` blob that dominates every debtor read.
--
-- The job itself lives in src/lib/dead-account-archive.server.ts (it needs Node to write the
-- Excel file); this migration only adds the marker column and the file ledger. The storage
-- bucket is created by that job on first use through the Storage API, not here — this project
-- has no bucket yet, and creating one from SQL depends on storage-schema grants we have not
-- relied on anywhere else.
--
-- Replay-safe (IF NOT EXISTS / DROP POLICY IF EXISTS): this directory is replayed on deploy.

ALTER TABLE debtors ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- One row per file written. `file_path` is the object's path inside the `dead-accounts` bucket,
-- always prefixed with the company id — the download action checks that prefix against the
-- caller's own company before handing out a signed URL.
CREATE TABLE IF NOT EXISTS dead_account_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id),
  portfolio_id    UUID REFERENCES portfolios(id) ON DELETE SET NULL,
  portfolio_name  TEXT NOT NULL,
  closed_at       TIMESTAMPTZ,
  file_path       TEXT NOT NULL UNIQUE,
  account_count   INTEGER NOT NULL,
  size_bytes      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dead_account_files_client_created_idx
  ON dead_account_files (client_id, created_at DESC);

-- Admins read their own company's ledger. No write policies: every write is the server job
-- (service role), so nobody can forge or remove an entry through the API.
ALTER TABLE dead_account_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dead_account_files_select ON dead_account_files;
CREATE POLICY dead_account_files_select ON dead_account_files FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');
