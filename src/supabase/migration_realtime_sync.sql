-- ============================================================
-- RecoveryAI — migrate localStorage-backed features to Supabase
-- Run ONCE in Supabase → SQL Editor, after schema.sql + seed.sql.
--
-- Adds: teams, team_agents, notifications, escalations, reminders,
--       mapping_templates.
-- Extends: portfolios (settings/team_id/manager_id), debtors (extra),
--          call_logs (outcome CHECK gains 'settlement').
--
-- Safe to re-run — every statement is idempotent (IF NOT EXISTS /
-- DROP ... IF EXISTS before CREATE).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. TEAMS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id),
  name        TEXT NOT NULL,
  manager_id  UUID REFERENCES agents(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_agents (
  team_id  UUID REFERENCES teams(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_client_id       ON teams(client_id);
CREATE INDEX IF NOT EXISTS idx_teams_manager_id       ON teams(manager_id);
CREATE INDEX IF NOT EXISTS idx_team_agents_agent_id   ON team_agents(agent_id);

ALTER TABLE teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_agents   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teams_own_client" ON teams;
CREATE POLICY "teams_own_client" ON teams FOR ALL
  USING (client_id = auth_client_id());

DROP POLICY IF EXISTS "team_agents_own_client" ON team_agents;
CREATE POLICY "team_agents_own_client" ON team_agents FOR ALL
  USING (team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id()));

-- ────────────────────────────────────────────────────────────
-- 2. PORTFOLIOS — add ownership + per-portfolio settings
-- ────────────────────────────────────────────────────────────
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS settings   JSONB;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS team_id    UUID REFERENCES teams(id);
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES agents(id);

CREATE INDEX IF NOT EXISTS idx_portfolios_team_id    ON portfolios(team_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_manager_id ON portfolios(manager_id);

-- ────────────────────────────────────────────────────────────
-- 3. DEBTORS — preserve unmapped/bank-specific CSV columns
-- ────────────────────────────────────────────────────────────
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS extra JSONB DEFAULT '{}'::jsonb;

-- ────────────────────────────────────────────────────────────
-- 4. CALL_LOGS — outcome CHECK gains 'settlement'
-- ────────────────────────────────────────────────────────────
ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_outcome_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_outcome_check
  CHECK (outcome IN (
    'paid','promised','refused','no_answer','voicemail',
    'dispute','callback','wrong_number','deceased','escalated','settlement'
  ));

-- ────────────────────────────────────────────────────────────
-- 5. NOTIFICATIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID REFERENCES clients(id),
  to_agent_id  UUID REFERENCES agents(id),
  from_name    TEXT NOT NULL,
  message      TEXT NOT NULL,
  read         BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_to_agent ON notifications(to_agent_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_recipient_only" ON notifications;
CREATE POLICY "notifications_recipient_only" ON notifications FOR ALL
  USING (to_agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid()));

-- Senders need to INSERT a notification addressed to someone else in the
-- same org (e.g. admin notifying a manager) — the USING clause above also
-- governs INSERT (no separate WITH CHECK given), so allow inserts to any
-- teammate in the same client instead of just self.
DROP POLICY IF EXISTS "notifications_send_within_client" ON notifications;
CREATE POLICY "notifications_send_within_client" ON notifications FOR INSERT
  WITH CHECK (client_id = auth_client_id());

-- ────────────────────────────────────────────────────────────
-- 6. ESCALATIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id),
  debtor_id   UUID REFERENCES debtors(id),
  reason      TEXT,
  priority    TEXT DEFAULT 'normal' CHECK (priority IN ('normal','urgent','critical')),
  notes       TEXT,
  agent_id    UUID REFERENCES agents(id),
  resolved    BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalations_debtor_id ON escalations(debtor_id);
CREATE INDEX IF NOT EXISTS idx_escalations_resolved   ON escalations(resolved);

ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "escalations_own_client" ON escalations;
CREATE POLICY "escalations_own_client" ON escalations FOR ALL
  USING (client_id = auth_client_id());

-- ────────────────────────────────────────────────────────────
-- 7. REMINDERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id),
  agent_id    UUID REFERENCES agents(id),
  debtor_id   UUID REFERENCES debtors(id),
  kind        TEXT CHECK (kind IN ('ptp','callback')),
  amount      DECIMAL(14,2),
  due_date    DATE NOT NULL,
  due_time    TIME,
  message     TEXT,
  notified    BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_agent_id ON reminders(agent_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due_date  ON reminders(due_date);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reminders_own_client" ON reminders;
CREATE POLICY "reminders_own_client" ON reminders FOR ALL
  USING (client_id = auth_client_id());

-- ────────────────────────────────────────────────────────────
-- 8. MAPPING TEMPLATES — shared org-wide, not per-browser
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mapping_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id),
  lender        TEXT NOT NULL,
  lender_label  TEXT,
  fingerprint   TEXT NOT NULL,
  mapping       JSONB NOT NULL,
  use_count     INTEGER DEFAULT 1,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, lender, fingerprint)
);

ALTER TABLE mapping_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mapping_templates_own_client" ON mapping_templates;
CREATE POLICY "mapping_templates_own_client" ON mapping_templates FOR ALL
  USING (client_id = auth_client_id());
