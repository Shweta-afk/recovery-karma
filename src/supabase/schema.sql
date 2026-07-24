-- ============================================================
-- RecoveryAI — complete database schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- TABLES
-- ────────────────────────────────────────────────────────────

-- clients
CREATE TABLE clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  plan         TEXT DEFAULT 'growth' CHECK (plan IN ('starter', 'growth', 'scale')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- agents
CREATE TABLE agents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id    UUID REFERENCES clients(id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'manager', 'admin')),
  daily_target INTEGER DEFAULT 80,
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- portfolios
CREATE TABLE portfolios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID REFERENCES clients(id),
  name             TEXT NOT NULL,
  lender_name      TEXT,
  product_type     TEXT CHECK (product_type IN (
                     'home_loan','personal_loan','business_loan',
                     'credit_card','vehicle_loan','gold_loan','other'
                   )),
  priority         TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  total_accounts   INTEGER DEFAULT 0,
  scored_accounts  INTEGER DEFAULT 0,
  uploaded_by      UUID REFERENCES agents(id),
  uploaded_at      TIMESTAMPTZ DEFAULT NOW()
);

-- debtors
CREATE TABLE debtors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID REFERENCES clients(id),
  portfolio_id         UUID REFERENCES portfolios(id),
  assigned_agent_id    UUID REFERENCES agents(id),
  name                 TEXT NOT NULL,
  phone_primary        TEXT NOT NULL,
  phone_alternate      TEXT,
  email                TEXT,
  loan_amount          DECIMAL(14,2),
  outstanding_balance  DECIMAL(14,2),
  emi_amount           DECIMAL(14,2),
  dpd                  INTEGER DEFAULT 0,
  lender               TEXT,
  product_type         TEXT,
  loan_reference       TEXT,
  ai_score             INTEGER CHECK (ai_score BETWEEN 1 AND 10),
  ai_score_reason      TEXT,
  risk_flags           TEXT[] DEFAULT '{}',
  recommended_channel  TEXT DEFAULT 'call' CHECK (recommended_channel IN ('call','whatsapp','sms','bot')),
  best_contact_time    TEXT DEFAULT 'any'  CHECK (best_contact_time   IN ('morning','afternoon','evening','any')),
  suggested_tone       TEXT DEFAULT 'empathetic',
  status               TEXT DEFAULT 'active' CHECK (status IN (
                         'active','paid','settled','legal','dispute','uncontactable'
                       )),
  last_contacted_at    TIMESTAMPTZ,
  score_updated_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- call_logs
CREATE TABLE call_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id         UUID REFERENCES debtors(id),
  agent_id          UUID REFERENCES agents(id),
  call_type         TEXT DEFAULT 'human' CHECK (call_type IN ('human','bot','ai','ivr')),
  outcome           TEXT CHECK (outcome IN (
                      'paid','promised','refused','no_answer','voicemail',
                      'dispute','callback','wrong_number','deceased','escalated'
                    )),
  promise_amount    DECIMAL(14,2),
  promise_date      DATE,
  callback_datetime TIMESTAMPTZ,
  duration_seconds  INTEGER,
  raw_notes         TEXT,
  ai_notes          TEXT,
  recording_url     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- messages
CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id        UUID REFERENCES debtors(id),
  agent_id         UUID REFERENCES agents(id),
  channel          TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  direction        TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  template_name    TEXT,
  content          TEXT NOT NULL,
  status           TEXT DEFAULT 'sent' CHECK (status IN ('sent','delivered','read','failed','replied')),
  payment_link_url TEXT,
  razorpay_link_id TEXT,
  sent_at          TIMESTAMPTZ DEFAULT NOW()
);

-- payments
CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id           UUID REFERENCES debtors(id),
  agent_id            UUID REFERENCES agents(id),
  amount              DECIMAL(14,2) NOT NULL,
  payment_method      TEXT CHECK (payment_method IN ('upi','card','netbanking','cash','cheque','link')),
  razorpay_payment_id TEXT,
  razorpay_link_id    TEXT,
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  payment_type        TEXT DEFAULT 'full'    CHECK (payment_type    IN ('full','partial','settlement','emi')),
  notes               TEXT,
  received_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- disputes
