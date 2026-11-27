-- Sales portal, phase 1 (user, 2026-11-27): SamvadX's own sales team tracks leads and prospects
-- for SamvadX itself — pipeline stages, contacts, a timeline of everything done on a lead, and
-- follow-up tasks. Leads arrive by hand, by Excel import (the old Google Sheet of website demo
-- requests) and from the samvadx.com demo form (POST /api/sales/lead).
--
-- Salespeople live in `sales_users`, NOT in `superadmins` (superadmins see every company's money)
-- and NOT in `agents` (they belong to no company). A salesperson sees leads they own plus the
-- unassigned pool; a superadmin sees everything.
--
-- Every table is server-only: all reads and writes go through src/lib/sales.server.ts after
-- verifySalesCaller. No RLS policy anywhere else changes.

-- check:sql server-only: sales_users
CREATE TABLE IF NOT EXISTS sales_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  UUID NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_users_email_idx ON sales_users (lower(email));

-- check:sql server-only: sales_leads
CREATE TABLE IF NOT EXISTS sales_leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name      TEXT NOT NULL,
  contact_name      TEXT,
  phone             TEXT,
  -- Last 10 digits of `phone`: how duplicates are recognised (src/lib/sales/sales-rules.ts).
  phone_key         TEXT,
  email             TEXT,
  city              TEXT,
  state             TEXT,
  source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('website', 'import', 'manual', 'signup', 'referral', 'event', 'other')),
  stage             TEXT NOT NULL DEFAULT 'new'
                      CHECK (stage IN ('new', 'contacted', 'demo_booked', 'demo_done', 'proposal',
                                       'negotiation', 'won', 'lost')),
  -- Lead = just a contact; prospect = qualified (we know their size and need).
  qualified         BOOLEAN NOT NULL DEFAULT FALSE,
  owner_id          UUID REFERENCES sales_users(id) ON DELETE SET NULL,
  agents_count      INTEGER CHECK (agents_count IS NULL OR agents_count >= 0),
  -- The website form's size band ("Under 25", "25–100", …) when no exact count is known.
  agents_band       TEXT,
  accounts_count    INTEGER CHECK (accounts_count IS NULL OR accounts_count >= 0),
  lenders           TEXT,
  deal_seats        INTEGER CHECK (deal_seats IS NULL OR deal_seats >= 0),
  deal_monthly      NUMERIC(14, 2) CHECK (deal_monthly IS NULL OR deal_monthly >= 0),
  next_follow_up    DATE,
  lost_reason       TEXT,
  notes             TEXT,
  website_page      TEXT,
  client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_leads_owner_idx ON sales_leads (owner_id, stage);
CREATE INDEX IF NOT EXISTS sales_leads_phone_key_idx ON sales_leads (phone_key);
CREATE INDEX IF NOT EXISTS sales_leads_follow_up_idx ON sales_leads (next_follow_up);

-- check:sql server-only: sales_contacts
CREATE TABLE IF NOT EXISTS sales_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  designation TEXT,
  phone       TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_contacts_lead_idx ON sales_contacts (lead_id);

-- The lead's timeline: notes, calls, meetings, stage changes, assignments, imports.
-- check:sql server-only: sales_activities
CREATE TABLE IF NOT EXISTS sales_activities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('created', 'note', 'call', 'email', 'meeting', 'stage', 'assigned',
                                 'task_done', 'website', 'import', 'updated')),
  body         TEXT,
  meta         JSONB,
  actor_name   TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_activities_lead_idx ON sales_activities (lead_id, occurred_at DESC);

-- check:sql server-only: sales_tasks
CREATE TABLE IF NOT EXISTS sales_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  due_date     DATE NOT NULL,
  assigned_to  UUID REFERENCES sales_users(id) ON DELETE SET NULL,
  done_at      TIMESTAMPTZ,
  created_by_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_tasks_open_idx ON sales_tasks (due_date) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS sales_tasks_lead_idx ON sales_tasks (lead_id);

ALTER TABLE sales_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_tasks      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE sales_users, sales_leads, sales_contacts, sales_activities, sales_tasks
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_users      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_leads      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_contacts   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_activities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_tasks      TO service_role;
