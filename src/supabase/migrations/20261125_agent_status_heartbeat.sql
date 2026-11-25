-- Presence heartbeat on the open status interval (2026-11-25). The interval used to be opened by
-- the Call Queue page and closed when the agent left it, so a signed-in agent on any other page
-- showed as Offline on Live Calls' "Agents right now", and a closed laptop (no pagehide) left an
-- interval open for hours. The agent/manager layouts now keep the interval open across pages
-- and touch last_seen_at every minute (agent-presence-store.ts); "signed in" = an open interval
-- seen within the last few minutes. Additive only; agents already update their own rows
-- (ended_at), so RLS is unchanged.

ALTER TABLE agent_status_log ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
