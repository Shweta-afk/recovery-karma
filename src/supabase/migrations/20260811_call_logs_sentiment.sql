-- Manager-assigned call sentiment/tone (happy, neutral, frustrated, rude) — the actual point
-- of "Call Audit": the outcome (paid/ptp/refused/...) says what happened, sentiment says how
-- the debtor was treated and how the call actually went. There's no transcription/sentiment
-- pipeline wired up yet, so this is a manual QA tag a manager sets after listening to the
-- recording, not an AI-derived score — audited_by/audited_at record who set it and when so it
-- reads as a real audit trail rather than an anonymous edit.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sentiment TEXT
  CHECK (sentiment IN ('happy', 'neutral', 'frustrated', 'rude'));
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS audited_by UUID REFERENCES agents(id);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ;

-- 20260730_harden_rls.sql deliberately gave call_logs no UPDATE policy at all ("an audit
-- trail — no UPDATE or DELETE for anyone, so a compromised agent account cannot rewrite
-- collection history"). Sentiment tagging needs one, so this opens UPDATE to managers (of the
-- calling agent's team) and admins only — same trust boundary as disputes_update/
-- settlements_update, which are also row- not column-scoped, so a manager technically could
-- edit other columns too via a crafted request; acceptable here since managers already have
-- broad write access elsewhere (team management, settlement approval).
CREATE POLICY call_logs_manager_audit_update ON call_logs FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND agent_id IN (
          SELECT ta.agent_id
          FROM team_agents ta
          JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  )
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
