-- ============================================================
-- Add agent_portfolios many-to-many table
-- Run this in Supabase SQL Editor
-- ============================================================

-- Create junction table for agent-portfolio assignment
CREATE TABLE agent_portfolios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  portfolio_id      UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  assigned_at       TIMESTAMPTZ DEFAULT NOW(),
  assigned_by       UUID REFERENCES agents(id),
  UNIQUE(agent_id, portfolio_id)
);

-- Create index for fast lookup
CREATE INDEX idx_agent_portfolios_agent_id ON agent_portfolios(agent_id);
CREATE INDEX idx_agent_portfolios_portfolio_id ON agent_portfolios(portfolio_id);

-- Enable RLS
ALTER TABLE agent_portfolios ENABLE ROW LEVEL SECURITY;

-- RLS policy: agents can only see their own portfolio assignments
CREATE POLICY "agent_portfolios_own_client"
  ON agent_portfolios FOR ALL
  USING (
    agent_id IN (
      SELECT id FROM agents WHERE client_id = auth_client_id()
    )
  );

-- Seed: Assign portfolios to agents
-- Priya Patel gets both HDFC and Bajaj
INSERT INTO agent_portfolios (agent_id, portfolio_id, assigned_by) VALUES
  ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001');

-- Amit Verma gets only Bajaj
INSERT INTO agent_portfolios (agent_id, portfolio_id, assigned_by) VALUES
  ('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001');

-- Rahul Sharma (manager) gets both for oversight
INSERT INTO agent_portfolios (agent_id, portfolio_id, assigned_by) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001');
