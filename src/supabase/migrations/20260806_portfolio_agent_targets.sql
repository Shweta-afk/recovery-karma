-- Per-agent, per-portfolio collection targets.
--
-- Distinct from agents.daily_target (a single, portfolio-agnostic daily call-count goal):
-- this lets a manager set, for one specific portfolio, how much a given agent should
-- recover (₹) and/or how many accounts they should close — set from the new "Edit
-- Portfolio" flow, alongside account allocation.

CREATE TABLE IF NOT EXISTS portfolio_agent_targets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID REFERENCES clients(id),
  portfolio_id     UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_amount    DECIMAL(14,2),
  target_accounts  INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (portfolio_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_agent_targets_portfolio
  ON portfolio_agent_targets(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_agent_targets_agent
  ON portfolio_agent_targets(agent_id);

ALTER TABLE portfolio_agent_targets ENABLE ROW LEVEL SECURITY;

-- Mirrors portfolios' post-hardening policy (20260730_harden_rls.sql): all staff on the
-- client can read, only managers/admins can write.
DROP POLICY IF EXISTS portfolio_agent_targets_select ON portfolio_agent_targets;
CREATE POLICY portfolio_agent_targets_select ON portfolio_agent_targets FOR SELECT TO authenticated
  USING (client_id = auth_client_id());

DROP POLICY IF EXISTS portfolio_agent_targets_write ON portfolio_agent_targets;
CREATE POLICY portfolio_agent_targets_write ON portfolio_agent_targets FOR ALL TO authenticated
  USING (client_id = auth_client_id() AND auth_role() IN ('admin', 'manager'))
  WITH CHECK (client_id = auth_client_id() AND auth_role() IN ('admin', 'manager'));

-- The table is queried by refreshPortfolios() on every mount. PostgREST will keep answering
-- 404 from a stale schema cache until it is told to reload, so do it here rather than leaving
-- the app to look broken for the next few minutes.
NOTIFY pgrst, 'reload schema';
