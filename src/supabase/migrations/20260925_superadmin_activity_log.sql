-- Generic superadmin activity log — the "whole history of superadmin activities" a superadmin
-- asked to see, e.g. how much money was assigned to a company.
--
-- Money movements already have a full history: profilex_wallet_ledger
-- (20260909_superadmin_and_wallets.sql) records every top-up/allocation/charge with amount,
-- scope, client_id, manager_id, created_by. That table's shape is right for money and a
-- console page (superadmin.companies.$clientId.tsx) already reads it per-company — it isn't
-- being replaced. What's missing is everything else a superadmin does that ISN'T an amount:
-- approving/rejecting a company, assigning or changing its subdomain, setting seat limits,
-- changing a user's role, changing a company's enabled Insights services. None of that was
-- ever recorded anywhere. This table is for those actions; getSuperadminActivity
-- (superadmin-actions.server.ts) merges this table with profilex_wallet_ledger into one
-- chronological feed for the new Superadmin Activity page.
--
-- Server-only, same pattern as profilex_actual_wallet / profilex_master_wallet /
-- superadmins itself: no RLS policy at all, read and written only through the service-role
-- client in superadmin-actions.server.ts (every handler already gates on
-- verifySuperadminCaller first).
-- check:sql server-only: superadmin_activity_log

CREATE TABLE IF NOT EXISTS superadmin_activity_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  superadmin_id UUID REFERENCES superadmins(id),
  -- Short machine-readable tag: 'company_approved' | 'company_rejected' | 'subdomain_set' |
  -- 'seat_limits_set' | 'user_role_changed' | 'insights_services_changed'. Free text rather
  -- than a CHECK constraint on purpose — new action kinds should never need a migration just
  -- to be loggable.
  action        TEXT NOT NULL,
  client_id     UUID REFERENCES clients(id),
  -- Human-readable one-liner for the activity feed, e.g. "Approved Kuber Associate and set
  -- subdomain to kuber".
  summary       TEXT NOT NULL,
  -- Structured before/after for whichever fields changed — e.g. {"subdomain": {"from": null,
  -- "to": "kuber"}}. Optional: some actions (company_approved) are fully captured by summary.
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS superadmin_activity_log_client_idx ON superadmin_activity_log (client_id);
CREATE INDEX IF NOT EXISTS superadmin_activity_log_created_idx ON superadmin_activity_log (created_at DESC);

ALTER TABLE superadmin_activity_log ENABLE ROW LEVEL SECURITY;
-- No policies — service-role only, same reasoning as profilex_actual_wallet.

REVOKE ALL ON TABLE superadmin_activity_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE superadmin_activity_log TO service_role;
