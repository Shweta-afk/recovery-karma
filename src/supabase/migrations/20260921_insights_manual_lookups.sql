-- Insights: lookups an admin types in by hand (Admin > Insights).
--
-- `debtor_traces` cannot hold these: debtor_id is NOT NULL and its cache/in-flight logic is keyed
-- on the debtor. A manual lookup has no debtor, so it gets its own ledger with the same shape
-- (who ran it, what it cost, what came back) and nothing more.
--
-- Deliberately NO insert/update/delete policy: like debtor_traces, every write goes through the
-- service-role server action (runManualInsight), which has verified the caller is an admin, that
-- the service is on their company's plan, and actually paid the provider.
--
-- Policy uses only SECURITY DEFINER helpers (auth_client_id, auth_role), per the rule in
-- 20260821_rls_no_direct_table_reads.sql. No BEGIN/COMMIT — the runner supplies the transaction.

CREATE TABLE IF NOT EXISTS insights_manual_lookups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  service_id       TEXT NOT NULL,
  requested_by     UUID REFERENCES agents(id),
  -- The value typed in (mobile / UAN / GSTIN), used to block a double-click paying twice.
  query_key        TEXT NOT NULL,
  -- The request body actually sent (mobile, firstName, ...).
  input            JSONB NOT NULL DEFAULT '{}'::jsonb,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','done','failed')),
  http_status      INTEGER,
  provider_status  TEXT,
  billable         BOOLEAN NOT NULL DEFAULT FALSE,
  -- What THIS company was charged (its rate card); the real provider price is charged to the
  -- superadmin actual wallet separately, exactly as for debtor_traces.
  cost             NUMERIC(10,2) NOT NULL DEFAULT 0,
  transaction_id   TEXT,
  response         JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS insights_manual_lookups_client_created_idx
  ON insights_manual_lookups (client_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS insights_manual_lookups_one_in_flight_idx
  ON insights_manual_lookups (client_id, service_id, query_key) WHERE state = 'pending';

ALTER TABLE insights_manual_lookups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insights_manual_lookups_select ON insights_manual_lookups;
CREATE POLICY insights_manual_lookups_select ON insights_manual_lookups FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');
