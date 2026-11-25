-- When a live_calls row entered its current phase (2026-11-25). Live Calls' "Agents right now"
-- panel times wrap-up (call ended → disposition saved) from it: agents spend a lot of time
-- writing dispositions and managers asked to see it live. The agent's own browser sets it on
-- insert and on every phase change (live-calls-store.ts); rows written before have NULL and are
-- timed from started_at. Additive only; RLS on live_calls is unchanged (agents update their own
-- row, as they already do for phase and last_seen_at).

ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS phase_since TIMESTAMPTZ;
