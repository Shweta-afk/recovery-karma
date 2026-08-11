-- Tracks the PTP miss-escalation chain: agent misses a PTP due today -> manager is notified;
-- manager doesn't resolve it by the next day -> admin is notified. There's no server-side cron
-- in this app, so both escalation checks run client-side, opportunistically, whenever the
-- relevant dashboard loads (agent's Call Queue for the manager escalation, manager's Team
-- Activity/Dashboard for the admin escalation) — see src/lib/ptp-escalation-store.ts. This table
-- exists purely so that opportunistic, possibly-repeated check never sends the same escalation
-- notification twice: one row per (debtor, ptp_date, level) is the dedupe key.
CREATE TABLE IF NOT EXISTS ptp_escalations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id    UUID NOT NULL REFERENCES debtors(id),
  ptp_date     DATE NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('manager', 'admin')),
  escalated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (debtor_id, ptp_date, level)
);

ALTER TABLE ptp_escalations ENABLE ROW LEVEL SECURITY;

-- Same tenant-scoping shape as every other child-of-debtors table (call_logs_select, etc.) —
-- any agent/manager/admin in the company can read and record an escalation. This is a
-- bookkeeping/dedupe signal, not sensitive collections data, so it doesn't need the tighter
-- per-team scoping call_logs has; worth keeping simple since either an agent (recording a
-- manager-level escalation) or a manager (recording an admin-level one) needs to write here.
CREATE POLICY ptp_escalations_select ON ptp_escalations FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY ptp_escalations_insert ON ptp_escalations FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