CREATE TABLE disputes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id      UUID REFERENCES debtors(id),
  raised_by      UUID REFERENCES agents(id),
  dispute_type   TEXT CHECK (dispute_type IN (
                   'payment','identity','amount','legal_threat','harassment_claim','other'
                 )),
  debtor_reason  TEXT,
  agent_notes    TEXT,
  status         TEXT DEFAULT 'open' CHECK (status IN (
                   'open','under_review','resolved','escalated_legal'
                 )),
  resolved_by    UUID REFERENCES agents(id),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- settlement_requests
CREATE TABLE settlement_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id        UUID REFERENCES debtors(id),
  requested_by     UUID REFERENCES agents(id),
  approved_by      UUID REFERENCES agents(id),
  original_amount  DECIMAL(14,2),
  proposed_amount  DECIMAL(14,2),
  agent_notes      TEXT,
  status           TEXT DEFAULT 'pending_manager' CHECK (status IN (
                     'pending_manager','approved','rejected','sent_to_bank'
                   )),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- INDEXES  (speeds up the common access patterns)
-- ────────────────────────────────────────────────────────────

CREATE INDEX idx_agents_auth_user_id      ON agents(auth_user_id);
CREATE INDEX idx_agents_client_id         ON agents(client_id);
CREATE INDEX idx_portfolios_client_id     ON portfolios(client_id);
CREATE INDEX idx_debtors_client_id        ON debtors(client_id);
CREATE INDEX idx_debtors_portfolio_id     ON debtors(portfolio_id);
CREATE INDEX idx_debtors_agent_id         ON debtors(assigned_agent_id);
CREATE INDEX idx_debtors_status           ON debtors(status);
CREATE INDEX idx_debtors_dpd              ON debtors(dpd);
CREATE INDEX idx_debtors_ai_score         ON debtors(ai_score DESC);
CREATE INDEX idx_call_logs_debtor_id      ON call_logs(debtor_id);
CREATE INDEX idx_call_logs_agent_id       ON call_logs(agent_id);
CREATE INDEX idx_call_logs_created_at     ON call_logs(created_at DESC);
CREATE INDEX idx_messages_debtor_id       ON messages(debtor_id);
CREATE INDEX idx_payments_debtor_id       ON payments(debtor_id);
CREATE INDEX idx_payments_status          ON payments(status);
CREATE INDEX idx_disputes_debtor_id       ON disputes(debtor_id);
CREATE INDEX idx_disputes_status          ON disputes(status);
CREATE INDEX idx_settlement_debtor_id     ON settlement_requests(debtor_id);

-- ────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY
-- ────────────────────────────────────────────────────────────

ALTER TABLE clients              ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios           ENABLE ROW LEVEL SECURITY;
ALTER TABLE debtors              ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_requests  ENABLE ROW LEVEL SECURITY;

-- Helper: resolve the calling user's client_id once per statement
-- (used inside USING expressions below)
CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER
  AS $$
    SELECT client_id FROM agents WHERE auth_user_id = auth.uid() LIMIT 1
  $$;

-- clients — agents can only read their own client row
CREATE POLICY "clients_read_own"
  ON clients FOR SELECT
  USING (id = auth_client_id());

-- agents — all operations scoped to same client
CREATE POLICY "agents_own_client"
  ON agents FOR ALL
  USING (client_id = auth_client_id());

-- portfolios
CREATE POLICY "portfolios_own_client"
  ON portfolios FOR ALL
  USING (client_id = auth_client_id());

-- debtors
CREATE POLICY "debtors_own_client"
  ON debtors FOR ALL
  USING (client_id = auth_client_id());

-- call_logs — join-guarded via debtors
CREATE POLICY "call_logs_own_client"
  ON call_logs FOR ALL
  USING (
    debtor_id IN (
      SELECT id FROM debtors WHERE client_id = auth_client_id()
    )
  );

-- messages
CREATE POLICY "messages_own_client"
  ON messages FOR ALL
  USING (
    debtor_id IN (
      SELECT id FROM debtors WHERE client_id = auth_client_id()
    )
  );

-- payments
CREATE POLICY "payments_own_client"
  ON payments FOR ALL
  USING (
    debtor_id IN (
      SELECT id FROM debtors WHERE client_id = auth_client_id()
    )
  );

-- disputes
CREATE POLICY "disputes_own_client"
  ON disputes FOR ALL
  USING (
    debtor_id IN (
      SELECT id FROM debtors WHERE client_id = auth_client_id()
    )
  );

-- settlement_requests
CREATE POLICY "settlements_own_client"
  ON settlement_requests FOR ALL
  USING (
    debtor_id IN (
      SELECT id FROM debtors WHERE client_id = auth_client_id()
    )
  );
