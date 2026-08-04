-- 1. clients: admin-only, own-client UPDATE policy.
--
-- clients currently has only clients_select (20260730_harden_rls.sql) — no INSERT or UPDATE
-- policy exists at all. INSERT deliberately stays unpoliced here: company creation goes
-- through the service-role client in setup-actions.server.ts, which bypasses RLS entirely
-- (see supabase-admin.server.ts for why that's safe — the server action itself is the
-- authorization boundary there, not a DB policy). UPDATE is needed so an admin can edit
-- their own company's name from Admin → Settings.

CREATE POLICY clients_update ON clients FOR UPDATE TO authenticated
  USING (id = auth_client_id() AND auth_role() = 'admin')
  WITH CHECK (id = auth_client_id() AND auth_role() = 'admin');

-- 2. Close a pre-existing gap on teams/team_agents: migration_realtime_sync.sql gave both
-- tables `FOR ALL USING (client_id = auth_client_id())` with no role check at all, so any
-- authenticated member of a tenant — not just admins — could create/reassign teams or add/
-- remove team members. Every other admin-sensitive write path in this project (agents_insert,
-- portfolios_write, settlements_update, ...) is gated with `auth_role() = 'admin'` or
-- `IN ('admin','manager')`; teams/team_agents were the one write surface left ungated.
-- Worth closing now since this migration already touches adjacent RLS and the new invite
-- flow (user-admin-actions.server.ts) writes to these same tables via the service-role
-- client, which is unaffected by this tightening.

DROP POLICY IF EXISTS "teams_own_client" ON teams;
CREATE POLICY teams_select ON teams FOR SELECT TO authenticated
  USING (client_id = auth_client_id());
CREATE POLICY teams_insert ON teams FOR INSERT TO authenticated
  WITH CHECK (client_id = auth_client_id() AND auth_role() = 'admin');
CREATE POLICY teams_update ON teams FOR UPDATE TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin')
  WITH CHECK (client_id = auth_client_id() AND auth_role() = 'admin');
CREATE POLICY teams_delete ON teams FOR DELETE TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');

DROP POLICY IF EXISTS "team_agents_own_client" ON team_agents;
CREATE POLICY team_agents_select ON team_agents FOR SELECT TO authenticated
  USING (team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id()));
CREATE POLICY team_agents_write ON team_agents FOR ALL TO authenticated
  USING (
    team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id())
    AND auth_role() = 'admin'
  )
  WITH CHECK (
    team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id())
    AND auth_role() = 'admin'
  );
