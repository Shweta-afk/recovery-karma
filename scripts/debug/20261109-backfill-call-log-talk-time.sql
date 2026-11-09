-- One-off backfill of call_logs.duration_seconds from the call ledger. NOT a migration: run by
-- hand in the SQL Editor, once the code that fills new calls is deployed. Safe to run again, it
-- only touches rows that are still NULL.
--
-- Rule (same as talkSeconds in src/lib/telephony/talk-time.ts): only telephony_calls rows with
-- status = 'completed' and a duration above zero. On any other status the figure is ringing time.
-- The ledger row must belong to the agent's own company, as in the call_audit_rows view.
--
-- NOT filled, on purpose:
--   * calls with no provider_call_id. Nothing ties them to a ledger row except guessing.
--   * ledger rows marked 'canceled' with a duration. A hang-up race overwrote the real status on
--     these (fixed in providerHangup), so ringing and talk cannot be told apart.
--
-- Step 1, preview. Run this alone first.
select count(*) as rows_to_fill,
       sum(t.duration_seconds) as seconds_to_fill,
       max(t.duration_seconds) as longest_call
from public.call_logs c
join public.agents ag on ag.id = c.agent_id
join public.telephony_calls t
  on t.provider_call_id = c.provider_call_id and t.client_id = ag.client_id
where c.duration_seconds is null
  and t.status = 'completed'
  and t.duration_seconds > 0;

-- Step 2, the write. A single statement, so it applies fully or not at all.
-- update public.call_logs c
-- set duration_seconds = t.duration_seconds
-- from public.agents ag, public.telephony_calls t
-- where ag.id = c.agent_id
--   and t.provider_call_id = c.provider_call_id
--   and t.client_id = ag.client_id
--   and c.duration_seconds is null
--   and t.status = 'completed'
--   and t.duration_seconds > 0;

-- Undo. Before this backfill the column was NULL on every row, but after the new code is live
-- this would also clear calls it filled, so limit it by created_at to before the deploy.
-- update public.call_logs set duration_seconds = null where created_at < '<deploy time>';
