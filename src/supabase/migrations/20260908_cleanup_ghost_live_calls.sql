-- Closes out any live_calls row that's gone silent for 15+ minutes — see GHOST_AFTER_MS in
-- live-calls-store.ts. The client-side cleanup can't do this itself: live_calls_update's RLS
-- policy (20260830_live_calls.sql) only lets an agent update their OWN rows (agent_id =
-- auth_agent_id()), so whichever manager/admin has the board open can never close out another
-- agent's ghost call that way — confirmed live, four days-old "ringing" rows never cleared no
-- matter who reloaded the page.
--
-- SECURITY DEFINER + row_security off, scoped to the caller's own client_id so it stays
-- tenant-isolated despite bypassing per-row RLS — same pattern as every other helper here that
-- needs cross-row access.
CREATE OR REPLACE FUNCTION cleanup_ghost_live_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = off
AS $$
BEGIN
  UPDATE live_calls
  SET ended_at = now()
  WHERE client_id = auth_client_id()
    AND ended_at IS NULL
    AND last_seen_at < now() - interval '15 minutes';
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_ghost_live_calls() TO authenticated;
