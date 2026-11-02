-- SamvadX's own copies of the archives companies download (user, 2026-10-29): if a company
-- later asks for an archive it forgot to download, a superadmin can hand it over.
--
-- Two kinds of file, both Excel, both in the private Storage bucket `saved-archives` (created by
-- the server on first use, like `dead-accounts` and `contracts`):
--   * portfolio_end — one per portfolio each time it ENDS (closed, or its end date passed):
--     every account with every bank-file column, calls & feedback, Insights, payments,
--     settlements and disputes. Saved by the daily archive run (/api/cron/archive) — before the
--     dead-account job strips anything 60 days later, so the copy still has the full bank file.
--   * month — the same file a company admin downloads from Admin → Archive History, frozen on
--     the 1st once the month has been finalised. Past months can otherwise be rebuilt by
--     "Archive now", so this keeps the copy as it was.
-- The job is src/lib/saved-archives.server.ts; rules in src/lib/saved-archives.ts.
--
-- Server-only: superadmin pages read it through the service role after verifySuperadminCaller.
-- Companies never see this table (they keep their own downloads on Archive History).
--
-- Replay-safe: this directory is replayed on deploy.

-- check:sql server-only: saved_archive_files
CREATE TABLE IF NOT EXISTS saved_archive_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id),
  kind            TEXT NOT NULL CHECK (kind IN ('portfolio_end', 'month')),
  -- portfolio_end only. SET NULL so the copy outlives a deleted portfolio; the name is kept.
  portfolio_id    UUID REFERENCES portfolios(id) ON DELETE SET NULL,
  portfolio_name  TEXT,
  -- portfolio_end: the IST day it ended, and how (closed by someone, or its end date passed).
  ended_on        DATE,
  ended_by        TEXT CHECK (ended_by IN ('closed', 'end_date')),
  -- month: 'YYYY-MM' (IST).
  month           TEXT CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  file_path       TEXT NOT NULL UNIQUE,
  size_bytes      BIGINT,
  -- Rows per sheet, e.g. {"Accounts": 5089, "Calls & feedback": 12000}.
  sheet_counts    JSONB,
  saved_by        TEXT NOT NULL DEFAULT 'schedule' CHECK (saved_by IN ('schedule', 'superadmin')),
  superadmin_id   UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  download_count  INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'portfolio_end' AND ended_on IS NOT NULL AND ended_by IS NOT NULL AND month IS NULL)
    OR (kind = 'month' AND month IS NOT NULL AND ended_on IS NULL)
  )
);

-- One copy per ending of a portfolio (a reopened-and-closed-again portfolio gets a second,
-- dated copy) and one per company-month. Two overlapping runs cannot both record a file: the
-- loser's insert fails and the server removes its upload.
CREATE UNIQUE INDEX IF NOT EXISTS saved_archive_files_portfolio_end_once
  ON saved_archive_files (portfolio_id, ended_on) WHERE kind = 'portfolio_end';
CREATE UNIQUE INDEX IF NOT EXISTS saved_archive_files_month_once
  ON saved_archive_files (client_id, month) WHERE kind = 'month';
CREATE INDEX IF NOT EXISTS saved_archive_files_client_created_idx
  ON saved_archive_files (client_id, created_at DESC);

ALTER TABLE saved_archive_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE saved_archive_files FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE saved_archive_files TO service_role;
