-- 20260804_clients_update_and_teams_rls.sql deliberately locked teams/team_agents writes to
-- admin-only. Reopened here on explicit request: a manager should be able to manage their
-- own team's roster (rename it, add/remove agents) without needing an admin to do it for
-- them. Scoped tightly — a manager may only touch a team where they are its manager_id;
-- admins keep unrestricted access, unchanged.

DROP POLICY IF EXISTS teams_insert ON teams;
CREATE POLICY teams_insert ON teams FOR INSERT TO authenticated
  WITH CHECK (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS teams_update ON teams;
CREATE POLICY teams_update ON teams FOR UPDATE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
    )
  )
  WITH CHECK (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS teams_delete ON teams;
CREATE POLICY teams_delete ON teams FOR DELETE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS team_agents_write ON team_agents;
CREATE POLICY team_agents_write ON team_agents FOR ALL TO authenticated
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (
          auth_role() = 'admin'
          OR manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
    )
  )
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (
          auth_role() = 'admin'
          OR manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
    )
  );
