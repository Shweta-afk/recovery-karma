-- Make a debtor's call notes visible to whoever is working that debtor, not only to whoever
-- typed them.
--
-- ── The problem ──────────────────────────────────────────────────────────────────────────
-- call_logs_select lets an agent read only rows where `agent_id = auth_agent_id()`. So when an
-- account moves between agents — reassignment, or the same borrower coming back in a later
-- portfolio as a retained account — the new agent sees an empty history and re-learns
-- everything the previous agent already wrote down. The notes were never lost; they were just
-- unreadable by the one person who needed them.
--
-- ── The rule ─────────────────────────────────────────────────────────────────────────────
-- An agent may read any call log **on a debtor they can already see**. It is scoped by the
-- DEBTOR, not widened to the tenant: agents still see nothing about accounts that were never
-- assigned to them, so this is not "every agent can read every call in the company". It is
-- exactly "the notes on my own accounts, whoever wrote them".
--
-- Manager and admin visibility are unchanged in intent (they already saw their team / all).
--
-- ── Why a new helper, and why it is shaped like this ─────────────────────────────────────
-- The rule needs "which debtors can I see", which is what debtors_select decides. A policy may
-- NOT read an RLS-protected table directly — that is the pattern that took production down
-- twice (see the RLS section in CLAUDE.md) — so the lookup goes through a SECURITY DEFINER
-- helper that never re-enters RLS:
--
--   * LANGUAGE plpgsql, never `sql`. A `sql` SECURITY DEFINER function simple enough for the
--     planner to INLINE silently loses the privilege escalation, and the policy recurses.
--   * SET row_security = off for the whole body, so none of its internal reads re-enter a
--     policy — including the read of `debtors` itself.
--
-- Its body deliberately mirrors debtors_select. If that policy's rules ever change, this must
-- change with it, or an agent's notes visibility will silently drift from their debtor
-- visibility.
CREATE OR REPLACE FUNCTION auth_visible_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; my_role TEXT; my_client UUID;
  BEGIN
    SELECT id, role, client_id INTO me, my_role, my_client
      FROM agents WHERE auth_user_id = auth.uid();
    IF me IS NULL THEN RETURN; END IF;

    IF my_role = 'admin' THEN
      RETURN QUERY SELECT id FROM debtors WHERE client_id = my_client;
    ELSIF my_role = 'manager' THEN
      RETURN QUERY
        SELECT id FROM debtors
        WHERE client_id = my_client
          AND (
            assigned_agent_id IN (SELECT auth_visible_agent_ids())
            OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
          );
    ELSE
      RETURN QUERY
        SELECT id FROM debtors
        WHERE client_id = my_client AND assigned_agent_id = me;
    END IF;
  END; $$;

-- Same policy as 20260821_rls_no_direct_table_reads.sql plus the final branch. Kept as one
-- CREATE (not an ALTER) so replaying either file converges on the same end state — the
-- migrations in this directory are applied in filename order and must be idempotent, which is
-- the lesson of the recursion incidents.
DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      -- New: any call logged against a debtor I can see, regardless of who made it. This is
      -- what carries notes across a reassignment or a retained account.
      OR debtor_id IN (SELECT auth_visible_debtor_ids())
    )
  );

-- Note this widens SELECT only. Writing, editing and deleting call logs are untouched: an
-- agent still cannot alter another agent's disposition or notes.

NOTIFY pgrst, 'reload schema';
