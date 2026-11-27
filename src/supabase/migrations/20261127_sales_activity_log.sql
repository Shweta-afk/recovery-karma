-- Sales activity log (user, 2026-11-27) — platform-wide history of what sales users did, the
-- same pattern as 20260925_superadmin_activity_log.sql:
--   leads: every lead's own timeline is already in sales_activities (per-lead feed).
--   this:  a single chronological feed of sales accounts, regardless of lead — sign-ins into
--          the sales portal, leads created / updated / assigned, imports, emails, team
--          changes. Superadmins read it on /sales/activity, like Superadmin → Activity.
-- Server-only, read + written only from src/lib/sales.server.ts (service-role).

-- check:sql server-only: sales_activity_log
CREATE TABLE IF NOT EXISTS sales_activity_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_user_id  UUID REFERENCES sales_users(id) ON DELETE SET NULL,
  superadmin_id  UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  -- Human-readable name at the time (so entries read sensibly after a user is deactivated).
  actor_name     TEXT,
  -- Short machine tag: 'sales_user_created', 'lead_created', 'lead_updated', 'lead_stage',
  -- 'lead_assigned', 'lead_email', 'lead_import', 'lead_deleted', 'sales_user_active',
  -- 'sales_user_inactive'. Free text so new kinds don't need a migration.
  action         TEXT NOT NULL,
  lead_id        UUID REFERENCES sales_leads(id) ON DELETE SET NULL,
  summary        TEXT NOT NULL,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_activity_log_created_idx ON sales_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS sales_activity_log_actor_idx ON sales_activity_log (sales_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_activity_log_lead_idx ON sales_activity_log (lead_id);

ALTER TABLE sales_activity_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_activity_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_activity_log TO service_role;
