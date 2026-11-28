-- When a paid file was uploaded (user, 2026-11-28: "when someone uploads paid file it shows the
-- date when the file was uploaded"). Before this only accounts with an amount got a dated
-- payments row; a file of bare loan IDs set debtors.status = 'paid' and left no date anywhere.
--
-- debtors.paid_reported_at: when a paid file marked this account paid.
-- paid_file_uploads: one row per upload (who, when, file name, counts), shown on the portfolio.
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS paid_reported_at timestamptz;

CREATE TABLE IF NOT EXISTS paid_file_uploads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id),
  portfolio_id    uuid NOT NULL REFERENCES portfolios(id),
  uploaded_by     uuid REFERENCES agents(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  file_name       text,
  rows_in_file    integer NOT NULL DEFAULT 0,
  marked_paid     integer NOT NULL DEFAULT 0,
  already_paid    integer NOT NULL DEFAULT 0,
  not_found       integer NOT NULL DEFAULT 0,
  amount_recorded numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS paid_file_uploads_portfolio_idx
  ON paid_file_uploads (portfolio_id, uploaded_at DESC);

ALTER TABLE paid_file_uploads ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.paid_file_uploads TO authenticated;
GRANT ALL ON public.paid_file_uploads TO service_role;

DROP POLICY IF EXISTS paid_file_uploads_select ON paid_file_uploads;
CREATE POLICY paid_file_uploads_select ON paid_file_uploads FOR SELECT TO authenticated
  USING (client_id = (SELECT auth_client_id())
         AND portfolio_id IN (SELECT auth_visible_portfolio_ids()));

DROP POLICY IF EXISTS paid_file_uploads_insert ON paid_file_uploads;
CREATE POLICY paid_file_uploads_insert ON paid_file_uploads FOR INSERT TO authenticated
  WITH CHECK (client_id = (SELECT auth_client_id())
              AND (SELECT auth_role()) IN ('manager', 'admin')
              AND portfolio_id IN (SELECT auth_visible_portfolio_ids())
              AND uploaded_by = (SELECT auth_agent_id()));
