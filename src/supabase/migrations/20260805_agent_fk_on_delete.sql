-- Deleting an agent from Supabase Auth (Authentication → Users) cascades into agents
-- (agents.auth_user_id → auth.users is ON DELETE CASCADE), but every one of the 15 FKs
-- below pointed at agents(id) with the Postgres default of NO ACTION — so the cascade got
-- blocked the moment an agent had any call_logs/messages/payments/etc, and the dashboard
-- surfaced that as an opaque "Failed to delete selected users: {}" with no real detail.
--
-- 14 of these columns are historical/audit records (call logs, payments, disputes,
-- assigned debtors, uploaded portfolios, ...) that must survive the agent being deleted —
-- for those we SET NULL so the row stays intact but detaches from the removed agent.
--
-- team_agents.agent_id is the one exception: it's a membership/join-table row, is NOT
-- NULL, and has no meaning once detached from an agent, so it gets CASCADE instead —
-- deleting the agent should just remove their team membership, not orphan a null row.

ALTER TABLE portfolios DROP CONSTRAINT portfolios_uploaded_by_fkey,
  ADD CONSTRAINT portfolios_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE portfolios DROP CONSTRAINT portfolios_manager_id_fkey,
  ADD CONSTRAINT portfolios_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE debtors DROP CONSTRAINT debtors_assigned_agent_id_fkey,
  ADD CONSTRAINT debtors_assigned_agent_id_fkey FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE call_logs DROP CONSTRAINT call_logs_agent_id_fkey,
  ADD CONSTRAINT call_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE messages DROP CONSTRAINT messages_agent_id_fkey,
  ADD CONSTRAINT messages_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE payments DROP CONSTRAINT payments_agent_id_fkey,
  ADD CONSTRAINT payments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE disputes DROP CONSTRAINT disputes_raised_by_fkey,
  ADD CONSTRAINT disputes_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE disputes DROP CONSTRAINT disputes_resolved_by_fkey,
  ADD CONSTRAINT disputes_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE settlement_requests DROP CONSTRAINT settlement_requests_requested_by_fkey,
  ADD CONSTRAINT settlement_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE settlement_requests DROP CONSTRAINT settlement_requests_approved_by_fkey,
  ADD CONSTRAINT settlement_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE teams DROP CONSTRAINT teams_manager_id_fkey,
  ADD CONSTRAINT teams_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE notifications DROP CONSTRAINT notifications_to_agent_id_fkey,
  ADD CONSTRAINT notifications_to_agent_id_fkey FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE escalations DROP CONSTRAINT escalations_agent_id_fkey,
  ADD CONSTRAINT escalations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE reminders DROP CONSTRAINT reminders_agent_id_fkey,
  ADD CONSTRAINT reminders_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE team_agents DROP CONSTRAINT team_agents_agent_id_fkey,
  ADD CONSTRAINT team_agents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
